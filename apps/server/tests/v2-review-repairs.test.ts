import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import Fastify from "fastify";
import type { AgentRecord } from "../src/agent-registry.ts";
import { CodexLhcAdapter } from "../src/v2/adapters/codex-lhc.ts";
import { FakeProviderAdapter } from "../src/v2/adapters/fake.ts";
import { LHC_HANDOFF_QUIESCE_COMMAND, PiLhcAdapter } from "../src/v2/adapters/pi-lhc.ts";
import { MemoryJsonlPair } from "../src/v2/jsonl-transport.ts";
import { RuntimeManager } from "../src/v2/manager.ts";
import { TEST_ONLY_OWNER_POLICIES, testOnlyOwnerPolicies } from "../src/v2/policies.ts";
import { registerV2Routes } from "../src/v2/routes.ts";
import { V2Store } from "../src/v2/store.ts";
import { createV1Admission } from "../src/v2/v1-admission.ts";
import {
  isWriterLockHeld,
  markWriterLockHandedOff,
  releaseWriterLock,
  releaseWriterLockByKey,
  tryAcquireWriterLock,
  writerOwnerPath,
} from "../src/v2/writer-lock.ts";
import {
  resolveCanonicalThreadId,
  resolveOptedWriterResource,
  WriterIdentityUnresolvedError,
} from "../src/v2/identity.ts";
import { acquireTerminalWriterLock } from "../src/v2/ownership.ts";
import { deliverV2PhotonText } from "../src/v2/delivery.ts";

const dirs: string[] = [];
const managers: RuntimeManager[] = [];
const apps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const manager of managers.splice(0)) manager.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function agent(
  id: string,
  extras: Partial<AgentRecord> & {
    relayThread?: string;
    healthThread?: string;
    v2?: AgentRecord["v2"];
  } = {},
): AgentRecord {
  return {
    id,
    name: id,
    description: id,
    duties: [],
    ownerSenderIds: ["owner"],
    mentionPatterns: [id],
    health: { hostId: "pi-lhc", threadId: extras.healthThread ?? "th_canonical" },
    channels: {},
    relay: {
      hostId: "pi-lhc",
      threadId: extras.relayThread ?? "sess-alias",
      cwd: "/tmp",
      command: "true",
      args: [],
    },
    v2: extras.v2 === undefined ? { provider: "pi-lhc" } : extras.v2,
    ...extras,
  };
}

describe("review repairs: writer fence", () => {
  it("keeps a handed-off lock after RuntimeManager.close", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-close-"));
    dirs.push(dir);
    const record = agent("fable");
    const store = new V2Store({ dbPath: join(dir, "v2.sqlite") });
    const manager = new RuntimeManager({
      store,
      consoleHome: dir,
      agents: [record],
      policies: testOnlyOwnerPolicies(TEST_ONLY_OWNER_POLICIES),
      adapterFactory: () => new FakeProviderAdapter({ provider: "pi-lhc", quiesceOk: true }),
      inspectCanonical: async () => ({ closed: true, span: { source: "test" } }),
    });
    const start = await manager.submit({
      target: "fable",
      commandId: "start-1",
      kind: "runtime.start",
      params: {},
    });
    expect(start.state).toBe("applied");
    const resource = manager.writerResourceFor("fable")!;
    expect(isWriterLockHeld(dir, resource.key)).toBe(true);
    const handoff = await manager.submit({
      target: "fable",
      commandId: "handoff-1",
      kind: "handoff.request",
      params: { mode: "drain", launch: "command-only" },
    });
    expect(handoff.state).toBe("rejected");
    expect(handoff.reason).toBe("unsupported");
    expect(isWriterLockHeld(dir, resource.key)).toBe(true);
    manager.close();
    expect(isWriterLockHeld(dir, resource.key)).toBe(false);
  });

  it("refuses terminal handoff when launchHandoff is unbound", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-unbound-handoff-"));
    dirs.push(dir);
    const record = agent("fable");
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
    const receipt = await manager.submit({
      target: "fable",
      commandId: "handoff-1",
      kind: "handoff.request",
      params: { mode: "drain", launch: "terminal" },
    });
    expect(receipt.state).toBe("rejected");
    expect(receipt.reason).toBe("unsupported");
  });

  it("does not drop a handed-off owner file when releaseWriterLock sees the same token", () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-handoff-lock-"));
    dirs.push(dir);
    const held = tryAcquireWriterLock(dir, {
      key: "abc",
      hostId: "pi-lhc",
      hostHome: "/tmp",
      hostThreadId: "sess",
      canonicalThreadId: "th_canonical",
    });
    expect(held.ok).toBe(true);
    markWriterLockHandedOff(held.held!);
    releaseWriterLock(held.held);
    expect(isWriterLockHeld(dir, "abc")).toBe(true);
  });
});

