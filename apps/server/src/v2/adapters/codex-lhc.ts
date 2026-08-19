import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { scrubbedEnv } from "../../tmux.ts";
import type {
  AdapterStartInput,
  AdapterSteerResult,
  ProviderAdapter,
  ProviderListener,
  ProviderNotification,
} from "../adapter.ts";
import { PROVIDER_CAPABILITIES, ProviderUnavailableError } from "../adapter.ts";
import type { V2StopMode } from "../contract.ts";
import { StreamJsonlTransport, type JsonlTransport } from "../jsonl-transport.ts";
import { spawnFencedChild, type HeldWriterLock } from "../writer-lock.ts";

const RPC_TIMEOUT_MS = 30_000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
  timer: NodeJS.Timeout;
}

export interface CodexLhcAdapterOptions {
  transport?: JsonlTransport;
  spawnProcess?: (
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; writerLock?: HeldWriterLock | null },
  ) => ChildProcess;
  command?: string;
  args?: string[];
}

/**
 * Thin Codex-LHC adapter over app-server JSON-RPC (JSONL, no Content-Length).
 * Does not hold queues, fences, or ownership.
 */
export class CodexLhcAdapter implements ProviderAdapter {
  readonly provider = "codex-lhc" as const;
  readonly capabilities = PROVIDER_CAPABILITIES["codex-lhc"];
  readonly #events = new EventEmitter();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #options: CodexLhcAdapterOptions;
  #transport: JsonlTransport | null = null;
  #child: ChildProcess | null = null;
  #unsub: (() => void) | null = null;
  #nextId = 1;
  #nativeThreadRef: string | null = null;
  #activeNativeTurnId: string | null = null;
  #lastAgentText = "";

  constructor(options: CodexLhcAdapterOptions = {}) {
    this.#options = options;
  }

  on(listener: ProviderListener): () => void {
    this.#events.on("event", listener);
    return () => this.#events.off("event", listener);
  }

  pid(): number | null {
    return this.#child?.pid ?? null;
  }

  /** Test helper: simulate child death while RPCs are in flight. */
  rejectPendingForTest(message = "codex-lhc runtime exited"): void {
    this.#rejectPending(new Error(message));
  }

