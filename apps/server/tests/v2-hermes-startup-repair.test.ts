import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { AgentRecord } from "../src/agent-registry.ts";
import { HermesLhcAdapter } from "../src/v2/adapters/hermes-lhc.ts";
import { inspectCanonicalSpan } from "../src/v2/canonical.ts";
import { hostHomeOverrideFor, resolveWriterResource } from "../src/v2/identity.ts";
import { MemoryJsonlPair } from "../src/v2/jsonl-transport.ts";
import { RuntimeManager } from "../src/v2/manager.ts";
import { TEST_ONLY_OWNER_POLICIES, testOnlyOwnerPolicies } from "../src/v2/policies.ts";
import { V2Store } from "../src/v2/store.ts";

/**
 * O1's deterministic half: the hermes thread file's stem is the durable
 * gateway session_key, so the `resumed`/`session_key` reference from
 * `session.resume` must equal the canonical store's own resume reference
 * (`launchRecipe(thread).sessionRef`). The ephemeral `session_id` SID minted
 * per resume proves nothing and must never be used as identity.
 */
const SESSION_STEM = "20260819_120000_a1b2c3";
const FOREIGN_STEM = "20260819_130000_ffffff";
const LIVE_SID = "ab12cd34";
const CANONICAL_THREAD_ID = "th_hermes_startup_repair";
const PROFILE = "lhc-v2-test";