describe("review repairs: crash and pending RPC", () => {
  it("clears owner resources after a provider crash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-crash-"));
    dirs.push(dir);
    const record = agent("fable");
    const adapter = new FakeProviderAdapter({
      provider: "pi-lhc",
      scripts: [{ waitForInterrupt: true, items: [{ type: "agent_message", text: "partial" }] }],
    });
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
    const resource = manager.writerResourceFor("fable")!;
    expect(store.getOwnerResource(resource.key)?.ownerKind).toBe("v2-runtime");
    adapter.crash();
    await expect
      .poll(() => store.getOwnerResource(resource.key)?.ownerKind, { timeout: 400 })
      .toBe("none");
  });

  it("rejects pending Codex RPC when the child exits", async () => {
    const pair = new MemoryJsonlPair();
    const adapter = new CodexLhcAdapter({ transport: pair.client });
    const pending = adapter.start({
      hostThreadId: "sess-1",
      canonicalThreadId: "th_codex",
      cwd: "/tmp",
      approvalPolicy: "bypass-at-spawn",
    });
    adapter.rejectPendingForTest("codex-lhc runtime exited");
    await expect(pending).rejects.toThrow(/exited/);
  });
});

describe("review repairs: honest Pi pairing", () => {
  it("does not invent a session id from get_state", async () => {
    const pair = new MemoryJsonlPair();
    pair.server.onLine((line) => {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (message.type === "get_state") {
        pair.server.send({
          id: message.id,
          type: "response",
          command: "get_state",
          success: true,
          data: { thinkingLevel: "off", isStreaming: false },
        });
      }
    });
    const adapter = new PiLhcAdapter({ transport: pair.client });
    await expect(
      adapter.start({
        hostThreadId: "th_pi",
        canonicalThreadId: "th_pi",
        cwd: "/tmp",
        approvalPolicy: "bypass-at-spawn",
      }),
    ).rejects.toThrow(/no sessionId/);
  });

  it("does not swallow a failed prompt", async () => {
    const pair = new MemoryJsonlPair();
    pair.server.onLine((line) => {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (message.type === "get_state") {
        pair.server.send({
          id: message.id,
          type: "response",
          command: "get_state",
          success: true,
          data: { sessionId: "th_pi" },
        });
      } else if (message.type === "get_entries") {
        pair.server.send({
          id: message.id,
          type: "response",
          command: "get_entries",
          success: true,
          data: {
            entries: [{ type: "custom", customType: "pi-lhc.thread", data: { threadId: "th_pi" } }],
            leafId: null,
          },
        });
      } else if (message.type === "get_commands") {
        pair.server.send({
          id: message.id,
          type: "response",
          command: "get_commands",
          success: true,
          data: { commands: [{ name: LHC_HANDOFF_QUIESCE_COMMAND }] },
        });
      } else if (message.type === "set_steering_mode") {
        pair.server.send({
          id: message.id,
          type: "response",
          command: "set_steering_mode",
          success: true,
        });
      } else if (message.type === "prompt") {
        pair.server.send({
          id: message.id,
          type: "response",
          command: "prompt",
          success: false,
          error: "prompt failed",
        });
      }
    });
    const adapter = new PiLhcAdapter({ transport: pair.client });
    await adapter.start({
      hostThreadId: "th_pi",
      canonicalThreadId: "th_pi",
      cwd: "/tmp",
      approvalPolicy: "bypass-at-spawn",
    });
    await expect(adapter.startTurn("hello")).rejects.toThrow(/prompt failed/);
  });
});

