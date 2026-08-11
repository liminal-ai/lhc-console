import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  GoalMigrationManifestInvalidError,
  LegacyGoalsMigrationConflictError,
  LegacyGoalsMigrationRequiredError,
  assertLegacyGoalsStartupSafe,
  legacyGoalsPaths,
  migrateLegacyGoalsOffline,
  readGoalMigrationManifest,
} from "../src/goal-migrate.ts";
import { GoalService } from "../src/goal.ts";
import { RelayQueue } from "../src/relay.ts";

const dirs: string[] = [];
const services: GoalService[] = [];
const queues: RelayQueue[] = [];
type SpawnedChild = ReturnType<typeof spawn>;
const childProcesses: SpawnedChild[] = [];

const relayTarget = {
  hostId: "pi-lhc",
  threadId: "th_fable",
  cwd: "/tmp",
  command: "unused",
  args: [] as string[],
};

afterEach(async () => {
  for (const child of childProcesses.splice(0)) {
    child.kill("SIGTERM");
    await waitForChildExit(child);
  }
  await Promise.all(queues.splice(0).map((queue) => queue.close()));
  await Promise.all(services.splice(0).map((service) => service.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function relayDbPath(dir: string): string {
  return join(dir, "relay.sqlite");
}

function createDeferredQueue(
  dir: string,
  options: {
    execute?: ConstructorParameters<typeof RelayQueue>[0]["execute"];
    targets?: Record<string, typeof relayTarget>;
  } = {},
): RelayQueue {
  const queue = new RelayQueue({
    dbPath: relayDbPath(dir),
    targets: options.targets ?? { fable: relayTarget },
    isBusy: () => false,
    execute: options.execute ?? (async () => "ok"),
    busyPollMs: 5,
  });
  queues.push(queue);
  return queue;
}

function makeGoalService(
  dir: string,
  queue: RelayQueue,
  targetExists: (target: string) => boolean = (target) => target === "fable",
): GoalService {
  const service = new GoalService({
    dbPath: relayDbPath(dir),
    relayQueue: queue,
    targetExists,
  });
  services.push(service);
  return service;
}

function executableReminderCount(dir: string): number {
  const db = new DatabaseSync(relayDbPath(dir));
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count FROM relay_jobs
         WHERE status IN ('queued', 'blocked', 'running')
           AND NOT EXISTS (
             SELECT 1 FROM relay_cancelled_jobs AS c WHERE c.id = relay_jobs.id
           )`,
      )
      .get() as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

function seedLegacyGoals(dir: string, sql: string, options: { walMode?: boolean } = {}): string {
  const legacyPath = legacyGoalsPaths(dir).legacyGoalsPath;
  const legacy = new DatabaseSync(legacyPath);
  if (options.walMode) legacy.exec("PRAGMA journal_mode = WAL");
  legacy.exec(sql);
  legacy.close();
  return legacyPath;
}

function seedPreUpgradeRelaySchema(dir: string, extraSql = ""): void {
  const db = new DatabaseSync(relayDbPath(dir));
  db.exec(`
    CREATE TABLE relay_jobs (
      id TEXT PRIMARY KEY, target TEXT NOT NULL, prompt TEXT NOT NULL,
      status TEXT NOT NULL, output TEXT, error TEXT, created_at TEXT NOT NULL,
      started_at TEXT, finished_at TEXT, notify TEXT, delivery_status TEXT,
      delivery_error TEXT, owner_pid INTEGER
    );
    ${extraSql}
  `);
  db.close();
}

function spawnIdleLegacyHolder(legacyPath: string): SpawnedChild {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { DatabaseSync } from "node:sqlite";
       const db = new DatabaseSync(${JSON.stringify(legacyPath)});
       db.exec("SELECT 1");
       setInterval(() => {}, 60_000);`,
    ],
    { stdio: "ignore" },
  );
  childProcesses.push(child);
  return child;
}

async function waitForChildReady(child: SpawnedChild, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`legacy holder exited early: ${child.exitCode}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (child.pid) return;
  }
  throw new Error("legacy holder did not start");
}

async function waitForChildExit(child: SpawnedChild, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (child.exitCode === null && child.signalCode === null && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

describe("Goal legacy upgrade", () => {
  it("migrates reminder fencing against pre-upgrade relay schema without RelayQueue", () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-console-goal-upgrade-pre-upgrade-relay-"));
    dirs.push(dir);
    const reminderId = "pre-upgrade-reminder";
    seedPreUpgradeRelaySchema(
      dir,
      `INSERT INTO relay_jobs
       (id, target, prompt, status, created_at)
       VALUES ('${reminderId}', 'fable', 'legacy reminder', 'queued', '2020-01-01T00:00:00.000Z');`,
    );
    seedLegacyGoals(
      dir,
      `
      CREATE TABLE goals (
        id TEXT PRIMARY KEY, target TEXT NOT NULL, objective TEXT NOT NULL,
        state TEXT NOT NULL, cadence_ms INTEGER NOT NULL, reminder_job_id TEXT,
        next_reminder_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        blocked_reason TEXT
      );
      INSERT INTO goals VALUES (
        'terminal-goal', 'fable', 'Done already', 'completed', 60000,
        '${reminderId}', NULL, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', NULL
      );`,
    );

    migrateLegacyGoalsOffline({
      consoleHome: dir,
      relayDbPath: relayDbPath(dir),
      targetExists: (target) => target === "fable",
      acknowledgeOffline: true,
    });

    const relayDb = new DatabaseSync(relayDbPath(dir));
    try {
      expect(
        relayDb.prepare("SELECT id FROM relay_cancelled_jobs WHERE id = ?").get(reminderId),
      ).toEqual({ id: reminderId });
      expect(relayDb.prepare("SELECT status FROM relay_jobs WHERE id = ?").get(reminderId)).toEqual(
        {
          status: "cancelled",
        },
      );
    } finally {
      relayDb.close();
    }
    expect(executableReminderCount(dir)).toBe(0);
  });

  it("blocks invalid targets against pre-upgrade relay schema without RelayQueue", () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-console-goal-upgrade-pre-upgrade-invalid-"));
    dirs.push(dir);
    const reminderId = "removed-target-reminder";
    seedPreUpgradeRelaySchema(
      dir,
      `INSERT INTO relay_jobs
       (id, target, prompt, status, created_at)
       VALUES ('${reminderId}', 'retired-agent', 'legacy reminder', 'queued', '2020-01-01T00:00:00.000Z');`,
    );
    seedLegacyGoals(
      dir,
      `
      CREATE TABLE goals (
        id TEXT PRIMARY KEY, target TEXT NOT NULL, objective TEXT NOT NULL,
        state TEXT NOT NULL, cadence_ms INTEGER NOT NULL, reminder_job_id TEXT,
        next_reminder_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        blocked_reason TEXT
      );
      INSERT INTO goals VALUES (
        'removed-target-goal', 'retired-agent', 'Orphaned target', 'active', 60000,
        '${reminderId}', NULL, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', NULL
      );`,
    );

    migrateLegacyGoalsOffline({
      consoleHome: dir,
      relayDbPath: relayDbPath(dir),
      targetExists: (target) => target === "fable",
      acknowledgeOffline: true,
    });

    const relayDb = new DatabaseSync(relayDbPath(dir));
    try {
      const goal = relayDb
        .prepare("SELECT state, blocked_reason, reminder_job_id FROM goals WHERE id = ?")
        .get("removed-target-goal") as {
        state: string;
        blocked_reason: string;
        reminder_job_id: string | null;
      };
      expect(goal).toEqual({
        state: "blocked",
        blocked_reason: "relay target no longer configured: retired-agent",
        reminder_job_id: null,
      });
      expect(relayDb.prepare("SELECT status FROM relay_jobs WHERE id = ?").get(reminderId)).toEqual(
        {
          status: "cancelled",
        },
      );
    } finally {
      relayDb.close();
    }
    expect(executableReminderCount(dir)).toBe(0);
  });

  it("retries pre-upgrade migration after a failed import leaves source untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-console-goal-upgrade-pre-upgrade-retry-"));
    dirs.push(dir);
    const reminderId = "retry-reminder";
    seedPreUpgradeRelaySchema(
      dir,
      `INSERT INTO relay_jobs
       (id, target, prompt, status, created_at)
       VALUES ('${reminderId}', 'fable', 'legacy reminder', 'queued', '2020-01-01T00:00:00.000Z');
       CREATE TABLE goals (
         id TEXT PRIMARY KEY, target TEXT NOT NULL, objective TEXT NOT NULL,
         state TEXT NOT NULL, cadence_ms INTEGER NOT NULL, reminder_job_id TEXT,
         next_reminder_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
         blocked_reason TEXT
       );
       INSERT INTO goals VALUES (
         'shared-id', 'fable', 'Already here', 'active', 60000,
         NULL, NULL, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', NULL
       );`,
    );
    seedLegacyGoals(
      dir,
      `
      CREATE TABLE goals (
        id TEXT PRIMARY KEY, target TEXT NOT NULL, objective TEXT NOT NULL,
        state TEXT NOT NULL, cadence_ms INTEGER NOT NULL, reminder_job_id TEXT,
        next_reminder_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        blocked_reason TEXT
      );
      INSERT INTO goals VALUES (
        'shared-id', 'fable', 'Different objective', 'active', 60000,
        NULL, NULL, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', NULL
      ),
      (
        'retry-goal', 'fable', 'Done already', 'completed', 60000,
        '${reminderId}', NULL, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', NULL
      );`,
    );

    expect(() =>
      migrateLegacyGoalsOffline({
        consoleHome: dir,
        relayDbPath: relayDbPath(dir),
        targetExists: () => true,
        acknowledgeOffline: true,
      }),
    ).toThrow(LegacyGoalsMigrationConflictError);
    expect(existsSync(legacyGoalsPaths(dir).legacyGoalsPath)).toBe(true);
    expect(readGoalMigrationManifest(legacyGoalsPaths(dir).manifestPath)).toBeNull();

    const relayDb = new DatabaseSync(relayDbPath(dir));
    relayDb.exec("DELETE FROM goals WHERE id = 'shared-id'");
    relayDb.close();

    const manifest = migrateLegacyGoalsOffline({
      consoleHome: dir,
      relayDbPath: relayDbPath(dir),
      targetExists: () => true,
      acknowledgeOffline: true,
    });
    expect(manifest.status).toBe("complete");
    expect(existsSync(legacyGoalsPaths(dir).legacyGoalsPath)).toBe(false);
    const verify = new DatabaseSync(relayDbPath(dir));
    try {
      expect(verify.prepare("SELECT status FROM relay_jobs WHERE id = ?").get(reminderId)).toEqual({
        status: "cancelled",
      });
      expect(
        verify.prepare("SELECT id FROM relay_cancelled_jobs WHERE id = ?").get(reminderId),
      ).toEqual({ id: reminderId });
    } finally {
      verify.close();
    }
  });

  it("refuses migration while another process holds an idle legacy connection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-console-goal-upgrade-external-handle-"));
    dirs.push(dir);
    const { legacyGoalsPath } = legacyGoalsPaths(dir);
    seedLegacyGoals(
      dir,
      `
      CREATE TABLE goals (
        id TEXT PRIMARY KEY, target TEXT NOT NULL, objective TEXT NOT NULL,
        state TEXT NOT NULL, cadence_ms INTEGER NOT NULL, reminder_job_id TEXT,
        next_reminder_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        blocked_reason TEXT
      );
      INSERT INTO goals VALUES (
        'held-goal', 'fable', 'Should stay put', 'active', 60000,
        NULL, NULL, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', NULL
      );`,
    );
    const child = spawnIdleLegacyHolder(legacyGoalsPath);
    await waitForChildReady(child);

    expect(() =>
      migrateLegacyGoalsOffline({
        consoleHome: dir,
        relayDbPath: relayDbPath(dir),
        targetExists: () => true,
        acknowledgeOffline: true,
      }),
    ).toThrow(LegacyGoalsMigrationRequiredError);
    expect(existsSync(legacyGoalsPath)).toBe(true);
    expect(readGoalMigrationManifest(legacyGoalsPaths(dir).manifestPath)).toBeNull();

    child.kill("SIGTERM");
    await waitForChildExit(child);
    childProcesses.pop();

    const manifest = migrateLegacyGoalsOffline({
      consoleHome: dir,
      relayDbPath: relayDbPath(dir),
      targetExists: () => true,
      acknowledgeOffline: true,
    });
    expect(manifest.status).toBe("complete");
    expect(existsSync(legacyGoalsPath)).toBe(false);
  });

  it("fails closed on startup when legacy goals.sqlite is present", () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-console-goal-upgrade-startup-fail-"));
    dirs.push(dir);
    seedLegacyGoals(
      dir,
      `CREATE TABLE goals (
        id TEXT PRIMARY KEY, target TEXT NOT NULL, objective TEXT NOT NULL,
        state TEXT NOT NULL, cadence_ms INTEGER NOT NULL, reminder_job_id TEXT,
        next_reminder_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        blocked_reason TEXT
      );`,
    );
    expect(() => assertLegacyGoalsStartupSafe(dir)).toThrow(LegacyGoalsMigrationRequiredError);
  });

  it("fences a terminal legacy goal reminder before relay workers start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-console-goal-upgrade-terminal-"));
    dirs.push(dir);
    const reminderId = "terminal-reminder";
    const calls: string[] = [];
    const queue = createDeferredQueue(dir, {
      execute: async (_target, prompt) => {
        calls.push(prompt);
        return "ok";
      },
    });
    const relayDb = new DatabaseSync(relayDbPath(dir));
    relayDb
      .prepare(
        `INSERT INTO relay_jobs
         (id, target, prompt, status, created_at, job_class)
         VALUES (?, 'fable', 'legacy reminder', 'queued', '2020-01-01T00:00:00.000Z', 'prioritized')`,
      )
      .run(reminderId);
    relayDb.close();

    seedLegacyGoals(
      dir,
      `
      CREATE TABLE goals (
        id TEXT PRIMARY KEY, target TEXT NOT NULL, objective TEXT NOT NULL,
        state TEXT NOT NULL, cadence_ms INTEGER NOT NULL, reminder_job_id TEXT,
        next_reminder_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        blocked_reason TEXT
      );
      INSERT INTO goals VALUES (
        'terminal-goal', 'fable', 'Done already', 'completed', 60000,
        '${reminderId}', NULL, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', NULL
      );`,
    );

    migrateLegacyGoalsOffline({
      consoleHome: dir,
      relayDbPath: relayDbPath(dir),
      targetExists: (target) => target === "fable",
      acknowledgeOffline: true,
    });
    const service = makeGoalService(dir, queue);
    expect(service.get("terminal-goal")).toMatchObject({ state: "completed" });
    expect(queue.get(reminderId)?.status).toBe("cancelled");
    expect(calls).toHaveLength(0);
    expect(executableReminderCount(dir)).toBe(0);

    queue.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toHaveLength(0);
    expect(executableReminderCount(dir)).toBe(0);
  });

  it("retires WAL sidecars after checkpoint during offline migration", () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-console-goal-upgrade-wal-"));
    dirs.push(dir);
    const { legacyGoalsPath, walPath, shmPath, manifestPath } = legacyGoalsPaths(dir);
    createDeferredQueue(dir);
    seedLegacyGoals(
      dir,
      `
      CREATE TABLE goals (
        id TEXT PRIMARY KEY, target TEXT NOT NULL, objective TEXT NOT NULL,
        state TEXT NOT NULL, cadence_ms INTEGER NOT NULL, reminder_job_id TEXT,
        next_reminder_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        blocked_reason TEXT
      );
      INSERT INTO goals VALUES (
        'wal-goal', 'fable', 'WAL import', 'active', 60000,
        NULL, NULL, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', NULL
      );`,
      { walMode: true },
    );
    const manifest = migrateLegacyGoalsOffline({
      consoleHome: dir,
      relayDbPath: relayDbPath(dir),
      targetExists: (target) => target === "fable",
      acknowledgeOffline: true,
    });
    expect(manifest.status).toBe("complete");
    expect(existsSync(legacyGoalsPath)).toBe(false);
    expect(existsSync(walPath)).toBe(false);
    expect(existsSync(shmPath)).toBe(false);
    expect(readGoalMigrationManifest(manifestPath)?.status).toBe("complete");
    expect(existsSync(join(dir, "goals-retired"))).toBe(true);
    assertLegacyGoalsStartupSafe(dir);
  });

  it("fails closed on startup when interrupted migration manifest is present but allows retry", () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-console-goal-upgrade-interrupted-"));
    dirs.push(dir);
    const { manifestPath } = legacyGoalsPaths(dir);
    seedLegacyGoals(
      dir,
      `CREATE TABLE goals (
        id TEXT PRIMARY KEY, target TEXT NOT NULL, objective TEXT NOT NULL,
        state TEXT NOT NULL, cadence_ms INTEGER NOT NULL, reminder_job_id TEXT,
        next_reminder_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        blocked_reason TEXT
      );
      INSERT INTO goals VALUES (
        'retry-goal', 'fable', 'Retry me', 'active', 60000,
        NULL, NULL, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', NULL
      );`,
    );
    const manifest = {
      version: 1 as const,
      status: "in_progress" as const,
      migratedAt: null,
      sourceRetiredTo: null,
      goalCount: 1,
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    expect(() => assertLegacyGoalsStartupSafe(dir)).toThrow(LegacyGoalsMigrationRequiredError);
    const completed = migrateLegacyGoalsOffline({
      consoleHome: dir,
      relayDbPath: relayDbPath(dir),
      targetExists: () => true,
      acknowledgeOffline: true,
    });
    expect(completed.status).toBe("complete");
    expect(readGoalMigrationManifest(manifestPath)?.status).toBe("complete");
    assertLegacyGoalsStartupSafe(dir);
  });

  it("fails closed on malformed or unsupported migration manifests", () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-console-goal-upgrade-invalid-manifest-"));
    dirs.push(dir);
    const { manifestPath } = legacyGoalsPaths(dir);

    writeFileSync(manifestPath, "{not json\n");
    expect(() => assertLegacyGoalsStartupSafe(dir)).toThrow(GoalMigrationManifestInvalidError);

    writeFileSync(
      manifestPath,
      `${JSON.stringify({
        version: 99,
        status: "complete",
        migratedAt: "2020-01-01T00:00:00.000Z",
        sourceRetiredTo: "/tmp/retired",
        goalCount: 1,
      })}\n`,
    );
    expect(() => assertLegacyGoalsStartupSafe(dir)).toThrow(GoalMigrationManifestInvalidError);
  });

  it("migrates terminal goals against the pre-upgrade relay schema", () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-console-goal-upgrade-old-relay-"));
    dirs.push(dir);
    const reminderId = "old-schema-reminder";
    const relayDb = new DatabaseSync(relayDbPath(dir));
    relayDb.exec(`
      CREATE TABLE relay_jobs (
        id TEXT PRIMARY KEY, target TEXT NOT NULL, prompt TEXT NOT NULL,
        status TEXT NOT NULL, output TEXT, error TEXT, created_at TEXT NOT NULL,
        started_at TEXT, finished_at TEXT, notify TEXT, delivery_status TEXT,
        delivery_error TEXT, owner_pid INTEGER
      );
      INSERT INTO relay_jobs
        (id, target, prompt, status, created_at)
      VALUES
        ('${reminderId}', 'fable', 'legacy reminder', 'queued', '2020-01-01T00:00:00.000Z');
    `);
    relayDb.close();
    seedLegacyGoals(
      dir,
      `
      CREATE TABLE goals (
        id TEXT PRIMARY KEY, target TEXT NOT NULL, objective TEXT NOT NULL,
        state TEXT NOT NULL, cadence_ms INTEGER NOT NULL, reminder_job_id TEXT,
        next_reminder_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        blocked_reason TEXT
      );
      INSERT INTO goals VALUES (
        'old-schema-goal', 'fable', 'Already done', 'completed', 60000,
        '${reminderId}', NULL, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', NULL
      );`,
    );

    expect(() =>
      migrateLegacyGoalsOffline({
        consoleHome: dir,
        relayDbPath: relayDbPath(dir),
        targetExists: () => true,
        acknowledgeOffline: true,
      }),
    ).not.toThrow();
    const verify = new DatabaseSync(relayDbPath(dir));
    try {
      expect(verify.prepare("SELECT status FROM relay_jobs WHERE id = ?").get(reminderId)).toEqual({
        status: "cancelled",
      });
      expect(
        verify.prepare("SELECT id FROM relay_cancelled_jobs WHERE id = ?").get(reminderId),
      ).toEqual({ id: reminderId });
    } finally {
      verify.close();
    }
  });

  it("rejects conflicting goal ids instead of retaining stale rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-console-goal-upgrade-conflict-"));
    dirs.push(dir);
    createDeferredQueue(dir);
    const relayDb = new DatabaseSync(relayDbPath(dir));
    relayDb.exec(`
      CREATE TABLE goals (
        id TEXT PRIMARY KEY, target TEXT NOT NULL, objective TEXT NOT NULL,
        state TEXT NOT NULL, cadence_ms INTEGER NOT NULL, reminder_job_id TEXT,
        next_reminder_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        blocked_reason TEXT
      );
      INSERT INTO goals VALUES (
        'shared-id', 'fable', 'Already here', 'active', 60000,
        NULL, NULL, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', NULL
      );
    `);
    relayDb.close();
    seedLegacyGoals(
      dir,
      `
      CREATE TABLE goals (
        id TEXT PRIMARY KEY, target TEXT NOT NULL, objective TEXT NOT NULL,
        state TEXT NOT NULL, cadence_ms INTEGER NOT NULL, reminder_job_id TEXT,
        next_reminder_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        blocked_reason TEXT
      );
      INSERT INTO goals VALUES (
        'shared-id', 'fable', 'Different objective', 'active', 60000,
        NULL, NULL, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', NULL
      );`,
    );
    expect(() =>
      migrateLegacyGoalsOffline({
        consoleHome: dir,
        relayDbPath: relayDbPath(dir),
        targetExists: (target) => target === "fable",
        acknowledgeOffline: true,
      }),
    ).toThrow(LegacyGoalsMigrationConflictError);
    expect(existsSync(legacyGoalsPaths(dir).legacyGoalsPath)).toBe(true);
    expect(readGoalMigrationManifest(legacyGoalsPaths(dir).manifestPath)).toBeNull();
  });

  it("blocks imported active goals for removed targets and fences reminders", () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-console-goal-upgrade-invalid-target-"));
    dirs.push(dir);
    const reminderId = "removed-target-reminder";
    const queue = createDeferredQueue(dir, { targets: { fable: relayTarget } });
    const relayDb = new DatabaseSync(relayDbPath(dir));
    relayDb
      .prepare(
        `INSERT INTO relay_jobs
         (id, target, prompt, status, created_at, job_class)
         VALUES (?, 'retired-agent', 'legacy reminder', 'queued', '2020-01-01T00:00:00.000Z', 'prioritized')`,
      )
      .run(reminderId);
    relayDb.close();
    seedLegacyGoals(
      dir,
      `
      CREATE TABLE goals (
        id TEXT PRIMARY KEY, target TEXT NOT NULL, objective TEXT NOT NULL,
        state TEXT NOT NULL, cadence_ms INTEGER NOT NULL, reminder_job_id TEXT,
        next_reminder_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        blocked_reason TEXT
      );
      INSERT INTO goals VALUES (
        'removed-target-goal', 'retired-agent', 'Orphaned target', 'active', 60000,
        '${reminderId}', NULL, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', NULL
      );`,
    );

    migrateLegacyGoalsOffline({
      consoleHome: dir,
      relayDbPath: relayDbPath(dir),
      targetExists: (target) => target === "fable",
      acknowledgeOffline: true,
    });
    const service = makeGoalService(dir, queue, (target) => target === "fable");
    expect(service.get("removed-target-goal")).toMatchObject({
      state: "blocked",
      blockedReason: "relay target no longer configured: retired-agent",
      reminderJobId: null,
    });
    expect(queue.get(reminderId)?.status).toBe("cancelled");
    service.tick();
    expect(executableReminderCount(dir)).toBe(0);
  });

  it("terminates a stale active goal whose reminder is already tombstoned with no relay row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-console-goal-upgrade-tombstone-missing-"));
    dirs.push(dir);
    const reminderId = "fenced-reminder";
    const queue = createDeferredQueue(dir);
    const bootstrap = makeGoalService(dir, queue);
    await bootstrap.close();
    services.pop();
    const relayDb = new DatabaseSync(relayDbPath(dir));
    relayDb.exec(`
      INSERT INTO goals
        (id, target, objective, state, cadence_ms, reminder_job_id, next_reminder_at,
         created_at, updated_at, blocked_reason)
      VALUES (
        'stale-active', 'fable', 'Should not run', 'active', 60000,
        '${reminderId}', NULL, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', NULL
      );
      INSERT INTO relay_cancelled_jobs (id, cancelled_at)
      VALUES ('${reminderId}', '2020-01-01T00:00:00.000Z');
    `);
    relayDb.close();

    const service = makeGoalService(dir, queue);
    expect(service.get("stale-active")).toMatchObject({ state: "cancelled", reminderJobId: null });
    service.tick();
    expect(service.get("stale-active")?.state).toBe("cancelled");
    expect(executableReminderCount(dir)).toBe(0);
  });

  it("terminates a stale active goal with a cancelled relay row and does not resurrect it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-console-goal-upgrade-tombstone-cancelled-"));
    dirs.push(dir);
    const reminderId = "cancelled-reminder";
    const queue = createDeferredQueue(dir);
    const bootstrap = makeGoalService(dir, queue);
    await bootstrap.close();
    services.pop();
    const relayDb = new DatabaseSync(relayDbPath(dir));
    relayDb.exec(`
      INSERT INTO goals
        (id, target, objective, state, cadence_ms, reminder_job_id, next_reminder_at,
         created_at, updated_at, blocked_reason)
      VALUES (
        'stale-active', 'fable', 'Should not run', 'active', 60000,
        '${reminderId}', NULL, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', NULL
      );
      INSERT INTO relay_jobs
        (id, target, prompt, status, created_at, finished_at, job_class)
      VALUES (
        '${reminderId}', 'fable', '[LHC system goal reminder]', 'cancelled',
        '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', 'prioritized'
      );
      INSERT INTO relay_cancelled_jobs (id, cancelled_at)
      VALUES ('${reminderId}', '2020-01-01T00:00:00.000Z');
    `);
    relayDb.close();

    const service = makeGoalService(dir, queue);
    expect(service.get("stale-active")).toMatchObject({ state: "cancelled", reminderJobId: null });
    service.tick();
    expect(service.get("stale-active")?.state).toBe("cancelled");
    expect(executableReminderCount(dir)).toBe(0);
  });
});
