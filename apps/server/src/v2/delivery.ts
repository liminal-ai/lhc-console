import { formatPhotonMessage } from "../relay-delivery.ts";
import { latestPhotonDestination } from "../relay-sender.ts";
import type { AgentRecord } from "../agent-registry.ts";
import type { PhotonConnectorManager } from "../photon-connector.ts";
import {
  DELIVERY_HEARTBEAT_MS,
  DELIVERY_LEASE_MS,
  DELIVERY_RETRY_BASE_MS,
  DELIVERY_RETRY_MAX_MS,
} from "../relay.ts";
import type { V2Store } from "./store.ts";

/**
 * Durable V2 Photon delivery. Truncation matches V1 (`formatPhotonMessage`).
 * Lease, heartbeat, reclaim and retry use the same timing constants as V1.
 */
export async function deliverV2PhotonText(input: {
  target: string;
  commandId: string;
  text: string;
  turnId?: string | null;
  agents: AgentRecord[];
  consoleHome: string;
  photonConnectors: PhotonConnectorManager | null;
  store?: V2Store;
}): Promise<"delivered" | "failed"> {
  if (input.store) {
    input.store.enqueueDelivery({
      commandId: input.commandId,
      target: input.target,
      turnId: input.turnId,
      text: input.text,
    });
    return await deliverClaimedV2Photon(input.store, input.commandId, {
      agents: input.agents,
      consoleHome: input.consoleHome,
      photonConnectors: input.photonConnectors,
    });
  }
  return await sendV2PhotonOnce(input);
}

export async function drainV2Deliveries(input: {
  store: V2Store;
  agents: AgentRecord[];
  consoleHome: string;
  photonConnectors: PhotonConnectorManager | null;
}): Promise<void> {
  for (const pending of input.store.listPendingDeliveries()) {
    await deliverClaimedV2Photon(input.store, pending.commandId, input);
  }
}

async function deliverClaimedV2Photon(
  store: V2Store,
  commandId: string,
  context: {
    agents: AgentRecord[];
    consoleHome: string;
    photonConnectors: PhotonConnectorManager | null;
  },
): Promise<"delivered" | "failed"> {
  const row = store.getDelivery(commandId);
  if (!row) return "failed";
  if (row.status === "delivered") return "delivered";
  const token = store.claimDelivery(commandId, DELIVERY_LEASE_MS);
  if (!token) return row.status === "delivered" ? "delivered" : "failed";
  let leaseLost = false;
  const heartbeat = setInterval(() => {
    if (!store.renewDeliveryLease(commandId, token, DELIVERY_LEASE_MS)) leaseLost = true;
  }, DELIVERY_HEARTBEAT_MS);
  try {
    await sendV2PhotonOnce({
      target: row.target,
      commandId,
      text: row.text,
      agents: context.agents,
      consoleHome: context.consoleHome,
      photonConnectors: context.photonConnectors,
    });
    if (leaseLost || !store.renewDeliveryLease(commandId, token, DELIVERY_LEASE_MS))
      return "failed";
    return store.finalizeDelivery(commandId, token, { status: "delivered" })
      ? "delivered"
      : "failed";
  } catch (error) {
    if (!leaseLost) {
      store.finalizeDelivery(commandId, token, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return "failed";
  } finally {
    clearInterval(heartbeat);
  }
}

export function v2DeliveryRetryDelayMs(attempt: number): number {
  return Math.min(DELIVERY_RETRY_MAX_MS, DELIVERY_RETRY_BASE_MS * 2 ** Math.max(0, attempt));
}

async function sendV2PhotonOnce(input: {
  target: string;
  commandId: string;
  text: string;
  agents: AgentRecord[];
  consoleHome: string;
  photonConnectors: PhotonConnectorManager | null;
}): Promise<"delivered" | "failed"> {
  const agent = input.agents.find((entry) => entry.id === input.target);
  const spaceId =
    agent?.channels.photon?.notifySpaceId ??
    latestPhotonDestination(input.consoleHome, input.target);
  if (!spaceId || !input.photonConnectors) {
    throw new Error(`agent ${input.target} has no delivery destination configured`);
  }
  const message = formatPhotonMessage(
    input.text.trim() ? input.text : "(empty reply)",
    input.commandId,
  );
  await input.photonConnectors.send(input.target, spaceId, message);
  return "delivered";
}