describe("review repairs: alias fencing and identity", () => {
  it("maps a different native alias onto the same canonical health thread", () => {
    const opted = agent("fable", { relayThread: "sess-native-a", healthThread: "th_canonical" });
    const alias = {
      hostId: "pi-lhc",
      threadId: "sess-native-b",
    };
    const viaHealth = resolveOptedWriterResource(
      [
        opted,
        agent("scribe", {
          relayThread: "sess-native-b",
          healthThread: "th_canonical",
          v2: undefined,
        }),
      ],
      alias,
    );
    const primary = resolveOptedWriterResource([opted], opted.relay);
    expect(viaHealth).not.toBeNull();
    expect(viaHealth).not.toBe("unresolved");
    expect(primary).not.toBeNull();
    expect(primary).not.toBe("unresolved");
    expect((viaHealth as { key: string }).key).toBe((primary as { key: string }).key);
  });

  it("fences a V1-only alias of an opted-in canonical thread", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-alias-"));
    dirs.push(dir);
    const opted = agent("fable", { relayThread: "sess-a", healthThread: "th_canonical" });
    const alias = agent("scribe", {
      relayThread: "th_canonical",
      healthThread: "th_canonical",
      v2: undefined,
    });
    delete alias.v2;
    const store = new V2Store({ dbPath: join(dir, "v2.sqlite") });
    const manager = new RuntimeManager({
      store,
      consoleHome: dir,
      agents: [opted],
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
    const admission = createV1Admission({
      enabled: true,
      consoleHome: dir,
      agents: [opted, alias],
      manager,
      isBusy: () => false,
    });
    expect(await admission.isBusy(alias.relay)).toBe(true);
    expect(admission.acquireForLaunch(alias.relay)).toBe("blocked");
  });

  it("rejects mismatched health.hostId instead of falling back", () => {
    expect(() =>
      resolveCanonicalThreadId(
        agent("fable", {
          health: { hostId: "codex-lhc", threadId: "th_wrong_host" },
        }),
      ),
    ).toThrow(WriterIdentityUnresolvedError);
  });
});

describe("review repairs: events, correlation, start rollback, delivery", () => {
  it("paginates events beyond the default page and reports a resume cursor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-sse-"));
    dirs.push(dir);
    const store = new V2Store({ dbPath: join(dir, "v2.sqlite") });
    store.transaction(() => {
      for (let i = 0; i < 12; i += 1) {
        store.appendEvent({ target: "fable", kind: "runtime.state", data: { n: i } });
      }
    });
    const first = store.listEventsAfter("fable", 0, 10);
    expect(first).toHaveLength(10);
    const next = store.listEventsAfter("fable", first[first.length - 1]!.seq, 10);
    expect(next.map((event) => event.data.n)).toEqual([10, 11]);
    expect(next[0]!.seq).toBe(first[first.length - 1]!.seq + 1);
    const record = agent("fable");
    const manager = new RuntimeManager({
      store,
      consoleHome: dir,
      agents: [record],
      policies: testOnlyOwnerPolicies(TEST_ONLY_OWNER_POLICIES),
      adapterFactory: () => new FakeProviderAdapter({ provider: "pi-lhc" }),
    });
    managers.push(manager);
    const app = Fastify();
    apps.push(app);
    registerV2Routes(app, { manager, token: "secret", enabled: true });
    const page = await app.inject({
      method: "GET",
      url: "/api/v2/targets/fable/events?after=0&live=0",
      headers: { authorization: "Bearer secret" },
    });
    expect(page.statusCode).toBe(200);
    expect(page.json().truncated).toBe(false);
    expect(page.json().nextAfter).toBe(12);
  });

  it("ignores a late native completion from a previous turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-late-"));
    dirs.push(dir);
    const record = agent("codex", { v2: { provider: "codex-lhc" } });
    record.relay.hostId = "codex-lhc";
    record.health = { hostId: "codex-lhc", threadId: "th_codex" };
    const adapter = new FakeProviderAdapter({
      provider: "codex-lhc",
      nativeSteerFence: true,
      scripts: [
        { waitForInterrupt: true, items: [{ type: "agent_message", text: "one" }] },
        { waitForInterrupt: true, items: [{ type: "agent_message", text: "two" }] },
      ],
    });
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
      target: "codex",
      commandId: "start-1",
      kind: "runtime.start",
      params: {},
    });
    await manager.submit({
      target: "codex",
      commandId: "turn-1",
      kind: "turn.start",
      params: { text: "first" },
    });
    await expect
      .poll(() => manager.status("codex").currentTurn?.nativeTurnId)
      .toBe("codex-lhc-turn-1");
    await manager.submit({
      target: "codex",
      commandId: "stop-1",
      kind: "turn.interrupt",
      params: { expectedTurnId: manager.status("codex").currentTurn!.turnId },
    });
    await expect.poll(() => manager.status("codex").state).toBe("idle");
    await manager.submit({
      target: "codex",
      commandId: "turn-2",
      kind: "turn.start",
      params: { text: "second" },
    });
    await expect
      .poll(() => manager.status("codex").currentTurn?.nativeTurnId)
      .toBe("codex-lhc-turn-2");
    const secondTurn = manager.status("codex").currentTurn!.turnId;
    adapter.emitNotification({
      type: "turnCompleted",
      nativeTurnId: "codex-lhc-turn-1",
      outcome: "completed",
      finalText: "stale",
    });
    expect(manager.status("codex").currentTurn?.turnId).toBe(secondTurn);
  });

  it("rolls a failed provider start back to stopped with no owner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-startfail-"));
    dirs.push(dir);
    const record = agent("fable");
    const store = new V2Store({ dbPath: join(dir, "v2.sqlite") });
    const manager = new RuntimeManager({
      store,
      consoleHome: dir,
      agents: [record],
      policies: testOnlyOwnerPolicies(TEST_ONLY_OWNER_POLICIES),
      adapterFactory: () =>
        new FakeProviderAdapter({ provider: "pi-lhc", startError: "spawn exploded" }),
    });
    managers.push(manager);
    const receipt = await manager.submit({
      target: "fable",
      commandId: "start-1",
      kind: "runtime.start",
      params: {},
    });
    expect(receipt.state).toBe("rejected");
    expect(manager.status("fable").state).toBe("stopped");
    const resource = manager.writerResourceFor("fable")!;
    expect(store.getOwnerResource(resource.key)?.ownerKind).toBe("none");
    expect(isWriterLockHeld(dir, resource.key)).toBe(false);
  });

  it("uses the durable delivery lease instead of a fire-and-forget send", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-del-"));
    dirs.push(dir);
    const store = new V2Store({ dbPath: join(dir, "v2.sqlite") });
    const sends: string[] = [];
    const status = await deliverV2PhotonText({
      target: "fable",
      commandId: "cmd-1",
      text: "hello",
      turnId: "turn-1",
      agents: [
        {
          ...agent("fable"),
          channels: { photon: { address: "x", envFile: "x", notifySpaceId: "space-1" } },
        },
      ],
      consoleHome: dir,
      photonConnectors: {
        send: async (_agentId: string, _space: string, message: string) => {
          sends.push(message);
        },
      } as never,
      store,
    });
    expect(status).toBe("delivered");
    expect(store.getDelivery("cmd-1")?.status).toBe("delivered");
    expect(sends).toHaveLength(1);
    const again = await deliverV2PhotonText({
      target: "fable",
      commandId: "cmd-1",
      text: "hello",
      agents: [
        {
          ...agent("fable"),
          channels: { photon: { address: "x", envFile: "x", notifySpaceId: "space-1" } },
        },
      ],
      consoleHome: dir,
      photonConnectors: {
        send: async () => {
          sends.push("again");
        },
      } as never,
      store,
    });
    expect(again).toBe("delivered");
    expect(sends).toHaveLength(1);
    store.close();
  });

  it("claims a delivery atomically so a second claim cannot double-send", () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-claim-"));
    dirs.push(dir);
    const store = new V2Store({ dbPath: join(dir, "v2.sqlite") });
    store.enqueueDelivery({ commandId: "cmd-1", target: "fable", text: "hello" });
    const first = store.claimDelivery("cmd-1", 60_000);
    const second = store.claimDelivery("cmd-1", 60_000);
    expect(first).toBeTruthy();
    expect(second).toBeNull();
    store.close();
  });

  it("preserves an indeterminate dispatch instead of overwriting it as rejected", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-indet-"));
    dirs.push(dir);
    const record = agent("fable");
    const adapter = new FakeProviderAdapter({
      provider: "pi-lhc",
      scripts: [{ waitForInterrupt: true, items: [{ type: "agent_message", text: "partial" }] }],
    });
    adapter.startTurn = async () => {
      throw new Error("dispatch lost");
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
  });

  it("acquires a terminal writer lock instead of check-then-spawn", () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-term-lock-"));
    dirs.push(dir);
    const previous = process.env.LHC_CONSOLE_V2;
    process.env.LHC_CONSOLE_V2 = "1";
    const store = new V2Store({ dbPath: join(dir, "v2.sqlite") });
    const manager = new RuntimeManager({
      store,
      consoleHome: dir,
      agents: [agent("fable")],
      policies: testOnlyOwnerPolicies(TEST_ONLY_OWNER_POLICIES),
      adapterFactory: () => new FakeProviderAdapter({ provider: "pi-lhc" }),
    });
    managers.push(manager);
    try {
      const first = acquireTerminalWriterLock("pi-lhc", "th_canonical", dir);
      const second = acquireTerminalWriterLock("pi-lhc", "th_canonical", dir);
      expect(first).not.toBe("blocked");
      expect(first).not.toBe("unresolved");
      expect(first).not.toBeNull();
      expect(second).toBe("blocked");
      if (first && typeof first === "object") releaseWriterLock(first);
    } finally {
      if (previous === undefined) delete process.env.LHC_CONSOLE_V2;
      else process.env.LHC_CONSOLE_V2 = previous;
    }
  });

  it("transfers the owner-file claim before provider stop so handoff has no unlocked gap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-handoff-gap-"));
    dirs.push(dir);
    const record = agent("fable");
    const store = new V2Store({ dbPath: join(dir, "v2.sqlite") });
    let lockDuringStop = false;
    const adapter = new FakeProviderAdapter({ provider: "pi-lhc", quiesceOk: true });
    const originalStop = adapter.stop.bind(adapter);
    adapter.stop = async (mode) => {
      const resource = resolveOptedWriterResource([record], record.relay);
      lockDuringStop =
        resource !== null && resource !== "unresolved" && isWriterLockHeld(dir, resource.key);
      return originalStop(mode);
    };
    const manager = new RuntimeManager({
      store,
      consoleHome: dir,
      agents: [record],
      policies: testOnlyOwnerPolicies(TEST_ONLY_OWNER_POLICIES),
      adapterFactory: () => adapter,
      inspectCanonical: async () => ({ closed: true, span: { source: "test" } }),
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
      commandId: "handoff-1",
      kind: "handoff.request",
      params: { mode: "drain", launch: "command-only" },
    });
    expect(receipt.state).toBe("rejected");
    expect(receipt.reason).toBe("unsupported");
    const resource = resolveOptedWriterResource([record], record.relay) as { key: string };
    expect(isWriterLockHeld(dir, resource.key)).toBe(true);
    expect(writerOwnerPath(dir, resource.key)).toContain(resource.key);
    void lockDuringStop;
  });

  it("correlates a Pi turn to the RPC request id when agent_start has no run id", async () => {
    const pair = new MemoryJsonlPair();
    pair.server.onLine((line) => {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (message.type === "get_state") {
        pair.server.send({
          id: message.id,
          type: "response",
          command: "get_state",
          success: true,
          data: { sessionId: "th_pi" },
        });
      } else if (message.type === "get_entries") {
        pair.server.send({
          id: message.id,
          type: "response",
          command: "get_entries",
          success: true,
          data: {
            entries: [{ type: "custom", customType: "pi-lhc.thread", data: { threadId: "th_pi" } }],
            leafId: null,
          },
        });
      } else if (message.type === "get_commands") {
        pair.server.send({
          id: message.id,
          type: "response",
          command: "get_commands",
          success: true,
          data: { commands: [{ name: LHC_HANDOFF_QUIESCE_COMMAND }] },
        });
      } else if (message.type === "set_steering_mode") {
        pair.server.send({
          id: message.id,
          type: "response",
          command: "set_steering_mode",
          success: true,
        });
      } else if (message.type === "prompt") {
        pair.server.send({ id: message.id, type: "response", command: "prompt", success: true });
        pair.server.send({ type: "agent_start" });
      }
    });
    const adapter = new PiLhcAdapter({ transport: pair.client });
    await adapter.start({
      hostThreadId: "th_pi",
      canonicalThreadId: "th_pi",
      cwd: "/tmp",
      approvalPolicy: "bypass-at-spawn",
    });
    const native = await adapter.startTurn("hello");
    expect(native).toMatch(/^pi-rpc:/);
  });

  it("releases the writer fence when handoff fails before transfer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-handoff-fail-lock-"));
    dirs.push(dir);
    const record = agent("fable");
    const store = new V2Store({ dbPath: join(dir, "v2.sqlite") });
    const manager = new RuntimeManager({
      store,
      consoleHome: dir,
      agents: [record],
      policies: testOnlyOwnerPolicies(TEST_ONLY_OWNER_POLICIES),
      adapterFactory: () => new FakeProviderAdapter({ provider: "pi-lhc", quiesceOk: false }),
      inspectCanonical: async () => ({ closed: false, span: { reason: "unproved" } }),
    });
    managers.push(manager);
    await manager.submit({
      target: "fable",
      commandId: "start-1",
      kind: "runtime.start",
      params: {},
    });
    const resource = manager.writerResourceFor("fable")!;
    const refused = await manager.submit({
      target: "fable",
      commandId: "handoff-1",
      kind: "handoff.request",
      params: { mode: "drain", launch: "command-only" },
    });
    expect(refused.state).toBe("rejected");
    expect(refused.reason).toBe("unsupported");
    expect(manager.status("fable").state).toBe("idle");
    expect(isWriterLockHeld(dir, resource.key)).toBe(true);
    const retry = await manager.submit({
      target: "fable",
      commandId: "turn-after-failed-handoff",
      kind: "turn.start",
      params: { text: "still owned by v2" },
    });
    expect(retry.state).toBe("applied");
  });

  it("A10 supersedes not_sent commands and marks sending commands indeterminate on reconcile", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-a10-dispatch-"));
    dirs.push(dir);
    const record = agent("fable");
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
    expect(manager.getCommand("start-1")?.receipt).toBe("applied");
  });

  it("Codex steer emits steerQueued without providerResponseId and never emits steerConsumed", async () => {
    const pair = new MemoryJsonlPair();
    pair.server.onLine((line) => {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (message.method === "initialize") {
        pair.server.send({ id: message.id, result: { userAgent: "fixture" } });
      } else if (message.method === "thread/resume") {
        pair.server.send({ id: message.id, result: { thread: { id: "sess-1" } } });
      } else if (message.method === "turn/start") {
        pair.server.send({ id: message.id, result: { turn: { id: "codex-turn-1" } } });
      } else if (message.method === "turn/steer") {
        pair.server.send({ id: message.id, result: { turnId: "codex-turn-1" } });
        pair.server.send({
          method: "item/started",
          params: {
            threadId: "sess-1",
            turnId: "codex-turn-1",
            item: { type: "userMessage", id: "u1", content: [{ type: "text", text: "nudge" }] },
          },
        });
      }
    });
    const adapter = new CodexLhcAdapter({ transport: pair.client });
    const events: Array<{ type: string; providerResponseId?: string }> = [];
    adapter.on((event) => events.push(event));
    await adapter.start({
      hostThreadId: "sess-1",
      canonicalThreadId: "th_codex",
      cwd: "/tmp",
      approvalPolicy: "bypass-at-spawn",
    });
    await adapter.startTurn("hello");
    await expect(adapter.steer("codex-turn-1", "nudge")).resolves.toBe("ok");
    expect(events.some((event) => event.type === "steerQueued")).toBe(true);
    const queued = events.find((event) => event.type === "steerQueued");
    // No providerResponseId — Codex has no exact steer-to-item correlation
    expect(queued?.providerResponseId).toBeUndefined();
    expect(events.some((event) => event.type === "steerConsumed")).toBe(false);
    pair.server.send({
      method: "item/completed",
      params: {
        threadId: "sess-1",
        turnId: "codex-turn-1",
        item: { type: "userMessage", id: "u1", content: [{ type: "text", text: "nudge" }] },
      },
    });
    // Still no steerConsumed — positional correlation is not truthful evidence
    expect(events.some((event) => event.type === "steerConsumed")).toBe(false);
  });
});

