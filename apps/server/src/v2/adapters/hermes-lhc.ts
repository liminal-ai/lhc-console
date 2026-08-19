import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { scrubbedEnv } from "../../tmux.ts";
import type {
  AdapterStartInput,
  AdapterStartState,
  AdapterSteerResult,
  ProviderAdapter,
  ProviderListener,
  ProviderNotification,
} from "../adapter.ts";
import {
  PROVIDER_CAPABILITIES,
  ProviderUnavailableError,
  ProviderUnsupportedError,
} from "../adapter.ts";
import type { V2StopMode, V2TurnOutcome } from "../contract.ts";
import { StreamJsonlTransport, type JsonlTransport } from "../jsonl-transport.ts";
import {
  GRACEFUL_STOP_TIMEOUT_MS,
  KILL_SETTLE_TIMEOUT_MS,
  killHard,
  StopUnprovenError,
  waitExitBounded,
  type BoundedExit,
} from "../stop-escalation.ts";
import { spawnFencedChild, type HeldWriterLock } from "../writer-lock.ts";

const RPC_TIMEOUT_MS = 30_000;
/** Bytes of child stderr kept for failure evidence. Older bytes are dropped. */
const STDERR_TAIL_BYTES = 8_192;
/** Lines of that tail quoted into an error message. */
const STDERR_TAIL_LINES = 5;
/**
 * The worker reaps idle sessions after HERMES_TUI_SESSION_TTL_S with no stdio
 * frame; a generous TTL for the worker this adapter owns keeps the only
 * session alive, and a 4007 afterwards is treated as the reap evidence.
 */
const DEFAULT_SESSION_TTL_S = "86400";

/** Hermes app error code: unsupported capability. */
const HERMES_UNSUPPORTED_CODE = 4010;
/** Hermes app error code: unknown session (post-reap evidence). */
const HERMES_UNKNOWN_SESSION_CODE = 4007;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
  timer: NodeJS.Timeout;
}

export interface HermesLhcAdapterOptions {
  transport?: JsonlTransport;
  spawnProcess?: (
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; writerLock?: HeldWriterLock | null },
  ) => ChildProcess;
  command?: string;
  args?: string[];
  /** Test override: bounded wait for the worker's gateway.ready frame. */
  readyTimeoutMs?: number;
  /** Test override: graceful-stop wait before SIGKILL escalation. */
  gracefulStopTimeoutMs?: number;
  /** Test override: post-SIGKILL settlement wait. */
  killSettleTimeoutMs?: number;
}

export function correlateHermesNativeTurnId(runtimeGeneration: number, requestId: string): string {
  return `hermes-rpc:${runtimeGeneration}:${requestId}`;
}

/**
 * Thin Hermes V2 adapter over a supervised `python -m tui_gateway.entry`
 * worker speaking newline-delimited JSON-RPC 2.0 on stdio.
 *
 * Hermes events carry no turn id; the session's single-active-turn invariant
 * is the correlation, so the adapter mints `hermes-rpc:<gen>:<reqId>` from the
 * prompt.submit request id and maps every event between the accepted submit
 * and the terminal `message.complete` to it. The worker binds to its
 * disposable profile home only through the HERMES_HOME environment variable;
 * the RPC `profile` parameter is never passed (O4).
 */
export class HermesLhcAdapter implements ProviderAdapter {
  readonly provider = "hermes" as const;
  readonly capabilities = PROVIDER_CAPABILITIES.hermes;
  readonly #events = new EventEmitter();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #options: HermesLhcAdapterOptions;
  #transport: JsonlTransport | null = null;
  #child: ChildProcess | null = null;
  #unsub: (() => void) | null = null;
  #nextId = 1;
  #runtimeGeneration = 0;
  /**
   * Durable native reference: the stored session key (`resumed`/`session_key`
   * in the resume payload) that the canonical store's own resume recipe names.
   * This is the identity that persists across gateway restarts.
   */
  #sessionKey: string | null = null;
  /**
   * Ephemeral live session id (`session_id` in the resume payload): the
   * gateway-session handle every subsequent RPC must address. It dies with
   * the worker and proves nothing about identity.
   */
  #liveSid: string | null = null;
  #startState: AdapterStartState | null = null;
  #activeNativeTurnId: string | null = null;
  /**
   * Events received between sending prompt.submit and its response. The
   * gateway runs the turn on a daemon thread, so message.start — or even the
   * terminal message.complete — can hit the wire before the RPC response;
   * replaying them after the caller has recorded the minted turn id is what
   * keeps a fast turn from being dropped or leaving the manager active.
   */
  #pendingSubmit: { nativeTurnId: string; buffered: Record<string, unknown>[] } | null = null;
  #turnStartedEmitted = false;
  #finalTextBuffer = "";
  #lastSubmitStatus: string | null = null;
  #stopping = false;
  #stderrTail = "";
  #childError: Error | null = null;
  #ready = false;
  #readyWaiters: Array<() => void> = [];
  #readyFailures: Array<(error: Error) => void> = [];

