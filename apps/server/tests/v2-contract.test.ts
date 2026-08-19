import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import Fastify from "fastify";
import type { AgentRecord } from "../src/agent-registry.ts";
import { FakeProviderAdapter } from "../src/v2/adapters/fake.ts";
import type { V2Provider } from "../src/v2/contract.ts";
import { RuntimeManager } from "../src/v2/manager.ts";
import { TEST_ONLY_OWNER_POLICIES, testOnlyOwnerPolicies } from "../src/v2/policies.ts";
import { registerV2Routes } from "../src/v2/routes.ts";
import { V2Store } from "../src/v2/store.ts";

const dirs: string[] = [];
const managers: RuntimeManager[] = [];
const apps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const manager of managers.splice(0)) manager.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function agent(provider: V2Provider, id = provider === "codex-lhc" ? "codex" : "pi"): AgentRecord {
  const threadId = provider === "codex-lhc" ? "sess-codex" : "th_pi_canonical";
  return {
    id,
    name: id,
    description: `${provider} test agent`,
    duties: [],
    ownerSenderIds: ["owner"],
    mentionPatterns: [`\\b${id}\\b`],
    health: { hostId: provider, threadId: provider === "pi-lhc" ? threadId : "th_codex_canonical" },
    channels: {},
    relay: {
      hostId: provider,
      threadId,
      cwd: "/tmp",
      command: provider,
      args: [],
    },
    v2: { provider },
  };
}

function setup(
  provider: V2Provider,
  extras: { adapters?: Map<string, FakeProviderAdapter>; waitForInterrupt?: boolean } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), `lhc-v2-${provider}-`));
  dirs.push(dir);
  const record = agent(provider);
  const adapters = extras.adapters ?? new Map<string, FakeProviderAdapter>();
  const store = new V2Store({ dbPath: join(dir, "v2.sqlite") });
  const manager = new RuntimeManager({
    store,
    consoleHome: dir,
    agents: [record],
    policies: testOnlyOwnerPolicies(TEST_ONLY_OWNER_POLICIES),
    adapterFactory: (kind) => {
      const existing = adapters.get(kind);
      if (existing) return existing;
      const created = new FakeProviderAdapter({
        provider: kind,
        nativeSteerFence: kind === "codex-lhc",
        scripts:
          extras.waitForInterrupt === false
            ? undefined
            : [{ waitForInterrupt: true, items: [{ type: "agent_message", text: "partial" }] }],
      });
      adapters.set(kind, created);
      return created;
    },
  });
  managers.push(manager);
  return { manager, record, adapters, dir };
}

async function startRuntime(manager: RuntimeManager, target: string) {
  return manager.submit({
    target,
    commandId: randomUUID(),
    kind: "runtime.start",
    params: {},
  });
}

