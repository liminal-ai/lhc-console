import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { RelayQueue } from "../src/relay.ts";

const dirs: string[] = [];

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "lhc-console-relay-"));
  dirs.push(dir);
  return join(dir, "relay.sqlite");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("RelayQueue", () => {
  it("runs jobs for one thread strictly one at a time", async () => {
    let active = 0;
    let maxActive = 0;
    const calls: string[] = [];
    const queue = new RelayQueue({
      dbPath: tempDb(),
      targets: {
        fable: {
          hostId: "pi-lhc",
          threadId: "th_fable",
          cwd: "/srv/work/long-horizon-context",
          command: "pi-lhc",
          args: ["--lhc-thread", "th_fable", "-p"],
        },
      },
      isBusy: () => false,
      execute: async (_target, prompt) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        calls.push(prompt);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return `reply:${prompt}`;
      },
      busyPollMs: 5,
    });

    try {
      const first = queue.enqueue({ target: "fable", prompt: "one" });
      const second = queue.enqueue({ target: "fable", prompt: "two" });
      const [a, b] = await Promise.all([queue.wait(first.id), queue.wait(second.id)]);

      expect(calls).toEqual(["one", "two"]);
      expect(maxActive).toBe(1);
      expect(a).toMatchObject({ status: "completed", output: "reply:one" });
      expect(b).toMatchObject({ status: "completed", output: "reply:two" });
    } finally {
      await queue.close();
    }
  });

  it("surfaces a busy thread and runs the queued job after it is released", async () => {
    let busy = true;
    const queue = new RelayQueue({
      dbPath: tempDb(),
      targets: {
        fable: {
          hostId: "pi-lhc",
          threadId: "th_fable",
          cwd: "/srv/work/long-horizon-context",
          command: "pi-lhc",
          args: ["--lhc-thread", "th_fable", "-p"],
        },
      },
      isBusy: () => busy,
      execute: async (_target, prompt) => `reply:${prompt}`,
      busyPollMs: 5,
    });

    try {
      const submitted = queue.enqueue({ target: "fable", prompt: "later" });
      await expect.poll(() => queue.get(submitted.id)?.status, { timeout: 500 }).toBe("blocked");

      busy = false;
      const completed = await queue.wait(submitted.id);
      expect(completed).toMatchObject({ status: "completed", output: "reply:later" });
    } finally {
      await queue.close();
    }
  });

  it("delivers completed human jobs through the configured notifier", async () => {
    const delivered: string[] = [];
    const queue = new RelayQueue({
      dbPath: tempDb(),
      targets: {
        fable: {
          hostId: "pi-lhc",
          threadId: "th_fable",
          cwd: "/srv/work/long-horizon-context",
          command: "pi-lhc",
          args: ["--lhc-thread", "th_fable", "-p"],
        },
      },
      isBusy: () => false,
      execute: async (_target, prompt) => `reply:${prompt}`,
      deliver: async (job) => {
        delivered.push(`${job.target}:${job.output}`);
      },
    });

    try {
      const submitted = queue.enqueue({ target: "fable", prompt: "human", notify: "photon" });
      const completed = await queue.wait(submitted.id);
      await expect.poll(() => queue.get(submitted.id)?.deliveryStatus).toBe("delivered");
      expect(completed.status).toBe("completed");
      expect(delivered).toEqual(["fable:reply:human"]);
    } finally {
      await queue.close();
    }
  });

  it("serializes durable jobs across two queue instances", async () => {
    const dbPath = tempDb();
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const options = {
      dbPath,
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
      busyPollMs: 5,
      execute: async () => {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return "once";
      },
    };
    const first = new RelayQueue(options);
    const second = new RelayQueue(options);
    const a = first.enqueue({ target: "fable", prompt: "first" });
    const b = second.enqueue({ target: "fable", prompt: "second" });

    try {
      await Promise.all([first.wait(a.id), second.wait(b.id)]);
      expect(calls).toBe(2);
      expect(maxActive).toBe(1);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it("aborts and settles a running executor before closing", async () => {
    let aborted = false;
    const queue = new RelayQueue({
      dbPath: tempDb(),
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
      execute: async (_target, _prompt, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    });
    const job = queue.enqueue({ target: "fable", prompt: "stop me" });
    await expect.poll(() => queue.get(job.id)?.status).toBe("running");

    await queue.close();
    expect(aborted).toBe(true);
  });

  it("retries a pending human delivery after restart", async () => {
    const dbPath = tempDb();
    const target = {
      hostId: "pi-lhc",
      threadId: "th_fable",
      cwd: "/tmp",
      command: "unused",
      args: [],
    };
    const first = new RelayQueue({
      dbPath,
      targets: { fable: target },
      isBusy: () => false,
      execute: async () => "saved reply",
    });
    const submitted = first.enqueue({ target: "fable", prompt: "human", notify: "photon" });
    await first.wait(submitted.id);
    expect(first.get(submitted.id)?.deliveryStatus).toBe("pending");
    await first.close();

    const delivered: string[] = [];
    const second = new RelayQueue({
      dbPath,
      targets: { fable: target },
      isBusy: () => false,
      execute: async () => "unused",
      deliver: async (job) => {
        delivered.push(job.output ?? "");
      },
    });
    try {
      await expect.poll(() => second.get(submitted.id)?.deliveryStatus).toBe("delivered");
      expect(delivered).toEqual(["saved reply"]);
    } finally {
      await second.close();
    }
  });
});
