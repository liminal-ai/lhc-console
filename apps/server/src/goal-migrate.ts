import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureColumn } from "./sqlite-migrate.ts";

export const LEGACY_GOALS_FILENAME = "goals.sqlite";
export const GOALS_MIGRATION_MANIFEST = "goals-migration.json";
export const GOALS_MIGRATION_VERSION = 1 as const;

export interface GoalMigrationManifest {
  version: typeof GOALS_MIGRATION_VERSION;
  status: "in_progress" | "complete";
  migratedAt: string | null;
  sourceRetiredTo: string | null;
  goalCount: number;
}

interface LegacyGoalRow {
  id: string;
  target: string;
  objective: string;
  state: string;
  cadence_ms: number;
  reminder_job_id: string | null;
  next_reminder_at: string | null;
  created_at: string;
  updated_at: string;
  blocked_reason: string | null;
}

interface FileIdentity {
  dev: number;
  ino: number;
}

interface ExternalLegacyHandle {
  pid: number;
  fd: string;
  target: string;
}

export class LegacyGoalsMigrationRequiredError extends Error {
  readonly name = "LegacyGoalsMigrationRequiredError";
}

export class LegacyGoalsMigrationConflictError extends Error {
  readonly name = "LegacyGoalsMigrationConflictError";
}

export class GoalMigrationManifestInvalidError extends Error {
  readonly name = "GoalMigrationManifestInvalidError";
}

export function legacyGoalsPaths(consoleHome: string): {
  legacyGoalsPath: string;
  manifestPath: string;
  walPath: string;
  shmPath: string;
} {
  const legacyGoalsPath = join(consoleHome, LEGACY_GOALS_FILENAME);
  return {
    legacyGoalsPath,
    manifestPath: join(consoleHome, GOALS_MIGRATION_MANIFEST),
    walPath: `${legacyGoalsPath}-wal`,
    shmPath: `${legacyGoalsPath}-shm`,
  };
}

function legacyBundlePaths(legacyGoalsPath: string): string[] {
  return [legacyGoalsPath, `${legacyGoalsPath}-wal`, `${legacyGoalsPath}-shm`];
}

function fileIdentity(path: string): FileIdentity | null {
  if (!existsSync(path)) return null;
  const stat = statSync(path);
  return { dev: stat.dev, ino: stat.ino };
}

function identitiesEqual(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function collectLegacyBundleIdentities(legacyGoalsPath: string): FileIdentity[] {
  const identities: FileIdentity[] = [];
  for (const path of legacyBundlePaths(legacyGoalsPath)) {
    const identity = fileIdentity(path);
    if (identity) identities.push(identity);
  }
  return identities;
}

function legacyBundleBasenames(legacyGoalsPath: string): string[] {
  return legacyBundlePaths(legacyGoalsPath).map((path) => basename(path));
}

function readlinkTargetMatchesLegacyBundle(target: string, legacyGoalsPath: string): boolean {
  const normalized = target.replace(/ \(deleted\)$/, "");
  const basenames = legacyBundleBasenames(legacyGoalsPath);
  for (const name of basenames) {
    if (normalized === name || normalized.endsWith(`/${name}`)) return true;
  }
  return false;
}

export function findExternalLegacyBundleHandles(
  legacyGoalsPath: string,
  excludePid = process.pid,
): ExternalLegacyHandle[] {
  if (!existsSync("/proc")) return [];
  const identities = collectLegacyBundleIdentities(legacyGoalsPath);
  if (identities.length === 0) return [];

  const handles: ExternalLegacyHandle[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === excludePid) continue;

    const fdDir = join("/proc", entry, "fd");
    let fds: string[];
    try {
      fds = readdirSync(fdDir);
    } catch {
      continue;
    }

    for (const fd of fds) {
      const fdPath = join(fdDir, fd);
      let target: string;
      try {
        target = readlinkSync(fdPath);
      } catch {
        continue;
      }

      let identity: FileIdentity | null = null;
      try {
        const stat = statSync(fdPath);
        identity = { dev: stat.dev, ino: stat.ino };
      } catch {
        continue;
      }

      const inodeMatch = identities.some((candidate) => identitiesEqual(candidate, identity!));
      const pathMatch = readlinkTargetMatchesLegacyBundle(target, legacyGoalsPath);
      if (inodeMatch || pathMatch) {
        handles.push({ pid, fd, target });
      }
    }
  }
  return handles;
}

