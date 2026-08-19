import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { AgentRecord } from "../src/agent-registry.ts";
import { RelayQueue } from "../src/relay.ts";
import { FakeProviderAdapter } from "../src/v2/adapters/fake.ts";
import { RuntimeManager } from "../src/v2/manager.ts";
import { TEST_ONLY_OWNER_POLICIES, testOnlyOwnerPolicies } from "../src/v2/policies.ts";
import { V2Store } from "../src/v2/store.ts";
import { createV1Admission } from "../src/v2/v1-admission.ts";

const dirs: string[] = [];
const queues: RelayQueue[] = [];
const managers: RuntimeManager[] = [];

afterEach(async () => {
  await Promise.all(queues.splice(0).map((queue) => queue.close()));
  for (const manager of managers.splice(0)) manager.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function optedAgent(): AgentRecord {
  return {
    id: "fable",
    name: "Fable",
    description: "test",
    duties: [],
    ownerSenderIds: ["owner"],
    mentionPatterns: ["fable"],
    health: { hostId: "pi-lhc", threadId: "th_fable" },
    channels: {},
    relay: {
      hostId: "pi-lhc",
      threadId: "th_fable",
      cwd: "/tmp",
      command: "true",
      args: [],
    },
    v2: { provider: "pi-lhc" },
  };
}

describe("V1 admission seam for V2-opted resources", () => {
  it("leaves V1 unchanged when V2 is disabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-adm-off-"));
    dirs.push(dir);
    const admission = createV1Admission({
      enabled: false,
      consoleHome: dir,
      agents: [optedAgent()],
      manager: null,
      isBusy: () => false,
    });
    expect(await admission.isBusy(optedAgent().relay)).toBe(false);
    expect(admission.acquireForLaunch(optedAgent().relay)).toBeNull();
  });

  it("blocks a V1 job while a V2 runtime owns the canonical resource", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-adm-on-"));
    dirs.push(dir);
    const agent = optedAgent();
    const store = new V2Store({ dbPath: join(dir, "v2.sqlite") });
    const manager = new RuntimeManager({
      store,
      consoleHome: dir,
      agents: [agent],
      policies: testOnlyOwnerPolicies(TEST_ONLY_OWNER_POLICIES),
      adapterFactory: () => new FakeProviderAdapter({ provider: "pi-lhc" }),
    });
    managers.push(manager);
    await manager.submit({
      target: "fable",
      commandId: "start-1",
      kind: "runtime.start",
      params: {},
    });
    const admission = createV1Admission({
      enabled: true,
      consoleHome: dir,
      agents: [agent],
      manager,
      isBusy: () => false,
    });
    expect(await admission.isBusy(agent.relay)).toBe(true);
    expect(admission.acquireForLaunch(agent.relay)).toBe("blocked");

    const queue = new RelayQueue({
      dbPath: join(dir, "relay.sqlite"),
      targets: { fable: agent.relay },
      isBusy: (target) => admission.isBusy(target),
      acquireWriterLock: (target) => admission.acquireForLaunch(target),
      execute: async () => "should-not-run",
      busyPollMs: 5,
    });
    queue.start();
    queues.push(queue);
    const job = queue.enqueue({ target: "fable", prompt: "hello" });
    await expect.poll(() => queue.get(job.id)?.status, { timeout: 400 }).toBe("blocked");
  });

  it("does not acquire a V2 fence when the target is not opted in", () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-adm-v1only-"));
    dirs.push(dir);
    const agent = optedAgent();
    delete agent.v2;
    const admission = createV1Admission({
      enabled: true,
      consoleHome: dir,
      agents: [agent],
      manager: null,
      isBusy: () => false,
    });
    expect(admission.acquireForLaunch(agent.relay)).toBeNull();
  });
});
