import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { registerAgentRoutes } from "../src/agent-routes.ts";
import type { AgentRecord } from "../src/agent-registry.ts";

const apps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function agent(): AgentRecord {
  return {
    id: "fable",
    name: "Fable",
    description: "Principal long-horizon agent",
    duties: ["architecture", "durable project work"],
    ownerSenderIds: ["owner-secret"],
    mentionPatterns: ["fable"],
    health: {
      hostId: "pi-lhc",
      threadId: "canonical-health-thread",
    },
    channels: {
      photon: {
        address: "+15555550123",
        envFile: "/secret/fable.env",
        notifySpaceId: "secret-space",
      },
    },
    relay: {
      hostId: "pi-lhc",
      threadId: "secret-thread",
      cwd: "/secret/worktree",
      command: "pi-lhc",
      args: ["--secret"],
    },
  };
}

function setup() {
  const app = Fastify();
  apps.push(app);
  registerAgentRoutes(app, { agents: [agent()], token: "test-secret" });
  return app;
}

describe("agent discovery API", () => {
  it("requires the relay bearer token", async () => {
    const response = await setup().inject({ method: "GET", url: "/api/agents" });
    expect(response.statusCode).toBe(401);
  });

  it("lists useful metadata without exposing sensitive routing configuration", async () => {
    const response = await setup().inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer test-secret" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      {
        id: "fable",
        name: "Fable",
        description: "Principal long-horizon agent",
        duties: ["architecture", "durable project work"],
        channels: ["photon"],
      },
    ]);
    const serialized = response.body;
    for (const secret of [
      "owner-secret",
      "secret-thread",
      "canonical-health-thread",
      "/secret",
      "+1555",
      "secret-space",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
