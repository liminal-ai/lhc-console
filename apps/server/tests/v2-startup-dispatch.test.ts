import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { AgentRecord } from "../src/agent-registry.ts";
import { FakeProviderAdapter } from "../src/v2/adapters/fake.ts";
import { RuntimeManager } from "../src/v2/manager.ts";
import { TEST_ONLY_OWNER_POLICIES, testOnlyOwnerPolicies } from "../src/v2/policies.ts";
import { V2Store } from "../src/v2/store.ts";

const dirs: string[] = [];
const managers: RuntimeManager[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function agent(id: string, canonical: string): AgentRecord {
  return {
    id,
    name: id,
    description: id,
    duties: [],
    ownerSenderIds: ["owner"],
    mentionPatterns: [id],
    health: { hostId: "pi-lhc", threadId: canonical },
    channels: {},
    relay: {
      hostId: "pi-lhc",
      threadId: `${id}-sess`,
      cwd: "/tmp",
      command: "true",
      args: [],
    },
    v2: { provider: "pi-lhc" },
  };
}

/**
 * A command the previous console durably accepted and then died before
 * applying. `acceptedAt` is deliberately identical across rows so acceptance
 * order can only come from insertion order, not from timestamp comparison.
 */
function acceptPending(
  store: V2Store,
  target: string,
  commandId: string,
  kind: string,
  params: Record<string, unknown>,
  dispatchState: "not_sent" | "sending" = "not_sent",
): void {
  const at = "2026-08-18T00:00:00.000Z";
  store.insertCommand({
    commandId,
    target,
    kind: kind as never,
    paramsJson: JSON.stringify(params),
    receipt: "accepted",
    reason: null,
    dispatchState,
    runtimeGeneration: null,
    nativeTurnId: null,
    providerResponseId: null,
    effectStage: null,
    turnId: null,
    expectedTurnId: null,
    afterTurnId: null,
    message: null,
    acceptedAt: at,
    updatedAt: at,
  });
}

function bootManager(
  dir: string,
  records: AgentRecord[],
  adapters: Map<string, FakeProviderAdapter>,
): { manager: RuntimeManager; store: V2Store } {
  const store = new V2Store({ dbPath: join(dir, "v2.sqlite") });
  const manager = new RuntimeManager({
    store,
    consoleHome: dir,
    agents: records,
    policies: testOnlyOwnerPolicies(TEST_ONLY_OWNER_POLICIES),
    adapterFactory: (_provider, target) => adapters.get(target)!,
  });
  managers.push(manager);
  return { manager, store };
}

describe("startup dispatch of proven-unsent commands", () => {
  it("dispatches accepted/not_sent commands in per-target acceptance order on the reconcile path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-startup-order-"));
    dirs.push(dir);
    const record = agent("fable", "th_fable");
    const adapter = new FakeProviderAdapter({
      provider: "pi-lhc",
      scripts: [{ waitForInterrupt: true }],
    });

    const seed = new V2Store({ dbPath: join(dir, "v2.sqlite") });
    acceptPending(seed, "fable", "c1-start", "runtime.start", {});
    acceptPending(seed, "fable", "c2-first", "turn.start", { text: "first" });
    acceptPending(seed, "fable", "c3-second", "turn.start", { text: "second" });
    seed.close();

    const { manager } = bootManager(dir, [record], new Map([["fable", adapter]]));
    // The startup/reconciliation path itself dispatches — no helper call.
    await manager.reconcileAll();

    expect(manager.getCommand("c1-start")?.receipt).toBe("applied");
    expect(manager.getCommand("c2-first")?.receipt).toBe("applied");
    // Acceptance order decides which turn wins; the later one is rejected
    // explicitly rather than silently queued.
    expect(manager.getCommand("c3-second")?.receipt).toBe("rejected");
    expect(manager.getCommand("c3-second")?.reason).toBe("turn_active");

    const startTurns = adapter.calls.filter((call) => call.method === "startTurn");
    expect(startTurns).toHaveLength(1);
    expect((startTurns[0]!.args as string[])[0]).toBe("first");
  });

  it("never replays dispatch_state=sending and settles it as indeterminate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-startup-sending-"));
    dirs.push(dir);
    const record = agent("fable", "th_fable");
    const adapter = new FakeProviderAdapter({
      provider: "pi-lhc",
      scripts: [{ waitForInterrupt: true }],
    });

    const seed = new V2Store({ dbPath: join(dir, "v2.sqlite") });
    acceptPending(seed, "fable", "c1-start", "runtime.start", {});
    acceptPending(seed, "fable", "c2-inflight", "turn.start", { text: "in-flight" }, "sending");
    acceptPending(seed, "fable", "c3-unsent", "turn.start", { text: "unsent" });
    seed.close();

    const { manager, store } = bootManager(dir, [record], new Map([["fable", adapter]]));
    await manager.reconcileAll();

    const inflight = manager.getCommand("c2-inflight")!;
    expect(inflight.receipt).toBe("indeterminate");
    expect(inflight.dispatchState).toBe("sending");
    const texts = adapter.calls
      .filter((call) => call.method === "startTurn")
      .map((call) => (call.args as string[])[0]);
    expect(texts).not.toContain("in-flight");
    expect(texts).toEqual(["unsent"]);

    const receipts = store
      .listEventsAfter("fable", 0, 10_000)
      .filter((event) => event.kind === "command.receipt" && event.commandId === "c2-inflight");
    expect(receipts.some((event) => event.data.state === "indeterminate")).toBe(true);
  });

  it("is idempotent across repeated startup/reconcile passes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-startup-idempotent-"));
    dirs.push(dir);
    const record = agent("fable", "th_fable");
    const adapter = new FakeProviderAdapter({
      provider: "pi-lhc",
      scripts: [{ waitForInterrupt: true }],
    });

    const seed = new V2Store({ dbPath: join(dir, "v2.sqlite") });
    acceptPending(seed, "fable", "c1-start", "runtime.start", {});
    acceptPending(seed, "fable", "c2-turn", "turn.start", { text: "only-once" });
    seed.close();

    const { manager } = bootManager(dir, [record], new Map([["fable", adapter]]));
    await manager.reconcileAll();
    const afterFirst = {
      start: manager.getCommand("c1-start")?.receipt,
      turn: manager.getCommand("c2-turn")?.receipt,
    };
    await manager.reconcileAll();
    await manager.reconcileAll();

    expect(manager.getCommand("c1-start")?.receipt).toBe(afterFirst.start);
    expect(manager.getCommand("c2-turn")?.receipt).toBe(afterFirst.turn);
    expect(adapter.calls.filter((call) => call.method === "startTurn")).toHaveLength(1);
    expect(adapter.calls.filter((call) => call.method === "start")).toHaveLength(1);
  });

  it("keeps each target's acceptance order independent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-startup-multi-"));
    dirs.push(dir);
    const fable = agent("fable", "th_fable");
    const scribe = agent("scribe", "th_scribe");
    const adapters = new Map([
      [
        "fable",
        new FakeProviderAdapter({ provider: "pi-lhc", scripts: [{ waitForInterrupt: true }] }),
      ],
      [
        "scribe",
        new FakeProviderAdapter({ provider: "pi-lhc", scripts: [{ waitForInterrupt: true }] }),
      ],
    ]);

    const seed = new V2Store({ dbPath: join(dir, "v2.sqlite") });
    acceptPending(seed, "fable", "f1", "runtime.start", {});
    acceptPending(seed, "scribe", "s1", "runtime.start", {});
    acceptPending(seed, "fable", "f2", "turn.start", { text: "fable-first" });
    acceptPending(seed, "scribe", "s2", "turn.start", { text: "scribe-first" });
    acceptPending(seed, "fable", "f3", "turn.start", { text: "fable-second" });
    seed.close();

    const { manager } = bootManager(dir, [fable, scribe], adapters);
    await manager.reconcileAll();

    expect(
      adapters
        .get("fable")!
        .calls.filter((call) => call.method === "startTurn")
        .map((call) => (call.args as string[])[0]),
    ).toEqual(["fable-first"]);
    expect(
      adapters
        .get("scribe")!
        .calls.filter((call) => call.method === "startTurn")
        .map((call) => (call.args as string[])[0]),
    ).toEqual(["scribe-first"]);
    expect(manager.getCommand("f3")?.reason).toBe("turn_active");
  });

  it("is wired into the console boot sequence, not just callable", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");
    expect(source).toMatch(/await\s+v2Manager\.reconcileAll\(\)/);
  });
});
