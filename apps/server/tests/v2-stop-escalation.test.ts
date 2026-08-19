import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CodexLhcAdapter } from "../src/v2/adapters/codex-lhc.ts";
import { LHC_HANDOFF_QUIESCE_COMMAND, PiLhcAdapter } from "../src/v2/adapters/pi-lhc.ts";

// Outside any real pid range, so killHard's process-group SIGKILL can only
// ever throw ESRCH instead of touching a real process group on this machine.
const IMPOSSIBLE_PID = 0x7fffffff;

interface StubbornChild {
  child: ChildProcess;
  killSignals: NodeJS.Signals[];
}

/**
 * A fake child that ignores graceful termination (EOF and SIGTERM). When
 * `dieOnSigkill` it emits "exit"(null, SIGKILL) on SIGKILL; otherwise it
 * never exits at all, modeling a process stuck in uninterruptible sleep.
 */
function stubbornChild(
  respond: (message: Record<string, unknown>, send: (out: unknown) => void) => void,
  options: { dieOnSigkill: boolean },
): StubbornChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const events = new EventEmitter();
  const killSignals: NodeJS.Signals[] = [];
  const state = { exitCode: null as number | null, signalCode: null as NodeJS.Signals | null };
  Object.defineProperties(events, {
    stdin: { value: stdin },
    stdout: { value: stdout },
    stderr: { value: new PassThrough() },
    pid: { get: () => IMPOSSIBLE_PID },
    killed: { get: () => killSignals.length > 0 },
    exitCode: { get: () => state.exitCode },
    signalCode: { get: () => state.signalCode },
    kill: {
      value(signal: NodeJS.Signals = "SIGTERM") {
        killSignals.push(signal);
        if (signal === "SIGKILL" && options.dieOnSigkill) {
          state.exitCode = null;
          state.signalCode = "SIGKILL";
          events.emit("exit", null, "SIGKILL");
        }
        return true;
      },
    },
  });
  const rl = createInterface({ input: stdin }) as unknown as EventEmitter;
  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    respond(JSON.parse(trimmed) as Record<string, unknown>, (out) => {
      stdout.write(`${JSON.stringify(out)}\n`);
    });
  });
  return { child: events as unknown as ChildProcess, killSignals };
}

function codexResponder(handshakeOnly = false) {
  return (message: Record<string, unknown>, send: (out: unknown) => void): void => {
    if (message.method === "initialize") {
      send({ id: message.id, result: { userAgent: "stubborn-fixture" } });
      return;
    }
    if (message.method === "thread/resume") {
      send({ id: message.id, result: { thread: { id: "sess-stubborn" } } });
      return;
    }
    if (handshakeOnly) return; // later RPCs (turn/start, ...) never answer
    send({ id: message.id, result: {} });
  };
}

function piResponder(handshake: { done: boolean }) {
  return (message: Record<string, unknown>, send: (out: unknown) => void): void => {
    if (handshake.done) return; // post-start commands never answer
    if (message.type === "get_state") {
      send({
        id: message.id,
        type: "response",
        command: "get_state",
        success: true,
        data: { sessionId: "pi-sess-stubborn" },
      });
      return;
    }
    if (message.type === "get_entries") {
      send({
        id: message.id,
        type: "response",
        command: "get_entries",
        success: true,
        data: {
          entries: [{ type: "custom", customType: "pi-lhc.thread", data: { threadId: "th_pi" } }],
          leafId: null,
        },
      });
      return;
    }
    if (message.type === "get_commands") {
      send({
        id: message.id,
        type: "response",
        command: "get_commands",
        success: true,
        data: { commands: [{ name: LHC_HANDOFF_QUIESCE_COMMAND }] },
      });
      return;
    }
    if (message.type === "set_steering_mode") {
      send({ id: message.id, type: "response", command: "set_steering_mode", success: true });
      handshake.done = true;
    }
  };
}

