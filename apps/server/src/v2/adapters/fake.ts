import { EventEmitter } from "node:events";
import type {
  AdapterStartInput,
  AdapterSteerResult,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderListener,
  SteerConsumptionEvidence,
} from "../adapter.ts";
import type { V2Provider, V2StopMode, V2TurnOutcome } from "../contract.ts";

export interface FakeTurnScript {
  items?: Array<{ type: "agent_message" | "tool" | "other"; text?: string }>;
  finalText?: string;
  outcome?: V2TurnOutcome;
  /** Delay before emitting turnCompleted. 0 is synchronous after start. */
  settleMs?: number;
  /** If true, wait for interrupt() instead of auto-settling. */
  waitForInterrupt?: boolean;
}

export interface FakeAdapterOptions {
  provider: V2Provider;
  nativeThreadRef?: string;
  /** Native steer fence: Codex reports mismatch; Pi relies on adapter-side fence. */
  nativeSteerFence?: boolean;
  startError?: string;
  /** Provider failure raised after the command crossed the dispatch boundary. */
  startTurnError?: string;
  /** Provider failure raised after the interrupt was dispatched. */
  interruptError?: string;
  /** Stop failure: the console cannot prove the spawned writer is gone. */
  stopError?: string;
  scripts?: FakeTurnScript[];
  /** Test-only: prove a host flush/quiesce receipt. Default refuses. */
  quiesceOk?: boolean;
  /** Which consumption evidence this harness models. Default `native`. */
  steerConsumption?: SteerConsumptionEvidence;
}

/**
 * Deterministic in-process adapter used for paired Codex/Pi contract tests.
 * It does not claim live provider behavior.
 */
export class FakeProviderAdapter implements ProviderAdapter {
  readonly provider: V2Provider;
  readonly capabilities: ProviderCapabilities;
  readonly #events = new EventEmitter();
  readonly #options: FakeAdapterOptions;
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  #nativeThreadRef: string | null = null;
  #activeNativeTurnId: string | null = null;
  #turnCount = 0;
  #started = false;
  #scriptIndex = 0;
  #settleTimer: NodeJS.Timeout | null = null;
  #pid = 10_000 + Math.floor(Math.random() * 1000);

  constructor(options: FakeAdapterOptions) {
    this.provider = options.provider;
    this.#options = options;
    this.capabilities = { steerConsumption: options.steerConsumption ?? "native" };
  }

  on(listener: ProviderListener): () => void {
    this.#events.on("event", listener);
    return () => this.#events.off("event", listener);
  }

  pid(): number | null {
    return this.#started ? this.#pid : null;
  }

  async start(input: AdapterStartInput): Promise<string> {
    this.calls.push({ method: "start", args: [input] });
    if (this.#options.startError) throw new Error(this.#options.startError);
    this.#started = true;
    this.#nativeThreadRef = this.#options.nativeThreadRef ?? input.hostThreadId;
    this.#events.emit("event", { type: "threadAttached", nativeThreadRef: this.#nativeThreadRef });
    return this.#nativeThreadRef;
  }

  async startTurn(text: string): Promise<string> {
    this.calls.push({ method: "startTurn", args: [text] });
    if (!this.#started) throw new Error("runtime not started");
    if (this.#options.startTurnError) throw new Error(this.#options.startTurnError);
    this.#turnCount += 1;
    const nativeTurnId = `${this.provider}-turn-${this.#turnCount}`;
    this.#activeNativeTurnId = nativeTurnId;
    const script = this.#options.scripts?.[this.#scriptIndex++] ?? {
      items: [{ type: "agent_message" as const, text: `echo:${text}` }],
      finalText: `echo:${text}`,
      outcome: "completed" as const,
      settleMs: 0,
    };
    const emitStartedAndItems = () => {
      this.#events.emit("event", { type: "turnStarted", nativeTurnId });
      for (const item of script.items ?? []) {
        this.#events.emit("event", { type: "item", nativeTurnId, item });
      }
      if (script.waitForInterrupt) return;
      const settle = () => {
        if (this.#activeNativeTurnId !== nativeTurnId) return;
        this.#activeNativeTurnId = null;
        this.#events.emit("event", {
          type: "turnCompleted",
          nativeTurnId,
          outcome: script.outcome ?? "completed",
          finalText: script.finalText,
        });
      };
      this.#settleTimer = setTimeout(settle, script.settleMs ?? 1);
    };
    this.#settleTimer = setTimeout(emitStartedAndItems, 1);
    return nativeTurnId;
  }

  async steer(nativeTurnId: string, text: string): Promise<AdapterSteerResult> {
    this.calls.push({ method: "steer", args: [nativeTurnId, text] });
    if (this.#options.nativeSteerFence && this.#activeNativeTurnId !== nativeTurnId) {
      return "mismatch";
    }
    if (this.#activeNativeTurnId !== nativeTurnId) return "mismatch";
    const providerResponseId = `fake-steer-${nativeTurnId}-${text.length}`;
    this.#events.emit("event", { type: "steerQueued", nativeTurnId, providerResponseId });
    this.#settleTimer = setTimeout(() => {
      this.#events.emit("event", {
        type: "steerConsumed",
        nativeTurnId,
        providerResponseId,
        evidence: {
          text,
          source: this.provider === "pi-lhc" ? "message_start" : "turn/steer",
          providerResponseId,
        },
      });
    }, 1);
    return "ok";
  }

  async quiesceForHandoff(): Promise<{
    captureFlushed: boolean;
    compactQuiesced: boolean;
    evidence?: Record<string, unknown>;
  }> {
    this.calls.push({ method: "quiesceForHandoff", args: [] });
    const ok = this.#options.quiesceOk === true;
    return { captureFlushed: ok, compactQuiesced: ok, evidence: { source: "fake" } };
  }

  async interrupt(nativeTurnId: string): Promise<void> {
    this.calls.push({ method: "interrupt", args: [nativeTurnId] });
    if (this.#options.interruptError) throw new Error(this.#options.interruptError);
    if (this.#settleTimer) clearTimeout(this.#settleTimer);
    if (this.#activeNativeTurnId === nativeTurnId) {
      this.#activeNativeTurnId = null;
      queueMicrotask(() => {
        this.#events.emit("event", {
          type: "turnCompleted",
          nativeTurnId,
          outcome: "interrupted",
        });
      });
    }
  }

  async stop(mode: V2StopMode): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    this.calls.push({ method: "stop", args: [mode] });
    if (this.#options.stopError) throw new Error(this.#options.stopError);
    if (this.#settleTimer) clearTimeout(this.#settleTimer);
    const active = this.#activeNativeTurnId;
    this.#activeNativeTurnId = null;
    this.#started = false;
    if (active && mode === "kill") {
      this.#events.emit("event", {
        type: "turnCompleted",
        nativeTurnId: active,
        outcome: "indeterminate",
      });
    }
    this.#events.emit("event", { type: "exited", code: mode === "kill" ? 137 : 0, signal: null });
    return { code: mode === "kill" ? 137 : 0, signal: null };
  }

  /** Test helper: inject a provider notification as if the child emitted it. */
  emitNotification(event: Parameters<ProviderListener>[0]): void {
    this.#events.emit("event", event);
  }

  /** Test helper: crash the fake child mid-turn. */
  crash(): void {
    const active = this.#activeNativeTurnId;
    this.#activeNativeTurnId = null;
    this.#started = false;
    if (active) {
      this.#events.emit("event", {
        type: "turnCompleted",
        nativeTurnId: active,
        outcome: "failed",
      });
    }
    this.#events.emit("event", { type: "exited", code: 1, signal: null });
  }
}
