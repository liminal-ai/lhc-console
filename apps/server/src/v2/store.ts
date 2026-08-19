import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { processIsAlive } from "../process-alive.ts";
import { ensureColumn, runExclusiveMigration } from "../sqlite-migrate.ts";
import type {
  V2CommandKind,
  V2DispatchState,
  V2Event,
  V2EventKind,
  V2OwnerKind,
  V2ReceiptState,
  V2RuntimeState,
  V2SteerEffectStage,
} from "./contract.ts";

export const DEFAULT_EVENT_RETENTION_COUNT = 10_000;
export const DEFAULT_EVENT_RETENTION_DAYS = 14;

export interface V2StoreOptions {
  dbPath: string;
  eventRetentionCount?: number;
  eventRetentionDays?: number;
}

export interface V2RuntimeRow {
  target: string;
  provider: string;
  state: V2RuntimeState;
  generation: number;
  ownerKind: V2OwnerKind;
  ownerPid: number | null;
  ownerToken: string | null;
  leaseExpiresAt: string | null;
  startedAt: string | null;
  writerResourceKey: string;
  hostId: string;
  hostThreadId: string;
  canonicalThreadId: string;
  nativeThreadRef: string | null;
  currentTurnId: string | null;
  currentNativeTurnId: string | null;
  currentTurnCommandId: string | null;
  currentTurnCause: string | null;
  currentTurnStartedAt: string | null;
  terminalId: string | null;
  lastReconcileAt: string | null;
  lastReconcileResult: string | null;
  updatedAt: string;
}

export interface V2CommandRow {
  commandId: string;
  target: string;
  kind: V2CommandKind;
  paramsJson: string;
  receipt: V2ReceiptState;
  reason: string | null;
  dispatchState: V2DispatchState;
  runtimeGeneration: number | null;
  nativeTurnId: string | null;
  providerResponseId: string | null;
  effectStage: V2SteerEffectStage | null;
  turnId: string | null;
  expectedTurnId: string | null;
  afterTurnId: string | null;
  message: string | null;
  acceptedAt: string;
  updatedAt: string;
}

export interface V2FollowUpRow {
  commandId: string;
  target: string;
  afterTurnId: string;
  text: string;
  delivery: string | null;
  cancelOnInterrupt: number;
  queuedAt: string;
  held: number;
}

export interface AppendEventInput {
  target: string;
  kind: V2EventKind;
  turnId?: string | null;
  commandId?: string | null;
  data?: Record<string, unknown>;
  provider?: {
    nativeTurnId?: string | null;
    nativeThreadRef?: string | null;
    providerResponseId?: string | null;
  };
  at?: string;
}

export class V2Store {
  readonly #dbPath: string;
  readonly #db: DatabaseSync;
  readonly #retentionCount: number;
  readonly #retentionDays: number;

