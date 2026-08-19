import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { AgentRecord } from "../src/agent-registry.ts";
import { CodexLhcAdapter, type CodexConfigWarning } from "../src/v2/adapters/codex-lhc.ts";
import { inspectCanonicalSpan } from "../src/v2/canonical.ts";
import { MemoryJsonlPair } from "../src/v2/jsonl-transport.ts";
import { RuntimeManager } from "../src/v2/manager.ts";
import { TEST_ONLY_OWNER_POLICIES, testOnlyOwnerPolicies } from "../src/v2/policies.ts";
import { V2Store } from "../src/v2/store.ts";

/**
 * The Codex thread file's stem IS the native session id for this host, so this
 * is both what `thread/resume` returns and what `launchRecipe` derives.
 */
const NATIVE_SESSION_ID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const FOREIGN_SESSION_ID = "11111111-2222-3333-4444-555555555555";
const CANONICAL_THREAD_ID = "th_codex_startup_repair";

const dirs: string[] = [];
const managers: RuntimeManager[] = [];
const adapters: CodexLhcAdapter[] = [];
let savedCodexHome: string | undefined;

afterEach(async () => {
  for (const adapter of adapters.splice(0)) {
    try {
      await adapter.stop("kill");
    } catch {
      // a test may already have stopped it
    }
  }
  for (const manager of managers.splice(0)) manager.close();
  if (savedCodexHome === undefined) delete process.env.CODEX_LHC_HOME;
  else process.env.CODEX_LHC_HOME = savedCodexHome;
  savedCodexHome = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A real codex-lhc host home: registry row plus the thread file it points at,
 * named by the native session uuid exactly as the native fork names it. The
 * producer under test reads this store; nothing here is stubbed.
 */
function codexHostHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "lhc-codex-home-"));
  dirs.push(dir);
  const threadsDir = join(dir, "threads");
  mkdirSync(threadsDir);
  const threadFile = join(threadsDir, `${NATIVE_SESSION_ID}.sqlite`);
  const thread = new DatabaseSync(threadFile);
  thread.exec(`
    CREATE TABLE event (event_order INTEGER PRIMARY KEY, recorded_at TEXT);
    INSERT INTO event VALUES (10, '2026-08-19T00:00:00Z');
    CREATE TABLE turns (
      turn_id TEXT PRIMARY KEY,
      turn_order INTEGER NOT NULL,
      status TEXT NOT NULL,
      closed_at_event_order INTEGER,
      deleted_at TEXT
    );
    INSERT INTO turns VALUES ('turn-1', 1, 'closed', 10, NULL);
    CREATE TABLE message (
      message_id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      source_event_order INTEGER NOT NULL,
      token_estimate INTEGER NOT NULL,
      deleted_at TEXT
    );
    INSERT INTO message VALUES ('m1', 'turn-1', 'user_prompt', 10, 5, NULL);
    CREATE TABLE message_block (
      message_id TEXT NOT NULL,
      block_index INTEGER NOT NULL,
      block_type TEXT NOT NULL,
      content TEXT NOT NULL
    );
    INSERT INTO message_block VALUES ('m1', 0, 'text', 'hello');
  `);
  thread.close();
  const registry = new DatabaseSync(join(dir, "registry.sqlite"));
  registry.exec(`
    CREATE TABLE threads (
      thread_id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      title TEXT,
      cwd TEXT,
      created_at TEXT NOT NULL
    );
  `);
  registry
    .prepare("insert into threads values (?, ?, ?, ?, ?)")
    .run(CANONICAL_THREAD_ID, threadFile, "startup repair", "/tmp", "2026-08-19T00:00:00Z");
  registry.close();
  savedCodexHome = process.env.CODEX_LHC_HOME;
  process.env.CODEX_LHC_HOME = dir;
  return dir;
}

function codexAgent(): AgentRecord {
  return {
    id: "codex-agent",
    name: "codex-agent",
    description: "codex-agent",
    duties: [],
    ownerSenderIds: ["owner"],
    mentionPatterns: ["codex"],
    health: { hostId: "codex-lhc", threadId: CANONICAL_THREAD_ID },
    channels: {},
    relay: {
      hostId: "codex-lhc",
      threadId: NATIVE_SESSION_ID,
      cwd: "/tmp",
      command: "true",
      args: [],
    },
    v2: { provider: "codex-lhc" },
  };
}

