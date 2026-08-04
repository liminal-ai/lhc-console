import { describe, expect, it } from "vite-plus/test";
import {
  admissionBlocked,
  advanceRekey,
  classifyPane,
  frameIsStale,
  reconcile,
  sessionDisplayName,
  type PaneFacts,
} from "../src/tmuxpool.ts";

function facts(over: Partial<PaneFacts> = {}): PaneFacts {
  return {
    dead: false,
    panePid: 100,
    foregroundPid: 100,
    foregroundComm: "bash",
    hasNonShellDescendants: false,
    readyToken: "3.100",
    recordedToken: "2.100",
    adapterSupported: true,
    ...over,
  };
}

describe("classifyPane", () => {
  it("fresh prompt token → idle", () => {
    expect(classifyPane(facts())).toBe("idle");
  });
  it("dead pane wins over everything", () => {
    expect(classifyPane(facts({ dead: true }))).toBe("dead");
  });
  it("foreground CLI → running", () => {
    expect(classifyPane(facts({ foregroundPid: 222, foregroundComm: "node" }))).toBe("running");
  });
  it("shell foreground but non-shell descendants → running (backgrounded job)", () => {
    expect(classifyPane(facts({ hasNonShellDescendants: true }))).toBe("running");
  });
  it("ssh foreground → busy (opaque), never idle", () => {
    expect(classifyPane(facts({ foregroundPid: 222, foregroundComm: "ssh" }))).toBe("busy");
  });
  it("nested tmux client → busy (opaque)", () => {
    expect(classifyPane(facts({ foregroundPid: 222, foregroundComm: "tmux" }))).toBe("busy");
  });
  it("stale token (no new prompt since last input) → busy, not idle", () => {
    expect(classifyPane(facts({ readyToken: "2.100", recordedToken: "2.100" }))).toBe("busy");
  });
  it("no token at all → busy", () => {
    expect(classifyPane(facts({ readyToken: "" }))).toBe("busy");
  });
  it("unsupported shell adapter → busy even at an apparent prompt", () => {
    expect(classifyPane(facts({ adapterSupported: false }))).toBe("busy");
  });
  it("nested user bash at prompt still idles only via token freshness", () => {
    // A nested bash is indistinguishable by comm; the token rule decides.
    expect(classifyPane(facts({ readyToken: "9.333", recordedToken: "" }))).toBe("idle");
  });
});

describe("sessionDisplayName", () => {
  it("slugs and suffixes", () => {
    expect(sessionDisplayName("LHC Console Build", "abcdef1234")).toBe("lhc-console-build-abcdef");
  });
  it("empty label falls back", () => {
    expect(sessionDisplayName("", "abcdef1234")).toBe("term-abcdef");
  });
  it("caps slug length", () => {
    const name = sessionDisplayName("x".repeat(100), "abcdef1234");
    expect(name.length).toBeLessThanOrEqual(32 + 7);
  });
});

describe("frameIsStale", () => {
  it("first frame is never stale", () => {
    expect(frameIsStale({ epoch: 1, revision: 1 }, null)).toBe(false);
  });
  it("newer epoch always adopted", () => {
    expect(frameIsStale({ epoch: 2, revision: 1 }, { epoch: 1, revision: 99 })).toBe(false);
  });
  it("older epoch rejected", () => {
    expect(frameIsStale({ epoch: 1, revision: 100 }, { epoch: 2, revision: 1 })).toBe(true);
  });
  it("same epoch compares revisions, equal is stale", () => {
    expect(frameIsStale({ epoch: 2, revision: 5 }, { epoch: 2, revision: 5 })).toBe(true);
    expect(frameIsStale({ epoch: 2, revision: 6 }, { epoch: 2, revision: 5 })).toBe(false);
  });
});

describe("advanceRekey", () => {
  const a = { hostId: "cc-lhc", threadId: "th_a", source: "argv" as const };
  const aReg = { hostId: "cc-lhc", threadId: "th_a", source: "registry" as const };
  const b = { hostId: "cc-lhc", threadId: "th_b", source: "argv" as const };
  it("commits after two agreeing scans", () => {
    const s1 = advanceRekey(null, a);
    expect(s1.commit).toBeNull();
    const s2 = advanceRekey(s1.pending, a);
    expect(s2.commit).toEqual(a);
    expect(s2.pending).toBeNull();
  });
  it("argv + registry corroboration commits immediately on the second scan", () => {
    const s1 = advanceRekey(null, a);
    const s2 = advanceRekey(s1.pending, aReg);
    expect(s2.commit).toEqual(aReg);
  });
  it("a different candidate restarts the count", () => {
    const s1 = advanceRekey(null, a);
    const s2 = advanceRekey(s1.pending, b);
    expect(s2.commit).toBeNull();
    expect(s2.pending?.candidate).toEqual(b);
    expect(s2.pending?.scans).toBe(1);
  });
  it("nothing observed clears pending", () => {
    const s1 = advanceRekey(null, a);
    expect(advanceRekey(s1.pending, null)).toEqual({ pending: null, commit: null });
  });
});

describe("reconcile", () => {
  const cat = (uuid: string) => ({
    uuid,
    threadRef: { hostId: "cc-lhc", threadId: "th_x", title: null },
    kind: "thread",
  });
  const live = (uuid: string | null, sessionId: string, over: object = {}) => ({
    uuid,
    sessionId,
    owner: uuid !== null,
    state: "idle" as const,
    threadFromOptions: null,
    ...over,
  });
  it("binds known live sessions", () => {
    const acts = reconcile([cat("u1")], [live("u1", "$3")]);
    expect(acts).toContainEqual({ kind: "bind", uuid: "u1", sessionId: "$3", state: "idle" });
  });
  it("tombstones catalog entries without sessions", () => {
    expect(reconcile([cat("u1")], [])).toContainEqual({ kind: "tombstone", uuid: "u1" });
  });
  it("adopts marked sessions missing from the catalog", () => {
    expect(reconcile([], [live("u2", "$4")])).toContainEqual({
      kind: "adopt",
      sessionId: "$4",
      uuid: "u2",
    });
  });
  it("unmarked sessions are foreign, never adopted", () => {
    expect(reconcile([], [live(null, "$5")])).toContainEqual({ kind: "foreign", sessionId: "$5" });
  });
  it("two sessions claiming one thread → conflict", () => {
    const t = { hostId: "cc-lhc", threadId: "th_dup" };
    const acts = reconcile(
      [],
      [live("u1", "$1", { threadFromOptions: t }), live("u2", "$2", { threadFromOptions: t })],
    );
    const conflict = acts.find((a) => a.kind === "conflict");
    expect(conflict).toEqual({ kind: "conflict", threadKey: "cc-lhc/th_dup", uuids: ["u1", "u2"] });
  });
});

describe("admissionBlocked", () => {
  it("counts running and busy, not idle/dead", () => {
    const r = admissionBlocked(["running", "busy", "idle", "dead", "idle"], 8);
    expect(r).toEqual({ blocked: false, counted: 2 });
  });
  it("blocks at the cap", () => {
    expect(admissionBlocked(Array(8).fill("running"), 8).blocked).toBe(true);
  });
});
