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
const LHC_THREAD_ENTRY_TYPE = "pi-lhc.thread";
/** Bytes of child stderr kept for failure evidence. Older bytes are dropped. */
const STDERR_TAIL_BYTES = 8_192;
/** Lines of that tail quoted into an error message. */
const STDERR_TAIL_LINES = 5;

export const LHC_HANDOFF_QUIESCE_COMMAND = "lhc-handoff-quiesce";
export const LHC_HANDOFF_QUIESCE_RECEIPT_PREFIX = "pi-lhc:handoff-quiesce";

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  type: string;
  timer: NodeJS.Timeout;
}

export interface PiLhcAdapterOptions {
  transport?: JsonlTransport;
  command?: string;
  args?: string[];
  spawnProcess?: (
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; writerLock?: HeldWriterLock | null },
  ) => ChildProcess;
  /**
   * Test-only: inject a JSONL pair. Production never sets this.
   */
  testTransport?: JsonlTransport;
}

interface HandoffQuiesceReceipt {
  captureFlushed: boolean;
  compactQuiesced: boolean;
  threadId?: string | null;
  pendingCapture?: number;
  autoCompactInFlight?: boolean;
}

/**
 * Thin Pi-LHC adapter over LHC-safe AgentSession RPC.
 *
 * Native follow-up is intentionally unused (console-owned queue). Steer is a
 * queued boundary operation; the adapter applies the expected-turn fence
 * itself because Pi's `steer` has no native expectedTurnId.
 */
export class PiLhcAdapter implements ProviderAdapter {
  readonly provider = "pi-lhc" as const;
  readonly capabilities = PROVIDER_CAPABILITIES["pi-lhc"];
  readonly #events = new EventEmitter();
  readonly #pending = new Map<string, PendingCommand>();
  readonly #options: PiLhcAdapterOptions;
  #transport: JsonlTransport | null = null;
  #child: ChildProcess | null = null;
  #unsub: (() => void) | null = null;
  #nextId = 1;

  #activeNativeTurnId: string | null = null;
  #runtimeGeneration = 0;
  #promptRequestId: string | null = null;
  #lhcHooksConfirmed = false;
  #lastAssistantText = "";
  #pendingSteerCommandId: string | null = null;
  #lastQuiesceReceipt: HandoffQuiesceReceipt | null = null;
  #awaitingQuiesce = false;
  #stopping = false;
  #stderrTail = "";
  #childError: Error | null = null;

