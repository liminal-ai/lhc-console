import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { GoalService } from "../src/goal.ts";
import { registerGoalRoutes } from "../src/goal-routes.ts";
import { RelayQueue } from "../src/relay.ts";

const dirs: string[] = [];
const apps: Array<ReturnType<typeof Fastify>> = [];
const services: GoalService[] = [];
const queues: RelayQueue[] = [];

const relayTarget = {
  hostId: "pi-lhc",
  threadId: "th_fable",
  cwd: "/tmp",
  command: "unused",
  args: [] as string[],
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(queues.splice(0).map((queue) => queue.close()));
  await Promise.all(services.splice(0).map((service) => service.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "lhc-console-goal-api-"));
  dirs.push(dir);
  const prompts: string[] = [];
  const queue = new RelayQueue({
    dbPath: join(dir, "relay.sqlite"),
    targets: { fable: relayTarget },
    isBusy: () => false,
    execute: async (_target, prompt) => {
      prompts.push(prompt);
      return "ok";
    },
    busyPollMs: 5,
  });
  queue.start();
  queues.push(queue);
  const service = new GoalService({
    dbPath: join(dir, "relay.sqlite"),
    relayQueue: queue,
    targetExists: (target) => target === "fable",
  });
  services.push(service);
  const app = Fastify();
  apps.push(app);
  registerGoalRoutes(app, { service, token: "test-secret" });
  return { app, prompts };
}

describe("goal HTTP API", () => {
  it("requires the relay bearer token", async () => {
    const { app } = setup();
    const response = await app.inject({ method: "GET", url: "/api/goals" });
    expect(response.statusCode).toBe(401);
  });

  it("creates, lists, and fetches goals with validation", async () => {
    const { app, prompts } = setup();
    const created = await app.inject({
      method: "POST",
      url: "/api/goals",
      headers: { authorization: "Bearer test-secret" },
      payload: { target: "fable", objective: "Ship the feature", cadence: "5m" },
    });
    expect(created.statusCode).toBe(201);
    const goal = created.json();
    expect(goal).toMatchObject({
      target: "fable",
      objective: "Ship the feature",
      state: "active",
      cadenceMs: 300_000,
    });
    expect(prompts).toHaveLength(1);

    const listed = await app.inject({
      method: "GET",
      url: "/api/goals",
      headers: { authorization: "Bearer test-secret" },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual([expect.objectContaining({ id: goal.id })]);

    const fetched = await app.inject({
      method: "GET",
      url: `/api/goals/${goal.id}`,
      headers: { authorization: "Bearer test-secret" },
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toMatchObject({ id: goal.id });

    const badTarget = await app.inject({
      method: "POST",
      url: "/api/goals",
      headers: { authorization: "Bearer test-secret" },
      payload: { target: "missing", objective: "x" },
    });
    expect(badTarget.statusCode).toBe(404);

    const badCadence = await app.inject({
      method: "POST",
      url: "/api/goals",
      headers: { authorization: "Bearer test-secret" },
      payload: { target: "fable", objective: "x", cadence: "bad" },
    });
    expect(badCadence.statusCode).toBe(400);
  });

  it("completes, blocks, and cancels goals", async () => {
    const { app } = setup();
    const created = await app.inject({
      method: "POST",
      url: "/api/goals",
      headers: { authorization: "Bearer test-secret" },
      payload: { target: "fable", objective: "Lifecycle" },
    });
    const id = created.json().id as string;

    const completed = await app.inject({
      method: "POST",
      url: `/api/goals/${id}/complete`,
      headers: { authorization: "Bearer test-secret" },
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().state).toBe("completed");

    const created2 = await app.inject({
      method: "POST",
      url: "/api/goals",
      headers: { authorization: "Bearer test-secret" },
      payload: { target: "fable", objective: "Blocked" },
    });
    const blockedId = created2.json().id as string;
    const blocked = await app.inject({
      method: "POST",
      url: `/api/goals/${blockedId}/blocked`,
      headers: { authorization: "Bearer test-secret" },
      payload: { reason: "dependency" },
    });
    expect(blocked.statusCode).toBe(200);
    expect(blocked.json()).toMatchObject({ state: "blocked", blockedReason: "dependency" });

    const created3 = await app.inject({
      method: "POST",
      url: "/api/goals",
      headers: { authorization: "Bearer test-secret" },
      payload: { target: "fable", objective: "Cancelled" },
    });
    const cancelledId = created3.json().id as string;
    const cancelled = await app.inject({
      method: "POST",
      url: `/api/goals/${cancelledId}/cancel`,
      headers: { authorization: "Bearer test-secret" },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().state).toBe("cancelled");
  });
});