/** An app-server fixture that resumes as `nativeId`, over the real JSONL codec. */
function appServer(
  nativeId: string,
  options: { configWarning?: Record<string, unknown> } = {},
): MemoryJsonlPair {
  const pair = new MemoryJsonlPair();
  pair.server.onLine((line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    if (message.method === "initialize") {
      pair.server.send({ id: message.id, result: { userAgent: "fixture" } });
      if (options.configWarning) {
        pair.server.send({ method: "configWarning", params: options.configWarning });
      }
      return;
    }
    if (message.method === "thread/resume") {
      pair.server.send({ id: message.id, result: { thread: { id: nativeId } } });
    }
  });
  return pair;
}

/**
 * The real producer wired to the real consumer: `inspectCanonicalSpan` reads
 * the host store above and `RuntimeManager` proves the resumed session against
 * it. No hand-written `inspectCanonical` stands in for either side, which is
 * the whole point — a stub would have kept agreeing with itself while the real
 * producer omitted the fields the real consumer reads.
 */
function managerOver(pair: MemoryJsonlPair): { manager: RuntimeManager; agent: AgentRecord } {
  const consoleHome = mkdtempSync(join(tmpdir(), "lhc-console-home-"));
  dirs.push(consoleHome);
  const agent = codexAgent();
  const adapter = new CodexLhcAdapter({ transport: pair.client });
  const manager = new RuntimeManager({
    store: new V2Store({ dbPath: join(consoleHome, "v2.sqlite") }),
    consoleHome,
    agents: [agent],
    policies: testOnlyOwnerPolicies(TEST_ONLY_OWNER_POLICIES),
    adapterFactory: () => adapter,
    inspectCanonical: inspectCanonicalSpan,
  });
  managers.push(manager);
  return { manager, agent };
}

describe("Codex V2 startup: real canonical producer against the real manager proof", () => {
  it("accepts a start whose native session is this canonical thread's resume reference", async () => {
    codexHostHome();
    const { manager } = managerOver(appServer(NATIVE_SESSION_ID));

    const receipt = await manager.submit({
      target: "codex-agent",
      commandId: "start-1",
      kind: "runtime.start",
      params: {},
    });

    expect(receipt.state).toBe("applied");
    const status = manager.status("codex-agent");
    expect(status.state).toBe("idle");
    expect(status.thread.nativeThreadRef).toBe(NATIVE_SESSION_ID);
    expect(status.thread.canonicalThreadId).toBe(CANONICAL_THREAD_ID);
  });

  it("still refuses a start whose native session is some other thread", async () => {
    codexHostHome();
    const { manager } = managerOver(appServer(FOREIGN_SESSION_ID));

    const receipt = await manager.submit({
      target: "codex-agent",
      commandId: "start-1",
      kind: "runtime.start",
      params: {},
    });

    expect(receipt.state).toBe("rejected");
    // Classified from the adapter's ProviderUnavailableError, not its wording.
    expect(receipt.reason).toBe("provider_unavailable");
    expect(receipt.message).toMatch(/does not map/);
    expect(manager.status("codex-agent").state).toBe("stopped");
    expect(manager.status("codex-agent").thread.nativeThreadRef).toBe(null);
  });

  it("carries the host's own resume reference on success spans", async () => {
    codexHostHome();
    const inspected = await inspectCanonicalSpan({
      hostId: "codex-lhc",
      canonicalThreadId: CANONICAL_THREAD_ID,
    });
    expect(inspected.span?.nativeThreadRef).toBe(NATIVE_SESSION_ID);
    expect(inspected.span?.hostThreadId).toBe(CANONICAL_THREAD_ID);
    expect(inspected.span?.turnCount).toBe(1);
    // Identity is proved; span closure still is not.
    expect(inspected.closed).toBe(false);
  });

  it("leaves failure spans field-less so identity can never be inferred from them", async () => {
    codexHostHome();
    const missing = await inspectCanonicalSpan({
      hostId: "codex-lhc",
      canonicalThreadId: "th_not_in_this_registry",
    });
    expect(missing.closed).toBe(false);
    expect(missing.span).toEqual({ reason: "thread_file_missing" });
  });
});

