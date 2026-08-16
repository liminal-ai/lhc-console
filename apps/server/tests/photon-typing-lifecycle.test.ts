import { execFile } from "node:child_process";
import type { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  PHOTON_TYPING_REFRESH_MS,
  PhotonTypingCoordinator,
  isPhotonAgentTypingJob,
} from "../src/photon-typing.ts";
import { executeRelayTarget } from "../src/relay-process.ts";
import { RelayQueue, type RelayJob, type RelayTarget } from "../src/relay.ts";

const dirs: string[] = [];
const queues: RelayQueue[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lhc-photon-typing-"));
  dirs.push(dir);
  return dir;
}

function relayTarget(spawnScript: string): RelayTarget {
  return {
    hostId: "pi-lhc",
    threadId: "th_fable",
    cwd: process.cwd(),
    command: process.execPath,
    args: ["-e", spawnScript],
  };
}

interface TypingCall {
  agentId: string;
  spaceId: string;
  state: "start" | "stop";
}

function createTypingManager() {
  const calls: TypingCall[] = [];
  const manager = {
    typing: vi.fn(async (agentId: string, spaceId: string, state: "start" | "stop") => {
      calls.push({ agentId, spaceId, state });
    }),
  };
  return { manager, calls };
}

function photonJob(overrides: Partial<{ target: string; spaceId: string; prompt: string }> = {}) {
  return {
    target: overrides.target ?? "fable",
    prompt: overrides.prompt ?? "hello",
    jobClass: "prioritized" as const,
    delivery: {
      channel: "photon",
      destination: { spaceId: overrides.spaceId ?? "space-dm-1" },
    },
  };
}

function createHarness(options: {
  execute?: ConstructorParameters<typeof RelayQueue>[0]["execute"];
  isBusy?: () => boolean;
  dbPath?: string;
  coordinator?: PhotonTypingCoordinator;
}) {
  const consoleHome = tempDir();
  mkdirSync(consoleHome, { recursive: true });
  const { manager, calls } = createTypingManager();
  const coordinator = options.coordinator ?? new PhotonTypingCoordinator(manager);
  const target = relayTarget("process.stdout.write(process.argv[1])");
  const queue = new RelayQueue({
    dbPath: options.dbPath ?? join(consoleHome, "relay.sqlite"),
    targets: { fable: target, other: { ...target, threadId: "th_other" } },
    isBusy: options.isBusy ?? (() => false),
    execute:
      options.execute ??
      ((targetArg, prompt, signal, lifecycle) =>
        executeRelayTarget(targetArg, prompt, {
          signal,
          onSpawn: lifecycle?.onSpawn,
        })),
    jobLifecycle: coordinator.lifecycle(),
    busyPollMs: 5,
    consoleHome,
  });
  queues.push(queue);
  queue.start();
  return { queue, calls, coordinator, consoleHome, manager };
}

