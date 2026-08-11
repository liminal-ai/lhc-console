import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AgentRecord } from "./agent-registry.ts";

interface AgentRouteOptions {
  agents: AgentRecord[];
  token: string;
}

export interface PublicAgent {
  id: string;
  name: string;
  description: string;
  duties: string[];
  channels: string[];
}

export function registerAgentRoutes(app: FastifyInstance, options: AgentRouteOptions): void {
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    if (!sameToken(supplied, options.token)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  };

  app.get("/api/agents", { preHandler: authorize }, async () =>
    options.agents.map(toPublicAgent).sort((a, b) => a.id.localeCompare(b.id)),
  );
}

function toPublicAgent(agent: AgentRecord): PublicAgent {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    duties: agent.duties,
    channels: Object.keys(agent.channels).sort(),
  };
}

function sameToken(supplied: string, expected: string): boolean {
  if (!supplied || !expected) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