describe("Codex V2 startup: child stderr is drained and reported", () => {
  it("keeps a bounded tail of a child that outwrites the stderr pipe buffer", async () => {
    const adapter = new CodexLhcAdapter();
    adapters.push(adapter);
    // 4000 lines is far more than a pipe buffer holds: an undrained stderr
    // would block this child before it ever reaches the marker line.
    const script =
      "for (let i = 0; i < 4000; i++) process.stderr.write(`noise ${i} ${'x'.repeat(60)}\\n`);" +
      "process.stderr.write('fatal: codex-lhc boot failed\\n');" +
      "setInterval(() => {}, 1000);";
    const started = adapter.start({
      hostThreadId: NATIVE_SESSION_ID,
      canonicalThreadId: CANONICAL_THREAD_ID,
      cwd: tmpdir(),
      command: process.execPath,
      args: ["-e", script],
      approvalPolicy: "bypass-at-spawn",
    });

    // Generous next to the ~200ms a drained pipe takes, and well inside the
    // per-test timeout raised below so a wedged child fails rather than hangs.
    const deadline = Date.now() + 10_000;
    let tail: string[] = [];
    while (Date.now() < deadline) {
      tail = ((await adapter.getState()).stderrTail as string[]) ?? [];
      if (tail.some((line) => line.includes("fatal: codex-lhc boot failed"))) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(tail.at(-1)).toBe("fatal: codex-lhc boot failed");
    // Bounded: 4001 lines written, a handful kept.
    expect(tail.length).toBeLessThanOrEqual(5);

    adapter.rejectPendingForTest("codex-lhc runtime exited");
    await expect(started).rejects.toThrow(/runtime exited[\s\S]*fatal: codex-lhc boot failed/);
  }, 15_000);
});

describe("Codex V2 startup: app-server config warnings", () => {
  it("records a config warning without failing an otherwise good start", async () => {
    codexHostHome();
    const pair = appServer(NATIVE_SESSION_ID, {
      configWarning: {
        summary: "Invalid configuration; using defaults.",
        details: "error loading config: bad config",
        path: "/home/agent/.codex/config.toml",
      },
    });
    const reported: CodexConfigWarning[] = [];
    const adapter = new CodexLhcAdapter({
      transport: pair.client,
      onConfigWarning: (warning) => reported.push(warning),
    });
    const native = await adapter.start({
      hostThreadId: NATIVE_SESSION_ID,
      canonicalThreadId: CANONICAL_THREAD_ID,
      cwd: "/tmp",
      approvalPolicy: "bypass-at-spawn",
      proveCanonicalSession: async (nativeThreadRef, canonicalThreadId) => {
        const inspected = await inspectCanonicalSpan({ hostId: "codex-lhc", canonicalThreadId });
        return inspected.span?.nativeThreadRef === nativeThreadRef;
      },
    });

    expect(native).toBe(NATIVE_SESSION_ID);
    const expected = [
      {
        summary: "Invalid configuration; using defaults.",
        details: "error loading config: bad config",
        path: "/home/agent/.codex/config.toml",
      },
    ];
    expect(adapter.configWarnings()).toEqual(expected);
    // Reported as it arrived, not merely retained for whoever asks later.
    expect(reported).toEqual(expected);
  });

  it("reports the config warning as evidence when the start fails", async () => {
    const pair = appServer(FOREIGN_SESSION_ID, {
      configWarning: { summary: "Error parsing rules; custom rules not applied.", details: null },
    });
    const adapter = new CodexLhcAdapter({ transport: pair.client, onConfigWarning: () => {} });
    await expect(
      adapter.start({
        hostThreadId: NATIVE_SESSION_ID,
        canonicalThreadId: CANONICAL_THREAD_ID,
        cwd: "/tmp",
        approvalPolicy: "bypass-at-spawn",
        proveCanonicalSession: async () => false,
      }),
    ).rejects.toThrow(/config warnings: Error parsing rules/);
  });
});
