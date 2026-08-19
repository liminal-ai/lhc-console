/**
 * Canonical Console V2 contract. Neither Codex-LHC nor Pi-LHC defines this
 * surface; adapters translate to and from it.
 */

export const V2_PROVIDERS = ["codex-lhc", "pi-lhc"] as const;
export type V2Provider = (typeof V2_PROVIDERS)[number];

export const V2_RUNTIME_STATES = [
  "stopped",
  "starting",
  "idle",
  "active",
  "draining",
  "handed_off",
  "unknown",
] as const;
export type V2RuntimeState = (typeof V2_RUNTIME_STATES)[number];

export const V2_COMMAND_KINDS = [
  "runtime.start",
  "runtime.stop",
  "turn.start",
  "turn.steer",
  "turn.followUp",
  "turn.interrupt",
  "command.cancel",
  "handoff.request",
  "handoff.release",
] as const;
export type V2CommandKind = (typeof V2_COMMAND_KINDS)[number];

export const V2_RECEIPT_STATES = [
  "accepted",
  "applied",
  "rejected",
  "superseded",
  "indeterminate",
] as const;
export type V2ReceiptState = (typeof V2_RECEIPT_STATES)[number];

export const V2_TERMINAL_RECEIPTS: readonly V2ReceiptState[] = [
  "applied",
  "rejected",
  "superseded",
  "indeterminate",
];

export const V2_DISPATCH_STATES = ["not_sent", "sending", "acknowledged"] as const;
export type V2DispatchState = (typeof V2_DISPATCH_STATES)[number];

export const V2_EVENT_KINDS = [
  "runtime.state",
  "command.receipt",
  "command.effect",
  "turn.started",
  "turn.item",
  "turn.completed",
  "delivery",
  "handoff",
] as const;
export type V2EventKind = (typeof V2_EVENT_KINDS)[number];

export const V2_TURN_OUTCOMES = ["completed", "interrupted", "failed", "indeterminate"] as const;
export type V2TurnOutcome = (typeof V2_TURN_OUTCOMES)[number];

export const V2_OWNER_KINDS = ["none", "v1-job", "v2-runtime", "handed_off"] as const;
export type V2OwnerKind = (typeof V2_OWNER_KINDS)[number];

export const V2_REJECT_REASONS = [
  "turn_active",
  "turn_mismatch",
  "no_active_turn",
  "writer_conflict",
  "handed_off",
  "unsupported",
  "runtime_not_ready",
  "provider_error",
  "provider_unavailable",
  "writer_identity_unresolved",
  "already_dispatched",
  "already_terminal",
  "unknown_command",
  "capture_not_flushed",
  "span_not_closed",
  "terminal_limit",
  "v2_disabled",
  "target_not_opted_in",
  "policy_unset",
] as const;
export type V2RejectReason = (typeof V2_REJECT_REASONS)[number];

export type V2DeliveryChannel = "photon";
export type V2StopMode = "drain" | "interrupt" | "kill";
export type V2HandoffMode = "drain" | "interrupt";
export type V2HandoffLaunch = "terminal" | "command-only";
export type V2SteerEffectStage = "queued" | "consumed" | "not_consumed";
export type V2TurnCause = "turn.start" | "followUp";

export interface V2ThreadIdentity {
  hostId: string;
  /** Host-native session / resume identifier (Codex session id, Pi thread selector). */
  hostThreadId: string;
  /** Canonical LHC `th_…` identity when resolved. */
  canonicalThreadId: string;
  nativeThreadRef?: string | null;
}

export interface RuntimeStartParams {
  resume?: boolean;
  resumeFollowUps?: boolean;
}

export interface TurnStartParams {
  text: string;
  delivery?: V2DeliveryChannel | null;
  expectedState?: "idle";
  deliverPartial?: boolean;
}

export interface TurnSteerParams {
  text: string;
  expectedTurnId: string;
}

export interface TurnFollowUpParams {
  text: string;
  afterTurnId: string;
  delivery?: V2DeliveryChannel | null;
  cancelOnInterrupt?: boolean;
  deliverPartial?: boolean;
}