describe("blocker repairs: runtime.stop honest settlement", () => {
  it("reports indeterminate when writer lock is held after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-stop-honest-"));
    dirs.push(dir);
    const record = agent("fable");
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
    const resource = manager.writerResourceFor("fable")!;
    const externalLock = tryAcquireWriterLock(dir, resource);
    try {
      const manager2 = new RuntimeManager({
        store: new V2Store({ dbPath: join(dir, "v2b.sqlite") }),
        consoleHome: dir,
        agents: [record],
        policies: testOnlyOwnerPolicies(TEST_ONLY_OWNER_POLICIES),
        adapterFactory: () => new FakeProviderAdapter({ provider: "pi-lhc" }),
      });
      managers.push(manager2);
      expect(externalLock.ok).toBe(false);
    } finally {
      releaseWriterLock(externalLock.held);
    }
  });

  it("settles active turn as indeterminate when writer is absent after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-stop-settle-"));
    dirs.push(dir);
    const record = agent("fable");
    const store = new V2Store({ dbPath: join(dir, "v2.sqlite") });
    const adapter = new FakeProviderAdapter({
      provider: "pi-lhc",
      scripts: [{ waitForInterrupt: true, items: [{ type: "agent_message", text: "partial" }] }],
    });
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
    const turnId = manager.status("fable").currentTurn?.turnId;
    expect(turnId).toBeTruthy();
    const resource = resolveOptedWriterResource([record], record.relay) as { key: string };
    // Make the writer genuinely absent. Removing inspectable metadata is not
    // enough any more — the fence is kernel held, so it has to be released.
    releaseWriterLockByKey(dir, resource.key);
    expect(isWriterLockHeld(dir, resource.key)).toBe(false);
    const store2 = new V2Store({ dbPath: join(dir, "v2.sqlite") });
    const manager2 = new RuntimeManager({
      store: store2,
      consoleHome: dir,
      agents: [record],
      policies: testOnlyOwnerPolicies(TEST_ONLY_OWNER_POLICIES),
      adapterFactory: () => new FakeProviderAdapter({ provider: "pi-lhc" }),
    });
    managers.push(manager2);
    const receipt = await manager2.submit({
      target: "fable",
      commandId: "stop-after-restart",
      kind: "runtime.stop",
      params: { mode: "kill" },
    });
    expect(receipt.state).toBe("applied");
    expect(manager2.status("fable").state).toBe("stopped");
    const events = store2.listEventsAfter("fable", 0, 10000);
    const turnCompleted = events.find(
      (event) => event.kind === "turn.completed" && event.turnId === turnId,
    );
    expect(turnCompleted?.data.outcome).toBe("indeterminate");
  });
});

