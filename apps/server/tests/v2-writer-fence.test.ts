import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { processIsAlive } from "../src/process-alive.ts";
import {
  isWriterLockHeld,
  releaseWriterLock,
  releaseWriterLockByKey,
  tryAcquireWriterLock,
  writerOwnerPath,
  writerResourceKey,
} from "../src/v2/writer-lock.ts";

const lockModule = fileURLToPath(new URL("../src/v2/writer-lock.ts", import.meta.url));

const dirs: string[] = [];
const spawnedPids: number[] = [];

afterEach(() => {
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempHome(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function resourceFor(home: string, canonical: string) {
  const hostHome = join(home, "host");
  return {
    key: writerResourceKey(hostHome, canonical),
    hostId: "pi-lhc" as const,
    hostHome,
    hostThreadId: "session-ref",
    canonicalThreadId: canonical,
  };
}

/**
 * Run one acquire in a REAL separate process so "the Console died" is a real
 * process death, not a mocked pid. `mode` selects where that process dies.
 */
function runHolder(
  home: string,
  resource: ReturnType<typeof resourceFor>,
  mode: "crash-before-metadata" | "acquire-only",
): { status: string; childPid: number | null } {
  const script = join(home, `holder-${mode}.ts`);
  writeFileSync(
    script,
    `
import { spawn } from "node:child_process";
import { tryAcquireWriterLock } from ${JSON.stringify(lockModule)};

const resource = ${JSON.stringify(resource)};
const attempt = tryAcquireWriterLock(${JSON.stringify(home)}, resource);
if (!attempt.ok || !attempt.held) {
  process.stdout.write("BUSY\\n");
  process.exit(3);
}
if (${JSON.stringify(mode)} === "acquire-only") {
  process.stdout.write("HELD:0\\n");
  process.exit(0);
}
// Spawn the writer child so it inherits the fence descriptor, then die
// immediately — before any owner/sidecar metadata is recorded. This is the
// exact window the fence must survive.
const child = spawn("sleep", ["120"], {
  stdio: ["ignore", "ignore", "ignore", attempt.held.fd],
  detached: true,
});
child.unref();
process.stdout.write("HELD:" + child.pid + "\\n");
process.exit(0);
`,
    "utf8",
  );
  const run = spawnSync(process.execPath, [script], { encoding: "utf8" });
  const line = run.stdout.trim().split("\n").pop() ?? "";
  if (line.startsWith("HELD:")) {
    const pid = Number(line.slice("HELD:".length));
    if (Number.isInteger(pid) && pid > 0) spawnedPids.push(pid);
    return { status: "held", childPid: pid > 0 ? pid : null };
  }
  return { status: line || `exit ${run.status}: ${run.stderr}`, childPid: null };
}

describe("canonical writer fence — crash safety", () => {
  it("keeps the fence when the acquiring Console dies after spawn but before any metadata write", () => {
    const home = tempHome("lhc-fence-crash-");
    const resource = resourceFor(home, "th_crash");

    const holder = runHolder(home, resource, "crash-before-metadata");
    expect(holder.status).toBe("held");
    expect(holder.childPid).not.toBeNull();
    expect(processIsAlive(holder.childPid!)).toBe(true);

    // The Console process that acquired is gone and wrote no sidecar. The
    // writer child is alive, so the fence must still exclude everyone.
    expect(isWriterLockHeld(home, resource.key)).toBe(true);
    const attempt = tryAcquireWriterLock(home, resource);
    expect(attempt.ok).toBe(false);
    expect(attempt.reason).toBe("busy");
    expect(attempt.held).toBeNull();
  });

  it("releases the fence with no reclaim step once every holder is gone", () => {
    const home = tempHome("lhc-fence-stale-");
    const resource = resourceFor(home, "th_stale");

    const holder = runHolder(home, resource, "crash-before-metadata");
    expect(holder.status).toBe("held");
    expect(isWriterLockHeld(home, resource.key)).toBe(true);

    process.kill(holder.childPid!, "SIGKILL");
    for (let i = 0; i < 200 && processIsAlive(holder.childPid!); i += 1) {
      spawnSync("sleep", ["0.01"]);
    }
    expect(processIsAlive(holder.childPid!)).toBe(false);

    // No reclaim, no unlink, no PID comparison: the kernel dropped the claim
    // when its last holder died.
    expect(isWriterLockHeld(home, resource.key)).toBe(false);
    const attempt = tryAcquireWriterLock(home, resource);
    expect(attempt.ok).toBe(true);
    releaseWriterLock(attempt.held);
  });

  it("never lets a late reclaimer destroy a successor's claim", () => {
    const home = tempHome("lhc-fence-successor-");
    const resource = resourceFor(home, "th_successor");

    // Predecessor dies leaving no live writer at all.
    const predecessor = runHolder(home, resource, "acquire-only");
    expect(predecessor.status).toBe("held");
    expect(isWriterLockHeld(home, resource.key)).toBe(false);

    // Successor claims the freed resource.
    const successor = tryAcquireWriterLock(home, resource);
    expect(successor.ok).toBe(true);
    const successorOwner = readFileSync(writerOwnerPath(home, resource.key), "utf8");

    // A late arrival runs the full acquire path (the old protocol reclaimed
    // and unlinked here). It must be refused and must leave the successor's
    // claim and metadata untouched.
    const late = runHolder(home, resource, "crash-before-metadata");
    expect(late.status).toBe("BUSY");
    expect(isWriterLockHeld(home, resource.key)).toBe(true);
    expect(existsSync(writerOwnerPath(home, resource.key))).toBe(true);
    expect(readFileSync(writerOwnerPath(home, resource.key), "utf8")).toBe(successorOwner);

    releaseWriterLock(successor.held);
    expect(isWriterLockHeld(home, resource.key)).toBe(false);
    expect(existsSync(writerOwnerPath(home, resource.key))).toBe(false);
  });

  it("does not treat owner metadata as the exclusion primitive", () => {
    const home = tempHome("lhc-fence-metadata-");
    const resource = resourceFor(home, "th_metadata");

    const held = tryAcquireWriterLock(home, resource);
    expect(held.ok).toBe(true);

    // Deleting or forging inspectable metadata must not free a live fence.
    rmSync(writerOwnerPath(home, resource.key), { force: true });
    expect(isWriterLockHeld(home, resource.key)).toBe(true);
    expect(tryAcquireWriterLock(home, resource).ok).toBe(false);

    writeFileSync(writerOwnerPath(home, resource.key), "1\nforged\n\n\n", "utf8");
    expect(isWriterLockHeld(home, resource.key)).toBe(true);
    expect(tryAcquireWriterLock(home, resource).ok).toBe(false);

    releaseWriterLock(held.held);
    expect(isWriterLockHeld(home, resource.key)).toBe(false);
  });
});

describe("canonical writer fence — metadata is never the fence", () => {
  it("reports managedFenceHeld from the kernel, not from an owner row", async () => {
    const dir = tempHome("lhc-fence-status-");
    const previous = process.env.LHC_CONSOLE_V2;
    process.env.LHC_CONSOLE_V2 = "1";
    try {
      const { RuntimeManager } = await import("../src/v2/manager.ts");
      const { V2Store } = await import("../src/v2/store.ts");
      const { FakeProviderAdapter } = await import("../src/v2/adapters/fake.ts");
      const { TEST_ONLY_OWNER_POLICIES, testOnlyOwnerPolicies } =
        await import("../src/v2/policies.ts");
      const record = {
        id: "fable",
        name: "fable",
        description: "fable",
        duties: [],
        ownerSenderIds: ["owner"],
        mentionPatterns: ["fable"],
        health: { hostId: "pi-lhc", threadId: "th_canonical" },
        channels: {},
        relay: {
          hostId: "pi-lhc",
          threadId: "sess-alias",
          cwd: "/tmp",
          command: "true",
          args: [],
        },
        v2: { provider: "pi-lhc" as const },
      };
      const manager = new RuntimeManager({
        store: new V2Store({ dbPath: join(dir, "v2.sqlite") }),
        consoleHome: dir,
        agents: [record],
        policies: testOnlyOwnerPolicies(TEST_ONLY_OWNER_POLICIES),
        adapterFactory: () => new FakeProviderAdapter({ provider: "pi-lhc" }),
      });
      try {
        await manager.submit({
          target: "fable",
          commandId: "start-1",
          kind: "runtime.start",
          params: {},
        });
        const resource = manager.writerResourceFor("fable")!;
        expect(manager.status("fable").writers.console.kind).toBe("v2-runtime");
        expect(manager.status("fable").writers.managedFenceHeld).toBe(true);

        // The runtime row still says a v2 runtime owns this resource, but the
        // fence is gone. Status must report the kernel truth, not the row.
        releaseWriterLockByKey(dir, resource.key);
        expect(isWriterLockHeld(dir, resource.key)).toBe(false);
        expect(manager.status("fable").writers.console.kind).toBe("v2-runtime");
        expect(manager.status("fable").writers.managedFenceHeld).toBe(false);
      } finally {
        manager.close();
      }
    } finally {
      if (previous === undefined) delete process.env.LHC_CONSOLE_V2;
      else process.env.LHC_CONSOLE_V2 = previous;
    }
  });

  it("does not let a stale v1-job owner row block a V1 launch forever", async () => {
    const dir = tempHome("lhc-fence-stale-v1-");
    const { RuntimeManager } = await import("../src/v2/manager.ts");
    const { V2Store } = await import("../src/v2/store.ts");
    const { FakeProviderAdapter } = await import("../src/v2/adapters/fake.ts");
    const { TEST_ONLY_OWNER_POLICIES, testOnlyOwnerPolicies } =
      await import("../src/v2/policies.ts");
    const { createV1Admission, releaseLaunchLock } = await import("../src/v2/v1-admission.ts");
    const record = {
      id: "fable",
      name: "fable",
      description: "fable",
      duties: [],
      ownerSenderIds: ["owner"],
      mentionPatterns: ["fable"],
      health: { hostId: "pi-lhc", threadId: "th_canonical" },
      channels: {},
      relay: {
        hostId: "pi-lhc",
        threadId: "sess-alias",
        cwd: "/tmp",
        command: "true",
        args: [],
      },
      v2: { provider: "pi-lhc" as const },
    };
    const manager = new RuntimeManager({
      store: new V2Store({ dbPath: join(dir, "v2.sqlite") }),
      consoleHome: dir,
      agents: [record],
      policies: testOnlyOwnerPolicies(TEST_ONLY_OWNER_POLICIES),
      adapterFactory: () => new FakeProviderAdapter({ provider: "pi-lhc" }),
    });
    try {
      const resource = manager.writerResourceFor("fable")!;
      // A V1 job owner row left behind by a console that died. Its pid is long
      // gone and no fence is held, so it is stale bookkeeping — not exclusion.
      manager.noteManagedOwner(resource, "v1-job", 999_999_999);
      expect(isWriterLockHeld(dir, resource.key)).toBe(false);

      const admission = createV1Admission({
        enabled: true,
        consoleHome: dir,
        agents: [record],
        manager,
        isBusy: () => false,
      });
      const held = admission.acquireForLaunch(record.relay);
      expect(held).not.toBe("blocked");
      expect(held).not.toBe("unresolved");
      expect(held).not.toBeNull();
      releaseLaunchLock(held as never, manager);
    } finally {
      manager.close();
    }
  });
});
