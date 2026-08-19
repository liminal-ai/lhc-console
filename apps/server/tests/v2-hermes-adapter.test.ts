import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vite-plus/test";
import type { AdapterStartInput, ProviderNotification } from "../src/v2/adapter.ts";
import { CodexLhcAdapter } from "../src/v2/adapters/codex-lhc.ts";
import { createProviderAdapter } from "../src/v2/adapters/factory.ts";
import {
  correlateHermesNativeTurnId,
  HermesLhcAdapter,
  resumeStartState,
} from "../src/v2/adapters/hermes-lhc.ts";
import { PiLhcAdapter } from "../src/v2/adapters/pi-lhc.ts";
import { V2_PROVIDERS, type V2Provider } from "../src/v2/contract.ts";
import { MemoryJsonlPair } from "../src/v2/jsonl-transport.ts";
import type { HeldWriterLock } from "../src/v2/writer-lock.ts";

/** Durable stored-session key (thread-file stem) the gateway resumes. */
const SESSION_KEY = "20260819_010203_abcdef";
/** Ephemeral live gateway-session id minted per resume (8 hex chars). */
const LIVE_SID = "ab12cd34";

function startInput(overrides: Partial<AdapterStartInput> = {}): AdapterStartInput {
  return {
    hostThreadId: "20260801_000000_parent",
    canonicalThreadId: "th_hermes",
    cwd: "/tmp",
    approvalPolicy: "bypass-at-spawn",
    env: { HERMES_HOME: "/tmp/hermes-disposable" },
    proveCanonicalSession: async () => true,
    ...overrides,
  };
}

/**
 * The real `session.resume` payload shape emitted by `tui_gateway`
 * (`methods_session.py`): an ephemeral `session_id` SID plus the durable
 * `resumed`/`session_key` stored reference, with the idle affirmation fields
 * (`running`, `inflight`, `status`).
 */
function resumeResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: LIVE_SID,
    resumed: SESSION_KEY,
    message_count: 0,
    messages: [],
    messages_omitted: false,
    info: { cwd: "/tmp", model: "", provider: "", profile: "lhc-v2-test" },
    inflight: null,
    running: false,
    session_key: SESSION_KEY,
    started_at: "2026-08-19T00:00:00Z",
    status: "idle",
    ...overrides,
  };
}

/**
 * In-memory Hermes gateway fixture over the real JSONL codec, speaking the
 * real wire shapes: JSON-RPC 2.0 requests in; event frames out as
 * `{"jsonrpc":"2.0","method":"event","params":{type,session_id,payload}}`
 * (`tui_gateway/server.py` `_event_frame`), with `gateway.ready` first
 * (payload only, no session_id — `entry.py`). `manualTurn` accepts
 * prompt.submit without streaming the scripted event sequence, so tests can
 * drive the turn frame by frame.
 */
function attachHermesGateway(
  pair: MemoryJsonlPair,
  options: {
    resume?: Record<string, unknown> | null;
    steerStatus?: string;
    manualTurn?: boolean;
    handle?: (message: Record<string, unknown>) => boolean;
  } = {},
): {
  seen: Record<string, unknown>[];
  ready: () => void;
  event: (type: string, payload?: unknown, sid?: string) => void;
} {
  const seen: Record<string, unknown>[] = [];
  const event = (type: string, payload?: unknown, sid: string = LIVE_SID) => {
    const params: Record<string, unknown> = { type, session_id: sid };
    if (payload !== undefined) params.payload = payload;
    pair.server.send({ jsonrpc: "2.0", method: "event", params });
  };
  pair.server.onLine((line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    seen.push(message);
    if (options.handle?.(message)) return;
    if (message.method === "session.resume") {
      pair.server.send({
        jsonrpc: "2.0",
        id: message.id,
        result: options.resume === undefined ? resumeResult() : (options.resume ?? {}),
      });
      return;
    }
    if (message.method === "prompt.submit") {
      pair.server.send({ jsonrpc: "2.0", id: message.id, result: { status: "streaming" } });
      if (options.manualTurn) return;
      event("message.start");
      event("message.delta", { text: "hel" });
      event("message.delta", { text: "lo" });
      event("reasoning.available", { text: "thinking…" });
      event("tool.start", { tool_id: "t1", name: "bash", context: "ls", args: { cmd: "ls" } });
      event("tool.complete", {
        tool_id: "t1",
        name: "bash",
        args: { cmd: "ls" },
        result: "ok",
        summary: "ok",
        duration_s: 0.2,
      });
      event("status.update", { kind: "compacting", text: "compacting" });
      event("session.usage", { tokens: 12 });
      event("message.complete", { text: "hello", usage: {}, status: "complete" });
      return;
    }
    if (message.method === "session.steer") {
      pair.server.send({
        jsonrpc: "2.0",
        id: message.id,
        result: { status: options.steerStatus ?? "queued" },
      });
      return;
    }
    if (message.method === "session.interrupt") {
      pair.server.send({ jsonrpc: "2.0", id: message.id, result: {} });
      event("message.complete", { text: "", usage: {}, status: "interrupted" });
    }
  });
  return {
    seen,
    ready: () =>
      pair.server.send({
        jsonrpc: "2.0",
        method: "event",
        params: { type: "gateway.ready", payload: { skin: "default", change_events: true } },
      }),
    event,
  };
}

