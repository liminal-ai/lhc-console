import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyGroupWakeFailureFallback } from "./relay-failure-fallback.ts";
import { processIsAlive } from "./process-alive.ts";
import { stripPtyFraming } from "./relay-process.ts";
import { ensureColumn, runExclusiveMigration } from "./sqlite-migrate.ts";

export type RelayJobStatus =
  | "queued"
  | "blocked"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";
export type RelayJobClass = "prioritized" | "deprioritized";
export type RelayJobKind = "agent" | "outbound";

export function parseRelayJobClass(value: unknown): RelayJobClass {
  if (value === undefined || value === null) return "deprioritized";
  if (value === "prioritized" || value === "deprioritized") return value;
  throw new Error('jobClass must be "prioritized" or "deprioritized"');
}

export function normalizeRelayJobClass(value: string | null | undefined): RelayJobClass {
  return value === "prioritized" ? "prioritized" : "deprioritized";
}

export function parseRelayJobKind(value: unknown): RelayJobKind {
  if (value === undefined || value === null) return "agent";
  if (value === "agent" || value === "outbound") return value;
  throw new Error('jobKind must be "agent" or "outbound"');
}

export function normalizeRelayJobKind(value: string | null | undefined): RelayJobKind {
  return value === "outbound" ? "outbound" : "agent";
}

export function isRelayJobWaitSettled(job: RelayJob): boolean {
  if (job.jobKind === "outbound") {
    if (job.status === "failed" || job.status === "cancelled") return true;
    return job.deliveryStatus === "delivered" || job.deliveryStatus === "failed-final";
  }
  return isSettledStatus(job.status);
}

export const DELIVERY_LEASE_MS = 60_000;
export const DELIVERY_HEARTBEAT_MS = 15_000;
export const DELIVERY_RETRY_BASE_MS = 250;
export const DELIVERY_RETRY_MAX_MS = 30_000;
/** Transient delivery failures retry up to this many attempts, then settle as failed-final. */
export const MAX_DELIVERY_ATTEMPTS = 8;

/** What a delivery reports back on success; recorded on the job's delivery metadata. */
export interface DeliveryReceipt {
  /** Agent identity whose Photon line carried the message (sender or console fallback). */
  deliveredVia?: string;
}

/**
 * A delivery error that no retry can fix (sidecar 4xx, target not allowed,
 * auth or config). Duck-typed so the connector does not import this module.
 */
export function isPermanentDeliveryError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { permanent?: unknown }).permanent === true
  );
}
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
  /**
   * Run this target's jobs concurrently instead of one at a time. For hosts whose
   * seat command owns its own serialization (the t3code injector queues per
   * sender and steers a busy thread), the relay's one-running-job claim would
   * only defeat that. Default off.
   */
  concurrent?: boolean;
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
  jobClass: RelayJobClass;
  jobKind: RelayJobKind;
  sender: string | null;
  output: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  notify: "photon" | null;
  delivery: RelayDelivery | null;
  /** failed: transient, retried; failed-final: permanent or retries exhausted, never resumed. */
  deliveryStatus: "pending" | "delivering" | "delivered" | "failed" | "failed-final" | null;
  deliveryError: string | null;
}

export interface RelayExecuteLifecycle {
  onSpawn?: () => void;
}

export interface RelayJobLifecycle {
  onRunning?: (job: RelayJob) => void;
  onSpawn?: (job: RelayJob) => void;
  onFinished?: (job: RelayJob) => void | Promise<void>;
  onCancellationIntent?: (job: RelayJob) => void | Promise<void>;
  onClose?: () => void | Promise<void>;
}

