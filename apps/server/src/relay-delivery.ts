import { join } from "node:path";
import type { LoadedAgentRegistry } from "./agent-registry.ts";
import {
  GroupCatchUpStore,
  resolveBacklogLimits,
  type GroupWakeDeliveryMetadata,
} from "./group-catch-up.ts";
import type { PhotonConnectorManager } from "./photon-connector.ts";
import { latestPhotonDestination, resolveLeePhotonRoute } from "./relay-sender.ts";
import type { RelayJob } from "./relay.ts";

const MAX_PHOTON_MESSAGE_LENGTH = 8_000;

export interface RelayDeliveryContext {
  agents: LoadedAgentRegistry["agents"];
  consoleHome: string;
  photonConnectors: PhotonConnectorManager | null;
}

export async function deliverRelayJob(job: RelayJob, context: RelayDeliveryContext): Promise<void> {
  const channel = job.delivery?.channel ?? (job.notify === "photon" ? "photon" : null);
  if (!channel) return;
  switch (channel) {
    case "photon":
      if (job.jobKind === "outbound" || job.target === "lee") {
        await deliverOutboundLee(job, context);
        return;
      }
      await deliverPhoton(job, context);
      return;
    default:
      throw new Error(`unsupported delivery channel: ${channel}`);
  }
}

async function deliverOutboundLee(job: RelayJob, context: RelayDeliveryContext): Promise<void> {
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
  await context.photonConnectors.send(route.connectorAgentId, route.spaceId, message);
}

async function deliverPhoton(job: RelayJob, context: RelayDeliveryContext): Promise<void> {
  const agent = context.agents.find((entry) => entry.id === job.target);
  const spaceId =
    job.delivery?.destination.spaceId ??
    agent?.channels.photon?.notifySpaceId ??
    latestPhotonDestination(context.consoleHome, job.target);
  if (!spaceId) {
    throw new Error(`agent ${job.target} has no delivery destination configured`);
  }
  if (!context.photonConnectors) {
    throw new Error("photon connectors are not running");
  }
  const message = formatPhotonMessage(job.output ?? "(empty reply)", job.id);
  await context.photonConnectors.send(job.target, spaceId, message);
  const metadata = job.delivery?.metadata as GroupWakeDeliveryMetadata | undefined;
  if (metadata?.kind === "photon_group_wake") {
    const store = new GroupCatchUpStore(
      join(context.consoleHome, "agents", job.target, "group-catch-up.sqlite"),
      resolveBacklogLimits(),
    );
    store.advanceCursor(metadata.spaceId, metadata.wakeMessageId, metadata.consumedIds);
  }
}

function formatPhotonMessage(message: string, jobId: string): string {
  if (message.length <= MAX_PHOTON_MESSAGE_LENGTH) return message;
  const suffix = `\n\n[Reply truncated for iMessage; full output remains in relay job ${jobId}.]`;
  return `${message.slice(0, MAX_PHOTON_MESSAGE_LENGTH - suffix.length)}${suffix}`;
}
