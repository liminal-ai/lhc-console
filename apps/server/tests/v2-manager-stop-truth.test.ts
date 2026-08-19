import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { AgentRecord } from "../src/agent-registry.ts";
import { CodexLhcAdapter } from "../src/v2/adapters/codex-lhc.ts";
import { MemoryJsonlPair } from "../src/v2/jsonl-transport.ts";
import { RuntimeManager, type V2CanonicalInspector } from "../src/v2/manager.ts";
import { TEST_ONLY_OWNER_POLICIES, testOnlyOwnerPolicies } from "../src/v2/policies.ts";
import { V2Store } from "../src/v2/store.ts";

// Outside any real pid range, so killHard's process-group SIGKILL can only
// ever throw ESRCH instead of touching a real process group on this machine.
const IMPOSSIBLE_PID = 0x7fffffff;
const NATIVE_SESSION_ID = "sess-stubborn";
const CANONICAL_THREAD_ID = "th_codex_truth";

const dirs: string[] = [];
const managers: RuntimeManager[] = [];
let savedCodexHome: string | undefined;

afterEach(() => {
  for (const manager of managers.splice(0)) manager.close();
  if (savedCodexHome === undefined) delete process.env.CODEX_LHC_HOME;
  else process.env.CODEX_LHC_HOME = savedCodexHome;
  savedCodexHome = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface StubbornChild {
  child: ChildProcess;
  killSignals: NodeJS.Signals[];
  /** Late real death: the observed exit the manager must settle from. */
  dieNow: (signal: NodeJS.Signals) => void;
}

/**
 * A fake child that ignores graceful termination (EOF and SIGTERM). When
 * `dieOnSigkill` it emits "exit"(null, SIGKILL) on SIGKILL; otherwise it
 * never exits at all, modeling a process stuck in uninterruptible sleep.
 */
function stubbornChild(options: { dieOnSigkill: boolean }): StubbornChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const events = new EventEmitter();
  const killSignals: NodeJS.Signals[] = [];
  const state = { exitCode: null as number | null, signalCode: null as NodeJS.Signals | null };
  const dieNow = (signal: NodeJS.Signals): void => {
    state.signalCode = signal;
    events.emit("exit", null, signal);
  };
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
        if (signal === "SIGKILL" && options.dieOnSigkill) dieNow("SIGKILL");
        return true;
      },
    },
  });
  const rl = createInterface({ input: stdin }) as unknown as EventEmitter;
  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const message = JSON.parse(trimmed) as Record<string, unknown>;
    const send = (out: unknown): void => {
      stdout.write(`${JSON.stringify(out)}\n`);
    };
    if (message.method === "initialize") {
      send({ id: message.id, result: { userAgent: "stubborn-fixture" } });
    } else if (message.method === "thread/resume") {
      send({ id: message.id, result: { thread: { id: NATIVE_SESSION_ID } } });
    }
  });
  return { child: events as unknown as ChildProcess, killSignals, dieNow };
}

function codexAgent(): AgentRecord {
  return {
    id: "codex-agent",
    name: "codex-agent",
    description: "codex-agent",
    duties: [],
    ownerSenderIds: ["owner"],
    mentionPatterns: ["codex"],
    health: { hostId: "codex-lhc", threadId: CANONICAL_THREAD_ID },
    channels: {},
    relay: {
      hostId: "codex-lhc",
      threadId: NATIVE_SESSION_ID,
      cwd: "/tmp",
      command: "true",
      args: [],
    },
    v2: { provider: "codex-lhc" },
  };
}

const provenInspector: V2CanonicalInspector = async () => ({
  closed: false,
  span: { nativeThreadRef: NATIVE_SESSION_ID, hostThreadId: CANONICAL_THREAD_ID },
});

function managerWith(
  adapter: CodexLhcAdapter,
  inspectCanonical: V2CanonicalInspector,
  agent: AgentRecord = codexAgent(),
): RuntimeManager {
  const consoleHome = mkdtempSync(join(tmpdir(), "lhc-console-home-"));
  dirs.push(consoleHome);
  savedCodexHome ??= process.env.CODEX_LHC_HOME ?? undefined;
  const hostHome = mkdtempSync(join(tmpdir(), "lhc-codex-home-"));
  dirs.push(hostHome);
  process.env.CODEX_LHC_HOME = hostHome;
  const manager = new RuntimeManager({
    store: new V2Store({ dbPath: join(consoleHome, "v2.sqlite") }),
    consoleHome,
    agents: [agent],
    policies: testOnlyOwnerPolicies(TEST_ONLY_OWNER_POLICIES),
    adapterFactory: () => adapter,
    inspectCanonical,
  });
  managers.push(manager);
  return manager;
}

function stubbornManager(options: { dieOnSigkill: boolean }): {
  manager: RuntimeManager;
  fake: StubbornChild;
} {
  const fake = stubbornChild(options);
  const adapter = new CodexLhcAdapter({
    spawnProcess: () => fake.child,
    gracefulStopTimeoutMs: 20,
    killSettleTimeoutMs: 20,
  });
  return { manager: managerWith(adapter, provenInspector), fake };
}

async function startRuntime(manager: RuntimeManager): Promise<void> {
  const receipt = await manager.submit({
    target: "codex-agent",
    commandId: "start-1",
    kind: "runtime.start",
    params: {},
  });
  expect(receipt.state).toBe("applied");
  expect(manager.status("codex-agent").state).toBe("idle");
}

