import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { globSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  browseDirs,
  discoverHosts,
  hermesProfiles,
  isExistingDir,
  launchableHostIds,
  planNewSession,
  quickDirs,
  launchRecipe,
  parseNamePatch,
  listMessages,
  listThreads,
  listTurns,
  measurementAlarms,
  readNewestCodexRolloutMeasurements,
  resolveThread,
  threadOverview,
  threadQuickStats,
  threadViewArrangement,
  turnKinds,
  viewBands,
  type ThreadSummary,
  writerPolicyFor,
  type ThreadQuickStats,
  type WriterPolicy,
} from "@lhc-console/core";
import {
  hiddenCount,
  hideThread,
  isHidden,
  loadPrefs,
  newSessionRoots,
  setThreadName,
  threadName,
  unhideThread,
} from "./prefs.ts";
import {
  newSessionEnv,
  ownTerminals,
  registerTerminalRoutes,
  shutdownTerminals,
} from "./terminals.ts";
import {
  detectAttached,
  detectAttachedOne,
  invalidateProcessScan,
  type AttachInfo,
} from "./attach-detect.ts";
import { loadRelayToken } from "./relay-config.ts";
import { executeRelayTarget } from "./relay-process.ts";
import { registerRelayRoutes } from "./relay-routes.ts";
import { RelayQueue } from "./relay.ts";
import { deliverRelayJob, resolvePhotonDeliveryRoute } from "./relay-delivery.ts";
import { isRegisteredRelayTarget, loadAgentRegistry } from "./agent-registry.ts";
import { PhotonConnectorManager } from "./photon-connector.ts";
import { PhotonTypingCoordinator } from "./photon-typing.ts";
import { MonitorService } from "./monitor.ts";
import { registerMonitorRoutes } from "./monitor-routes.ts";
import { GoalService } from "./goal.ts";
import { assertLegacyGoalsStartupSafe } from "./goal-migrate.ts";
import { registerGoalRoutes } from "./goal-routes.ts";
import { registerAgentRoutes } from "./agent-routes.ts";
import { createProviderAdapter } from "./v2/adapters/factory.ts";
import { inspectCanonicalSpan } from "./v2/canonical.ts";
import { isV2Enabled, loadConfiguredOwnerPolicies, v2BearerToken, v2DbPath } from "./v2/config.ts";
import { RuntimeManager } from "./v2/manager.ts";
import { UnsettledOwnerPolicyError } from "./v2/policies.ts";
import { registerV2Routes } from "./v2/routes.ts";
import { V2Store } from "./v2/store.ts";
import { resolveOptedWriterResource } from "./v2/identity.ts";
import { createV1Admission, releaseLaunchLock } from "./v2/v1-admission.ts";

const PORT = Number(process.env.LHC_CONSOLE_PORT ?? 5959);

const app = Fastify({ logger: { level: "info" } });

const consoleHome = process.env.LHC_CONSOLE_HOME ?? join(homedir(), ".lhc-console");
assertLegacyGoalsStartupSafe(consoleHome);
const agentRegistry = loadAgentRegistry(consoleHome);
const relayToken = loadRelayToken(consoleHome);
const photonRef: { current: PhotonConnectorManager | null } = { current: null };
const photonTypingRef: { current: PhotonTypingCoordinator | null } = { current: null };
const v1RunningRef: { current: ((resourceKey: string) => boolean) | null } = { current: null };

const relayDbPath = join(consoleHome, "relay.sqlite");
const relayTargets: Record<string, import("./relay.ts").RelayTarget> = {
  lee: {
    hostId: "lee",
    threadId: "lee",
    cwd: consoleHome,
    command: process.execPath,
    args: ["-e", "process.exit(1)"],
  },
};
for (const [id, target] of Object.entries(agentRegistry.relayTargets)) {
  relayTargets[id] = {
    ...target,
    env: { ...target.env, LHC_AGENT_ID: id },
  };
}

