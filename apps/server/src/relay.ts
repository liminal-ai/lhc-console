import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyGroupWakeFailureFallback } from "./relay-failure-fallback.ts";
import { processIsAlive } from "./process-alive.ts";
import { ensureColumn, runExclusiveMigration } from "./sqlite-migrate.ts";

export type RelayJobStatus = "queued" | "blocked" | "running" | "completed" | "failed";

export const DELIVERY_LEASE_MS = 60_000;
export const DELIVERY_HEARTBEAT_MS = 15_000;
export const DELIVERY_RETRY_BASE_MS = 250;
export const DELIVERY_RETRY_MAX_MS = 30_000;
export const CLOSE_TIMEOUT_MS = 5_000;

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

export interface RelayDelivery {
  channel: string;
  destination: Record<string, string>;
  metadata?: Record<string, unknown>;
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
  delivery: RelayDelivery | null;
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
  deliveryLeaseMs?: number;
  deliveryHeartbeatMs?: number;
  closeTimeoutMs?: number;
  consoleHome?: string;
}

type Waiter = (job: RelayJob) => void;
type SettledListener = (job: RelayJob) => void;

export class RelayQueue {
  readonly #dbPath: string;
  readonly #db: DatabaseSync;
  readonly #targets: Record<string, RelayTarget>;
  readonly #isBusy: RelayQueueOptions["isBusy"];
  readonly #execute: RelayQueueOptions["execute"];
  readonly #deliver: RelayQueueOptions["deliver"];
  readonly #busyPollMs: number;
  readonly #deliveryLeaseMs: number;
  readonly #deliveryHeartbeatMs: number;
  readonly #closeTimeoutMs: number;
  readonly #consoleHome?: string;
  readonly #runningTargets = new Set<string>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #deliveryRetryTimers = new Map<string, NodeJS.Timeout>();
  readonly #failureFallbackRetryTimers = new Map<string, NodeJS.Timeout>();
  readonly #waiters = new Map<string, Waiter[]>();
  readonly #activeRuns = new Set<Promise<void>>();
  readonly #controllers = new Set<AbortController>();
  readonly #settledListeners: SettledListener[] = [];
  #outstandingRuns = 0;
  readonly #outstandingWaiters: Array<() => void> = [];
  #closed = false;
  #started = false;
  #dbClosed = false;
  #closeWhenIdle: Promise<void> | null = null;

