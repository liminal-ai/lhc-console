import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class InboundDedupeStore {
  readonly #dbPath: string;

  constructor(dbPath: string) {
    this.#dbPath = dbPath;
  }

  claim(chatId: string, messageId: string): boolean {
    if (!chatId || !messageId) return false;
    return this.#withDb((db) => {
      const result = db
        .prepare(
          `INSERT OR IGNORE INTO seen_messages (chat_id, message_id, seen_at)
           VALUES (?, ?, ?)`,
        )
        .run(chatId, messageId, new Date().toISOString());
      return result.changes === 1;
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
        CREATE TABLE IF NOT EXISTS seen_messages (
          chat_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          seen_at TEXT NOT NULL,
          PRIMARY KEY (chat_id, message_id)
        );
      `);
      return fn(db);
    } finally {
      for (const path of [this.#dbPath, `${this.#dbPath}-wal`, `${this.#dbPath}-shm`]) {
        if (existsSync(path)) chmodSync(path, 0o600);
      }
      db.close();
    }
  }
}