async function startedAdapter(
  gatewayOptions: Parameters<typeof attachHermesGateway>[1] = {},
  inputOverrides: Partial<AdapterStartInput> = {},
): Promise<{
  adapter: HermesLhcAdapter;
  seen: Record<string, unknown>[];
  event: (type: string, payload?: unknown, sid?: string) => void;
  events: ProviderNotification[];
}> {
  const pair = new MemoryJsonlPair();
  const gateway = attachHermesGateway(pair, gatewayOptions);
  const adapter = new HermesLhcAdapter({ transport: pair.client });
  const events: ProviderNotification[] = [];
  adapter.on((event) => events.push(event));
  const started = adapter.start(startInput(inputOverrides));
  gateway.ready();
  await started;
  return { adapter, seen: gateway.seen, event: gateway.event, events };
}

function fakeHermesChild(
  respond: (message: Record<string, unknown>, send: (out: unknown) => void) => void,
  options: { prelude?: string[] } = {},
): ChildProcess {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const events = new EventEmitter();
  const state = {
    pid: 5252,
    killed: false,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  };
  const child = events as unknown as ChildProcess;
  Object.defineProperties(events, {
    stdin: { value: stdin },
    stdout: { value: stdout },
    stderr: { value: new PassThrough() },
    pid: { get: () => state.pid },
    killed: { get: () => state.killed },
    exitCode: { get: () => state.exitCode },
    signalCode: { get: () => state.signalCode },
    kill: {
      value(signal?: NodeJS.Signals) {
        state.killed = true;
        state.exitCode = signal === "SIGKILL" ? 137 : 0;
        state.signalCode = signal ?? null;
        events.emit("exit", state.exitCode, state.signalCode);
        return true;
      },
    },
  });
  const send = (out: unknown) => stdout.write(`${JSON.stringify(out)}\n`);
  // Anything the "worker" writes before its ready frame — including garbage —
  // is buffered by the PassThrough until the adapter's readline attaches.
  for (const line of options.prelude ?? []) stdout.write(`${line}\n`);
  send({
    jsonrpc: "2.0",
    method: "event",
    params: { type: "gateway.ready", payload: { skin: "default", change_events: true } },
  });
  const rl = createInterface({ input: stdin }) as unknown as EventEmitter;
  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    respond(JSON.parse(trimmed) as Record<string, unknown>, send);
  });
  return child;
}

/** Wait past the adapter's setImmediate replay of pre-response events. */
function afterReplay(): Promise<void> {
  return new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
}

describe("provider adapter factory", () => {
  it("routes every registered provider to its own adapter, never a fallback", () => {
    const classes = {
      "codex-lhc": CodexLhcAdapter,
      "pi-lhc": PiLhcAdapter,
      hermes: HermesLhcAdapter,
    } as const;
    for (const provider of V2_PROVIDERS) {
      const adapter = createProviderAdapter(provider);
      expect(adapter).toBeInstanceOf(classes[provider]);
      expect(adapter.provider).toBe(provider);
    }
  });

  it("throws for an unknown provider instead of silently routing to Pi", () => {
    expect(() => createProviderAdapter("mystery" as V2Provider)).toThrow(
      /no V2 adapter is registered/,
    );
  });
});