const v2Enabled = isV2Enabled();
const v2Policies = v2Enabled ? loadConfiguredOwnerPolicies(consoleHome) : null;
if (v2Enabled && !v2Policies) {
  throw new UnsettledOwnerPolicyError(
    "Q1",
    "LHC_CONSOLE_V2=1 requires an explicit owner policy object in LHC_CONSOLE_V2_POLICIES or ~/.lhc-console/v2-policies.json",
  );
}
const v2Store = v2Enabled ? new V2Store({ dbPath: v2DbPath(consoleHome) }) : null;
const v2Manager =
  v2Store && v2Policies
    ? new RuntimeManager({
        store: v2Store,
        consoleHome,
        agents: agentRegistry.agents,
        policies: v2Policies,
        adapterFactory: (provider) => createProviderAdapter(provider),
        detectBusy: (target) =>
          detectAttachedOne(
            {
              hostId: target.hostId,
              threadId: target.threadId,
              recipe: { command: target.recipeCommand ?? "", sessionRef: target.threadId },
            },
            ownTerminals(),
            { includeOwnProcesses: true },
          ),
        v1Running: (resourceKey) => v1RunningRef.current?.(resourceKey) ?? false,
        ownTerminals: () => ownTerminals(),
        inspectCanonical: inspectCanonicalSpan,
        deliver: async (input) => {
          const { deliverV2PhotonText } = await import("./v2/delivery.ts");
          return deliverV2PhotonText({
            ...input,
            agents: agentRegistry.agents,
            consoleHome,
            photonConnectors: photonRef.current,
            store: v2Store,
          });
        },
      })
    : null;
if (v2Manager) {
  // Reconcile, then dispatch what reconciliation proved was never sent, before
  // any route can accept new work for these targets.
  await v2Manager.reconcileAll();
  if (v2Store) {
    const { drainV2Deliveries } = await import("./v2/delivery.ts");
    void drainV2Deliveries({
      store: v2Store,
      agents: agentRegistry.agents,
      consoleHome,
      photonConnectors: photonRef.current,
    });
    const retry = setInterval(() => {
      if (!v2Store) return;
      void drainV2Deliveries({
        store: v2Store,
        agents: agentRegistry.agents,
        consoleHome,
        photonConnectors: photonRef.current,
      });
    }, 1_000);
    retry.unref?.();
  }
}

const v1Busy = (target: import("./relay.ts").RelayTarget) => {
  if (target.hostId === "lee") return false;
  invalidateProcessScan();
  return (
    detectAttachedOne(
      {
        hostId: target.hostId,
        threadId: target.threadId,
        recipe: { command: target.command, sessionRef: target.threadId },
      },
      [],
      { includeOwnProcesses: true },
    ).attached.length > 0
  );
};
const v1Admission = createV1Admission({
  enabled: v2Enabled,
  consoleHome,
  agents: agentRegistry.agents,
  manager: v2Manager,
  isBusy: v1Busy,
});

const relayQueue = new RelayQueue({
  dbPath: relayDbPath,
  targets: relayTargets,
  isBusy: (target) => v1Admission.isBusy(target),
  acquireWriterLock: (target) => v1Admission.acquireForLaunch(target),
  releaseWriterLock: (held) =>
    releaseLaunchLock(held as import("./v2/writer-lock.ts").HeldWriterLock, v2Manager),
  execute: (target, prompt, signal, lifecycle, writerLock) =>
    executeRelayTarget(target, prompt, {
      signal,
      onSpawn: lifecycle?.onSpawn,
      writerLock: writerLock as import("./v2/writer-lock.ts").HeldWriterLock | undefined,
    }),
  deliver: async (job) => {
    await deliverRelayJob(job, {
      agents: agentRegistry.agents,
      consoleHome,
      photonConnectors: photonRef.current,
    });
  },
  jobLifecycle: {
    onRunning: (job) => photonTypingRef.current?.onRunning(job),
    onSpawn: (job) => photonTypingRef.current?.onSpawn(job),
    onFinished: (job) => photonTypingRef.current?.onFinished(job),
    onCancellationIntent: (job) => photonTypingRef.current?.onFinished(job),
    onClose: () => photonTypingRef.current?.close(),
  },
  consoleHome,
});
v1RunningRef.current = (resourceKey) =>
  relayQueue.listRunningJobs().some((job) => {
    const target = relayTargets[job.target];
    if (!target) return false;
    const resolved = resolveOptedWriterResource(agentRegistry.agents, target);
    return resolved !== null && resolved !== "unresolved" && resolved.key === resourceKey;
  });

