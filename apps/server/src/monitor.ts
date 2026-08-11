import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RelayJobStatus } from "./relay.ts";

export interface Monitor {
  id: string;
  target: string;
  prompt: string;
  intervalMs: number;
  idleForMs: number;
  maxTicks: number;
  tickCount: number;
  active: boolean;
  createdAt: string;
  nextTickAt: string;
  lastTickAt: string | null;
  lastJobId: string | null;
  lastError: string | null;
  quiet: boolean;
}

interface MonitorServiceOptions {
  dbPath: string;
  enqueue: (input: { target: string; prompt: string; notify?: "photon" }) => { id: string };
  getJob: (id: string) => { status: RelayJobStatus } | null;
  targetExists: (target: string) => boolean;
  lastActivityAt: (target: string) => Date | null;
  pollMs?: number;
  minIntervalMs?: number;
}

interface MonitorRow {
  id: string;
  target: string;
  prompt: string;
  interval_ms: number;
  idle_for_ms: number;
  max_ticks: number;
  tick_count: number;
  active: number;
  created_at: string;
  next_tick_at: string;
  last_tick_at: string | null;
  last_job_id: string | null;
  last_error: string | null;
  quiet: number;
}

const ACTIVE_JOB_STATUSES = new Set<RelayJobStatus>(["queued", "blocked", "running"]);
export const DEFAULT_IDLE_FOR_MS = 180_000;
export const MIN_MONITOR_INTERVAL_MS = 30_000;
export const MONITOR_STATUS_FORMAT =
  "Reply with a short plain-English status a phone reader can skim — a few sentences, phase-level, no ids or jargon. If your status needs an action or decision from Lee, start the message with: NEEDS YOU —";

export class MonitorService {
  readonly #db: DatabaseSync;
  readonly #enqueue: MonitorServiceOptions["enqueue"];
  readonly #getJob: MonitorServiceOptions["getJob"];
  readonly #targetExists: MonitorServiceOptions["targetExists"];
  readonly #lastActivityAt: MonitorServiceOptions["lastActivityAt"];
  readonly #pollMs: number;
  readonly #minIntervalMs: number;
  #timer: NodeJS.Timeout | null = null;
  #closed = false;
  #ticking = false;

  constructor(options: MonitorServiceOptions) {
    mkdirSync(dirname(options.dbPath), { recursive: true });
    closeSync(openSync(options.dbPath, "a", 0o600));
    chmodSync(options.dbPath, 0o600);
    this.#db = new DatabaseSync(options.dbPath);
    this.#enqueue = options.enqueue;
    this.#getJob = options.getJob;
    this.#targetExists = options.targetExists;
    this.#lastActivityAt = options.lastActivityAt;
    this.#pollMs = options.pollMs ?? 1000;
    this.#minIntervalMs = options.minIntervalMs ?? MIN_MONITOR_INTERVAL_MS;
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS monitors (
        id TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        prompt TEXT NOT NULL,
        interval_ms INTEGER NOT NULL,
        idle_for_ms INTEGER NOT NULL DEFAULT 180000,
        max_ticks INTEGER NOT NULL,
        tick_count INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        next_tick_at TEXT NOT NULL,
        last_tick_at TEXT,
        last_job_id TEXT,
        last_error TEXT,
        quiet INTEGER NOT NULL DEFAULT 0
      );
    `);
    for (const path of [options.dbPath, `${options.dbPath}-wal`, `${options.dbPath}-shm`]) {
      if (existsSync(path)) chmodSync(path, 0o600);
    }
    this.#ensureIdleForColumn();
    this.#ensureQuietColumn();
  }

  start(): void {
    if (this.#timer || this.#closed) return;
    this.#timer = setInterval(() => this.#tick(), this.#pollMs);
    this.#timer.unref();
    this.#tick();
  }

  add(input: {
    target: string;
    prompt: string;
    intervalMs: number;
    idleForMs?: number;
    maxTicks: number;
    quiet?: boolean;
  }): Monitor {
    if (!this.#targetExists(input.target)) throw new Error(`unknown relay target: ${input.target}`);
    if (!input.prompt.trim()) throw new Error("prompt is required");
    if (!Number.isSafeInteger(input.intervalMs) || input.intervalMs <= 0) {
      throw new Error("intervalMs must be a positive integer");
    }
    if (input.intervalMs < this.#minIntervalMs) {
      throw new Error(`intervalMs must be at least ${this.#minIntervalMs}`);
    }
    const idleForMs = input.idleForMs ?? DEFAULT_IDLE_FOR_MS;
    if (!Number.isSafeInteger(idleForMs) || idleForMs <= 0) {
      throw new Error("idleForMs must be a positive integer");
    }
    if (!Number.isSafeInteger(input.maxTicks) || input.maxTicks <= 0) {
      throw new Error("maxTicks must be a positive integer");
    }
    const createdAt = new Date().toISOString();
    const monitor: Monitor = {
      id: randomUUID(),
      target: input.target,
      prompt: `${input.prompt.trim()}\n\n${MONITOR_STATUS_FORMAT}`,
      intervalMs: input.intervalMs,
      idleForMs,
      maxTicks: input.maxTicks,
      tickCount: 0,
      active: true,
      createdAt,
      nextTickAt: new Date(Date.now() + input.intervalMs).toISOString(),
      lastTickAt: null,
      lastJobId: null,
      lastError: null,
      quiet: input.quiet ?? false,
    };
    this.#db
      .prepare(
        `INSERT INTO monitors
         (id, target, prompt, interval_ms, idle_for_ms, max_ticks, tick_count, active, created_at,
          next_tick_at, last_tick_at, last_job_id, last_error, quiet)
         VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?, NULL, NULL, NULL, ?)`,
      )
      .run(
        monitor.id,
        monitor.target,
        monitor.prompt,
        monitor.intervalMs,
        monitor.idleForMs,
        monitor.maxTicks,
        monitor.createdAt,
        monitor.nextTickAt,
        monitor.quiet ? 1 : 0,
      );
    return monitor;
  }