  constructor(options: V2StoreOptions) {
    mkdirSync(dirname(options.dbPath), { recursive: true });
    closeSync(openSync(options.dbPath, "a", 0o600));
    chmodSync(options.dbPath, 0o600);
    this.#dbPath = options.dbPath;
    this.#db = new DatabaseSync(options.dbPath);
    this.#retentionCount = options.eventRetentionCount ?? DEFAULT_EVENT_RETENTION_COUNT;
    this.#retentionDays = options.eventRetentionDays ?? DEFAULT_EVENT_RETENTION_DAYS;
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS v2_runtimes (
        target TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        state TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 0,
        owner_kind TEXT NOT NULL DEFAULT 'none',
        owner_pid INTEGER,
        owner_token TEXT,
        lease_expires_at TEXT,
        started_at TEXT,
        writer_resource_key TEXT NOT NULL,
        host_id TEXT NOT NULL,
        host_thread_id TEXT NOT NULL,
        canonical_thread_id TEXT NOT NULL,
        native_thread_ref TEXT,
        current_turn_id TEXT,
        current_native_turn_id TEXT,
        current_turn_command_id TEXT,
        current_turn_cause TEXT,
        current_turn_started_at TEXT,
        terminal_id TEXT,
        last_reconcile_at TEXT,
        last_reconcile_result TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS v2_commands (
        command_id TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        kind TEXT NOT NULL,
        params_json TEXT NOT NULL,
        receipt TEXT NOT NULL,
        reason TEXT,
        dispatch_state TEXT NOT NULL DEFAULT 'not_sent',
        runtime_generation INTEGER,
        native_turn_id TEXT,
        provider_response_id TEXT,
        effect_stage TEXT,
        turn_id TEXT,
        expected_turn_id TEXT,
        after_turn_id TEXT,
        message TEXT,
        accepted_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS v2_events (
        target TEXT NOT NULL,
        seq INTEGER NOT NULL,
        at TEXT NOT NULL,
        kind TEXT NOT NULL,
        turn_id TEXT,
        command_id TEXT,
        data_json TEXT NOT NULL,
        provider_json TEXT,
        PRIMARY KEY (target, seq)
      );
      CREATE TABLE IF NOT EXISTS v2_followups (
        command_id TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        after_turn_id TEXT NOT NULL,
        text TEXT NOT NULL,
        delivery TEXT,
        cancel_on_interrupt INTEGER NOT NULL DEFAULT 0,
        queued_at TEXT NOT NULL,
        held INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS v2_owner_resources (
        writer_resource_key TEXT PRIMARY KEY,
        host_id TEXT NOT NULL,
        host_thread_id TEXT NOT NULL,
        canonical_thread_id TEXT NOT NULL,
        owner_kind TEXT NOT NULL DEFAULT 'none',
        owner_pid INTEGER,
        owner_token TEXT,
        runtime_generation INTEGER,
        lease_expires_at TEXT,
        terminal_id TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS v2_owner_aliases (
        target TEXT PRIMARY KEY,
        writer_resource_key TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS v2_deliveries (
        command_id TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        turn_id TEXT,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        owner_pid INTEGER,
        owner_token TEXT,
        lease_expires_at TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.#ensureColumns();
    for (const path of [options.dbPath, `${options.dbPath}-wal`, `${options.dbPath}-shm`]) {
      if (existsSync(path)) chmodSync(path, 0o600);
    }
  }

  get dbPath(): string {
    return this.#dbPath;
  }

  close(): void {
    try {
      this.#db.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ERR_INVALID_STATE") throw error;
    }
  }

  transaction<T>(fn: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  upsertRuntime(row: V2RuntimeRow): void {
    this.#db
      .prepare(
        `INSERT INTO v2_runtimes (
           target, provider, state, generation, owner_kind, owner_pid, owner_token,
           lease_expires_at, started_at, writer_resource_key, host_id, host_thread_id,
           canonical_thread_id, native_thread_ref, current_turn_id, current_native_turn_id,
           current_turn_command_id, current_turn_cause, current_turn_started_at, terminal_id,
           last_reconcile_at, last_reconcile_result, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(target) DO UPDATE SET
           provider = excluded.provider,
           state = excluded.state,
           generation = excluded.generation,
           owner_kind = excluded.owner_kind,
           owner_pid = excluded.owner_pid,
           owner_token = excluded.owner_token,
           lease_expires_at = excluded.lease_expires_at,
           started_at = excluded.started_at,
           writer_resource_key = excluded.writer_resource_key,
           host_id = excluded.host_id,
           host_thread_id = excluded.host_thread_id,
           canonical_thread_id = excluded.canonical_thread_id,
           native_thread_ref = excluded.native_thread_ref,
           current_turn_id = excluded.current_turn_id,
           current_native_turn_id = excluded.current_native_turn_id,
           current_turn_command_id = excluded.current_turn_command_id,
           current_turn_cause = excluded.current_turn_cause,
           current_turn_started_at = excluded.current_turn_started_at,
           terminal_id = excluded.terminal_id,
           last_reconcile_at = excluded.last_reconcile_at,
           last_reconcile_result = excluded.last_reconcile_result,
           updated_at = excluded.updated_at`,
      )
      .run(
        row.target,
        row.provider,
        row.state,
        row.generation,
        row.ownerKind,
        row.ownerPid,
        row.ownerToken,
        row.leaseExpiresAt,
        row.startedAt,
        row.writerResourceKey,
        row.hostId,
        row.hostThreadId,
        row.canonicalThreadId,
        row.nativeThreadRef,
        row.currentTurnId,
        row.currentNativeTurnId,
        row.currentTurnCommandId,
        row.currentTurnCause,
        row.currentTurnStartedAt,
        row.terminalId,
        row.lastReconcileAt,
        row.lastReconcileResult,
        row.updatedAt,
      );
    this.#db
      .prepare(
        `INSERT INTO v2_owner_aliases (target, writer_resource_key) VALUES (?, ?)
         ON CONFLICT(target) DO UPDATE SET writer_resource_key = excluded.writer_resource_key`,
      )
      .run(row.target, row.writerResourceKey);
  }

  getRuntime(target: string): V2RuntimeRow | null {
    const row = this.#db.prepare("SELECT * FROM v2_runtimes WHERE target = ?").get(target) as
      | Record<string, unknown>
      | undefined;
    return row ? runtimeFromRow(row) : null;
  }

  listRuntimes(): V2RuntimeRow[] {
    return (this.#db.prepare("SELECT * FROM v2_runtimes").all() as Record<string, unknown>[]).map(
      runtimeFromRow,
    );
  }

  listTargetsForResource(resourceKey: string): string[] {
    return (
      this.#db
        .prepare("SELECT target FROM v2_owner_aliases WHERE writer_resource_key = ?")
        .all(resourceKey) as Array<{ target: string }>
    ).map((row) => row.target);
  }

  listOwnerResources(): Array<NonNullable<ReturnType<V2Store["getOwnerResource"]>>> {
    return (
      this.#db.prepare("SELECT * FROM v2_owner_resources").all() as Record<string, unknown>[]
    ).map((row) => ({
      writerResourceKey: String(row.writer_resource_key),
      hostId: String(row.host_id),
      hostThreadId: String(row.host_thread_id),
      canonicalThreadId: String(row.canonical_thread_id),
      ownerKind: row.owner_kind as V2OwnerKind,
      ownerPid: (row.owner_pid as number | null) ?? null,
      ownerToken: (row.owner_token as string | null) ?? null,
      runtimeGeneration: (row.runtime_generation as number | null) ?? null,
      leaseExpiresAt: (row.lease_expires_at as string | null) ?? null,
      terminalId: (row.terminal_id as string | null) ?? null,
      updatedAt: String(row.updated_at),
    }));
  }

  getOwnerResource(resourceKey: string): {
    writerResourceKey: string;
    hostId: string;
    hostThreadId: string;
    canonicalThreadId: string;
    ownerKind: V2OwnerKind;
    ownerPid: number | null;
    ownerToken: string | null;
    runtimeGeneration: number | null;
    leaseExpiresAt: string | null;
    terminalId: string | null;
    updatedAt: string;
  } | null {
    const row = this.#db
      .prepare("SELECT * FROM v2_owner_resources WHERE writer_resource_key = ?")
      .get(resourceKey) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      writerResourceKey: String(row.writer_resource_key),
      hostId: String(row.host_id),
      hostThreadId: String(row.host_thread_id),
      canonicalThreadId: String(row.canonical_thread_id),
      ownerKind: row.owner_kind as V2OwnerKind,
      ownerPid: (row.owner_pid as number | null) ?? null,
      ownerToken: (row.owner_token as string | null) ?? null,
      runtimeGeneration: (row.runtime_generation as number | null) ?? null,
      leaseExpiresAt: (row.lease_expires_at as string | null) ?? null,
      terminalId: (row.terminal_id as string | null) ?? null,
      updatedAt: String(row.updated_at),
    };
  }

  upsertOwnerResource(input: {
    writerResourceKey: string;
    hostId: string;
    hostThreadId: string;
    canonicalThreadId: string;
    ownerKind: V2OwnerKind;
    ownerPid?: number | null;
    ownerToken?: string | null;
    runtimeGeneration?: number | null;
    leaseExpiresAt?: string | null;
    terminalId?: string | null;
  }): void {
    const updatedAt = nowIso();
    this.#db
      .prepare(
        `INSERT INTO v2_owner_resources (
           writer_resource_key, host_id, host_thread_id, canonical_thread_id,
           owner_kind, owner_pid, owner_token, runtime_generation, lease_expires_at,
           terminal_id, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(writer_resource_key) DO UPDATE SET
           host_id = excluded.host_id,
           host_thread_id = excluded.host_thread_id,
           canonical_thread_id = excluded.canonical_thread_id,
           owner_kind = excluded.owner_kind,
           owner_pid = excluded.owner_pid,
           owner_token = excluded.owner_token,
           runtime_generation = excluded.runtime_generation,
           lease_expires_at = excluded.lease_expires_at,
           terminal_id = excluded.terminal_id,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.writerResourceKey,
        input.hostId,
        input.hostThreadId,
        input.canonicalThreadId,
        input.ownerKind,
        input.ownerPid ?? null,
        input.ownerToken ?? null,
        input.runtimeGeneration ?? null,
        input.leaseExpiresAt ?? null,
        input.terminalId ?? null,
        updatedAt,
      );
  }

  insertCommand(row: V2CommandRow): boolean {
    const result = this.#db
      .prepare(
        `INSERT OR IGNORE INTO v2_commands (
           command_id, target, kind, params_json, receipt, reason, dispatch_state,
           runtime_generation, native_turn_id, provider_response_id, effect_stage,
           turn_id, expected_turn_id, after_turn_id, message, accepted_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.commandId,
        row.target,
        row.kind,
        row.paramsJson,
        row.receipt,
        row.reason,
        row.dispatchState,
        row.runtimeGeneration,
        row.nativeTurnId,
        row.providerResponseId,
        row.effectStage,
        row.turnId,
        row.expectedTurnId,
        row.afterTurnId,
        row.message,
        row.acceptedAt,
        row.updatedAt,
      );
    return result.changes === 1;
  }

  getCommand(commandId: string): V2CommandRow | null {
    const row = this.#db
      .prepare("SELECT * FROM v2_commands WHERE command_id = ?")
      .get(commandId) as Record<string, unknown> | undefined;
    return row ? commandFromRow(row) : null;
  }

  listCommands(target: string): V2CommandRow[] {
    return (
      this.#db
        .prepare("SELECT * FROM v2_commands WHERE target = ? ORDER BY accepted_at, command_id")
        .all(target) as Record<string, unknown>[]
    ).map(commandFromRow);
  }

  listPendingCommands(target: string): V2CommandRow[] {
    return (
      this.#db
        .prepare(
          // rowid, not command_id: acceptance order is insertion order, and
          // two commands accepted in the same millisecond must not be
          // reordered by how their ids happen to sort.
          `SELECT * FROM v2_commands
           WHERE target = ? AND receipt = 'accepted'
           ORDER BY accepted_at, rowid`,
        )
        .all(target) as Record<string, unknown>[]
    ).map(commandFromRow);
  }

  updateCommand(
    commandId: string,
    patch: Partial<
      Pick<
        V2CommandRow,
        | "receipt"
        | "reason"
        | "dispatchState"
        | "runtimeGeneration"
        | "nativeTurnId"
        | "providerResponseId"
        | "effectStage"
        | "turnId"
        | "afterTurnId"
        | "message"
      >
    >,
  ): void {
    const current = this.getCommand(commandId);
    if (!current) throw new Error(`unknown v2 command: ${commandId}`);
    const next = { ...current, ...patch, updatedAt: nowIso() };
    this.#db
      .prepare(
        `UPDATE v2_commands SET
           receipt = ?, reason = ?, dispatch_state = ?, runtime_generation = ?,
           native_turn_id = ?, provider_response_id = ?, effect_stage = ?, turn_id = ?,
           after_turn_id = ?, message = ?, updated_at = ?
         WHERE command_id = ?`,
      )
      .run(
        next.receipt,
        next.reason,
        next.dispatchState,
        next.runtimeGeneration,
        next.nativeTurnId,
        next.providerResponseId,
        next.effectStage,
        next.turnId,
        next.afterTurnId,
        next.message,
        next.updatedAt,
        commandId,
      );
  }

  appendEvent(input: AppendEventInput): V2Event {
    const at = input.at ?? nowIso();
    const last = this.#db
      .prepare("SELECT MAX(seq) AS seq FROM v2_events WHERE target = ?")
      .get(input.target) as { seq: number | null };
    const seq = (last.seq ?? 0) + 1;
    const event: V2Event = {
      seq,
      target: input.target,
      at,
      kind: input.kind,
      turnId: input.turnId ?? null,
      commandId: input.commandId ?? null,
      data: input.data ?? {},
      provider: input.provider,
    };
    this.#db
      .prepare(
        `INSERT INTO v2_events (target, seq, at, kind, turn_id, command_id, data_json, provider_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.target,
        event.seq,
        event.at,
        event.kind,
        event.turnId ?? null,
        event.commandId ?? null,
        JSON.stringify(event.data),
        event.provider ? JSON.stringify(event.provider) : null,
      );
    this.#pruneEvents(input.target);
    return event;
  }

  updateCommandAndEmit(
    commandId: string,
    patch: Parameters<V2Store["updateCommand"]>[1],
    event: AppendEventInput,
  ): V2Event {
    return this.transaction(() => {
      this.updateCommand(commandId, patch);
      return this.appendEvent(event);
    });
  }

  lastEventSeq(target: string): number {
    const last = this.#db
      .prepare("SELECT MAX(seq) AS seq FROM v2_events WHERE target = ?")
      .get(target) as { seq: number | null };
    return last.seq ?? 0;
  }

  minEventSeq(target: string): number | null {
    const first = this.#db
      .prepare("SELECT MIN(seq) AS seq FROM v2_events WHERE target = ?")
      .get(target) as { seq: number | null };
    return first.seq;
  }

  listEventsAfter(target: string, after: number, limit = 1000): V2Event[] {
    return (
      this.#db
        .prepare(`SELECT * FROM v2_events WHERE target = ? AND seq > ? ORDER BY seq LIMIT ?`)
        .all(target, after, limit) as Record<string, unknown>[]
    ).map(eventFromRow);
  }

  listEventsThrough(target: string, through: number): V2Event[] {
    return (
      this.#db
        .prepare(`SELECT * FROM v2_events WHERE target = ? AND seq <= ? ORDER BY seq`)
        .all(target, through) as Record<string, unknown>[]
    ).map(eventFromRow);
  }

  enqueueFollowUp(row: V2FollowUpRow): void {
    this.#db
      .prepare(
        `INSERT INTO v2_followups (
           command_id, target, after_turn_id, text, delivery, cancel_on_interrupt, queued_at, held
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.commandId,
        row.target,
        row.afterTurnId,
        row.text,
        row.delivery,
        row.cancelOnInterrupt,
        row.queuedAt,
        row.held,
      );
  }

  listFollowUps(target: string): V2FollowUpRow[] {
    return (
      this.#db
        .prepare("SELECT * FROM v2_followups WHERE target = ? ORDER BY queued_at, command_id")
        .all(target) as Record<string, unknown>[]
    ).map(followUpFromRow);
  }

  removeFollowUp(commandId: string): V2FollowUpRow | null {
    const row = this.#db
      .prepare("SELECT * FROM v2_followups WHERE command_id = ?")
      .get(commandId) as Record<string, unknown> | undefined;
    if (!row) return null;
    this.#db.prepare("DELETE FROM v2_followups WHERE command_id = ?").run(commandId);
    return followUpFromRow(row);
  }

  holdFollowUps(target: string): void {
    this.#db.prepare("UPDATE v2_followups SET held = 1 WHERE target = ?").run(target);
  }

  releaseHeldFollowUps(target: string): void {
    this.#db.prepare("UPDATE v2_followups SET held = 0 WHERE target = ?").run(target);
  }

  nextFollowUp(target: string, afterTurnId: string): V2FollowUpRow | null {
    const row = this.#db
      .prepare(
        `SELECT * FROM v2_followups
         WHERE target = ? AND after_turn_id = ? AND held = 0
         ORDER BY queued_at, command_id LIMIT 1`,
      )
      .get(target, afterTurnId) as Record<string, unknown> | undefined;
    return row ? followUpFromRow(row) : null;
  }

  newOwnerToken(): string {
    return randomUUID();
  }

  enqueueDelivery(input: {
    commandId: string;
    target: string;
    turnId?: string | null;
    text: string;
  }): void {
    const now = nowIso();
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO v2_deliveries (
           command_id, target, turn_id, text, status, attempt, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`,
      )
      .run(input.commandId, input.target, input.turnId ?? null, input.text, now, now);
  }

  listPendingDeliveries(): Array<{
    commandId: string;
    target: string;
    turnId: string | null;
    text: string;
    status: string;
    attempt: number;
  }> {
    return (
      this.#db
        .prepare(
          `SELECT command_id, target, turn_id, text, status, attempt
           FROM v2_deliveries
           WHERE status IN ('pending', 'failed')
           ORDER BY created_at, command_id`,
        )
        .all() as Array<{
        command_id: string;
        target: string;
        turn_id: string | null;
        text: string;
        status: string;
        attempt: number;
      }>
    ).map((row) => ({
      commandId: row.command_id,
      target: row.target,
      turnId: row.turn_id,
      text: row.text,
      status: row.status,
      attempt: row.attempt,
    }));
  }

  getDelivery(commandId: string): {
    commandId: string;
    target: string;
    turnId: string | null;
    text: string;
    status: string;
    attempt: number;
    ownerPid: number | null;
    ownerToken: string | null;
    leaseExpiresAt: string | null;
    error: string | null;
  } | null {
    const row = this.#db
      .prepare("SELECT * FROM v2_deliveries WHERE command_id = ?")
      .get(commandId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      commandId: String(row.command_id),
      target: String(row.target),
      turnId: (row.turn_id as string | null) ?? null,
      text: String(row.text),
      status: String(row.status),
      attempt: Number(row.attempt),
      ownerPid: (row.owner_pid as number | null) ?? null,
      ownerToken: (row.owner_token as string | null) ?? null,
      leaseExpiresAt: (row.lease_expires_at as string | null) ?? null,
      error: (row.error as string | null) ?? null,
    };
  }

  claimDelivery(commandId: string, leaseMs: number): string | null {
    const now = nowIso();
    const leaseExpires = new Date(Date.now() + leaseMs).toISOString();
    const token = randomUUID();
    const row = this.getDelivery(commandId);
    if (!row) return null;
    if (row.status === "delivered") return null;
    return this.transaction(() => {
      const current = this.getDelivery(commandId);
      if (!current || current.status === "delivered") return null;
      if (current.status === "delivering") {
        const ownerAlive = current.ownerPid !== null && processIsAlive(current.ownerPid);
        const leaseValid = Boolean(current.leaseExpiresAt && current.leaseExpiresAt > now);
        if (ownerAlive && leaseValid) return null;
        const reclaim = this.#db
          .prepare(
            `UPDATE v2_deliveries
             SET status = 'delivering', error = NULL, owner_pid = ?, owner_token = ?,
                 lease_expires_at = ?, updated_at = ?
             WHERE command_id = ? AND status = 'delivering'
               AND owner_token IS ?
               AND lease_expires_at IS ?`,
          )
          .run(
            process.pid,
            token,
            leaseExpires,
            now,
            commandId,
            current.ownerToken,
            current.leaseExpiresAt,
          );
        return reclaim.changes === 1 ? token : null;
      }
      if (current.status !== "pending" && current.status !== "failed") return null;
      const updated = this.#db
        .prepare(
          `UPDATE v2_deliveries
           SET status = 'delivering', error = NULL, owner_pid = ?, owner_token = ?,
               lease_expires_at = ?, updated_at = ?
           WHERE command_id = ? AND status IN ('pending', 'failed')`,
        )
        .run(process.pid, token, leaseExpires, now, commandId);
      return updated.changes === 1 ? token : null;
    });
  }

  renewDeliveryLease(commandId: string, token: string, leaseMs: number): boolean {
    const leaseExpires = new Date(Date.now() + leaseMs).toISOString();
    const updated = this.#db
      .prepare(
        `UPDATE v2_deliveries
         SET lease_expires_at = ?, updated_at = ?
         WHERE command_id = ? AND owner_token = ? AND status = 'delivering'`,
      )
      .run(leaseExpires, nowIso(), commandId, token);
    return updated.changes === 1;
  }

  finalizeDelivery(
    commandId: string,
    token: string,
    outcome: { status: "delivered" } | { status: "failed"; error: string },
  ): boolean {
    if (outcome.status === "delivered") {
      const updated = this.#db
        .prepare(
          `UPDATE v2_deliveries
           SET status = 'delivered', error = NULL, owner_pid = NULL, owner_token = NULL,
               lease_expires_at = NULL, updated_at = ?
           WHERE command_id = ? AND owner_token = ? AND status = 'delivering'`,
        )
        .run(nowIso(), commandId, token);
      return updated.changes === 1;
    }
    const updated = this.#db
      .prepare(
        `UPDATE v2_deliveries
         SET status = 'failed', error = ?, owner_pid = NULL, owner_token = NULL,
             lease_expires_at = NULL, attempt = attempt + 1, updated_at = ?
         WHERE command_id = ? AND owner_token = ? AND status = 'delivering'`,
      )
      .run(outcome.error, nowIso(), commandId, token);
    return updated.changes === 1;
  }

  #pruneEvents(target: string): void {
    const cutoff = new Date(Date.now() - this.#retentionDays * 24 * 60 * 60 * 1000).toISOString();
    this.#db.prepare("DELETE FROM v2_events WHERE target = ? AND at < ?").run(target, cutoff);
    const countRow = this.#db
      .prepare("SELECT COUNT(*) AS n FROM v2_events WHERE target = ?")
      .get(target) as { n: number };
    if (countRow.n <= this.#retentionCount) return;
    const overflow = countRow.n - this.#retentionCount;
    this.#db
      .prepare(
        `DELETE FROM v2_events
         WHERE rowid IN (
           SELECT rowid FROM v2_events WHERE target = ? ORDER BY seq LIMIT ?
         )`,
      )
      .run(target, overflow);
  }

  #ensureColumns(): void {
    runExclusiveMigration(this.#db, () => {
      ensureColumn(
        this.#db,
        "v2_runtimes",
        "last_reconcile_result",
        "ALTER TABLE v2_runtimes ADD COLUMN last_reconcile_result TEXT",
      );
    });
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

function runtimeFromRow(row: Record<string, unknown>): V2RuntimeRow {
  return {
    target: String(row.target),
    provider: String(row.provider),
    state: row.state as V2RuntimeState,
    generation: Number(row.generation),
    ownerKind: row.owner_kind as V2OwnerKind,
    ownerPid: (row.owner_pid as number | null) ?? null,
    ownerToken: (row.owner_token as string | null) ?? null,
    leaseExpiresAt: (row.lease_expires_at as string | null) ?? null,
    startedAt: (row.started_at as string | null) ?? null,
    writerResourceKey: String(row.writer_resource_key),
    hostId: String(row.host_id),
    hostThreadId: String(row.host_thread_id),
    canonicalThreadId: String(row.canonical_thread_id),
    nativeThreadRef: (row.native_thread_ref as string | null) ?? null,
    currentTurnId: (row.current_turn_id as string | null) ?? null,
    currentNativeTurnId: (row.current_native_turn_id as string | null) ?? null,
    currentTurnCommandId: (row.current_turn_command_id as string | null) ?? null,
    currentTurnCause: (row.current_turn_cause as string | null) ?? null,
    currentTurnStartedAt: (row.current_turn_started_at as string | null) ?? null,
    terminalId: (row.terminal_id as string | null) ?? null,
    lastReconcileAt: (row.last_reconcile_at as string | null) ?? null,
    lastReconcileResult: (row.last_reconcile_result as string | null) ?? null,
    updatedAt: String(row.updated_at),
  };
}

function commandFromRow(row: Record<string, unknown>): V2CommandRow {
  return {
    commandId: String(row.command_id),
    target: String(row.target),
    kind: row.kind as V2CommandKind,
    paramsJson: String(row.params_json),
    receipt: row.receipt as V2ReceiptState,
    reason: (row.reason as string | null) ?? null,
    dispatchState: row.dispatch_state as V2DispatchState,
    runtimeGeneration: (row.runtime_generation as number | null) ?? null,
    nativeTurnId: (row.native_turn_id as string | null) ?? null,
    providerResponseId: (row.provider_response_id as string | null) ?? null,
    effectStage: (row.effect_stage as V2SteerEffectStage | null) ?? null,
    turnId: (row.turn_id as string | null) ?? null,
    expectedTurnId: (row.expected_turn_id as string | null) ?? null,
    afterTurnId: (row.after_turn_id as string | null) ?? null,
    message: (row.message as string | null) ?? null,
    acceptedAt: String(row.accepted_at),
    updatedAt: String(row.updated_at),
  };
}

function eventFromRow(row: Record<string, unknown>): V2Event {
  return {
    seq: Number(row.seq),
    target: String(row.target),
    at: String(row.at),
    kind: row.kind as V2EventKind,
    turnId: (row.turn_id as string | null) ?? null,
    commandId: (row.command_id as string | null) ?? null,
    data: JSON.parse(String(row.data_json)) as Record<string, unknown>,
    provider:
      typeof row.provider_json === "string"
        ? (JSON.parse(row.provider_json) as V2Event["provider"])
        : undefined,
  };
}

function followUpFromRow(row: Record<string, unknown>): V2FollowUpRow {
  return {
    commandId: String(row.command_id),
    target: String(row.target),
    afterTurnId: String(row.after_turn_id),
    text: String(row.text),
    delivery: (row.delivery as string | null) ?? null,
    cancelOnInterrupt: Number(row.cancel_on_interrupt),
    queuedAt: String(row.queued_at),
    held: Number(row.held),
  };
}