export function assertLegacyBundleNotOpenExternally(
  legacyGoalsPath: string,
  excludePid = process.pid,
): void {
  if (!existsSync("/proc")) {
    throw new Error("legacy goals migration requires Linux /proc for external handle checks");
  }
  const handles = findExternalLegacyBundleHandles(legacyGoalsPath, excludePid);
  if (handles.length === 0) return;
  const summary = handles
    .slice(0, 3)
    .map((handle) => `pid ${handle.pid} fd ${handle.fd} -> ${handle.target}`)
    .join("; ");
  throw new LegacyGoalsMigrationRequiredError(
    `${legacyGoalsPath} is open in another process (${summary}); stop the old server before migrating`,
  );
}

export function readGoalMigrationManifest(manifestPath: string): GoalMigrationManifest | null {
  if (!existsSync(manifestPath)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new GoalMigrationManifestInvalidError(
      `invalid goals migration manifest (${manifestPath}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isGoalMigrationManifest(value)) {
    throw new GoalMigrationManifestInvalidError(
      `invalid or unsupported goals migration manifest (${manifestPath})`,
    );
  }
  return value;
}

function isGoalMigrationManifest(value: unknown): value is GoalMigrationManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const manifest = value as Record<string, unknown>;
  if (
    manifest.version !== GOALS_MIGRATION_VERSION ||
    (manifest.status !== "in_progress" && manifest.status !== "complete") ||
    !Number.isInteger(manifest.goalCount) ||
    (manifest.goalCount as number) < 0
  ) {
    return false;
  }
  if (manifest.status === "in_progress") {
    return manifest.migratedAt === null && manifest.sourceRetiredTo === null;
  }
  return (
    typeof manifest.migratedAt === "string" &&
    manifest.migratedAt.length > 0 &&
    typeof manifest.sourceRetiredTo === "string" &&
    manifest.sourceRetiredTo.length > 0
  );
}

function legacyBundlePresent(legacyGoalsPath: string): boolean {
  return legacyBundlePaths(legacyGoalsPath).some((path) => existsSync(path));
}

export function assertLegacyGoalsStartupSafe(consoleHome: string): void {
  const { legacyGoalsPath, manifestPath, walPath, shmPath } = legacyGoalsPaths(consoleHome);
  const hasLegacyArtifact =
    existsSync(legacyGoalsPath) || existsSync(walPath) || existsSync(shmPath);
  const manifest = readGoalMigrationManifest(manifestPath);
  if (manifest?.status === "in_progress") {
    throw new LegacyGoalsMigrationRequiredError(
      `goals migration was interrupted (${manifestPath}); stop all servers and re-run offline migration with --acknowledge-offline`,
    );
  }
  if (manifest?.status === "complete") {
    if (hasLegacyArtifact) {
      throw new LegacyGoalsMigrationRequiredError(
        `legacy goals files remain after migration (${legacyGoalsPath}); inspect ${manifestPath} and remove the retired source files`,
      );
    }
    return;
  }
  if (hasLegacyArtifact) {
    throw new LegacyGoalsMigrationRequiredError(
      `legacy ${LEGACY_GOALS_FILENAME} requires offline migration before startup; stop any old server and run: lhc-console-migrate-goals --acknowledge-offline`,
    );
  }
}

export function writeGoalMigrationManifest(
  manifestPath: string,
  manifest: GoalMigrationManifest,
): void {
  const manifestDir = dirname(manifestPath);
  mkdirSync(manifestDir, { recursive: true });
  const temporaryPath = join(
    manifestDir,
    `.${basename(manifestPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, manifestPath);
    chmodSync(manifestPath, 0o600);
  } catch (error) {
    if (existsSync(temporaryPath)) rmSync(temporaryPath);
    throw error;
  }
}

function checkpointLegacyDatabase(legacyGoalsPath: string): void {
  if (!existsSync(legacyGoalsPath)) return;
  const db = new DatabaseSync(legacyGoalsPath);
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

class LegacyMigrationLock {
  #db: DatabaseSync | null = null;

  acquire(legacyGoalsPath: string): void {
    if (!existsSync(legacyGoalsPath)) {
      throw new LegacyGoalsMigrationRequiredError(
        `${legacyGoalsPath} is missing; cannot acquire migration lock`,
      );
    }
    this.#db = new DatabaseSync(legacyGoalsPath);
    try {
      this.#db.exec("BEGIN EXCLUSIVE");
    } catch {
      this.#db.close();
      this.#db = null;
      throw new LegacyGoalsMigrationRequiredError(
        `${legacyGoalsPath} is locked or in use; stop the old server before migrating`,
      );
    }
  }

  readRows(): LegacyGoalRow[] {
    if (!this.#db) return [];
    const table = this.#db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'goals'")
      .get() as { name: string } | undefined;
    if (!table) return [];
    return this.#db.prepare("SELECT * FROM goals").all() as unknown as LegacyGoalRow[];
  }

  assertSafeToRetire(legacyGoalsPath: string): void {
    assertLegacyBundleNotOpenExternally(legacyGoalsPath);
  }

  release(): void {
    if (!this.#db) return;
    try {
      this.#db.exec("ROLLBACK");
    } catch {
      // Best effort: closing releases the exclusive lock.
    }
    this.#db.close();
    this.#db = null;
  }
}

function legacyRowsEqual(left: LegacyGoalRow, right: LegacyGoalRow): boolean {
  return (
    left.target === right.target &&
    left.objective === right.objective &&
    left.state === right.state &&
    left.cadence_ms === right.cadence_ms &&
    left.reminder_job_id === right.reminder_job_id &&
    left.next_reminder_at === right.next_reminder_at &&
    left.created_at === right.created_at &&
    left.updated_at === right.updated_at &&
    left.blocked_reason === right.blocked_reason
  );
}

function relayTableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { ok: number } | undefined;
  return row?.ok === 1;
}

function ensureRelayMigrationSchema(db: DatabaseSync, rows: LegacyGoalRow[]): void {
  const hasRelayJobs = relayTableExists(db, "relay_jobs");
  const needsRelayJobs = rows.some((row) => row.reminder_job_id) || hasRelayJobs;
  if (needsRelayJobs && !hasRelayJobs) {
    throw new LegacyGoalsMigrationRequiredError(
      "relay.sqlite is missing relay_jobs table required for goal migration",
    );
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_cancelled_jobs (
      id TEXT PRIMARY KEY,
      cancelled_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      target TEXT NOT NULL,
      objective TEXT NOT NULL,
      state TEXT NOT NULL,
      cadence_ms INTEGER NOT NULL,
      reminder_job_id TEXT,
      next_reminder_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      blocked_reason TEXT
    );
  `);
  if (hasRelayJobs) {
    ensureColumn(
      db,
      "relay_jobs",
      "job_class",
      "ALTER TABLE relay_jobs ADD COLUMN job_class TEXT NOT NULL DEFAULT 'deprioritized'",
    );
  }
}

function fenceReminderJob(db: DatabaseSync, jobId: string, cancelledAt: string): void {
  db.prepare("INSERT OR IGNORE INTO relay_cancelled_jobs (id, cancelled_at) VALUES (?, ?)").run(
    jobId,
    cancelledAt,
  );
  db.prepare(
    `UPDATE relay_jobs
       SET status = 'cancelled', finished_at = ?, error = NULL
       WHERE id = ? AND status IN ('queued', 'blocked')`,
  ).run(cancelledAt, jobId);
}

function importLegacyRows(
  db: DatabaseSync,
  rows: LegacyGoalRow[],
  targetExists: (target: string) => boolean,
  now: () => number,
): number {
  let imported = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    const selectExisting = db.prepare("SELECT * FROM goals WHERE id = ?");
    const insert = db.prepare(
      `INSERT INTO goals
       (id, target, objective, state, cadence_ms, reminder_job_id, next_reminder_at,
        created_at, updated_at, blocked_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of rows) {
      const existing = selectExisting.get(row.id) as LegacyGoalRow | undefined;
      if (existing) {
        if (!legacyRowsEqual(existing, row)) {
          throw new LegacyGoalsMigrationConflictError(
            `goal id conflict during migration: ${row.id}`,
          );
        }
        continue;
      }
      let state = row.state;
      let blockedReason = row.blocked_reason;
      let reminderJobId = row.reminder_job_id;
      let nextReminderAt = row.next_reminder_at;
      const updatedAt = new Date(now()).toISOString();
      if (state === "active" && !targetExists(row.target)) {
        state = "blocked";
        blockedReason = `relay target no longer configured: ${row.target}`;
        if (reminderJobId) fenceReminderJob(db, reminderJobId, updatedAt);
        reminderJobId = null;
        nextReminderAt = null;
      } else if (state !== "active" && reminderJobId) {
        fenceReminderJob(db, reminderJobId, row.updated_at);
      }
      insert.run(
        row.id,
        row.target,
        row.objective,
        state,
        row.cadence_ms,
        reminderJobId,
        nextReminderAt,
        row.created_at,
        updatedAt,
        blockedReason,
      );
      imported += 1;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return imported;
}

function retireLegacyBundle(
  consoleHome: string,
  legacyGoalsPath: string,
  migratedAt: string,
): string {
  const retiredDir = join(consoleHome, "goals-retired", migratedAt.replaceAll(":", "-"));
  mkdirSync(retiredDir, { recursive: true });
  chmodSync(retiredDir, 0o700);
  for (const path of legacyBundlePaths(legacyGoalsPath)) {
    if (!existsSync(path)) continue;
    const dest = join(retiredDir, basename(path));
    renameSync(path, dest);
    chmodSync(dest, 0o600);
  }
  return retiredDir;
}

export function migrateLegacyGoalsOffline(options: {
  consoleHome: string;
  relayDbPath: string;
  targetExists: (target: string) => boolean;
  acknowledgeOffline: boolean;
  now?: () => number;
}): GoalMigrationManifest {
  if (!options.acknowledgeOffline) {
    throw new Error("offline migration requires acknowledgeOffline: true");
  }
  const now = options.now ?? Date.now;
  const { legacyGoalsPath, manifestPath } = legacyGoalsPaths(options.consoleHome);
  const existingManifest = readGoalMigrationManifest(manifestPath);
  if (existingManifest?.status === "complete") {
    throw new Error(`goals migration already completed (${manifestPath})`);
  }
  if (existingManifest?.status === "in_progress") {
    if (!legacyBundlePresent(legacyGoalsPath)) {
      throw new LegacyGoalsMigrationRequiredError(
        `goals migration was interrupted after source retirement (${manifestPath}); manual recovery required`,
      );
    }
    removeGoalMigrationManifest(manifestPath);
  }
  if (!legacyBundlePresent(legacyGoalsPath)) {
    throw new Error(`no legacy ${LEGACY_GOALS_FILENAME} found to migrate`);
  }

  assertLegacyBundleNotOpenExternally(legacyGoalsPath);
  checkpointLegacyDatabase(legacyGoalsPath);
  assertLegacyBundleNotOpenExternally(legacyGoalsPath);

  const lock = new LegacyMigrationLock();
  let manifestWritten = false;
  try {
    lock.acquire(legacyGoalsPath);
    const rows = lock.readRows();
    const migratedAt = new Date(now()).toISOString();

    mkdirSync(dirname(options.relayDbPath), { recursive: true });
    closeSync(openSync(options.relayDbPath, "a", 0o600));
    chmodSync(options.relayDbPath, 0o600);
    const relayDb = new DatabaseSync(options.relayDbPath);
    try {
      ensureRelayMigrationSchema(relayDb, rows);
      writeGoalMigrationManifest(manifestPath, {
        version: GOALS_MIGRATION_VERSION,
        status: "in_progress",
        migratedAt: null,
        sourceRetiredTo: null,
        goalCount: rows.length,
      });
      manifestWritten = true;
      importLegacyRows(relayDb, rows, options.targetExists, now);
    } finally {
      relayDb.close();
    }

    lock.assertSafeToRetire(legacyGoalsPath);
    const sourceRetiredTo = retireLegacyBundle(options.consoleHome, legacyGoalsPath, migratedAt);
    const manifest: GoalMigrationManifest = {
      version: GOALS_MIGRATION_VERSION,
      status: "complete",
      migratedAt,
      sourceRetiredTo,
      goalCount: rows.length,
    };
    writeGoalMigrationManifest(manifestPath, manifest);
    manifestWritten = false;
    return manifest;
  } catch (error) {
    if (manifestWritten && legacyBundlePresent(legacyGoalsPath)) {
      removeGoalMigrationManifest(manifestPath);
    }
    throw error;
  } finally {
    lock.release();
  }
}

export function removeGoalMigrationManifest(manifestPath: string): void {
  if (existsSync(manifestPath)) rmSync(manifestPath);
}