  list(): Monitor[] {
    return (
      this.#db
        .prepare("SELECT * FROM monitors ORDER BY created_at, id")
        .all() as unknown as MonitorRow[]
    ).map(rowToMonitor);
  }

  get(id: string): Monitor | null {
    const row = this.#db.prepare("SELECT * FROM monitors WHERE id = ?").get(id);
    return row ? rowToMonitor(row as unknown as MonitorRow) : null;
  }

  remove(id: string): boolean {
    return this.#db.prepare("DELETE FROM monitors WHERE id = ?").run(id).changes > 0;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    while (this.#ticking) await new Promise((resolve) => setTimeout(resolve, 1));
    this.#db.close();
  }

  #tick(): void {
    if (this.#closed || this.#ticking) return;
    this.#ticking = true;
    try {
      const now = new Date();
      const rows = this.#db
        .prepare(
          `SELECT * FROM monitors
           WHERE active = 1 AND next_tick_at <= ?
           ORDER BY next_tick_at, created_at`,
        )
        .all(now.toISOString()) as unknown as MonitorRow[];
      for (const row of rows) this.#processDue(row, now);
    } finally {
      this.#ticking = false;
    }
  }

  #processDue(row: MonitorRow, now: Date): void {
    const nextTickAt = new Date(now.getTime() + row.interval_ms).toISOString();
    const claimed = this.#db
      .prepare(
        `UPDATE monitors SET next_tick_at = ?
         WHERE id = ? AND active = 1 AND next_tick_at = ?`,
      )
      .run(nextTickAt, row.id, row.next_tick_at);
    if (claimed.changes !== 1) return;

    if (row.last_job_id) {
      const previous = this.#getJob(row.last_job_id);
      if (previous && ACTIVE_JOB_STATUSES.has(previous.status)) return;
    }

    const lastActivityAt = this.#lastActivityAt(row.target);
    if (!lastActivityAt || now.getTime() - lastActivityAt.getTime() < row.idle_for_ms) return;

    try {
      const job = this.#enqueue({
        target: row.target,
        prompt: row.prompt,
        notify: row.quiet === 1 ? undefined : "photon",
      });
      const tickCount = row.tick_count + 1;
      this.#db
        .prepare(
          `UPDATE monitors
           SET tick_count = ?, active = ?, last_tick_at = ?, last_job_id = ?, last_error = NULL
           WHERE id = ?`,
        )
        .run(tickCount, tickCount < row.max_ticks ? 1 : 0, now.toISOString(), job.id, row.id);
    } catch (error) {
      this.#db
        .prepare("UPDATE monitors SET last_error = ? WHERE id = ?")
        .run(error instanceof Error ? error.message : String(error), row.id);
    }
  }

  #ensureIdleForColumn(): void {
    const columns = this.#db.prepare("PRAGMA table_info(monitors)").all() as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === "idle_for_ms")) {
      this.#db.exec(
        `ALTER TABLE monitors ADD COLUMN idle_for_ms INTEGER NOT NULL DEFAULT ${DEFAULT_IDLE_FOR_MS}`,
      );
    }
  }

  #ensureQuietColumn(): void {
    const columns = this.#db.prepare("PRAGMA table_info(monitors)").all() as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === "quiet")) {
      this.#db.exec("ALTER TABLE monitors ADD COLUMN quiet INTEGER NOT NULL DEFAULT 0");
    }
  }
}

function rowToMonitor(row: MonitorRow): Monitor {
  return {
    id: row.id,
    target: row.target,
    prompt: row.prompt,
    intervalMs: row.interval_ms,
    idleForMs: row.idle_for_ms,
    maxTicks: row.max_ticks,
    tickCount: row.tick_count,
    active: row.active === 1,
    createdAt: row.created_at,
    nextTickAt: row.next_tick_at,
    lastTickAt: row.last_tick_at,
    lastJobId: row.last_job_id,
    lastError: row.last_error,
    quiet: row.quiet === 1,
  };
}