  constructor(options: PiLhcAdapterOptions = {}) {
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
  rejectPendingForTest(message = "pi-lhc runtime exited"): void {
    this.#rejectPending(new Error(message));
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
    const injected = this.#options.transport ?? this.#options.testTransport;
    if (injected) {
      this.#transport = injected;
    } else {
      this.#transport = this.#spawn(input);
    }
    this.#unsub = this.#transport.onLine((line) => this.#onLine(line));
    this.#runtimeGeneration = input.runtimeGeneration ?? 0;
    const native = await this.#confirmLhcSafeSession(input.canonicalThreadId);
    this.#lhcHooksConfirmed = true;
    await this.#command("set_steering_mode", { mode: "one-at-a-time" });
    this.#emit({ type: "threadAttached", nativeThreadRef: native });
    return native;
  }

  async startTurn(text: string): Promise<string> {
    if (!this.#transport || !this.#lhcHooksConfirmed) {
      throw new ProviderUnavailableError("pi-lhc session is not started");
    }
    this.#lastAssistantText = "";
    const id = String(this.#nextId++);
    this.#promptRequestId = id;
    this.#activeNativeTurnId = correlatePiNativeTurnId(this.#runtimeGeneration, id);
    const started = new Promise<void>((resolve) => {
      const off = this.on((event) => {
        if (event.type === "turnStarted" && event.nativeTurnId === this.#activeNativeTurnId) {
          off();
          resolve();
        }
      });
    });
    try {
      const prompt = this.#command("prompt", { message: text }, id);
      this.#emit({ type: "turnStarted", nativeTurnId: this.#activeNativeTurnId });
      await Promise.race([prompt, started]);
      await prompt;
    } catch (error) {
      this.#activeNativeTurnId = null;
      this.#promptRequestId = null;
      throw error;
    }
    if (!this.#activeNativeTurnId) {
      throw new ProviderUnavailableError(
        "pi-lhc prompt produced no native turn id; refusing to invent a synthetic id",
      );
    }
    return this.#activeNativeTurnId;
  }

  async steer(nativeTurnId: string, text: string): Promise<AdapterSteerResult> {
    if (!this.#activeNativeTurnId) return "mismatch";
    if (this.#activeNativeTurnId !== nativeTurnId) return "mismatch";
    if (this.#pendingSteerCommandId) return "unsupported";
    const steerId = String(this.#nextId++);
    this.#pendingSteerCommandId = steerId;
    await this.#command("steer", { message: text }, steerId);
    this.#emit({ type: "steerQueued", nativeTurnId, providerResponseId: steerId });
    return "ok";
  }

  async quiesceForHandoff(): Promise<{
    captureFlushed: boolean;
    compactQuiesced: boolean;
    evidence?: Record<string, unknown>;
  }> {
    if (!this.#transport || !this.#lhcHooksConfirmed) {
      return {
        captureFlushed: false,
        compactQuiesced: false,
        evidence: { source: "session_not_started" },
      };
    }
    this.#lastQuiesceReceipt = null;
    this.#awaitingQuiesce = true;
    try {
      await this.#command("prompt", { message: `/${LHC_HANDOFF_QUIESCE_COMMAND}` });
    } catch (error) {
      this.#awaitingQuiesce = false;
      return {
        captureFlushed: false,
        compactQuiesced: false,
        evidence: {
          source: "quiesce_command_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    this.#awaitingQuiesce = false;
    const receipt = this.#takeQuiesceReceipt();
    if (!receipt) {
      return {
        captureFlushed: false,
        compactQuiesced: false,
        evidence: {
          source: "missing_structured_receipt",
          note: "agent_settled and prompt success are not capture/compact quiescence",
        },
      };
    }
    const evidence: Record<string, unknown> = { source: LHC_HANDOFF_QUIESCE_COMMAND, ...receipt };
    this.#emit({ type: "captureFlush", ok: receipt.captureFlushed, evidence });
    this.#emit({ type: "compactQuiesced", ok: receipt.compactQuiesced, evidence });
    return {
      captureFlushed: receipt.captureFlushed,
      compactQuiesced: receipt.compactQuiesced,
      evidence,
    };
  }

  async interrupt(_nativeTurnId: string): Promise<void> {
    await this.#command("abort");
  }

  async getState(): Promise<Record<string, unknown>> {
    const result = (await this.#command("get_state")) as { data?: Record<string, unknown> };
    return result.data ?? {};
  }

  async stop(mode: V2StopMode): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    this.#stopping = true;
    if (mode === "kill" && this.#child) {
      try {
        if (this.#child.pid) process.kill(-this.#child.pid, "SIGKILL");
      } catch {
        // process-group kill is best-effort
      }
      this.#child.kill("SIGKILL");
    } else {
      this.#transport?.close();
      this.#child?.kill("SIGTERM");
    }
    const exit = await this.#waitExit();
    this.#cleanup();
    this.#emit({ type: "exited", code: exit.code, signal: exit.signal });
    return exit;
  }

  #spawn(input: AdapterStartInput): JsonlTransport {
    // Evidence is per-child: a restart must not inherit the previous one's.
    this.#stderrTail = "";
    this.#childError = null;
    const command = input.command ?? this.#options.command ?? "pi-lhc";
    const args = resolvePiRpcArgs(
      command,
      input.args ?? this.#options.args,
      input.canonicalThreadId,
    );
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
      const failure = new ProviderUnavailableError(`pi-lhc child process failed: ${error.message}`);
      if (!this.#childError) this.#childError = failure;
      this.#rejectPending(failure);
    });
    (this.#child as unknown as EventEmitter).on(
      "exit",
      (code: number | null, signal: NodeJS.Signals | null) => {
        this.#rejectPending(new Error("pi-lhc runtime exited"));
        if (!this.#stopping) this.#emit({ type: "exited", code, signal });
      },
    );
    this.#drainStderr(this.#child);
    return new StreamJsonlTransport(this.#child);
  }

  /**
   * Keep the child's stderr moving. A piped stderr nobody reads fills its OS
   * buffer and blocks the writer — the launcher logs there, so an unread
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
   * `ProviderUnavailableError` must stay one. Stderr here is evidence, never
   * a verdict — advisory launcher warnings must not become fatal by proxy.
   */
  #withStartEvidence(error: unknown): Error {
    const base = error instanceof Error ? error : new Error(String(error));
    const tail = this.#tailLines();
    if (tail.length === 0) return base;
    const message = `${base.message} (stderr tail: ${tail.join(" / ")})`;
    const decorated =
      base instanceof ProviderUnavailableError
        ? new ProviderUnavailableError(message)
        : new Error(message);
    decorated.stack = base.stack;
    return decorated;
  }

  async #confirmLhcSafeSession(canonicalThreadId: string): Promise<string> {
    const state = (await this.#command("get_state")) as {
      data?: { sessionId?: string };
    };
    const native = state.data?.sessionId;
    if (!native) {
      throw new ProviderUnavailableError(
        "pi-lhc get_state returned no sessionId; refusing to invent a thread identity",
      );
    }
    const entriesResult = (await this.#command("get_entries")) as {
      data?: { entries?: unknown };
    };
    const seededId = readSeededLhcThreadId(entriesResult.data?.entries);
    if (!seededId) {
      throw new ProviderUnavailableError(
        "pi-lhc get_entries is missing the seeded pi-lhc.thread identity; refusing to invent a thread",
      );
    }
    if (seededId !== canonicalThreadId) {
      throw new ProviderUnavailableError(
        `pi-lhc seeded LHC thread ${seededId} does not match launcher thread ${canonicalThreadId}`,
      );
    }
    const commandsResult = (await this.#command("get_commands")) as {
      data?: { commands?: Array<{ name?: string }> };
    };
    const names = (commandsResult.data?.commands ?? [])
      .map((command) => command.name)
      .filter((name): name is string => typeof name === "string");
    if (!names.includes(LHC_HANDOFF_QUIESCE_COMMAND)) {
      throw new ProviderUnavailableError(
        `pi-lhc RPC refused: LHC command ${LHC_HANDOFF_QUIESCE_COMMAND} is not registered`,
      );
    }
    return native;
  }

  #onLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.type === "response") {
      const id =
        typeof message.id === "string" || typeof message.id === "number" ? String(message.id) : "";
      const pending =
        this.#pending.get(id) ??
        [...this.#pending.values()].find((p) => p.type === message.command);
      if (!pending) return;
      clearTimeout(pending.timer);
      for (const [key, value] of this.#pending) {
        if (value === pending) this.#pending.delete(key);
      }
      if (message.success === false) {
        pending.reject(
          new Error(typeof message.error === "string" ? message.error : "pi-lhc command failed"),
        );
      } else {
        pending.resolve(message);
      }
      return;
    }
    if (message.type === "extension_ui_request") {
      this.#handleExtensionUi(message);
      return;
    }
    this.#handleEvent(message);
  }

  #handleExtensionUi(message: Record<string, unknown>): void {
    const method = typeof message.method === "string" ? message.method : "";
    if (method !== "notify") return;
    const text = typeof message.message === "string" ? message.message : "";
    const receipt = parseHandoffQuiesceReceipt(text);
    if (receipt) this.#lastQuiesceReceipt = receipt;
  }

  #handleEvent(event: Record<string, unknown>): void {
    const type = typeof event.type === "string" ? event.type : "";
    const nativeTurnId = this.#activeNativeTurnId ?? "";
    if (type === "agent_start") {
      if (this.#awaitingQuiesce) return;
      if (!this.#activeNativeTurnId || !this.#promptRequestId) return;
      const reported =
        (typeof event.runId === "string" && event.runId) ||
        (typeof event.agentRunId === "string" && event.agentRunId) ||
        (typeof event.id === "string" && event.id) ||
        null;
      if (reported && reported !== this.#activeNativeTurnId && reported !== this.#promptRequestId) {
        return;
      }
      this.#emit({ type: "turnStarted", nativeTurnId: this.#activeNativeTurnId });
      return;
    }
    if (type === "message_start" || type === "message_update" || type === "message_end") {
      if (!this.#activeNativeTurnId || this.#awaitingQuiesce) return;
      const message = event.message as { role?: string; content?: unknown } | undefined;
      const text = extractText(event) ?? extractText(message ?? {});
      if (text && (message?.role === "assistant" || event.role === "assistant")) {
        this.#lastAssistantText = text;
        this.#emit({
          type: "item",
          nativeTurnId: this.#activeNativeTurnId,
          item: { type: "agent_message", text },
        });
      }
      if (
        this.#pendingSteerCommandId &&
        type === "message_start" &&
        (message?.role === "user" || event.role === "user")
      ) {
        // Exactly one field can prove consumption: the top-level `requestId`
        // of this session event. `event.id` is a different identifier and a
        // `requestId` nested on the message is not the wire field, so neither
        // may stand in for it. Upstream Pi emits none of them today, which is
        // why the capability reports consumption unproven.
        const requestId = typeof event.requestId === "string" ? event.requestId : null;
        if (requestId && requestId === this.#pendingSteerCommandId) {
          this.#emit({
            type: "steerConsumed",
            nativeTurnId: this.#activeNativeTurnId,
            providerResponseId: this.#pendingSteerCommandId,
            evidence: {
              source: "message_start",
              commandId: this.#pendingSteerCommandId,
              correlation: "exact",
              requestId,
            },
          });
          this.#pendingSteerCommandId = null;
        }
        // No exact match → do not claim consumed. Steer stays queued and
        // settles as not_consumed at turn end via #settleSteers.
      }
      return;
    }
    if (type === "queue_update") {
      // queue_update is not consumption evidence. Ignore it.
      return;
    }
    if (type === "agent_end") {
      if (this.#awaitingQuiesce) return;
      this.#emit({
        type: "item",
        nativeTurnId,
        item: { type: "other", text: "agent_end" },
      });
      return;
    }
    if (type === "agent_settled") {
      if (this.#awaitingQuiesce || !this.#activeNativeTurnId) return;
      const text = extractText(event) ?? this.#lastAssistantText;
      this.#emit({
        type: "turnCompleted",
        nativeTurnId,
        outcome: event.aborted === true ? "interrupted" : "completed",
        finalText: typeof text === "string" ? text : undefined,
      });
    }
  }

  #command(
    type: string,
    extra: Record<string, unknown> = {},
    id = String(this.#nextId++),
  ): Promise<unknown> {
    if (!this.#transport) throw new ProviderUnavailableError("pi-lhc transport is not started");
    if (this.#childError) return Promise.reject(this.#childError);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pending.has(id)) return;
        this.#pending.delete(id);
        reject(new Error(`pi-lhc ${type} timed out after ${RPC_TIMEOUT_MS}ms`));
      }, RPC_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, type, timer });
      this.#transport!.send({ id, type, ...extra });
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

  #cleanup(): void {
    this.#unsub?.();
    this.#unsub = null;
    this.#transport = null;
    this.#child = null;
    this.#activeNativeTurnId = null;
    this.#promptRequestId = null;
    this.#lhcHooksConfirmed = false;
    this.#awaitingQuiesce = false;
    this.#stopping = false;
    this.#childError = null;
    this.#rejectPending(new Error("pi-lhc runtime stopped"));
  }

  #takeQuiesceReceipt(): HandoffQuiesceReceipt | null {
    return this.#lastQuiesceReceipt;
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

export function correlatePiNativeTurnId(runtimeGeneration: number, requestId: string): string {
  return `pi-rpc:${runtimeGeneration}:${requestId}`;
}

export function resolvePiRpcArgs(
  command: string,
  requested: string[] | undefined,
  canonicalThreadId: string,
): string[] {
  const base = command.split(/[/\\]/).pop() ?? command;
  if (base === "pi" || base.endsWith("/pi")) {
    throw new ProviderUnavailableError(
      "pi-lhc adapter refuses bare pi; spawn the LHC-safe pi-lhc launcher with --mode rpc",
    );
  }
  if (requested && requested.length > 0) {
    if (!requested.includes("rpc")) {
      throw new ProviderUnavailableError(
        "pi-lhc production start requires --mode rpc on the LHC-safe launcher",
      );
    }
    return requested;
  }
  if (!canonicalThreadId) {
    throw new ProviderUnavailableError(
      "pi-lhc production start requires a canonical LHC thread id for --lhc-thread",
    );
  }
  return ["--lhc-thread", canonicalThreadId, "--mode", "rpc"];
}

export function readSeededLhcThreadId(entries: unknown): string | null {
  if (!Array.isArray(entries)) return null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { type?: string; customType?: string; data?: unknown };
    if (
      record.type !== LHC_THREAD_ENTRY_TYPE &&
      !(record.type === "custom" && record.customType === LHC_THREAD_ENTRY_TYPE)
    ) {
      continue;
    }
    const data =
      typeof record.data === "object" && record.data !== null
        ? (record.data as Record<string, unknown>)
        : (record as Record<string, unknown>);
    const threadId = data.threadId;
    if (typeof threadId === "string" && threadId !== "") return threadId;
  }
  return null;
}

export function parseHandoffQuiesceReceipt(message: string): HandoffQuiesceReceipt | null {
  const trimmed = message.trim();
  if (!trimmed.startsWith(LHC_HANDOFF_QUIESCE_RECEIPT_PREFIX)) return null;
  const payload = trimmed.slice(LHC_HANDOFF_QUIESCE_RECEIPT_PREFIX.length).trim();
  try {
    const parsed = JSON.parse(payload) as Partial<HandoffQuiesceReceipt>;
    if (typeof parsed.captureFlushed !== "boolean" || typeof parsed.compactQuiesced !== "boolean") {
      return null;
    }
    return parsed as HandoffQuiesceReceipt;
  } catch {
    return null;
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

function extractText(value: Record<string, unknown>): string | undefined {
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content)) {
    return value.content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part)
          return String((part as { text: unknown }).text);
        return "";
      })
      .join("");
  }
  return undefined;
}