interface RelayQueueOptions {
  dbPath: string;
  targets: Record<string, RelayTarget>;
  isBusy: (target: RelayTarget) => boolean | Promise<boolean>;
  execute: (
    target: RelayTarget,
    prompt: string,
    signal: AbortSignal,
    lifecycle?: RelayExecuteLifecycle,
    writerLock?: unknown,
    job?: RelayJob,
  ) => Promise<string>;
  /**
   * Optional V2-opted launch fence. Returning "blocked" defers the job the
   * same way `isBusy` does. A held lock is passed to `execute` so the writer
   * child can inherit it.
   */
  acquireWriterLock?: (target: RelayTarget) => unknown;
  releaseWriterLock?: (held: unknown) => void;
  deliver?: (job: RelayJob) => Promise<void | DeliveryReceipt>;
  jobLifecycle?: RelayJobLifecycle;
  busyPollMs?: number;
  deliveryLeaseMs?: number;
  /** Override MAX_DELIVERY_ATTEMPTS (tests). */
  maxDeliveryAttempts?: number;
  deliveryHeartbeatMs?: number;
  closeTimeoutMs?: number;
  consoleHome?: string;
}

type Waiter = (job: RelayJob) => void;
type SettledListener = (job: RelayJob) => void | Promise<void>;

