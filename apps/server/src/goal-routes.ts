import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { DEFAULT_GOAL_CADENCE_MS, type GoalService } from "./goal.ts";
import { parseInterval } from "./monitor-routes.ts";

interface GoalRouteOptions {
  service: GoalService;
  token: string;
}

export function registerGoalRoutes(app: FastifyInstance, options: GoalRouteOptions): void {
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    if (!sameToken(supplied, options.token)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  };

  app.get("/api/goals", { preHandler: authorize }, async () => options.service.list());

  app.post("/api/goals", { preHandler: authorize }, async (request, reply) => {
    const { target, objective, cadence } = (request.body ?? {}) as {
      target?: unknown;
      objective?: unknown;
      cadence?: unknown;
    };
    if (typeof target !== "string" || !target.trim()) {
      return reply.code(400).send({ error: "target is required" });
    }
    if (typeof objective !== "string" || !objective.trim()) {
      return reply.code(400).send({ error: "objective is required" });
    }
    let cadenceMs: number | undefined;
    if (cadence !== undefined) {
      if (typeof cadence !== "string") {
        return reply.code(400).send({ error: "cadence must be like 30s, 5m, or 2h" });
      }
      const parsed = parseInterval(cadence);
      if (parsed === null) {
        return reply.code(400).send({ error: "cadence must be like 30s, 5m, or 2h" });
      }
      cadenceMs = parsed;
    }
    try {
      const goal = options.service.create({
        target: target.trim(),
        objective,
        cadenceMs,
      });
      return reply.code(201).send(goal);
    } catch (error) {
      return reply
        .code(
          error instanceof Error && error.message.startsWith("unknown relay target") ? 404 : 400,
        )
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/goals/:id", { preHandler: authorize }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const goal = options.service.get(id);
    if (!goal) return reply.code(404).send({ error: "goal not found" });
    return goal;
  });

  app.post("/api/goals/:id/complete", { preHandler: authorize }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return options.service.complete(id);
    } catch (error) {
      return reply
        .code(error instanceof Error && error.message.startsWith("unknown goal") ? 404 : 400)
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/goals/:id/blocked", { preHandler: authorize }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { reason } = (request.body ?? {}) as { reason?: unknown };
    if (typeof reason !== "string" || !reason.trim()) {
      return reply.code(400).send({ error: "reason is required" });
    }
    try {
      return options.service.block(id, reason);
    } catch (error) {
      return reply
        .code(error instanceof Error && error.message.startsWith("unknown goal") ? 404 : 400)
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/goals/:id/cancel", { preHandler: authorize }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return options.service.cancel(id);
    } catch (error) {
      return reply
        .code(error instanceof Error && error.message.startsWith("unknown goal") ? 404 : 400)
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}

export { DEFAULT_GOAL_CADENCE_MS };

function sameToken(supplied: string, expected: string): boolean {
  if (!supplied || !expected) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
