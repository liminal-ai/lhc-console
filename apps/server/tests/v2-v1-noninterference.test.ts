import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { RelayQueue } from "../src/relay.ts";
import { registerRelayRoutes } from "../src/relay-routes.ts";
import { registerV2Routes } from "../src/v2/routes.ts";
import { isV2Enabled } from "../src/v2/config.ts";

const dirs: string[] = [];
const queues: RelayQueue[] = [];
const apps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(queues.splice(0).map((queue) => queue.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("A13 V1 non-interference", () => {
  it("keeps V2 disabled by default and leaves V1 relay routes unchanged", async () => {
    expect(isV2Enabled({} as NodeJS.ProcessEnv)).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-a13-"));
    dirs.push(dir);
    const queue = new RelayQueue({
      dbPath: join(dir, "relay.sqlite"),
      targets: {
        fable: { hostId: "pi-lhc", threadId: "th_fable", cwd: "/tmp", command: "unused", args: [] },
      },
      isBusy: () => false,
      execute: async (_target, prompt) => `reply:${prompt}`,
    });
    queue.start();
    queues.push(queue);
    const app = Fastify();
    apps.push(app);
    registerRelayRoutes(app, { queue, token: "test-secret", syncTimeoutMs: 500, agents: [] });
    registerV2Routes(app, { manager: null as never, token: "test-secret", enabled: false });

    const job = await app.inject({
      method: "POST",
      url: "/api/relay/targets/fable/jobs",
      headers: { authorization: "Bearer test-secret", prefer: "respond-async" },
      payload: { prompt: "hello" },
    });
    expect(job.statusCode).toBe(202);
    expect(job.json().status).toBe("queued");

    const v2 = await app.inject({
      method: "GET",
      url: "/api/v2/targets/fable/status",
      headers: { authorization: "Bearer test-secret" },
    });
    expect(v2.statusCode).toBe(404);
    expect(v2.json().error).toBe("v2 disabled");
  });
});