  constructor(options: HermesLhcAdapterOptions = {}) {
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
  rejectPendingForTest(message = "hermes runtime exited"): void {
    this.#rejectPending(new Error(message));
  }

  async getState(): Promise<Record<string, unknown>> {
    return {
      nativeThreadRef: this.#sessionKey,
      liveSessionId: this.#liveSid,
      activeNativeTurnId: this.#activeNativeTurnId,
      lastSubmitStatus: this.#lastSubmitStatus,
      startState: this.#startState,
      stderrTail: this.#tailLines(),
    };
  }

  startEvidence(): AdapterStartState {
    return (
      this.#startState ?? {
        kind: "unproven",
        reasons: ["no resume evidence recorded"],
        evidence: {},
      }
    );
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
    if (!input.env?.HERMES_HOME) {
      // An unset HERMES_HOME resolves to the operator's default home; a worker
      // silently binding it is exactly the failure explicit HERMES_HOME
      // prevents, so the adapter refuses to start without one.
      throw new ProviderUnavailableError(
        "hermes V2 requires an explicit disposable HERMES_HOME in the target's v2.env; refusing to bind the default profile home",
      );
    }
    this.#transport = this.#options.transport ?? this.#spawn(input);
    this.#unsub = this.#transport.onLine((line) => this.#onLine(line));
    this.#runtimeGeneration = input.runtimeGeneration ?? 0;
    await this.#waitReady();
    const result = (await this.#rpc("session.resume", {
      session_id: input.hostThreadId,
    })) as Record<string, unknown>;
    // The resume payload carries two identities with different lifetimes:
    // `session_id` is a freshly minted ephemeral gateway-session handle (the
    // SID all later RPCs must address) while `resumed`/`session_key` name the
    // durable stored conversation the gateway actually attached. Only the
    // durable reference is identity; only the live SID is addressable.
    const liveSid = nonEmptyString(result.session_id);
    const sessionKey = nonEmptyString(result.resumed) ?? nonEmptyString(result.session_key);
    if (!liveSid) {
      throw new ProviderUnavailableError(
        "hermes session.resume returned no live session_id; refusing to invent an RPC handle",
      );
    }
    if (!sessionKey) {
      throw new ProviderUnavailableError(
        "hermes session.resume returned no durable resumed/session_key reference; refusing to invent a thread identity",
      );
    }
    if (!input.proveCanonicalSession) {
      // String equality between the resumed session key and configured thread
      // ids is not identity evidence; only a canonical-store proof is.
      throw new ProviderUnavailableError(
        `hermes resume attached stored session ${sessionKey} but no canonical identity prover was supplied; refusing string-equality identity for ${input.canonicalThreadId}`,
      );
    }
    const mapped = await input.proveCanonicalSession(sessionKey, input.canonicalThreadId);
    if (!mapped) {
      throw new ProviderUnavailableError(
        `hermes session ${sessionKey} does not map to configured canonical LHC thread ${input.canonicalThreadId}`,
      );
    }
    this.#liveSid = liveSid;
    this.#sessionKey = sessionKey;
    this.#startState = resumeStartState(result);
    this.#emit({ type: "threadAttached", nativeThreadRef: sessionKey });
    return sessionKey;
  }

  async startTurn(text: string): Promise<string> {
    if (!this.#transport || !this.#liveSid) {
      throw new ProviderUnavailableError("hermes session is not attached");
    }
    if (this.#activeNativeTurnId) {
      // The gateway's default busy_input_mode redirects the live turn in
      // place, so a busy submit could cancel-and-replace the very turn it
      // duplicates. Refusing here keeps the single-active-turn invariant that
      // all event correlation rests on.
      throw new ProviderUnavailableError(
        "hermes adapter refuses prompt.submit while a turn is active: a busy submit redirects the live turn",
      );
    }
    this.#finalTextBuffer = "";
    this.#turnStartedEmitted = false;
    const requestId = String(this.#nextId++);
    const nativeTurnId = correlateHermesNativeTurnId(this.#runtimeGeneration, requestId);
    this.#activeNativeTurnId = nativeTurnId;
    // Turn events can beat the prompt.submit response onto the wire (the
    // gateway answers from a daemon thread). Buffer them under this turn's
    // generation and replay after the caller's own post-await bookkeeping —
    // otherwise a terminal frame that raced the response is dropped and the
    // manager stays active forever.
    this.#pendingSubmit = { nativeTurnId, buffered: [] };
    try {
      const result = (await this.#rpc(
        "prompt.submit",
        { session_id: this.#liveSid, text },
        requestId,
      )) as Record<string, unknown>;
      this.#lastSubmitStatus = typeof result.status === "string" ? result.status : null;
    } catch (error) {
      this.#pendingSubmit = null;
      this.#activeNativeTurnId = null;
      throw error;
    }
    const pending = this.#pendingSubmit;
    this.#pendingSubmit = null;
    if (pending && pending.buffered.length > 0) {
      // setImmediate runs after the caller's microtask continuation (where the
      // manager records the minted turn id), so replayed events correlate.
      setImmediate(() => {
        for (const params of pending.buffered) {
          if (this.#activeNativeTurnId !== pending.nativeTurnId) return;
          this.#handleEvent(typeof params.type === "string" ? params.type : "", params);
        }
      });
    }
    return nativeTurnId;
  }

  async steer(nativeTurnId: string, text: string): Promise<AdapterSteerResult> {
    // Adapter-side fence: Hermes steering authority is transport-bound, not
    // turn-bound, so the expected-turn check lives here.
    if (!this.#activeNativeTurnId) return "mismatch";
    if (this.#activeNativeTurnId !== nativeTurnId) return "mismatch";
    const result = (await this.#rpc("session.steer", {
      session_id: this.#liveSid,
      text,
    })) as Record<string, unknown>;
    if (result.status === "queued") {
      this.#emit({ type: "steerQueued", nativeTurnId });
      return "ok";
    }
    return "mismatch";
  }

  async interrupt(_nativeTurnId: string): Promise<void> {
    if (!this.#transport || !this.#liveSid) {
      throw new ProviderUnavailableError("hermes session is not attached");
    }
    await this.#rpc("session.interrupt", { session_id: this.#liveSid });
  }

  async quiesceForHandoff(): Promise<{
    captureFlushed: boolean;
    compactQuiesced: boolean;
    evidence?: Record<string, unknown>;
  }> {
    // No structured Hermes quiesce receipt is identified; absence must fail
    // handoff rather than invent one.
    return { captureFlushed: false, compactQuiesced: false, evidence: { source: "unimplemented" } };
  }

  /**
   * Every path is bounded, and `exited`/cleanup only ever follow an observed
   * child exit. When even the post-SIGKILL settlement window passes without
   * one, the child may still be alive, so this throws `StopUnprovenError` and
   * retains child/transport state instead of inventing a stop.
   */
  async stop(mode: V2StopMode): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    this.#stopping = true;
    const child = this.#child;
    if (mode !== "kill" && this.#activeNativeTurnId && this.#transport && !this.#childError) {
      // Best effort so Hermes denies pending approvals and clears queues
      // itself before the SIGTERM; no receipt is claimed from it.
      try {
        this.#transport.send({
          jsonrpc: "2.0",
          id: `stop-interrupt-${this.#nextId++}`,
          method: "session.interrupt",
          params: { session_id: this.#liveSid },
        });
      } catch {
        // the bounded SIGTERM/SIGKILL path below is the real stop
      }
    }
    let exit: BoundedExit;
    if (!child) {
      // Injected-transport session: no console-spawned process exists.
      this.#transport?.close();
      exit = { exited: true, code: 0, signal: null };
    } else if (this.#childError && child.pid === undefined) {
      // Spawn itself failed: no OS process ever existed, so there is no exit
      // to observe and nothing that could still hold the thread.
      exit = { exited: true, code: null, signal: null };
    } else if (mode === "kill") {
      killHard(child);
      exit = await waitExitBounded(
        child,
        this.#options.killSettleTimeoutMs ?? KILL_SETTLE_TIMEOUT_MS,
      );
    } else {
      this.#transport?.close();
      child.kill("SIGTERM");
      exit = await waitExitBounded(
        child,
        this.#options.gracefulStopTimeoutMs ?? GRACEFUL_STOP_TIMEOUT_MS,
      );
      if (!exit.exited) {
        killHard(child);
        exit = await waitExitBounded(
          child,
          this.#options.killSettleTimeoutMs ?? KILL_SETTLE_TIMEOUT_MS,
        );
      }
    }
    if (!exit.exited) {
      // Re-arm exit notification: if the child does die later, its "exit"
      // handler must reach the manager as a real observed exit.
      this.#stopping = false;
      throw new StopUnprovenError(
        `hermes child pid ${child?.pid ?? "unknown"} did not exit within the SIGKILL bound; child state retained, stop unproven`,
      );
    }
    this.#cleanup();
    this.#emit({ type: "exited", code: exit.code, signal: exit.signal });
    return { code: exit.code, signal: exit.signal };
  }

  #spawn(input: AdapterStartInput): JsonlTransport {
    // Evidence is per-child: a restart must not inherit the previous one's.
    this.#stderrTail = "";
    this.#childError = null;
    const command = input.command ?? this.#options.command ?? "python";
    const args = input.args ?? this.#options.args ?? ["-m", "tui_gateway.entry"];
    const env: NodeJS.ProcessEnv = {
      ...scrubbedEnv({}),
      // Python stdout is block-buffered on a pipe; frames hang without this.
      PYTHONUNBUFFERED: "1",
      // Tool lifecycle events are gated on tool progress; enabling it at
      // worker setup is what makes tool.start/tool.complete flow (O5).
      HERMES_TUI_TOOL_PROGRESS: "verbose",
      HERMES_TUI_SESSION_TTL_S: DEFAULT_SESSION_TTL_S,
      ...input.env,
    };
    const spawnProcess = this.#options.spawnProcess ?? defaultSpawn;
    this.#child = spawnProcess(command, args, {
      cwd: input.cwd,
      env,
      writerLock: input.writerLock,
    });
    // Subscribed before anything can await on the child: an unhandled
    // ChildProcess "error" (spawn ENOENT, kill failure) crashes the whole
    // server, and a failed spawn never emits "exit", so this is the only
    // signal that turns a bad executable into a bounded start rejection.
    (this.#child as unknown as EventEmitter).on("error", (error: Error) => {
      const failure = new ProviderUnavailableError(`hermes child process failed: ${error.message}`);
      if (!this.#childError) this.#childError = failure;
      this.#rejectPending(failure);
      // A failed spawn never emits "exit", so a pending gateway.ready wait
      // must be failed here or start() hangs until its timeout.
      this.#failReady(failure);
    });
    (this.#child as unknown as EventEmitter).on(
      "exit",
      (code: number | null, signal: NodeJS.Signals | null) => {
        this.#rejectPending(new Error("hermes runtime exited"));
        this.#failReady(
          this.#childError ??
            new ProviderUnavailableError("hermes worker exited before gateway.ready"),
        );
        if (!this.#stopping) this.#emit({ type: "exited", code, signal });
      },
    );
    this.#drainStderr(this.#child);
    return new StreamJsonlTransport(this.#child);
  }

  /**
   * The worker's first frame is a `gateway.ready` event, not a response to an
   * initialize request; the adapter waits for it, bounded, before any RPC.
   */
  #waitReady(): Promise<void> {
    if (this.#ready) return Promise.resolve();
    if (this.#childError) return Promise.reject(this.#childError);
    const timeoutMs = this.#options.readyTimeoutMs ?? RPC_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const settle = (fn: () => void) => {
        clearTimeout(timer);
        this.#readyWaiters = this.#readyWaiters.filter((waiter) => waiter !== onReady);
        this.#readyFailures = this.#readyFailures.filter((waiter) => waiter !== onFailure);
        fn();
      };
      const timer = setTimeout(() => {
        settle(() =>
          reject(
            new ProviderUnavailableError(
              `hermes worker did not emit gateway.ready within ${timeoutMs}ms`,
            ),
          ),
        );
      }, timeoutMs);
      const onReady = () => settle(resolve);
      const onFailure = (error: Error) => settle(() => reject(error));
      this.#readyWaiters.push(onReady);
      this.#readyFailures.push(onFailure);
    });
  }

  #failReady(error: Error): void {
    this.#readyWaiters = [];
    for (const waiter of this.#readyFailures.splice(0)) waiter(error);
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
      if (message.error !== undefined) {
        pending.reject(hermesRpcError(pending.method, message.error));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method !== "event") return;
    const params = (message.params ?? {}) as Record<string, unknown>;
    const type = typeof params.type === "string" ? params.type : "";
    if (type === "gateway.ready") {
      this.#ready = true;
      for (const waiter of this.#readyWaiters.splice(0)) waiter();
      return;
    }
    // The envelope's session_id names the emitting gateway session; frames
    // from any session other than the one this adapter resumed are not ours.
    const sid = typeof params.session_id === "string" ? params.session_id : "";
    if (sid && this.#liveSid && sid !== this.#liveSid) return;
    if (this.#pendingSubmit) {
      this.#pendingSubmit.buffered.push(params);
      return;
    }
    this.#handleEvent(type, params);
  }

  #handleEvent(type: string, params: Record<string, unknown>): void {
    const nativeTurnId = this.#activeNativeTurnId;
    if (!nativeTurnId) return;
    // Event payloads ride nested under params.payload, not on params itself:
    // {"method":"event","params":{"type":…,"session_id":…,"payload":{…}}}.
    const payload = asRecord(params.payload);
    if (type === "message.start") {
      if (this.#turnStartedEmitted) return;
      this.#turnStartedEmitted = true;
      this.#emit({ type: "turnStarted", nativeTurnId });
      return;
    }
    if (type === "message.delta") {
      // Buffered, not emitted per-token; the terminal frame carries the text.
      if (typeof payload.text === "string") this.#finalTextBuffer += payload.text;
      return;
    }
    if (type === "reasoning.available" || type === "reasoning.delta") {
      this.#emit({ type: "item", nativeTurnId, item: { type: "other", text: "reasoning" } });
      return;
    }
    if (type === "tool.start" || type === "tool.complete") {
      this.#emit({
        type: "item",
        nativeTurnId,
        item: {
          type: "tool",
          text: typeof payload.name === "string" ? payload.name : undefined,
          nativeItemId: typeof payload.tool_id === "string" ? payload.tool_id : undefined,
        },
      });
      return;
    }
    if (type === "status.update") {
      this.#emit({
        type: "item",
        nativeTurnId,
        item: { type: "other", text: typeof payload.kind === "string" ? payload.kind : "status" },
      });
      return;
    }
    if (type === "error") {
      // The gateway's cancel-before-ready path closes a turn with a bare
      // `error` event and never sends message.complete; without this the
      // turn would hang open forever.
      this.#settleTurn(nativeTurnId, "failed", this.#finalTextBuffer);
      return;
    }
    if (type === "message.complete") {
      const finalText =
        typeof payload.text === "string" && payload.text ? payload.text : this.#finalTextBuffer;
      const status = typeof payload.status === "string" ? payload.status : "";
      // Truthful outcomes: only the statuses the gateway actually emits map
      // to definite outcomes; anything unrecognized is indeterminate, never
      // silently promoted to completed.
      const outcome =
        status === "complete"
          ? ("completed" as const)
          : status === "interrupted"
            ? ("interrupted" as const)
            : status === "error"
              ? ("failed" as const)
              : ("indeterminate" as const);
      this.#settleTurn(nativeTurnId, outcome, finalText);
      return;
    }
    // session.info, session.usage, notification.show, *.request prompts and
    // anything unrecognized: evidence, never fatal.
    this.#emit({ type: "item", nativeTurnId, item: { type: "other", text: type } });
  }

  #settleTurn(nativeTurnId: string, outcome: V2TurnOutcome, finalText: string): void {
    if (finalText) {
      this.#emit({
        type: "item",
        nativeTurnId,
        item: { type: "agent_message", text: finalText },
      });
    }
    // The sole terminal frame per turn: exactly one turnCompleted per minted
    // turn id, and clearing the active id closes the correlation window.
    this.#emit({
      type: "turnCompleted",
      nativeTurnId,
      outcome,
      finalText: finalText || undefined,
    });
    this.#activeNativeTurnId = null;
    this.#turnStartedEmitted = false;
  }

  /**
   * Keep the child's stderr moving. A piped stderr nobody reads fills its OS
   * buffer and blocks the writer — the worker logs there, so an unread pipe
   * can wedge the very process this adapter is waiting on. Only the tail is
   * kept; the rest is discarded as it arrives.
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
   * `ProviderUnavailableError` must stay one. Stderr here is evidence, never
   * a verdict.
   */
  #withStartEvidence(error: unknown): Error {
    const base = error instanceof Error ? error : new Error(String(error));
    const tail = this.#tailLines();
    if (tail.length === 0) return base;
    const message = `${base.message} (stderr tail: ${tail.join(" / ")})`;
    let decorated: Error;
    if (base instanceof ProviderUnavailableError) {
      decorated = new ProviderUnavailableError(message);
    } else if (base instanceof ProviderUnsupportedError) {
      decorated = new ProviderUnsupportedError(message);
    } else {
      decorated = new Error(message);
    }
    decorated.stack = base.stack;
    return decorated;
  }

  #rpc(method: string, params: unknown, id = String(this.#nextId++)): Promise<unknown> {
    if (!this.#transport) throw new ProviderUnavailableError("hermes transport is not started");
    if (this.#childError) return Promise.reject(this.#childError);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pending.has(id)) return;
        this.#pending.delete(id);
        reject(new Error(`hermes ${method} timed out after ${RPC_TIMEOUT_MS}ms`));
      }, RPC_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, method, timer });
      this.#transport!.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  #emit(event: ProviderNotification): void {
    this.#events.emit("event", event);
  }

  #cleanup(): void {
    this.#unsub?.();
    this.#unsub = null;
    this.#transport = null;
    this.#child = null;
    this.#sessionKey = null;
    this.#liveSid = null;
    this.#startState = null;
    this.#pendingSubmit = null;
    this.#activeNativeTurnId = null;
    this.#turnStartedEmitted = false;
    this.#stopping = false;
    this.#childError = null;
    this.#ready = false;
    this.#readyWaiters = [];
    this.#readyFailures = [];
    this.#rejectPending(new Error("hermes runtime stopped"));
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Typed start state from the gateway's own resume payload. Idle is claimed
 * only when the payload affirms it on every axis it reports activity on:
 * `running` false, no retained `inflight` turn snapshot, `status` "idle", and
 * no scheduled `auto_continue`. A payload that omits or garbles those fields
 * proves nothing and stays unproven — resume of a mid-run or auto-continuing
 * session must never be presented as an idle attach.
 */
