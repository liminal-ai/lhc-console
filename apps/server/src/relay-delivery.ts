import { join } from "node:path";
import type { LoadedAgentRegistry } from "./agent-registry.ts";
import {
  GroupCatchUpStore,
  resolveBacklogLimits,
  type GroupWakeDeliveryMetadata,
} from "./group-catch-up.ts";
import type { PhotonConnectorManager } from "./photon-connector.ts";
import type { RelayJob } from "./relay.ts";

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
      await deliverPhoton(job, context);
      return;
    default:
      throw new Error(`unsupported delivery channel: ${channel}`);
  }
}

async function deliverPhoton(job: RelayJob, context: RelayDeliveryContext): Promise<void> {
  const agent = context.agents.find((entry) => entry.id === job.target);
  const spaceId = job.delivery?.destination.spaceId ?? agent?.channels.photon?.notifySpaceId;
  if (!spaceId) {
    throw new Error(`agent ${job.target} has no delivery destination configured`);
  }
  if (!context.photonConnectors) {
    throw new Error("photon connectors are not running");
  }
  const message = job.output ?? "(empty reply)";
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
