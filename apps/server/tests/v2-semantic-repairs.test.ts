import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { AgentRecord } from "../src/agent-registry.ts";
import { CodexLhcAdapter } from "../src/v2/adapters/codex-lhc.ts";
import { FakeProviderAdapter } from "../src/v2/adapters/fake.ts";
import { LHC_HANDOFF_QUIESCE_COMMAND, PiLhcAdapter } from "../src/v2/adapters/pi-lhc.ts";
import { MemoryJsonlPair } from "../src/v2/jsonl-transport.ts";
import { RuntimeManager } from "../src/v2/manager.ts";
import { acquireTerminalWriterLock } from "../src/v2/ownership.ts";
import { TEST_ONLY_OWNER_POLICIES, testOnlyOwnerPolicies } from "../src/v2/policies.ts";
import { V2Store } from "../src/v2/store.ts";
import {
  isWriterLockHeld,
  releaseWriterLock,
  tryAcquireWriterLock,
} from "../src/v2/writer-lock.ts";
import { resolveWriterResource } from "../src/v2/identity.ts";

const dirs: string[] = [];
const managers: RuntimeManager[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function agent(id = "fable"): AgentRecord {
  return {
    id,
    name: id,
    description: id,
    duties: [],
    ownerSenderIds: ["owner"],
    mentionPatterns: [id],
    health: { hostId: "pi-lhc", threadId: "th_canonical" },
    channels: {},
    relay: {
      hostId: "pi-lhc",
      threadId: "sess-alias",
      cwd: "/tmp",
      command: "true",
      args: [],
    },
    v2: { provider: "pi-lhc" },
  };
}

function attachPi(pair: MemoryJsonlPair, handle?: (message: Record<string, unknown>) => boolean) {
  pair.server.onLine((line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    if (handle?.(message)) return;
    if (message.type === "get_state") {
      pair.server.send({
        id: message.id,
        type: "response",
        command: "get_state",
        success: true,
        data: { sessionId: "pi-sess", isStreaming: false },
      });
      return;
    }
    if (message.type === "get_entries") {
      pair.server.send({
        id: message.id,
        type: "response",
        command: "get_entries",
        success: true,
        data: {
          entries: [
            { type: "custom", customType: "pi-lhc.thread", data: { threadId: "th_canonical" } },
          ],
          leafId: null,
        },
      });
      return;
    }
    if (message.type === "get_commands") {
      pair.server.send({
        id: message.id,
        type: "response",
        command: "get_commands",
        success: true,
        data: { commands: [{ name: LHC_HANDOFF_QUIESCE_COMMAND }] },
      });
      return;
    }
    if (message.type === "set_steering_mode") {
      pair.server.send({
        id: message.id,
        type: "response",
        command: "set_steering_mode",
        success: true,
      });
    }
  });
}

describe("semantic repair: RPC request/generation correlation", () => {
  it("correlates a prompt to the RPC request id and runtime generation when agent_start omits runId", async () => {
    const pair = new MemoryJsonlPair();
    let promptId: string | undefined;
    attachPi(pair, (message) => {
      if (message.type === "prompt") {
        promptId = String(message.id);
        pair.server.send({ id: message.id, type: "response", command: "prompt", success: true });
        pair.server.send({ type: "agent_start" });
        pair.server.send({ type: "message_start", role: "assistant", text: "ok" });
        pair.server.send({ type: "agent_settled" });
        return true;
      }
      return false;
    });
    const adapter = new PiLhcAdapter({ transport: pair.client });
    const events: Array<{ type: string; nativeTurnId?: string }> = [];
    adapter.on((event) => events.push(event));
    await adapter.start({
      hostThreadId: "sess-alias",
      canonicalThreadId: "th_canonical",
      cwd: "/tmp",
      approvalPolicy: "bypass-at-spawn",
      runtimeGeneration: 7,
    });
    const native = await adapter.startTurn("hello");
    expect(promptId).toBeTruthy();
    expect(native).toContain(String(promptId));
    expect(native).toContain("7");
    expect(native).not.toMatch(/^pi-run-/);
    expect(
      events.some((event) => event.type === "turnStarted" && event.nativeTurnId === native),
    ).toBe(true);
  });
});

describe("semantic repair: crash-atomic transitions", () => {
  it("keeps an uncorrelated in-flight turn indeterminate instead of resetting to idle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-atomic-"));
    dirs.push(dir);
    const record = agent();
    const adapter = new FakeProviderAdapter({
      provider: "pi-lhc",
      scripts: [{ waitForInterrupt: true, items: [{ type: "agent_message", text: "partial" }] }],
    });
    adapter.startTurn = async () => {
      throw new Error("dispatch lost after send");
    };
    const store = new V2Store({ dbPath: join(dir, "v2.sqlite") });
    const manager = new RuntimeManager({
      store,
      consoleHome: dir,
      agents: [record],
      policies: testOnlyOwnerPolicies(TEST_ONLY_OWNER_POLICIES),
      adapterFactory: () => adapter,
    });
    managers.push(manager);
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
    expect(receipt.state).toBe("indeterminate");
    expect(manager.status("fable").state).not.toBe("idle");
    expect(manager.getCommand("turn-1")?.dispatchState).toBe("sending");
  });

  it("stops a spawned child before releasing the fence when runtime.start fails after spawn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-start-rollback-"));
    dirs.push(dir);
    const record = agent();
    let stopped = false;
    const adapter = new FakeProviderAdapter({ provider: "pi-lhc" });
    adapter.start = async () => {
      throw new Error("confirm exploded after spawn");
    };
    const originalStop = adapter.stop.bind(adapter);
    adapter.stop = async (mode) => {
      stopped = true;
      return originalStop(mode);
    };
    const store = new V2Store({ dbPath: join(dir, "v2.sqlite") });
    const manager = new RuntimeManager({
      store,
      consoleHome: dir,
      agents: [record],
      policies: testOnlyOwnerPolicies(TEST_ONLY_OWNER_POLICIES),
      adapterFactory: () => adapter,
    });
    managers.push(manager);
    const receipt = await manager.submit({
      target: "fable",
      commandId: "start-1",
      kind: "runtime.start",
      params: {},
    });
    expect(receipt.state).toBe("rejected");
    expect(stopped).toBe(true);
    const resource = resolveWriterResource(record);
    expect(isWriterLockHeld(dir, resource.key)).toBe(false);
    expect(store.getOwnerResource(resource.key)?.ownerKind).toBe("none");
  });

  it("keeps runtime.stop indeterminate when drain settlement is not observed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-stop-indet-"));
    dirs.push(dir);
    const record = agent();
    const adapter = new FakeProviderAdapter({
      provider: "pi-lhc",
      scripts: [{ waitForInterrupt: true, items: [{ type: "agent_message", text: "partial" }] }],
    });
    adapter.stop = async () => {
      throw new Error("kill settlement lost");
    };
    const store = new V2Store({ dbPath: join(dir, "v2.sqlite") });
    const manager = new RuntimeManager({
      store,
      consoleHome: dir,
      agents: [record],
      policies: testOnlyOwnerPolicies(TEST_ONLY_OWNER_POLICIES),
      adapterFactory: () => adapter,
    });
    managers.push(manager);
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
      params: { text: "hello" },
    });
    const stop = await manager.submit({
      target: "fable",
      commandId: "stop-1",
      kind: "runtime.stop",
      params: { mode: "kill" },
    });
    expect(stop.state).toBe("indeterminate");
    expect(manager.getCommand("stop-1")?.receipt).toBe("indeterminate");
  });
});

