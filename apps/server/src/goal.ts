import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { renderGoalReminderPrompt } from "./goal-prompt.ts";
import type { RelayJob, RelayQueue } from "./relay.ts";

export type GoalState = "active" | "completed" | "blocked" | "cancelled";

export interface Goal {
  id: string;
  target: string;
  objective: string;
  state: GoalState;
  cadenceMs: number;
  reminderJobId: string | null;
  nextReminderAt: string | null;
  createdAt: string;
  updatedAt: string;
  blockedReason: string | null;
}

interface GoalServiceOptions {
  dbPath: string;
  relayQueue: RelayQueue;
  targetExists: (target: string) => boolean;
  pollMs?: number;
  defaultCadenceMs?: number;
  now?: () => number;
  idFactory?: () => string;
}

interface GoalRow {
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

const GOAL_ERROR_MAX_ATTEMPTS = 5;
const GOAL_ERROR_BASE_MS = 50;
const GOAL_ERROR_MAX_MS = 5_000;

export const DEFAULT_GOAL_CADENCE_MS = 5 * 60_000;

export class GoalService {
  readonly #db: DatabaseSync;
  readonly #relayQueue: RelayQueue;
  readonly #targetExists: GoalServiceOptions["targetExists"];
  readonly #pollMs: number;
  readonly #defaultCadenceMs: number;
  readonly #now: () => number;
  readonly #idFactory: () => string;
  #timer: NodeJS.Timeout | null = null;
  #closed = false;
  #stopped = false;
  #ticking = false;
  readonly #goalErrors = new Map<string, { attempts: number; until: number }>();

  constructor(options: GoalServiceOptions) {
    mkdirSync(dirname(options.dbPath), { recursive: true });
    closeSync(openSync(options.dbPath, "a", 0o600));
    chmodSync(options.dbPath, 0o600);
    this.#db = new DatabaseSync(options.dbPath);
    this.#relayQueue = options.relayQueue;
    this.#targetExists = options.targetExists;
    this.#pollMs = options.pollMs ?? 1000;
    this.#defaultCadenceMs = options.defaultCadenceMs ?? DEFAULT_GOAL_CADENCE_MS;
    this.#now = options.now ?? Date.now;
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
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
    for (const path of [options.dbPath, `${options.dbPath}-wal`, `${options.dbPath}-shm`]) {
      if (existsSync(path)) chmodSync(path, 0o600);
    }
    this.#bootstrapReconcile();
  }

