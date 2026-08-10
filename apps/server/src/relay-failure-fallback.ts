import { join } from "node:path";
import {
  GroupCatchUpStore,
  resolveBacklogLimits,
  type GroupWakeDeliveryMetadata,
} from "./group-catch-up.ts";
import type { RelayJob } from "./relay.ts";

export function applyGroupWakeFailureFallback(job: RelayJob, consoleHome: string): boolean {
  const metadata = job.delivery?.metadata as GroupWakeDeliveryMetadata | undefined;
  if (!metadata || metadata.kind !== "photon_group_wake") return false;
  const store = new GroupCatchUpStore(
    join(consoleHome, "agents", job.target, "group-catch-up.sqlite"),
    resolveBacklogLimits(),
  );
  return store.append(metadata.spaceId, {
    messageId: metadata.fallback.messageId,
    senderId: metadata.fallback.senderId ?? "unknown",
    text: metadata.fallback.text,
    timestamp: metadata.fallback.timestamp,
    senderAuthorized: true,
  });
}
