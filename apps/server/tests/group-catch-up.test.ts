import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_MAX_BACKLOG_BYTES,
  DEFAULT_MAX_BACKLOG_MESSAGES,
  GroupBacklogLimitError,
  GroupCatchUpStore,
  GroupCatchUpStoreError,
  resolveBacklogLimits,
} from "../src/group-catch-up.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempStore(limits?: { maxBacklogMessages?: number; maxBacklogBytes?: number }): {
  store: GroupCatchUpStore;
  dbPath: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "lhc-group-catch-up-"));
  dirs.push(dir);
  const dbPath = join(dir, "group-catch-up.sqlite");
  return { dbPath, store: new GroupCatchUpStore(dbPath, limits) };
}

describe("GroupCatchUpStore", () => {
  it("applies generous production defaults", () => {
    expect(resolveBacklogLimits()).toEqual({
      maxBacklogMessages: DEFAULT_MAX_BACKLOG_MESSAGES,
      maxBacklogBytes: DEFAULT_MAX_BACKLOG_BYTES,
    });
  });

  it("rejects invalid backlog limit environment values", () => {
    const previousMessages = process.env.LHC_PHOTON_MAX_BACKLOG_MESSAGES;
    const previousBytes = process.env.LHC_PHOTON_MAX_BACKLOG_BYTES;
    try {
      process.env.LHC_PHOTON_MAX_BACKLOG_MESSAGES = "Infinity";
      process.env.LHC_PHOTON_MAX_BACKLOG_BYTES = "not-a-number";
      expect(resolveBacklogLimits()).toEqual({
        maxBacklogMessages: DEFAULT_MAX_BACKLOG_MESSAGES,
        maxBacklogBytes: DEFAULT_MAX_BACKLOG_BYTES,
      });
      process.env.LHC_PHOTON_MAX_BACKLOG_MESSAGES = "0";
      process.env.LHC_PHOTON_MAX_BACKLOG_BYTES = "-5";
      expect(resolveBacklogLimits()).toEqual({
        maxBacklogMessages: DEFAULT_MAX_BACKLOG_MESSAGES,
        maxBacklogBytes: DEFAULT_MAX_BACKLOG_BYTES,
      });
    } finally {
      if (previousMessages === undefined) delete process.env.LHC_PHOTON_MAX_BACKLOG_MESSAGES;
      else process.env.LHC_PHOTON_MAX_BACKLOG_MESSAGES = previousMessages;
      if (previousBytes === undefined) delete process.env.LHC_PHOTON_MAX_BACKLOG_BYTES;
      else process.env.LHC_PHOTON_MAX_BACKLOG_BYTES = previousBytes;
    }
  });

  it("deduplicates buffered messages by chat and message id", () => {
    const { store } = tempStore();
    expect(
      store.append("group-1", {
        messageId: "m1",
        senderId: "+15550000001",
        text: "first",
        timestamp: "2026-01-01T00:00:00.000Z",
        senderAuthorized: true,
      }),
    ).toBe(true);
    expect(
      store.append("group-1", {
        messageId: "m1",
        senderId: "+15550000001",
        text: "duplicate",
        timestamp: "2026-01-01T00:00:01.000Z",
        senderAuthorized: true,
      }),
    ).toBe(false);
  });

  it("pseudonymizes participants and prefixes unverified lines", () => {
    const { store } = tempStore();
    store.append("group-1", {
      messageId: "m1",
      senderId: "+15550000001",
      text: "hello",
      timestamp: "2026-01-01T00:00:00.000Z",
      senderAuthorized: true,
    });
    store.append("group-1", {
      messageId: "m2",
      senderId: "+15550000002",
      text: "stranger",
      timestamp: "2026-01-01T00:00:01.000Z",
      senderAuthorized: false,
    });
    const [context] = store.readWakeSnapshot("group-1");
    expect(context).toContain("[Group messages since your last reply]");
    expect(context).toContain("[participant-1] hello");
    expect(context).toContain("[unverified] [participant-2] stranger");
    expect(context).toContain("hasn't been confirmed against your allowlist");
  });

  it("returns consumed ids in chronological order for wake catch-up", () => {
    const { store } = tempStore();
    store.append("group-1", {
      messageId: "m2",
      senderId: "+15550000001",
      text: "later",
      timestamp: "2026-01-01T00:00:02.000Z",
      senderAuthorized: true,
    });
    store.append("group-1", {
      messageId: "m1",
      senderId: "+15550000001",
      text: "earlier",
      timestamp: "2026-01-01T00:00:01.000Z",
      senderAuthorized: true,
    });
    const [, consumed] = store.readWakeSnapshot("group-1");
    expect(consumed).toEqual(["m1", "m2"]);
  });

  it("advances only the exact consumed snapshot after a successful wake", () => {
    const { store } = tempStore();
    store.append("group-1", {
      messageId: "m1",
      senderId: "+15550000001",
      text: "one",
      timestamp: "2026-01-01T00:00:00.000Z",
      senderAuthorized: true,
    });
    const [, consumed] = store.readWakeSnapshot("group-1");
    store.advanceCursor("group-1", "wake-1", consumed);
    expect(store.pendingMessageIds("group-1")).toEqual([]);
    store.append("group-1", {
      messageId: "m2",
      senderId: "+15550000001",
      text: "two",
      timestamp: "2026-01-01T00:00:01.000Z",
      senderAuthorized: true,
    });
    expect(store.pendingMessageIds("group-1")).toEqual(["m2"]);
  });

  it("fails closed visibly on persistence errors", () => {
    const { dbPath } = tempStore();
    const store = new GroupCatchUpStore(dbPath);
    const seed = new DatabaseSync(dbPath);
    seed.exec("CREATE TABLE backlog_messages (id INTEGER PRIMARY KEY)");
    seed.close();
    expect(() =>
      store.append("group-1", {
        messageId: "m1",
        senderId: "+15550000001",
        text: "boom",
        timestamp: "2026-01-01T00:00:00.000Z",
        senderAuthorized: true,
      }),
    ).toThrow(GroupCatchUpStoreError);
  });

  it("allocates stable participant labels under concurrent appends", () => {
    const { store } = tempStore();
    store.append("group-1", {
      messageId: "m1",
      senderId: "+15550000001",
      text: "a",
      timestamp: "2026-01-01T00:00:00.000Z",
      senderAuthorized: true,
    });
    store.append("group-1", {
      messageId: "m2",
      senderId: "+15550000002",
      text: "b",
      timestamp: "2026-01-01T00:00:01.000Z",
      senderAuthorized: false,
    });
    const [context] = store.readWakeSnapshot("group-1");
    expect(context).toContain("[participant-1] a");
    expect(context).toContain("[participant-2] b");
  });

  it("measures backlog size in UTF-8 bytes", () => {
    const { store } = tempStore({ maxBacklogBytes: 3 });
    store.append("group-1", {
      messageId: "m1",
      senderId: "+15550000001",
      text: "€",
      timestamp: "2026-01-01T00:00:00.000Z",
      senderAuthorized: true,
    });
    expect(() =>
      store.append("group-1", {
        messageId: "m2",
        senderId: "+15550000001",
        text: "a",
        timestamp: "2026-01-01T00:00:01.000Z",
        senderAuthorized: true,
      }),
    ).toThrow(GroupBacklogLimitError);
    expect(store.pendingMessageIds("group-1")).toEqual(["m1"]);
  });

  it("refuses further appends once the backlog is full", () => {
    const { store } = tempStore({ maxBacklogMessages: 1 });
    store.append("group-1", {
      messageId: "m1",
      senderId: "+15550000001",
      text: "one",
      timestamp: "2026-01-01T00:00:00.000Z",
      senderAuthorized: true,
    });
    expect(() =>
      store.append("group-1", {
        messageId: "m2",
        senderId: "+15550000001",
        text: "two",
        timestamp: "2026-01-01T00:00:01.000Z",
        senderAuthorized: true,
      }),
    ).toThrow(GroupBacklogLimitError);
    expect(store.pendingMessageIds("group-1")).toEqual(["m1"]);
  });

  it("refuses wake when backlog exceeds configured safety limits", () => {
    const { dbPath } = tempStore();
    const seed = new DatabaseSync(dbPath);
    seed.exec(`
      CREATE TABLE chat_cursors (chat_id TEXT PRIMARY KEY, cursor_message_id TEXT NOT NULL);
      CREATE TABLE chat_participants (
        chat_id TEXT NOT NULL, sender_id TEXT NOT NULL, label TEXT NOT NULL,
        PRIMARY KEY (chat_id, sender_id)
      );
      CREATE TABLE backlog_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        participant_label TEXT NOT NULL,
        text TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        sender_authorized INTEGER,
        text_bytes INTEGER NOT NULL DEFAULT 0,
        UNIQUE(chat_id, message_id)
      );
    `);
    seed
      .prepare(
        `INSERT INTO backlog_messages
       (message_id, chat_id, participant_label, text, timestamp, sender_authorized, text_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("m1", "group-1", "participant-1", "one", "2026-01-01T00:00:00.000Z", 1, 3);
    seed
      .prepare(
        `INSERT INTO backlog_messages
       (message_id, chat_id, participant_label, text, timestamp, sender_authorized, text_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("m2", "group-1", "participant-1", "two", "2026-01-01T00:00:01.000Z", 1, 3);
    seed.close();
    const bounded = new GroupCatchUpStore(dbPath, { maxBacklogMessages: 1 });
    expect(() => bounded.readWakeSnapshot("group-1")).toThrow(GroupBacklogLimitError);
    expect(bounded.pendingMessageIds("group-1")).toEqual(["m1", "m2"]);
  });
});