const goalService = new GoalService({
  dbPath: relayDbPath,
  relayQueue,
  targetExists: (target) => isRegisteredRelayTarget(agentRegistry.relayTargets, target),
});
const removeGoalSettledListener = relayQueue.addSettledListener((job) =>
  goalService.notifyJobSettled(job),
);

const photonConnectors = new PhotonConnectorManager({
  agents: agentRegistry.agents,
  consoleHome,
  queue: relayQueue,
  v2: v2Manager,
});
photonRef.current = photonConnectors;
photonTypingRef.current = new PhotonTypingCoordinator(photonConnectors, (job) =>
  resolvePhotonDeliveryRoute(job, { agents: agentRegistry.agents, consoleHome }),
);

await photonConnectors.start();
photonTypingRef.current.reconcileInterruptedJobs(relayQueue.listRunningJobs());
relayQueue.start();

const monitorService = new MonitorService({
  dbPath: join(consoleHome, "monitor.sqlite"),
  enqueue: ({ target, prompt, notify }) => relayQueue.enqueue({ target, prompt, notify }),
  getJob: (id) => relayQueue.get(id),
  targetExists: (target) => isRegisteredRelayTarget(agentRegistry.relayTargets, target),
  lastActivityAt: (targetId) => {
    const target = relayTargets[targetId];
    if (!target) return null;
    const host = discoverHosts().find((candidate) => candidate.id === target.hostId);
    if (!host) return null;
    try {
      const thread = resolveThread(host, target.threadId);
      return thread?.fileMtime ? new Date(thread.fileMtime) : null;
    } catch {
      return null;
    }
  },
});
monitorService.start();

goalService.start();

/**
 * Quick-stats cache keyed by thread file path + mtime, so the aggregated
 * list stays fast without ever serving stale numbers.
 */
const statsCache = new Map<string, { mtime: string; stats: ThreadQuickStats }>();

/** A zero-message thread this old is a shell that will never fill in. */
const EMPTY_QUIESCENT_MS = 10 * 60_000;

function cachedQuickStats(t: ThreadSummary): ThreadQuickStats | null {
  if (!t.fileMtime) return null;
  const hit = statsCache.get(t.filePath);
  if (hit && hit.mtime === t.fileMtime) return hit.stats;
  try {
    const stats = threadQuickStats(t.filePath);
    statsCache.set(t.filePath, { mtime: t.fileMtime, stats });
    return stats;
  } catch {
    return null;
  }
}

function codexMeasurements(sessionRef: string | null) {
  if (!sessionRef) return null;
  const paths = globSync(
    join(homedir(), ".codex", "sessions", "*", "*", "*", `*${sessionRef}.jsonl`),
  );
  return readNewestCodexRolloutMeasurements(paths);
}

/**
 * Cache-only read of the same stats. Quick-dirs wants a "last active" per
 * thread but must not become a reason to open forty thread files: when the
 * stats are already cached it uses the real last-event time, otherwise the
 * file's mtime, which is within seconds of it anyway.
 */
function peekQuickStats(t: ThreadSummary): ThreadQuickStats | null {
  const hit = statsCache.get(t.filePath);
  return hit && hit.mtime === t.fileMtime ? hit.stats : null;
}

type Lookup = { thread: ThreadSummary } | { code: number; error: string };

/**
 * The console's own name for a thread, as the client sees it. The host
 * `title` is served untouched alongside it — which of the two is displayed is
 * the client's call, and the raw registry title stays visible on the detail
 * page either way.
 */
function customName(
  hostId: string,
  threadId: string,
): {
  title: string | null;
  description: string | null;
} | null {
  const entry = threadName(hostId, threadId);
  return entry ? { title: entry.title, description: entry.description } : null;
}