  async start(input: AdapterStartInput): Promise<string> {
    if (input.approvalPolicy === "surface-server-requests") {
      throw new ProviderUnavailableError(
        "Q4 surface-server-requests is selectable but not implemented: Codex serverRequest handling is unsupported in this plane",
      );
    }
    this.#transport = this.#options.transport ?? this.#spawn(input);
    this.#unsub = this.#transport.onLine((line) => this.#onLine(line));
    await this.#rpc("initialize", {
      clientInfo: { name: "lhc-console-v2", version: "0.0.0" },
    });
    this.#transport.send({ method: "initialized" });
    const resumeParams: Record<string, unknown> = { threadId: input.hostThreadId };
    if (input.approvalPolicy === "bypass-at-spawn") {
      resumeParams.approvalPolicy = "never";
      resumeParams.sandbox = "danger-full-access";
    }
    const result = (await this.#rpc("thread/resume", resumeParams)) as {
      thread?: { id?: string };
    };
    const native = result.thread?.id;
    if (!native) {
      throw new ProviderUnavailableError("codex-lhc thread/resume returned no native session id");
    }
    if (input.proveCanonicalSession) {
      const mapped = await input.proveCanonicalSession(native, input.canonicalThreadId);
      if (!mapped) {
        throw new ProviderUnavailableError(
          `codex-lhc native session ${native} does not map to configured canonical LHC thread ${input.canonicalThreadId}`,
        );
      }
    } else if (native !== input.hostThreadId && native !== input.canonicalThreadId) {
      throw new ProviderUnavailableError(
        `codex-lhc native session ${native} does not map to configured canonical LHC thread ${input.canonicalThreadId}`,
      );
    }
    this.#nativeThreadRef = native;
    this.#emit({ type: "threadAttached", nativeThreadRef: native });
    return native;
  }

  async startTurn(text: string): Promise<string> {
    if (!this.#nativeThreadRef)
      throw new ProviderUnavailableError("codex-lhc thread is not attached");
    this.#lastAgentText = "";
    const result = (await this.#rpc("turn/start", {
      threadId: this.#nativeThreadRef,
      input: [{ type: "text", text }],
    })) as { turn?: { id?: string } };
    const nativeTurnId = result.turn?.id;
    if (!nativeTurnId)
      throw new ProviderUnavailableError("codex-lhc turn/start returned no turn id");
    this.#activeNativeTurnId = nativeTurnId;
    return nativeTurnId;
  }

  async steer(nativeTurnId: string, text: string): Promise<AdapterSteerResult> {
    if (!this.#nativeThreadRef) return "unsupported";
    try {
      await this.#rpc("turn/steer", {
        threadId: this.#nativeThreadRef,
        expectedTurnId: nativeTurnId,
        input: [{ type: "text", text }],
      });
      this.#emit({ type: "steerQueued", nativeTurnId });
      return "ok";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/mismatch|expectedTurn|not active|no active/i.test(message)) return "mismatch";
      throw error;
    }
  }

  async quiesceForHandoff(): Promise<{
    captureFlushed: boolean;
    compactQuiesced: boolean;
    evidence?: Record<string, unknown>;
  }> {
    // Host flush/quiesce is a remaining real-seat proof obligation. Absence
    // must fail handoff rather than invent a receipt.
    return { captureFlushed: false, compactQuiesced: false, evidence: { source: "unimplemented" } };
  }

  async interrupt(nativeTurnId: string): Promise<void> {
    if (!this.#nativeThreadRef)
      throw new ProviderUnavailableError("codex-lhc thread is not attached");
    await this.#rpc("turn/interrupt", {
      threadId: this.#nativeThreadRef,
      turnId: nativeTurnId,
    });
  }

  async stop(mode: V2StopMode): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (mode === "kill" && this.#child?.pid) {
      try {
        process.kill(-this.#child.pid, "SIGKILL");
      } catch {
        this.#child.kill("SIGKILL");
      }
    } else {
      this.#transport?.close();
      this.#child?.kill(mode === "interrupt" ? "SIGTERM" : "SIGTERM");
    }
    const exit = await this.#waitExit();
    this.#cleanup();
    this.#emit({ type: "exited", code: exit.code, signal: exit.signal });
    return exit;
  }

  #spawn(input: AdapterStartInput): JsonlTransport {
    const command = input.command ?? this.#options.command ?? "codex-lhc";
    const args = input.args ?? this.#options.args ?? ["app-server"];
    const spawnProcess = this.#options.spawnProcess ?? defaultSpawn;
    this.#child = spawnProcess(command, args, {
      cwd: input.cwd,
      env: { ...scrubbedEnv({}), ...input.env },
      writerLock: input.writerLock,
    });
    (this.#child as unknown as EventEmitter).on(
      "exit",
      (code: number | null, signal: NodeJS.Signals | null) => {
        this.#rejectPending(new Error("codex-lhc runtime exited"));
        this.#emit({ type: "exited", code, signal });
      },
    );
    return new StreamJsonlTransport(this.#child);
  }

  #onLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const id =
        typeof message.id === "string" || typeof message.id === "number" ? String(message.id) : "";
      const pending = this.#pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      if (message.error) {
        const err = message.error as { message?: string };
        pending.reject(new Error(err.message ?? JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    const method = typeof message.method === "string" ? message.method : "";
    const params = (message.params ?? {}) as Record<string, unknown>;
    this.#handleNotification(method, params);
  }

  #handleNotification(method: string, params: Record<string, unknown>): void {
    if (method === "turn/started") {
      const turn = params.turn as { id?: string } | undefined;
      const nativeTurnId = turn?.id;
      if (
        !nativeTurnId ||
        (this.#activeNativeTurnId && nativeTurnId !== this.#activeNativeTurnId)
      ) {
        return;
      }
      this.#activeNativeTurnId = nativeTurnId;
      this.#emit({ type: "turnStarted", nativeTurnId });
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      const item = params.item as { type?: string; text?: string; id?: string } | undefined;
      const nativeTurnId = typeof params.turnId === "string" ? params.turnId : "";
      if (!nativeTurnId || nativeTurnId !== this.#activeNativeTurnId) return;
      if (item?.type === "userMessage") {
        // Codex app-server provides no exact steer-to-item correlation.
        // Do not claim consumed from positional order — steers settle as
        // not_consumed at turn end via #settleSteers.
        return;
      }
      if (method === "item/started") return;
      if (item?.type === "agentMessage" && typeof item.text === "string") {
        this.#lastAgentText = item.text;
        this.#emit({
          type: "item",
          nativeTurnId,
          item: { type: "agent_message", text: item.text, nativeItemId: item.id },
        });
        return;
      }
      this.#emit({
        type: "item",
        nativeTurnId,
        item: {
          type: item?.type === "commandExecution" ? "tool" : "other",
          nativeItemId: item?.id,
        },
      });
      return;
    }
    if (method === "turn/completed") {
      const turn = params.turn as { id?: string; status?: string } | undefined;
      const nativeTurnId = turn?.id ?? "";
      if (!nativeTurnId || nativeTurnId !== this.#activeNativeTurnId) return;
      const status = (turn?.status ?? "completed").toLowerCase();
      const outcome =
        status === "interrupted" ? "interrupted" : status === "failed" ? "failed" : "completed";
      this.#emit({
        type: "turnCompleted",
        nativeTurnId,
        outcome,
        finalText: this.#lastAgentText || undefined,
      });
      this.#activeNativeTurnId = null;
      return;
    }
    if (method === "serverRequest" || method === "item/serverRequest") {
      this.#emit({
        type: "item",
        nativeTurnId: this.#activeNativeTurnId ?? "",
        item: {
          type: "other",
          text: "serverRequest",
          nativeItemId: typeof params.id === "string" ? params.id : "",
        },
      });
    }
  }

  #rpc(method: string, params: unknown): Promise<unknown> {
    if (!this.#transport) throw new ProviderUnavailableError("codex-lhc transport is not started");
    const id = String(this.#nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pending.has(id)) return;
        this.#pending.delete(id);
        reject(new Error(`codex-lhc ${method} timed out after ${RPC_TIMEOUT_MS}ms`));
      }, RPC_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, method, timer });
      this.#transport!.send({ id, method, params });
    });
  }

  #emit(event: ProviderNotification): void {
    this.#events.emit("event", event);
  }

  async #waitExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (!this.#child) return { code: 0, signal: null };
    if (this.#child.exitCode !== null)
      return { code: this.#child.exitCode, signal: this.#child.signalCode };
    return await new Promise((resolve) => {
      (this.#child as unknown as EventEmitter).once(
        "exit",
        (code: number | null, signal: NodeJS.Signals | null) => resolve({ code, signal }),
      );
    });
  }

  #cleanup(): void {
    this.#unsub?.();
    this.#unsub = null;
    this.#transport = null;
    this.#child = null;
    this.#nativeThreadRef = null;
    this.#activeNativeTurnId = null;
    this.#rejectPending(new Error("codex-lhc runtime stopped"));
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function defaultSpawn(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; writerLock?: HeldWriterLock | null },
): ChildProcess {
  if (options.writerLock) {
    return spawnFencedChild({
      command,
      args,
      cwd: options.cwd,
      env: options.env,
      held: options.writerLock,
    });
  }
  return spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}
