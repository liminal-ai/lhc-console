import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { AgentRecord } from "../src/agent-registry.ts";
import { HermesLhcAdapter } from "../src/v2/adapters/hermes-lhc.ts";
import { inspectCanonicalSpan } from "../src/v2/canonical.ts";
import { MemoryJsonlPair } from "../src/v2/jsonl-transport.ts";
import { RuntimeManager } from "../src/v2/manager.ts";
import { TEST_ONLY_OWNER_POLICIES, testOnlyOwnerPolicies } from "../src/v2/policies.ts";
import { V2Store } from "../src/v2/store.ts";

/**
 * O1's deterministic half: the hermes thread file's stem is the gateway
 * session_key, so the resolved session id from `session.resume` must equal the
 * canonical store's own resume reference (`launchRecipe(thread).sessionRef`).
 */
const SESSION_STEM = "20260819_120000_a1b2c3";
const FOREIGN_STEM = "20260819_130000_ffffff";
const CANONICAL_THREAD_ID = "th_hermes_startup_repair";
const PROFILE = "lhc-v2-test";

const dirs: string[] = [];
const managers: RuntimeManager[] = [];
let savedHermesHome: string | undefined;

afterEach(() => {
  for (const manager of managers.splice(0)) manager.close();
  if (savedHermesHome === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = savedHermesHome;
  savedHermesHome = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A real disposable hermes profile home: `profiles/<name>/lhc/threads/<stem>.sqlite`
 * in the exact per-profile layout `describeHost("hermes")` scans, identity
 * carried by the file's own `thread_metadata` row exactly as the LHC engine
 * writes it. The producer under test reads this store; nothing is stubbed.
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
  savedHermesHome = process.env.HERMES_HOME;
  process.env.HERMES_HOME = dir;
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

/** A gateway fixture that resumes as `resolvedStem`, over the real JSONL codec. */
function gateway(resolvedStem: string): MemoryJsonlPair {
  const pair = new MemoryJsonlPair();
  pair.server.onLine((line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    if (message.method === "session.resume") {
      pair.server.send({ id: message.id, result: { session_id: resolvedStem, sid: "ab12cd34" } });
    }
  });
  return pair;
}

/**
 * The real producer wired to the real consumer: `inspectCanonicalSpan` reads
 * the profile home above and `RuntimeManager` proves the resolved session
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
  it("accepts a start whose resolved session is this canonical thread's resume stem", async () => {
    const home = hermesHome();
    const pair = gateway(SESSION_STEM);
    const manager = managerOver(pair, home);

    const receipt = await submitStart(manager, pair);

    expect(receipt.state).toBe("applied");
    const status = manager.status("hermes-agent");
    expect(status.state).toBe("idle");
    expect(status.provider).toBe("hermes");
    expect(status.thread.nativeThreadRef).toBe(SESSION_STEM);
    expect(status.thread.canonicalThreadId).toBe(CANONICAL_THREAD_ID);
    expect(status.capabilities.steerConsumption).toBe("unsupported");
  });

  it("refuses a start whose resolved session is some other stem", async () => {
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

  it("carries the hermes stem as the host's own resume reference on success spans", async () => {
    hermesHome();
    const inspected = await inspectCanonicalSpan({
      hostId: "hermes",
      canonicalThreadId: CANONICAL_THREAD_ID,
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
    hermesHome();
    const missing = await inspectCanonicalSpan({
      hostId: "hermes",
      canonicalThreadId: "th_not_in_this_profile",
    });
    expect(missing.closed).toBe(false);
    expect(missing.span).toEqual({ reason: "thread_file_missing" });
  });
});