  start(): void {
    if (this.#timer || this.#closed || this.#stopped) return;
    this.#timer = setInterval(() => this.tick(), this.#pollMs);
    this.#timer.unref();
    this.tick();
  }

  create(input: { target: string; objective: string; cadenceMs?: number }): Goal {
    if (!this.#targetExists(input.target)) {
      throw new Error(`unknown relay target: ${input.target}`);
    }
    if (!input.objective.trim()) throw new Error("objective is required");
    const cadenceMs = input.cadenceMs ?? this.#defaultCadenceMs;
    if (!Number.isSafeInteger(cadenceMs) || cadenceMs <= 0) {
      throw new Error("cadenceMs must be a positive integer");
    }
    const createdAt = new Date(this.#now()).toISOString();
    const reminderJobId = this.#idFactory();
    const goal: Goal = {
      id: this.#idFactory(),
      target: input.target,
      objective: input.objective.trim(),
      state: "active",
      cadenceMs,
      reminderJobId,
      nextReminderAt: null,
      createdAt,
      updatedAt: createdAt,
      blockedReason: null,
    };
    const prompt = renderGoalReminderPrompt(goal.id, goal.objective);
    this.#runImmediate(() => {
      this.#db
        .prepare(
          `INSERT INTO goals
           (id, target, objective, state, cadence_ms, reminder_job_id, next_reminder_at,
            created_at, updated_at, blocked_reason)
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
        )
        .run(
          goal.id,
          goal.target,
          goal.objective,
          goal.state,
          goal.cadenceMs,
          goal.reminderJobId,
          goal.createdAt,
          goal.updatedAt,
        );
      this.#insertReminderJob({
        id: reminderJobId,
        target: goal.target,
        prompt,
        createdAt,
      });
    });
    this.#safePokeSchedule(goal.target);
    return this.get(goal.id)!;
  }

  list(): Goal[] {
    return (
      this.#db.prepare("SELECT * FROM goals ORDER BY created_at, id").all() as unknown as GoalRow[]
    ).map(rowToGoal);
  }

  get(id: string): Goal | null {
    const row = this.#db.prepare("SELECT * FROM goals WHERE id = ?").get(id);
    return row ? rowToGoal(row as unknown as GoalRow) : null;
  }

  complete(id: string): Goal {
    return this.#setTerminalState(id, "completed");
  }

  block(id: string, reason: string): Goal {
    if (!reason.trim()) throw new Error("blocked reason is required");
    return this.#setTerminalState(id, "blocked", reason.trim());
  }

  cancel(id: string): Goal {
    return this.#setTerminalState(id, "cancelled");
  }

  notifyJobSettled(job: Pick<RelayJob, "id" | "status">): void {
    if (job.status !== "completed" && job.status !== "failed") return;
    const row = this.#db
      .prepare("SELECT * FROM goals WHERE reminder_job_id = ? AND state = 'active'")
      .get(job.id) as GoalRow | undefined;
    if (!row) return;
    const nextReminderAt = new Date(this.#now() + row.cadence_ms).toISOString();
    const updatedAt = new Date(this.#now()).toISOString();
    this.#db
      .prepare(
        `UPDATE goals
         SET reminder_job_id = NULL, next_reminder_at = ?, updated_at = ?
         WHERE id = ? AND reminder_job_id = ? AND state = 'active'`,
      )
      .run(nextReminderAt, updatedAt, row.id, job.id);
  }

  tick(): void {
    if (this.#closed || this.#stopped || this.#ticking) return;
    this.#ticking = true;
    try {
      this.#reconcileActiveReminders();
      const nowIso = new Date(this.#now()).toISOString();
      const rows = this.#db
        .prepare(
          `SELECT * FROM goals
           WHERE state = 'active' AND next_reminder_at IS NOT NULL AND next_reminder_at <= ?
           ORDER BY next_reminder_at, created_at`,
        )
        .all(nowIso) as unknown as GoalRow[];
      for (const row of rows) {
        if (this.#isGoalBackedOff(row.id)) continue;
        try {
          this.#processDue(row);
        } catch (error) {
          this.#recordGoalError(row.id, error);
        }
      }
    } catch {
      // tick must never throw into setInterval
    } finally {
      this.#ticking = false;
    }
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    while (this.#ticking) await new Promise((resolve) => setTimeout(resolve, 1));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    await this.stop();
    this.#closed = true;
    this.#db.close();
  }

  #bootstrapReconcile(): void {
    this.#reconcileInvalidTargets();
    this.#fenceTerminalGoalReminders();
    this.#terminateActiveGoalsWithTombstonedReminders();
    this.#reconcileSettledReminders();
  }

  #reconcileInvalidTargets(): void {
    const rows = this.#db
      .prepare("SELECT * FROM goals WHERE state = 'active'")
      .all() as unknown as GoalRow[];
    for (const row of rows) {
      if (this.#targetExists(row.target)) continue;
      this.#blockInvalidTargetGoal(row);
    }
  }

  #blockInvalidTargetGoal(row: GoalRow): void {
    const reason = `relay target no longer configured: ${row.target}`;
    const updatedAt = new Date(this.#now()).toISOString();
    this.#runImmediate(() => {
      if (row.reminder_job_id) this.#fenceReminderJob(row.reminder_job_id, updatedAt);
      this.#db
        .prepare(
          `UPDATE goals
           SET state = 'blocked', blocked_reason = ?, reminder_job_id = NULL,
               next_reminder_at = NULL, updated_at = ?
           WHERE id = ? AND state = 'active'`,
        )
        .run(reason, updatedAt, row.id);
    });
  }

  #fenceTerminalGoalReminders(): void {
    const rows = this.#db
      .prepare(
        `SELECT reminder_job_id, updated_at FROM goals
         WHERE state != 'active' AND reminder_job_id IS NOT NULL`,
      )
      .all() as Array<Pick<GoalRow, "reminder_job_id" | "updated_at">>;
    for (const row of rows) {
      this.#fenceReminderJob(row.reminder_job_id!, row.updated_at);
    }
  }

  #terminateActiveGoalsWithTombstonedReminders(): void {
    const rows = this.#db
      .prepare(
        `SELECT id, reminder_job_id FROM goals AS g
         WHERE g.state = 'active' AND g.reminder_job_id IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM relay_cancelled_jobs AS c WHERE c.id = g.reminder_job_id
           )`,
      )
      .all() as Array<Pick<GoalRow, "id" | "reminder_job_id">>;
    for (const row of rows) {
      this.#terminateFencedReminder(row.id, row.reminder_job_id!);
    }
  }

  #reconcileSettledReminders(): void {
    this.#reconcileActiveReminders();
  }

  #reconcileActiveReminders(): void {
    const unscheduled = this.#db
      .prepare(
        `SELECT * FROM goals
         WHERE state = 'active' AND reminder_job_id IS NULL AND next_reminder_at IS NULL`,
      )
      .all() as unknown as GoalRow[];
    for (const row of unscheduled) {
      if (this.#isGoalBackedOff(row.id)) continue;
      try {
        this.#recoverUnscheduledGoal(row);
      } catch (error) {
        this.#recordGoalError(row.id, error);
      }
    }
    const rows = this.#db
      .prepare("SELECT * FROM goals WHERE state = 'active' AND reminder_job_id IS NOT NULL")
      .all() as unknown as GoalRow[];
    for (const row of rows) {
      if (this.#isGoalBackedOff(row.id)) continue;
      try {
        this.#reconcileReminderRow(row);
      } catch (error) {
        this.#recordGoalError(row.id, error);
      }
    }
  }

  #reconcileReminderRow(row: GoalRow): void {
    const jobId = row.reminder_job_id!;
    const job = this.#getJob(jobId);
    if (!job) {
      this.#ensureReminderJob(rowToGoal(row));
      return;
    }
    if (job.status === "completed" || job.status === "failed") {
      this.notifyJobSettled({ id: jobId, status: job.status });
      return;
    }
    if (job.status === "queued" || job.status === "blocked") {
      this.#tryPokeSchedule(row.target);
      return;
    }
    if (job.status === "cancelled") {
      this.#terminateFencedReminder(row.id, jobId);
    }
  }

  #terminateFencedReminder(goalId: string, reminderJobId: string, at?: string): void {
    const updatedAt = at ?? new Date(this.#now()).toISOString();
    this.#runImmediate(() => {
      this.#fenceReminderJob(reminderJobId, updatedAt);
      this.#db
        .prepare(
          `UPDATE goals
           SET state = 'cancelled', reminder_job_id = NULL, next_reminder_at = NULL, updated_at = ?
           WHERE id = ? AND state = 'active'`,
        )
        .run(updatedAt, goalId);
    });
  }

  #cancelTombstonedGoal(goalId: string, reminderJobId: string): void {
    this.#terminateFencedReminder(goalId, reminderJobId);
  }

  #setTerminalState(id: string, state: GoalState, blockedReason: string | null = null): Goal {
    const goal = this.get(id);
    if (!goal) throw new Error(`unknown goal: ${id}`);
    if (goal.state !== "active") throw new Error(`goal is already ${goal.state}`);
    const updatedAt = new Date(this.#now()).toISOString();
    let reminderJobId: string | null = null;
    this.#runImmediate(() => {
      const row = this.#db
        .prepare("SELECT reminder_job_id FROM goals WHERE id = ? AND state = 'active'")
        .get(id) as { reminder_job_id: string | null } | undefined;
      if (!row) throw new Error(`unknown goal: ${id}`);
      reminderJobId = row.reminder_job_id;
      const changed = this.#db
        .prepare(
          `UPDATE goals
           SET state = ?, blocked_reason = ?, next_reminder_at = NULL, updated_at = ?
           WHERE id = ? AND state = 'active'`,
        )
        .run(state, blockedReason, updatedAt, id);
      if (changed.changes !== 1) throw new Error(`unknown goal: ${id}`);
      if (reminderJobId) this.#fenceReminderJob(reminderJobId, updatedAt);
    });
    if (reminderJobId) this.#safePokeJobSettled(reminderJobId);
    const updated = this.get(id);
    if (!updated) throw new Error(`unknown goal: ${id}`);
    return updated;
  }

  #recoverUnscheduledGoal(row: GoalRow): void {
    if (!this.#targetExists(row.target)) {
      this.#blockInvalidTargetGoal(row);
      return;
    }
    const reminderJobId = this.#idFactory();
    const updatedAt = new Date(this.#now()).toISOString();
    const prompt = renderGoalReminderPrompt(row.id, row.objective);
    let claimed = false;
    this.#runImmediate(() => {
      const result = this.#db
        .prepare(
          `UPDATE goals
           SET reminder_job_id = ?, updated_at = ?
           WHERE id = ? AND state = 'active'
             AND reminder_job_id IS NULL AND next_reminder_at IS NULL`,
        )
        .run(reminderJobId, updatedAt, row.id);
      if (result.changes !== 1) return;
      this.#insertReminderJob({
        id: reminderJobId,
        target: row.target,
        prompt,
        createdAt: updatedAt,
      });
      claimed = true;
    });
    if (claimed) this.#tryPokeSchedule(row.target);
  }

  #processDue(row: GoalRow): void {
    if (row.reminder_job_id) return;
    if (!this.#targetExists(row.target)) {
      this.#blockInvalidTargetGoal(row);
      return;
    }
    const reminderJobId = this.#idFactory();
    const updatedAt = new Date(this.#now()).toISOString();
    const prompt = renderGoalReminderPrompt(row.id, row.objective);
    let claimed = false;
    this.#runImmediate(() => {
      const result = this.#db
        .prepare(
          `UPDATE goals
           SET reminder_job_id = ?, next_reminder_at = NULL, updated_at = ?
           WHERE id = ? AND state = 'active' AND reminder_job_id IS NULL AND next_reminder_at = ?`,
        )
        .run(reminderJobId, updatedAt, row.id, row.next_reminder_at);
      if (result.changes !== 1) return;
      this.#insertReminderJob({
        id: reminderJobId,
        target: row.target,
        prompt,
        createdAt: updatedAt,
      });
      claimed = true;
    });
    if (!claimed) return;
    this.#tryPokeSchedule(row.target);
  }

  #ensureReminderJob(goal: Goal): void {
    if (!goal.reminderJobId || goal.state !== "active") return;
    if (!this.#targetExists(goal.target)) {
      this.#blockInvalidTargetGoal({
        id: goal.id,
        target: goal.target,
        objective: goal.objective,
        state: goal.state,
        cadence_ms: goal.cadenceMs,
        reminder_job_id: goal.reminderJobId,
        next_reminder_at: goal.nextReminderAt,
        created_at: goal.createdAt,
        updated_at: goal.updatedAt,
        blocked_reason: goal.blockedReason,
      });
      return;
    }
    const existing = this.#db
      .prepare("SELECT 1 AS ok FROM relay_jobs WHERE id = ?")
      .get(goal.reminderJobId) as { ok: number } | undefined;
    if (existing) {
      this.#safePokeSchedule(goal.target);
      return;
    }
    const tombstone = this.#db
      .prepare("SELECT 1 AS ok FROM relay_cancelled_jobs WHERE id = ?")
      .get(goal.reminderJobId) as { ok: number } | undefined;
    if (tombstone) {
      this.#cancelTombstonedGoal(goal.id, goal.reminderJobId);
      return;
    }
    const prompt = renderGoalReminderPrompt(goal.id, goal.objective);
    let inserted = false;
    this.#runImmediate(() => {
      const active = this.#db.prepare("SELECT state FROM goals WHERE id = ?").get(goal.id) as
        | { state: string }
        | undefined;
      if (!active || active.state !== "active") return;
      const exists = this.#db
        .prepare("SELECT 1 AS ok FROM relay_jobs WHERE id = ?")
        .get(goal.reminderJobId!) as { ok: number } | undefined;
      if (exists) return;
      this.#insertReminderJob({
        id: goal.reminderJobId!,
        target: goal.target,
        prompt,
        createdAt: new Date(this.#now()).toISOString(),
      });
      inserted = true;
    });
    if (inserted) this.#tryPokeSchedule(goal.target);
  }

  #tryPokeSchedule(target: string): boolean {
    try {
      this.#relayQueue.pokeSchedule(target);
      return true;
    } catch {
      return false;
    }
  }

  #safePokeSchedule(target: string): void {
    this.#tryPokeSchedule(target);
  }

  #safePokeJobSettled(jobId: string): void {
    try {
      this.#relayQueue.pokeJobSettled(jobId);
    } catch {
      // online tick reconciliation retries settlement signals
    }
  }

  #insertReminderJob(input: {
    id: string;
    target: string;
    prompt: string;
    createdAt: string;
  }): void {
    const tombstone = this.#db
      .prepare("SELECT 1 AS ok FROM relay_cancelled_jobs WHERE id = ?")
      .get(input.id) as { ok: number } | undefined;
    if (tombstone) throw new Error(`relay job cancelled: ${input.id}`);
    const inserted = this.#db
      .prepare(
        `INSERT INTO relay_jobs
         (id, target, prompt, status, output, error, created_at, started_at, finished_at,
          notify, delivery_status, delivery_error, delivery_channel, delivery_destination,
          delivery_metadata, job_class)
         VALUES (?, ?, ?, 'queued', NULL, NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'prioritized')`,
      )
      .run(input.id, input.target, input.prompt, input.createdAt);
    if (inserted.changes !== 1) {
      throw new Error(`relay job id collision: ${input.id}`);
    }
  }

  #fenceReminderJob(jobId: string, cancelledAt: string): void {
    this.#db
      .prepare("INSERT OR IGNORE INTO relay_cancelled_jobs (id, cancelled_at) VALUES (?, ?)")
      .run(jobId, cancelledAt);
    this.#db
      .prepare(
        `UPDATE relay_jobs
         SET status = 'cancelled', finished_at = ?, error = NULL
         WHERE id = ? AND status IN ('queued', 'blocked')`,
      )
      .run(cancelledAt, jobId);
  }

  #getJob(id: string): Pick<RelayJob, "status"> | null {
    const row = this.#db.prepare("SELECT status FROM relay_jobs WHERE id = ?").get(id) as
      | { status: string }
      | undefined;
    return row ? { status: row.status as RelayJob["status"] } : null;
  }

  #runImmediate(fn: () => void): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #isGoalBackedOff(goalId: string): boolean {
    const entry = this.#goalErrors.get(goalId);
    return Boolean(entry && this.#now() < entry.until);
  }

  #recordGoalError(goalId: string, _error: unknown): void {
    const attempts = (this.#goalErrors.get(goalId)?.attempts ?? 0) + 1;
    const delay = Math.min(GOAL_ERROR_BASE_MS * 2 ** (attempts - 1), GOAL_ERROR_MAX_MS);
    this.#goalErrors.set(goalId, {
      attempts: Math.min(attempts, GOAL_ERROR_MAX_ATTEMPTS),
      until: this.#now() + delay,
    });
    if (attempts >= GOAL_ERROR_MAX_ATTEMPTS) {
      this.#goalErrors.delete(goalId);
    }
  }
}

function rowToGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    target: row.target,
    objective: row.objective,
    state: row.state as GoalState,
    cadenceMs: row.cadence_ms,
    reminderJobId: row.reminder_job_id,
    nextReminderAt: row.next_reminder_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    blockedReason: row.blocked_reason,
  };
}
