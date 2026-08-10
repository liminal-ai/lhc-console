import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { processIsAlive } from "./process-alive.ts";
import { ensureColumn, runExclusiveMigration } from "./sqlite-migrate.ts";

export const INBOUND_LEASE_MS = 120_000;

export type InboundDedupeGate = "skip" | "process";

export interface InboundDedupeClaim {
  gate: InboundDedupeGate;
  token?: string;
}

export class InboundDedupeStore {
  readonly #dbPath: string;
  readonly #leaseMs: number;

  constructor(dbPath: string, options: { leaseMs?: number } = {}) {
    this.#dbPath = dbPath;
    this.#leaseMs = options.leaseMs ?? INBOUND_LEASE_MS;
  }

  begin(chatId: string, messageId: string): InboundDedupeClaim {
    if (!chatId || !messageId) return { gate: "skip" };
    return this.#withDb((db) => {
      const now = new Date();
      const nowIso = now.toISOString();
      const leaseExpires = new Date(now.getTime() + this.#leaseMs).toISOString();
      const token = randomUUID();
      const pid = process.pid;
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db
          .prepare(
            `SELECT state, owner_pid, lease_expires_at
             FROM inbound_messages
             WHERE chat_id = ? AND message_id = ?`,
          )
          .get(chatId, messageId) as
          | { state: string; owner_pid: number | null; lease_expires_at: string | null }
          | undefined;
        if (row?.state === "complete") {
          db.exec("ROLLBACK");
          return { gate: "skip" as const };
        }
        if (row?.state === "processing") {
          const ownerAlive = row.owner_pid !== null && processIsAlive(row.owner_pid);
          const leaseValid = Boolean(row.lease_expires_at && row.lease_expires_at > nowIso);
          if (ownerAlive && leaseValid) {
            db.exec("ROLLBACK");
            return { gate: "skip" as const };
          }
          db.prepare(
            `UPDATE inbound_messages
             SET owner_pid = ?, owner_token = ?, lease_expires_at = ?, updated_at = ?
             WHERE chat_id = ? AND message_id = ? AND state = 'processing'`,
          ).run(pid, token, leaseExpires, nowIso, chatId, messageId);
          db.exec("COMMIT");
          return { gate: "process" as const, token };
        }
        db.prepare(
          `INSERT INTO inbound_messages (
             chat_id, message_id, state, updated_at, owner_pid, owner_token, lease_expires_at
           ) VALUES (?, ?, 'processing', ?, ?, ?, ?)`,
        ).run(chatId, messageId, nowIso, pid, token, leaseExpires);
        db.exec("COMMIT");
        return { gate: "process" as const, token };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  complete(chatId: string, messageId: string, token?: string): void {
    if (!chatId || !messageId) return;
    this.#withDb((db) => {
      if (token) {
        db.prepare(
          `UPDATE inbound_messages
           SET state = 'complete',
               updated_at = ?,
               owner_pid = NULL,
               owner_token = NULL,
               lease_expires_at = NULL
           WHERE chat_id = ? AND message_id = ? AND owner_token = ?`,
        ).run(new Date().toISOString(), chatId, messageId, token);
        return;
      }
      db.prepare(
        `UPDATE inbound_messages
         SET state = 'complete',
             updated_at = ?,
             owner_pid = NULL,
             owner_token = NULL,
             lease_expires_at = NULL
         WHERE chat_id = ? AND message_id = ?
           AND (owner_token IS NULL OR state != 'processing')`,
      ).run(new Date().toISOString(), chatId, messageId);
    });
  }

  release(chatId: string, messageId: string, token?: string): void {
    if (!chatId || !messageId) return;
    this.#withDb((db) => {
      if (token) {
        db.prepare(
          `DELETE FROM inbound_messages
           WHERE chat_id = ? AND message_id = ? AND state = 'processing' AND owner_token = ?`,
        ).run(chatId, messageId, token);
        return;
      }
      db.prepare(
        `DELETE FROM inbound_messages
         WHERE chat_id = ? AND message_id = ? AND state = 'processing' AND owner_pid = ?`,
      ).run(chatId, messageId, process.pid);
    });
  }

  #withDb<T>(fn: (db: DatabaseSync) => T): T {
    mkdirSync(dirname(this.#dbPath), { recursive: true, mode: 0o700 });
    closeSync(openSync(this.#dbPath, "a", 0o600));
    chmodSync(this.#dbPath, 0o600);
    const db = new DatabaseSync(this.#dbPath);
    try {
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS inbound_messages (
          chat_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          state TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          owner_pid INTEGER,
          owner_token TEXT,
          lease_expires_at TEXT,
          PRIMARY KEY (chat_id, message_id)
        );
      `);
      runExclusiveMigration(db, () => {
        ensureColumn(
          db,
          "inbound_messages",
          "owner_pid",
          "ALTER TABLE inbound_messages ADD COLUMN owner_pid INTEGER",
        );
        ensureColumn(
          db,
          "inbound_messages",
          "owner_token",
          "ALTER TABLE inbound_messages ADD COLUMN owner_token TEXT",
        );
        ensureColumn(
          db,
          "inbound_messages",
          "lease_expires_at",
          "ALTER TABLE inbound_messages ADD COLUMN lease_expires_at TEXT",
        );
        const seen = db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'seen_messages'")
          .get() as { name: string } | undefined;
        if (seen) {
          db.prepare(
            `INSERT OR IGNORE INTO inbound_messages (chat_id, message_id, state, updated_at)
             SELECT chat_id, message_id, 'complete', seen_at FROM seen_messages`,
          ).run();
        }
      });
      return fn(db);
    } finally {
      for (const path of [this.#dbPath, `${this.#dbPath}-wal`, `${this.#dbPath}-shm`]) {
        if (existsSync(path)) chmodSync(path, 0o600);
      }
      db.close();
    }
  }
}