/**
 * Carry the attach state on the launch recipe itself: `inUse` is true only for
 * attachments that are NOT one of our terminals (those the UI already handles
 * by jumping to the screen), `attached` names the pids so a row can say which
 * process it means, and `writerPolicy` says whether that is a warning
 * ("single") or a neutral note ("shared").
 */
function withAttach(
  hostId: string,
  recipe: ReturnType<typeof launchRecipe>,
  info: AttachInfo | undefined,
):
  | (ReturnType<typeof launchRecipe> & {
      inUse: boolean;
      attached: AttachInfo["attached"];
      writerPolicy: WriterPolicy;
    })
  | null {
  if (!recipe) return null;
  return {
    ...recipe,
    inUse: info?.inUse ?? false,
    attached: info?.attached ?? [],
    writerPolicy: info?.writerPolicy ?? writerPolicyFor(hostId),
  };
}

/**
 * Resolve `:host/:id`, distinguishing an unknown host (404 "unknown host")
 * from a known host with no such thread (404 "thread not found") and from an
 * ambiguous id prefix (400) — the old path let all three fall out as a 500.
 */
function lookupThread(hostId: string, threadId: string): Lookup {
  const host = discoverHosts().find((h) => h.id === hostId);
  if (!host) return { code: 404, error: "unknown host" };
  let thread;
  try {
    thread = resolveThread(host, threadId);
  } catch (e) {
    return { code: 400, error: e instanceof Error ? e.message : String(e) };
  }
  if (!thread || !thread.fileMtime) return { code: 404, error: "thread not found" };
  return { thread };
}

await app.register(websocket);
registerTerminalRoutes(app, lookupThread);
registerRelayRoutes(app, {
  queue: relayQueue,
  token: relayToken,
  agents: agentRegistry.agents,
  consoleHome,
});
if (v2Manager && v2Policies) {
  registerV2Routes(app, {
    manager: v2Manager,
    token: v2BearerToken(v2Policies.policies, relayToken),
    enabled: v2Enabled,
  });
}
registerMonitorRoutes(app, { service: monitorService, token: relayToken });
registerGoalRoutes(app, { service: goalService, token: relayToken });
registerAgentRoutes(app, { agents: agentRegistry.agents, token: relayToken });

app.get("/api/hosts", async () => {
  const launchable = new Set(launchableHostIds(discoverHosts().map((h) => h.id)));
  return discoverHosts().map((h) => ({
    ...h,
    threadCount: listThreads(h).length,
    /** A new session can be started here (never t3code, which is web-managed). */
    launchable: launchable.has(h.id),
  }));
});

/**
 * Everything the new-session modal needs to open: which hosts can be started,
 * which hermes profiles exist, and where the directory picker should begin.
 * One fetch, because the modal opens on a keystroke.
 */
app.get("/api/new-session/options", async () => {
  const hostIds = launchableHostIds(discoverHosts().map((h) => h.id));
  const roots = newSessionRoots();
  return {
    hosts: hostIds.map((id) => ({
      id,
      writerPolicy: writerPolicyFor(id),
      /** Hermes picks a profile instead of a directory. */
      picks: id === "hermes" ? "profile" : "directory",
    })),
    hermesProfiles: hermesProfiles(),
    defaultRoot: roots.defaultRoot,
    rootByHost: roots.rootByHost,
  };
});

/**
 * What would run, without running it. The modal shows this and the copy
 * button hands it over, so the previewed string is the command itself rather
 * than a client-side reconstruction of it that could drift.
 */
app.get("/api/new-session/preview", async (req) => {
  // `hostId` everywhere: the POST body and the options response both call it
  // that, and a query parameter spelled differently is a trap for whoever
  // probes this next. `host` stays as an alias for anything already using it.
  const q = req.query as {
    hostId?: string;
    host?: string;
    cwd?: string;
    profile?: string;
    kind?: string;
  };
  const plan =
    q.kind === "shell"
      ? planNewSession({ kind: "shell", cwd: q.cwd }, newSessionEnv())
      : planNewSession(
          {
            kind: "newSession",
            hostId: q.hostId ?? q.host,
            cwd: q.cwd,
            profile: q.profile ?? null,
          },
          newSessionEnv(),
        );
  if (!plan.ok) return { command: null, error: plan.error };
  // Existence is checked here too: the modal should say "not a directory"
  // before the user presses the button, not after.
  if (!isExistingDir(plan.cwd)) {
    return { command: null, error: `not a directory: ${plan.cwd}` };
  }
  return { command: plan.command, cwd: plan.cwd, title: plan.title };
});

