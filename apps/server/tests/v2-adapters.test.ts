import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vite-plus/test";
import { CodexLhcAdapter } from "../src/v2/adapters/codex-lhc.ts";
import {
  LHC_HANDOFF_QUIESCE_COMMAND,
  LHC_HANDOFF_QUIESCE_RECEIPT_PREFIX,
  PiLhcAdapter,
} from "../src/v2/adapters/pi-lhc.ts";
import { MemoryJsonlPair } from "../src/v2/jsonl-transport.ts";
import type { HeldWriterLock } from "../src/v2/writer-lock.ts";

function piThreadEntries(threadId: string) {
  return [
    {
      type: "custom",
      customType: "pi-lhc.thread",
      data: { threadId },
    },
  ];
}

function attachPiRpcFixture(
  pair: MemoryJsonlPair,
  options: {
    sessionId?: string;
    threadId?: string;
    commands?: Array<{ name: string }>;
    handle?: (message: Record<string, unknown>) => boolean;
  } = {},
): { seen: Record<string, unknown>[] } {
  const seen: Record<string, unknown>[] = [];
  const sessionId = options.sessionId ?? "th_pi";
  const threadId = options.threadId ?? sessionId;
  const commands = options.commands ?? [{ name: LHC_HANDOFF_QUIESCE_COMMAND }];
  pair.server.onLine((line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    seen.push(message);
    if (options.handle?.(message)) return;
    if (message.type === "get_state") {
      pair.server.send({
        id: message.id,
        type: "response",
        command: "get_state",
        success: true,
        data: {
          thinkingLevel: "off",
          isStreaming: false,
          isCompacting: false,
          steeringMode: "one-at-a-time",
          followUpMode: "all",
          sessionId,
          autoCompactionEnabled: true,
          messageCount: 0,
          pendingMessageCount: 0,
        },
      });
      return;
    }
    if (message.type === "get_entries") {
      pair.server.send({
        id: message.id,
        type: "response",
        command: "get_entries",
        success: true,
        data: { entries: piThreadEntries(threadId), leafId: null },
      });
      return;
    }
    if (message.type === "get_commands") {
      pair.server.send({
        id: message.id,
        type: "response",
        command: "get_commands",
        success: true,
        data: { commands },
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
      return;
    }
    if (message.type === "get_last_assistant_text") {
      pair.server.send({
        id: message.id,
        type: "response",
        command: "get_last_assistant_text",
        success: true,
        data: { text: "pi says hi" },
      });
    }
  });
  return { seen };
}

function fakePiChild(
  respond: (message: Record<string, unknown>, send: (out: unknown) => void) => void,
): ChildProcess {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const events = new EventEmitter();
  const state = {
    pid: 4242,
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
  const rl = createInterface({ input: stdin }) as unknown as EventEmitter;
  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    respond(JSON.parse(trimmed) as Record<string, unknown>, (out) => {
      stdout.write(`${JSON.stringify(out)}\n`);
    });
  });
  return child;
}

describe("Codex-LHC JSON-RPC fixture", () => {
  it("maps initialize, thread/resume, turn/start, native steer fence, and interrupt", async () => {
    const pair = new MemoryJsonlPair();
    const seen: unknown[] = [];
    pair.server.onLine((line) => {
      const message = JSON.parse(line) as Record<string, unknown>;
      seen.push(message);
      if (message.method === "initialize") {
        pair.server.send({ id: message.id, result: { userAgent: "fixture" } });
      } else if (message.method === "thread/resume") {
        pair.server.send({ id: message.id, result: { thread: { id: "sess-1" } } });
      } else if (message.method === "turn/start") {
        pair.server.send({ id: message.id, result: { turn: { id: "codex-turn-1" } } });
        pair.server.send({
          method: "turn/started",
          params: { threadId: "sess-1", turn: { id: "codex-turn-1" } },
        });
        pair.server.send({
          method: "item/completed",
          params: {
            threadId: "sess-1",
            turnId: "codex-turn-1",
            item: { type: "agentMessage", id: "m1", text: "hi" },
          },
        });
      } else if (message.method === "turn/steer") {
        const params = message.params as { expectedTurnId?: string };
        if (params.expectedTurnId !== "codex-turn-1") {
          pair.server.send({ id: message.id, error: { message: "expectedTurnId mismatch" } });
        } else {
          pair.server.send({ id: message.id, result: { turnId: "codex-turn-1" } });
        }
      } else if (message.method === "turn/interrupt") {
        pair.server.send({ id: message.id, result: {} });
        pair.server.send({
          method: "turn/completed",
          params: { threadId: "sess-1", turn: { id: "codex-turn-1", status: "interrupted" } },
        });
      }
    });

    const adapter = new CodexLhcAdapter({ transport: pair.client });
    const events: string[] = [];
    adapter.on((event) => events.push(event.type));
    await expect(
      adapter.start({
        hostThreadId: "sess-1",
        canonicalThreadId: "th_codex",
        cwd: "/tmp",
        approvalPolicy: "bypass-at-spawn",
        proveCanonicalSession: async () => true,
      }),
    ).resolves.toBe("sess-1");
    expect(seen.some((message) => (message as { method?: string }).method === "initialize")).toBe(
      true,
    );
    const resume = seen.find(
      (message) => (message as { method?: string }).method === "thread/resume",
    ) as {
      params: { approvalPolicy?: string; sandbox?: string };
    };
    expect(resume.params.approvalPolicy).toBe("never");
    expect(resume.params.sandbox).toBe("danger-full-access");

    await expect(adapter.startTurn("hello")).resolves.toBe("codex-turn-1");
    await expect(adapter.steer("wrong", "nudge")).resolves.toBe("mismatch");
    await expect(adapter.steer("codex-turn-1", "nudge")).resolves.toBe("ok");
    await adapter.interrupt("codex-turn-1");
    expect(events).toContain("turnStarted");
    expect(events).toContain("item");
    expect(events).toContain("steerQueued");
    expect(events).toContain("turnCompleted");
    const adapterWithQuiesce = new CodexLhcAdapter({ transport: pair.client });
    await expect(adapterWithQuiesce.quiesceForHandoff()).resolves.toMatchObject({
      captureFlushed: false,
      compactQuiesced: false,
    });
  });

  it("does not invent a bypass when Q4 surface-server-requests is selected", async () => {
    const pair = new MemoryJsonlPair();
    const adapter = new CodexLhcAdapter({ transport: pair.client });
    await expect(
      adapter.start({
        hostThreadId: "sess-1",
        canonicalThreadId: "th_codex",
        cwd: "/tmp",
        approvalPolicy: "surface-server-requests",
      }),
    ).rejects.toThrow(/Q4 surface-server-requests is selectable but not implemented/);
  });
});

describe("Pi-LHC RPC fixture", () => {
  it("ignores imagined rpcSeamAvailable and still requires LHC-safe spawn or injected transport", async () => {
    const adapter = new PiLhcAdapter({ rpcSeamAvailable: true } as never);
    await expect(
      adapter.start({
        hostThreadId: "th_pi",
        canonicalThreadId: "th_pi",
        cwd: "/tmp",
        approvalPolicy: "bypass-at-spawn",
        args: ["--lhc-thread", "th_pi"],
      }),
    ).rejects.toThrow(/--mode rpc/);
  });

  it("spawns the LHC-safe pi-lhc launcher with --mode rpc and validates thread plus hooks", async () => {
    const spawned: {
      command?: string;
      args?: string[];
      writerLock?: HeldWriterLock | null;
    } = {};
    const lock = {
      resourceKey: "rk",
      fenceName: "\u0000lhc-v2-writer.rk",
      ownerPath: "/tmp/rk.owner",
      token: "tok",
      ownerPid: 1,
      ownerStartedAt: "2026-08-17T00:00:00.000Z",
      fd: 3,
    } satisfies HeldWriterLock;
    const adapter = new PiLhcAdapter({
      spawnProcess: (command, args, options) => {
        spawned.command = command;
        spawned.args = args;
        spawned.writerLock = options.writerLock ?? null;
        return fakePiChild((message, send) => {
          if (message.type === "get_state") {
            send({
              id: message.id,
              type: "response",
              command: "get_state",
              success: true,
              data: { sessionId: "pi-sess-1" },
            });
            return;
          }
          if (message.type === "get_entries") {
            send({
              id: message.id,
              type: "response",
              command: "get_entries",
              success: true,
              data: { entries: piThreadEntries("th_canonical"), leafId: null },
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
          }
        });
      },
    });
    await expect(
      adapter.start({
        hostThreadId: "sess-alias",
        canonicalThreadId: "th_canonical",
        cwd: "/tmp",
        approvalPolicy: "bypass-at-spawn",
        writerLock: lock,
      }),
    ).resolves.toBe("pi-sess-1");
    expect(spawned.command).toBe("pi-lhc");
    expect(spawned.args).toEqual(["--lhc-thread", "th_canonical", "--mode", "rpc"]);
    expect(spawned.writerLock).toBe(lock);
    expect(adapter.pid()).toBe(4242);
  });

  it("refuses bare pi and a launcher argv that is not --mode rpc", async () => {
    const adapter = new PiLhcAdapter({
      command: "pi",
      spawnProcess: () => {
        throw new Error("must not spawn");
      },
    });
    await expect(
      adapter.start({
        hostThreadId: "th_pi",
        canonicalThreadId: "th_pi",
        cwd: "/tmp",
        approvalPolicy: "bypass-at-spawn",
      }),
    ).rejects.toThrow(/bare pi|pi-lhc launcher/);
    const rpcMissing = new PiLhcAdapter({
      spawnProcess: () => {
        throw new Error("must not spawn");
      },
    });
    await expect(
      rpcMissing.start({
        hostThreadId: "th_pi",
        canonicalThreadId: "th_pi",
        cwd: "/tmp",
        approvalPolicy: "bypass-at-spawn",
        command: "pi-lhc",
        args: ["--lhc-thread", "th_pi"],
      }),
    ).rejects.toThrow(/--mode rpc/);
  });

  it("refuses a seeded LHC thread that does not match the requested canonical id", async () => {
    const pair = new MemoryJsonlPair();
    attachPiRpcFixture(pair, { sessionId: "pi-sess", threadId: "th_other" });
    const adapter = new PiLhcAdapter({ transport: pair.client });
    await expect(
      adapter.start({
        hostThreadId: "th_pi",
        canonicalThreadId: "th_pi",
        cwd: "/tmp",
        approvalPolicy: "bypass-at-spawn",
      }),
    ).rejects.toThrow(/does not match/);
  });

  it("refuses startup when the LHC handoff-quiesce command is not registered", async () => {
    const pair = new MemoryJsonlPair();
    attachPiRpcFixture(pair, { commands: [{ name: "lhc-export-threadview" }] });
    const adapter = new PiLhcAdapter({ transport: pair.client });
    await expect(
      adapter.start({
        hostThreadId: "th_pi",
        canonicalThreadId: "th_pi",
        cwd: "/tmp",
        approvalPolicy: "bypass-at-spawn",
      }),
    ).rejects.toThrow(/lhc-handoff-quiesce|LHC hook|not registered/);
  });

  it("maps prompt/steer/abort and treats agent_settled as completion", async () => {
    const pair = new MemoryJsonlPair();
    const { seen } = attachPiRpcFixture(pair, {
      handle: (message) => {
        if (message.type === "prompt") {
          pair.server.send({ id: message.id, type: "response", command: "prompt", success: true });
          pair.server.send({ type: "agent_start", runId: "pi-run-1" });
          pair.server.send({ type: "message_start", role: "assistant", text: "pi says hi" });
          pair.server.send({ type: "agent_end" });
          pair.server.send({ type: "agent_settled" });
          return true;
        }
        if (message.type === "steer") {
          pair.server.send({ id: message.id, type: "response", command: "steer", success: true });
          pair.server.send({
            type: "message_start",
            role: "user",
            text: message.message,
            requestId: message.id,
          });
          return true;
        }
        if (message.type === "abort") {
          pair.server.send({ id: message.id, type: "response", command: "abort", success: true });
          return true;
        }
        return false;
      },
    });

    const adapter = new PiLhcAdapter({ transport: pair.client });
    const events: string[] = [];
    adapter.on((event) => events.push(event.type));
    await expect(
      adapter.start({
        hostThreadId: "th_pi",
        canonicalThreadId: "th_pi",
        cwd: "/tmp",
        approvalPolicy: "bypass-at-spawn",
      }),
    ).resolves.toBe("th_pi");
    const native = await adapter.startTurn("hello");
    await expect(adapter.steer("other", "nudge")).resolves.toBe("mismatch");
    await expect(adapter.steer(native, "nudge")).resolves.toBe("ok");
    expect(events).toContain("turnStarted");
    expect(events).toContain("steerQueued");
    expect(events).toContain("steerConsumed");
    expect(events).toContain("turnCompleted");
    expect(events.filter((type) => type === "turnCompleted")).toHaveLength(1);
    expect(seen.some((message) => message.type === "follow_up")).toBe(false);
    expect(seen.some((message) => "lhcActive" in ((message.data as object) ?? {}))).toBe(false);
  });

  it("does not treat agent_end as V2 turn completion", async () => {
    const pair = new MemoryJsonlPair();
    attachPiRpcFixture(pair, {
      handle: (message) => {
        if (message.type === "prompt") {
          pair.server.send({ id: message.id, type: "response", command: "prompt", success: true });
          pair.server.send({ type: "agent_start", runId: "pi-run-end" });
          pair.server.send({ type: "agent_end" });
          return true;
        }
        return false;
      },
    });
    const adapter = new PiLhcAdapter({ transport: pair.client });
    const events: string[] = [];
    adapter.on((event) => events.push(event.type));
    await adapter.start({
      hostThreadId: "th_pi",
      canonicalThreadId: "th_pi",
      cwd: "/tmp",
      approvalPolicy: "bypass-at-spawn",
    });
    await adapter.startTurn("hello");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toContain("turnStarted");
    expect(events).toContain("item");
    expect(events).not.toContain("turnCompleted");
  });

  it("refuses handoff quiesce until the launcher flush receipt exists", async () => {
    const adapter = new PiLhcAdapter({ transport: new MemoryJsonlPair().client });
    await expect(adapter.quiesceForHandoff()).resolves.toMatchObject({
      captureFlushed: false,
      compactQuiesced: false,
    });
  });

  it("does not treat agent_settled as a capture flush or compact quiesce receipt", async () => {
    const pair = new MemoryJsonlPair();
    attachPiRpcFixture(pair, {
      handle: (message) => {
        if (message.type === "prompt" && message.message !== `/${LHC_HANDOFF_QUIESCE_COMMAND}`) {
          pair.server.send({ id: message.id, type: "response", command: "prompt", success: true });
          pair.server.send({ type: "agent_start", runId: "pi-run-settle" });
          pair.server.send({ type: "agent_settled" });
          return true;
        }
        if (message.type === "prompt" && message.message === `/${LHC_HANDOFF_QUIESCE_COMMAND}`) {
          pair.server.send({ id: message.id, type: "response", command: "prompt", success: true });
          return true;
        }
        return false;
      },
    });
    const adapter = new PiLhcAdapter({ transport: pair.client });
    await adapter.start({
      hostThreadId: "th_pi",
      canonicalThreadId: "th_pi",
      cwd: "/tmp",
      approvalPolicy: "bypass-at-spawn",
    });
    await adapter.startTurn("hello");
    await expect(adapter.quiesceForHandoff()).resolves.toMatchObject({
      captureFlushed: false,
      compactQuiesced: false,
    });
  });

  it("accepts handoff quiesce only from the structured LHC receipt, not prompt success", async () => {
    const pair = new MemoryJsonlPair();
    attachPiRpcFixture(pair, {
      handle: (message) => {
        if (message.type === "prompt" && message.message === `/${LHC_HANDOFF_QUIESCE_COMMAND}`) {
          pair.server.send({
            type: "extension_ui_request",
            id: "ui-1",
            method: "notify",
            notifyType: "info",
            message: `${LHC_HANDOFF_QUIESCE_RECEIPT_PREFIX} ${JSON.stringify({
              captureFlushed: true,
              compactQuiesced: true,
              threadId: "th_pi",
            })}`,
          });
          pair.server.send({ id: message.id, type: "response", command: "prompt", success: true });
          return true;
        }
        return false;
      },
    });
    const adapter = new PiLhcAdapter({ transport: pair.client });
    await adapter.start({
      hostThreadId: "th_pi",
      canonicalThreadId: "th_pi",
      cwd: "/tmp",
      approvalPolicy: "bypass-at-spawn",
    });
    await expect(adapter.quiesceForHandoff()).resolves.toMatchObject({
      captureFlushed: true,
      compactQuiesced: true,
    });
  });

  it("rejects in-flight RPCs and clears the child on crash or stop", async () => {
    const adapter = new PiLhcAdapter({
      spawnProcess: () =>
        fakePiChild((message, send) => {
          if (message.type === "get_state") {
            send({
              id: message.id,
              type: "response",
              command: "get_state",
              success: true,
              data: { sessionId: "pi-sess-1" },
            });
            return;
          }
          if (message.type === "get_entries") {
            send({
              id: message.id,
              type: "response",
              command: "get_entries",
              success: true,
              data: { entries: piThreadEntries("th_pi"), leafId: null },
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
          }
        }),
    });
    await adapter.start({
      hostThreadId: "th_pi",
      canonicalThreadId: "th_pi",
      cwd: "/tmp",
      approvalPolicy: "bypass-at-spawn",
    });
    const pending = adapter.startTurn("hello");
    adapter.rejectPendingForTest("pi-lhc runtime exited");
    await expect(pending).rejects.toThrow(/exited/);
    const exit = await adapter.stop("kill");
    expect(exit.code === 137 || exit.code === 0).toBe(true);
    expect(adapter.pid()).toBeNull();
  });
});

describe("adapter child-process failure containment", () => {
  const startInput = {
    hostThreadId: "sess-none",
    canonicalThreadId: "th_none",
    cwd: "/tmp",
    approvalPolicy: "bypass-at-spawn" as const,
  };

  async function withUncaughtCapture<T>(run: () => Promise<T>): Promise<{
    result: T;
    uncaught: unknown[];
  }> {
    const uncaught: unknown[] = [];
    const handler = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", handler);
    try {
      const result = await run();
      // Let any stray child "error"/stream events flush before we look.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { result, uncaught };
    } finally {
      process.off("uncaughtException", handler);
    }
  }

  it("codex-lhc rejects start for a nonexistent executable without crashing or hanging", async () => {
    const adapter = new CodexLhcAdapter({
      command: "/nonexistent/lhc-codex-binary",
      args: ["app-server"],
    });
    const { result: outcome, uncaught } = await withUncaughtCapture(async () => {
      await expect(adapter.start(startInput)).rejects.toThrow(
        /codex-lhc child process failed: .*ENOENT/,
      );
      // Manager cleanup path: stop("kill") must resolve even though the
      // child never spawned and will never emit "exit".
      return adapter.stop("kill");
    });
    // Node either never emits "exit" for a failed spawn (older) or emits it
    // with a negative errno code (newer); both must resolve without a signal.
    expect(outcome.signal).toBeNull();
    expect(outcome.code === null || outcome.code < 0).toBe(true);
    expect(adapter.pid()).toBeNull();
    expect(uncaught).toEqual([]);
  });

  it("pi-lhc rejects start for a nonexistent executable without crashing or hanging", async () => {
    const adapter = new PiLhcAdapter({
      command: "/nonexistent/lhc-pi-binary",
      args: ["--mode", "rpc"],
    });
    const { result: outcome, uncaught } = await withUncaughtCapture(async () => {
      await expect(adapter.start(startInput)).rejects.toThrow(
        /pi-lhc child process failed: .*ENOENT/,
      );
      return adapter.stop("kill");
    });
    // Node either never emits "exit" for a failed spawn (older) or emits it
    // with a negative errno code (newer); both must resolve without a signal.
    expect(outcome.signal).toBeNull();
    expect(outcome.code === null || outcome.code < 0).toBe(true);
    expect(adapter.pid()).toBeNull();
    expect(uncaught).toEqual([]);
  });

  it("pi-lhc drains a large stderr producer and surfaces a bounded tail as evidence", async () => {
    // 1 MiB of stderr far exceeds the ~64 KiB pipe buffer: without a drain
    // the child blocks on write and never exits, and this test times out.
    const script = "process.stderr.write(Buffer.alloc(1024 * 1024, 'x')); process.exit(0);";
    const adapter = new PiLhcAdapter({
      command: process.execPath,
      args: ["-e", script, "rpc"],
    });
    const { result: error, uncaught } = await withUncaughtCapture(async () => {
      const failure = await adapter.start(startInput).then(
        () => null,
        (thrown: unknown) => thrown as Error,
      );
      await adapter.stop("kill");
      return failure;
    });
    expect(uncaught).toEqual([]);
    // The child exited (proving its 1 MiB stderr was drained past the ~64 KiB
    // pipe buffer) and the rejection carries stderr evidence, bounded.
    expect(error?.message).toMatch(/pi-lhc runtime exited \(stderr tail: x+/);
    expect(error!.message.length).toBeLessThan(16_384);
  });
});
