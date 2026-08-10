import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { RelayQueue } from "../src/relay.ts";
import { registerRelayRoutes } from "../src/relay-routes.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
const apps: Array<ReturnType<typeof Fastify>> = [];
const queues: RelayQueue[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(queues.splice(0).map((queue) => queue.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "lhc-console-relay-api-"));
  dirs.push(dir);
  const queue = new RelayQueue({
    dbPath: join(dir, "relay.sqlite"),
    targets: {
      fable: {
        hostId: "pi-lhc",
        threadId: "th_fable",
        cwd: "/tmp",
        command: "unused",
        args: [],
      },
    },
    isBusy: () => false,
    execute: async (_target, prompt) => `reply:${prompt}`,
  });
  queue.start();
  queues.push(queue);
  const app = Fastify();
  apps.push(app);
  registerRelayRoutes(app, { queue, token: "test-secret", syncTimeoutMs: 500 });
  return app;
}

describe("relay HTTP API", () => {
  it("requires the relay bearer token", async () => {
    const app = setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/relay/targets/fable/jobs",
      payload: { prompt: "hello" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("accepts an async job and exposes its completed result", async () => {
    const app = setup();
    const submitted = await app.inject({
      method: "POST",
      url: "/api/relay/targets/fable/jobs",
      headers: { authorization: "Bearer test-secret", prefer: "respond-async" },
      payload: { prompt: "hello", notify: "photon" },
    });
    expect(submitted.statusCode).toBe(202);
    expect(submitted.json()).toMatchObject({ notify: "photon", deliveryStatus: "pending" });
    const id = submitted.json().id as string;

    await expect
      .poll(
        async () => {
          const response = await app.inject({
            method: "GET",
            url: `/api/relay/jobs/${id}`,
            headers: { authorization: "Bearer test-secret" },
          });
          return response.json().status;
        },
        { timeout: 500 },
      )
      .toBe("completed");

    const result = await app.inject({
      method: "GET",
      url: `/api/relay/jobs/${id}`,
      headers: { authorization: "Bearer test-secret" },
    });
    expect(result.json()).toMatchObject({ id, status: "completed", output: "reply:hello" });
  });

  it("waits for the result when async response is not requested", async () => {
    const app = setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/relay/targets/fable/jobs",
      headers: { authorization: "Bearer test-secret" },
      payload: { prompt: "now" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "completed", output: "reply:now" });
  });

  it("uses the Hermes channel-context envelope for addressed group turns", async () => {
    const app = setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/relay/targets/fable/jobs",
      headers: { authorization: "Bearer test-secret" },
      payload: {
        prompt: "What do you think?",
        channelContext: "[Group messages since your last reply]\n[participant-1] Earlier point",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "completed",
      output:
        "reply:[Group messages since your last reply]\n[participant-1] Earlier point\n\n[New message]\nWhat do you think?",
    });
  });

  it("rejects malformed group context", async () => {
    const app = setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/relay/targets/fable/jobs",
      headers: { authorization: "Bearer test-secret" },
      payload: { prompt: "hello", channelContext: ["not", "trusted"] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "channelContext must be a string" });
  });
});
