import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AgentRecord } from "./agent-registry.ts";
import type { RelayJob, RelayQueue } from "./relay.ts";
import { renderRelayPrompt } from "./relay-prompt.ts";
import {
  latestPhotonDestination,
  renderSenderAttribution,
  resolveLeePhotonRoute,
  validateSenderAgent,
} from "./relay-sender.ts";

interface RelayRouteOptions {
  queue: RelayQueue;
  token: string;
  agents: AgentRecord[];
  consoleHome?: string;
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
    const { prompt, notify, channelContext, jobClass, sender } = (request.body ?? {}) as {
      prompt?: unknown;
      notify?: unknown;
      channelContext?: unknown;
      jobClass?: unknown;
      sender?: unknown;
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
    if (jobClass !== undefined && jobClass !== "prioritized" && jobClass !== "deprioritized") {
      return reply.code(400).send({ error: 'jobClass must be "prioritized" or "deprioritized"' });
    }
    if (sender !== undefined && typeof sender !== "string") {
      return reply.code(400).send({ error: "sender must be a string" });
    }

    if (target === "lee") {
      if (typeof sender !== "string" || !sender.trim()) {
        return reply.code(400).send({
          error: "sender is required for lee (set LHC_AGENT_ID or pass sender in the request body)",
        });
      }
      let validatedSender: string;
      try {
        validatedSender = validateSenderAgent(options.agents, sender);
      } catch (error) {
        return reply
          .code(400)
          .send({ error: error instanceof Error ? error.message : String(error) });
      }
      let route;
      try {
        const learnedSpaceId = options.consoleHome
          ? latestPhotonDestination(options.consoleHome, validatedSender)
          : null;
        route = resolveLeePhotonRoute(options.agents, validatedSender, learnedSpaceId);
      } catch (error) {
        return reply
          .code(400)
          .send({ error: error instanceof Error ? error.message : String(error) });
      }
      const job = options.queue.enqueue({
        target: "lee",
        prompt: prompt.trim(),
        jobKind: "outbound",
        sender: validatedSender,
        delivery: {
          channel: "photon",
          destination: { spaceId: route.spaceId },
          metadata: {
            kind: "outbound_lee",
            senderAgentId: validatedSender,
            connectorAgentId: route.connectorAgentId,
          },
        },
      });
      return reply.code(202).header("location", `/api/relay/jobs/${job.id}`).send(job);
    }

    let renderedPrompt = renderRelayPrompt(prompt, channelContext);
    let declaredSender: string | null = null;
    if (typeof sender === "string" && sender.trim()) {
      try {
        declaredSender = validateSenderAgent(options.agents, sender);
        renderedPrompt = renderSenderAttribution(declaredSender, renderedPrompt);
      } catch (error) {
        return reply
          .code(400)
          .send({ error: error instanceof Error ? error.message : String(error) });
      }
    }

    let job;
    try {
      job = options.queue.enqueue({
        target,
        prompt: renderedPrompt,
        ...(notify === "photon" ? { notify } : {}),
        ...(jobClass ? { jobClass } : {}),
        ...(declaredSender ? { sender: declaredSender } : {}),
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
