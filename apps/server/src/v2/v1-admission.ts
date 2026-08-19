import type { RelayTarget } from "../relay.ts";
import type { RuntimeManager } from "./manager.ts";
import { resolveOptedWriterResource } from "./identity.ts";
import type { AgentRecord } from "../agent-registry.ts";
import { releaseWriterLock, tryAcquireWriterLock, type HeldWriterLock } from "./writer-lock.ts";

/**
 * V1 launch-boundary admission for canonical writer resources opted into V2.
 * When V2 is disabled or the resource has no v2 block, V1 keeps its current
 * isBusy behavior exactly.
 */
export function createV1Admission(options: {
  enabled: boolean;
  consoleHome: string;
  agents: AgentRecord[];
  manager: RuntimeManager | null;
  isBusy: (target: RelayTarget) => boolean | Promise<boolean>;
}): {
  isBusy: (target: RelayTarget) => boolean | Promise<boolean>;
  acquireForLaunch: (target: RelayTarget) => HeldWriterLock | "blocked" | "unresolved" | null;
} {
  return {
    async isBusy(target) {
      const busy = await options.isBusy(target);
      if (busy) return true;
      if (!options.enabled || !options.manager) return false;
      const resolved = resolveOptedWriterResource(options.agents, target);
      if (!resolved) return false;
      if (resolved === "unresolved") return true;
      try {
        return options.manager.ownsResource(resolved.key);
      } catch {
        return true;
      }
    },
    acquireForLaunch(target) {
      if (!options.enabled || !options.manager) return null;
      const resolved = resolveOptedWriterResource(options.agents, target);
      if (!resolved) return null;
      if (resolved === "unresolved") return "unresolved";
      const resource = resolved;
      // Bookkeeping first: a v1-job row whose owner process is gone is stale
      // metadata, not exclusion, and must not fence a launch forever.
      if (options.manager.staleV1Owner(resource.key)) {
        options.manager.clearManagedOwner(resource.key);
      }
      if (options.manager.ownsResource(resource.key)) return "blocked";
      // No pre-probe: acquisition is atomic, and a probe would briefly hold
      // the fence itself and could bounce a concurrent legitimate acquirer.
      const attempt = tryAcquireWriterLock(options.consoleHome, resource);
      if (!attempt.ok || !attempt.held) return "blocked";
      options.manager.noteManagedOwner(resource, "v1-job", process.pid);
      return attempt.held;
    },
  };
}

export function releaseLaunchLock(
  held: HeldWriterLock | null | undefined,
  manager?: RuntimeManager | null,
): void {
  if (held && manager) manager.clearManagedOwner(held.resourceKey);
  releaseWriterLock(held);
}