function stoppedEvents(manager: RuntimeManager): unknown[] {
  return manager
    .eventsAfter("codex-agent", 0)
    .filter((event) => event.kind === "runtime.state" && event.data.state === "stopped");
}

describe("manager stop truth: a child surviving SIGKILL never becomes a stopped runtime", () => {
  it("keeps the runtime unknown, the fence held, and the receipt indeterminate when drain-mode stop cannot prove an exit", async () => {
    const { manager, fake } = stubbornManager({ dieOnSigkill: false });
    await startRuntime(manager);

    const receipt = await manager.submit({
      target: "codex-agent",
      commandId: "stop-1",
      kind: "runtime.stop",
      params: { mode: "drain" },
    });

    expect(fake.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    // Never applied, never stopped: no exit was observed.
    expect(receipt.state).toBe("indeterminate");
    const status = manager.status("codex-agent");
    expect(status.state).toBe("unknown");
    expect(status.writers.managedFenceHeld).toBe(true);
    expect(status.writers.console.kind).toBe("v2-runtime");
    expect(status.runtime.pid).toBe(IMPOSSIBLE_PID);
    expect(stoppedEvents(manager)).toEqual([]);

    // Retained truth: a second stop still cannot invent an exit.
    const again = await manager.submit({
      target: "codex-agent",
      commandId: "stop-2",
      kind: "runtime.stop",
      params: { mode: "drain" },
    });
    expect(again.state).toBe("indeterminate");
    expect(stoppedEvents(manager)).toEqual([]);
  });

  it("settles to stopped only from the child's later observed exit", async () => {
    const { manager, fake } = stubbornManager({ dieOnSigkill: false });
    await startRuntime(manager);
    const receipt = await manager.submit({
      target: "codex-agent",
      commandId: "stop-1",
      kind: "runtime.stop",
      params: { mode: "kill" },
    });
    expect(receipt.state).toBe("indeterminate");
    expect(manager.status("codex-agent").state).toBe("unknown");

    // The child finally dies for real; the retained subscription observes it.
    fake.dieNow("SIGKILL");
    await expect
      .poll(() => manager.status("codex-agent").state, { timeout: 1_000 })
      .toBe("stopped");
    expect(manager.status("codex-agent").writers.managedFenceHeld).toBe(false);
    expect(stoppedEvents(manager)).toHaveLength(1);
  });

  it("bounds kill-mode stop and applies it when SIGKILL produces a real exit", async () => {
    const { manager, fake } = stubbornManager({ dieOnSigkill: true });
    await startRuntime(manager);
    const startedAt = Date.now();
    const receipt = await manager.submit({
      target: "codex-agent",
      commandId: "stop-1",
      kind: "runtime.stop",
      params: { mode: "kill" },
    });
    // Bounded: the 20ms test windows, not a hung wait, decide this.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(fake.killSignals).toContain("SIGKILL");
    expect(receipt.state).toBe("applied");
    const status = manager.status("codex-agent");
    expect(status.state).toBe("stopped");
    expect(status.writers.managedFenceHeld).toBe(false);
  });
});

describe("manager canonical identity: string equality is not store evidence", () => {
  function appServer(nativeId: string): MemoryJsonlPair {
    const pair = new MemoryJsonlPair();
    pair.server.onLine((line) => {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (message.method === "initialize") {
        pair.server.send({ id: message.id, result: { userAgent: "fixture" } });
        return;
      }
      if (message.method === "thread/resume") {
        pair.server.send({ id: message.id, result: { thread: { id: nativeId } } });
      }
    });
    return pair;
  }

  it("rejects a resume whose native id equals the canonical id when the canonical span is missing", async () => {
    // The native session id IS the canonical thread id — the old shortcut
    // would have accepted this with no store evidence at all.
    const agent = codexAgent();
    agent.health = { hostId: "codex-lhc", threadId: NATIVE_SESSION_ID };
    const adapter = new CodexLhcAdapter({ transport: appServer(NATIVE_SESSION_ID).client });
    const manager = managerWith(
      adapter,
      async () => ({ closed: false, span: { reason: "thread_file_missing" } }),
      agent,
    );

    const receipt = await manager.submit({
      target: "codex-agent",
      commandId: "start-1",
      kind: "runtime.start",
      params: {},
    });

    expect(receipt.state).toBe("rejected");
    expect(receipt.reason).toBe("provider_unavailable");
    expect(receipt.message).toMatch(/does not map/);
    expect(manager.status("codex-agent").state).toBe("stopped");
    expect(manager.status("codex-agent").writers.managedFenceHeld).toBe(false);
  });

  it("rejects when the canonical inspector itself fails, even with matching strings", async () => {
    const adapter = new CodexLhcAdapter({ transport: appServer(NATIVE_SESSION_ID).client });
    const manager = managerWith(adapter, async () => {
      throw new Error("canonical store unreadable");
    });

    const receipt = await manager.submit({
      target: "codex-agent",
      commandId: "start-1",
      kind: "runtime.start",
      params: {},
    });

    expect(receipt.state).toBe("rejected");
    expect(receipt.reason).toBe("provider_unavailable");
    expect(manager.status("codex-agent").state).toBe("stopped");
  });
});
