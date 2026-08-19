import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { AgentRecord } from "../src/agent-registry.ts";
import { PROVIDER_CAPABILITIES } from "../src/v2/adapter.ts";
import { CodexLhcAdapter } from "../src/v2/adapters/codex-lhc.ts";
import { FakeProviderAdapter } from "../src/v2/adapters/fake.ts";
import { LHC_HANDOFF_QUIESCE_COMMAND, PiLhcAdapter } from "../src/v2/adapters/pi-lhc.ts";
import { MemoryJsonlPair } from "../src/v2/jsonl-transport.ts";
import { RuntimeManager } from "../src/v2/manager.ts";
import { TEST_ONLY_OWNER_POLICIES, testOnlyOwnerPolicies } from "../src/v2/policies.ts";
import { V2Store } from "../src/v2/store.ts";

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
    relay: { hostId: "pi-lhc", threadId: "sess-alias", cwd: "/tmp", command: "true", args: [] },
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

/**
 * Drive one Pi steer and return the adapter events, with the steer's user
 * `message_start` shaped by `decorate`. Only a top-level `requestId` equal to
 * the steer RPC request id may ever count as consumption evidence.
 */
async function steerWith(
  decorate: (steerRequestId: string, text: string) => Record<string, unknown>,
): Promise<Array<{ type: string; providerResponseId?: string }>> {
  const pair = new MemoryJsonlPair();
  attachPi(pair, (message) => {
    if (message.type === "prompt") {
      pair.server.send({ id: message.id, type: "response", command: "prompt", success: true });
      pair.server.send({ type: "agent_start" });
      return true;
    }
    if (message.type === "steer") {
      pair.server.send({ id: message.id, type: "response", command: "steer", success: true });
      pair.server.send(decorate(String(message.id), String(message.message)));
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
  return events;
}

describe("Pi steer consumption requires the real requestId field", () => {
  it("consumes when the wire carries requestId equal to the steer request id", async () => {
    const events = await steerWith((id, text) => ({
      type: "message_start",
      role: "user",
      text,
      requestId: id,
    }));
    expect(events.some((event) => event.type === "steerConsumed")).toBe(true);
  });

  it("does not consume from a top-level id that merely equals the steer request id", async () => {
    const events = await steerWith((id, text) => ({
      type: "message_start",
      role: "user",
      text,
      id,
    }));
    expect(events.some((event) => event.type === "steerQueued")).toBe(true);
    expect(events.some((event) => event.type === "steerConsumed")).toBe(false);
  });

  it("does not consume from a requestId nested on the message object", async () => {
    const events = await steerWith((id, text) => ({
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text }], requestId: id },
    }));
    expect(events.some((event) => event.type === "steerQueued")).toBe(true);
    expect(events.some((event) => event.type === "steerConsumed")).toBe(false);
  });

  it("does not consume from a different requestId", async () => {
    const events = await steerWith((_id, text) => ({
      type: "message_start",
      role: "user",
      text,
      requestId: "some-other-request",
    }));
    expect(events.some((event) => event.type === "steerConsumed")).toBe(false);
  });
});

describe("steer consumption capability is reported honestly", () => {
  it("declares consumption unproven for both real providers", () => {
    // The upstream Pi RPC `message_start` event carries only `{type, message}`
    // (packages/agent AgentEvent), and Codex reports no consumption evidence
    // either. Neither may be advertised as proving consumption.
    expect(PROVIDER_CAPABILITIES["pi-lhc"].steerConsumption).toBe("unsupported");
    expect(PROVIDER_CAPABILITIES["codex-lhc"].steerConsumption).toBe("unsupported");
    expect(new PiLhcAdapter().capabilities.steerConsumption).toBe("unsupported");
    expect(new CodexLhcAdapter().capabilities.steerConsumption).toBe("unsupported");
  });

  it("surfaces the capability in target status", () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-steer-cap-"));
    dirs.push(dir);
    const store = new V2Store({ dbPath: join(dir, "v2.sqlite") });
    const manager = new RuntimeManager({
      store,
      consoleHome: dir,
      agents: [agent()],
      policies: testOnlyOwnerPolicies(TEST_ONLY_OWNER_POLICIES),
      adapterFactory: () => new FakeProviderAdapter({ provider: "pi-lhc" }),
    });
    managers.push(manager);
    expect(manager.status("fable").capabilities.steerConsumption).toBe("unsupported");
  });

  it("ignores a steerConsumed notification from a provider that cannot prove it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-steer-guard-"));
    dirs.push(dir);
    const store = new V2Store({ dbPath: join(dir, "v2.sqlite") });
    const adapter = new FakeProviderAdapter({
      provider: "pi-lhc",
      scripts: [{ waitForInterrupt: true }],
      steerConsumption: "unsupported",
    });
    const manager = new RuntimeManager({
      store,
      consoleHome: dir,
      agents: [agent()],
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
    await manager.submit({
      target: "fable",
      commandId: "steer-1",
      kind: "turn.steer",
      params: { text: "nudge", expectedTurnId: turnId },
    });
    // The fake emits steerConsumed, but a provider whose capability says the
    // evidence is unprovable must never move the effect stage to consumed.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(manager.getCommand("steer-1")?.effectStage).toBe("queued");
  });

  it("settles an unprovable steer as not_consumed with an explicit reason", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-steer-settle-"));
    dirs.push(dir);
    const store = new V2Store({ dbPath: join(dir, "v2.sqlite") });
    const adapter = new FakeProviderAdapter({
      provider: "pi-lhc",
      scripts: [{ settleMs: 40, finalText: "done" }],
      steerConsumption: "unsupported",
    });
    const manager = new RuntimeManager({
      store,
      consoleHome: dir,
      agents: [agent()],
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
    await manager.submit({
      target: "fable",
      commandId: "steer-1",
      kind: "turn.steer",
      params: { text: "nudge", expectedTurnId: turnId },
    });
    await expect
      .poll(() => manager.getCommand("steer-1")?.effectStage, { timeout: 2000 })
      .toBe("not_consumed");
    const effect = store
      .listEventsAfter("fable", 0, 10_000)
      .find((event) => event.kind === "command.effect" && event.commandId === "steer-1");
    // "not consumed" must not be read as proof the message was dropped.
    expect(effect?.data.reason).toBe("consumption_evidence_unsupported");
  });
});