describe("semantic repair: writer fence and V1 noninterference", () => {
  it("does not acquire a terminal writer lock when V2 is disabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-term-off-"));
    dirs.push(dir);
    const previous = process.env.LHC_CONSOLE_V2;
    delete process.env.LHC_CONSOLE_V2;
    try {
      const held = acquireTerminalWriterLock("pi-lhc", "th_canonical", dir);
      expect(held).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.LHC_CONSOLE_V2;
      else process.env.LHC_CONSOLE_V2 = previous;
    }
  });

  it("does not fence a V1-only terminal resource when V2 is enabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-term-v1only-"));
    dirs.push(dir);
    const previous = process.env.LHC_CONSOLE_V2;
    process.env.LHC_CONSOLE_V2 = "1";
    try {
      const held = acquireTerminalWriterLock("pi-lhc", "th_unrelated", dir);
      expect(held).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.LHC_CONSOLE_V2;
      else process.env.LHC_CONSOLE_V2 = previous;
    }
  });

  it("writes pid and start metadata atomically on acquire", () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-pid-meta-"));
    dirs.push(dir);
    const resource = resolveWriterResource(agent());
    const held = tryAcquireWriterLock(dir, resource);
    expect(held.ok).toBe(true);
    expect(held.held?.ownerPid).toBe(process.pid);
    expect(held.held?.ownerStartedAt).toMatch(/^\d{4}-/);
    if (held.held) releaseWriterLock(held.held);
  });
});

