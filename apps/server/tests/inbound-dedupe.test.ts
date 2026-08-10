import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { InboundDedupeStore } from "../src/inbound-dedupe.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "lhc-dedupe-"));
  dirs.push(dir);
  return join(dir, "dedupe.sqlite");
}

describe("InboundDedupeStore", () => {
  it("skips completed events across restarts", () => {
    const path = tempPath();
    const first = new InboundDedupeStore(path);
    const claim = first.begin("dm:+15559876543", "dm-1");
    expect(claim).toEqual({
      gate: "process",
      token: expect.any(String),
    });
    first.complete("dm:+15559876543", "dm-1", claim.token);

    const second = new InboundDedupeStore(path);
    expect(second.begin("dm:+15559876543", "dm-1")).toEqual({ gate: "skip" });
    expect(second.begin("dm:+15559876543", "dm-2").gate).toBe("process");
  });

  it("skips duplicate work while a live owner holds the lease", () => {
    const path = tempPath();
    const first = new InboundDedupeStore(path);
    const second = new InboundDedupeStore(path);
    expect(first.begin("chat-1", "m1").gate).toBe("process");
    expect(second.begin("chat-1", "m1")).toEqual({ gate: "skip" });
  });

  it("reclaims processing after a dead owner", () => {
    const path = tempPath();
    const seed = new DatabaseSync(path);
    seed.exec(`
      CREATE TABLE inbound_messages (
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        owner_pid INTEGER,
        owner_token TEXT,
        lease_expires_at TEXT,
        PRIMARY KEY (chat_id, message_id)
      )
    `);
    seed
      .prepare(
        `INSERT INTO inbound_messages
         (chat_id, message_id, state, updated_at, owner_pid, owner_token, lease_expires_at)
         VALUES (?, ?, 'processing', ?, ?, ?, ?)`,
      )
      .run(
        "chat-1",
        "m1",
        new Date().toISOString(),
        999_999_999,
        "dead",
        new Date(Date.now() + 60_000).toISOString(),
      );
    seed.close();

    const store = new InboundDedupeStore(path);
    expect(store.begin("chat-1", "m1").gate).toBe("process");
  });

  it("reclaims processing after a stale lease", () => {
    const path = tempPath();
    const seed = new DatabaseSync(path);
    seed.exec(`
      CREATE TABLE inbound_messages (
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        owner_pid INTEGER,
        owner_token TEXT,
        lease_expires_at TEXT,
        PRIMARY KEY (chat_id, message_id)
      )
    `);
    seed
      .prepare(
        `INSERT INTO inbound_messages
         (chat_id, message_id, state, updated_at, owner_pid, owner_token, lease_expires_at)
         VALUES (?, ?, 'processing', ?, ?, ?, ?)`,
      )
      .run(
        "chat-1",
        "m1",
        new Date().toISOString(),
        process.pid,
        "stale",
        new Date(Date.now() - 60_000).toISOString(),
      );
    seed.close();

    const store = new InboundDedupeStore(path);
    expect(store.begin("chat-1", "m1").gate).toBe("process");
  });

  it("migrates legacy seen_messages rows as complete", () => {
    const path = tempPath();
    const seed = new DatabaseSync(path);
    seed.exec(`
      CREATE TABLE seen_messages (
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        seen_at TEXT NOT NULL,
        PRIMARY KEY (chat_id, message_id)
      )
    `);
    seed
      .prepare("INSERT INTO seen_messages (chat_id, message_id, seen_at) VALUES (?, ?, ?)")
      .run("chat-legacy", "legacy-1", "2026-01-01T00:00:00.000Z");
    seed.close();

    const store = new InboundDedupeStore(path);
    expect(store.begin("chat-legacy", "legacy-1")).toEqual({ gate: "skip" });
  });

  it("releases processing only for the owning token", () => {
    const path = tempPath();
    const store = new InboundDedupeStore(path);
    const claim = store.begin("chat-1", "m1");
    expect(claim.gate).toBe("process");
    store.release("chat-1", "m1", "wrong-token");
    expect(store.begin("chat-1", "m1")).toEqual({ gate: "skip" });
    store.release("chat-1", "m1", claim.token);
    expect(store.begin("chat-1", "m1").gate).toBe("process");
  });

  it("completes processing only for the owning token", () => {
    const path = tempPath();
    const first = new InboundDedupeStore(path);
    const second = new InboundDedupeStore(path);
    const stale = first.begin("chat-1", "m1");
    expect(stale.gate).toBe("process");
    const seed = new DatabaseSync(path);
    seed
      .prepare(
        `UPDATE inbound_messages
       SET owner_pid = ?, lease_expires_at = ?
       WHERE chat_id = ? AND message_id = ?`,
      )
      .run(999_999_999, new Date(Date.now() - 60_000).toISOString(), "chat-1", "m1");
    seed.close();
    const current = second.begin("chat-1", "m1");
    expect(current.gate).toBe("process");
    first.complete("chat-1", "m1", stale.token);
    expect(second.begin("chat-1", "m1")).toEqual({ gate: "skip" });
    if (current.token) second.complete("chat-1", "m1", current.token);
    expect(second.begin("chat-1", "m1")).toEqual({ gate: "skip" });
  });
});