/**
 * Directory completion for the path picker. Always 200: a half-typed path
 * naming nothing is an ordinary state, and the picker prints the reason
 * inline rather than treating it as a failure.
 */
app.get("/api/fs/browse", async (req) => {
  const q = req.query as { path?: string };
  return browseDirs(q.path ?? "");
});

/**
 * The directories work actually happens in, most recent first. Derived from
 * the rows the list already reads — no thread files are opened for this.
 */
app.get("/api/quick-dirs", async () => {
  const rows = discoverHosts().flatMap((h) => {
    try {
      return listThreads(h);
    } catch {
      return [];
    }
  });
  return quickDirs(
    rows.map((t) => ({
      hostId: t.hostId,
      cwd: t.cwd,
      lastActiveAt: peekQuickStats(t)?.lastEventAt ?? t.fileMtime ?? t.createdAt,
    })),
  );
});

app.get("/api/threads", async (req, reply) => {
  const q = req.query as {
    host?: string;
    cwd?: string;
    q?: string;
    includeHidden?: string;
    includeEmpty?: string;
    includeSubagents?: string;
  };
  const includeHidden = q.includeHidden === "1" || q.includeHidden === "true";
  const includeEmpty = q.includeEmpty === "1" || q.includeEmpty === "true";
  const includeSubagents = q.includeSubagents === "1" || q.includeSubagents === "true";
  const known = discoverHosts();
  const scoped = q.host ? known.filter((h) => h.id === q.host) : known;
  if (q.host && scoped.length === 0) return reply.code(404).send({ error: "unknown host" });
  const hosts = scoped;
  let threads = hosts.flatMap((h) => {
    try {
      return listThreads(h);
    } catch {
      return [];
    }
  });
  if (q.cwd) threads = threads.filter((t) => t.cwd === q.cwd);
  // Hidden threads are a console-side preference: excluded by default, and
  // carried with a `hidden` flag when the client asks for them.
  if (!includeHidden) threads = threads.filter((t) => !isHidden(t.hostId, t.threadId));
  const recipes = new Map(threads.map((t) => [`${t.hostId}/${t.threadId}`, launchRecipe(t)]));
  // One process scan for the whole list: the guard must not cost an N+1.
  const attachments = detectAttached(
    threads.map((t) => ({
      hostId: t.hostId,
      threadId: t.threadId,
      recipe: recipes.get(`${t.hostId}/${t.threadId}`) ?? null,
    })),
    ownTerminals(),
  );
  let enriched = threads.map((t) => {
    const stats = cachedQuickStats(t);
    return {
      ...t,
      hidden: isHidden(t.hostId, t.threadId),
      custom: customName(t.hostId, t.threadId),
      stats,
      /**
       * Agent-spawned sub-session: real captured traffic but not one user
       * prompt (codex validation swarms get their task as an agent message).
       * Excluded by default — they are host workers, not sessions the board
       * exists for — and available under `includeSubagents=1`.
       */
      subagent: stats != null && stats.messageCount > 0 && stats.userPromptCount === 0,
      launch: withAttach(
        t.hostId,
        recipes.get(`${t.hostId}/${t.threadId}`) ?? null,
        attachments.get(`${t.hostId}/${t.threadId}`),
      ),
    };
  });
  /*
   * Threads with zero captured messages are shells, not sessions — hermes
   * background-review/curator forks create the file at agent init with
   * persistence disabled, so nothing can ever land in them (aborted sessions
   * on other hosts leave the same debris). They are dropped outright — no UI
   * toggle, by design. The age guard keeps a just-launched real session
   * visible while its first turn is still being captured; a missing stats
   * read (unreadable file) stays visible because that is an anomaly worth
   * seeing. This filter lives here, not in core listThreads: the terminal
   * newborn-association poll must keep seeing brand-new empty rows.
   */
  if (!includeSubagents) enriched = enriched.filter((t) => !t.subagent);
  if (!includeEmpty) {
    const quiescentBefore = Date.now() - EMPTY_QUIESCENT_MS;
    enriched = enriched.filter(
      (t) =>
        !t.stats ||
        t.stats.messageCount > 0 ||
        Date.parse(t.fileMtime ?? t.createdAt) > quiescentBefore,
    );
  }
  if (q.q) {
    const needle = q.q.toLowerCase();
    enriched = enriched.filter(
      (t) =>
        t.threadId.includes(needle) ||
        (t.title ?? "").toLowerCase().includes(needle) ||
        // A console-owned name is usually the only human-meaningful text on a
        // row, so it has to be searchable — under both titles, not instead of.
        (t.custom?.title ?? "").toLowerCase().includes(needle) ||
        (t.custom?.description ?? "").toLowerCase().includes(needle) ||
        (t.cwd ?? "").toLowerCase().includes(needle) ||
        (t.stats?.summary ?? "").toLowerCase().includes(needle),
    );
  }
  enriched.sort((a, b) => {
    const am = a.stats?.lastEventAt ?? a.fileMtime ?? a.createdAt;
    const bm = b.stats?.lastEventAt ?? b.fileMtime ?? b.createdAt;
    return bm.localeCompare(am);
  });
  return enriched;
});

