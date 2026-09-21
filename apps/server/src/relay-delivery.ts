import { join } from "node:path";
import type { LoadedAgentRegistry } from "./agent-registry.ts";
import {
  GroupCatchUpStore,
  resolveBacklogLimits,
  type GroupWakeDeliveryMetadata,
} from "./group-catch-up.ts";
import {
  fanInGroupReply,
  formatGroupReply,
  isGroupLineMetadata,
  type GroupLineWakeMetadata,
} from "./group-line.ts";
import { GroupTranscript } from "./group-transcript.ts";
import type { PhotonConnectorManager } from "./photon-connector.ts";
import {
  latestPhotonDestination,
  resolveConsoleFallbackRoute,
  resolveLeePhotonRoute,
} from "./relay-sender.ts";
import { type DeliveryReceipt, isPermanentDeliveryError, type RelayJob } from "./relay.ts";

const MAX_PHOTON_MESSAGE_LENGTH = 8_000;

export interface RelayDeliveryContext {
  agents: LoadedAgentRegistry["agents"];
  consoleHome: string;
  photonConnectors: PhotonConnectorManager | null;
  /** Transcript factory (tests inject an in-memory one). Default: the group's sqlite. */
  openTranscript?: (groupId: string) => GroupTranscript;
}

export function groupTranscriptPath(consoleHome: string, groupId: string): string {
  return join(consoleHome, "agents", groupId, "transcript.sqlite");
}

export function resolvePhotonDeliveryRoute(
  job: RelayJob,
  context: Pick<RelayDeliveryContext, "agents" | "consoleHome">,
): { agentId: string; spaceId: string } | null {
  if (job.jobKind === "outbound" || job.target === "lee") return null;
  const groupMeta = job.delivery?.metadata;
  if (isGroupLineMetadata(groupMeta) && job.delivery?.destination.spaceId) {
    // A member's reply rides the group's own line, not the member's.
    return { agentId: groupMeta.groupId, spaceId: job.delivery.destination.spaceId };
  }
  const agent = context.agents.find((entry) => entry.id === job.target);
  const spaceId =
    job.delivery?.destination.spaceId ??
    agent?.channels.photon?.notifySpaceId ??
    latestPhotonDestination(context.consoleHome, job.target);
  return spaceId ? { agentId: job.target, spaceId } : null;
}

export async function deliverRelayJob(
  job: RelayJob,
  context: RelayDeliveryContext,
): Promise<DeliveryReceipt | undefined> {
  const channel = job.delivery?.channel ?? (job.notify === "photon" ? "photon" : null);
  if (!channel) return undefined;
  switch (channel) {
    case "photon":
      if (job.jobKind === "outbound" || job.target === "lee") {
        return await deliverOutboundLee(job, context);
      }
      if (isGroupLineMetadata(job.delivery?.metadata)) {
        await deliverGroupLine(job, job.delivery.metadata, context);
        return undefined;
      }
      await deliverPhoton(job, context);
      return undefined;
    default:
      throw new Error(`unsupported delivery channel: ${channel}`);
  }
}

async function deliverOutboundLee(
  job: RelayJob,
  context: RelayDeliveryContext,
): Promise<DeliveryReceipt> {
  const metadata = job.delivery?.metadata ?? {};
  const senderAgentId =
    (typeof metadata.senderAgentId === "string" && metadata.senderAgentId) || job.sender || null;
  if (!senderAgentId) {
    throw new Error("outbound lee job is missing sender attribution");
  }
  const learnedSpaceId =
    job.delivery?.destination.spaceId ??
    latestPhotonDestination(context.consoleHome, senderAgentId);
  const route = resolveLeePhotonRoute(context.agents, senderAgentId, learnedSpaceId);
  if (!context.photonConnectors) {
    throw new Error("photon connectors are not running");
  }
  const message = formatPhotonMessage(job.output ?? job.prompt, job.id);
  if (!message.trim()) throw new Error("outbound lee job has no message to deliver");
  try {
    await context.photonConnectors.send(route.connectorAgentId, route.spaceId, message);
    return { deliveredVia: route.connectorAgentId };
  } catch (error) {
    // The sender's line cannot deliver (target not allowed, auth): one retry
    // through Console's identity, recorded on the receipt. Transient errors
    // stay with the sender's line and the queue's retry schedule.
    const fallback = resolveConsoleFallbackRoute(context.agents, route.connectorAgentId);
    if (!fallback || !isPermanentDeliveryError(error)) throw error;
    await context.photonConnectors.send(fallback.connectorAgentId, fallback.spaceId, message);
    return { deliveredVia: fallback.connectorAgentId };
  }
}

