import type { PhotonConnectorManager } from "./photon-connector.ts";
import type { RelayJob, RelayJobLifecycle } from "./relay.ts";

/** Matches Hermes Photon adapter typing cooldown. */
export const PHOTON_TYPING_REFRESH_MS = 5_000;

export function isPhotonAgentTypingJob(job: RelayJob): boolean {
  if (job.jobKind !== "agent" || job.target === "lee") return false;
  const channel = job.delivery?.channel ?? (job.notify === "photon" ? "photon" : null);
  return channel === "photon";
}

function resolvePhotonSpaceId(job: RelayJob): string | null {
  const spaceId = job.delivery?.destination.spaceId;
  return typeof spaceId === "string" && spaceId ? spaceId : null;
}

interface ActiveSession {
  agentId: string;
  spaceId: string;
  refreshTimer: ReturnType<typeof setInterval> | null;
  stopping: boolean;
  startInFlight: Promise<void> | null;
}

export interface PhotonTypingRoute {
  agentId: string;
  spaceId: string;
}

type ResolvePhotonTypingRoute = (job: RelayJob) => PhotonTypingRoute | null;

export class PhotonTypingCoordinator {
  readonly #connectors: Pick<PhotonConnectorManager, "typing">;
  readonly #resolveRoute: ResolvePhotonTypingRoute;
  readonly #sessions = new Map<string, ActiveSession>();
  readonly #pending = new Set<string>();
  readonly #reconciled = new Set<string>();

  constructor(
    connectors: Pick<PhotonConnectorManager, "typing">,
    resolveRoute: ResolvePhotonTypingRoute = (job) => {
      const spaceId = resolvePhotonSpaceId(job);
      return spaceId ? { agentId: job.target, spaceId } : null;
    },
  ) {
    this.#connectors = connectors;
    this.#resolveRoute = resolveRoute;
  }

  lifecycle(): RelayJobLifecycle {
    return {
      onRunning: (job) => this.onRunning(job),
      onSpawn: (job) => this.onSpawn(job),
      onFinished: (job) => this.onFinished(job),
      onCancellationIntent: (job) => this.onFinished(job),
      onClose: () => this.close(),
    };
  }

  onRunning(job: RelayJob): void {
    if (!isPhotonAgentTypingJob(job) || this.#reconciled.has(job.id)) return;
    this.#pending.add(job.id);
  }

  onSpawn(job: RelayJob): void {
    if (
      !this.#pending.has(job.id) ||
      !isPhotonAgentTypingJob(job) ||
      this.#reconciled.has(job.id)
    ) {
      return;
    }
    const route = this.#resolveRoute(job);
    if (!route) return;
    if (this.#sessions.has(job.id)) return;
    this.#pending.delete(job.id);
    const session: ActiveSession = {
      agentId: route.agentId,
      spaceId: route.spaceId,
      refreshTimer: null,
      stopping: false,
      startInFlight: null,
    };
    this.#sessions.set(job.id, session);
    session.startInFlight = this.#sendStart(session).finally(() => {
      session.startInFlight = null;
    });
    session.refreshTimer = setInterval(() => {
      void this.#sendStart(session);
    }, PHOTON_TYPING_REFRESH_MS);
  }

  async onFinished(job: RelayJob): Promise<void> {
    this.#pending.delete(job.id);
    await this.#stop(job.id);
  }

  async close(): Promise<void> {
    await Promise.all([...this.#sessions.keys()].map((id) => this.#stop(id)));
    this.#pending.clear();
  }

  reconcileInterruptedJobs(jobs: Iterable<RelayJob>): void {
    for (const job of jobs) {
      if (job.status !== "running" || !isPhotonAgentTypingJob(job)) continue;
      const route = this.#resolveRoute(job);
      if (!route) continue;
      this.#reconciled.add(job.id);
      this.#pending.delete(job.id);
      void this.#sendStop(route.agentId, route.spaceId);
    }
  }

  async #stop(jobId: string): Promise<void> {
    const session = this.#sessions.get(jobId);
    if (!session || session.stopping) return;
    session.stopping = true;
    if (session.refreshTimer) {
      clearInterval(session.refreshTimer);
      session.refreshTimer = null;
    }
    this.#sessions.delete(jobId);
    if (session.startInFlight) await session.startInFlight;
    await this.#sendStop(session.agentId, session.spaceId);
  }

  async #sendStart(session: ActiveSession): Promise<void> {
    if (session.stopping) return;
    try {
      await this.#connectors.typing(session.agentId, session.spaceId, "start");
    } catch (error) {
      this.#logTypingError("start", session, error);
    }
  }

  async #sendStop(agentId: string, spaceId: string): Promise<void> {
    try {
      await this.#connectors.typing(agentId, spaceId, "stop");
    } catch (error) {
      this.#logTypingError("stop", { agentId, spaceId }, error);
    }
  }

  #logTypingError(
    action: "start" | "stop",
    target: { agentId: string; spaceId: string },
    error: unknown,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[photon-typing:${target.agentId}] ${action} failed for ${target.spaceId}: ${message}`,
    );
  }
}