describe("semantic repair: restart respects a live writer", () => {
  it("does not complete a turn while the writer process is still alive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-restart-live-"));
    dirs.push(dir);
    const record = agent();
    const store = new V2Store({ dbPath: join(dir, "v2.sqlite") });
    const manager = new RuntimeManager({
      store,
      consoleHome: dir,
      agents: [record],
      policies: testOnlyOwnerPolicies(TEST_ONLY_OWNER_POLICIES),
      adapterFactory: () =>
        new FakeProviderAdapter({
          provider: "pi-lhc",
          scripts: [
            { waitForInterrupt: true, items: [{ type: "agent_message", text: "partial" }] },
          ],
        }),
    });
    managers.push(manager);
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
      params: { text: "hello" },
    });
    const turnId = manager.status("fable").currentTurn?.turnId;
    expect(turnId).toBeTruthy();
    manager.reconcile("fable");
    expect(manager.status("fable").state).toBe("unknown");
    expect(manager.status("fable").currentTurn?.turnId).toBe(turnId);
    expect(
      manager
        .eventsAfter("fable", 0)
        .some((event) => event.kind === "turn.completed" && event.turnId === turnId),
    ).toBe(false);
    expect(manager.getCommand("turn-1")?.receipt).toBe("applied");
  });

  it("never replays a sending command and supersedes not_sent after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-restart-dispatch-"));
    dirs.push(dir);
    const record = agent();
    const store = new V2Store({ dbPath: join(dir, "v2.sqlite") });
    const manager = new RuntimeManager({
      store,
      consoleHome: dir,
      agents: [record],
      policies: testOnlyOwnerPolicies(TEST_ONLY_OWNER_POLICIES),
      adapterFactory: () => new FakeProviderAdapter({ provider: "pi-lhc" }),
    });
    managers.push(manager);
    await manager.submit({
      target: "fable",
      commandId: "start-1",
      kind: "runtime.start",
      params: {},
    });
    const now = new Date().toISOString();
    store.insertCommand({
      commandId: "queued-not-sent",
      target: "fable",
      kind: "turn.followUp",
      paramsJson: JSON.stringify({ text: "later", afterTurnId: "t_open" }),
      receipt: "accepted",
      reason: null,
      dispatchState: "not_sent",
      runtimeGeneration: 1,
      nativeTurnId: null,
      providerResponseId: null,
      effectStage: null,
      turnId: null,
      expectedTurnId: null,
      afterTurnId: "t_open",
      message: null,
      acceptedAt: now,
      updatedAt: now,
    });
    store.insertCommand({
      commandId: "sending-uncorrelated",
      target: "fable",
      kind: "turn.steer",
      paramsJson: JSON.stringify({ text: "nudge", expectedTurnId: "t_open" }),
      receipt: "accepted",
      reason: null,
      dispatchState: "sending",
      runtimeGeneration: 1,
      nativeTurnId: null,
      providerResponseId: null,
      effectStage: "queued",
      turnId: "t_open",
      expectedTurnId: "t_open",
      afterTurnId: null,
      message: null,
      acceptedAt: now,
      updatedAt: now,
    });
    manager.reconcile("fable");
    // not_sent commands stay accepted for re-dispatch (proven not dispatched)
    expect(manager.getCommand("queued-not-sent")?.receipt).toBe("accepted");
    expect(manager.getCommand("queued-not-sent")?.dispatchState).toBe("not_sent");
    expect(manager.getCommand("sending-uncorrelated")?.receipt).toBe("indeterminate");
    expect(manager.getCommand("sending-uncorrelated")?.dispatchState).toBe("sending");
  });
});