async function startCodex(fake: StubbornChild, timeouts: Record<string, number>) {
  const adapter = new CodexLhcAdapter({ spawnProcess: () => fake.child, ...timeouts });
  await adapter.start({
    hostThreadId: "sess-stubborn",
    canonicalThreadId: "th_codex",
    cwd: "/tmp",
    approvalPolicy: "bypass-at-spawn",
    proveCanonicalSession: async () => true,
  });
  return adapter;
}

async function startPi(fake: StubbornChild, timeouts: Record<string, number>) {
  const adapter = new PiLhcAdapter({ spawnProcess: () => fake.child, ...timeouts });
  await adapter.start({
    hostThreadId: "sess-alias",
    canonicalThreadId: "th_pi",
    cwd: "/tmp",
    approvalPolicy: "bypass-at-spawn",
  });
  return adapter;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Codex-LHC bounded stop escalation", () => {
  it("escalates drain to SIGKILL when the child ignores EOF/SIGTERM, and rejects pending RPCs", async () => {
    const fake = stubbornChild(codexResponder(true), { dieOnSigkill: true });
    const adapter = await startCodex(fake, { gracefulStopTimeoutMs: 20, killSettleTimeoutMs: 20 });
    const exited: Array<{ code: number | null; signal: NodeJS.Signals | null }> = [];
    adapter.on((event) => {
      if (event.type === "exited") exited.push({ code: event.code, signal: event.signal });
    });
    const hung = adapter.startTurn("never answered");
    const hungRejected = hung.catch((error: Error) => error.message);
    const exit = await adapter.stop("drain");
    expect(exit).toEqual({ code: null, signal: "SIGKILL" });
    expect(fake.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    await expect(hungRejected).resolves.toMatch(/runtime exited|runtime stopped/);
    expect(exited).toContainEqual({ code: null, signal: "SIGKILL" });
  });

  it("settles interrupt-mode stop within the final bound when even SIGKILL is ignored, leaking no timers or listeners", async () => {
    const fake = stubbornChild(codexResponder(true), { dieOnSigkill: false });
    const adapter = await startCodex(fake, {});
    const exitListenersBefore = fake.child.listenerCount("exit");
    vi.useFakeTimers();
    const stopping = adapter.stop("interrupt");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fake.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    await vi.advanceTimersByTimeAsync(2_000);
    // Truthful evidence: no exit ever happened, so nothing is invented.
    await expect(stopping).resolves.toEqual({ code: null, signal: null });
    expect(vi.getTimerCount()).toBe(0);
    expect(fake.child.listenerCount("exit")).toBe(exitListenersBefore);
  });
});

describe("Pi-LHC bounded stop escalation", () => {
  it("escalates interrupt to SIGKILL when the child ignores EOF/SIGTERM, and rejects pending commands", async () => {
    const handshake = { done: false };
    const fake = stubbornChild(piResponder(handshake), { dieOnSigkill: true });
    const adapter = await startPi(fake, { gracefulStopTimeoutMs: 20, killSettleTimeoutMs: 20 });
    const hung = adapter.getState();
    const hungRejected = hung.catch((error: Error) => error.message);
    const exit = await adapter.stop("interrupt");
    expect(exit).toEqual({ code: null, signal: "SIGKILL" });
    expect(fake.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    await expect(hungRejected).resolves.toMatch(/runtime exited|runtime stopped/);
  });

  it("settles drain-mode stop within the final bound when even SIGKILL is ignored, leaking no timers or listeners", async () => {
    const handshake = { done: false };
    const fake = stubbornChild(piResponder(handshake), { dieOnSigkill: false });
    const adapter = await startPi(fake, {});
    const exitListenersBefore = fake.child.listenerCount("exit");
    vi.useFakeTimers();
    const stopping = adapter.stop("drain");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fake.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(stopping).resolves.toEqual({ code: null, signal: null });
    expect(vi.getTimerCount()).toBe(0);
    expect(fake.child.listenerCount("exit")).toBe(exitListenersBefore);
  });
});
