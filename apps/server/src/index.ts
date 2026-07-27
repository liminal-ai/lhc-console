import Fastify from "fastify";
import {
  discoverHosts,
  listMessages,
  listThreads,
  listTurns,
  resolveThread,
  threadOverview,
  threadQuickStats,
  threadViewArrangement,
  turnKinds,
  viewBands,
  type ThreadSummary,
  type ThreadQuickStats,
} from "@lhc-console/core";

const PORT = Number(process.env.LHC_CONSOLE_PORT ?? 5959);

const app = Fastify({ logger: { level: "info" } });

/**
 * Quick-stats cache keyed by thread file path + mtime, so the aggregated
 * list stays fast without ever serving stale numbers.
 */
const statsCache = new Map<string, { mtime: string; stats: ThreadQuickStats }>();

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

type Lookup = { thread: ThreadSummary } | { code: number; error: string };

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

app.get("/api/hosts", async () => {
  return discoverHosts().map((h) => ({
    ...h,
    threadCount: listThreads(h).length,
  }));
});

app.get("/api/threads", async (req, reply) => {
  const q = req.query as { host?: string; cwd?: string; q?: string };
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
  let enriched = threads.map((t) => ({ ...t, stats: cachedQuickStats(t) }));
  if (q.q) {
    const needle = q.q.toLowerCase();
    enriched = enriched.filter(
      (t) =>
        t.threadId.includes(needle) ||
        (t.title ?? "").toLowerCase().includes(needle) ||
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
  return { thread, overview: threadOverview(thread.filePath) };
});

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

const addr = await app.listen({ port: PORT, host: "127.0.0.1" });
app.log.info(`lhc-console server on ${addr}`);