describe("semantic repair: exact steer correlation", () => {
  it("does not consume the oldest queued steer from an unrelated user message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-steer-corr-"));
    dirs.push(dir);
    const record = agent();
    const adapter = new FakeProviderAdapter({
      provider: "pi-lhc",
      scripts: [{ waitForInterrupt: true, items: [{ type: "agent_message", text: "partial" }] }],
    });
    adapter.steer = async () => "ok";
    const store = new V2Store({ dbPath: join(dir, "v2.sqlite") });
    const manager = new RuntimeManager({
      store,
      consoleHome: dir,
      agents: [record],
      policies: testOnlyOwnerPolicies(TEST_ONLY_OWNER_POLICIES),
      adapterFactory: () => adapter,
    });
    managers.push(manager);
    await manager.submit({
      target: "fable",
      commandId: "start-1",
      kind: "runtime.start",
      params: {},
    });
    const started = await manager.submit({
      target: "fable",
      commandId: "turn-1",
      kind: "turn.start",
      params: { text: "hello" },
    });
    const turnId = manager.getCommand(started.commandId)?.turnId;
    expect(turnId).toBeTruthy();
    await manager.submit({
      target: "fable",
      commandId: "steer-old",
      kind: "turn.steer",
      params: { text: "first", expectedTurnId: turnId },
    });
    await manager.submit({
      target: "fable",
      commandId: "steer-new",
      kind: "turn.steer",
      params: { text: "second", expectedTurnId: turnId },
    });
    adapter.emitNotification({
      type: "steerConsumed",
      nativeTurnId: manager.status("fable").currentTurn?.nativeTurnId ?? "",
      providerResponseId: "unrelated-user-message",
      evidence: { source: "message_start", text: "unrelated" },
    });
    expect(manager.getCommand("steer-old")?.effectStage).toBe("queued");
    expect(manager.getCommand("steer-new")?.effectStage).toBe("queued");
  });

  it("consumes only the Pi steer whose RPC request id matches", async () => {
    const pair = new MemoryJsonlPair();
    let steerId: string | undefined;
    attachPi(pair, (message) => {
      if (message.type === "prompt") {
        pair.server.send({ id: message.id, type: "response", command: "prompt", success: true });
        pair.server.send({ type: "agent_start" });
        return true;
      }
      if (message.type === "steer") {
        steerId = String(message.id);
        pair.server.send({ id: message.id, type: "response", command: "steer", success: true });
        pair.server.send({
          type: "message_start",
          role: "user",
          text: message.message,
          requestId: message.id,
        });
        return true;
      }
      return false;
    });
    const adapter = new PiLhcAdapter({ transport: pair.client });
    const events: Array<{ type: string; providerResponseId?: string }> = [];
    adapter.on((event) => events.push(event));
    await adapter.start({
      hostThreadId: "sess-alias",
      canonicalThreadId: "th_canonical",
      cwd: "/tmp",
      approvalPolicy: "bypass-at-spawn",
      runtimeGeneration: 1,
    });
    const native = await adapter.startTurn("hello");
    await expect(adapter.steer(native, "nudge")).resolves.toBe("ok");
    const consumed = events.find((event) => event.type === "steerConsumed");
    expect(consumed?.providerResponseId).toBe(steerId);
    expect(events.some((event) => event.type === "steerQueued")).toBe(true);
  });
});

describe("semantic repair: production handoff unsupported", () => {
  it("rejects handoff.request and handoff.release as unsupported in this slice", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-no-handoff-"));
    dirs.push(dir);
    const record = agent();
    const store = new V2Store({ dbPath: join(dir, "v2.sqlite") });
    const manager = new RuntimeManager({
      store,
      consoleHome: dir,
      agents: [record],
      policies: testOnlyOwnerPolicies(TEST_ONLY_OWNER_POLICIES),
      adapterFactory: () => new FakeProviderAdapter({ provider: "pi-lhc", quiesceOk: true }),
      inspectCanonical: async () => ({ closed: true, span: { source: "test" } }),
    });
    managers.push(manager);
    await manager.submit({
      target: "fable",
      commandId: "start-1",
      kind: "runtime.start",
      params: {},
    });
    const request = await manager.submit({
      target: "fable",
      commandId: "handoff-1",
      kind: "handoff.request",
      params: { mode: "drain", launch: "command-only" },
    });
    expect(request.state).toBe("rejected");
    expect(request.reason).toBe("unsupported");
    expect(request.message).toMatch(/not supported|this slice/i);
    expect(manager.status("fable").state).toBe("idle");
    const release = await manager.submit({
      target: "fable",
      commandId: "handoff-2",
      kind: "handoff.release",
      params: {},
    });
    expect(release.state).toBe("rejected");
    expect(release.reason).toBe("unsupported");
  });

  it("refuses Codex start until the native session maps to the configured canonical thread", async () => {
    const pair = new MemoryJsonlPair();
    pair.server.onLine((line) => {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (message.method === "initialize") {
        pair.server.send({ id: message.id, result: { userAgent: "fixture" } });
      } else if (message.method === "thread/resume") {
        pair.server.send({ id: message.id, result: { thread: { id: "sess-other" } } });
      }
    });
    const adapter = new CodexLhcAdapter({ transport: pair.client });
    await expect(
      adapter.start({
        hostThreadId: "sess-1",
        canonicalThreadId: "th_codex",
        cwd: "/tmp",
        approvalPolicy: "bypass-at-spawn",
        proveCanonicalSession: async () => false,
      }),
    ).rejects.toThrow(/canonical LHC thread|does not map/);
  });
});