const dirs: string[] = [];
const managers: RuntimeManager[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A real disposable hermes profile home: `profiles/<name>/lhc/threads/<stem>.sqlite`
 * in the exact per-profile layout `describeHost("hermes")` scans, identity
 * carried by the file's own `thread_metadata` row exactly as the LHC engine
 * writes it. The producer under test reads this store; nothing is stubbed and
 * the Console process's global HERMES_HOME is never consulted or mutated —
 * the home travels as the target's own v2.env binding.
 */
function hermesHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "lhc-hermes-home-"));
  dirs.push(dir);
  const threadsDir = join(dir, "profiles", PROFILE, "lhc", "threads");
  mkdirSync(threadsDir, { recursive: true });
  const thread = new DatabaseSync(join(threadsDir, `${SESSION_STEM}.sqlite`));
  thread.exec(`
    CREATE TABLE thread_metadata (
      id INTEGER PRIMARY KEY,
      thread_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      token_estimator TEXT
    );
    INSERT INTO thread_metadata VALUES (1, '${CANONICAL_THREAD_ID}', '2026-08-19T00:00:00Z', 'approx');
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
  return dir;
}

function hermesAgent(home: string): AgentRecord {
  return {
    id: "hermes-agent",
    name: "hermes-agent",
    description: "hermes-agent",
    duties: [],
    ownerSenderIds: ["owner"],
    mentionPatterns: ["hermes"],
    health: { hostId: "hermes", threadId: CANONICAL_THREAD_ID },
    channels: {},
    relay: {
      hostId: "hermes",
      threadId: SESSION_STEM,
      cwd: "/tmp",
      command: "true",
      args: [],
    },
    v2: { provider: "hermes", env: { HERMES_HOME: home } },
  };
}

/**
 * A gateway fixture answering `session.resume` with the real payload shape
 * (`tui_gateway/methods_session.py`): ephemeral `session_id` SID plus durable
 * `resumed`/`session_key`, with the idle-affirmation fields.
 */
function gateway(
  resolvedStem: string,
  resumeOverrides: Record<string, unknown> = {},
): MemoryJsonlPair {
  const pair = new MemoryJsonlPair();
  pair.server.onLine((line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    if (message.method === "session.resume") {
      pair.server.send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          session_id: LIVE_SID,
          resumed: resolvedStem,
          session_key: resolvedStem,
          message_count: 1,
          messages: [],
          messages_omitted: true,
          info: { cwd: "/tmp", profile: PROFILE },
          inflight: null,
          running: false,
          started_at: "2026-08-19T00:00:00Z",
          status: "idle",
          ...resumeOverrides,
        },
      });
    }
  });
  return pair;
}

/**
 * The real producer wired to the real consumer: `inspectCanonicalSpan` reads
 * the disposable profile home above (threaded per-target, never via the
 * Console process env) and `RuntimeManager` proves the resumed session_key
 * against it. No hand-written `inspectCanonical` stands in for either side.
 */
function managerOver(pair: MemoryJsonlPair, home: string): RuntimeManager {
  const consoleHome = mkdtempSync(join(tmpdir(), "lhc-console-home-"));
  dirs.push(consoleHome);
  const adapter = new HermesLhcAdapter({ transport: pair.client });
  const manager = new RuntimeManager({
    store: new V2Store({ dbPath: join(consoleHome, "v2.sqlite") }),
    consoleHome,
    agents: [hermesAgent(home)],
    policies: testOnlyOwnerPolicies(TEST_ONLY_OWNER_POLICIES),
    adapterFactory: () => adapter,
    inspectCanonical: inspectCanonicalSpan,
  });
  managers.push(manager);
  return manager;
}

async function submitStart(manager: RuntimeManager, pair: MemoryJsonlPair) {
  // The worker's ready frame arrives on its own schedule relative to the
  // manager's start path; repeat it until the submit settles.
  const readyPump = setInterval(
    () => pair.server.send({ method: "event", params: { type: "gateway.ready" } }),
    5,
  );
  try {
    return await manager.submit({
      target: "hermes-agent",
      commandId: "start-1",
      kind: "runtime.start",
      params: {},
    });
  } finally {
    clearInterval(readyPump);
  }
}

describe("Hermes V2 startup: real canonical producer against the real manager proof", () => {
  it("accepts a start whose resumed session_key is this canonical thread's resume stem", async () => {
    const home = hermesHome();
    const pair = gateway(SESSION_STEM);
    const manager = managerOver(pair, home);

    const receipt = await submitStart(manager, pair);

    expect(receipt.state).toBe("applied");
    const status = manager.status("hermes-agent");
    expect(status.state).toBe("idle");
    expect(status.provider).toBe("hermes");
    // Identity is the durable session_key, never the ephemeral SID.
    expect(status.thread.nativeThreadRef).toBe(SESSION_STEM);
    expect(status.thread.canonicalThreadId).toBe(CANONICAL_THREAD_ID);
    expect(status.capabilities.steerConsumption).toBe("unsupported");
    // The proof ran against the target's disposable home, not whatever the
    // Console process's global HERMES_HOME points at (unset or a real seat).
    expect(process.env.HERMES_HOME ?? "").not.toBe(home);
  });

  it("refuses a start whose resumed session_key is some other stem", async () => {
    const home = hermesHome();
    const pair = gateway(FOREIGN_STEM);
    const manager = managerOver(pair, home);

    const receipt = await submitStart(manager, pair);

    expect(receipt.state).toBe("rejected");
    // Classified from the adapter's ProviderUnavailableError, not its wording.
    expect(receipt.reason).toBe("provider_unavailable");
    expect(receipt.message).toMatch(/does not map/);
    expect(manager.status("hermes-agent").state).toBe("stopped");
    expect(manager.status("hermes-agent").thread.nativeThreadRef).toBe(null);
  });

  it("refuses identity carried only by the ephemeral SID with no durable reference", async () => {
    const home = hermesHome();
    const pair = gateway(SESSION_STEM, { resumed: undefined, session_key: undefined });
    const manager = managerOver(pair, home);

    const receipt = await submitStart(manager, pair);

    expect(receipt.state).toBe("rejected");
    expect(receipt.reason).toBe("provider_unavailable");
    expect(receipt.message).toMatch(/durable resumed\/session_key/);
  });

  it("marks an unproven-idle resume as unknown, never idle", async () => {
    const home = hermesHome();
    // The gateway resumed a session with a live run loop and a retained
    // inflight turn (a mid-run reconnect); startup must surface that.
    const pair = gateway(SESSION_STEM, {
      running: true,
      inflight: { user: "still going" },
      status: "streaming",
    });
    const manager = managerOver(pair, home);

    const receipt = await submitStart(manager, pair);

    expect(receipt.state).toBe("applied");
    const status = manager.status("hermes-agent");
    expect(status.state).toBe("unknown");
    expect(status.thread.nativeThreadRef).toBe(SESSION_STEM);
  });

  it("carries the hermes stem as the host's own resume reference on success spans", async () => {
    const home = hermesHome();
    const inspected = await inspectCanonicalSpan({
      hostId: "hermes",
      canonicalThreadId: CANONICAL_THREAD_ID,
      hostHome: home,
    });
    // sessionRef comes from launchRecipe(thread) — the host's own resume
    // recipe (`hermes --profile … --resume <stem>`), not a Console guess.
    expect(inspected.span?.nativeThreadRef).toBe(SESSION_STEM);
    expect(inspected.span?.hostThreadId).toBe(CANONICAL_THREAD_ID);
    expect(inspected.span?.turnCount).toBe(1);
    // Identity is proved; span closure still is not.
    expect(inspected.closed).toBe(false);
  });

  it("leaves failure spans field-less so identity can never be inferred from them", async () => {
    const home = hermesHome();
    const missing = await inspectCanonicalSpan({
      hostId: "hermes",
      canonicalThreadId: "th_not_in_this_profile",
      hostHome: home,
    });
    expect(missing.closed).toBe(false);
    expect(missing.span).toEqual({ reason: "thread_file_missing" });
  });

  it("keys the writer fence off the target's own disposable home, never the process home", () => {
    const homeA = hermesHome();
    const agentA = hermesAgent(homeA);
    expect(hostHomeOverrideFor(agentA)).toBe(homeA);
    const resourceA = resolveWriterResource(agentA);
    expect(resourceA.hostHome).toBe(homeA);
    // A second target with a different disposable home must land on a
    // different fence key — same canonical id, different store.
    const homeB = mkdtempSync(join(tmpdir(), "lhc-hermes-home-b-"));
    dirs.push(homeB);
    const resourceB = resolveWriterResource(hermesAgent(homeB));
    expect(resourceB.key).not.toBe(resourceA.key);
    // Codex/Pi targets carry no override and keep default home resolution.
    expect(
      hostHomeOverrideFor({ ...agentA, relay: { ...agentA.relay, hostId: "codex-lhc" } }),
    ).toBeNull();
  });

  it("refuses to key a hermes writer fence without an explicit HERMES_HOME", () => {
    const agent = hermesAgent(hermesHome());
    const bare = { ...agent, v2: { provider: "hermes" as const } };
    expect(() => resolveWriterResource(bare)).toThrow(/no explicit HERMES_HOME/);
  });
});
