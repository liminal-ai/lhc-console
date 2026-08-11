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
  registerRelayRoutes(app, { queue, token: "test-secret", syncTimeoutMs: 500, agents: [] });
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

  it("accepts an explicit job class and returns it on the job record", async () => {
    const app = setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/relay/targets/fable/jobs",
      headers: { authorization: "Bearer test-secret", prefer: "respond-async" },
      payload: { prompt: "urgent", jobClass: "prioritized" },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ jobClass: "prioritized" });
  });

  it("rejects an invalid job class", async () => {
    const app = setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/relay/targets/fable/jobs",
      headers: { authorization: "Bearer test-secret" },
      payload: { prompt: "hello", jobClass: "high" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'jobClass must be "prioritized" or "deprioritized"',
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

function setupWithLee(
  execute: ConstructorParameters<typeof RelayQueue>[0]["execute"] = async (_target, prompt) =>
    `reply:${prompt}`,
  deliver?: ConstructorParameters<typeof RelayQueue>[0]["deliver"],
) {
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
      lee: {
        hostId: "lee",
        threadId: "lee",
        cwd: "/tmp",
        command: "unused",
        args: [],
      },
    },
    isBusy: () => false,
    execute,
    deliver,
  });
  queue.start();
  queues.push(queue);
  const app = Fastify();
  apps.push(app);
  registerRelayRoutes(app, {
    queue,
    token: "test-secret",
    syncTimeoutMs: 500,
    agents: [
      {
        id: "fable",
        name: "Fable",
        description: "durable agent",
        duties: [],
        ownerSenderIds: ["owner"],
        mentionPatterns: [],
        channels: {
          photon: {
            address: "http://127.0.0.1:1",
            envFile: ".env",
            notifySpaceId: "fable-home",
          },
        },
        relay: {
          hostId: "pi-lhc",
          threadId: "th_fable",
          cwd: "/tmp",
          command: "unused",
          args: [],
        },
      },
    ],
  });
  return { app, queue };
}

describe("relay HTTP API sender attribution", () => {
  it("accepts lee outbound jobs with sender and stays async", async () => {
    let executed = 0;
    const delivered: Array<{ connector: string; spaceId: string; text: string }> = [];
    const { app } = setupWithLee(
      async () => {
        executed += 1;
        return "unused";
      },
      async (job) => {
        delivered.push({
          connector: job.delivery?.metadata?.connectorAgentId as string,
          spaceId: job.delivery?.destination.spaceId ?? "",
          text: job.output ?? "",
        });
      },
    );

    const submitted = await app.inject({
      method: "POST",
      url: "/api/relay/targets/lee/jobs",
      headers: { authorization: "Bearer test-secret" },
      payload: { prompt: "heads up", sender: "fable" },
    });
    expect(submitted.statusCode).toBe(202);
    const id = submitted.json().id as string;
    expect(executed).toBe(0);

    await expect
      .poll(async () => {
        const response = await app.inject({
          method: "GET",
          url: `/api/relay/jobs/${id}`,
          headers: { authorization: "Bearer test-secret" },
        });
        return response.json().deliveryStatus;
      })
      .toBe("delivered");

    expect(delivered).toEqual([{ connector: "fable", spaceId: "fable-home", text: "heads up" }]);
  });

  it("rejects unknown senders at the trust boundary", async () => {
    const { app } = setupWithLee();
    const response = await app.inject({
      method: "POST",
      url: "/api/relay/targets/lee/jobs",
      headers: { authorization: "Bearer test-secret" },
      payload: { prompt: "hello", sender: "intruder" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/unknown sender agent/);
  });

  it("prepends peer attribution when sender is declared", async () => {
    const { app } = setupWithLee();
    const response = await app.inject({
      method: "POST",
      url: "/api/relay/targets/fable/jobs",
      headers: { authorization: "Bearer test-secret" },
      payload: { prompt: "hello", sender: "fable" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().output).toBe("reply:[from: fable]\nhello");
  });
});
