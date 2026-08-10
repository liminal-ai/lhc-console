import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { MonitorService } from "../src/monitor.ts";
import { registerMonitorRoutes } from "../src/monitor-routes.ts";

const dirs: string[] = [];
const apps: Array<ReturnType<typeof Fastify>> = [];
const services: MonitorService[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(services.splice(0).map((service) => service.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "lhc-console-monitor-api-"));
  dirs.push(dir);
  const service = new MonitorService({
    dbPath: join(dir, "monitor.sqlite"),
    enqueue: () => ({ id: "relay-job" }),
    getJob: () => null,
    targetExists: (target) => target === "fable",
    lastActivityAt: () => new Date(0),
  });
  services.push(service);
  const app = Fastify();
  apps.push(app);
  registerMonitorRoutes(app, { service, token: "test-secret" });
  return app;
}

describe("monitor HTTP API", () => {
  it("requires the relay bearer token", async () => {
    const response = await setup().inject({ method: "GET", url: "/api/monitors" });
    expect(response.statusCode).toBe(401);
  });

  it("adds, lists, and removes a monitor", async () => {
    const app = setup();
    const added = await app.inject({
      method: "POST",
      url: "/api/monitors",
      headers: { authorization: "Bearer test-secret" },
      payload: {
        target: "fable",
        prompt: "Inspect the goal and continue the next unfinished step.",
        interval: "5m",
        idleFor: "10m",
        maxTicks: 12,
      },
    });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toMatchObject({
      target: "fable",
      intervalMs: 300_000,
      idleForMs: 600_000,
      maxTicks: 12,
      tickCount: 0,
      active: true,
    });
    const id = added.json().id as string;

    const listed = await app.inject({
      method: "GET",
      url: "/api/monitors",
      headers: { authorization: "Bearer test-secret" },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual([expect.objectContaining({ id, target: "fable" })]);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/monitors/${id}`,
      headers: { authorization: "Bearer test-secret" },
    });
    expect(removed.statusCode).toBe(204);

    const missing = await app.inject({
      method: "DELETE",
      url: `/api/monitors/${id}`,
      headers: { authorization: "Bearer test-secret" },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("rejects malformed intervals and max-tick caps", async () => {
    const app = setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/monitors",
      headers: { authorization: "Bearer test-secret" },
      payload: { target: "fable", prompt: "hello", interval: "soon", maxTicks: 0 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "interval must be like 30s, 5m, or 2h" });
  });

  it("defaults idle-for to three minutes and rejects sub-30-second intervals", async () => {
    const app = setup();
    const tooFast = await app.inject({
      method: "POST",
      url: "/api/monitors",
      headers: { authorization: "Bearer test-secret" },
      payload: { target: "fable", prompt: "hello", interval: "10s", maxTicks: 2 },
    });
    expect(tooFast.statusCode).toBe(400);
    expect(tooFast.json()).toEqual({ error: "interval must be at least 30s" });

    const added = await app.inject({
      method: "POST",
      url: "/api/monitors",
      headers: { authorization: "Bearer test-secret" },
      payload: { target: "fable", prompt: "hello", interval: "30s", maxTicks: 2 },
    });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toMatchObject({ idleForMs: 180_000 });
  });
});