afterEach(async () => {
  await Promise.all(queues.splice(0).map((queue) => queue.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("isPhotonAgentTypingJob", () => {
  it("includes agent jobs with photon delivery only", () => {
    expect(
      isPhotonAgentTypingJob({
        id: "1",
        target: "fable",
        prompt: "x",
        status: "running",
        jobClass: "prioritized",
        jobKind: "agent",
        sender: null,
        output: null,
        error: null,
        createdAt: "",
        startedAt: null,
        finishedAt: null,
        notify: null,
        delivery: { channel: "photon", destination: { spaceId: "s1" } },
        deliveryStatus: "pending",
        deliveryError: null,
      }),
    ).toBe(true);
    expect(
      isPhotonAgentTypingJob({
        id: "2",
        target: "fable",
        prompt: "x",
        status: "running",
        jobClass: "prioritized",
        jobKind: "outbound",
        sender: "fable",
        output: null,
        error: null,
        createdAt: "",
        startedAt: null,
        finishedAt: null,
        notify: null,
        delivery: { channel: "photon", destination: { spaceId: "s1" } },
        deliveryStatus: "pending",
        deliveryError: null,
      }),
    ).toBe(false);
    expect(
      isPhotonAgentTypingJob({
        id: "3",
        target: "fable",
        prompt: "x",
        status: "running",
        jobClass: "prioritized",
        jobKind: "agent",
        sender: null,
        output: null,
        error: null,
        createdAt: "",
        startedAt: null,
        finishedAt: null,
        notify: null,
        delivery: { channel: "slack", destination: { channelId: "c1" } },
        deliveryStatus: "pending",
        deliveryError: null,
      }),
    ).toBe(false);
  });
});

describe("executeRelayTarget onSpawn", () => {
  it("invokes onSpawn only after the child emits spawn, not on spawn errors", async () => {
    const spawned: string[] = [];
    const target = relayTarget("process.stdout.write(process.argv[1])");
    await executeRelayTarget(target, "ok", {
      timeoutMs: 1000,
      onSpawn: () => spawned.push("spawned"),
    });
    expect(spawned).toEqual(["spawned"]);

    const badSpawn: string[] = [];
    await expect(
      new Promise<void>((resolve, reject) => {
        const child = execFile(
          "/definitely-missing-binary",
          ["noop"],
          { encoding: "utf8" },
          (error) => (error ? reject(error) : resolve()),
        );
        (child as unknown as EventEmitter).once("spawn", () => badSpawn.push("spawned"));
      }),
    ).rejects.toBeDefined();
    expect(badSpawn).toEqual([]);
  });
});

describe("Photon typing lifecycle", () => {
  it("does not type while queued or blocked", async () => {
    let releaseBusy: (() => void) | undefined;
    const busyGate = new Promise<void>((resolve) => {
      releaseBusy = resolve;
    });
    const { queue, calls } = createHarness({
      isBusy: () => true,
      execute: async () => {
        await busyGate;
        return "ok";
      },
    });
    try {
      const job = queue.enqueue(photonJob());
      await expect.poll(() => queue.get(job.id)?.status, { timeout: 250 }).toBe("blocked");
      expect(calls).toEqual([]);
      releaseBusy?.();
    } finally {
      await queue.close();
    }
  });

  it("does not start typing on running claim before spawn", async () => {
    let releaseExecute: (() => void) | undefined;
    const { queue, calls } = createHarness({
      execute: async (_target, _prompt, _signal, lifecycle) => {
        expect(calls).toEqual([]);
        await new Promise<void>((resolve) => {
          releaseExecute = resolve;
        });
        lifecycle?.onSpawn?.();
        return "done";
      },
    });
    try {
      const job = queue.enqueue(photonJob());
      await expect.poll(() => queue.get(job.id)?.status).toBe("running");
      expect(calls).toEqual([]);
      releaseExecute?.();
      await queue.wait(job.id);
      expect(calls.some((call) => call.state === "start")).toBe(true);
    } finally {
      await queue.close();
    }
  });

  it("starts typing for the correct connector and space after spawn", async () => {
    const { queue, calls } = createHarness({});
    try {
      const job = queue.enqueue(photonJob({ target: "fable", spaceId: "space-abc" }));
      await queue.wait(job.id);
      expect(calls.filter((call) => call.state === "start")).toEqual([
        { agentId: "fable", spaceId: "space-abc", state: "start" },
      ]);
      expect(calls.filter((call) => call.state === "stop")).toEqual([
        { agentId: "fable", spaceId: "space-abc", state: "stop" },
      ]);
    } finally {
      await queue.close();
    }
  });

  it("uses the shared delivery route for notify-only Photon jobs", async () => {
    const { manager, calls } = createTypingManager();
    const coordinator = new PhotonTypingCoordinator(manager, (job) => ({
      agentId: job.target,
      spaceId: "learned-owner-space",
    }));
    const { queue } = createHarness({ coordinator });
    try {
      const job = queue.enqueue({ target: "fable", prompt: "notify", notify: "photon" });
      await queue.wait(job.id);
      expect(calls).toEqual([
        { agentId: "fable", spaceId: "learned-owner-space", state: "start" },
        { agentId: "fable", spaceId: "learned-owner-space", state: "stop" },
      ]);
    } finally {
      await queue.close();
    }
  });

  it("refreshes typing across a long turn using Photon cooldown", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const { queue, calls } = createHarness({
      execute: async (_target, _prompt, _signal, lifecycle) => {
        lifecycle?.onSpawn?.();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return "long";
      },
    });
    try {
      const job = queue.enqueue(photonJob());
      await vi.advanceTimersByTimeAsync(0);
      await expect.poll(() => calls.filter((call) => call.state === "start").length).toBe(1);
      const thirtyMinutesMs = 30 * 60 * 1000;
      await vi.advanceTimersByTimeAsync(thirtyMinutesMs);
      const expectedRefreshes = Math.floor(thirtyMinutesMs / PHOTON_TYPING_REFRESH_MS);
      expect(calls.filter((call) => call.state === "start").length).toBe(1 + expectedRefreshes);
      release?.();
      await vi.advanceTimersByTimeAsync(0);
      await queue.wait(job.id);
    } finally {
      await queue.close();
    }
  });

  it("stops typing on success, execute failure, timeout, cancellation intent, and queue close", async () => {
    const cases: Array<{
      name: string;
      run: (ctx: ReturnType<typeof createHarness>) => Promise<void>;
    }> = [
      {
        name: "success",
        run: async ({ queue, calls }) => {
          const job = queue.enqueue(photonJob({ prompt: "ok" }));
          await queue.wait(job.id);
          expect(calls.at(-1)).toEqual({
            agentId: "fable",
            spaceId: "space-dm-1",
            state: "stop",
          });
        },
      },
      {
        name: "execute throw",
        run: async () => {
          const failing = createHarness({
            execute: async (_t, _p, _s, lifecycle) => {
              lifecycle?.onSpawn?.();
              throw new Error("boom");
            },
          });
          queues.push(failing.queue);
          failing.queue.start();
          const job = failing.queue.enqueue(photonJob());
          await failing.queue.wait(job.id);
          expect(failing.calls.at(-1)?.state).toBe("stop");
          await failing.queue.close();
        },
      },
      {
        name: "timeout",
        run: async () => {
          const timing = createHarness({
            execute: (targetArg, prompt, signal, lifecycle) =>
              executeRelayTarget(
                { ...targetArg, args: ["-e", "setTimeout(() => {}, 1000)"] },
                prompt,
                { signal, timeoutMs: 20, onSpawn: lifecycle?.onSpawn },
              ),
          });
          queues.push(timing.queue);
          timing.queue.start();
          const job = timing.queue.enqueue(photonJob());
          await timing.queue.wait(job.id);
          expect(timing.calls.some((call) => call.state === "stop")).toBe(true);
          await timing.queue.close();
        },
      },
      {
        name: "cancellation intent",
        run: async () => {
          let release: (() => void) | undefined;
          const blocking = createHarness({
            execute: async (_t, _p, _s, lifecycle) => {
              lifecycle?.onSpawn?.();
              await new Promise<void>((resolve) => {
                release = resolve;
              });
              return "still running";
            },
          });
          queues.push(blocking.queue);
          blocking.queue.start();
          const job = blocking.queue.enqueue(photonJob());
          await expect.poll(() => blocking.calls.some((call) => call.state === "start")).toBe(true);
          blocking.queue.cancelJob(job.id);
          expect(blocking.calls.filter((call) => call.state === "stop").length).toBeGreaterThan(0);
          release?.();
          await blocking.queue.wait(job.id);
          await blocking.queue.close();
        },
      },
      {
        name: "queue close",
        run: async () => {
          let release: (() => void) | undefined;
          const blocking = createHarness({
            execute: async (_t, _p, _s, lifecycle) => {
              lifecycle?.onSpawn?.();
              await new Promise<void>((resolve) => {
                release = resolve;
              });
              return "late";
            },
          });
          queues.push(blocking.queue);
          blocking.queue.start();
          blocking.queue.enqueue(photonJob());
          await expect.poll(() => blocking.calls.some((call) => call.state === "start")).toBe(true);
          const closePromise = blocking.queue.close();
          expect(blocking.calls.some((call) => call.state === "stop")).toBe(true);
          release?.();
          await closePromise;
        },
      },
    ];

    for (const testCase of cases) {
      const ctx = createHarness({});
      try {
        await testCase.run(ctx);
      } finally {
        await ctx.queue.close();
      }
    }
  });

  it("treats typing start, refresh, and stop failures as nonfatal", async () => {
    const { manager, calls } = createTypingManager();
    manager.typing.mockImplementation(async (_agentId, _spaceId, state) => {
      calls.push({ agentId: "fable", spaceId: "space-dm-1", state });
      throw new Error("sidecar typing down");
    });
    const { queue } = createHarness({ coordinator: new PhotonTypingCoordinator(manager) });
    try {
      const job = queue.enqueue(photonJob());
      const settled = await queue.wait(job.id);
      expect(settled.status).toBe("completed");
    } finally {
      await queue.close();
    }
  });

  it("does not let an unresolved start complete after the job has stopped", async () => {
    let finishStart: (() => void) | undefined;
    const calls: TypingCall[] = [];
    const manager = {
      typing: vi.fn(async (agentId: string, spaceId: string, state: "start" | "stop") => {
        calls.push({ agentId, spaceId, state });
        if (state === "start") {
          await new Promise<void>((resolve) => {
            finishStart = resolve;
          });
        }
      }),
    };
    const coordinator = new PhotonTypingCoordinator(manager);
    const job = {
      ...photonJob(),
      id: "late-start",
      status: "running" as const,
      jobKind: "agent" as const,
      sender: null,
      output: null,
      error: null,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      notify: null,
      deliveryStatus: "pending" as const,
      deliveryError: null,
    };
    coordinator.onRunning(job);
    coordinator.onSpawn(job);
    await expect.poll(() => calls).toHaveLength(1);
    const stopped = coordinator.onFinished(job);
    await Promise.resolve();
    expect(calls.map((call) => call.state)).toEqual(["start"]);
    finishStart?.();
    await stopped;
    expect(calls.map((call) => call.state)).toEqual(["start", "stop"]);
  });

  it("does not let an unresolved refresh complete after the job has stopped", async () => {
    vi.useFakeTimers();
    let finishRefresh: (() => void) | undefined;
    let starts = 0;
    const calls: TypingCall[] = [];
    const manager = {
      typing: vi.fn(async (agentId: string, spaceId: string, state: "start" | "stop") => {
        calls.push({ agentId, spaceId, state });
        if (state === "start" && ++starts === 2) {
          await new Promise<void>((resolve) => {
            finishRefresh = resolve;
          });
        }
      }),
    };
    const coordinator = new PhotonTypingCoordinator(manager);
    const job = {
      ...photonJob(),
      id: "late-refresh",
      status: "running" as const,
      jobKind: "agent" as const,
      sender: null,
      output: null,
      error: null,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      notify: null,
      deliveryStatus: "pending" as const,
      deliveryError: null,
    };
    coordinator.onRunning(job);
    coordinator.onSpawn(job);
    await vi.advanceTimersByTimeAsync(PHOTON_TYPING_REFRESH_MS);
    expect(calls.map((call) => call.state)).toEqual(["start", "start"]);
    const stopped = coordinator.onFinished(job);
    await Promise.resolve();
    expect(calls.map((call) => call.state)).toEqual(["start", "start"]);
    finishRefresh?.();
    await stopped;
    expect(calls.map((call) => call.state)).toEqual(["start", "start", "stop"]);
  });

  it("reconciles orphan running photon jobs with stop only and never restarts typing", async () => {
    const { manager, calls } = createTypingManager();
    const coordinator = new PhotonTypingCoordinator(manager);
    const orphan: RelayJob = {
      id: "orphan-1",
      target: "fable",
      prompt: "stale",
      status: "running",
      jobClass: "prioritized",
      jobKind: "agent",
      sender: null,
      output: null,
      error: null,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      notify: null,
      delivery: { channel: "photon", destination: { spaceId: "space-orphan" } },
      deliveryStatus: "pending",
      deliveryError: null,
    };
    coordinator.reconcileInterruptedJobs([orphan]);
    expect(calls).toEqual([{ agentId: "fable", spaceId: "space-orphan", state: "stop" }]);
    calls.length = 0;
    coordinator.onRunning(orphan);
    coordinator.onSpawn(orphan);
    expect(calls).toEqual([]);
  });

  it("does not cross-stop concurrent jobs on different routes", async () => {
    let releaseA: (() => void) | undefined;
    let releaseB: (() => void) | undefined;
    const { queue, calls } = createHarness({
      execute: async (targetArg, _prompt, _signal, lifecycle) => {
        lifecycle?.onSpawn?.();
        if (targetArg.threadId === "th_fable") {
          await new Promise<void>((resolve) => {
            releaseA = resolve;
          });
        } else {
          await new Promise<void>((resolve) => {
            releaseB = resolve;
          });
        }
        return "ok";
      },
    });
    try {
      const jobA = queue.enqueue(photonJob({ target: "fable", spaceId: "space-a" }));
      const jobB = queue.enqueue({
        ...photonJob({ target: "other", spaceId: "space-b" }),
        target: "other",
      });
      await expect.poll(() => calls.filter((call) => call.state === "start").length).toBe(2);
      releaseA?.();
      await queue.wait(jobA.id);
      expect(
        calls.filter((call) => call.spaceId === "space-a" && call.state === "stop"),
      ).toHaveLength(1);
      expect(
        calls.filter((call) => call.spaceId === "space-b" && call.state === "stop"),
      ).toHaveLength(0);
      releaseB?.();
      await queue.wait(jobB.id);
    } finally {
      await queue.close();
    }
  });

  it("excludes outbound and non-photon agent jobs", async () => {
    const { queue, calls } = createHarness({});
    try {
      queue.enqueue({
        target: "fable",
        prompt: "out",
        jobKind: "outbound",
        sender: "fable",
        delivery: { channel: "photon", destination: { spaceId: "space-out" } },
      });
      const slack = queue.enqueue({
        target: "fable",
        prompt: "slack",
        delivery: { channel: "slack", destination: { channelId: "c1" } },
      });
      await queue.wait(slack.id);
      expect(calls).toEqual([]);
    } finally {
      await queue.close();
    }
  });
});
