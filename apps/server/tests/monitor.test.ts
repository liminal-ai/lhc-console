import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { MonitorService } from "../src/monitor.ts";
import type { RelayJob } from "../src/relay.ts";

const dirs: string[] = [];
const services: MonitorService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "lhc-console-monitor-"));
  dirs.push(dir);
  const jobs = new Map<string, RelayJob>();
  let sequence = 0;
  const prompts: Array<{ target: string; prompt: string; notify?: "photon" }> = [];
  let lastActivityAt: Date | null = new Date(0);
  const service = new MonitorService({
    dbPath: join(dir, "monitor.sqlite"),
    pollMs: 5,
    enqueue: ({ target, prompt, notify }) => {
      const id = `job-${++sequence}`;
      prompts.push({ target, prompt, notify });
      jobs.set(id, {
        id,
        target,
        prompt,
        jobKind: "agent",
        sender: null,
        status: "queued",
        jobClass: "deprioritized",
        output: null,
        error: null,
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        notify: null,
        delivery: null,
        deliveryStatus: null,
        deliveryError: null,
      });
      return { id };
    },
    getJob: (id) => jobs.get(id) ?? null,
    targetExists: (target) => target === "fable",
    lastActivityAt: () => lastActivityAt,
    minIntervalMs: 1,
  });
  services.push(service);
  return {
    dir,
    jobs,
    prompts,
    service,
    setLastActivityAt: (value: Date | null) => {
      lastActivityAt = value;
    },
  };
}

describe("MonitorService", () => {
  it("persists owner-private monitors across service restarts", async () => {
    const { dir, service } = setup();
    const monitor = service.add({
      target: "fable",
      prompt: "Continue until the goal is done.",
      intervalMs: 60_000,
      maxTicks: 3,
    });
    await service.close();
    services.splice(services.indexOf(service), 1);

    const dbPath = join(dir, "monitor.sqlite");
    expect(existsSync(dbPath)).toBe(true);
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);

    const reopened = new MonitorService({
      dbPath,
      enqueue: () => ({ id: "unused" }),
      getJob: () => null,
      targetExists: (target) => target === "fable",
      lastActivityAt: () => new Date(0),
      minIntervalMs: 1,
    });
    services.push(reopened);
    expect(reopened.list()).toEqual([
      expect.objectContaining({
        id: monitor.id,
        target: "fable",
        prompt:
          "Continue until the goal is done.\n\nReply with a short plain-English status a phone reader can skim — a few sentences, phase-level, no ids or jargon. If your status needs an action or decision from Lee, start the message with: NEEDS YOU —",
        intervalMs: 60_000,
        idleForMs: 180_000,
        maxTicks: 3,
        tickCount: 0,
        active: true,
        quiet: false,
      }),
    ]);
  });

  it("skips due ticks while its previous relay job is queued or running", async () => {
    const { jobs, prompts, service } = setup();
    const monitor = service.add({
      target: "fable",
      prompt: "Keep moving.",
      intervalMs: 15,
      maxTicks: 2,
    });
    service.start();

    await expect.poll(() => prompts.length, { timeout: 250 }).toBe(1);
    expect(prompts[0]).toEqual({
      target: "fable",
      notify: "photon",
      prompt:
        "Keep moving.\n\nReply with a short plain-English status a phone reader can skim — a few sentences, phase-level, no ids or jargon. If your status needs an action or decision from Lee, start the message with: NEEDS YOU —",
    });
    await new Promise((resolve) => setTimeout(resolve, 45));
    expect(prompts).toHaveLength(1);
    expect(service.get(monitor.id)?.tickCount).toBe(1);

    const firstJob = jobs.get("job-1");
    if (!firstJob) throw new Error("first relay job missing");
    firstJob.status = "running";
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(prompts).toHaveLength(1);

    firstJob.status = "completed";
    await expect.poll(() => prompts.length, { timeout: 250 }).toBe(2);
    expect(service.get(monitor.id)).toMatchObject({ tickCount: 2, active: false });
  });

  it("allows a quiet monitor to skip phone delivery", async () => {
    const { prompts, service } = setup();
    service.add({
      target: "fable",
      prompt: "Run a noisy check.",
      intervalMs: 15,
      maxTicks: 1,
      quiet: true,
    });
    service.start();

    await expect.poll(() => prompts.length, { timeout: 250 }).toBe(1);
    expect(prompts[0]?.notify).toBeUndefined();
    expect(service.list()[0]).toMatchObject({ quiet: true });
  });

  it("skips active targets without consuming a tick and honors an idle override", async () => {
    const { prompts, service, setLastActivityAt } = setup();
    setLastActivityAt(new Date());
    const monitor = service.add({
      target: "fable",
      prompt: "Keep moving.",
      intervalMs: 15,
      idleForMs: 40,
      maxTicks: 1,
    });
    service.start();

    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(prompts).toHaveLength(0);
    expect(service.get(monitor.id)).toMatchObject({
      tickCount: 0,
      active: true,
      idleForMs: 40,
    });

    setLastActivityAt(new Date(Date.now() - 100));
    await expect.poll(() => prompts.length, { timeout: 250 }).toBe(1);
    expect(service.get(monitor.id)).toMatchObject({ tickCount: 1, active: false });
  });

  it("removes a monitor explicitly and rejects invalid registrations", () => {
    const { service } = setup();
    expect(() =>
      service.add({ target: "unknown", prompt: "hello", intervalMs: 1000, maxTicks: 2 }),
    ).toThrow("unknown relay target");
    expect(() =>
      service.add({ target: "fable", prompt: " ", intervalMs: 1000, maxTicks: 2 }),
    ).toThrow("prompt is required");
    expect(() =>
      service.add({ target: "fable", prompt: "hello", intervalMs: 0, maxTicks: 2 }),
    ).toThrow("intervalMs must be a positive integer");
    expect(() =>
      service.add({ target: "fable", prompt: "hello", intervalMs: 1000, maxTicks: 0 }),
    ).toThrow("maxTicks must be a positive integer");

    const monitor = service.add({
      target: "fable",
      prompt: "hello",
      intervalMs: 1000,
      maxTicks: 2,
    });
    expect(service.remove(monitor.id)).toBe(true);
    expect(service.get(monitor.id)).toBeNull();
    expect(service.remove(monitor.id)).toBe(false);
  });
});