describe("Hermes V2 JSON-RPC fixture", () => {
  it("refuses to start without an explicit disposable HERMES_HOME", async () => {
    const adapter = new HermesLhcAdapter({
      spawnProcess: () => {
        throw new Error("must not spawn");
      },
    });
    await expect(adapter.start(startInput({ env: {} }))).rejects.toThrow(/HERMES_HOME/);
  });

  it("separates the durable session_key from the ephemeral SID and never sends profile", async () => {
    let proved: { native: string; canonical: string } | null = null;
    const { adapter, seen } = await startedAdapter(
      {},
      {
        proveCanonicalSession: async (native, canonical) => {
          proved = { native, canonical };
          return true;
        },
      },
    );
    const state = await adapter.getState();
    // The durable resumed/session_key reference is the identity that binds…
    expect(state.nativeThreadRef).toBe(SESSION_KEY);
    expect(proved).toEqual({ native: SESSION_KEY, canonical: "th_hermes" });
    // …while the ephemeral SID is only the RPC handle.
    expect(state.liveSessionId).toBe(LIVE_SID);
    const resume = seen.find((message) => message.method === "session.resume")!;
    expect(resume.params).toEqual({ session_id: "20260801_000000_parent" });
    // O4: HERMES_HOME is the single binding; the RPC profile param is never passed.
    for (const message of seen) {
      expect(Object.keys((message.params as object) ?? {})).not.toContain("profile");
    }
  });

  it("addresses every post-resume RPC by the live SID, not the durable key", async () => {
    const { adapter, seen, event } = await startedAdapter({ manualTurn: true });
    const native = await adapter.startTurn("hello");
    event("message.start");
    await adapter.steer(native, "nudge");
    await adapter.interrupt(native);
    const rpcSids = seen
      .filter((m) =>
        ["prompt.submit", "session.steer", "session.interrupt"].includes(m.method as string),
      )
      .map((m) => (m.params as Record<string, unknown>).session_id);
    expect(rpcSids.length).toBeGreaterThanOrEqual(3);
    for (const sid of rpcSids) expect(sid).toBe(LIVE_SID);
  });

  it("refuses start when the resume response carries no live session_id", async () => {
    const pair = new MemoryJsonlPair();
    const gateway = attachHermesGateway(pair, {
      resume: resumeResult({ session_id: undefined }),
    });
    const adapter = new HermesLhcAdapter({ transport: pair.client });
    const started = adapter.start(startInput());
    gateway.ready();
    await expect(started).rejects.toThrow(/no live session_id/);
  });

  it("refuses start when the resume response carries no durable resumed/session_key", async () => {
    const pair = new MemoryJsonlPair();
    const gateway = attachHermesGateway(pair, {
      resume: resumeResult({ resumed: undefined, session_key: undefined }),
    });
    const adapter = new HermesLhcAdapter({ transport: pair.client });
    const started = adapter.start(startInput());
    gateway.ready();
    await expect(started).rejects.toThrow(/no durable resumed\/session_key/);
  });

  it("refuses string-equality identity when no canonical prover is supplied", async () => {
    const pair = new MemoryJsonlPair();
    const gateway = attachHermesGateway(pair);
    const adapter = new HermesLhcAdapter({ transport: pair.client });
    const started = adapter.start(startInput({ proveCanonicalSession: undefined }));
    gateway.ready();
    await expect(started).rejects.toThrow(/no canonical identity prover/);
  });

  it("refuses start when the canonical proof rejects the resumed session", async () => {
    const pair = new MemoryJsonlPair();
    const gateway = attachHermesGateway(pair);
    const adapter = new HermesLhcAdapter({ transport: pair.client });
    const started = adapter.start(startInput({ proveCanonicalSession: async () => false }));
    gateway.ready();
    await expect(started).rejects.toThrow(/does not map to configured canonical LHC thread/);
  });

  it("bounds the gateway.ready wait instead of hanging on a silent worker", async () => {
    const pair = new MemoryJsonlPair();
    const adapter = new HermesLhcAdapter({ transport: pair.client, readyTimeoutMs: 50 });
    await expect(adapter.start(startInput())).rejects.toThrow(/gateway\.ready within 50ms/);
  });

  it("claims idle start evidence only from an affirmatively idle resume payload", async () => {
    const { adapter } = await startedAdapter();
    expect(adapter.startEvidence()).toEqual({ kind: "idle" });
  });

  it.each([
    ["running run loop", { running: true, status: "streaming" }, /running run loop/],
    ["retained inflight turn", { inflight: { user: "hi" } }, /inflight turn snapshot/],
    ["scheduled auto_continue", { auto_continue: { delay_s: 1 } }, /auto_continue/],
    ["missing idle affirmation", { running: undefined, status: undefined }, /did not affirm/],
  ] as const)(
    "surfaces %s as unproven start evidence, never idle",
    async (_label, overrides, pattern) => {
      const { adapter } = await startedAdapter({
        resume: resumeResult(overrides as Record<string, unknown>),
      });
      const evidence = adapter.startEvidence();
      expect(evidence.kind).toBe("unproven");
      if (evidence.kind === "unproven") {
        expect(evidence.reasons.join("; ")).toMatch(pattern);
        expect(evidence.evidence).toHaveProperty("running");
      }
    },
  );

  it("typed resume start-state helper is honest about each uncertainty axis", () => {
    expect(resumeStartState(resumeResult())).toEqual({ kind: "idle" });
    const unproven = resumeStartState(resumeResult({ running: true, status: "streaming" }));
    expect(unproven.kind).toBe("unproven");
  });

  it("mints hermes-rpc turn ids from generation and request id and maps the event stream", async () => {
    const { adapter, events } = await startedAdapter({}, { runtimeGeneration: 7 });
    const native = await adapter.startTurn("hello");
    await afterReplay();
    expect(native).toMatch(/^hermes-rpc:7:\d+$/);
    expect(native).toBe(correlateHermesNativeTurnId(7, native.split(":")[2]!));
    const kinds = events.map((event) => event.type);
    expect(kinds).toContain("turnStarted");
    expect(kinds.filter((kind) => kind === "turnCompleted")).toHaveLength(1);
    const items = events.filter(
      (event): event is Extract<ProviderNotification, { type: "item" }> => event.type === "item",
    );
    // tool.start + tool.complete both surface as tool items, named from payload.
    const tools = items.filter((item) => item.item.type === "tool");
    expect(tools).toHaveLength(2);
    expect(tools[0]!.item.text).toBe("bash");
    expect(tools[0]!.item.nativeItemId).toBe("t1");
    // reasoning + status.update kind + unrecognized session.usage surface as other items.
    const others = items.filter((item) => item.item.type === "other");
    expect(others.length).toBeGreaterThanOrEqual(3);
    expect(others.some((item) => item.item.text === "compacting")).toBe(true);
    const completed = events.find(
      (event): event is Extract<ProviderNotification, { type: "turnCompleted" }> =>
        event.type === "turnCompleted",
    )!;
    expect(completed).toMatchObject({ nativeTurnId: native, outcome: "completed" });
    expect(completed.finalText).toBe("hello");
    // Per-token deltas are buffered, never emitted as items.
    expect(items.some((item) => item.item.text === "hel")).toBe(false);
  });

  it("settles a turn whose events all beat the prompt.submit response", async () => {
    // The gateway runs turns on a daemon thread: the terminal frame can hit
    // the wire before the RPC response. Nothing may be dropped and the
    // adapter must not stay active.
    const pair = new MemoryJsonlPair();
    const gateway = attachHermesGateway(pair, {
      handle: (message) => {
        if (message.method !== "prompt.submit") return false;
        gateway.event("message.start");
        gateway.event("message.delta", { text: "fast" });
        gateway.event("message.complete", { text: "fast", usage: {}, status: "complete" });
        pair.server.send({ jsonrpc: "2.0", id: message.id, result: { status: "streaming" } });
        return true;
      },
    });
    const adapter = new HermesLhcAdapter({ transport: pair.client });
    const events: ProviderNotification[] = [];
    adapter.on((event) => events.push(event));
    const started = adapter.start(startInput());
    gateway.ready();
    await started;
    const native = await adapter.startTurn("quick");
    // Buffered events replay only after the caller's post-await continuation.
    expect(events.some((e) => e.type === "turnCompleted")).toBe(false);
    await afterReplay();
    const kinds = events.map((e) => e.type);
    expect(kinds).toContain("turnStarted");
    const completed = events.find(
      (e): e is Extract<ProviderNotification, { type: "turnCompleted" }> =>
        e.type === "turnCompleted",
    )!;
    expect(completed).toMatchObject({ nativeTurnId: native, outcome: "completed" });
    expect(completed.finalText).toBe("fast");
    expect((await adapter.getState()).activeNativeTurnId).toBeNull();
  });

  it("ignores events addressed to a foreign gateway session", async () => {
    const { adapter, events, event } = await startedAdapter({ manualTurn: true });
    const native = await adapter.startTurn("hi");
    event("message.start");
    // A different SID's terminal frame must not close our turn.
    event("message.complete", { text: "not ours", status: "complete" }, "ffff0000");
    expect(events.some((e) => e.type === "turnCompleted")).toBe(false);
    event("message.complete", { text: "ours", usage: {}, status: "complete" });
    const completed = events.find(
      (e): e is Extract<ProviderNotification, { type: "turnCompleted" }> =>
        e.type === "turnCompleted",
    )!;
    expect(completed).toMatchObject({ nativeTurnId: native, finalText: "ours" });
  });

  it("falls back to accumulated payload deltas when message.complete carries no text", async () => {
    const { adapter, events, event } = await startedAdapter({ manualTurn: true });
    const native = await adapter.startTurn("hi");
    event("message.start");
    event("message.delta", { text: "streamed " });
    event("message.delta", { text: "answer" });
    event("message.complete", { usage: {}, status: "complete" });
    const completed = events.find(
      (e): e is Extract<ProviderNotification, { type: "turnCompleted" }> =>
        e.type === "turnCompleted",
    )!;
    expect(completed.nativeTurnId).toBe(native);
    expect(completed.finalText).toBe("streamed answer");
  });

  it("applies the adapter-side steer fence: no turn, wrong turn, closed turn", async () => {
    const { adapter, events, seen } = await startedAdapter();
    await expect(adapter.steer("hermes-rpc:0:999", "early")).resolves.toBe("mismatch");
    const native = await adapter.startTurn("go");
    await afterReplay();
    // Fixture settles the turn synchronously — a steer after the terminal
    // frame is a mismatch, not a queued lie.
    await expect(adapter.steer(native, "late")).resolves.toBe("mismatch");
    expect(events.some((event) => event.type === "steerQueued")).toBe(false);
    expect(seen.some((message) => message.method === "session.steer")).toBe(false);
  });

  it("emits steerQueued on a queued steer of the live turn", async () => {
    const { adapter, events, event } = await startedAdapter({ manualTurn: true });
    const native = await adapter.startTurn("long");
    event("message.start");
    await expect(adapter.steer(native, "nudge")).resolves.toBe("ok");
    expect(events.some((e) => e.type === "steerQueued" && e.nativeTurnId === native)).toBe(true);
    event("message.complete", { text: "done", usage: {}, status: "complete" });
  });

  it("maps a rejected steer status to mismatch", async () => {
    const { adapter, event } = await startedAdapter({ manualTurn: true, steerStatus: "rejected" });
    const native = await adapter.startTurn("long");
    event("message.start");
    await expect(adapter.steer(native, "nudge")).resolves.toBe("mismatch");
    event("message.complete", { text: "", usage: {}, status: "complete" });
  });

  it("interrupt settles the turn through the terminal interrupted frame", async () => {
    const { adapter, events, event } = await startedAdapter({ manualTurn: true });
    const native = await adapter.startTurn("long");
    event("message.start");
    await adapter.interrupt(native);
    const completed = events.find((e) => e.type === "turnCompleted");
    expect(completed).toMatchObject({ nativeTurnId: native, outcome: "interrupted" });
  });

  it("maps an error-status terminal frame to a failed outcome, exactly once", async () => {
    const { adapter, events, event } = await startedAdapter({ manualTurn: true });
    await adapter.startTurn("doomed");
    event("message.start");
    event("message.complete", {
      text: "partial",
      usage: {},
      status: "error",
      error: "provider 500",
      recoverable: true,
    });
    // A duplicate terminal frame after the turn closed must not double-settle.
    event("message.complete", { text: "partial", usage: {}, status: "error" });
    const completed = events.filter((e) => e.type === "turnCompleted");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ outcome: "failed", finalText: "partial" });
  });

  it("closes a turn the gateway abandons with a bare error event as failed", async () => {
    // methods_prompt.py's cancel-before-ready path emits `error` and never a
    // message.complete; the turn must not hang open.
    const { adapter, events, event } = await startedAdapter({ manualTurn: true });
    const native = await adapter.startTurn("doomed");
    event("error", { message: "Turn cancelled before the agent was ready" });
    const completed = events.find(
      (e): e is Extract<ProviderNotification, { type: "turnCompleted" }> =>
        e.type === "turnCompleted",
    )!;
    expect(completed).toMatchObject({ nativeTurnId: native, outcome: "failed" });
    expect((await adapter.getState()).activeNativeTurnId).toBeNull();
  });

  it("reports an unrecognized terminal status as indeterminate, never completed", async () => {
    const { adapter, events, event } = await startedAdapter({ manualTurn: true });
    await adapter.startTurn("odd");
    event("message.start");
    event("message.complete", { text: "??", usage: {}, status: "paused" });
    const completed = events.find(
      (e): e is Extract<ProviderNotification, { type: "turnCompleted" }> =>
        e.type === "turnCompleted",
    )!;
    expect(completed.outcome).toBe("indeterminate");
  });

  it("refuses a second prompt.submit while a turn is active", async () => {
    const { adapter, seen, event } = await startedAdapter({ manualTurn: true });
    await adapter.startTurn("first");
    event("message.start");
    await expect(adapter.startTurn("second")).rejects.toThrow(/while a turn is active/);
    expect(seen.filter((message) => message.method === "prompt.submit")).toHaveLength(1);
    event("message.complete", { text: "", usage: {}, status: "complete" });
  });

  it("classifies gateway app errors by code, never wording", async () => {
    let code = 4009;
    const pair = new MemoryJsonlPair();
    const gateway = attachHermesGateway(pair, {
      handle: (message) => {
        if (message.method !== "prompt.submit") return false;
        pair.server.send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code, message: `app error ${code}` },
        });
        return true;
      },
    });
    const adapter = new HermesLhcAdapter({ transport: pair.client });
    const started = adapter.start(startInput());
    gateway.ready();
    await started;

    // 4009 busy: a plain provider error; the minted turn is cleared, never retried.
    const busy = await adapter.startTurn("busy").then(
      () => null,
      (error: Error) => error,
    );
    expect(busy?.name).toBe("Error");
    expect(busy?.message).toMatch(/\(4009\)/);
    expect((await adapter.getState()).activeNativeTurnId).toBeNull();

    // 4010 unsupported capability.
    code = 4010;
    const unsupported = await adapter.startTurn("x").then(
      () => null,
      (error: Error) => error,
    );
    expect(unsupported?.name).toBe("ProviderUnsupportedError");

    // 4007 unknown session — the only observable evidence of a silent reap.
    code = 4007;
    const reaped = await adapter.startTurn("y").then(
      () => null,
      (error: Error) => error,
    );
    expect(reaped?.name).toBe("ProviderUnavailableError");
    expect(reaped?.message).toMatch(/reaped/);
  });

  it("ignores malformed and non-request lines without dropping the stream", async () => {
    const adapter = new HermesLhcAdapter({
      spawnProcess: () =>
        fakeHermesChild(
          (message, send) => {
            if (message.method === "session.resume") {
              send({ jsonrpc: "2.0", id: message.id, result: resumeResult() });
            }
            if (message.method === "prompt.submit") {
              send({ jsonrpc: "2.0", id: message.id, result: { status: "streaming" } });
              send({
                jsonrpc: "2.0",
                method: "event",
                params: { type: "message.start", session_id: LIVE_SID },
              });
              send({
                jsonrpc: "2.0",
                method: "event",
                params: {
                  type: "message.complete",
                  session_id: LIVE_SID,
                  payload: { text: "ok", usage: {}, status: "complete" },
                },
              });
            }
          },
          { prelude: ["this is not json {", '"a bare json string"', '{"method":"noise"}'] },
        ),
    });
    await expect(adapter.start(startInput())).resolves.toBe(SESSION_KEY);
    await expect(adapter.startTurn("still works")).resolves.toMatch(/^hermes-rpc:/);
    await adapter.stop("kill");
  });

  it("spawns the worker with unbuffered stdio, tool progress, TTL, and the writer fence", async () => {
    const spawned: {
      command?: string;
      args?: string[];
      env?: NodeJS.ProcessEnv;
      writerLock?: HeldWriterLock | null;
    } = {};
    const lock = {
      resourceKey: "rk",
      fenceName: " lhc-v2-writer.rk",
      ownerPath: "/tmp/rk.owner",
      token: "tok",
      ownerPid: 1,
      ownerStartedAt: "2026-08-17T00:00:00.000Z",
      fd: 3,
    } satisfies HeldWriterLock;
    const adapter = new HermesLhcAdapter({
      spawnProcess: (command, args, options) => {
        spawned.command = command;
        spawned.args = args;
        spawned.env = options.env;
        spawned.writerLock = options.writerLock ?? null;
        return fakeHermesChild((message, send) => {
          if (message.method === "session.resume") {
            send({ jsonrpc: "2.0", id: message.id, result: resumeResult() });
          }
        });
      },
    });
    await expect(adapter.start(startInput({ writerLock: lock }))).resolves.toBe(SESSION_KEY);
    expect(spawned.command).toBe("python");
    expect(spawned.args).toEqual(["-m", "tui_gateway.entry"]);
    expect(spawned.writerLock).toBe(lock);
    expect(spawned.env?.HERMES_HOME).toBe("/tmp/hermes-disposable");
    expect(spawned.env?.PYTHONUNBUFFERED).toBe("1");
    expect(spawned.env?.HERMES_TUI_TOOL_PROGRESS).toBe("verbose");
    // The reaper is silent on stdio; the owned worker's TTL must be generous.
    expect(Number(spawned.env?.HERMES_TUI_SESSION_TTL_S)).toBeGreaterThan(21_600);
    expect(adapter.pid()).toBe(5252);
    await adapter.stop("kill");
  });

  it("rejects in-flight RPCs on mid-turn death and proves the stop", async () => {
    const adapter = new HermesLhcAdapter({
      spawnProcess: () =>
        fakeHermesChild((message, send) => {
          if (message.method === "session.resume") {
            send({ jsonrpc: "2.0", id: message.id, result: resumeResult() });
          }
          // prompt.submit deliberately never answered: the worker dies mid-line
        }),
    });
    await adapter.start(startInput());
    const pending = adapter.startTurn("hello");
    adapter.rejectPendingForTest("hermes runtime exited");
    await expect(pending).rejects.toThrow(/exited/);
    const exit = await adapter.stop("kill");
    expect(exit.code === 137 || exit.code === 0).toBe(true);
    expect(adapter.pid()).toBeNull();
  });

  it("rejects start for a nonexistent python without crashing or hanging", async () => {
    const uncaught: unknown[] = [];
    const handler = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", handler);
    try {
      const adapter = new HermesLhcAdapter({
        command: "/nonexistent/lhc-hermes-python",
      });
      await expect(adapter.start(startInput())).rejects.toThrow(
        /hermes child process failed: .*ENOENT/,
      );
      const outcome = await adapter.stop("kill");
      // Node either never emits "exit" for a failed spawn (older) or emits it
      // with a negative errno code (newer); both must resolve without a signal.
      expect(outcome.signal).toBeNull();
      expect(outcome.code === null || outcome.code < 0).toBe(true);
      expect(adapter.pid()).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", handler);
    }
  });

  it("refuses handoff quiesce: no structured Hermes receipt exists", async () => {
    const { adapter } = await startedAdapter();
    await expect(adapter.quiesceForHandoff()).resolves.toMatchObject({
      captureFlushed: false,
      compactQuiesced: false,
      evidence: { source: "unimplemented" },
    });
  });

  it("declares steer consumption unprovable", async () => {
    const adapter = new HermesLhcAdapter();
    expect(adapter.capabilities.steerConsumption).toBe("unsupported");
  });
});
