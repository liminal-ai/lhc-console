// Group-line transcript: the source of truth for one group. Every owner
// message and every member reply lands here first; each member has a cursor
// (the last seq it has seen). Idempotent on the inbound message id and on the
// relay job id so redelivery never duplicates a line. Bounded by bytes with
// trim-oldest; a wake is never refused for size.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DEFAULT_TRANSCRIPT_MAX_BYTES = 256 * 1024;

export interface TranscriptMessage {
  seq: number;
  senderId: string;
  senderLabel: string;
  text: string;
  at: string;
  jobId: string | null;
  inboundMessageId: string | null;
}

export interface TranscriptAppendInput {
  senderId: string;
  senderLabel: string;
  text: string;
  at?: string;
  jobId?: string | null;
  inboundMessageId?: string | null;
}

export interface TranscriptSlice {
  messages: TranscriptMessage[];
  /** Lines dropped by the byte cap (or a window) that the reader will not see. */
  trimmed: number;
}

interface Row {
  seq: number;
  sender_id: string;
  sender_label: string;
  text: string;
  at: string;
  job_id: string | null;
  inbound_message_id: string | null;
}

function rowToMessage(row: Row): TranscriptMessage {
  return {
    seq: Number(row.seq),
    senderId: row.sender_id,
    senderLabel: row.sender_label,
    text: row.text,
    at: row.at,
    jobId: row.job_id,
    inboundMessageId: row.inbound_message_id,
  };
}

export class GroupTranscript {
  readonly #db: DatabaseSync;
  readonly #maxBytes: number;

  constructor(dbPath: string, options: { maxBytes?: number } = {}) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new DatabaseSync(dbPath);
    this.#maxBytes = options.maxBytes ?? DEFAULT_TRANSCRIPT_MAX_BYTES;
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id TEXT NOT NULL,
        sender_label TEXT NOT NULL,
        text TEXT NOT NULL,
        at TEXT NOT NULL,
        job_id TEXT,
        inbound_message_id TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS messages_job_id ON messages(job_id) WHERE job_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS messages_inbound_id
        ON messages(inbound_message_id) WHERE inbound_message_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS cursors (
        member_id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
    `);
  }

  close(): void {
    this.#db.close();
  }

  /**
   * Append one line. Returns the row and whether it was new; a repeat of a
   * known inbound message id or job id returns the existing row unchanged.
   */
  append(input: TranscriptAppendInput): { message: TranscriptMessage; inserted: boolean } {
    const existing = this.#existing(input);
    if (existing) return { message: existing, inserted: false };
    const at = input.at ?? new Date().toISOString();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const duplicate = this.#existing(input);
      if (duplicate) {
        this.#db.exec("COMMIT");
        return { message: duplicate, inserted: false };
      }
      const result = this.#db
        .prepare(
          `INSERT INTO messages (sender_id, sender_label, text, at, job_id, inbound_message_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.senderId,
          input.senderLabel,
          input.text,
          at,
          input.jobId ?? null,
          input.inboundMessageId ?? null,
        );
      this.#trimLocked();
      this.#db.exec("COMMIT");
      const seq = Number(result.lastInsertRowid);
      return {
        message: {
          seq,
          senderId: input.senderId,
          senderLabel: input.senderLabel,
          text: input.text,
          at,
          jobId: input.jobId ?? null,
          inboundMessageId: input.inboundMessageId ?? null,
        },
        inserted: true,
      };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  cursor(memberId: string): number {
    const row = this.#db.prepare("SELECT seq FROM cursors WHERE member_id = ?").get(memberId) as
      | { seq: number }
      | undefined;
    return row ? Number(row.seq) : 0;
  }

  /** Move a member's cursor forward; never backward. */
  advanceCursor(memberId: string, seq: number): void {
    this.#db
      .prepare(
        `INSERT INTO cursors (member_id, seq) VALUES (?, ?)
         ON CONFLICT(member_id) DO UPDATE SET seq = MAX(seq, excluded.seq)`,
      )
      .run(memberId, seq);
  }

  /**
   * Lines after `afterSeq` (and before `beforeSeq`), oldest first. Lines lost
   * to the byte cap since `afterSeq` are counted as trimmed.
   */
  since(afterSeq: number, options: { beforeSeq?: number } = {}): TranscriptSlice {
    const rows = this.#db
      .prepare("SELECT * FROM messages WHERE seq > ? AND seq < ? ORDER BY seq ASC")
      .all(afterSeq, options.beforeSeq ?? Number.MAX_SAFE_INTEGER) as unknown as Row[];
    const messages = rows.map(rowToMessage);
    const firstKept = this.#firstSeq();
    let trimmed = 0;
    if (firstKept !== null && firstKept > afterSeq + 1) {
      // Rows in (afterSeq, firstKept) were dropped by the byte cap.
      trimmed += firstKept - afterSeq - 1;
    } else if (firstKept === null) {
      trimmed += Math.max(0, this.#trimmedTotal() - afterSeq);
    }
    return { messages, trimmed };
  }

  /** Read-only listing for viewers (web): lines after `afterSeq`, oldest first, capped. */
  list(afterSeq = 0, limit = 500): TranscriptMessage[] {
    const rows = this.#db
      .prepare("SELECT * FROM messages WHERE seq > ? ORDER BY seq ASC LIMIT ?")
      .all(afterSeq, limit) as unknown as Row[];
    return rows.map(rowToMessage);
  }

  lastSeq(): number {
    const row = this.#db.prepare("SELECT MAX(seq) AS seq FROM messages").get() as {
      seq: number | null;
    };
    return row.seq === null ? this.#trimmedTotal() : Number(row.seq);
  }

  #existing(input: TranscriptAppendInput): TranscriptMessage | null {
    if (input.inboundMessageId) {
      const row = this.#db
        .prepare("SELECT * FROM messages WHERE inbound_message_id = ?")
        .get(input.inboundMessageId) as Row | undefined;
      if (row) return rowToMessage(row);
    }
    if (input.jobId) {
      const row = this.#db.prepare("SELECT * FROM messages WHERE job_id = ?").get(input.jobId) as
        | Row
        | undefined;
      if (row) return rowToMessage(row);
    }
    return null;
  }