app.get("/api/threads/:hostId/:threadId", async (req, reply) => {
  const { hostId, threadId } = req.params as {
    hostId: string;
    threadId: string;
  };
  const found = lookupThread(hostId, threadId);
  if ("error" in found) return reply.code(found.code).send({ error: found.error });
  const { thread } = found;
  const recipe = launchRecipe(thread);
  const overview = threadOverview(thread.filePath);
  const rollout = hostId === "codex-lhc" ? codexMeasurements(recipe?.sessionRef ?? null) : null;
  if (rollout?.latestProviderInputTokens != null) {
    overview.stats.latestProviderInputTokens = rollout.latestProviderInputTokens;
  }
  const alarms = measurementAlarms({
    projectedViewTokens: overview.stats.projectedViewTokenEstimate,
    projectedViewIsUpperBound: overview.stats.projectedViewIsUpperBound,
    modelContextWindow: rollout?.modelContextWindow ?? null,
    currentViewId: overview.view?.viewId ?? null,
    currentViewCreatedAt: overview.view?.createdAt ?? null,
    latestNativeCompactAt: rollout?.latestNativeCompactAt ?? null,
    latestNativeCompactViewId: rollout?.latestNativeCompactViewId ?? null,
  });
  const key = `${thread.hostId}/${thread.threadId}`;
  const attach = detectAttached(
    [{ hostId: thread.hostId, threadId: thread.threadId, recipe }],
    ownTerminals(),
  ).get(key);
  return {
    thread,
    hidden: isHidden(thread.hostId, thread.threadId),
    custom: customName(thread.hostId, thread.threadId),
    launch: withAttach(thread.hostId, recipe, attach),
    overview: {
      ...overview,
      hostMeasurements: {
        activeContextTokens: null,
        modelContextWindow: rollout?.modelContextWindow ?? null,
        latestProviderUsageAt: rollout?.latestProviderUsageAt ?? null,
        latestNativeCompactAt: rollout?.latestNativeCompactAt ?? null,
        alarms,
      },
    },
  };
});

/**
 * Rename a thread, console-side. Partial: an absent field is untouched, null
 * clears it, and clearing both removes the entry so the row falls back to
 * whatever the host calls it. The id may be a prefix, so — like hide — the
 * RESOLVED full thread id is what gets written.
 */
app.patch("/api/threads/:hostId/:threadId/name", async (req, reply) => {
  const { hostId, threadId } = req.params as { hostId: string; threadId: string };
  const found = lookupThread(hostId, threadId);
  if ("error" in found) return reply.code(found.code).send({ error: found.error });
  const parsed = parseNamePatch(req.body);
  if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
  const { thread } = found;
  return {
    threadId: thread.threadId,
    custom: setThreadName(thread.hostId, thread.threadId, parsed.patch),
  };
});

