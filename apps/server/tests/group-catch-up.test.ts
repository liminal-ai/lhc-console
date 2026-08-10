import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { GroupCatchUpStore, GroupCatchUpStoreError } from "../src/group-catch-up.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempStore(): { store: GroupCatchUpStore; agentId: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "lhc-group-catch-up-"));
  dirs.push(dir);
  const agentId = "fable";
  return {
    agentId,
    dbPath: join(dir, "group-catch-up.sqlite"),
    store: new GroupCatchUpStore(join(dir, "group-catch-up.sqlite")),
  };
}

describe("GroupCatchUpStore", () => {
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
});