/**
 * Group-line fan-in: a completed reply is written to the transcript (advancing
 * only this member's cursor) and delivered to the owner prefixed with the
 * member's name. A failure notice is delivered prefixed but never written.
 */
async function deliverGroupLine(
  job: RelayJob,
  meta: GroupLineWakeMetadata,
  context: RelayDeliveryContext,
): Promise<void> {
  const route = resolvePhotonDeliveryRoute(job, context);
  if (!route) throw new Error(`group ${meta.groupId} has no delivery destination`);
  if (!context.photonConnectors) throw new Error("photon connectors are not running");
  let text: string;
  if (job.status === "failed") {
    text = formatFailureNotice(job);
  } else {
    const transcript =
      context.openTranscript?.(meta.groupId) ??
      new GroupTranscript(groupTranscriptPath(context.consoleHome, meta.groupId));
    try {
      const line = fanInGroupReply(transcript, meta, job);
      text = line.text || "(empty reply)";
    } finally {
      if (!context.openTranscript) transcript.close();
    }
  }
  const message = formatPhotonMessage(formatGroupReply(meta.memberLabel, text), job.id);
  await context.photonConnectors.send(route.agentId, route.spaceId, message);
}

async function deliverPhoton(job: RelayJob, context: RelayDeliveryContext): Promise<void> {
  const route = resolvePhotonDeliveryRoute(job, context);
  if (!route) {
    throw new Error(`agent ${job.target} has no delivery destination configured`);
  }
  if (!context.photonConnectors) {
    throw new Error("photon connectors are not running");
  }
  const message =
    job.status === "failed"
      ? formatFailureNotice(job)
      : formatPhotonMessage(job.output?.trim() ? job.output : "(empty reply)", job.id);
  await context.photonConnectors.send(route.agentId, route.spaceId, message);
  const metadata = job.delivery?.metadata as GroupWakeDeliveryMetadata | undefined;
  if (metadata?.kind === "photon_group_wake") {
    const store = new GroupCatchUpStore(
      join(context.consoleHome, "agents", job.target, "group-catch-up.sqlite"),
      resolveBacklogLimits(),
    );
    store.advanceCursor(metadata.spaceId, metadata.wakeMessageId, metadata.consumedIds);
  }
}

const MAX_FAILURE_DETAIL_LENGTH = 600;

/**
 * One truthful, bounded notice for a failed direct turn. Names the job so the
 * full error stays reachable, never replays the prompt, never retries the turn.
 */
export function formatFailureNotice(job: RelayJob): string {
  const detail = (job.error ?? "unknown error").trim();
  const bounded =
    detail.length > MAX_FAILURE_DETAIL_LENGTH
      ? `${detail.slice(0, MAX_FAILURE_DETAIL_LENGTH)}…`
      : detail;
  return `⚠️ ${job.target} failed to complete your request.\n${bounded}\n[relay job ${job.id}]`;
}

export function formatPhotonMessage(message: string, jobId: string): string {
  if (message.length <= MAX_PHOTON_MESSAGE_LENGTH) return message;
  const suffix = `\n\n[Reply truncated for iMessage; full output remains in relay job ${jobId}.]`;
  return `${message.slice(0, MAX_PHOTON_MESSAGE_LENGTH - suffix.length)}${suffix}`;
}