  #firstSeq(): number | null {
    const row = this.#db.prepare("SELECT MIN(seq) AS seq FROM messages").get() as {
      seq: number | null;
    };
    return row.seq === null ? null : Number(row.seq);
  }

  /** Highest seq ever dropped by the byte cap (0 when nothing was dropped). */
  #trimmedTotal(): number {
    const row = this.#db.prepare("SELECT value FROM meta WHERE key = 'trimmed_through'").get() as
      | { value: number }
      | undefined;
    return row ? Number(row.value) : 0;
  }

  #bytes(): number {
    const row = this.#db
      .prepare("SELECT COALESCE(SUM(LENGTH(CAST(text AS BLOB)) + 64), 0) AS bytes FROM messages")
      .get() as { bytes: number };
    return Number(row.bytes);
  }

  /** Drop oldest lines until the transcript fits; always keeps the newest line. */
  #trimLocked(): void {
    let bytes = this.#bytes();
    if (bytes <= this.#maxBytes) return;
    let lastDropped = 0;
    while (bytes > this.#maxBytes) {
      const oldest = this.#db
        .prepare("SELECT seq FROM messages ORDER BY seq ASC LIMIT 2")
        .all() as unknown as Array<{ seq: number }>;
      if (oldest.length < 2) break;
      const seq = Number(oldest[0]!.seq);
      this.#db.prepare("DELETE FROM messages WHERE seq = ?").run(seq);
      lastDropped = seq;
      bytes = this.#bytes();
    }
    if (lastDropped > 0) {
      this.#db
        .prepare(
          `INSERT INTO meta (key, value) VALUES ('trimmed_through', ?)
           ON CONFLICT(key) DO UPDATE SET value = MAX(value, excluded.value)`,
        )
        .run(lastDropped);
    }
  }
}
