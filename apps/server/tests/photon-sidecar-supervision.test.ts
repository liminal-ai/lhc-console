import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { ChildProcess } from "node:child_process";
import type { AgentRecord } from "../src/agent-registry.ts";
import { PhotonConnector, type PhotonConnectorManager } from "../src/photon-connector.ts";
import { deliverRelayJob } from "../src/relay-delivery.ts";
import { RelayQueue, type RelayTarget } from "../src/relay.ts";

type RelayExecute = (target: RelayTarget, prompt: string, signal: AbortSignal) => Promise<string>;

const dirs: string[] = [];
const queues: RelayQueue[] = [];
const connectors: PhotonConnector[] = [];

afterEach(async () => {
  await Promise.all(connectors.splice(0).map((connector) => connector.stop()));
  await Promise.all(queues.splice(0).map((queue) => queue.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function agentRecord(): AgentRecord {
  return {
    id: "fable",
    ownerSenderIds: ["+15551234567"],
    mentionPatterns: [String.raw`\bfable\b`],
    channels: { photon: { address: "+15550001111", envFile: "/tmp/unused.env" } },
    relay: {
      hostId: "pi-lhc",
      threadId: "th_fable",
      cwd: "/tmp",
      command: "unused",
      args: [],
    },
  };
}

function relayQueue(execute: RelayExecute, consoleHome: string): RelayQueue {
  const dir = mkdtempSync(join(tmpdir(), "lhc-photon-relay-"));
  dirs.push(dir);
  const queue = new RelayQueue({
    dbPath: join(dir, "relay.sqlite"),
    targets: { fable: agentRecord().relay },
    isBusy: () => false,
    execute,
    deliver: async (job) => {
      await deliverRelayJob(job, {
        agents: [agentRecord()],
        consoleHome,
        photonConnectors: { send: async () => undefined } as unknown as PhotonConnectorManager,
      });
    },
    busyPollMs: 5,
    consoleHome,
  });
  queues.push(queue);
  return queue;
}

function managedFetch(inbound: "closing" | "hanging"): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/healthz")) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/inbound")) {
      if (inbound === "closing") {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("\n"));
              controller.close();
            },
          }),
          { status: 200 },
        );
      }
      return new Response(new ReadableStream(), { status: 200 });
    }
    if (url.endsWith("/shutdown")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return fetch(input, init);
  };
}

describe("PhotonConnector sidecar supervision", { concurrent: false }, () => {
  it("respawns a managed sidecar after fatal child exit once inbound settles", async () => {
    let spawnCount = 0;
    const fakeChildren: EventEmitter[] = [];
    const dir = mkdtempSync(join(tmpdir(), "lhc-photon-sidecar-"));
    dirs.push(dir);
    const queue = relayQueue(async () => "ok", dir);
    const connector = new PhotonConnector({
      agent: agentRecord(),
      consoleHome: dir,
      queue,
      fetchImpl: managedFetch("closing"),
      loadPhotonEnv: () => ({ PHOTON_PROJECT_ID: "test" }),
      spawnSidecar: () => {
        spawnCount += 1;
        const emitter = new EventEmitter();
        fakeChildren.push(emitter);
        return Object.assign(emitter, {
          stdin: { end: () => undefined },
          kill: () => undefined,
          once: emitter.once.bind(emitter),
          removeListener: emitter.removeListener.bind(emitter),
        }) as unknown as ChildProcess;
      },
    });
    connectors.push(connector);
    await connector.start();
    queue.start();
    fakeChildren[0].emit("exit", 1);
    await expect.poll(() => spawnCount, { timeout: 5_000 }).toBeGreaterThan(1);
  });

  it("does not overlap consumers when inbound ignores abort", async () => {
    let spawnCount = 0;
    const fakeChildren: EventEmitter[] = [];
    const dir = mkdtempSync(join(tmpdir(), "lhc-photon-sidecar-"));
    dirs.push(dir);
    const queue = relayQueue(async () => "ok", dir);
    const connector = new PhotonConnector({
      agent: agentRecord(),
      consoleHome: dir,
      queue,
      fetchImpl: managedFetch("hanging"),
      loadPhotonEnv: () => ({ PHOTON_PROJECT_ID: "test" }),
      spawnSidecar: () => {
        spawnCount += 1;
        const emitter = new EventEmitter();
        fakeChildren.push(emitter);
        return Object.assign(emitter, {
          stdin: { end: () => undefined },
          kill: () => undefined,
          once: emitter.once.bind(emitter),
          removeListener: emitter.removeListener.bind(emitter),
        }) as unknown as ChildProcess;
      },
    });
    connectors.push(connector);
    await connector.start();
    queue.start();
    fakeChildren[0].emit("exit", 1);
    await new Promise((resolve) => setTimeout(resolve, 4_500));
    expect(spawnCount).toBe(1);
  });

  it("ignores stale child fatal events after a replacement sidecar starts", async () => {
    let spawnCount = 0;
    const fakeChildren: EventEmitter[] = [];
    const dir = mkdtempSync(join(tmpdir(), "lhc-photon-sidecar-"));
    dirs.push(dir);
    const queue = relayQueue(async () => "ok", dir);
    const connector = new PhotonConnector({
      agent: agentRecord(),
      consoleHome: dir,
      queue,
      fetchImpl: managedFetch("closing"),
      loadPhotonEnv: () => ({ PHOTON_PROJECT_ID: "test" }),
      spawnSidecar: () => {
        spawnCount += 1;
        const emitter = new EventEmitter();
        fakeChildren.push(emitter);
        return Object.assign(emitter, {
          stdin: { end: () => undefined },
          kill: () => undefined,
          once: emitter.once.bind(emitter),
          removeListener: emitter.removeListener.bind(emitter),
        }) as unknown as ChildProcess;
      },
    });
    connectors.push(connector);
    await connector.start();
    queue.start();
    fakeChildren[0].emit("exit", 1);
    await expect.poll(() => spawnCount, { timeout: 5_000 }).toBe(2);
    const staleChild = fakeChildren[0];
    staleChild.on("error", () => undefined);
    staleChild.emit("error", new Error("stale"));
    staleChild.emit("exit", 9);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(spawnCount).toBe(2);
  });

  it("stops within a bounded time when managed sidecar shutdown hangs", async () => {
    let shutdownCalls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/healthz")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.endsWith("/shutdown")) {
        shutdownCalls += 1;
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(signal.reason ?? new Error("aborted"));
            return;
          }
          signal?.addEventListener("abort", () => {
            reject(signal.reason ?? new Error("aborted"));
          });
        });
      }
      if (url.endsWith("/inbound")) {
        return new Response(new ReadableStream(), { status: 200 });
      }
      return fetch(input, init);
    };
    const dir = mkdtempSync(join(tmpdir(), "lhc-photon-sidecar-"));
    dirs.push(dir);
    const queue = relayQueue(async () => "ok", dir);
    const connector = new PhotonConnector({
      agent: agentRecord(),
      consoleHome: dir,
      queue,
      fetchImpl,
      loadPhotonEnv: () => ({ PHOTON_PROJECT_ID: "test" }),
      spawnSidecar: () => {
        const emitter = new EventEmitter();
        return Object.assign(emitter, {
          stdin: { end: () => undefined },
          kill: () => undefined,
          once: emitter.once.bind(emitter),
        }) as unknown as ChildProcess;
      },
    });
    connectors.push(connector);
    await connector.start();
    queue.start();
    const started = Date.now();
    await connector.stop();
    expect(Date.now() - started).toBeLessThan(4_500);
    expect(shutdownCalls).toBe(1);
  });
});
