import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type RelayJobStatus = "queued" | "blocked" | "running" | "completed" | "failed";

export interface RelayTarget {
  hostId: string;
  threadId: string;
  cwd: string;
  command: string;
  /** Arguments before the prompt. The prompt is always appended as one argv item. */
  args: string[];
  /** Maximum wall-clock time for one turn. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface RelayJob {
  id: string;
  target: string;
  prompt: string;
  status: RelayJobStatus;
  output: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  notify: "photon" | null;
  deliveryStatus: "pending" | "delivering" | "delivered" | "failed" | null;
  deliveryError: string | null;
}

interface RelayQueueOptions {
  dbPath: string;
  targets: Record<string, RelayTarget>;
  isBusy: (target: RelayTarget) => boolean | Promise<boolean>;
  execute: (target: RelayTarget, prompt: string, signal: AbortSignal) => Promise<string>;
  deliver?: (job: RelayJob) => Promise<void>;
  busyPollMs?: number;
}

type Waiter = (job: RelayJob) => void;

export class RelayQueue {
  readonly #db: DatabaseSync;
  readonly #targets: Record<string, RelayTarget>;
  readonly #isBusy: RelayQueueOptions["isBusy"];
  readonly #execute: RelayQueueOptions["execute"];
  readonly #deliver: RelayQueueOptions["deliver"];
  readonly #busyPollMs: number;
  readonly #runningTargets = new Set<string>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #waiters = new Map<string, Waiter[]>();
  readonly #activeRuns = new Set<Promise<void>>();
  readonly #controllers = new Set<AbortController>();
  #closed = false;

  constructor(options: RelayQueueOptions) {
    mkdirSync(dirname(options.dbPath), { recursive: true });
    closeSync(openSync(options.dbPath, "a", 0o600));
    chmodSync(options.dbPath, 0o600);
    this.#db = new DatabaseSync(options.dbPath);
    this.#targets = options.targets;
    this.#isBusy = options.isBusy;
    this.#execute = options.execute;
    this.#deliver = options.deliver;
    this.#busyPollMs = options.busyPollMs ?? 2000;
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS relay_jobs (
        id TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        output TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
        ,notify TEXT
        ,delivery_status TEXT
        ,delivery_error TEXT
        ,owner_pid INTEGER
      );
    `);
    const columns = this.#db.prepare("PRAGMA table_info(relay_jobs)").all() as unknown as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === "owner_pid")) {
      this.#db.exec("ALTER TABLE relay_jobs ADD COLUMN owner_pid INTEGER");
    }
    for (const path of [options.dbPath, `${options.dbPath}-wal`, `${options.dbPath}-shm`]) {
      if (existsSync(path)) chmodSync(path, 0o600);
    }
    this.#db
      .prepare(
        "UPDATE relay_jobs SET delivery_status = 'pending' WHERE delivery_status = 'delivering'",
      )
      .run();
    for (const target of Object.keys(options.targets)) this.#schedule(target);
  }

  enqueue(input: { target: string; prompt: string; notify?: "photon" }): RelayJob {
    if (!this.#targets[input.target]) throw new Error(`unknown relay target: ${input.target}`);
    if (!input.prompt.trim()) throw new Error("prompt is required");
    const job: RelayJob = {
      id: randomUUID(),
      target: input.target,
      prompt: input.prompt,
      status: "queued",
      output: null,
      error: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      notify: input.notify ?? null,
      deliveryStatus: input.notify ? "pending" : null,
      deliveryError: null,
    };
    this.#db
      .prepare(
        `INSERT INTO relay_jobs
         (id, target, prompt, status, output, error, created_at, started_at, finished_at,
          notify, delivery_status, delivery_error)
         VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, ?, ?, NULL)`,
      )
      .run(
        job.id,
        job.target,
        job.prompt,
        job.status,
        job.createdAt,
        job.notify,
        job.deliveryStatus,
      );
    this.#schedule(job.target);
    return job;
  }

  get(id: string): RelayJob | null {
    const row = this.#db.prepare("SELECT * FROM relay_jobs WHERE id = ?").get(id);
    return row ? rowToJob(row as unknown as RelayRow) : null;
  }

  wait(id: string): Promise<RelayJob> {
    const job = this.get(id);
    if (!job) return Promise.reject(new Error(`unknown relay job: ${id}`));
    if (job.status === "completed" || job.status === "failed") return Promise.resolve(job);
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const finish: Waiter = (completed) => {
        if (timer) clearTimeout(timer);
        resolve(completed);
      };
      const poll = () => {
        const current = this.get(id);
        if (current && (current.status === "completed" || current.status === "failed")) {
          const waiters = this.#waiters.get(id)?.filter((waiter) => waiter !== finish) ?? [];
          if (waiters.length) this.#waiters.set(id, waiters);
          else this.#waiters.delete(id);
          finish(current);
          return;
        }
        timer = setTimeout(poll, 50);
      };
      const waiters = this.#waiters.get(id) ?? [];
      waiters.push(finish);
      this.#waiters.set(id, waiters);
      timer = setTimeout(poll, 50);
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    for (const controller of this.#controllers) controller.abort();
    await Promise.allSettled(this.#activeRuns);
    this.#db.close();
  }

  #schedule(target: string): void {
    if (this.#closed || this.#runningTargets.has(target)) return;
    queueMicrotask(() => {
      if (this.#closed) return;
      const run = this.#runTarget(target);
      this.#activeRuns.add(run);
      void run.finally(() => this.#activeRuns.delete(run));
    });
  }

  async #runTarget(targetName: string): Promise<void> {
    if (this.#closed || this.#runningTargets.has(targetName)) return;
    this.#runningTargets.add(targetName);
    try {
      const target = this.#targets[targetName];
      if (!target) return;
      const interrupted = this.#db
        .prepare(
          "SELECT id, owner_pid FROM relay_jobs WHERE target = ? AND status = 'running' LIMIT 1",
        )
        .get(targetName) as { id: string; owner_pid: number | null } | undefined;
      if (interrupted) {
        if (interrupted.owner_pid !== null && processIsAlive(interrupted.owner_pid)) {
          this.#defer(targetName);
          return;
        }
        if (await this.#isBusy(target)) {
          this.#defer(targetName);
          return;
        }
        this.#db
          .prepare(
            `UPDATE relay_jobs
             SET status = 'failed',
                 error = 'relay lost track of this job after restart; the turn may have completed — check the durable thread',
                 finished_at = ?
             WHERE id = ? AND status = 'running'`,
          )
          .run(new Date().toISOString(), interrupted.id);
        this.#notify(interrupted.id);
      }
      await this.#deliverPending(targetName);
      while (!this.#closed) {
        const row = this.#db
          .prepare(
            `SELECT * FROM relay_jobs
             WHERE target = ? AND status IN ('queued', 'blocked')
             ORDER BY created_at, rowid LIMIT 1`,
          )
          .get(targetName) as unknown as RelayRow | undefined;
        if (!row) return;
        const job = rowToJob(row);
        if (await this.#isBusy(target)) {
          this.#db.prepare("UPDATE relay_jobs SET status = 'blocked' WHERE id = ?").run(job.id);
          this.#defer(targetName);
          return;
        }
        // The busy scan is advisory. An interactive writer can still attach
        // before spawn; the LHC single-writer lock remains authoritative and
        // its collision is surfaced as a failed relay job.
        const startedAt = new Date().toISOString();
        const claim = this.#db
          .prepare(
            `UPDATE relay_jobs
             SET status = 'running', started_at = ?, error = NULL, owner_pid = ?
             WHERE id = ? AND status IN ('queued', 'blocked')
               AND NOT EXISTS (
                 SELECT 1 FROM relay_jobs AS active
                 WHERE active.target = ? AND active.status = 'running'
               )`,
          )
          .run(startedAt, process.pid, job.id, targetName);
        if (claim.changes !== 1) {
          this.#defer(targetName);
          return;
        }
        const controller = new AbortController();
        this.#controllers.add(controller);
        try {
          const output = await this.#execute(target, job.prompt, controller.signal);
          const finishedAt = new Date().toISOString();
          this.#db
            .prepare(
              "UPDATE relay_jobs SET status = 'completed', output = ?, finished_at = ? WHERE id = ?",
            )
            .run(output, finishedAt, job.id);
          await this.#deliverCompleted(job.id);
        } catch (error) {
          const finishedAt = new Date().toISOString();
          this.#db
            .prepare(
              "UPDATE relay_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?",
            )
            .run(error instanceof Error ? error.message : String(error), finishedAt, job.id);
        } finally {
          this.#controllers.delete(controller);
        }
        this.#notify(job.id);
      }
    } finally {
      this.#runningTargets.delete(targetName);
    }
  }

  #notify(id: string): void {
    const job = this.get(id);
    if (!job) return;
    for (const resolve of this.#waiters.get(id) ?? []) resolve(job);
    this.#waiters.delete(id);
  }

  #defer(target: string): void {
    this.#timers.set(
      target,
      setTimeout(() => {
        this.#timers.delete(target);
        this.#schedule(target);
      }, this.#busyPollMs),
    );
  }

  async #deliverPending(target: string): Promise<void> {
    const rows = this.#db
      .prepare(
        `SELECT id FROM relay_jobs
         WHERE target = ? AND status = 'completed' AND delivery_status = 'pending'
         ORDER BY finished_at, rowid`,
      )
      .all(target) as unknown as Array<{ id: string }>;
    for (const row of rows) await this.#deliverCompleted(row.id);
  }

  async #deliverCompleted(id: string): Promise<void> {
    const job = this.get(id);
    if (job?.status !== "completed" || !job.notify || !this.#deliver) return;
    const claim = this.#db
      .prepare(
        `UPDATE relay_jobs SET delivery_status = 'delivering', delivery_error = NULL
         WHERE id = ? AND delivery_status = 'pending'`,
      )
      .run(id);
    if (claim.changes !== 1) return;
    try {
      await this.#deliver(this.get(id)!);
      this.#db.prepare("UPDATE relay_jobs SET delivery_status = 'delivered' WHERE id = ?").run(id);
    } catch (error) {
      this.#db
        .prepare(
          "UPDATE relay_jobs SET delivery_status = 'failed', delivery_error = ? WHERE id = ?",
        )
        .run(error instanceof Error ? error.message : String(error), id);
    }
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
    );
  }
}

interface RelayRow {
  id: string;
  target: string;
  prompt: string;
  status: string;
  output: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  notify: string | null;
  delivery_status: string | null;
  delivery_error: string | null;
}

function rowToJob(row: RelayRow): RelayJob {
  return {
    id: row.id,
    target: row.target,
    prompt: row.prompt,
    status: row.status as RelayJobStatus,
    output: row.output,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    notify: row.notify as "photon" | null,
    deliveryStatus:
      row.delivery_status === null ? null : (row.delivery_status as RelayJob["deliveryStatus"]),
    deliveryError: row.delivery_error,
  };
}