  constructor(options: RelayQueueOptions) {
    mkdirSync(dirname(options.dbPath), { recursive: true });
    closeSync(openSync(options.dbPath, "a", 0o600));
    chmodSync(options.dbPath, 0o600);
    this.#dbPath = options.dbPath;
    this.#db = new DatabaseSync(options.dbPath);
    this.#targets = options.targets;
    this.#isBusy = options.isBusy;
    this.#execute = options.execute;
    this.#deliver = options.deliver;
    this.#busyPollMs = options.busyPollMs ?? 2000;
    this.#deliveryLeaseMs = options.deliveryLeaseMs ?? DELIVERY_LEASE_MS;
    this.#deliveryHeartbeatMs = options.deliveryHeartbeatMs ?? DELIVERY_HEARTBEAT_MS;
    this.#closeTimeoutMs = options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS;
    this.#consoleHome = options.consoleHome;
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
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
        ,delivery_channel TEXT
        ,delivery_destination TEXT
        ,delivery_metadata TEXT
        ,delivery_owner_pid INTEGER
        ,delivery_owner_token TEXT
        ,delivery_lease_expires_at TEXT
      );
    `);
    this.#ensureColumns();
    for (const path of [options.dbPath, `${options.dbPath}-wal`, `${options.dbPath}-shm`]) {
      if (existsSync(path)) chmodSync(path, 0o600);
    }
    this.#reclaimOrphanedDeliveries();
    this.#processPendingFailureFallbacks();
  }

  start(): void {
    if (this.#started || this.#closed) return;
    this.#started = true;
    for (const target of Object.keys(this.#targets)) this.#schedule(target);
  }

  addSettledListener(listener: SettledListener): void {
    this.#settledListeners.push(listener);
  }

  enqueue(input: {
    target: string;
    prompt: string;
    notify?: "photon";
    delivery?: RelayDelivery;
  }): RelayJob {
    if (!this.#targets[input.target]) throw new Error(`unknown relay target: ${input.target}`);
    if (!input.prompt.trim()) throw new Error("prompt is required");
    const wantsDelivery = Boolean(input.delivery ?? input.notify);
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
      delivery: input.delivery ?? null,
      deliveryStatus: wantsDelivery ? "pending" : null,
      deliveryError: null,
    };
    this.#db
      .prepare(
        `INSERT INTO relay_jobs
         (id, target, prompt, status, output, error, created_at, started_at, finished_at,
          notify, delivery_status, delivery_error, delivery_channel, delivery_destination,
          delivery_metadata)
         VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(
        job.id,
        job.target,
        job.prompt,
        job.status,
        job.createdAt,
        job.notify,
        job.deliveryStatus,
        job.delivery?.channel ?? null,
        job.delivery ? JSON.stringify(job.delivery.destination) : null,
        job.delivery?.metadata ? JSON.stringify(job.delivery.metadata) : null,
      );
    this.#schedule(job.target);
    return job;
  }

  get(id: string): RelayJob | null {
    if (!this.#dbClosed) {
      return this.#withDb(() => {
        const row = this.#db.prepare("SELECT * FROM relay_jobs WHERE id = ?").get(id);
        return row ? rowToJob(row as unknown as RelayRow) : null;
      }, null);
    }
    const db = new DatabaseSync(this.#dbPath);
    try {
      const row = db.prepare("SELECT * FROM relay_jobs WHERE id = ?").get(id);
      return row ? rowToJob(row as unknown as RelayRow) : null;
    } finally {
      db.close();
    }
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
    await Promise.race([Promise.allSettled(this.#activeRuns), sleep(this.#closeTimeoutMs)]);
    void this.#closeDbWhenIdle();
  }

  #notifyOutstandingDrain(): void {
    if (this.#outstandingRuns > 0) return;
    for (const waiter of this.#outstandingWaiters.splice(0)) waiter();
  }

  #waitForOutstandingDrain(): Promise<void> {
    if (this.#outstandingRuns === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.#outstandingWaiters.push(resolve);
    });
  }

  #closeDbWhenIdle(): Promise<void> {
    if (this.#closeWhenIdle) return this.#closeWhenIdle;
    this.#closeWhenIdle = (async () => {
      while (this.#outstandingRuns > 0) {
        await this.#waitForOutstandingDrain();
      }
      if (this.#dbClosed) return;
      try {
        this.#db.close();
      } catch {
        // already closed
      }
      this.#dbClosed = true;
    })();
    return this.#closeWhenIdle;
  }

  #withDb<T>(fn: () => T, fallback: T): T {
    if (this.#dbClosed) return fallback;
    try {
      return fn();
    } catch (error) {
      if (this.#closed) return fallback;
      throw error;
    }
  }

  #ensureColumns(): void {
    runExclusiveMigration(this.#db, () => {
      ensureColumn(
        this.#db,
        "relay_jobs",
        "owner_pid",
        "ALTER TABLE relay_jobs ADD COLUMN owner_pid INTEGER",
      );
      ensureColumn(
        this.#db,
        "relay_jobs",
        "delivery_channel",
        "ALTER TABLE relay_jobs ADD COLUMN delivery_channel TEXT",
      );
      ensureColumn(
        this.#db,
        "relay_jobs",
        "delivery_destination",
        "ALTER TABLE relay_jobs ADD COLUMN delivery_destination TEXT",
      );
      ensureColumn(
        this.#db,
        "relay_jobs",
        "delivery_metadata",
        "ALTER TABLE relay_jobs ADD COLUMN delivery_metadata TEXT",
      );
      ensureColumn(
        this.#db,
        "relay_jobs",
        "delivery_owner_pid",
        "ALTER TABLE relay_jobs ADD COLUMN delivery_owner_pid INTEGER",
      );
      ensureColumn(
        this.#db,
        "relay_jobs",
        "delivery_owner_token",
        "ALTER TABLE relay_jobs ADD COLUMN delivery_owner_token TEXT",
      );
      ensureColumn(
        this.#db,
        "relay_jobs",
        "delivery_lease_expires_at",
        "ALTER TABLE relay_jobs ADD COLUMN delivery_lease_expires_at TEXT",
      );
      ensureColumn(
        this.#db,
        "relay_jobs",
        "failure_fallback_applied",
        "ALTER TABLE relay_jobs ADD COLUMN failure_fallback_applied INTEGER NOT NULL DEFAULT 0",
      );
    });
  }

  #reclaimOrphanedDeliveries(): void {
    const nowIso = new Date().toISOString();
    const rows = this.#db
      .prepare(
        `SELECT id, delivery_owner_pid, delivery_owner_token, delivery_lease_expires_at
         FROM relay_jobs
         WHERE delivery_status = 'delivering'`,
      )
      .all() as Array<{
      id: string;
      delivery_owner_pid: number | null;
      delivery_owner_token: string | null;
      delivery_lease_expires_at: string | null;
    }>;
    for (const row of rows) {
      const ownerAlive = row.delivery_owner_pid !== null && processIsAlive(row.delivery_owner_pid);
      const leaseValid = Boolean(
        row.delivery_lease_expires_at && row.delivery_lease_expires_at > nowIso,
      );
      if (ownerAlive && leaseValid) continue;
      this.#db
        .prepare(
          `UPDATE relay_jobs
           SET delivery_status = 'pending',
               delivery_error = NULL,
               delivery_owner_pid = NULL,
               delivery_owner_token = NULL,
               delivery_lease_expires_at = NULL
           WHERE id = ? AND delivery_status = 'delivering'
             AND delivery_owner_token IS ?
             AND delivery_lease_expires_at IS ?`,
        )
        .run(row.id, row.delivery_owner_token, row.delivery_lease_expires_at);
    }
  }

  #schedule(target: string): void {
    if (this.#closed || !this.#started || this.#runningTargets.has(target)) return;
    queueMicrotask(() => {
      if (this.#closed || !this.#started) return;
      const run = this.#runTarget(target);
      this.#activeRuns.add(run);
      void run.finally(() => this.#activeRuns.delete(run));
    });
  }

  async #runTarget(targetName: string): Promise<void> {
    if (this.#closed || !this.#started || this.#runningTargets.has(targetName)) return;
    this.#runningTargets.add(targetName);
    this.#outstandingRuns += 1;
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
        this.#emitSettled(interrupted.id);
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
          this.#withDb(() => {
            this.#db
              .prepare(
                "UPDATE relay_jobs SET status = 'completed', output = ?, finished_at = ? WHERE id = ?",
              )
              .run(output, finishedAt, job.id);
          }, undefined);
          if (!this.#dbClosed) await this.#deliverCompleted(job.id);
        } catch (error) {
          const finishedAt = new Date().toISOString();
          const message = error instanceof Error ? error.message : String(error);
          this.#withDb(() => {
            this.#db
              .prepare(
                "UPDATE relay_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?",
              )
              .run(message, finishedAt, job.id);
          }, undefined);
          this.#applyFailureFallback(job.id);
        } finally {
          this.#controllers.delete(controller);
        }
        this.#notify(job.id);
        this.#emitSettled(job.id);
      }
    } finally {
      this.#runningTargets.delete(targetName);
      this.#outstandingRuns -= 1;
      this.#notifyOutstandingDrain();
    }
  }

  #notify(id: string): void {
    const job = this.get(id);
    if (!job) return;
    for (const resolve of this.#waiters.get(id) ?? []) resolve(job);
    this.#waiters.delete(id);
  }

  #emitSettled(id: string): void {
    const job = this.get(id);
    if (!job) return;
    for (const listener of this.#settledListeners) listener(job);
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
         WHERE target = ? AND status = 'completed'
           AND delivery_status IN ('pending', 'failed')
         ORDER BY finished_at, rowid`,
      )
      .all(target) as unknown as Array<{ id: string }>;
    for (const row of rows) await this.#deliverCompleted(row.id);
  }

  #claimDelivery(id: string): string | null {
    const nowIso = new Date().toISOString();
    const leaseExpires = new Date(Date.now() + this.#deliveryLeaseMs).toISOString();
    const token = randomUUID();
    const row = this.#db
      .prepare(
        `SELECT delivery_status, delivery_owner_pid, delivery_owner_token, delivery_lease_expires_at
         FROM relay_jobs WHERE id = ? AND status = 'completed'`,
      )
      .get(id) as
      | {
          delivery_status: string | null;
          delivery_owner_pid: number | null;
          delivery_owner_token: string | null;
          delivery_lease_expires_at: string | null;
        }
      | undefined;
    if (!row?.delivery_status) return null;
    if (row.delivery_status === "delivering") {
      const ownerAlive = row.delivery_owner_pid !== null && processIsAlive(row.delivery_owner_pid);
      const leaseValid = Boolean(
        row.delivery_lease_expires_at && row.delivery_lease_expires_at > nowIso,
      );
      if (ownerAlive && leaseValid) return null;
      const observedToken = row.delivery_owner_token;
      const observedLease = row.delivery_lease_expires_at;
      const reclaim = this.#db
        .prepare(
          `UPDATE relay_jobs
           SET delivery_status = 'delivering',
               delivery_error = NULL,
               delivery_owner_pid = ?,
               delivery_owner_token = ?,
               delivery_lease_expires_at = ?
           WHERE id = ? AND status = 'completed' AND delivery_status = 'delivering'
             AND delivery_owner_token IS ?
             AND delivery_lease_expires_at IS ?`,
        )
        .run(process.pid, token, leaseExpires, id, observedToken, observedLease);
      return reclaim.changes === 1 ? token : null;
    }
    if (row.delivery_status !== "pending" && row.delivery_status !== "failed") return null;
    const claim = this.#db
      .prepare(
        `UPDATE relay_jobs
         SET delivery_status = 'delivering',
             delivery_error = NULL,
             delivery_owner_pid = ?,
             delivery_owner_token = ?,
             delivery_lease_expires_at = ?
         WHERE id = ? AND status = 'completed' AND delivery_status IN ('pending', 'failed')`,
      )
      .run(process.pid, token, leaseExpires, id);
    return claim.changes === 1 ? token : null;
  }

  #renewDeliveryLease(id: string, token: string): boolean {
    const leaseExpires = new Date(Date.now() + this.#deliveryLeaseMs).toISOString();
    const renewed = this.#db
      .prepare(
        `UPDATE relay_jobs
         SET delivery_lease_expires_at = ?
         WHERE id = ? AND delivery_owner_token = ? AND delivery_status = 'delivering'`,
      )
      .run(leaseExpires, id, token);
    return renewed.changes === 1;
  }

  #finalizeDelivery(
    id: string,
    token: string,
    outcome: { status: "delivered" } | { status: "failed"; error: string },
  ): boolean {
    if (outcome.status === "delivered") {
      const updated = this.#db
        .prepare(
          `UPDATE relay_jobs
           SET delivery_status = 'delivered',
               delivery_error = NULL,
               delivery_owner_pid = NULL,
               delivery_owner_token = NULL,
               delivery_lease_expires_at = NULL
           WHERE id = ? AND delivery_owner_token = ? AND delivery_status = 'delivering'`,
        )
        .run(id, token);
      return updated.changes === 1;
    }
    const updated = this.#db
      .prepare(
        `UPDATE relay_jobs
         SET delivery_status = 'failed',
             delivery_error = ?,
             delivery_owner_pid = NULL,
             delivery_owner_token = NULL,
             delivery_lease_expires_at = NULL
         WHERE id = ? AND delivery_owner_token = ? AND delivery_status = 'delivering'`,
      )
      .run(outcome.error, id, token);
    return updated.changes === 1;
  }

  async #deliverCompleted(id: string, attempt = 0): Promise<void> {
    this.#outstandingRuns += 1;
    try {
      if (this.#dbClosed) return;
      const job = this.get(id);
      if (job?.status !== "completed" || !this.#needsDelivery(job) || !this.#deliver) return;
      const token = this.#claimDelivery(id);
      if (!token) return;
      let leaseLost = false;
      const heartbeat = setInterval(() => {
        if (!this.#renewDeliveryLease(id, token)) {
          leaseLost = true;
        }
      }, this.#deliveryHeartbeatMs);
      try {
        await this.#deliver(this.get(id)!);
        if (leaseLost || !this.#renewDeliveryLease(id, token)) return;
        if (this.#finalizeDelivery(id, token, { status: "delivered" })) {
          this.#deliveryRetryTimers.delete(id);
        }
      } catch (error) {
        if (leaseLost) return;
        const message = error instanceof Error ? error.message : String(error);
        if (this.#finalizeDelivery(id, token, { status: "failed", error: message })) {
          this.#scheduleDeliveryRetry(id, attempt + 1);
        }
      } finally {
        clearInterval(heartbeat);
      }
      this.#emitSettled(id);
    } finally {
      this.#outstandingRuns -= 1;
      this.#notifyOutstandingDrain();
    }
  }

  #applyFailureFallback(id: string, attempt = 0): void {
    if (!this.#consoleHome) return;
    const row = this.#withDb(
      () =>
        this.#db
          .prepare(
            `SELECT target, status, delivery_channel, delivery_destination, delivery_metadata,
                    failure_fallback_applied
             FROM relay_jobs WHERE id = ?`,
          )
          .get(id) as RelayRow | undefined,
      undefined,
    );
    if (!row || row.status !== "failed" || (row.failure_fallback_applied ?? 0) !== 0) return;
    const job = rowToJob(row);
    try {
      if (!applyGroupWakeFailureFallback(job, this.#consoleHome)) return;
      this.#withDb(
        () =>
          this.#db
            .prepare("UPDATE relay_jobs SET failure_fallback_applied = 1 WHERE id = ?")
            .run(id),
        undefined,
      );
      const existing = this.#failureFallbackRetryTimers.get(id);
      if (existing) clearTimeout(existing);
      this.#failureFallbackRetryTimers.delete(id);
    } catch {
      this.#scheduleFailureFallbackRetry(id, attempt);
    }
  }

  #scheduleFailureFallbackRetry(id: string, attempt: number): void {
    if (this.#closed) return;
    const existing = this.#failureFallbackRetryTimers.get(id);
    if (existing) clearTimeout(existing);
    else {
      this.#outstandingRuns += 1;
    }
    const delay = Math.min(DELIVERY_RETRY_BASE_MS * 2 ** attempt, DELIVERY_RETRY_MAX_MS);
    const timer = setTimeout(() => {
      this.#failureFallbackRetryTimers.delete(id);
      this.#outstandingRuns -= 1;
      this.#notifyOutstandingDrain();
      this.#applyFailureFallback(id, attempt + 1);
    }, delay);
    this.#failureFallbackRetryTimers.set(id, timer);
  }

  #processPendingFailureFallbacks(): void {
    if (!this.#consoleHome) return;
    const rows = this.#db
      .prepare(
        `SELECT id FROM relay_jobs
         WHERE status = 'failed' AND failure_fallback_applied = 0
           AND delivery_metadata IS NOT NULL`,
      )
      .all() as Array<{ id: string }>;
    for (const row of rows) this.#applyFailureFallback(row.id, 0);
  }

  #scheduleDeliveryRetry(id: string, attempt: number): void {
    if (this.#closed) return;
    const existing = this.#deliveryRetryTimers.get(id);
    if (existing) clearTimeout(existing);
    else {
      this.#outstandingRuns += 1;
    }
    const delay = Math.min(DELIVERY_RETRY_BASE_MS * 2 ** attempt, DELIVERY_RETRY_MAX_MS);
    const timer = setTimeout(() => {
      this.#deliveryRetryTimers.delete(id);
      this.#outstandingRuns -= 1;
      this.#notifyOutstandingDrain();
      const run = this.#deliverCompleted(id, attempt);
      this.#activeRuns.add(run);
      void run.finally(() => this.#activeRuns.delete(run));
    }, delay);
    this.#deliveryRetryTimers.set(id, timer);
  }

  #needsDelivery(job: RelayJob): boolean {
    return Boolean(job.delivery ?? job.notify);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  delivery_channel: string | null;
  delivery_destination: string | null;
  delivery_metadata: string | null;
  delivery_status: string | null;
  delivery_error: string | null;
  failure_fallback_applied: number;
}

function rowToJob(row: RelayRow): RelayJob {
  const delivery =
    row.delivery_channel && row.delivery_destination
      ? {
          channel: row.delivery_channel,
          destination: JSON.parse(row.delivery_destination) as Record<string, string>,
          ...(row.delivery_metadata
            ? { metadata: JSON.parse(row.delivery_metadata) as Record<string, unknown> }
            : {}),
        }
      : null;
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
    delivery,
    deliveryStatus:
      row.delivery_status === null ? null : (row.delivery_status as RelayJob["deliveryStatus"]),
    deliveryError: row.delivery_error,
  };
}
