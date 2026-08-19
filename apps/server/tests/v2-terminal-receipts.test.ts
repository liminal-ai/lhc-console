import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { AgentRecord } from "../src/agent-registry.ts";
import { FakeProviderAdapter, type FakeAdapterOptions } from "../src/v2/adapters/fake.ts";
import { RuntimeManager } from "../src/v2/manager.ts";
import { TEST_ONLY_OWNER_POLICIES, testOnlyOwnerPolicies } from "../src/v2/policies.ts";
import { V2Store } from "../src/v2/store.ts";
import { isWriterLockHeld } from "../src/v2/writer-lock.ts";
import type { V2Event } from "../src/v2/contract.ts";

const dirs: string[] = [];
const managers: RuntimeManager[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function agent(id: string): AgentRecord {
  return {
    id,
    name: id,
    description: id,
    duties: [],
    ownerSenderIds: ["owner"],
    mentionPatterns: [id],
    health: { hostId: "pi-lhc", threadId: "th_canonical" },
    channels: {},
    relay: { hostId: "pi-lhc", threadId: "sess", cwd: "/tmp", command: "true", args: [] },
    v2: { provider: "pi-lhc" },
  };
}

function boot(prefix: string, options: FakeAdapterOptions) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  const store = new V2Store({ dbPath: join(dir, "v2.sqlite") });
  const adapter = new FakeProviderAdapter(options);
  const manager = new RuntimeManager({
    store,
    consoleHome: dir,
    agents: [agent("fable")],
    policies: testOnlyOwnerPolicies(TEST_ONLY_OWNER_POLICIES),
    adapterFactory: () => adapter,
  });
  managers.push(manager);
  return { dir, store, adapter, manager };
}

function events(store: V2Store): V2Event[] {
  return store.listEventsAfter("fable", 0, 10_000);
}

function receiptEvents(store: V2Store, commandId: string): V2Event[] {
  return events(store).filter(
    (event) => event.kind === "command.receipt" && event.commandId === commandId,
  );
}

function lastRuntimeState(store: V2Store): string | undefined {
  const runtimeEvents = events(store).filter((event) => event.kind === "runtime.state");
  return runtimeEvents.at(-1)?.data.state as string | undefined;
}