describe.each([
  { provider: "codex-lhc" as const, native: true },
  { provider: "pi-lhc" as const, native: false },
])("V2 contract via $provider fake adapter", ({ provider }) => {
  it("A1 ordinary turn emits started/item/completed with native id", async () => {
    const { manager, record, adapters } = setup(provider);
    adapters.set(
      provider,
      new FakeProviderAdapter({
        provider,
        nativeSteerFence: provider === "codex-lhc",
        scripts: [
          {
            items: [{ type: "agent_message", text: "hello from fixture" }],
            finalText: "hello from fixture",
            outcome: "completed",
          },
        ],
      }),
    );
    expect((await startRuntime(manager, record.id)).state).toBe("applied");
    const receipt = await manager.submit({
      target: record.id,
      commandId: randomUUID(),
      kind: "turn.start",
      params: { text: "hello", delivery: "photon" },
    });
    expect(receipt.state).toBe("applied");
    expect(receipt.nativeTurnId).toMatch(new RegExp(`${provider}-turn-`));
    await expect.poll(() => manager.status(record.id).state, { timeout: 500 }).toBe("idle");
    const events = manager.eventsAfter(record.id, 0);
    expect(events.some((event) => event.kind === "turn.started")).toBe(true);
    expect(events.some((event) => event.kind === "turn.item")).toBe(true);
    expect(
      events.some(
        (event) =>
          event.kind === "turn.completed" &&
          event.data.outcome === "completed" &&
          event.data.finalText,
      ),
    ).toBe(true);
  });

  it("A1 requests Photon delivery only when the originating command asked for it", async () => {
    const dir = mkdtempSync(join(tmpdir(), `lhc-v2-a1-del-${provider}-`));
    dirs.push(dir);
    const record = agent(provider);
    const delivered: string[] = [];
    const store = new V2Store({ dbPath: join(dir, "v2.sqlite") });
    const manager = new RuntimeManager({
      store,
      consoleHome: dir,
      agents: [record],
      policies: testOnlyOwnerPolicies(TEST_ONLY_OWNER_POLICIES),
      adapterFactory: (kind) =>
        new FakeProviderAdapter({
          provider: kind,
          scripts: [{ items: [{ type: "agent_message", text: "done" }], finalText: "done" }],
        }),
      deliver: async (input) => {
        delivered.push(input.commandId);
        return "delivered";
      },
    });
    managers.push(manager);
    await startRuntime(manager, record.id);
    const receipt = await manager.submit({
      target: record.id,
      commandId: randomUUID(),
      kind: "turn.start",
      params: { text: "hello", delivery: "photon" },
    });
    await expect.poll(() => manager.status(record.id).state, { timeout: 500 }).toBe("idle");
    await expect
      .poll(
        () =>
          manager
            .eventsAfter(record.id, 0)
            .some((event) => event.kind === "delivery" && event.data.status === "delivered"),
        { timeout: 500 },
      )
      .toBe(true);
    expect(delivered).toEqual([receipt.commandId]);
  });

  it("A2 start while active is rejected, not queued", async () => {
    const { manager, record } = setup(provider);
    await startRuntime(manager, record.id);
    const first = await manager.submit({
      target: record.id,
      commandId: randomUUID(),
      kind: "turn.start",
      params: { text: "one" },
    });
    expect(first.state).toBe("applied");
    const second = await manager.submit({
      target: record.id,
      commandId: randomUUID(),
      kind: "turn.start",
      params: { text: "two" },
    });
    expect(second.state).toBe("rejected");
    expect(second.reason).toBe("turn_active");
    expect(second.currentTurnId).toBe(manager.status(record.id).currentTurn?.turnId);
    expect(manager.status(record.id).currentTurn).not.toBeNull();
  });

  it("A3/A4 steer fence accepts the current turn and rejects a stale one", async () => {
    const { manager, record, adapters } = setup(provider);
    await startRuntime(manager, record.id);
    const started = await manager.submit({
      target: record.id,
      commandId: randomUUID(),
      kind: "turn.start",
      params: { text: "long" },
    });
    const turnId = manager.status(record.id).currentTurn?.turnId;
    expect(turnId).toBeTruthy();
    const stale = await manager.submit({
      target: record.id,
      commandId: randomUUID(),
      kind: "turn.steer",
      params: { text: "old", expectedTurnId: "t_stale" },
    });
    expect(stale.state).toBe("rejected");
    expect(stale.reason).toBe("turn_mismatch");
    const adapter = adapters.get(provider)!;
    expect(adapter.calls.some((call) => call.method === "steer")).toBe(false);
    const ok = await manager.submit({
      target: record.id,
      commandId: randomUUID(),
      kind: "turn.steer",
      params: { text: "nudge", expectedTurnId: turnId },
    });
    expect(ok.state).toBe("applied");
    expect(ok.effectStage).toBe("queued");
    await expect
      .poll(
        () =>
          manager
            .eventsAfter(record.id, 0)
            .some((event) => event.kind === "command.effect" && event.data.stage === "consumed"),
        { timeout: 500 },
      )
      .toBe(true);
    void started;
  });

  it("A5 follow-ups run in acceptance order after the fenced turn", async () => {
    const { manager, record, adapters } = setup(provider);
    adapters.set(
      provider,
      new FakeProviderAdapter({
        provider,
        nativeSteerFence: provider === "codex-lhc",
        scripts: [
          { items: [{ type: "agent_message", text: "one" }], finalText: "one" },
          { items: [{ type: "agent_message", text: "a" }], finalText: "a" },
          { items: [{ type: "agent_message", text: "b" }], finalText: "b" },
        ],
      }),
    );
    await startRuntime(manager, record.id);
    const first = await manager.submit({
      target: record.id,
      commandId: randomUUID(),
      kind: "turn.start",
      params: { text: "root" },
    });
    const turnId = manager.getCommand(first.commandId)?.turnId;
    expect(turnId).toBeTruthy();
    const a = await manager.submit({
      target: record.id,
      commandId: randomUUID(),
      kind: "turn.followUp",
      params: { text: "a", afterTurnId: turnId },
    });
    const b = await manager.submit({
      target: record.id,
      commandId: randomUUID(),
      kind: "turn.followUp",
      params: { text: "b", afterTurnId: turnId },
    });
    expect(a.state).toBe("applied");
    expect(b.state).toBe("applied");
    await expect.poll(() => manager.status(record.id).state, { timeout: 800 }).toBe("idle");
    const started = manager
      .eventsAfter(record.id, 0)
      .filter((event) => event.kind === "turn.started");
    expect(started.map((event) => event.data.cause)).toEqual([
      "turn.start",
      "followUp",
      "followUp",
    ]);
    expect(started[1]?.commandId).toBe(a.commandId);
    expect(started[2]?.commandId).toBe(b.commandId);
  });

  it("A6/A7 interrupt settles the active turn and rejects when idle", async () => {
    const { manager, record } = setup(provider);
    await startRuntime(manager, record.id);
    await manager.submit({
      target: record.id,
      commandId: randomUUID(),
      kind: "turn.start",
      params: { text: "long" },
    });
    const turnId = manager.status(record.id).currentTurn?.turnId;
    const interrupted = await manager.submit({
      target: record.id,
      commandId: randomUUID(),
      kind: "turn.interrupt",
      params: { expectedTurnId: turnId },
    });
    expect(interrupted.state).toBe("applied");
    await expect
      .poll(
        () =>
          manager
            .eventsAfter(record.id, 0)
            .some(
              (event) => event.kind === "turn.completed" && event.data.outcome === "interrupted",
            ),
        { timeout: 500 },
      )
      .toBe(true);
    expect(manager.status(record.id).state).toBe("idle");
    const idle = await manager.submit({
      target: record.id,
      commandId: randomUUID(),
      kind: "turn.interrupt",
      params: { expectedTurnId: turnId },
    });
    expect(idle.state).toBe("rejected");
    expect(idle.reason).toBe("no_active_turn");
  });

  it("A8 status lastEventSeq is consistent with the event log", async () => {
    const { manager, record, adapters } = setup(provider);
    adapters.set(
      provider,
      new FakeProviderAdapter({
        provider,
        scripts: [{ items: [{ type: "agent_message", text: "ok" }], finalText: "ok" }],
      }),
    );
    await startRuntime(manager, record.id);
    await manager.submit({
      target: record.id,
      commandId: randomUUID(),
      kind: "turn.start",
      params: { text: "hello" },
    });
    await expect.poll(() => manager.status(record.id).state, { timeout: 500 }).toBe("idle");
    const status = manager.status(record.id);
    const replayed = manager
      .eventsAfter(record.id, 0)
      .filter((event) => event.seq <= status.lastEventSeq);
    expect(replayed.at(-1)?.seq).toBe(status.lastEventSeq);
  });

  it("A9 replay after a live cursor returns the same retained events", async () => {
    const { manager, record } = setup(provider);
    await startRuntime(manager, record.id);
    const app = Fastify();
    apps.push(app);
    registerV2Routes(app, { manager, token: "test-secret", enabled: true });
    const replay = await app.inject({
      method: "GET",
      url: `/api/v2/targets/${record.id}/events?after=0&live=0`,
      headers: { authorization: "Bearer test-secret" },
    });
    expect(replay.statusCode).toBe(200);
    const first = replay.json().events as Array<{ seq: number }>;
    const again = await app.inject({
      method: "GET",
      url: `/api/v2/targets/${record.id}/events?after=0&live=0`,
      headers: { authorization: "Bearer test-secret" },
    });
    expect(again.json().events).toEqual(first);
  });

  it("A10 restart reconciliation does not auto-restart a runtime", async () => {
    const { manager, record } = setup(provider);
    await startRuntime(manager, record.id);
    const commandId = randomUUID();
    await manager.submit({
      target: record.id,
      commandId,
      kind: "turn.start",
      params: { text: "long" },
    });
    manager.reconcile(record.id);
    const state = manager.status(record.id).state;
    expect(["unknown", "stopped"]).toContain(state);
    expect(manager.status(record.id).runtime.generation).toBeGreaterThan(0);
  });

  it("A12 alias targets cannot take a second writer on the same canonical thread", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-alias-"));
    dirs.push(dir);
    const primary = agent(provider, "primary");
    const alias: AgentRecord = {
      ...agent(provider, "alias"),
      health: primary.health,
      relay: { ...primary.relay, threadId: `${primary.relay.threadId}-alias` },
    };
    const store = new V2Store({ dbPath: join(dir, "v2.sqlite") });
    const manager = new RuntimeManager({
      store,
      consoleHome: dir,
      agents: [primary, alias],
      policies: testOnlyOwnerPolicies(TEST_ONLY_OWNER_POLICIES),
      adapterFactory: (kind) =>
        new FakeProviderAdapter({ provider: kind, nativeSteerFence: kind === "codex-lhc" }),
    });
    managers.push(manager);
    expect((await startRuntime(manager, primary.id)).state).toBe("applied");
    const second = await manager.submit({
      target: alias.id,
      commandId: randomUUID(),
      kind: "runtime.start",
      params: {},
    });
    expect(second.state).toBe("rejected");
    expect(second.reason).toBe("writer_conflict");
    const owned = store.getRuntime(primary.id)!.writerResourceKey;
    expect(manager.ownsResource(owned)).toBe(true);
  });

  it("A15 cancel retracts a queued follow-up and refuses to interrupt the active turn", async () => {
    const { manager, record } = setup(provider, { waitForInterrupt: true });
    await startRuntime(manager, record.id);
    const started = await manager.submit({
      target: record.id,
      commandId: randomUUID(),
      kind: "turn.start",
      params: { text: "active" },
    });
    const follow = await manager.submit({
      target: record.id,
      commandId: randomUUID(),
      kind: "turn.followUp",
      params: { text: "later", afterTurnId: manager.getCommand(started.commandId)?.turnId },
    });
    const cancelled = await manager.submit({
      target: record.id,
      commandId: randomUUID(),
      kind: "command.cancel",
      params: { targetCommandId: follow.commandId },
    });
    expect(cancelled.state).toBe("applied");
    expect(manager.getCommand(follow.commandId)?.receipt).toBe("superseded");
    const activeCancel = await manager.submit({
      target: record.id,
      commandId: randomUUID(),
      kind: "command.cancel",
      params: { targetCommandId: started.commandId },
    });
    expect(activeCancel.state).toBe("rejected");
    expect(activeCancel.reason).toBe("already_dispatched");
    expect(manager.status(record.id).currentTurn).not.toBeNull();
  });

  it("Q2 detached remains selectable and is not silently implemented", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-q2-"));
    dirs.push(dir);
    const record = agent(provider);
    const store = new V2Store({ dbPath: join(dir, "v2.sqlite") });
    const manager = new RuntimeManager({
      store,
      consoleHome: dir,
      agents: [record],
      policies: testOnlyOwnerPolicies({ ...TEST_ONLY_OWNER_POLICIES, runtimeProcess: "detached" }),
      adapterFactory: (kind) => new FakeProviderAdapter({ provider: kind }),
    });
    managers.push(manager);
    const receipt = await startRuntime(manager, record.id);
    expect(receipt.state).toBe("rejected");
    expect(receipt.reason).toBe("unsupported");
  });

  it("A11 production handoff is explicitly unsupported in this slice", async () => {
    const { manager, record, adapters } = setup(provider);
    adapters.set(
      provider,
      new FakeProviderAdapter({
        provider,
        nativeSteerFence: provider === "codex-lhc",
        scripts: [{ items: [{ type: "agent_message", text: "ok" }], finalText: "ok" }],
      }),
    );
    await startRuntime(manager, record.id);
    await manager.submit({
      target: record.id,
      commandId: randomUUID(),
      kind: "turn.start",
      params: { text: "hello" },
    });
    await expect.poll(() => manager.status(record.id).state, { timeout: 500 }).toBe("idle");
    const refused = await manager.submit({
      target: record.id,
      commandId: randomUUID(),
      kind: "handoff.request",
      params: { mode: "drain", launch: "command-only" },
    });
    expect(refused.state).toBe("rejected");
    expect(refused.reason).toBe("unsupported");
  });

  it("A11 does not transfer ownership in this slice even with a proved flush", async () => {
    const dir = mkdtempSync(join(tmpdir(), `lhc-v2-a11-${provider}-`));
    dirs.push(dir);
    const record = agent(provider);
    const store = new V2Store({ dbPath: join(dir, "v2.sqlite") });
    const manager = new RuntimeManager({
      store,
      consoleHome: dir,
      agents: [record],
      policies: testOnlyOwnerPolicies(TEST_ONLY_OWNER_POLICIES),
      adapterFactory: (kind) =>
        new FakeProviderAdapter({
          provider: kind,
          nativeSteerFence: kind === "codex-lhc",
          quiesceOk: true,
          scripts: [{ items: [{ type: "agent_message", text: "ok" }], finalText: "ok" }],
        }),
      inspectCanonical: async () => ({ closed: true, span: { correlated: true } }),
    });
    managers.push(manager);
    await startRuntime(manager, record.id);
    await manager.submit({
      target: record.id,
      commandId: randomUUID(),
      kind: "turn.start",
      params: { text: "hello" },
    });
    await expect.poll(() => manager.status(record.id).state, { timeout: 500 }).toBe("idle");
    const handoff = await manager.submit({
      target: record.id,
      commandId: randomUUID(),
      kind: "handoff.request",
      params: { mode: "drain", launch: "command-only" },
    });
    expect(handoff.state).toBe("rejected");
    expect(handoff.reason).toBe("unsupported");
    expect(manager.status(record.id).state).toBe("idle");
    const released = await manager.submit({
      target: record.id,
      commandId: randomUUID(),
      kind: "handoff.release",
      params: {},
    });
    expect(released.state).toBe("rejected");
    expect(released.reason).toBe("unsupported");
  });

  it("A14 provider crash settles the turn from evidence and holds follow-ups", async () => {
    const { manager, record, adapters } = setup(provider, { waitForInterrupt: true });
    await startRuntime(manager, record.id);
    const started = await manager.submit({
      target: record.id,
      commandId: randomUUID(),
      kind: "turn.start",
      params: { text: "long" },
    });
    await manager.submit({
      target: record.id,
      commandId: randomUUID(),
      kind: "turn.followUp",
      params: { text: "later", afterTurnId: manager.getCommand(started.commandId)?.turnId },
    });
    adapters.get(provider)!.crash();
    await expect
      .poll(
        () =>
          manager
            .eventsAfter(record.id, 0)
            .some((event) => event.kind === "turn.completed" && event.data.outcome === "failed"),
        { timeout: 500 },
      )
      .toBe(true);
    expect(manager.status(record.id).state).toBe("stopped");
    expect(manager.status(record.id).followUps.length).toBe(1);
  });

  it("A16 classifies dispatch-boundary commands by durable sending state", async () => {
    const { manager, record } = setup(provider);
    await startRuntime(manager, record.id);
    const commandId = randomUUID();
    await manager.submit({
      target: record.id,
      commandId,
      kind: "turn.start",
      params: { text: "long" },
    });
    const row = manager.getCommand(commandId);
    expect(row?.dispatchState).toBe("acknowledged");
    expect(row?.receipt).toBe("applied");
    manager.reconcile(record.id);
    expect(manager.getCommand(commandId)?.receipt).toBe("applied");
  });
});