/*
 * Hide / unhide. The id in the path may be a prefix, so both write the
 * RESOLVED full thread id — otherwise a prefix hide would never match the
 * full-id rows the list serves.
 */
app.post("/api/threads/:hostId/:threadId/hide", async (req, reply) => {
  const { hostId, threadId } = req.params as { hostId: string; threadId: string };
  const found = lookupThread(hostId, threadId);
  if ("error" in found) return reply.code(found.code).send({ error: found.error });
  const { thread } = found;
  return { hidden: hideThread(thread.hostId, thread.threadId), threadId: thread.threadId };
});

app.delete("/api/threads/:hostId/:threadId/hide", async (req, reply) => {
  const { hostId, threadId } = req.params as { hostId: string; threadId: string };
  const found = lookupThread(hostId, threadId);
  if ("error" in found) return reply.code(found.code).send({ error: found.error });
  const { thread } = found;
  return { hidden: unhideThread(thread.hostId, thread.threadId), threadId: thread.threadId };
});

/** The raw map, for tooling and tests; the UI gets `hidden` on each row. */
app.get("/api/prefs/hidden", async () => ({
  hidden: hiddenCount(),
  hiddenThreads: loadPrefs().hiddenThreads,
}));

app.get("/api/threads/:hostId/:threadId/turns", async (req, reply) => {
  const { hostId, threadId } = req.params as {
    hostId: string;
    threadId: string;
  };
  const found = lookupThread(hostId, threadId);
  if ("error" in found) return reply.code(found.code).send({ error: found.error });
  const { thread } = found;
  return listTurns(thread.filePath);
});

app.get("/api/threads/:hostId/:threadId/turn-kinds", async (req, reply) => {
  const { hostId, threadId } = req.params as {
    hostId: string;
    threadId: string;
  };
  const found = lookupThread(hostId, threadId);
  if ("error" in found) return reply.code(found.code).send({ error: found.error });
  const { thread } = found;
  return turnKinds(thread.filePath);
});

app.get("/api/threads/:hostId/:threadId/messages", async (req, reply) => {
  const { hostId, threadId } = req.params as {
    hostId: string;
    threadId: string;
  };
  const q = req.query as {
    turn?: string;
    from?: string;
    to?: string;
    limit?: string;
    cap?: string;
  };
  const found = lookupThread(hostId, threadId);
  if ("error" in found) return reply.code(found.code).send({ error: found.error });
  const { thread } = found;
  return listMessages(thread.filePath, {
    turnId: q.turn,
    fromOrder: q.from !== undefined ? Number(q.from) : undefined,
    toOrder: q.to !== undefined ? Number(q.to) : undefined,
    limit: q.limit !== undefined ? Number(q.limit) : undefined,
    blockContentCap: q.cap !== undefined ? Number(q.cap) : undefined,
  });
});

app.get("/api/threads/:hostId/:threadId/view", async (req, reply) => {
  const { hostId, threadId } = req.params as {
    hostId: string;
    threadId: string;
  };
  const found = lookupThread(hostId, threadId);
  if ("error" in found) return reply.code(found.code).send({ error: found.error });
  const { thread } = found;
  return viewBands(thread.filePath);
});

app.get("/api/threads/:hostId/:threadId/view-arrangement", async (req, reply) => {
  const { hostId, threadId } = req.params as {
    hostId: string;
    threadId: string;
  };
  const found = lookupThread(hostId, threadId);
  if ("error" in found) return reply.code(found.code).send({ error: found.error });
  const { thread } = found;
  return threadViewArrangement(thread.filePath);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, async () => {
    shutdownTerminals();
    v2Manager?.close();
    await goalService.stop();
    await relayQueue.close();
    removeGoalSettledListener();
    await goalService.close();
    await monitorService.close();
    await photonConnectors.stop();
    await app.close();
    process.exit(0);
  });
}

const addr = await app.listen({ port: PORT, host: "127.0.0.1" });
app.log.info(`lhc-console server on ${addr}`);
