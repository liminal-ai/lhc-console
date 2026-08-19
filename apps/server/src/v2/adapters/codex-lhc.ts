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
import {
  GRACEFUL_STOP_TIMEOUT_MS,
  KILL_SETTLE_TIMEOUT_MS,
  killHard,
  waitExitBounded,
} from "../stop-escalation.ts";
import { spawnFencedChild, type HeldWriterLock } from "../writer-lock.ts";

const RPC_TIMEOUT_MS = 30_000;
/** Bytes of child stderr kept for failure evidence. Older bytes are dropped. */
const STDERR_TAIL_BYTES = 8_192;
/** Lines of that tail quoted into an error message. */
const STDERR_TAIL_LINES = 5;
/** Config warnings retained from one app-server startup. */
const MAX_CONFIG_WARNINGS = 20;

/**
 * A `configWarning` notification the app-server sent after `initialize`
 * (`codex-rs/app-server-protocol/src/protocol/v2/config.rs` —
 * `ConfigWarningNotification`). These are non-fatal by protocol: the server
 * keeps running, having fallen back to defaults or dropped custom rules. They
 * are kept because they explain a child that starts but behaves unlike the
 * seat it was configured as, and dropping them silently would leave that
 * unexplained.
 */
export interface CodexConfigWarning {
  summary: string;
  details?: string;
  path?: string;
}

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
  /**
   * Where config warnings are reported. Defaults to the console's own error
   * log so a warning is never only visible to whoever thinks to ask for it.
   */
  onConfigWarning?: (warning: CodexConfigWarning) => void;
  /** Test override: graceful-stop wait before SIGKILL escalation. */
  gracefulStopTimeoutMs?: number;
  /** Test override: post-SIGKILL settlement wait. */
  killSettleTimeoutMs?: number;
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
  #stderrTail = "";
  #childError: Error | null = null;
  readonly #configWarnings: CodexConfigWarning[] = [];

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

  /** Config warnings this app-server reported, oldest first. */
  configWarnings(): CodexConfigWarning[] {
    return [...this.#configWarnings];
  }

  async getState(): Promise<Record<string, unknown>> {
    return {
      nativeThreadRef: this.#nativeThreadRef,
      activeNativeTurnId: this.#activeNativeTurnId,
      configWarnings: this.configWarnings(),
      stderrTail: this.#tailLines(),
    };
  }

  async start(input: AdapterStartInput): Promise<string> {
    try {
      return await this.#start(input);
    } catch (error) {
      // Startup failures are the case where the child's own stderr is the only
      // account of what went wrong, so it is attached here rather than lost.
      throw this.#withStartEvidence(error);
    }
  }

  async #start(input: AdapterStartInput): Promise<string> {
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
    let exit: { code: number | null; signal: NodeJS.Signals | null };
    if (mode === "kill" && this.#child?.pid) {
      try {
        process.kill(-this.#child.pid, "SIGKILL");
      } catch {
        this.#child.kill("SIGKILL");
      }
      exit = await this.#waitExit();
    } else {
      this.#transport?.close();
      this.#child?.kill("SIGTERM");
      exit = await this.#waitExitEscalating();
    }
    this.#cleanup();
    this.#emit({ type: "exited", code: exit.code, signal: exit.signal });
    return exit;
  }

  #spawn(input: AdapterStartInput): JsonlTransport {
    // Evidence is per-child: a restart must not inherit the previous one's.
    this.#stderrTail = "";
    this.#configWarnings.length = 0;
    this.#childError = null;
    const command = input.command ?? this.#options.command ?? "codex-lhc";
    const args = input.args ?? this.#options.args ?? ["app-server"];
    const spawnProcess = this.#options.spawnProcess ?? defaultSpawn;
    this.#child = spawnProcess(command, args, {
      cwd: input.cwd,
      env: { ...scrubbedEnv({}), ...input.env },
      writerLock: input.writerLock,
    });
    // Subscribed before anything can await on the child: an unhandled
    // ChildProcess "error" (spawn ENOENT, kill failure) crashes the whole
    // server, and a failed spawn never emits "exit", so this is the only
    // signal that turns a bad executable into a bounded start rejection.
    (this.#child as unknown as EventEmitter).on("error", (error: Error) => {
      const failure = new ProviderUnavailableError(
        `codex-lhc child process failed: ${error.message}`,
      );
      if (!this.#childError) this.#childError = failure;
      this.#rejectPending(failure);
    });
    (this.#child as unknown as EventEmitter).on(
      "exit",
      (code: number | null, signal: NodeJS.Signals | null) => {
        this.#rejectPending(new Error("codex-lhc runtime exited"));
        this.#emit({ type: "exited", code, signal });
      },
    );
    this.#drainStderr(this.#child);
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
    if (method === "configWarning") {
      this.#recordConfigWarning(params);
      return;
    }
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

  /**
   * Keep the child's stderr moving. A piped stderr nobody reads fills its OS
   * buffer and blocks the writer — the app-server logs there, so an unread
   * pipe can wedge the very process this adapter is waiting on. Only the tail
   * is kept; the rest is discarded as it arrives.
   */
  #drainStderr(child: ChildProcess): void {
    const stderr = child.stderr;
    if (!stderr) return;
    stderr.setEncoding("utf8");
    (stderr as unknown as EventEmitter).on("data", (chunk: string) => {
      this.#stderrTail = `${this.#stderrTail}${chunk}`.slice(-STDERR_TAIL_BYTES);
    });
    // A stderr error must not take the runtime down; the tail simply stops.
    (stderr as unknown as EventEmitter).on("error", () => {});
  }

  /** Last few non-empty stderr lines, oldest first. Empty when nothing arrived. */
  #tailLines(): string[] {
    return this.#stderrTail
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-STDERR_TAIL_LINES);
  }

  /**
   * Attach start-failure evidence without changing what the error *is*: the
   * runtime manager classifies rejections by error class, so a decorated
   * `ProviderUnavailableError` must stay one.
   */
  #withStartEvidence(error: unknown): Error {
    const base = error instanceof Error ? error : new Error(String(error));
    const parts: string[] = [];
    const tail = this.#tailLines();
    if (tail.length > 0) parts.push(`stderr tail: ${tail.join(" / ")}`);
    if (this.#configWarnings.length > 0) {
      parts.push(
        `config warnings: ${this.#configWarnings.map((warning) => warning.summary).join(" / ")}`,
      );
    }
    if (parts.length === 0) return base;
    const message = `${base.message} (${parts.join("; ")})`;
    const decorated =
      base instanceof ProviderUnavailableError
        ? new ProviderUnavailableError(message)
        : new Error(message);
    decorated.stack = base.stack;
    return decorated;
  }

  /**
   * `configWarning` is advisory, not a failure: the app-server has already
   * decided to continue (defaults loaded, custom rules dropped). Reporting it
   * as a start failure would be a lie in one direction and dropping it would
   * be a lie in the other, so it is recorded and surfaced as evidence.
   */
  #recordConfigWarning(params: Record<string, unknown>): void {
    const summary = typeof params.summary === "string" ? params.summary.trim() : "";
    if (!summary) return;
    const details = typeof params.details === "string" ? params.details.trim() : "";
    const path = typeof params.path === "string" ? params.path.trim() : "";
    const warning: CodexConfigWarning = {
      summary,
      ...(details ? { details } : {}),
      ...(path ? { path } : {}),
    };
    // Reported every time; retained only up to the cap, so a warning storm
    // bounds memory without any warning going unreported.
    (this.#options.onConfigWarning ?? logConfigWarning)(warning);
    if (this.#configWarnings.length >= MAX_CONFIG_WARNINGS) return;
    this.#configWarnings.push(warning);
  }

  #rpc(method: string, params: unknown): Promise<unknown> {
    if (!this.#transport) throw new ProviderUnavailableError("codex-lhc transport is not started");
    if (this.#childError) return Promise.reject(this.#childError);
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
    // A child that failed to spawn (no pid) will never emit "exit"; waiting
    // on it would hang stop() forever.
    if (this.#childError && this.#child.pid === undefined) return { code: null, signal: null };
    return await new Promise((resolve) => {
      (this.#child as unknown as EventEmitter).once(
        "exit",
        (code: number | null, signal: NodeJS.Signals | null) => resolve({ code, signal }),
      );
    });
  }

  /**
   * Graceful-stop wait, bounded so a child that ignores EOF/SIGTERM cannot
   * wedge the per-target command queue: escalate to SIGKILL after the grace
   * window, then settle within a final bound even if "exit" never arrives.
   */
  async #waitExitEscalating(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    const child = this.#child;
    if (!child) return { code: 0, signal: null };
    if (this.#childError && child.pid === undefined) return { code: null, signal: null };
    const graceful = await waitExitBounded(
      child,
      this.#options.gracefulStopTimeoutMs ?? GRACEFUL_STOP_TIMEOUT_MS,
    );
    if (graceful.exited) return { code: graceful.code, signal: graceful.signal };
    killHard(child);
    const settled = await waitExitBounded(
      child,
      this.#options.killSettleTimeoutMs ?? KILL_SETTLE_TIMEOUT_MS,
    );
    return { code: settled.code, signal: settled.signal };
  }

  #cleanup(): void {
    this.#unsub?.();
    this.#unsub = null;
    this.#transport = null;
    this.#child = null;
    this.#nativeThreadRef = null;
    this.#activeNativeTurnId = null;
    this.#childError = null;
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

function logConfigWarning(warning: CodexConfigWarning): void {
  const details = warning.details ? ` — ${warning.details}` : "";
  const path = warning.path ? ` (${warning.path})` : "";
  console.error(`codex-lhc app-server config warning: ${warning.summary}${details}${path}`);
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
