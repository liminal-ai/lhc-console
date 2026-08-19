/**
 * Open owner decisions for Console V2 (design §12.2 Q1–Q4).
 *
 * These are selectable configuration, not product defaults. A value may be
 * supplied by an explicit owner-configured policy object or, in tests, by a
 * fixture labeled test-only. Resolvers never invent an owner settlement.
 */

export const OPEN_OWNER_DECISIONS = ["Q1", "Q2", "Q3", "Q4"] as const;
export type OpenOwnerDecision = (typeof OPEN_OWNER_DECISIONS)[number];

/** Q1: reuse the V1 relay bearer token, or require a second owner-only token. */
export type AuthTokenPolicy = "reuse-v1-relay-token" | "owner-only-v2-token";

/**
 * Q2: runtime processes as console children (this design's recommendation) or
 * detached runtimes that can survive console restart.
 */
export type RuntimeProcessPolicy = "console-child" | "detached";

/**
 * Q3: after handoff/restart, whether held follow-ups resume when the runtime
 * starts again. Callers may also pass `resumeFollowUps` on `runtime.start`.
 */
export type HeldFollowUpResumePolicy = "resume" | "hold";

/**
 * Q4: Codex approvals under V2. Bypass matches V1 launches; surface keeps
 * `serverRequest` events for a later `approval.respond` command (DEFERRED D1).
 */
export type CodexApprovalPolicy = "bypass-at-spawn" | "surface-server-requests";

export interface V2OwnerPolicies {
  authToken: AuthTokenPolicy;
  runtimeProcess: RuntimeProcessPolicy;
  heldFollowUpResume: HeldFollowUpResumePolicy;
  codexApprovals: CodexApprovalPolicy;
}

export type PolicySource = "explicit" | "test-only";

export interface ResolvedV2OwnerPolicies {
  policies: V2OwnerPolicies;
  source: PolicySource;
  /** Present only when a test fixture supplied the values. */
  testOnly?: true;
}

export class UnsettledOwnerPolicyError extends Error {
  readonly decision: OpenOwnerDecision;

  constructor(decision: OpenOwnerDecision, detail: string) {
    super(`LIM-75 owner decision ${decision} is unset: ${detail}`);
    this.name = "UnsettledOwnerPolicyError";
    this.decision = decision;
  }
}

const AUTH_TOKEN_POLICIES = new Set<AuthTokenPolicy>([
  "reuse-v1-relay-token",
  "owner-only-v2-token",
]);
const RUNTIME_PROCESS_POLICIES = new Set<RuntimeProcessPolicy>(["console-child", "detached"]);
const HELD_FOLLOW_UP_POLICIES = new Set<HeldFollowUpResumePolicy>(["resume", "hold"]);
const CODEX_APPROVAL_POLICIES = new Set<CodexApprovalPolicy>([
  "bypass-at-spawn",
  "surface-server-requests",
]);

export function parseAuthTokenPolicy(value: unknown, label = "authToken"): AuthTokenPolicy {
  if (typeof value === "string" && AUTH_TOKEN_POLICIES.has(value as AuthTokenPolicy)) {
    return value as AuthTokenPolicy;
  }
  throw new UnsettledOwnerPolicyError(
    "Q1",
    `${label} must be reuse-v1-relay-token or owner-only-v2-token`,
  );
}

export function parseRuntimeProcessPolicy(
  value: unknown,
  label = "runtimeProcess",
): RuntimeProcessPolicy {
  if (typeof value === "string" && RUNTIME_PROCESS_POLICIES.has(value as RuntimeProcessPolicy)) {
    return value as RuntimeProcessPolicy;
  }
  throw new UnsettledOwnerPolicyError("Q2", `${label} must be console-child or detached`);
}

export function parseHeldFollowUpResumePolicy(
  value: unknown,
  label = "heldFollowUpResume",
): HeldFollowUpResumePolicy {
  if (typeof value === "string" && HELD_FOLLOW_UP_POLICIES.has(value as HeldFollowUpResumePolicy)) {
    return value as HeldFollowUpResumePolicy;
  }
  throw new UnsettledOwnerPolicyError("Q3", `${label} must be resume or hold`);
}

export function parseCodexApprovalPolicy(
  value: unknown,
  label = "codexApprovals",
): CodexApprovalPolicy {
  if (typeof value === "string" && CODEX_APPROVAL_POLICIES.has(value as CodexApprovalPolicy)) {
    return value as CodexApprovalPolicy;
  }
  throw new UnsettledOwnerPolicyError(
    "Q4",
    `${label} must be bypass-at-spawn or surface-server-requests`,
  );
}

export function parseV2OwnerPolicies(raw: unknown, label = "v2.policies"): V2OwnerPolicies {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new UnsettledOwnerPolicyError("Q1", `${label} must be an object settling Q1–Q4`);
  }
  const input = raw as Record<string, unknown>;
  return {
    authToken: parseAuthTokenPolicy(input.authToken, `${label}.authToken`),
    runtimeProcess: parseRuntimeProcessPolicy(input.runtimeProcess, `${label}.runtimeProcess`),
    heldFollowUpResume: parseHeldFollowUpResumePolicy(
      input.heldFollowUpResume,
      `${label}.heldFollowUpResume`,
    ),
    codexApprovals: parseCodexApprovalPolicy(input.codexApprovals, `${label}.codexApprovals`),
  };
}

/**
 * Resolve owner policies from an explicit configured object. Absence is not a
 * default; it is an unsettled decision.
 */
export function resolveConfiguredOwnerPolicies(
  raw: unknown,
  label = "v2.policies",
): ResolvedV2OwnerPolicies {
  return { policies: parseV2OwnerPolicies(raw, label), source: "explicit" };
}

/**
 * Test-only policy fixture. Callers must pass `testOnly: true` so a test
 * default cannot be mistaken for product behavior.
 */
export function testOnlyOwnerPolicies(policies: V2OwnerPolicies): ResolvedV2OwnerPolicies {
  return { policies, source: "test-only", testOnly: true };
}

export const TEST_ONLY_OWNER_POLICIES: V2OwnerPolicies = {
  authToken: "reuse-v1-relay-token",
  runtimeProcess: "console-child",
  heldFollowUpResume: "hold",
  codexApprovals: "bypass-at-spawn",
};

export function requireOwnerPolicies(
  resolved: ResolvedV2OwnerPolicies | null | undefined,
): V2OwnerPolicies {
  if (!resolved) {
    throw new UnsettledOwnerPolicyError("Q1", "no owner policy object was supplied");
  }
  return resolved.policies;
}

export function describeUnsetOwnerDecisions(): Record<OpenOwnerDecision, string> {
  return {
    Q1: "Reuse the V1 relay bearer token for /api/v2, or mint a second owner-only token?",
    Q2: "Runtime processes as console children versus detached runtimes that survive console restart?",
    Q3: "On runtime.start after handoff/restart, do held follow-ups resume by default?",
    Q4: "Codex approvals under V2: bypass at spawn, or surface serverRequest approvals as events?",
  };
}