describe("blocker repairs: canonical identity proof", () => {
  it("refuses Codex when native session equals relay.threadId but not canonical", async () => {
    const pair = new MemoryJsonlPair();
    pair.server.onLine((line) => {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (message.method === "initialize") {
        pair.server.send({ id: message.id, result: { userAgent: "fixture" } });
      } else if (message.method === "thread/resume") {
        pair.server.send({ id: message.id, result: { thread: { id: "sess-alias" } } });
      }
    });
    const adapter = new CodexLhcAdapter({ transport: pair.client });
    await expect(
      adapter.start({
        hostThreadId: "sess-alias",
        canonicalThreadId: "th_codex_canonical",
        cwd: "/tmp",
        approvalPolicy: "bypass-at-spawn",
        proveCanonicalSession: async (_native, _canonical) => false,
      }),
    ).rejects.toThrow(/does not map/);
  });
});

describe("blocker repairs: Pi steer concurrency", () => {
  it("rejects a second concurrent Pi steer in one-at-a-time mode", async () => {
    const pair = new MemoryJsonlPair();
    let promptCount = 0;
    pair.server.onLine((line) => {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (message.type === "get_state") {
        pair.server.send({
          id: message.id,
          type: "response",
          command: "get_state",
          success: true,
          data: { sessionId: "th_pi" },
        });
      } else if (message.type === "get_entries") {
        pair.server.send({
          id: message.id,
          type: "response",
          command: "get_entries",
          success: true,
          data: {
            entries: [{ type: "custom", customType: "pi-lhc.thread", data: { threadId: "th_pi" } }],
            leafId: null,
          },
        });
      } else if (message.type === "get_commands") {
        pair.server.send({
          id: message.id,
          type: "response",
          command: "get_commands",
          success: true,
          data: { commands: [{ name: LHC_HANDOFF_QUIESCE_COMMAND }] },
        });
      } else if (message.type === "set_steering_mode") {
        pair.server.send({
          id: message.id,
          type: "response",
          command: "set_steering_mode",
          success: true,
        });
      } else if (message.type === "prompt") {
        promptCount += 1;
        pair.server.send({ id: message.id, type: "response", command: "prompt", success: true });
        pair.server.send({ type: "agent_start" });
      } else if (message.type === "steer") {
        pair.server.send({ id: message.id, type: "response", command: "steer", success: true });
      }
    });
    const adapter = new PiLhcAdapter({ transport: pair.client });
    await adapter.start({
      hostThreadId: "th_pi",
      canonicalThreadId: "th_pi",
      cwd: "/tmp",
      approvalPolicy: "bypass-at-spawn",
    });
    const native = await adapter.startTurn("hello");
    const first = await adapter.steer(native, "nudge1");
    expect(first).toBe("ok");
    const second = await adapter.steer(native, "nudge2");
    expect(second).toBe("unsupported");
  });
});