export interface TurnInterruptParams {
  expectedTurnId: string;
  reason?: string;
}

export interface CommandCancelParams {
  targetCommandId: string;
}

export interface RuntimeStopParams {
  mode: V2StopMode;
}

export interface HandoffRequestParams {
  mode: V2HandoffMode;
  launch: V2HandoffLaunch;
}

export interface HandoffReleaseParams {}

export type V2CommandParams =
  | RuntimeStartParams
  | TurnStartParams
  | TurnSteerParams
  | TurnFollowUpParams
  | TurnInterruptParams
  | CommandCancelParams
  | RuntimeStopParams
  | HandoffRequestParams
  | HandoffReleaseParams
  | Record<string, never>;

export interface V2CommandEnvelope {
  commandId: string;
  kind: V2CommandKind;
  target: string;
  params: Record<string, unknown>;
}

export interface V2Receipt {
  commandId: string;
  kind: V2CommandKind;
  target: string;
  state: V2ReceiptState;
  reason?: V2RejectReason;
  currentTurnId?: string | null;
  currentState?: V2RuntimeState;
  nativeTurnId?: string | null;
  providerResponseId?: string | null;
  effectStage?: V2SteerEffectStage;
  terminalId?: string | null;
  wrapperCommand?: string | null;
  message?: string;
}

export interface V2EventProviderRef {
  nativeTurnId?: string | null;
  nativeThreadRef?: string | null;
  providerResponseId?: string | null;
}

export interface V2Event {
  seq: number;
  target: string;
  at: string;
  kind: V2EventKind;
  turnId?: string | null;
  commandId?: string | null;
  data: Record<string, unknown>;
  provider?: V2EventProviderRef;
}

export interface V2FollowUpStatus {
  commandId: string;
  afterTurnId: string;
  queuedAt: string;
  text?: string;
}

export interface V2PendingCommandStatus {
  commandId: string;
  kind: V2CommandKind;
  receipt: V2ReceiptState;
}

export interface V2CurrentTurnStatus {
  turnId: string;
  nativeTurnId: string | null;
  startedAt: string;
  cause: V2TurnCause;
  commandId: string;
}

export interface V2RuntimeStatusBlock {
  pid: number | null;
  startedAt: string | null;
  generation: number;
  leaseExpiresAt: string | null;
}

export interface V2WritersStatus {
  policy: "single";
  managedFenceHeld: boolean;
  external: Array<{ pid: number; args: string; source: "process" | "terminal" }>;
  console: { kind: "none" | "v2-runtime" | "v1-job" | "handed_off"; pid?: number | null };
}

/**
 * What the target's provider can prove, so clients read receipts correctly.
 * A `not_consumed` steer under `unsupported` means unprovable, not refuted.
 */
export interface V2CapabilityStatus {
  steerConsumption: "native" | "unsupported";
}

export interface V2TargetStatus {
  target: string;
  provider: V2Provider;
  capabilities: V2CapabilityStatus;
  state: V2RuntimeState;
  runtime: V2RuntimeStatusBlock;
  thread: V2ThreadIdentity;
  currentTurn: V2CurrentTurnStatus | null;
  followUps: V2FollowUpStatus[];
  pendingCommands: V2PendingCommandStatus[];
  lastEventSeq: number;
  writers: V2WritersStatus;
  lastReconcile: { at: string | null; result: string | null };
}

export interface V2CanonicalSpan {
  fromTurnId: string | null;
  toTurnId: string | null;
  fromEventOrder: number | null;
  toEventOrder: number | null;
  closed: boolean;
  continuationMarkers: string[];
}

export function isV2CommandKind(value: unknown): value is V2CommandKind {
  return typeof value === "string" && (V2_COMMAND_KINDS as readonly string[]).includes(value);
}

export function isV2Provider(value: unknown): value is V2Provider {
  return value === "codex-lhc" || value === "pi-lhc";
}

export function isTerminalReceipt(state: V2ReceiptState): boolean {
  return (V2_TERMINAL_RECEIPTS as readonly string[]).includes(state);
}

export function mintTurnId(): string {
  return `t_${crypto.randomUUID()}`;
}

export function isCommandId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