describe("V2 HTTP plane", () => {
  it("404s when disabled and authorizes with the configured token", async () => {
    const { manager, record } = setup("pi-lhc");
    const disabled = Fastify();
    apps.push(disabled);
    registerV2Routes(disabled, { manager, token: "secret", enabled: false });
    const off = await disabled.inject({
      method: "GET",
      url: `/api/v2/targets/${record.id}/status`,
      headers: { authorization: "Bearer secret" },
    });
    expect(off.statusCode).toBe(404);

    const app = Fastify();
    apps.push(app);
    registerV2Routes(app, { manager, token: "secret", enabled: true });
    const unauthorized = await app.inject({
      method: "GET",
      url: `/api/v2/targets/${record.id}/status`,
    });
    expect(unauthorized.statusCode).toBe(401);
    const ok = await app.inject({
      method: "GET",
      url: `/api/v2/targets/${record.id}/status`,
      headers: { authorization: "Bearer secret" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().provider).toBe("pi-lhc");
  });

  it("A9 returns 410 and a status snapshot when the cursor is older than retention", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-a9-"));
    dirs.push(dir);
    const record = agent("pi-lhc");
    const store = new V2Store({
      dbPath: join(dir, "v2.sqlite"),
      eventRetentionCount: 2,
      eventRetentionDays: 14,
    });
    const manager = new RuntimeManager({
      store,
      consoleHome: dir,
      agents: [record],
      policies: testOnlyOwnerPolicies(TEST_ONLY_OWNER_POLICIES),
      adapterFactory: (kind) => new FakeProviderAdapter({ provider: kind }),
    });
    managers.push(manager);
    await startRuntime(manager, record.id);
    await manager.submit({
      target: record.id,
      commandId: randomUUID(),
      kind: "turn.start",
      params: { text: "hello" },
    });
    await expect.poll(() => manager.status(record.id).state, { timeout: 500 }).toBe("idle");
    const min = manager.minEventSeq(record.id);
    expect(min).toBeGreaterThan(1);
    const app = Fastify();
    apps.push(app);
    registerV2Routes(app, { manager, token: "secret", enabled: true });
    const gone = await app.inject({
      method: "GET",
      url: `/api/v2/targets/${record.id}/events?after=1&live=0`,
      headers: { authorization: "Bearer secret" },
    });
    expect(gone.statusCode).toBe(410);
    expect(gone.json().snapshot.target).toBe(record.id);
  });

  it("replays the same commandId receipt", async () => {
    const { manager, record } = setup("codex-lhc");
    const app = Fastify();
    apps.push(app);
    registerV2Routes(app, { manager, token: "secret", enabled: true });
    const commandId = randomUUID();
    const first = await app.inject({
      method: "POST",
      url: `/api/v2/targets/${record.id}/commands`,
      headers: { authorization: "Bearer secret" },
      payload: { commandId, kind: "runtime.start", params: {} },
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/v2/targets/${record.id}/commands`,
      headers: { authorization: "Bearer secret" },
      payload: { commandId, kind: "runtime.start", params: {} },
    });
    expect(first.json()).toEqual(second.json());
  });
});