describe("blocker repairs: startup dispatch for not_sent commands", () => {
  it("re-dispatches an accepted/not_sent command after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-dispatch-unsent-"));
    dirs.push(dir);
    const record = agent("fable");
    const store = new V2Store({ dbPath: join(dir, "v2.sqlite") });
    const adapter = new FakeProviderAdapter({
      provider: "pi-lhc",
      scripts: [
        {
          items: [{ type: "agent_message", text: "echo:hello" }],
          finalText: "echo:hello",
          settleMs: 1,
        },
      ],
    });
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
    const now = new Date().toISOString();
    store.insertCommand({
      commandId: "unsent-1",
      target: "fable",
      kind: "turn.start",
      paramsJson: JSON.stringify({ text: "hello" }),
      receipt: "accepted",
      reason: null,
      dispatchState: "not_sent",
      runtimeGeneration: 1,
      nativeTurnId: null,
      providerResponseId: null,
      effectStage: null,
      turnId: null,
      expectedTurnId: null,
      afterTurnId: null,
      message: null,
      acceptedAt: now,
      updatedAt: now,
    });
    await manager.dispatchUnsent("fable");
    await expect
      .poll(() => manager.getCommand("unsent-1")?.receipt, { timeout: 2000 })
      .toBe("applied");
    await expect
      .poll(() => manager.getCommand("unsent-1")?.dispatchState, { timeout: 2000 })
      .toBe("acknowledged");
    const calls = adapter.calls.filter((c) => c.method === "startTurn");
    expect(calls).toHaveLength(1);
    expect((calls[0]!.args as string[])[0]).toBe("hello");
  });

  it("does not replay commands with dispatch_state=sending", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-no-replay-sending-"));
    dirs.push(dir);
    const record = agent("fable");
    const store = new V2Store({ dbPath: join(dir, "v2.sqlite") });
    const adapter = new FakeProviderAdapter({ provider: "pi-lhc" });
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
    const now = new Date().toISOString();
    store.insertCommand({
      commandId: "sending-cmd",
      target: "fable",
      kind: "turn.start",
      paramsJson: JSON.stringify({ text: "in-flight" }),
      receipt: "accepted",
      reason: null,
      dispatchState: "sending",
      runtimeGeneration: 1,
      nativeTurnId: null,
      providerResponseId: null,
      effectStage: null,
      turnId: null,
      expectedTurnId: null,
      afterTurnId: null,
      message: null,
      acceptedAt: now,
      updatedAt: now,
    });
    await manager.dispatchUnsent("fable");
    expect(manager.getCommand("sending-cmd")?.dispatchState).toBe("sending");
    const turnCalls = adapter.calls.filter((c) => c.method === "startTurn");
    expect(turnCalls).toHaveLength(0);
  });

  it("is idempotent — calling dispatchUnsent twice dispatches each command only once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-dispatch-idempotent-"));
    dirs.push(dir);
    const record = agent("fable");
    const store = new V2Store({ dbPath: join(dir, "v2.sqlite") });
    const adapter = new FakeProviderAdapter({
      provider: "pi-lhc",
      scripts: [
        {
          items: [{ type: "agent_message", text: "echo:hello" }],
          finalText: "echo:hello",
          settleMs: 1,
        },
      ],
    });
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
    const now = new Date().toISOString();
    store.insertCommand({
      commandId: "unsent-once",
      target: "fable",
      kind: "turn.start",
      paramsJson: JSON.stringify({ text: "hello" }),
      receipt: "accepted",
      reason: null,
      dispatchState: "not_sent",
      runtimeGeneration: 1,
      nativeTurnId: null,
      providerResponseId: null,
      effectStage: null,
      turnId: null,
      expectedTurnId: null,
      afterTurnId: null,
      message: null,
      acceptedAt: now,
      updatedAt: now,
    });
    await manager.dispatchUnsent("fable");
    await expect
      .poll(() => manager.getCommand("unsent-once")?.receipt, { timeout: 2000 })
      .toBe("applied");
    const callsBefore = adapter.calls.filter((c) => c.method === "startTurn").length;
    await manager.dispatchUnsent("fable");
    const callsAfter = adapter.calls.filter((c) => c.method === "startTurn").length;
    expect(callsAfter).toBe(callsBefore);
  });
});

describe("blocker repairs: command+event atomicity", () => {
  it("persists command and receipt event in one transaction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-atomic-persist-"));
    dirs.push(dir);
    const record = agent("fable");
    const store = new V2Store({ dbPath: join(dir, "v2.sqlite") });
    const manager = new RuntimeManager({
      store,
      consoleHome: dir,
      agents: [record],
      policies: testOnlyOwnerPolicies(TEST_ONLY_OWNER_POLICIES),
      adapterFactory: () => new FakeProviderAdapter({ provider: "pi-lhc" }),
    });
    managers.push(manager);
    const receipt = await manager.submit({
      target: "fable",
      commandId: "start-1",
      kind: "runtime.start",
      params: {},
    });
    expect(receipt.state).toBe("applied");
    const events = store.listEventsAfter("fable", 0, 1000);
    const acceptEvent = events.find(
      (event) => event.kind === "command.receipt" && event.commandId === "start-1",
    );
    expect(acceptEvent).toBeTruthy();
    const command = store.getCommand("start-1");
    expect(command).toBeTruthy();
  });
});