export class RelayQueue {
  readonly #dbPath: string;
  readonly #db: DatabaseSync;
  readonly #targets: Record<string, RelayTarget>;
  readonly #isBusy: RelayQueueOptions["isBusy"];
  readonly #acquireWriterLock: RelayQueueOptions["acquireWriterLock"];
  readonly #releaseWriterLock: RelayQueueOptions["releaseWriterLock"];
  readonly #execute: RelayQueueOptions["execute"];
  readonly #deliver: RelayQueueOptions["deliver"];
  readonly #jobLifecycle: RelayQueueOptions["jobLifecycle"];
  readonly #busyPollMs: number;
  readonly #deliveryLeaseMs: number;
  readonly #maxDeliveryAttempts: number;
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
    this.#acquireWriterLock = options.acquireWriterLock;
    this.#releaseWriterLock = options.releaseWriterLock;
    this.#execute = options.execute;
    this.#deliver = options.deliver;
    this.#jobLifecycle = options.jobLifecycle;
    this.#busyPollMs = options.busyPollMs ?? 2000;
    this.#deliveryLeaseMs = options.deliveryLeaseMs ?? DELIVERY_LEASE_MS;
    this.#maxDeliveryAttempts = options.maxDeliveryAttempts ?? MAX_DELIVERY_ATTEMPTS;
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
      CREATE TABLE IF NOT EXISTS relay_cancelled_jobs (
        id TEXT PRIMARY KEY,
        cancelled_at TEXT NOT NULL
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

  /** Wake in-memory scheduling after a job was inserted outside RelayQueue.enqueue. */
  pokeSchedule(target: string): void {
    this.#schedule(target);
  }

  /** Wake waiters/listeners after a job was settled or cancelled outside RelayQueue. */
  pokeJobSettled(jobId: string): void {
    const job = this.get(jobId);
    if (!job || !isRelayJobWaitSettled(job)) return;
    this.#notify(jobId);
    this.#emitSettled(jobId);
  }

  addSettledListener(listener: SettledListener): () => void {
    this.#settledListeners.push(listener);
    return () => {
      const index = this.#settledListeners.indexOf(listener);
      if (index >= 0) this.#settledListeners.splice(index, 1);
    };
  }

  cancelJob(id: string): void {
    const cancelledAt = new Date().toISOString();
    const runningJob = this.#withDb(() => {
      const row = this.#db.prepare("SELECT status FROM relay_jobs WHERE id = ?").get(id) as
        | { status: string }
        | undefined;
      return row?.status === "running" ? this.get(id) : null;
    }, null);
    const changed = this.#withDb(() => {
      this.#db
        .prepare("INSERT OR IGNORE INTO relay_cancelled_jobs (id, cancelled_at) VALUES (?, ?)")
        .run(id, cancelledAt);
      return this.#db
        .prepare(
          `UPDATE relay_jobs
           SET status = 'cancelled', finished_at = ?, error = NULL
           WHERE id = ? AND status IN ('queued', 'blocked')`,
        )
        .run(cancelledAt, id).changes;
    }, 0);
    if (runningJob) {
      this.#invokeJobLifecycle("onCancellationIntent", runningJob);
    }
    if (changed === 1) {
      this.#notify(id);
      this.#emitSettled(id);
    }
  }

  #isCancelled(id: string): boolean {
    return this.#withDb(() => {
      const row = this.#db.prepare("SELECT 1 FROM relay_cancelled_jobs WHERE id = ?").get(id) as
        | { 1: number }
        | undefined;
      return Boolean(row);
    }, false);
  }

  enqueue(input: {
    id?: string;
    target: string;
    prompt: string;
    notify?: "photon";
    delivery?: RelayDelivery;
    jobClass?: RelayJobClass;
    jobKind?: RelayJobKind;
    sender?: string | null;
  }): RelayJob {
    if (!Object.hasOwn(this.#targets, input.target)) {
      throw new Error(`unknown relay target: ${input.target}`);
    }
    if (!input.prompt.trim()) throw new Error("prompt is required");
    if (input.id && this.#isCancelled(input.id)) {
      throw new Error(`relay job cancelled: ${input.id}`);
    }
    const wantsDelivery = Boolean(input.delivery ?? input.notify);
    const jobClass = parseRelayJobClass(input.jobClass);
    const jobKind = parseRelayJobKind(input.jobKind);
    const job: RelayJob = {
      id: input.id ?? randomUUID(),
      target: input.target,
      prompt: input.prompt,
      status: "queued",
      jobClass,
      jobKind,
      sender: input.sender ?? null,
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
    const inserted = this.#db
      .prepare(
        `INSERT OR IGNORE INTO relay_jobs
         (id, target, prompt, status, output, error, created_at, started_at, finished_at,
          notify, delivery_status, delivery_error, delivery_channel, delivery_destination,
          delivery_metadata, job_class, job_kind, sender)
         VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
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
        job.jobClass,
        job.jobKind,
        job.sender,
      );
    if (inserted.changes !== 1) {
      const existing = this.get(job.id);
      if (
        !existing ||
        existing.target !== job.target ||
        existing.prompt !== job.prompt ||
        existing.jobClass !== job.jobClass
      ) {
        throw new Error(`relay job id collision: ${job.id}`);
      }
      this.#schedule(job.target);
      return existing;
    }
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

  /**
   * Group-line wake jobs for one group whose reply has not settled: queued,
   * blocked or running, or completed with the delivery still in flight. This
   * is what "the member is working" means on the group page.
   */
  listUnsettledGroupJobs(groupId: string): RelayJob[] {
    return this.#withDb(() => {
      const rows = this.#db
        .prepare(
          `SELECT * FROM relay_jobs
           WHERE delivery_metadata IS NOT NULL
             AND json_extract(delivery_metadata, '$.kind') = 'group_line'
             AND json_extract(delivery_metadata, '$.groupId') = ?
             AND (status IN ('queued', 'blocked', 'running')
                  OR (status = 'completed' AND delivery_status IN ('pending', 'delivering')))
           ORDER BY created_at`,
        )
        .all(groupId) as unknown as RelayRow[];
      return rows.map((row) => rowToJob(row));
    }, []);
  }

  listRunningJobs(): RelayJob[] {
    return this.#withDb(() => {
      const rows = this.#db
        .prepare("SELECT * FROM relay_jobs WHERE status = 'running'")
        .all() as unknown as RelayRow[];
      return rows.map((row) => rowToJob(row));
    }, []);
  }

  wait(id: string): Promise<RelayJob> {
    const job = this.get(id);
    if (!job) return Promise.reject(new Error(`unknown relay job: ${id}`));
    if (isRelayJobWaitSettled(job)) return Promise.resolve(job);
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const finish: Waiter = (completed) => {
        if (timer) clearTimeout(timer);
        resolve(completed);
      };
      const poll = () => {
        const current = this.get(id);
        if (current && isRelayJobWaitSettled(current)) {
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
    const closed = this.#jobLifecycle?.onClose?.();
    if (closed) await closed.catch(() => undefined);
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
      ensureColumn(
        this.#db,
        "relay_jobs",
        "job_class",
        "ALTER TABLE relay_jobs ADD COLUMN job_class TEXT NOT NULL DEFAULT 'deprioritized'",
      );
      ensureColumn(
        this.#db,
        "relay_jobs",
        "job_kind",
        "ALTER TABLE relay_jobs ADD COLUMN job_kind TEXT NOT NULL DEFAULT 'agent'",
      );
      ensureColumn(
        this.#db,
        "relay_jobs",
        "sender",
        "ALTER TABLE relay_jobs ADD COLUMN sender TEXT",
      );
      ensureColumn(
        this.#db,
        "relay_jobs",
        "delivery_attempts",
        "ALTER TABLE relay_jobs ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0",
      );
      this.#db.exec(
        `UPDATE relay_jobs
         SET job_class = 'deprioritized'
         WHERE job_class IS NULL OR job_class NOT IN ('prioritized', 'deprioritized')`,
      );
      this.#db.exec(
        `UPDATE relay_jobs
         SET job_kind = 'agent'
         WHERE job_kind IS NULL OR job_kind NOT IN ('agent', 'outbound')`,
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

  #isConcurrent(target: string): boolean {
    return this.#targets[target]?.concurrent === true;
  }

  #schedule(target: string): void {
    if (this.#closed || !this.#started) return;
    // A concurrent target gets a runner per wake: each runner claims one job at a
    // time, so N pending wakes give up to N jobs in flight. A runner that finds
    // nothing to claim simply exits.
    if (!this.#isConcurrent(target) && this.#runningTargets.has(target)) return;
    queueMicrotask(() => {
      if (this.#closed || !this.#started) return;
      const run = this.#runTarget(target);
      this.#activeRuns.add(run);
      void run.finally(() => this.#activeRuns.delete(run));
    });
  }

  async #runTarget(targetName: string): Promise<void> {
    if (this.#closed || !this.#started) return;
    const concurrent = this.#isConcurrent(targetName);
    if (!concurrent) {
      if (this.#runningTargets.has(targetName)) return;
      this.#runningTargets.add(targetName);
    }
    this.#outstandingRuns += 1;
    try {
      const target = this.#targets[targetName];
      if (!target) return;
      if (concurrent) this.#failOrphanedRunning(targetName);
      const interrupted = concurrent
        ? undefined
        : (this.#db
            .prepare(
              "SELECT id, owner_pid FROM relay_jobs WHERE target = ? AND status = 'running' LIMIT 1",
            )
            .get(targetName) as { id: string; owner_pid: number | null } | undefined);
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
        const tombstoned = this.#db
          .prepare(
            `SELECT r.id FROM relay_jobs AS r
             WHERE r.target = ? AND r.status IN ('queued', 'blocked')
               AND EXISTS (SELECT 1 FROM relay_cancelled_jobs AS c WHERE c.id = r.id)
             ORDER BY CASE r.job_class WHEN 'prioritized' THEN 0 ELSE 1 END, r.created_at, r.rowid
             LIMIT 1`,
          )
          .get(targetName) as { id: string } | undefined;
        if (tombstoned) {
          const cancelledAt = new Date().toISOString();
          const cancelled = this.#db
            .prepare(
              `UPDATE relay_jobs
               SET status = 'cancelled', finished_at = ?, error = NULL
               WHERE id = ? AND status IN ('queued', 'blocked')`,
            )
            .run(cancelledAt, tombstoned.id);
          if (cancelled.changes === 1) {
            this.#notify(tombstoned.id);
            this.#emitSettled(tombstoned.id);
          }
          continue;
        }
        if (await this.#isBusy(target)) {
          this.#db
            .prepare(
              `UPDATE relay_jobs
               SET status = 'blocked'
               WHERE id = (
                 SELECT r.id FROM relay_jobs AS r
                 WHERE r.target = ? AND r.status = 'queued'
                   AND NOT EXISTS (
                     SELECT 1 FROM relay_cancelled_jobs AS c WHERE c.id = r.id
                   )
                 ORDER BY CASE r.job_class WHEN 'prioritized' THEN 0 ELSE 1 END, r.created_at, r.rowid
                 LIMIT 1
               )`,
            )
            .run(targetName);
          this.#defer(targetName);
          return;
        }
        const launchFence = this.#acquireWriterLock?.(target);
        if (launchFence === "blocked" || launchFence === "unresolved") {
          this.#db
            .prepare(
              `UPDATE relay_jobs
               SET status = 'blocked'
               WHERE id = (
                 SELECT r.id FROM relay_jobs AS r
                 WHERE r.target = ? AND r.status = 'queued'
                   AND NOT EXISTS (
                     SELECT 1 FROM relay_cancelled_jobs AS c WHERE c.id = r.id
                   )
                 ORDER BY CASE r.job_class WHEN 'prioritized' THEN 0 ELSE 1 END, r.created_at, r.rowid
                 LIMIT 1
               )`,
            )
            .run(targetName);
          this.#defer(targetName);
          return;
        }
        const startedAt = new Date().toISOString();
        const claim = this.#db
          .prepare(
            `UPDATE relay_jobs
             SET status = 'running', started_at = ?, error = NULL, owner_pid = ?
             WHERE id = (
               SELECT r.id FROM relay_jobs AS r
               WHERE r.target = ? AND r.status IN ('queued', 'blocked')
                 AND NOT EXISTS (
                   SELECT 1 FROM relay_cancelled_jobs AS c WHERE c.id = r.id
                 )
               ORDER BY CASE r.job_class WHEN 'prioritized' THEN 0 ELSE 1 END, r.created_at, r.rowid
               LIMIT 1
             )
               AND id = (
                 SELECT r.id FROM relay_jobs AS r
                 WHERE r.target = ? AND r.status IN ('queued', 'blocked')
                   AND NOT EXISTS (
                     SELECT 1 FROM relay_cancelled_jobs AS c WHERE c.id = r.id
                   )
                 ORDER BY CASE r.job_class WHEN 'prioritized' THEN 0 ELSE 1 END, r.created_at, r.rowid
                 LIMIT 1
               )
               AND status IN ('queued', 'blocked')
               AND (? = 1 OR NOT EXISTS (
                 SELECT 1 FROM relay_jobs AS active
                 WHERE active.target = ? AND active.status = 'running'
               ))`,
          )
          .run(startedAt, process.pid, targetName, targetName, concurrent ? 1 : 0, targetName);
        if (claim.changes !== 1) {
          this.#dropLaunchFence(launchFence);
          if (concurrent) {
            // Another runner took the row between our select and update; if
            // anything is still pending, try again, else this runner is done.
            const pendingRow = this.#db
              .prepare(
                `SELECT 1 FROM relay_jobs
                 WHERE target = ? AND status IN ('queued', 'blocked')
                   AND NOT EXISTS (
                     SELECT 1 FROM relay_cancelled_jobs AS c WHERE c.id = relay_jobs.id
                   )
                 LIMIT 1`,
              )
              .get(targetName);
            if (!pendingRow) return;
            await sleep(0);
            continue;
          }
          const activeRun = this.#db
            .prepare(
              "SELECT id, owner_pid FROM relay_jobs WHERE target = ? AND status = 'running' LIMIT 1",
            )
            .get(targetName) as { id: string; owner_pid: number | null } | undefined;
          if (activeRun) {
            if (activeRun.owner_pid !== null && processIsAlive(activeRun.owner_pid)) {
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
              .run(new Date().toISOString(), activeRun.id);
            this.#notify(activeRun.id);
            this.#emitSettled(activeRun.id);
            continue;
          }
          const pending = this.#db
            .prepare(
              `SELECT 1 FROM relay_jobs
               WHERE target = ? AND status IN ('queued', 'blocked')
                 AND NOT EXISTS (
                   SELECT 1 FROM relay_cancelled_jobs AS c WHERE c.id = relay_jobs.id
                 )
               LIMIT 1`,
            )
            .get(targetName);
          if (!pending) return;
          await sleep(0);
          continue;
        }
        const running = this.#db
          .prepare(
            `SELECT * FROM relay_jobs
             WHERE target = ? AND status = 'running' AND owner_pid = ? AND started_at = ?
             ORDER BY rowid LIMIT 1`,
          )
          .get(targetName, process.pid, startedAt) as unknown as RelayRow | undefined;
        if (!running) {
          this.#dropLaunchFence(launchFence);
          continue;
        }
        const job = rowToJob(running);
        if (job.jobKind === "outbound") {
          this.#dropLaunchFence(launchFence);
          const finishedAt = new Date().toISOString();
          this.#withDb(() => {
            this.#db
              .prepare(
                "UPDATE relay_jobs SET status = 'completed', output = ?, finished_at = ? WHERE id = ?",
              )
              .run(job.prompt, finishedAt, job.id);
          }, undefined);
          if (!this.#dbClosed) await this.#deliverSettled(job.id);
          continue;
        }
        const controller = new AbortController();
        this.#controllers.add(controller);
        this.#invokeJobLifecycle("onRunning", job);
        const executeLifecycle: RelayExecuteLifecycle = {
          onSpawn: () => this.#invokeJobLifecycle("onSpawn", job),
        };
        try {
          const output = await this.#execute(
            target,
            job.prompt,
            controller.signal,
            executeLifecycle,
            launchFence,
            job,
          );
          if (
            isDirectAgentJob(job) &&
            job.prompt.trim() !== "" &&
            stripPtyFraming(output).trim() === ""
          ) {
            // A nonempty direct submission that yields no text is a failed turn,
            // not a successful empty reply. Group wakes keep their own contract.
            throw new Error(EMPTY_REPLY_ERROR);
          }
          const finishedAt = new Date().toISOString();
          this.#withDb(() => {
            this.#db
              .prepare(
                "UPDATE relay_jobs SET status = 'completed', output = ?, finished_at = ? WHERE id = ?",
              )
              .run(output, finishedAt, job.id);
          }, undefined);
          const finished = this.#jobLifecycle?.onFinished?.(job);
          if (finished) await finished.catch(() => undefined);
          if (!this.#dbClosed) await this.#deliverSettled(job.id);
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
          if (!this.#dbClosed) await this.#deliverSettled(job.id);
        } finally {
          if (this.get(job.id)?.status !== "completed") {
            const finished = this.#jobLifecycle?.onFinished?.(job);
            if (finished) await finished.catch(() => undefined);
          }
          this.#controllers.delete(controller);
          this.#dropLaunchFence(launchFence);
        }
        this.#notify(job.id);
        this.#emitSettled(job.id);
      }
    } finally {
      if (!concurrent) this.#runningTargets.delete(targetName);
      this.#outstandingRuns -= 1;
      this.#notifyOutstandingDrain();
    }
  }

  /** Concurrent target: several rows may be running; fail only those whose owner died. */
  #failOrphanedRunning(targetName: string): void {
    const rows = this.#db
      .prepare("SELECT id, owner_pid FROM relay_jobs WHERE target = ? AND status = 'running'")
      .all(targetName) as Array<{ id: string; owner_pid: number | null }>;
    for (const row of rows) {
      if (row.owner_pid !== null && processIsAlive(row.owner_pid)) continue;
      this.#db
        .prepare(
          `UPDATE relay_jobs
           SET status = 'failed',
               error = 'relay lost track of this job after restart; the turn may have completed — check the durable thread',
               finished_at = ?
           WHERE id = ? AND status = 'running'`,
        )
        .run(new Date().toISOString(), row.id);
      this.#notify(row.id);
      this.#emitSettled(row.id);
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
    for (const listener of this.#settledListeners.slice()) {
      try {
        const result = listener(job);
        if (result) void result.catch(() => undefined);
      } catch {
        // listener failures must not affect relay execution
      }
    }
  }

  #invokeJobLifecycle(event: "onClose"): void;
  #invokeJobLifecycle(event: Exclude<keyof RelayJobLifecycle, "onClose">, job: RelayJob): void;
  #invokeJobLifecycle(event: keyof RelayJobLifecycle, job?: RelayJob): void {
    if (!this.#jobLifecycle) return;
    try {
      if (event === "onClose") {
        const result = this.#jobLifecycle.onClose?.();
        if (result) void result.catch(() => undefined);
        return;
      }
      if (!job) return;
      const handler = this.#jobLifecycle[event];
      if (!handler) return;
      const result = handler(job);
      if (result) void result.catch(() => undefined);
    } catch {
      // lifecycle failures must not affect relay execution
    }
  }

  #dropLaunchFence(fence: unknown): void {
    if (!fence || fence === "blocked" || fence === "unresolved") return;
    this.#releaseWriterLock?.(fence);
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
         WHERE target = ? AND status IN ('completed', 'failed')
           AND delivery_status IN ('pending', 'failed')
         ORDER BY finished_at, rowid`,
      )
      .all(target) as unknown as Array<{ id: string }>;
    for (const row of rows) await this.#deliverSettled(row.id);
  }

  #claimDelivery(id: string): string | null {
    const nowIso = new Date().toISOString();
    const leaseExpires = new Date(Date.now() + this.#deliveryLeaseMs).toISOString();
    const token = randomUUID();
    const row = this.#db
      .prepare(
        `SELECT delivery_status, delivery_owner_pid, delivery_owner_token, delivery_lease_expires_at
         FROM relay_jobs WHERE id = ? AND status IN ('completed', 'failed')`,
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
           WHERE id = ? AND status IN ('completed', 'failed') AND delivery_status = 'delivering'
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
         WHERE id = ? AND status IN ('completed', 'failed') AND delivery_status IN ('pending', 'failed')`,
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

  #deliveryAttempts(id: string): number {
    const row = this.#db
      .prepare("SELECT delivery_attempts FROM relay_jobs WHERE id = ?")
      .get(id) as { delivery_attempts: number | null } | undefined;
    return row?.delivery_attempts ?? 0;
  }

  #finalizeDelivery(
    id: string,
    token: string,
    outcome:
      | { status: "delivered"; deliveredVia?: string }
      | { status: "failed"; error: string; final: boolean },
  ): boolean {
    if (outcome.status === "delivered") {
      const updated = this.#db
        .prepare(
          `UPDATE relay_jobs
           SET delivery_status = 'delivered',
               delivery_error = NULL,
               delivery_metadata = CASE WHEN ? IS NULL THEN delivery_metadata
                 ELSE json_set(COALESCE(delivery_metadata, '{}'), '$.deliveredVia', ?) END,
               delivery_owner_pid = NULL,
               delivery_owner_token = NULL,
               delivery_lease_expires_at = NULL
           WHERE id = ? AND delivery_owner_token = ? AND delivery_status = 'delivering'`,
        )
        .run(outcome.deliveredVia ?? null, outcome.deliveredVia ?? null, id, token);
      return updated.changes === 1;
    }
    const updated = this.#db
      .prepare(
        `UPDATE relay_jobs
         SET delivery_status = ?,
             delivery_error = ?,
             delivery_attempts = delivery_attempts + 1,
             delivery_owner_pid = NULL,
             delivery_owner_token = NULL,
             delivery_lease_expires_at = NULL
         WHERE id = ? AND delivery_owner_token = ? AND delivery_status = 'delivering'`,
      )
      .run(outcome.final ? "failed-final" : "failed", outcome.error, id, token);
    return updated.changes === 1;
  }

  async #deliverSettled(id: string, attempt = 0): Promise<void> {
    this.#outstandingRuns += 1;
    try {
      if (this.#dbClosed) return;
      const job = this.get(id);
      if (!job || !this.#isDeliverable(job) || !this.#deliver) return;
      const token = this.#claimDelivery(id);
      if (!token) return;
      let leaseLost = false;
      const heartbeat = setInterval(() => {
        if (!this.#renewDeliveryLease(id, token)) {
          leaseLost = true;
        }
      }, this.#deliveryHeartbeatMs);
      try {
        const receipt = await this.#deliver(this.get(id)!);
        if (leaseLost || !this.#renewDeliveryLease(id, token)) return;
        const deliveredVia = receipt?.deliveredVia;
        if (
          this.#finalizeDelivery(id, token, {
            status: "delivered",
            ...(deliveredVia ? { deliveredVia } : {}),
          })
        ) {
          this.#deliveryRetryTimers.delete(id);
        }
      } catch (error) {
        if (leaseLost) return;
        const message = error instanceof Error ? error.message : String(error);
        // Permanent errors and exhausted retries settle as failed-final: no
        // retry timer, and #deliverPending never resumes them at boot.
        const attempts = this.#deliveryAttempts(id) + 1;
        const permanent = isPermanentDeliveryError(error);
        const exhausted = attempts >= this.#maxDeliveryAttempts;
        const detail =
          !permanent && exhausted ? `${message} (gave up after ${attempts} attempts)` : message;
        const final = permanent || exhausted;
        if (this.#finalizeDelivery(id, token, { status: "failed", error: detail, final })) {
          if (final) this.#deliveryRetryTimers.delete(id);
          else this.#scheduleDeliveryRetry(id, attempt + 1);
        }
      } finally {
        clearInterval(heartbeat);
      }
      const current = this.get(id);
      if (current && isRelayJobWaitSettled(current)) this.#notify(id);
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
      const run = this.#deliverSettled(id, attempt);
      this.#activeRuns.add(run);
      void run.finally(() => this.#activeRuns.delete(run));
    }, delay);
    this.#deliveryRetryTimers.set(id, timer);
  }

  #needsDelivery(job: RelayJob): boolean {
    return Boolean(job.delivery ?? job.notify);
  }

  /**
   * Completed jobs deliver their output. Failed jobs deliver one failure
   * notice, but only direct Agent submissions: group wakes fall back to the
   * catch-up store instead, and outbound/lee jobs never execute.
   */
  #isDeliverable(job: RelayJob): boolean {
    if (!this.#needsDelivery(job)) return false;
    if (job.status === "completed") return true;
    return job.status === "failed" && isDirectAgentJob(job);
  }
}

export const EMPTY_REPLY_ERROR = "agent turn produced an empty reply";

export function isDirectAgentJob(job: RelayJob): boolean {
  if (job.jobKind !== "agent" || job.target === "lee") return false;
  const kind = (job.delivery?.metadata as { kind?: unknown } | undefined)?.kind;
  return kind !== "photon_group_wake";
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
  job_class: string;
  job_kind: string;
  sender: string | null;
}

function isSettledStatus(status: RelayJobStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
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
    jobClass: normalizeRelayJobClass(row.job_class),
    jobKind: normalizeRelayJobKind(row.job_kind),
    sender: row.sender ?? null,
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