describe("terminal transitions carry their receipt event", () => {
  it("turn.start provider failure is indeterminate and emits both receipt and runtime events", async () => {
    const { store, manager } = boot("lhc-v2-turnstart-fail-", {
      provider: "pi-lhc",
      startTurnError: "provider socket closed mid-send",
    });
    await manager.submit({
      target: "fable",
      commandId: "start-1",
      kind: "runtime.start",
      params: {},
    });
    const receipt = await manager.submit({
      target: "fable",
      commandId: "turn-1",
      kind: "turn.start",
      params: { text: "hello" },
    });

    // The command crossed the dispatch boundary, so it cannot be called
    // rejected — the provider may have started the turn.
    expect(receipt.state).toBe("indeterminate");
    expect(manager.getCommand("turn-1")?.dispatchState).toBe("sending");

    const terminal = receiptEvents(store, "turn-1").filter(
      (event) => event.data.state === "indeterminate",
    );
    expect(terminal).toHaveLength(1);

    // The runtime is exposed as `unknown`; that must be readable from events.
    expect(manager.status("fable").state).toBe("unknown");
    expect(lastRuntimeState(store)).toBe("unknown");
  });

  it("interrupt failure stays indeterminate rather than rejected, with a correlated event", async () => {
    const { store, manager } = boot("lhc-v2-interrupt-fail-", {
      provider: "pi-lhc",
      scripts: [{ waitForInterrupt: true }],
      interruptError: "abort channel closed",
    });
    await manager.submit({
      target: "fable",
      commandId: "start-1",
      kind: "runtime.start",
      params: {},
    });
    await manager.submit({
      target: "fable",
      commandId: "turn-1",
      kind: "turn.start",
      params: { text: "long" },
    });
    const turnId = manager.status("fable").currentTurn?.turnId;
    expect(turnId).toBeTruthy();

    const receipt = await manager.submit({
      target: "fable",
      commandId: "int-1",
      kind: "turn.interrupt",
      params: { expectedTurnId: turnId },
    });

    expect(receipt.state).toBe("indeterminate");
    expect(receiptEvents(store, "int-1").some((e) => e.data.state === "indeterminate")).toBe(true);
    // No terminal claim about the turn may be invented from a failed interrupt.
    expect(
      events(store).some((event) => event.kind === "turn.completed" && event.turnId === turnId),
    ).toBe(false);
  });

  it("runtime.start failure reports the stopped runtime through an event", async () => {
    const { store, manager } = boot("lhc-v2-start-fail-", {
      provider: "pi-lhc",
      startError: "pi-lhc RPC launcher unavailable",
    });
    const receipt = await manager.submit({
      target: "fable",
      commandId: "start-1",
      kind: "runtime.start",
      params: {},
    });
    expect(receipt.state).toBe("rejected");
    expect(manager.status("fable").state).toBe("stopped");
    // The state a client can read must be reachable by replaying events.
    expect(lastRuntimeState(store)).toBe("stopped");
  });

  it("runtime.stop failure exposes unknown only together with its events", async () => {
    const { store, manager } = boot("lhc-v2-stop-fail-", {
      provider: "pi-lhc",
      stopError: "provider stop channel died",
    });
    await manager.submit({
      target: "fable",
      commandId: "start-1",
      kind: "runtime.start",
      params: {},
    });
    const receipt = await manager.submit({
      target: "fable",
      commandId: "stop-1",
      kind: "runtime.stop",
      params: { mode: "kill" },
    });
    expect(receipt.state).toBe("indeterminate");
    expect(manager.status("fable").state).toBe("unknown");
    expect(lastRuntimeState(store)).toBe("unknown");
    expect(receiptEvents(store, "stop-1").some((e) => e.data.state === "indeterminate")).toBe(true);
  });

  it("keeps the fence and stays indeterminate when a failed start cannot prove its writer is gone", async () => {
    const { dir, store, manager } = boot("lhc-v2-start-unproven-", {
      provider: "pi-lhc",
      startError: "thread attach refused",
      stopError: "kill failed",
    });
    const receipt = await manager.submit({
      target: "fable",
      commandId: "start-1",
      kind: "runtime.start",
      params: {},
    });
    // The console spawned something and could not kill it: rejecting here
    // would invite a second writer onto the same canonical thread.
    expect(receipt.state).toBe("indeterminate");
    expect(manager.status("fable").state).toBe("unknown");
    expect(lastRuntimeState(store)).toBe("unknown");
    const resource = manager.writerResourceFor("fable")!;
    expect(isWriterLockHeld(dir, resource.key)).toBe(true);
  });

  it("keeps status and the runtime.state event log agreeing across a failure sequence", async () => {
    const { store, manager } = boot("lhc-v2-state-agree-", {
      provider: "pi-lhc",
      scripts: [{ settleMs: 20, finalText: "done" }],
    });
    await manager.submit({
      target: "fable",
      commandId: "start-1",
      kind: "runtime.start",
      params: {},
    });
    await manager.submit({
      target: "fable",
      commandId: "turn-1",
      kind: "turn.start",
      params: { text: "long" },
    });
    await manager.submit({
      target: "fable",
      commandId: "stop-1",
      kind: "runtime.stop",
      params: { mode: "drain" },
    });
    // `draining` is externally visible mid-stop; it must appear in the log.
    const states = events(store)
      .filter((event) => event.kind === "runtime.state")
      .map((event) => event.data.state);
    expect(states).toContain("draining");
    expect(states.at(-1)).toBe(manager.status("fable").state);
  });
});
