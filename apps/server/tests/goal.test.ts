import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { GoalService } from "../src/goal.ts";
import { migrateLegacyGoalsOffline } from "../src/goal-migrate.ts";
import { RelayQueue } from "../src/relay.ts";
import type { RelayJobStatus } from "../src/relay.ts";

const dirs: string[] = [];
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
  await Promise.all(queues.splice(0).map((queue) => queue.close()));
  await Promise.all(services.splice(0).map((service) => service.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function relayDbPath(dir: string): string {
  return join(dir, "relay.sqlite");
}

function makeQueue(
  dir: string,
  options: {
    isBusy?: () => boolean | Promise<boolean>;
    execute?: ConstructorParameters<typeof RelayQueue>[0]["execute"];
    busyPollMs?: number;
  } = {},
): RelayQueue {
  const queue = new RelayQueue({
    dbPath: relayDbPath(dir),
    targets: { fable: relayTarget },
    isBusy: options.isBusy ?? (() => false),
    execute:
      options.execute ??
      (async (_target, prompt) => {
        return `reply:${prompt.length}`;
      }),
    busyPollMs: options.busyPollMs ?? 5,
  });
  queue.start();
  queues.push(queue);
  return queue;
}

function makeService(
  dir: string,
  queue: RelayQueue,
  options: {
    cadenceMs?: number;
    pollMs?: number;
    now?: () => number;
    idFactory?: () => string;
  } = {},
): GoalService {
  const service = new GoalService({
    dbPath: relayDbPath(dir),
    relayQueue: queue,
    pollMs: options.pollMs ?? 5,
    defaultCadenceMs: options.cadenceMs ?? 60_000,
    now: options.now,
    idFactory: options.idFactory,
    targetExists: (target) => target === "fable",
  });
  services.push(service);
  return service;
}

function wireGoalSettledListener(service: GoalService, queue: RelayQueue): void {
  queue.addSettledListener((job) => service.notifyJobSettled(job));
}

function setupRelayIntegration(options: { cadenceMs?: number; pollMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lhc-console-goal-relay-"));
  dirs.push(dir);
  let now = 0;
  const calls: string[] = [];
  const queue = makeQueue(dir, {
    execute: async (_target, prompt) => {
      calls.push(prompt);
      return `reply:${prompt.length}`;
    },
  });
  const service = makeService(dir, queue, {
    cadenceMs: options.cadenceMs,
    pollMs: options.pollMs,
    now: () => now,
  });
  wireGoalSettledListener(service, queue);
  return {
    dir,
    service,
    queue,
    calls,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function setup(
  options: {
    pollMs?: number;
    cadenceMs?: number;
    holdJobs?: boolean;
    holdExecute?: boolean;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "lhc-console-goal-"));
  dirs.push(dir);
  let now = 0;
  let hold = options.holdJobs ?? true;
  let releaseExecute: (() => void) | undefined;
  const queue = makeQueue(dir, {
    isBusy: () => hold,
    execute:
      options.holdExecute === false
        ? async (_target, prompt) => `reply:${prompt.length}`
        : async () => {
            await new Promise<void>((resolve) => {
              releaseExecute = resolve;
            });
            return "ok";
          },
  });
  const service = makeService(dir, queue, {
    pollMs: options.pollMs ?? 5,
    cadenceMs: options.cadenceMs ?? 60_000,
    now: () => now,
  });
  wireGoalSettledListener(service, queue);
  return {
    dir,
    service,
    queue,
    releaseJobs: () => {
      hold = false;
      queue.pokeSchedule("fable");
      releaseExecute?.();
      releaseExecute = undefined;
    },
    setHold: (value: boolean) => {
      hold = value;
    },
    advance: (ms: number) => {
      now += ms;
    },
    setJobStatus: (id: string, status: RelayJobStatus) => {
      const db = new DatabaseSync(relayDbPath(dir));
      try {
        const finishedAt =
          status === "queued" || status === "running" ? null : new Date(now).toISOString();
        db.prepare("UPDATE relay_jobs SET status = ?, finished_at = ? WHERE id = ?").run(
          status,
          finishedAt,
          id,
        );
      } finally {
        db.close();
      }
      const job = queue.get(id);
      if (job && (status === "completed" || status === "failed")) {
        service.notifyJobSettled({ id, status });
      }
    },
    countQueuedReminders: () => {
      const db = new DatabaseSync(relayDbPath(dir));
      try {
        const row = db
          .prepare(
            `SELECT COUNT(*) AS count FROM relay_jobs
             WHERE target = 'fable' AND status IN ('queued', 'blocked', 'running')`,
          )
          .get() as { count: number };
        return row.count;
      } finally {
        db.close();
      }
    },
  };
}

describe("GoalService", () => {
  it("creates a goal and immediately enqueues one prioritized reminder", () => {
    const { service, queue } = setup();
    const goal = service.create({ target: "fable", objective: "Ship the feature" });
    expect(goal).toMatchObject({
      target: "fable",
      objective: "Ship the feature",
      state: "active",
      cadenceMs: 60_000,
      reminderJobId: goal.reminderJobId,
    });
    const job = queue.get(goal.reminderJobId!);
    expect(job).toMatchObject({
      target: "fable",
      jobClass: "prioritized",
      status: "queued",
    });
    expect(job?.prompt).toContain("[LHC system goal reminder]");
    expect(job?.prompt).toContain(goal.id);
    expect(job?.prompt).toContain("Ship the feature");
    expect(job?.prompt).toContain("lhc-agent goal done");
  });

  it("never stacks more than one unsettled reminder for a goal", async () => {
    const { service, queue, setJobStatus, countQueuedReminders, releaseJobs } = setup({
      cadenceMs: 100,
      holdExecute: true,
    });
    const goal = service.create({ target: "fable", objective: "Keep going" });
    service.start();
    releaseJobs();
    await expect
      .poll(
        () => {
          const status = queue.get(goal.reminderJobId!)?.status;
          return status !== undefined && status !== "queued";
        },
        { timeout: 250 },
      )
      .toBe(true);
    setJobStatus(goal.reminderJobId!, "running");
    service.tick();
    expect(countQueuedReminders()).toBe(1);
    setJobStatus(goal.reminderJobId!, "completed");
    service.tick();
    expect(countQueuedReminders()).toBe(0);
  });

  it("schedules the next reminder only after cadence once the previous reminder settles", async () => {
    const { service, queue, advance, releaseJobs, setHold } = setup({
      cadenceMs: 100,
      pollMs: 5,
      holdJobs: true,
      holdExecute: false,
    });
    const goal = service.create({ target: "fable", objective: "Cadence check" });
    releaseJobs();
    await expect
      .poll(() => queue.get(goal.reminderJobId!)?.status === "completed", { timeout: 250 })
      .toBe(true);
    service.notifyJobSettled({ id: goal.reminderJobId!, status: "completed" });
    setHold(true);
    advance(50);
    expect(service.get(goal.id)).toMatchObject({
      reminderJobId: null,
      nextReminderAt: new Date(100).toISOString(),
    });
    advance(60);
    service.tick();
    expect(service.get(goal.id)?.reminderJobId).not.toBeNull();
    setHold(false);
    queue.pokeSchedule("fable");
    const nextId = service.get(goal.id)?.reminderJobId;
    expect(nextId).not.toBe(goal.reminderJobId);
    expect(queue.get(nextId!)?.status).toBe("queued");
  });

  it("recovers due reminders after restart without stacking", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-console-goal-restart-"));
    dirs.push(dir);
    let now = 0;
    const queue = makeQueue(dir);
    const first = makeService(dir, queue, { cadenceMs: 100, pollMs: 5, now: () => now });
    const goal = first.create({ target: "fable", objective: "Restart me" });
    const firstJobId = goal.reminderJobId!;
    const db = new DatabaseSync(relayDbPath(dir));
    db.prepare("UPDATE relay_jobs SET status = 'completed', finished_at = ? WHERE id = ?").run(
      new Date(now).toISOString(),
      firstJobId,
    );
    db.close();
    first.notifyJobSettled({ id: firstJobId, status: "completed" });
    now += 150;
    await first.close();
    services.splice(services.indexOf(first), 1);
    await queue.close();
    queues.splice(queues.indexOf(queue), 1);

    const restartedQueue = makeQueue(dir);
    const second = makeService(dir, restartedQueue, { cadenceMs: 100, pollMs: 5, now: () => now });
    second.start();
    await expect.poll(() => second.get(goal.id)?.reminderJobId, { timeout: 250 }).not.toBeNull();
    expect(second.get(goal.id)?.reminderJobId).not.toBe(firstJobId);
  });

  it("does not persist a goal when reminder insertion fails atomically", () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-console-goal-enqueue-crash-"));
    dirs.push(dir);
    const queue = makeQueue(dir);
    const blockedId = randomUUID();
    const db = new DatabaseSync(relayDbPath(dir));
    db.prepare("INSERT INTO relay_cancelled_jobs (id, cancelled_at) VALUES (?, ?)").run(
      blockedId,
      new Date().toISOString(),
    );
    db.close();

    let call = 0;
    const service = makeService(dir, queue, {
      idFactory: () => {
        call += 1;
        return call === 1 ? blockedId : randomUUID();
      },
    });
    expect(() => service.create({ target: "fable", objective: "Recover enqueue" })).toThrow(
      /cancelled/,
    );
    expect(service.list()).toHaveLength(0);
  });

  it("recovers a reminder that settled while the goal service was offline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-console-goal-offline-settle-"));
    dirs.push(dir);
    let now = 0;
    const queue = makeQueue(dir);
    const first = makeService(dir, queue, { cadenceMs: 100, pollMs: 5, now: () => now });
    const goal = first.create({ target: "fable", objective: "Recover settlement" });
    await first.close();
    services.splice(services.indexOf(first), 1);

    const db = new DatabaseSync(relayDbPath(dir));
    db.prepare("UPDATE relay_jobs SET status = 'completed', finished_at = ? WHERE id = ?").run(
      new Date(now).toISOString(),
      goal.reminderJobId!,
    );
    db.close();
    now = 50;
    const second = makeService(dir, queue, { cadenceMs: 100, pollMs: 5, now: () => now });
    second.start();

    expect(second.get(goal.id)).toMatchObject({
      reminderJobId: null,
      nextReminderAt: new Date(150).toISOString(),
    });
    now = 160;
    second.tick();
    await expect.poll(() => second.get(goal.id)?.reminderJobId, { timeout: 250 }).not.toBeNull();
    expect(second.get(goal.id)?.reminderJobId).not.toBe(goal.reminderJobId);
  });

  it("allows only one instance to schedule a due reminder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-console-goal-multi-"));
    dirs.push(dir);
    let now = 0;
    const queue = makeQueue(dir);
    const options = {
      cadenceMs: 100,
      pollMs: 5,
      now: () => now,
    };
    const first = makeService(dir, queue, options);
    const second = makeService(dir, queue, options);
    const goal = first.create({ target: "fable", objective: "Single scheduler" });
    first.notifyJobSettled({ id: goal.reminderJobId!, status: "completed" });
    now = 200;
    first.start();
    second.start();
    await expect.poll(() => second.get(goal.id)?.reminderJobId, { timeout: 250 }).not.toBeNull();
    const db = new DatabaseSync(relayDbPath(dir));
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count FROM relay_jobs
         WHERE target = 'fable' AND id != ? AND status IN ('queued', 'blocked', 'running')`,
      )
      .get(goal.reminderJobId!) as { count: number };
    db.close();
    expect(row.count).toBe(1);
  });

  it("stops future reminders when a goal is completed, blocked, or cancelled", async () => {
    const { service, queue, setJobStatus, advance, releaseJobs } = setup({
      cadenceMs: 50,
      pollMs: 5,
      holdJobs: true,
      holdExecute: false,
    });
    const goal = service.create({ target: "fable", objective: "Finish line" });
    const initialCount = 1;
    service.start();
    releaseJobs();
    await expect
      .poll(() => queue.get(goal.reminderJobId!)?.status === "completed", { timeout: 250 })
      .toBe(true);
    setJobStatus(goal.reminderJobId!, "completed");
    service.complete(goal.id);
    advance(200);
    service.tick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const db = new DatabaseSync(relayDbPath(dirs[dirs.length - 1]!));
    const afterComplete = db
      .prepare("SELECT COUNT(*) AS count FROM relay_jobs WHERE target = 'fable'")
      .get() as { count: number };
    db.close();
    expect(afterComplete.count).toBe(initialCount);
    expect(service.get(goal.id)?.state).toBe("completed");

    const blocked = service.create({ target: "fable", objective: "Blocked path" });
    await expect
      .poll(() => queue.get(blocked.reminderJobId!)?.status === "completed", { timeout: 250 })
      .toBe(true);
    setJobStatus(blocked.reminderJobId!, "completed");
    service.block(blocked.id, "waiting on dependency");
    advance(200);
    service.tick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(service.get(blocked.id)).toMatchObject({
      state: "blocked",
      blockedReason: "waiting on dependency",
    });

    const cancelled = service.create({ target: "fable", objective: "Never mind" });
    service.cancel(cancelled.id);
    advance(200);
    service.tick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(service.get(cancelled.id)?.state).toBe("cancelled");
    expect(queue.get(cancelled.reminderJobId!)?.status).toBe("cancelled");
  });

  it("fences a queued relay reminder when a goal reaches a terminal state", async () => {
    const { service, queue, calls } = setupRelayIntegration();
    const goal = service.create({ target: "fable", objective: "Fence me" });
    service.complete(goal.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toEqual([]);
    expect(queue.get(goal.reminderJobId!)?.status).toBe("cancelled");
  });

  it("never runs a fenced reminder after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-console-goal-fence-restart-"));
    dirs.push(dir);
    const calls: string[] = [];
    const queue = makeQueue(dir, {
      execute: async (_target, prompt) => {
        calls.push(prompt);
        return "ok";
      },
    });
    const first = makeService(dir, queue);
    const goal = first.create({ target: "fable", objective: "Persist fence" });
    first.cancel(goal.id);
    await first.stop();
    services.splice(services.indexOf(first), 1);
    await queue.close();
    queues.splice(queues.indexOf(queue), 1);

    const restartedQueue = makeQueue(dir, {
      execute: async (_target, prompt) => {
        calls.push(prompt);
        return "ok";
      },
    });
    const restarted = makeService(dir, restartedQueue);
    restarted.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toEqual([]);
    expect(restartedQueue.get(goal.reminderJobId!)?.status).toBe("cancelled");
  });

  it("wins the race when a goal completes while its reminder is still queued", async () => {
    let release: (() => void) | undefined;
    const dir = mkdtempSync(join(tmpdir(), "lhc-console-goal-terminal-race-"));
    dirs.push(dir);
    const calls: string[] = [];
    const queue = makeQueue(dir, {
      execute: async (_target, prompt) => {
        calls.push(prompt);
        if (prompt.includes("Fence race")) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return "ok";
      },
    });
    const service = makeService(dir, queue, { cadenceMs: 50, pollMs: 5 });
    const goal = service.create({ target: "fable", objective: "Fence race" });
    service.start();
    await expect.poll(() => queue.get(goal.reminderJobId!)?.status).toBe("running");
    service.complete(goal.id);
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(queue.get(goal.reminderJobId!)?.status).toBe("completed");
    service.tick();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toHaveLength(1);
    expect(service.get(goal.id)?.reminderJobId).toBe(goal.reminderJobId);
  });

  it("drains relay before closing goal settlement handling", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-console-goal-shutdown-"));
    dirs.push(dir);
    const settled: string[] = [];
    const queue = makeQueue(dir, { execute: async () => "ok" });
    const service = makeService(dir, queue, { cadenceMs: 60_000, pollMs: 5 });
    const removeListener = queue.addSettledListener((job) => {
      settled.push(job.id);
      service.notifyJobSettled(job);
    });
    service.start();
    const goal = service.create({ target: "fable", objective: "Shutdown order" });
    await service.stop();
    const job = await queue.wait(goal.reminderJobId!);
    expect(job.status).toBe("completed");
    removeListener();
    await service.close();
    expect(settled).toContain(goal.reminderJobId);
  });

  it("atomically creates goal and relay job or neither on reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-console-goal-create-atomic-"));
    dirs.push(dir);
    const queue = makeQueue(dir);
    const service = makeService(dir, queue);
    const goal = service.create({ target: "fable", objective: "Atomic create" });
    const db = new DatabaseSync(relayDbPath(dir));
    const goalRow = db.prepare("SELECT id FROM goals WHERE id = ?").get(goal.id);
    const jobRow = db.prepare("SELECT id FROM relay_jobs WHERE id = ?").get(goal.reminderJobId!);
    db.close();
    expect(goalRow).toBeTruthy();
    expect(jobRow).toBeTruthy();
  });

  it("atomically fences terminal state and tombstone across reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-console-goal-terminal-atomic-"));
    dirs.push(dir);
    const queue = makeQueue(dir);
    const first = makeService(dir, queue);
    const goal = first.create({ target: "fable", objective: "Terminal atomic" });
    first.cancel(goal.id);
    await first.close();
    services.splice(services.indexOf(first), 1);
    await queue.close();
    queues.splice(queues.indexOf(queue), 1);

    const db = new DatabaseSync(relayDbPath(dir));
    const tombstone = db
      .prepare("SELECT id FROM relay_cancelled_jobs WHERE id = ?")
      .get(goal.reminderJobId!);
    const goalRow = db.prepare("SELECT state FROM goals WHERE id = ?").get(goal.id) as {
      state: string;
    };
    db.close();
    expect(tombstone).toBeTruthy();
    expect(goalRow.state).toBe("cancelled");

    const restartedQueue = makeQueue(dir);
    const restarted = makeService(dir, restartedQueue);
    restarted.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(restartedQueue.get(goal.reminderJobId!)?.status).toBe("cancelled");
  });

  it("terminal transition racing due scheduling cannot leave an executable reminder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-console-goal-terminal-due-race-"));
    dirs.push(dir);
    let now = 0;
    let hold = true;
    const calls: string[] = [];
    const queue = makeQueue(dir, {
      isBusy: () => hold,
      execute: async (_target, prompt) => {
        calls.push(prompt);
        return "ok";
      },
    });
    const first = makeService(dir, queue, { cadenceMs: 100, pollMs: 5, now: () => now });
    const second = makeService(dir, queue, { cadenceMs: 100, pollMs: 5, now: () => now });
    const goal = first.create({ target: "fable", objective: "Race due" });
    const dbBefore = new DatabaseSync(relayDbPath(dir));
    dbBefore
      .prepare("UPDATE relay_jobs SET status = 'completed', finished_at = ? WHERE id = ?")
      .run(new Date(now).toISOString(), goal.reminderJobId!);
    dbBefore.close();
    first.notifyJobSettled({ id: goal.reminderJobId!, status: "completed" });
    now = 200;
    first.start();
    second.start();
    first.complete(goal.id);
    hold = false;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const db = new DatabaseSync(relayDbPath(dir));
    const executable = db
      .prepare(
        `SELECT COUNT(*) AS count FROM relay_jobs
         WHERE target = 'fable'
           AND status IN ('queued', 'blocked', 'running')
           AND NOT EXISTS (
             SELECT 1 FROM relay_cancelled_jobs AS c WHERE c.id = relay_jobs.id
           )`,
      )
      .get() as { count: number };
    db.close();
    expect(executable.count).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("migrates legacy goals.sqlite into relay.sqlite without duplicating rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-console-goal-legacy-migrate-"));
    dirs.push(dir);
    const legacyPath = join(dir, "goals.sqlite");
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(`
      CREATE TABLE goals (
        id TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        objective TEXT NOT NULL,
        state TEXT NOT NULL,
        cadence_ms INTEGER NOT NULL,
        reminder_job_id TEXT,
        next_reminder_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        blocked_reason TEXT
      );
      INSERT INTO goals VALUES (
        'legacy-goal', 'fable', 'Legacy objective', 'active', 60000,
        NULL, NULL, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', NULL
      );
    `);
    legacy.close();

    migrateLegacyGoalsOffline({
      consoleHome: dir,
      relayDbPath: relayDbPath(dir),
      targetExists: (target) => target === "fable",
      acknowledgeOffline: true,
      now: () => 1,
    });
    const queue = makeQueue(dir);
    const service = makeService(dir, queue);
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(join(dir, "goals-retired"))).toBe(true);
    expect(service.get("legacy-goal")).toMatchObject({
      objective: "Legacy objective",
      state: "active",
    });
    expect(service.list().filter((g) => g.id === "legacy-goal")).toHaveLength(1);
    const recoveredId = service.get("legacy-goal")?.reminderJobId;
    expect(recoveredId).toBeTruthy();
    expect(queue.get(recoveredId!)).toMatchObject({
      target: "fable",
      status: "queued",
      jobClass: "prioritized",
    });
  });

  it("allows only one instance to recover an active goal with no reminder state", () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-console-goal-null-recovery-"));
    dirs.push(dir);
    const queue = makeQueue(dir);
    const unrelated = queue.enqueue({
      target: "fable",
      prompt: "an unrelated cancelled job mentioning orphan-goal",
    });
    queue.cancelJob(unrelated.id);
    const seed = makeService(dir, queue);
    const db = new DatabaseSync(relayDbPath(dir));
    db.prepare(
      `INSERT INTO goals
       (id, target, objective, state, cadence_ms, reminder_job_id, next_reminder_at,
        created_at, updated_at, blocked_reason)
       VALUES ('orphan-goal', 'fable', 'Recover me', 'active', 60000, NULL, NULL, ?, ?, NULL)`,
    ).run("2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z");
    db.close();

    seed.tick();
    const second = makeService(dir, queue);
    second.tick();

    const recovered = seed.get("orphan-goal");
    expect(recovered?.reminderJobId).toBeTruthy();
    const verify = new DatabaseSync(relayDbPath(dir));
    const jobs = verify
      .prepare(
        `SELECT COUNT(*) AS count FROM relay_jobs
         WHERE prompt LIKE '%orphan-goal%'
           AND NOT EXISTS (
             SELECT 1 FROM relay_cancelled_jobs AS c WHERE c.id = relay_jobs.id
           )`,
      )
      .get() as { count: number };
    verify.close();
    expect(jobs.count).toBe(1);
  });

  it("fences terminal legacy reminders and preserves tombstoned active goals as cancelled", () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-console-goal-legacy-fence-"));
    dirs.push(dir);
    const queue = new RelayQueue({
      dbPath: relayDbPath(dir),
      targets: { fable: relayTarget },
      isBusy: () => false,
      execute: async () => "must not run",
      busyPollMs: 5,
    });
    queues.push(queue);
    queue.enqueue({
      id: "terminal-reminder",
      target: "fable",
      prompt: "terminal reminder",
      jobClass: "prioritized",
    });
    queue.cancelJob("stale-active-reminder");

    const legacyPath = join(dir, "goals.sqlite");
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(`
      CREATE TABLE goals (
        id TEXT PRIMARY KEY, target TEXT NOT NULL, objective TEXT NOT NULL,
        state TEXT NOT NULL, cadence_ms INTEGER NOT NULL, reminder_job_id TEXT,
        next_reminder_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        blocked_reason TEXT
      );
      INSERT INTO goals VALUES
        ('terminal-goal', 'fable', 'Already done', 'completed', 60000,
         'terminal-reminder', NULL, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', NULL),
        ('stale-active-goal', 'fable', 'Stale active', 'active', 60000,
         'stale-active-reminder', NULL, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', NULL);
    `);
    legacy.close();

    migrateLegacyGoalsOffline({
      consoleHome: dir,
      relayDbPath: relayDbPath(dir),
      targetExists: (target) => target === "fable",
      acknowledgeOffline: true,
      now: () => 1,
    });
    const service = makeService(dir, queue);
    expect(queue.get("terminal-reminder")?.status).toBe("cancelled");
    expect(service.get("terminal-goal")?.state).toBe("completed");
    expect(service.get("stale-active-goal")?.state).toBe("cancelled");
  });

  it("recovers from transient notifyJobSettled failure without duplicate reminders", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-console-goal-notify-retry-"));
    dirs.push(dir);
    let now = 0;
    let failNotify = true;
    let hold = false;
    const queue = makeQueue(dir, { isBusy: () => hold });
    const service = makeService(dir, queue, { cadenceMs: 100, pollMs: 5, now: () => now });
    const originalNotify = service.notifyJobSettled.bind(service);
    service.notifyJobSettled = (job) => {
      if (failNotify) throw new Error("simulated notify db failure");
      originalNotify(job);
    };
    const goal = service.create({ target: "fable", objective: "Notify retry" });
    service.start();
    const db = new DatabaseSync(relayDbPath(dir));
    db.prepare("UPDATE relay_jobs SET status = 'completed', finished_at = ? WHERE id = ?").run(
      new Date(now).toISOString(),
      goal.reminderJobId!,
    );
    db.close();
    service.tick();
    expect(service.get(goal.id)?.reminderJobId).toBe(goal.reminderJobId);
    failNotify = false;
    now = 100;
    service.tick();
    await expect.poll(() => service.get(goal.id)?.reminderJobId, { timeout: 250 }).toBeNull();
    hold = true;
    now = 300;
    service.tick();
    await expect.poll(() => service.get(goal.id)?.reminderJobId, { timeout: 250 }).not.toBeNull();
    const db2 = new DatabaseSync(relayDbPath(dir));
    const reminderCount = db2
      .prepare(
        `SELECT COUNT(*) AS count FROM relay_jobs
         WHERE target = 'fable' AND status IN ('queued', 'blocked', 'running')`,
      )
      .get() as { count: number };
    db2.close();
    expect(reminderCount.count).toBe(1);
  });

  it("recovers from transient poke failure without duplicate reminders", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-console-goal-poke-retry-"));
    dirs.push(dir);
    let now = 0;
    let failPoke = false;
    let hold = true;
    const queue = makeQueue(dir, {
      isBusy: () => hold,
    });
    const originalPoke = queue.pokeSchedule.bind(queue);
    queue.pokeSchedule = (target: string) => {
      if (failPoke) throw new Error("simulated poke failure");
      originalPoke(target);
    };
    const service = makeService(dir, queue, { cadenceMs: 100, pollMs: 5, now: () => now });
    const goal = service.create({ target: "fable", objective: "Poke retry" });
    const db0 = new DatabaseSync(relayDbPath(dir));
    db0
      .prepare("UPDATE relay_jobs SET status = 'completed', finished_at = ? WHERE id = ?")
      .run(new Date(now).toISOString(), goal.reminderJobId!);
    db0.close();
    service.notifyJobSettled({ id: goal.reminderJobId!, status: "completed" });
    now = 200;
    failPoke = true;
    service.start();
    await expect.poll(() => service.get(goal.id)?.reminderJobId, { timeout: 250 }).not.toBeNull();
    const db = new DatabaseSync(relayDbPath(dir));
    const pending = db
      .prepare(
        `SELECT COUNT(*) AS count FROM relay_jobs
         WHERE target = 'fable' AND status IN ('queued', 'blocked', 'running')`,
      )
      .get() as { count: number };
    db.close();
    expect(pending.count).toBe(1);
    failPoke = false;
    hold = false;
    service.tick();
    await expect
      .poll(
        () => {
          const db3 = new DatabaseSync(relayDbPath(dir));
          const row = db3
            .prepare(
              `SELECT COUNT(*) AS count FROM relay_jobs
             WHERE target = 'fable' AND status IN ('queued', 'blocked', 'running')`,
            )
            .get() as { count: number };
          db3.close();
          return row.count;
        },
        { timeout: 250 },
      )
      .toBe(1);
    const db4 = new DatabaseSync(relayDbPath(dir));
    const reminderCount = db4
      .prepare("SELECT COUNT(*) AS count FROM relay_jobs WHERE target = 'fable'")
      .get() as { count: number };
    db4.close();
    expect(reminderCount.count).toBe(2);
    expect(service.get(goal.id)?.reminderJobId).not.toBe(goal.reminderJobId);
  });
});
