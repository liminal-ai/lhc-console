import { createHash } from "node:crypto";
import { describeHost } from "@lhc-console/core";
import type { AgentRecord } from "../agent-registry.ts";
import { isV2Provider, V2_PROVIDERS, type V2Provider, type V2ThreadIdentity } from "./contract.ts";

export interface WriterResource {
  key: string;
  hostId: string;
  hostHome: string;
  hostThreadId: string;
  canonicalThreadId: string;
}

export class WriterIdentityUnresolvedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriterIdentityUnresolvedError";
  }
}

export function resolveCanonicalThreadId(agent: AgentRecord): string {
  const health = agent.health;
  if (health && health.hostId !== agent.relay.hostId) {
    throw new WriterIdentityUnresolvedError(
      `cannot resolve canonical LHC thread for ${agent.id}: health.hostId ${health.hostId} does not match relay.hostId ${agent.relay.hostId}`,
    );
  }
  if (health && health.hostId === agent.relay.hostId && health.threadId.trim()) {
    return health.threadId.trim();
  }
  if (agent.relay.hostId === "pi-lhc" && looksLikeCanonicalThreadId(agent.relay.threadId)) {
    return agent.relay.threadId.trim();
  }
  if (looksLikeCanonicalThreadId(agent.relay.threadId)) return agent.relay.threadId.trim();
  throw new WriterIdentityUnresolvedError(
    `cannot resolve canonical LHC thread for ${agent.id}: set matching health.threadId or a canonical relay.threadId`,
  );
}

export function looksLikeCanonicalThreadId(value: string): boolean {
  return /^th_[A-Za-z0-9_-]+$/.test(value.trim());
}

export function resolveThreadIdentity(agent: AgentRecord): V2ThreadIdentity {
  return {
    hostId: agent.relay.hostId,
    hostThreadId: agent.relay.threadId,
    canonicalThreadId: resolveCanonicalThreadId(agent),
  };
}

export function writerResourceKey(hostHome: string, canonicalThreadId: string): string {
  return createHash("sha256").update(`${hostHome}\0${canonicalThreadId}`).digest("hex");
}

export function resolveWriterResource(agent: AgentRecord): WriterResource {
  const host = describeHost(agent.relay.hostId);
  const canonicalThreadId = resolveCanonicalThreadId(agent);
  if (!host.home) {
    throw new WriterIdentityUnresolvedError(`host home unresolved for ${agent.relay.hostId}`);
  }
  return {
    key: writerResourceKey(host.home, canonicalThreadId),
    hostId: agent.relay.hostId,
    hostHome: host.home,
    hostThreadId: agent.relay.threadId,
    canonicalThreadId,
  };
}

/**
 * Resolve the opted-in canonical writer resource for any V1/V2 target alias.
 * Native session ids may differ; the fence key is host home + health/canonical
 * thread. A V1-only alias of an opted-in resource still maps here.
 */
export function resolveOptedWriterResource(
  agents: AgentRecord[],
  target: { hostId: string; threadId: string },
): WriterResource | "unresolved" | null {
  const opted = new Map<string, WriterResource>();
  for (const agent of agents) {
    if (!agent.v2 || agent.relay.hostId !== target.hostId) continue;
    try {
      const resource = resolveWriterResource(agent);
      opted.set(resource.key, resource);
    } catch {
      // fail closed at the call site if this target itself is unresolved
    }
  }
  if (opted.size === 0) return null;

  const exact = agents.find(
    (agent) => agent.relay.hostId === target.hostId && agent.relay.threadId === target.threadId,
  );
  if (exact) {
    try {
      const resource = resolveWriterResource(exact);
      if (opted.has(resource.key)) return resource;
      // V1-only alias: its own health/canonical id still maps onto an opted resource.
      if (!exact.v2 && opted.has(resource.key) === false) {
        for (const candidate of opted.values()) {
          if (candidate.canonicalThreadId === resource.canonicalThreadId) return candidate;
        }
      }
    } catch {
      if (exact.v2) return "unresolved";
      if (
        exact.health?.hostId === target.hostId &&
        exact.health.threadId &&
        [...opted.values()].some(
          (resource) => resource.canonicalThreadId === exact.health?.threadId,
        )
      ) {
        return [...opted.values()].find(
          (resource) => resource.canonicalThreadId === exact.health?.threadId,
        )!;
      }
    }
  }

  for (const resource of opted.values()) {
    if (
      resource.hostThreadId === target.threadId ||
      resource.canonicalThreadId === target.threadId
    ) {
      return resource;
    }
  }

  const healthMatch = agents.find(
    (agent) =>
      agent.v2 &&
      agent.relay.hostId === target.hostId &&
      agent.health?.hostId === target.hostId &&
      agent.health.threadId === target.threadId,
  );
  if (healthMatch) {
    try {
      return resolveWriterResource(healthMatch);
    } catch {
      return "unresolved";
    }
  }
  return null;
}

export function requireV2Provider(hostId: string): V2Provider {
  if (isV2Provider(hostId)) return hostId;
  throw new Error(`V2 provider must be one of ${V2_PROVIDERS.join(", ")} (got ${hostId})`);
}
