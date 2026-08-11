import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { DEFAULT_IDLE_FOR_MS, MIN_MONITOR_INTERVAL_MS, type MonitorService } from "./monitor.ts";

interface MonitorRouteOptions {
  service: MonitorService;
  token: string;
}

export function registerMonitorRoutes(app: FastifyInstance, options: MonitorRouteOptions): void {
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    if (!sameToken(supplied, options.token)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  };

  app.get("/api/monitors", { preHandler: authorize }, async () => options.service.list());

  app.post("/api/monitors", { preHandler: authorize }, async (request, reply) => {
    const { target, prompt, interval, idleFor, maxTicks, quiet } = (request.body ?? {}) as {
      target?: unknown;
      prompt?: unknown;
      interval?: unknown;
      idleFor?: unknown;
      maxTicks?: unknown;
      quiet?: unknown;
    };
    if (typeof target !== "string" || !target.trim()) {
      return reply.code(400).send({ error: "target is required" });
    }
    if (typeof prompt !== "string" || !prompt.trim()) {
      return reply.code(400).send({ error: "prompt is required" });
    }
    const intervalMs = typeof interval === "string" ? parseInterval(interval) : null;
    if (intervalMs === null) {
      return reply.code(400).send({ error: "interval must be like 30s, 5m, or 2h" });
    }
    if (intervalMs < MIN_MONITOR_INTERVAL_MS) {
      return reply.code(400).send({ error: "interval must be at least 30s" });
    }
    const idleForMs =
      idleFor === undefined
        ? DEFAULT_IDLE_FOR_MS
        : typeof idleFor === "string"
          ? parseInterval(idleFor)
          : null;
    if (idleForMs === null) {
      return reply.code(400).send({ error: "idleFor must be like 30s, 5m, or 2h" });
    }
    if (!Number.isSafeInteger(maxTicks) || Number(maxTicks) <= 0) {
      return reply.code(400).send({ error: "maxTicks must be a positive integer" });
    }
    if (quiet !== undefined && typeof quiet !== "boolean") {
      return reply.code(400).send({ error: "quiet must be a boolean" });
    }
    try {
      const monitor = options.service.add({
        target: target.trim(),
        prompt,
        intervalMs,
        idleForMs,
        maxTicks: Number(maxTicks),
        quiet: quiet ?? false,
      });
      return reply.code(201).send(monitor);
    } catch (error) {
      return reply
        .code(
          error instanceof Error && error.message.startsWith("unknown relay target") ? 404 : 400,
        )
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete("/api/monitors/:id", { preHandler: authorize }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!options.service.remove(id)) {
      return reply.code(404).send({ error: "monitor not found" });
    }
    return reply.code(204).send();
  });
}

export function parseInterval(value: string): number | null {
  const match = /^(\d+)(s|m|h)$/.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const multiplier = match[2] === "s" ? 1000 : match[2] === "m" ? 60_000 : 3_600_000;
  const result = amount * multiplier;
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}

function sameToken(supplied: string, expected: string): boolean {
  if (!supplied || !expected) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