export function resumeStartState(result: Record<string, unknown>): AdapterStartState {
  const reasons: string[] = [];
  if (result.running !== false) {
    reasons.push(
      result.running === true
        ? "resume reported a running run loop"
        : "resume payload did not affirm running=false",
    );
  }
  if (result.inflight !== null) {
    reasons.push(
      result.inflight === undefined
        ? "resume payload did not affirm inflight=null"
        : "resume retained an inflight turn snapshot",
    );
  }
  if (result.auto_continue !== undefined) {
    reasons.push("resume scheduled an auto_continue turn");
  }
  const status = nonEmptyString(result.status);
  if (status !== "idle") {
    reasons.push(
      status ? `resume status is '${status}', not idle` : "resume payload carried no status",
    );
  }
  if (reasons.length === 0) return { kind: "idle" };
  return {
    kind: "unproven",
    reasons,
    evidence: {
      running: result.running ?? null,
      inflight: result.inflight ?? null,
      status: result.status ?? null,
      auto_continue: result.auto_continue ?? null,
    },
  };
}

/**
 * Classify a Hermes JSON-RPC error envelope by app code, never by wording:
 * 4010 (unsupported capability) is `ProviderUnsupportedError`; 4007 (unknown
 * session — the only observable evidence of a silent idle reap) is
 * `ProviderUnavailableError`; everything else stays a plain provider error.
 */
function hermesRpcError(method: string, error: unknown): Error {
  const envelope =
    error && typeof error === "object" ? (error as { code?: unknown; message?: unknown }) : {};
  const code = typeof envelope.code === "number" ? envelope.code : null;
  const message =
    typeof envelope.message === "string" && envelope.message
      ? envelope.message
      : JSON.stringify(error);
  if (code === HERMES_UNSUPPORTED_CODE) {
    return new ProviderUnsupportedError(`hermes ${method} unsupported (4010): ${message}`);
  }
  if (code === HERMES_UNKNOWN_SESSION_CODE) {
    return new ProviderUnavailableError(
      `hermes ${method} unknown session (4007) — the worker may have reaped it: ${message}`,
    );
  }
  return new Error(`hermes ${method} failed${code !== null ? ` (${code})` : ""}: ${message}`);
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
