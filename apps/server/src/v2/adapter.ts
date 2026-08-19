import type { V2Provider, V2StopMode, V2TurnOutcome } from "./contract.ts";
import type { CodexApprovalPolicy } from "./policies.ts";
import type { HeldWriterLock } from "./writer-lock.ts";

export type AdapterSteerResult = "ok" | "mismatch" | "unsupported";

/**
 * Whether a provider's wire can prove that a queued steer entered the active
 * turn. `native` means the provider emits an event carrying the steer's own
 * request id; `unsupported` means Console cannot prove consumption at all and
 * must never report `consumed`.
 */
export type SteerConsumptionEvidence = "native" | "unsupported";

export interface ProviderCapabilities {
  steerConsumption: SteerConsumptionEvidence;
}

/**
 * Honest per-provider capability declarations.
 *
 * Pi: the upstream RPC session event for a user message is
 * `{ type: "message_start", message }` (pi `packages/agent` `AgentEvent`), and
 * `AgentSession` matches a steer back to its queue by message *text*. No
 * request id reaches the wire, and the real `pi-lhc --mode rpc` child
 * acceptance test asserts that. Text or ordinal matching is inference, not
 * evidence, so consumption is reported unproven.
 *
 * Codex: `turn/steer` acknowledges queueing; no notification correlates a
 * queued steer to the point it entered the turn.
 *
 * Hermes: `session.steer` splices text into the current tool-result batch with
 * no correlating id on any subsequent event, so consumption is unprovable on
 * its wire.
 */
export const PROVIDER_CAPABILITIES: Record<V2Provider, ProviderCapabilities> = {
  "codex-lhc": { steerConsumption: "unsupported" },
  "pi-lhc": { steerConsumption: "unsupported" },
  hermes: { steerConsumption: "unsupported" },
};

export interface AdapterStartInput {
  hostThreadId: string;
  canonicalThreadId: string;
  cwd: string;
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  approvalPolicy: CodexApprovalPolicy;
  writerLock?: HeldWriterLock | null;
  runtimeGeneration?: number;
  proveCanonicalSession?: (nativeThreadRef: string, canonicalThreadId: string) => Promise<boolean>;
}

/**
 * What the provider's own start/resume evidence says about the attached
 * session's activity. `idle` requires the provider to have affirmatively
 * reported an idle session; anything the wire left ambiguous (a running run
 * loop, a retained inflight turn, a scheduled auto-continue, or fields the
 * response simply omitted) is `unproven` and must never be presented as idle.
 */
export type AdapterStartState =
  | { kind: "idle" }
  | { kind: "unproven"; reasons: string[]; evidence: Record<string, unknown> };

export interface AdapterTurnItem {
  type: "agent_message" | "tool" | "other";
  text?: string;
  nativeItemId?: string;
}

export type ProviderNotification =
  | { type: "threadAttached"; nativeThreadRef: string }
  | { type: "turnStarted"; nativeTurnId: string }
  | { type: "item"; nativeTurnId: string; item: AdapterTurnItem }
  | {
      type: "steerQueued";
      nativeTurnId: string;
      providerResponseId?: string;
    }
  | {
      type: "steerConsumed";
      nativeTurnId: string;
      providerResponseId?: string;
      evidence: Record<string, unknown>;
    }
  | {
      type: "turnCompleted";
      nativeTurnId: string;
      outcome: V2TurnOutcome;
      finalText?: string;
    }
  | {
      type: "exited";
      code: number | null;
      signal: NodeJS.Signals | null;
    }
  | {
      type: "captureFlush";
      ok: boolean;
      evidence?: Record<string, unknown>;
    }
  | {
      type: "compactQuiesced";
      ok: boolean;
      evidence?: Record<string, unknown>;
    };

export type ProviderListener = (event: ProviderNotification) => void;

export interface ProviderAdapter {
  readonly provider: V2Provider;
  /** What this adapter can actually prove. Never aspirational. */
  readonly capabilities: ProviderCapabilities;
  start(input: AdapterStartInput): Promise<string>;
  startTurn(text: string): Promise<string>;
  steer(nativeTurnId: string, text: string): Promise<AdapterSteerResult>;
  interrupt(nativeTurnId: string): Promise<void>;
  /**
   * Pi-only native follow-up exists but the contract forbids using it.
   * Adapters must not expose a follow-up method.
   */
  stop(mode: V2StopMode): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  getState?(): Promise<Record<string, unknown>>;
  /**
   * Typed start evidence from the provider's own resume/attach response.
   * Absent means the adapter has no richer signal than a successful start
   * (Codex/Pi today); present, the manager must not mark the runtime idle
   * unless this says `idle`.
   */
  startEvidence?(): AdapterStartState;
  /**
   * Host capture flush + post-settle compact quiesce. Absence or a false
   * receipt must fail handoff; adapters must not invent success.
   */
  quiesceForHandoff?(): Promise<{
    captureFlushed: boolean;
    compactQuiesced: boolean;
    evidence?: Record<string, unknown>;
  }>;
  on(listener: ProviderListener): () => void;
  pid(): number | null;
}

export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

export class ProviderUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderUnsupportedError";
  }
}
