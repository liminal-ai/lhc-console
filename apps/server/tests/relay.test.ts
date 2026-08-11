import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { GroupCatchUpStore } from "../src/group-catch-up.ts";
import { RelayQueue, DELIVERY_RETRY_BASE_MS } from "../src/relay.ts";

const dirs: string[] = [];

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "lhc-console-relay-"));
  dirs.push(dir);
  return join(dir, "relay.sqlite");
}

function createQueue(options: ConstructorParameters<typeof RelayQueue>[0]): RelayQueue {
  const queue = new RelayQueue(options);
  queue.start();
  return queue;
}

function failureFallbackApplied(dbPath: string, id: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db
      .prepare("SELECT failure_fallback_applied FROM relay_jobs WHERE id = ?")
      .get(id) as { failure_fallback_applied: number };
    return row.failure_fallback_applied;
  } finally {
    db.close();
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("RelayQueue", () => {
  it("rejects inherited object keys as unknown targets", async () => {
    const queue = createQueue({
      dbPath: tempDb(),
      targets: {},
      isBusy: () => false,
      execute: async () => "unreachable",
    });
    try {
      expect(() => queue.enqueue({ target: "constructor", prompt: "hello" })).toThrow(
        /unknown relay target/,
      );
    } finally {
      await queue.close();
    }
  });

  it("rejects invalid jobClass values at enqueue time", async () => {
    const queue = createQueue({
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
      execute: async () => "ok",
    });
    try {
      expect(() =>
        queue.enqueue({
          target: "fable",
          prompt: "bad class",
          jobClass: "urgent" as "prioritized",
        }),
      ).toThrow(/jobClass/);
    } finally {
      await queue.close();
    }
  });

  it("normalizes malformed persisted job_class values during migration and read", async () => {
    const dbPath = tempDb();
    const seed = new DatabaseSync(dbPath);
    seed.exec(`
      CREATE TABLE relay_jobs (
        id TEXT PRIMARY KEY, target TEXT NOT NULL, prompt TEXT NOT NULL,
        status TEXT NOT NULL, output TEXT, error TEXT, created_at TEXT NOT NULL,
        started_at TEXT, finished_at TEXT, notify TEXT, delivery_status TEXT,
        delivery_error TEXT, owner_pid INTEGER, job_class TEXT
      )
    `);
    seed
      .prepare(
        `INSERT INTO relay_jobs
         (id, target, prompt, status, created_at, job_class)
         VALUES (?, ?, ?, 'queued', ?, ?)`,
      )
      .run("bad-class", "fable", "legacy", "2020-01-01T00:00:00.000Z", "urgent");
    seed
      .prepare(
        `INSERT INTO relay_jobs
         (id, target, prompt, status, created_at, job_class)
         VALUES (?, ?, ?, 'queued', ?, NULL)`,
      )
      .run("null-class", "fable", "legacy null", "2020-01-01T00:00:01.000Z");
    seed.close();

    const queue = createQueue({
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
      execute: async () => "ok",
      busyPollMs: 5,
    });
    try {
      expect(queue.get("bad-class")?.jobClass).toBe("deprioritized");
      expect(queue.get("null-class")?.jobClass).toBe("deprioritized");
      const db = new DatabaseSync(dbPath);
      try {
        const rows = db
          .prepare("SELECT id, job_class FROM relay_jobs WHERE id IN ('bad-class', 'null-class')")
          .all() as Array<{ id: string; job_class: string }>;
        expect(rows).toHaveLength(2);
        expect(rows.every((row) => row.job_class === "deprioritized")).toBe(true);
      } finally {
        db.close();
      }
    } finally {
      await queue.close();
    }
  });

  it("fences queued reminders with a durable cancellation tombstone", async () => {
    const calls: string[] = [];
    const queue = createQueue({
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
      execute: async (_target, prompt) => {
        calls.push(prompt);
        return `reply:${prompt}`;
      },
      busyPollMs: 5,
    });
    try {
      const job = queue.enqueue({
        id: "reminder-1",
        target: "fable",
        prompt: "nudge",
        jobClass: "prioritized",
      });
      queue.cancelJob(job.id);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(calls).toEqual([]);
      expect(queue.get(job.id)?.status).toBe("cancelled");
      queue.cancelJob(job.id);
      expect(queue.get(job.id)?.status).toBe("cancelled");
    } finally {
      await queue.close();
    }
  });

  it("emits settlement when the scheduler applies an externally inserted tombstone", async () => {
    const dbPath = tempDb();
    const settled: string[] = [];
    const queue = createQueue({
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
      isBusy: () => true,
      execute: async () => "unreachable",
      busyPollMs: 5,
    });
    queue.addSettledListener((job) => {
      settled.push(job.id);
    });
    try {
      const job = queue.enqueue({ target: "fable", prompt: "cancel externally" });
      await expect.poll(() => queue.get(job.id)?.status, { timeout: 250 }).toBe("blocked");
      const db = new DatabaseSync(dbPath);
      db.prepare("INSERT INTO relay_cancelled_jobs (id, cancelled_at) VALUES (?, ?)").run(
        job.id,
        new Date().toISOString(),
      );
      db.close();
      queue.pokeSchedule("fable");
      await expect.poll(() => queue.get(job.id)?.status, { timeout: 250 }).toBe("cancelled");
      expect(settled).toEqual([job.id]);
    } finally {
      await queue.close();
    }
  });

  it("does not preempt a running turn when a reminder is cancelled", async () => {
    let release: (() => void) | undefined;
    const calls: string[] = [];
    const queue = createQueue({
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
      execute: async (_target, prompt) => {
        calls.push(prompt);
        if (prompt === "running") {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return `reply:${prompt}`;
      },
      busyPollMs: 5,
    });
    try {
      const job = queue.enqueue({ target: "fable", prompt: "running" });
      await expect.poll(() => queue.get(job.id)?.status).toBe("running");
      queue.cancelJob(job.id);
      expect(queue.get(job.id)?.status).toBe("running");
      release?.();
      await queue.wait(job.id);
      expect(calls).toEqual(["running"]);
      expect(queue.get(job.id)?.status).toBe("completed");
    } finally {
      await queue.close();
    }
  });

  it("rejects enqueue for tombstoned reminder ids", async () => {
    const queue = createQueue({
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
      execute: async () => "ok",
    });
    try {
      queue.cancelJob("never-inserted");
      expect(() =>
        queue.enqueue({
          id: "never-inserted",
          target: "fable",
          prompt: "too late",
          jobClass: "prioritized",
        }),
      ).toThrow(/cancelled/i);
    } finally {
      await queue.close();
    }
  });

  it("isolates synchronous and asynchronous settled listener failures and supports removal", async () => {
    const calls: string[] = [];
    const queue = createQueue({
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
      execute: async () => "ok",
      busyPollMs: 5,
    });
    const removeFirst = queue.addSettledListener(() => {
      throw new Error("listener boom");
    });
    const removeAsync = queue.addSettledListener(async () => {
      await Promise.resolve();
      throw new Error("async listener boom");
    });
    const removeSecond = queue.addSettledListener((job) => {
      calls.push(job.id);
    });
    try {
      const job = queue.enqueue({ target: "fable", prompt: "hello" });
      await queue.wait(job.id);
      expect(calls).toEqual([job.id]);
      removeFirst();
      removeAsync();
      removeSecond();
      const second = queue.enqueue({ target: "fable", prompt: "again" });
      await queue.wait(second.id);
      expect(calls).toEqual([job.id]);
    } finally {
      await queue.close();
    }
  });

  it("defaults new jobs to deprioritized and migrates legacy rows", async () => {
    const dbPath = tempDb();
    const seed = new DatabaseSync(dbPath);
    seed.exec(`
      CREATE TABLE relay_jobs (
        id TEXT PRIMARY KEY, target TEXT NOT NULL, prompt TEXT NOT NULL,
        status TEXT NOT NULL, output TEXT, error TEXT, created_at TEXT NOT NULL,
        started_at TEXT, finished_at TEXT, notify TEXT, delivery_status TEXT,
        delivery_error TEXT, owner_pid INTEGER
      )
    `);
    seed
      .prepare(
        `INSERT INTO relay_jobs
         (id, target, prompt, status, created_at)
         VALUES (?, ?, ?, 'queued', ?)`,
      )
      .run("legacy", "fable", "old job", "2020-01-01T00:00:00.000Z");
    seed.close();

    const queue = createQueue({
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
      execute: async () => "ok",
      busyPollMs: 5,
    });
    try {
      const created = queue.enqueue({ target: "fable", prompt: "new job" });
      expect(created.jobClass).toBe("deprioritized");
      expect(queue.get("legacy")?.jobClass).toBe("deprioritized");
    } finally {
      await queue.close();
    }
  });

  it("pokes the target when an idempotent enqueue retries an existing durable id", async () => {
    let busy = true;
    const calls: string[] = [];
    const queue = createQueue({
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
      isBusy: () => busy,
      execute: async (_target, prompt) => {
        calls.push(prompt);
        return `reply:${prompt}`;
      },
      busyPollMs: 5,
    });
    try {
      const first = queue.enqueue({
        id: "stable-reminder",
        target: "fable",
        prompt: "continue",
        jobClass: "prioritized",
      });
      await expect.poll(() => queue.get(first.id)?.status, { timeout: 500 }).toBe("blocked");
      busy = false;
      queue.enqueue({
        id: "stable-reminder",
        target: "fable",
        prompt: "continue",
        jobClass: "prioritized",
      });
      await expect.poll(() => calls, { timeout: 500 }).toEqual(["continue"]);
      expect(queue.get(first.id)?.status).toBe("completed");
    } finally {
      await queue.close();
    }
  });

  it("idempotently returns an existing job when an explicit durable id is retried", async () => {
    const queue = createQueue({
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
      isBusy: () => true,
      execute: async () => "unreachable",
      busyPollMs: 5,
    });
    try {
      const first = queue.enqueue({
        id: "stable-reminder",
        target: "fable",
        prompt: "continue",
        jobClass: "prioritized",
      });
      const retried = queue.enqueue({
        id: "stable-reminder",
        target: "fable",
        prompt: "continue",
        jobClass: "prioritized",
      });
      expect(retried).toEqual(first);
      expect(queue.get("stable-reminder")).toEqual(first);
    } finally {
      await queue.close();
    }
  });

  it("resolves waiters when a queued job is cancelled", async () => {
    const queue = createQueue({
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
      isBusy: () => true,
      execute: async () => "unreachable",
      busyPollMs: 5,
    });
    try {
      const job = queue.enqueue({ target: "fable", prompt: "cancel me" });
      const settled = queue.wait(job.id);
      queue.cancelJob(job.id);
      await expect(settled).resolves.toMatchObject({ id: job.id, status: "cancelled" });
    } finally {
      await queue.close();
    }
  });

  it("runs queued prioritized jobs before deprioritized jobs while preserving FIFO within each class", async () => {
    let releaseFirst: (() => void) | undefined;
    const calls: string[] = [];
    const queue = createQueue({
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
      execute: async (_target, prompt) => {
        calls.push(prompt);
        if (prompt === "dep-a") {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        return `reply:${prompt}`;
      },
      busyPollMs: 5,
    });

    try {
      const depFirst = queue.enqueue({ target: "fable", prompt: "dep-a" });
      await expect.poll(() => queue.get(depFirst.id)?.status).toBe("running");
      const priFirst = queue.enqueue({ target: "fable", prompt: "pri-a", jobClass: "prioritized" });
      const depSecond = queue.enqueue({ target: "fable", prompt: "dep-b" });
      const priSecond = queue.enqueue({
        target: "fable",
        prompt: "pri-b",
        jobClass: "prioritized",
      });
      releaseFirst?.();
      await Promise.all([
        queue.wait(depFirst.id),
        queue.wait(priFirst.id),
        queue.wait(depSecond.id),
        queue.wait(priSecond.id),
      ]);
      expect(calls).toEqual(["dep-a", "pri-a", "pri-b", "dep-b"]);
    } finally {
      await queue.close();
    }
  });

  it("claims the highest-priority queued job when a prioritized job arrives during isBusy", async () => {
    let releaseBusy: (() => void) | undefined;
    const calls: string[] = [];
    const queue = createQueue({
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
      isBusy: () => {
        if (!releaseBusy) return false;
        return new Promise<boolean>((resolve) => {
          const gate = releaseBusy;
          releaseBusy = undefined;
          void new Promise<void>((done) => {
            gate?.();
            done();
          }).then(() => resolve(false));
        });
      },
      execute: async (_target, prompt) => {
        calls.push(prompt);
        return `reply:${prompt}`;
      },
      busyPollMs: 5,
    });

    try {
      const dep = queue.enqueue({ target: "fable", prompt: "dep-wait" });
      releaseBusy = () => {
        queue.enqueue({ target: "fable", prompt: "pri-jump", jobClass: "prioritized" });
      };
      await expect.poll(() => calls.length, { timeout: 2000 }).toBe(2);
      expect(calls).toEqual(["pri-jump", "dep-wait"]);
      await queue.wait(dep.id);
    } finally {
      await queue.close();
    }
  });

  it("does not preempt a running turn for a prioritized job", async () => {
    let release: (() => void) | undefined;
    const calls: string[] = [];
    const queue = createQueue({
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
      execute: async (_target, prompt) => {
        calls.push(prompt);
        if (prompt === "running") {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return `reply:${prompt}`;
      },
      busyPollMs: 5,
    });

    try {
      const running = queue.enqueue({ target: "fable", prompt: "running" });
      await expect.poll(() => queue.get(running.id)?.status).toBe("running");
      const prioritized = queue.enqueue({
        target: "fable",
        prompt: "jump",
        jobClass: "prioritized",
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(calls).toEqual(["running"]);
      release?.();
      await queue.wait(prioritized.id);
      expect(calls).toEqual(["running", "jump"]);
    } finally {
      await queue.close();
    }
  });

  it("runs jobs for one thread strictly one at a time", async () => {
    let active = 0;
    let maxActive = 0;
    const calls: string[] = [];
    const queue = createQueue({
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
    const queue = createQueue({
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
    const queue = createQueue({
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

  it("delivers to a persisted per-job destination", async () => {
    const delivered: Array<{ spaceId: string; text: string }> = [];
    const queue = createQueue({
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
      execute: async () => "saved reply",
      deliver: async (job) => {
        delivered.push({
          spaceId: job.delivery?.destination.spaceId ?? "",
          text: job.output ?? "",
        });
      },
    });

    try {
      const submitted = queue.enqueue({
        target: "fable",
        prompt: "hello",
        delivery: { channel: "photon", destination: { spaceId: "chat-originating" } },
      });
      await queue.wait(submitted.id);
      await expect.poll(() => queue.get(submitted.id)?.deliveryStatus).toBe("delivered");
      expect(delivered).toEqual([{ spaceId: "chat-originating", text: "saved reply" }]);
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
    first.start();
    second.start();
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
    const queue = createQueue({
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

  it("marks an orphaned running job as indeterminate rather than definitely failed", async () => {
    const dbPath = tempDb();
    const seed = new DatabaseSync(dbPath);
    seed.exec(`
      CREATE TABLE relay_jobs (
        id TEXT PRIMARY KEY, target TEXT NOT NULL, prompt TEXT NOT NULL,
        status TEXT NOT NULL, output TEXT, error TEXT, created_at TEXT NOT NULL,
        started_at TEXT, finished_at TEXT, notify TEXT, delivery_status TEXT,
        delivery_error TEXT, owner_pid INTEGER
      )
    `);
    const now = new Date().toISOString();
    seed
      .prepare(
        `INSERT INTO relay_jobs
         (id, target, prompt, status, created_at, started_at, owner_pid)
         VALUES (?, ?, ?, 'running', ?, ?, ?)`,
      )
      .run("orphan", "fable", "possibly landed", now, now, 999_999_999);
    seed.close();

    const queue = createQueue({
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
      execute: async () => "unused",
      busyPollMs: 5,
    });
    try {
      await expect.poll(() => queue.get("orphan")?.status).toBe("failed");
      expect(queue.get("orphan")?.error).toContain("may have completed");
      expect(queue.get("orphan")?.error).toContain("durable thread");
    } finally {
      await queue.close();
    }
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
    first.start();
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
    second.start();
    try {
      await expect.poll(() => second.get(submitted.id)?.deliveryStatus).toBe("delivered");
      expect(delivered).toEqual(["saved reply"]);
    } finally {
      await second.close();
    }
  });

  it("retries per-job delivery after a failed attempt", async () => {
    const dbPath = tempDb();
    const target = {
      hostId: "pi-lhc",
      threadId: "th_fable",
      cwd: "/tmp",
      command: "unused",
      args: [],
    };
    let attempts = 0;
    const first = new RelayQueue({
      dbPath,
      targets: { fable: target },
      isBusy: () => false,
      execute: async () => "reply text",
      deliver: async () => {
        attempts += 1;
        throw new Error("send failed");
      },
      busyPollMs: 5,
    });
    first.start();
    const submitted = first.enqueue({
      target: "fable",
      prompt: "hello",
      delivery: { channel: "photon", destination: { spaceId: "chat-1" } },
    });
    await first.wait(submitted.id);
    await expect.poll(() => first.get(submitted.id)?.deliveryStatus).toBe("failed");
    await first.close();

    const second = new RelayQueue({
      dbPath,
      targets: { fable: target },
      isBusy: () => false,
      execute: async () => "unused",
      deliver: async (job) => {
        attempts += 1;
        expect(job.output).toBe("reply text");
      },
      busyPollMs: 5,
    });
    second.start();
    try {
      await expect
        .poll(() => second.get(submitted.id)?.deliveryStatus, { timeout: 500 })
        .toBe("delivered");
      expect(attempts).toBe(2);
    } finally {
      await second.close();
    }
  });

  it("recovers per-job delivery after restart without rerunning execution", async () => {
    const dbPath = tempDb();
    const target = {
      hostId: "pi-lhc",
      threadId: "th_fable",
      cwd: "/tmp",
      command: "unused",
      args: [],
    };
    let executeCalls = 0;
    const first = new RelayQueue({
      dbPath,
      targets: { fable: target },
      isBusy: () => false,
      execute: async () => {
        executeCalls += 1;
        return "saved reply";
      },
    });
    first.start();
    const submitted = first.enqueue({
      target: "fable",
      prompt: "hello",
      delivery: { channel: "photon", destination: { spaceId: "chat-originating" } },
    });
    await first.wait(submitted.id);
    expect(first.get(submitted.id)?.deliveryStatus).toBe("pending");
    await first.close();

    const delivered: Array<{ spaceId: string; text: string }> = [];
    const second = new RelayQueue({
      dbPath,
      targets: { fable: target },
      isBusy: () => false,
      execute: async () => {
        executeCalls += 1;
        return "should-not-run";
      },
      deliver: async (job) => {
        delivered.push({
          spaceId: job.delivery?.destination.spaceId ?? "",
          text: job.output ?? "",
        });
      },
      busyPollMs: 5,
    });
    second.start();
    try {
      await expect.poll(() => second.get(submitted.id)?.deliveryStatus).toBe("delivered");
      expect(delivered).toEqual([{ spaceId: "chat-originating", text: "saved reply" }]);
      expect(executeCalls).toBe(1);
    } finally {
      await second.close();
    }
  });

  it("does not run jobs until start() is called", async () => {
    let calls = 0;
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
      execute: async () => {
        calls += 1;
        return "reply";
      },
      busyPollMs: 5,
    });
    const job = queue.enqueue({ target: "fable", prompt: "wait" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toBe(0);
    queue.start();
    await queue.wait(job.id);
    expect(calls).toBe(1);
    await queue.close();
  });

  it("retries failed delivery in the same running process", async () => {
    let attempts = 0;
    const queue = createQueue({
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
      execute: async () => "reply text",
      deliver: async () => {
        attempts += 1;
        if (attempts < 2) throw new Error("send failed");
      },
      busyPollMs: 5,
    });
    const submitted = queue.enqueue({
      target: "fable",
      prompt: "hello",
      delivery: { channel: "photon", destination: { spaceId: "chat-1" } },
    });
    await queue.wait(submitted.id);
    await expect
      .poll(() => queue.get(submitted.id)?.deliveryStatus, { timeout: 2_000 })
      .toBe("delivered");
    expect(attempts).toBe(2);
    await queue.close();
  });

  it("closes within a timeout even when the executor ignores abort", async () => {
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
      closeTimeoutMs: 100,
      execute: async () => new Promise(() => undefined),
    });
    queue.start();
    const job = queue.enqueue({ target: "fable", prompt: "hang" });
    await expect.poll(() => queue.get(job.id)?.status, { timeout: 500 }).toBe("running");
    const started = Date.now();
    await queue.close();
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("contains a late delivery retry after close returns without closed-db errors", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    let attempts = 0;
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
      closeTimeoutMs: 50,
      deliver: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("send failed");
        await new Promise((resolve) => setTimeout(resolve, 200));
      },
      execute: async () => "reply text",
    });
    queue.start();
    const submitted = queue.enqueue({
      target: "fable",
      prompt: "hello",
      delivery: { channel: "photon", destination: { spaceId: "chat-1" } },
    });
    await queue.wait(submitted.id);
    await expect
      .poll(() => queue.get(submitted.id)?.deliveryStatus, { timeout: 500 })
      .toBe("failed");
    const started = Date.now();
    await queue.close();
    expect(Date.now() - started).toBeLessThan(DELIVERY_RETRY_BASE_MS);
    await expect
      .poll(() => queue.get(submitted.id)?.deliveryStatus, { timeout: 2_000 })
      .toBe("delivered");
    expect(attempts).toBe(2);
    expect(rejections).toEqual([]);
    process.off("unhandledRejection", onRejection);
  });

  it("contains a late executor completion after close returns without closed-db errors", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
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
      closeTimeoutMs: 50,
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return "late output";
      },
    });
    queue.start();
    const job = queue.enqueue({ target: "fable", prompt: "late" });
    await expect.poll(() => queue.get(job.id)?.status, { timeout: 500 }).toBe("running");
    const started = Date.now();
    await queue.close();
    expect(Date.now() - started).toBeLessThan(200);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(queue.get(job.id)?.status).toBe("completed");
    expect(queue.get(job.id)?.output).toBe("late output");
    expect(rejections).toEqual([]);
    process.off("unhandledRejection", onRejection);
  });

  it("reclaims an expired delivery lease with an atomic owner-token compare-and-swap", () => {
    const dbPath = tempDb();
    const seed = new DatabaseSync(dbPath);
    seed.exec(`
      CREATE TABLE relay_jobs (
        id TEXT PRIMARY KEY, target TEXT NOT NULL, prompt TEXT NOT NULL,
        status TEXT NOT NULL, output TEXT, error TEXT, created_at TEXT NOT NULL,
        started_at TEXT, finished_at TEXT, notify TEXT, delivery_status TEXT,
        delivery_error TEXT, owner_pid INTEGER, delivery_channel TEXT,
        delivery_destination TEXT, delivery_metadata TEXT, delivery_owner_pid INTEGER,
        delivery_owner_token TEXT, delivery_lease_expires_at TEXT,
        failure_fallback_applied INTEGER NOT NULL DEFAULT 0
      )
    `);
    const now = new Date().toISOString();
    const expiredLease = new Date(Date.now() - 60_000).toISOString();
    const observedToken = "stale-owner-token";
    seed
      .prepare(
        `INSERT INTO relay_jobs
         (id, target, prompt, status, output, created_at, finished_at, delivery_status,
          delivery_channel, delivery_destination, delivery_owner_pid, delivery_owner_token,
          delivery_lease_expires_at, failure_fallback_applied)
         VALUES (?, ?, ?, 'completed', ?, ?, ?, 'delivering', ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        "expired-reclaim",
        "fable",
        "hello",
        "saved reply",
        now,
        now,
        "photon",
        JSON.stringify({ spaceId: "chat-1" }),
        999_999_999,
        observedToken,
        expiredLease,
      );
    seed.close();

    const dbA = new DatabaseSync(dbPath);
    const dbB = new DatabaseSync(dbPath);
    const leaseNew = new Date(Date.now() + 60_000).toISOString();
    const reclaimSql = `
      UPDATE relay_jobs
      SET delivery_status = 'delivering',
          delivery_error = NULL,
          delivery_owner_pid = ?,
          delivery_owner_token = ?,
          delivery_lease_expires_at = ?
      WHERE id = ?
        AND status = 'completed'
        AND delivery_status = 'delivering'
        AND delivery_owner_token = ?
        AND delivery_lease_expires_at = ?
    `;
    const reclaimA = dbA
      .prepare(reclaimSql)
      .run(process.pid, randomUUID(), leaseNew, "expired-reclaim", observedToken, expiredLease);
    const reclaimB = dbB
      .prepare(reclaimSql)
      .run(process.pid, randomUUID(), leaseNew, "expired-reclaim", observedToken, expiredLease);
    dbA.close();
    dbB.close();
    expect(Number(reclaimA.changes) + Number(reclaimB.changes)).toBe(1);
  });

  it("allows only one concurrent delivery across two queue instances with a tiny lease", async () => {
    const dbPath = tempDb();
    const target = {
      hostId: "pi-lhc",
      threadId: "th_fable",
      cwd: "/tmp",
      command: "unused",
      args: [],
    };
    let sends = 0;
    const options = {
      dbPath,
      targets: { fable: target },
      isBusy: () => false,
      execute: async () => "reply",
      deliver: async () => {
        sends += 1;
        await new Promise((resolve) => setTimeout(resolve, 120));
      },
      deliveryLeaseMs: 20,
      deliveryHeartbeatMs: 5,
      busyPollMs: 5,
    };
    const first = new RelayQueue(options);
    const second = new RelayQueue(options);
    first.start();
    second.start();
    const submitted = first.enqueue({
      target: "fable",
      prompt: "hello",
      delivery: { channel: "photon", destination: { spaceId: "chat-1" } },
    });
    try {
      await first.wait(submitted.id);
      await expect
        .poll(() => second.get(submitted.id)?.deliveryStatus, { timeout: 2_000 })
        .toBe("delivered");
      expect(sends).toBe(1);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it("startup reclaim loses when a competitor installs a live token before its stale update", async () => {
    const dbPath = tempDb();
    const target = {
      hostId: "pi-lhc",
      threadId: "th_fable",
      cwd: "/tmp",
      command: "unused",
      args: [],
    };
    const staleToken = "stale-startup-token";
    const expiredLease = new Date(Date.now() - 60_000).toISOString();
    const seed = new DatabaseSync(dbPath);
    seed.exec(`
      CREATE TABLE relay_jobs (
        id TEXT PRIMARY KEY, target TEXT NOT NULL, prompt TEXT NOT NULL,
        status TEXT NOT NULL, output TEXT, error TEXT, created_at TEXT NOT NULL,
        started_at TEXT, finished_at TEXT, notify TEXT, delivery_status TEXT,
        delivery_error TEXT, owner_pid INTEGER, delivery_channel TEXT,
        delivery_destination TEXT, delivery_metadata TEXT, delivery_owner_pid INTEGER,
        delivery_owner_token TEXT, delivery_lease_expires_at TEXT,
        failure_fallback_applied INTEGER NOT NULL DEFAULT 0
      )
    `);
    const now = new Date().toISOString();
    seed
      .prepare(
        `INSERT INTO relay_jobs
         (id, target, prompt, status, output, created_at, finished_at, delivery_status,
          delivery_channel, delivery_destination, delivery_owner_pid, delivery_owner_token,
          delivery_lease_expires_at, failure_fallback_applied)
         VALUES (?, ?, ?, 'completed', ?, ?, ?, 'delivering', ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        "startup-race",
        "fable",
        "hello",
        "saved reply",
        now,
        now,
        "photon",
        JSON.stringify({ spaceId: "chat-1" }),
        999_999_999,
        staleToken,
        expiredLease,
      );
    seed.close();

    let externalSendCount = 0;
    const competitorToken = randomUUID();
    const competitorLease = new Date(Date.now() + 60_000).toISOString();
    const prepareDescriptor = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "prepare");
    if (!prepareDescriptor || typeof prepareDescriptor.value !== "function") {
      throw new Error("DatabaseSync.prepare descriptor unavailable");
    }
    DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
      const statement = Reflect.apply(prepareDescriptor.value, this, [sql]) as ReturnType<
        DatabaseSync["prepare"]
      >;
      const isStartupReclaim =
        sql.includes("SET delivery_status = 'pending'") &&
        sql.includes("delivery_status = 'delivering'");
      if (!isStartupReclaim) return statement;
      const originalRun = statement.run.bind(statement);
      return Object.assign(statement, {
        run: (...args: Parameters<typeof statement.run>) => {
          const competitor = new DatabaseSync(dbPath);
          try {
            const claimed = competitor
              .prepare(
                `UPDATE relay_jobs
                 SET delivery_owner_pid = ?,
                     delivery_owner_token = ?,
                     delivery_lease_expires_at = ?
                 WHERE id = 'startup-race'
                   AND delivery_status = 'delivering'
                   AND delivery_owner_token IS ?
                   AND delivery_lease_expires_at IS ?`,
              )
              .run(process.pid, competitorToken, competitorLease, staleToken, expiredLease);
            expect(claimed.changes).toBe(1);
            externalSendCount += 1;
          } finally {
            competitor.close();
          }
          return originalRun(...args);
        },
      });
    };

    const queue = new RelayQueue({
      dbPath,
      targets: { fable: target },
      isBusy: () => false,
      execute: async () => "unused",
      deliver: async () => {
        externalSendCount += 1;
      },
      busyPollMs: 5,
    });
    Object.defineProperty(DatabaseSync.prototype, "prepare", prepareDescriptor);
    queue.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(externalSendCount).toBe(1);
      expect(queue.get("startup-race")?.deliveryStatus).toBe("delivering");
    } finally {
      await queue.close();
    }
  });

  it("reclaims delivery after a stale lease and dead owner", async () => {
    const dbPath = tempDb();
    const target = {
      hostId: "pi-lhc",
      threadId: "th_fable",
      cwd: "/tmp",
      command: "unused",
      args: [],
    };
    const seed = new DatabaseSync(dbPath);
    seed.exec(`
      CREATE TABLE relay_jobs (
        id TEXT PRIMARY KEY, target TEXT NOT NULL, prompt TEXT NOT NULL,
        status TEXT NOT NULL, output TEXT, error TEXT, created_at TEXT NOT NULL,
        started_at TEXT, finished_at TEXT, notify TEXT, delivery_status TEXT,
        delivery_error TEXT, owner_pid INTEGER, delivery_channel TEXT,
        delivery_destination TEXT, delivery_metadata TEXT, delivery_owner_pid INTEGER,
        delivery_owner_token TEXT, delivery_lease_expires_at TEXT,
        failure_fallback_applied INTEGER NOT NULL DEFAULT 0
      )
    `);
    const now = new Date().toISOString();
    seed
      .prepare(
        `INSERT INTO relay_jobs
         (id, target, prompt, status, output, created_at, finished_at, delivery_status,
          delivery_channel, delivery_destination, delivery_owner_pid, delivery_owner_token,
          delivery_lease_expires_at, failure_fallback_applied)
         VALUES (?, ?, ?, 'completed', ?, ?, ?, 'delivering', ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        "stale-delivery",
        "fable",
        "hello",
        "saved reply",
        now,
        now,
        "photon",
        JSON.stringify({ spaceId: "chat-1" }),
        999_999_999,
        "dead-owner",
        new Date(Date.now() - 60_000).toISOString(),
      );
    seed.close();

    let sends = 0;
    const queue = createQueue({
      dbPath,
      targets: { fable: target },
      isBusy: () => false,
      execute: async () => "unused",
      deliver: async () => {
        sends += 1;
      },
      busyPollMs: 5,
    });
    try {
      await expect
        .poll(() => queue.get("stale-delivery")?.deliveryStatus, { timeout: 1_000 })
        .toBe("delivered");
      expect(sends).toBe(1);
    } finally {
      await queue.close();
    }
  });

  it("survives restart when group wake fallback cannot append to a full backlog", async () => {
    const previousLimit = process.env.LHC_PHOTON_MAX_BACKLOG_MESSAGES;
    process.env.LHC_PHOTON_MAX_BACKLOG_MESSAGES = "1";
    try {
      const dir = mkdtempSync(join(tmpdir(), "lhc-console-relay-fallback-full-"));
      dirs.push(dir);
      mkdirSync(join(dir, "agents", "fable"), { recursive: true });
      const dbPath = join(dir, "relay.sqlite");
      const catchUpPath = join(dir, "agents", "fable", "group-catch-up.sqlite");
      const catchUp = new GroupCatchUpStore(catchUpPath, { maxBacklogMessages: 1 });
      catchUp.append("chat-guid-group", {
        messageId: "existing-1",
        senderId: "+15550000001",
        text: "one",
        timestamp: "2026-01-01T00:00:00.000Z",
        senderAuthorized: true,
      });
      const target = {
        hostId: "pi-lhc",
        threadId: "th_fable",
        cwd: "/tmp",
        command: "unused",
        args: [],
      };
      const metadata = {
        kind: "photon_group_wake" as const,
        spaceId: "chat-guid-group",
        wakeMessageId: "wake-1",
        consumedIds: [] as string[],
        fallback: {
          messageId: "wake-1",
          senderId: "+15551234567",
          text: "wake text",
          timestamp: "2026-01-01T00:00:01.000Z",
        },
      };
      const rejections: unknown[] = [];
      const onRejection = (reason: unknown) => {
        rejections.push(reason);
      };
      process.on("unhandledRejection", onRejection);
      const queue = createQueue({
        dbPath,
        targets: { fable: target },
        isBusy: () => false,
        execute: async () => {
          throw new Error("turn failed");
        },
        consoleHome: dir,
        busyPollMs: 5,
      });
      const submitted = queue.enqueue({
        target: "fable",
        prompt: "wake",
        delivery: {
          channel: "photon",
          destination: { spaceId: "chat-guid-group" },
          metadata,
        },
      });
      await queue.wait(submitted.id);
      expect(queue.get(submitted.id)?.status).toBe("failed");
      expect(failureFallbackApplied(dbPath, submitted.id)).toBe(0);
      expect(catchUp.pendingMessageIds("chat-guid-group")).toEqual(["existing-1"]);
      await queue.close();

      const restarted = createQueue({
        dbPath,
        targets: { fable: target },
        isBusy: () => false,
        execute: async () => "unused",
        consoleHome: dir,
        busyPollMs: 5,
      });
      expect(failureFallbackApplied(dbPath, submitted.id)).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, DELIVERY_RETRY_BASE_MS + 50));
      expect(failureFallbackApplied(dbPath, submitted.id)).toBe(0);
      expect(catchUp.pendingMessageIds("chat-guid-group")).toEqual(["existing-1"]);
      expect(rejections).toEqual([]);
      process.off("unhandledRejection", onRejection);
      await restarted.close();
    } finally {
      if (previousLimit === undefined) delete process.env.LHC_PHOTON_MAX_BACKLOG_MESSAGES;
      else process.env.LHC_PHOTON_MAX_BACKLOG_MESSAGES = previousLimit;
    }
  });

  it("applies durable group wake fallback on relay failure and survives restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-console-relay-fallback-"));
    dirs.push(dir);
    mkdirSync(join(dir, "agents", "fable"), { recursive: true });
    const dbPath = join(dir, "relay.sqlite");
    const target = {
      hostId: "pi-lhc",
      threadId: "th_fable",
      cwd: "/tmp",
      command: "unused",
      args: [],
    };
    const metadata = {
      kind: "photon_group_wake" as const,
      spaceId: "chat-guid-group",
      wakeMessageId: "wake-1",
      consumedIds: [] as string[],
      fallback: {
        messageId: "wake-1",
        senderId: "+15551234567",
        text: "wake text",
        timestamp: "2026-01-01T00:00:00.000Z",
      },
    };
    const queue = createQueue({
      dbPath,
      targets: { fable: target },
      isBusy: () => false,
      execute: async () => {
        throw new Error("turn failed");
      },
      consoleHome: dir,
      busyPollMs: 5,
    });
    const submitted = queue.enqueue({
      target: "fable",
      prompt: "wake",
      delivery: {
        channel: "photon",
        destination: { spaceId: "chat-guid-group" },
        metadata,
      },
    });
    await queue.wait(submitted.id);
    expect(queue.get(submitted.id)?.status).toBe("failed");
    const catchUp = new GroupCatchUpStore(join(dir, "agents", "fable", "group-catch-up.sqlite"));
    const snapshot = catchUp.readWakeSnapshot("chat-guid-group");
    expect(snapshot[0]).toContain("wake text");
    await queue.close();

    const restarted = createQueue({
      dbPath,
      targets: { fable: target },
      isBusy: () => false,
      execute: async () => "unused",
      consoleHome: dir,
      busyPollMs: 5,
    });
    const before = catchUp.readWakeSnapshot("chat-guid-group")[0];
    await new Promise((resolve) => setTimeout(resolve, 50));
    const after = catchUp.readWakeSnapshot("chat-guid-group")[0];
    expect(after).toBe(before);
    await restarted.close();
  });
});

const leeTarget = {
  hostId: "lee",
  threadId: "lee",
  cwd: "/tmp",
  command: "unused",
  args: [],
};

describe("RelayQueue outbound lee jobs", () => {
  it("does not execute an agent turn for outbound lee jobs", async () => {
    let executed = 0;
    const delivered: string[] = [];
    const queue = createQueue({
      dbPath: tempDb(),
      targets: { lee: leeTarget },
      isBusy: () => false,
      execute: async () => {
        executed += 1;
        return "unused";
      },
      deliver: async (job) => {
        delivered.push(job.output ?? "");
      },
    });
    try {
      const submitted = queue.enqueue({
        target: "lee",
        prompt: "ping",
        jobKind: "outbound",
        sender: "fable",
        delivery: {
          channel: "photon",
          destination: { spaceId: "fable-home" },
          metadata: { kind: "outbound_lee", senderAgentId: "fable", connectorAgentId: "fable" },
        },
      });
      const settled = await queue.wait(submitted.id);
      await expect.poll(() => queue.get(submitted.id)?.deliveryStatus).toBe("delivered");
      expect(executed).toBe(0);
      expect(settled.status).toBe("completed");
      expect(delivered).toEqual(["ping"]);
    } finally {
      await queue.close();
    }
  });

  it("settles outbound jobs only after delivery succeeds or definitively fails", async () => {
    let attempts = 0;
    const queue = createQueue({
      dbPath: tempDb(),
      targets: { lee: leeTarget },
      isBusy: () => false,
      execute: async () => "unused",
      deliver: async () => {
        attempts += 1;
        if (attempts < 2) throw new Error("temporary send failure");
      },
      busyPollMs: 5,
    });
    try {
      const submitted = queue.enqueue({
        target: "lee",
        prompt: "retry me",
        jobKind: "outbound",
        sender: "fable",
        delivery: {
          channel: "photon",
          destination: { spaceId: "fable-home" },
          metadata: { kind: "outbound_lee", senderAgentId: "fable", connectorAgentId: "fable" },
        },
      });
      const pending = queue.get(submitted.id);
      expect(pending?.status).not.toBe("failed");
      const settled = await queue.wait(submitted.id);
      await expect
        .poll(() => queue.get(submitted.id)?.deliveryStatus, { timeout: 2_000 })
        .toBe("delivered");
      expect(attempts).toBeGreaterThanOrEqual(2);
      expect(settled.deliveryStatus).toBe("delivered");
    } finally {
      await queue.close();
    }
  });

  it("retries outbound delivery after restart until delivery settles", async () => {
    const dbPath = tempDb();
    let attempts = 0;
    const first = createQueue({
      dbPath,
      targets: { lee: leeTarget },
      isBusy: () => false,
      execute: async () => "unused",
      deliver: async () => {
        attempts += 1;
        throw new Error("send failed");
      },
      busyPollMs: 5,
    });
    const submitted = first.enqueue({
      target: "lee",
      prompt: "after restart",
      jobKind: "outbound",
      sender: "fable",
      delivery: {
        channel: "photon",
        destination: { spaceId: "fable-home" },
        metadata: { kind: "outbound_lee", senderAgentId: "fable", connectorAgentId: "fable" },
      },
    });
    await expect
      .poll(() => first.get(submitted.id)?.deliveryStatus, { timeout: 1_000 })
      .toBe("failed");
    await first.close();

    attempts = 0;
    const second = createQueue({
      dbPath,
      targets: { lee: leeTarget },
      isBusy: () => false,
      execute: async () => "unused",
      deliver: async (job) => {
        attempts += 1;
        expect(job.output).toBe("after restart");
      },
      busyPollMs: 5,
    });
    try {
      const settled = await second.wait(submitted.id);
      await expect
        .poll(() => second.get(submitted.id)?.deliveryStatus, { timeout: 2_000 })
        .toBe("delivered");
      expect(attempts).toBeGreaterThanOrEqual(1);
      expect(settled.deliveryStatus).toBe("delivered");
    } finally {
      await second.close();
    }
  });

  it("keeps prioritized ordinary agent jobs ahead of deprioritized work", async () => {
    const calls: string[] = [];
    const queue = createQueue({
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
      execute: async (_target, prompt) => {
        calls.push(prompt);
        return `reply:${prompt}`;
      },
      busyPollMs: 5,
    });
    try {
      queue.enqueue({ target: "fable", prompt: "slow", jobClass: "deprioritized" });
      queue.enqueue({ target: "fable", prompt: "urgent", jobClass: "prioritized" });
      await expect.poll(() => calls, { timeout: 1_000 }).toEqual(["urgent", "slow"]);
    } finally {
      await queue.close();
    }
  });
});
