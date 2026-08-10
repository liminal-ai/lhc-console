import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RelayJob, RelayQueue } from "./relay.ts";

interface RelayRouteOptions {
  queue: RelayQueue;
  token: string;
  syncTimeoutMs?: number;
}

export function registerRelayRoutes(app: FastifyInstance, options: RelayRouteOptions): void {
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    if (!sameToken(supplied, options.token)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  };

  app.post("/api/relay/targets/:target/jobs", { preHandler: authorize }, async (request, reply) => {
    const { target } = request.params as { target: string };
    const { prompt, notify, channelContext } = (request.body ?? {}) as {
      prompt?: unknown;
      notify?: unknown;
      channelContext?: unknown;
    };
    if (typeof prompt !== "string" || !prompt.trim()) {
      return reply.code(400).send({ error: "prompt is required" });
    }
    if (notify !== undefined && notify !== "photon") {
      return reply.code(400).send({ error: 'notify must be "photon"' });
    }
    if (channelContext !== undefined && typeof channelContext !== "string") {
      return reply.code(400).send({ error: "channelContext must be a string" });
    }
    let job;
    try {
      job = options.queue.enqueue({
        target,
        prompt: renderRelayPrompt(prompt, channelContext),
        ...(notify === "photon" ? { notify } : {}),
      });
    } catch (error) {
      return reply
        .code(
          error instanceof Error && error.message.startsWith("unknown relay target") ? 404 : 400,
        )
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
    const prefer = Array.isArray(request.headers.prefer)
      ? request.headers.prefer.join(",")
      : request.headers.prefer;
    if (prefer?.toLowerCase().includes("respond-async")) {
      return reply.code(202).header("location", `/api/relay/jobs/${job.id}`).send(job);
    }
    const completed = await waitWithin(options.queue, job.id, options.syncTimeoutMs ?? 10 * 60_000);
    if (!completed) {
      return reply
        .code(202)
        .header("location", `/api/relay/jobs/${job.id}`)
        .send(options.queue.get(job.id));
    }
    return completed;
  });

  app.get("/api/relay/jobs/:id", { preHandler: authorize }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = options.queue.get(id);
    if (!job) return reply.code(404).send({ error: "relay job not found" });
    return job;
  });
}

function renderRelayPrompt(prompt: string, channelContext?: string): string {
  if (!channelContext) return prompt;
  return `${channelContext}\n\n[New message]\n${prompt}`;
}

async function waitWithin(
  queue: RelayQueue,
  id: string,
  timeoutMs: number,
): Promise<RelayJob | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      queue.wait(id),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sameToken(supplied: string, expected: string): boolean {
  if (!supplied || !expected) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
