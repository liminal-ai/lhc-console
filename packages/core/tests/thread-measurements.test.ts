import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { threadQuickStats, threadViewArrangement } from "../src/thread.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(options: { withView?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "lhc-console-measurements-"));
  dirs.push(dir);
  const path = join(dir, "thread.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE event (recorded_at TEXT);
    INSERT INTO event VALUES ('2026-01-01T00:00:00Z');
    CREATE TABLE thread_metadata (
      id INTEGER PRIMARY KEY,
      thread_id TEXT,
      created_at TEXT,
      token_estimator TEXT
    );
    INSERT INTO thread_metadata VALUES (1, 'fixture', '2026-01-01T00:00:00Z', 'fixture');
    CREATE TABLE turns (
      turn_id TEXT PRIMARY KEY,
      turn_order INTEGER NOT NULL,
      status TEXT NOT NULL,
      opened_at_event_order INTEGER,
      deleted_at TEXT
    );
    CREATE TABLE message (
      message_id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      source_event_order INTEGER NOT NULL,
      token_estimate INTEGER NOT NULL,
      provider_usage TEXT,
      deleted_at TEXT
    );
    CREATE TABLE message_block (
      message_id TEXT NOT NULL,
      block_index INTEGER NOT NULL,
      block_type TEXT NOT NULL,
      content TEXT NOT NULL
    );
    CREATE TABLE thread_view (
      singleton INTEGER PRIMARY KEY,
      view_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      compact_point INTEGER NOT NULL,
      covered_from INTEGER NOT NULL,
      profile_name TEXT,
      arrangement_json TEXT,
      gaps_json TEXT
    );
    CREATE TABLE thread_view_band (
      view_id TEXT NOT NULL,
      band TEXT NOT NULL,
      token_count INTEGER NOT NULL
    );
    CREATE TABLE chunk_member (chunk_id TEXT, turn_id TEXT, member_idx INTEGER);
    CREATE TABLE derivation (
      subject_kind TEXT,
      subject_id TEXT,
      derivation_type TEXT,
      state TEXT,
      content TEXT
    );
    CREATE TABLE chunk (chunk_id TEXT PRIMARY KEY, chunk_order INTEGER NOT NULL);
    CREATE TABLE work_item (work_item_id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE view_boundary (thread_singleton INTEGER PRIMARY KEY, position INTEGER NOT NULL);

    INSERT INTO turns VALUES
      ('old-selected', 1, 'closed', 10, NULL),
      ('old-omitted', 2, 'closed', 20, NULL),
      ('post-compact', 3, 'closed', 110, NULL);
    INSERT INTO message VALUES
      ('m1', 'old-selected', 'user_prompt', 10, 100, NULL, NULL),
      ('m2', 'old-omitted', 'user_prompt', 20, 1000, NULL, NULL),
      ('m3', 'post-compact', 'user_prompt', 110, 50, '{"input":70,"cacheRead":30}', NULL);
    INSERT INTO message_block VALUES
      ('m1', 0, 'text', 'selected'),
      ('m2', 0, 'text', 'omitted'),
      ('m3', 0, 'text', 'new');
  `);
  if (options.withView !== false) {
    db.prepare(
      `INSERT INTO thread_view VALUES (1, 'v1', '2026-01-01T00:00:00Z', 100, 1, 'default', ?, '[]')`,
    ).run(
      JSON.stringify([
        {
          band: "brief",
          subjectKind: "turn",
          subjectId: "old-selected",
          derivationUsed: "turn_summary",
        },
      ]),
    );
    db.exec(`
      INSERT INTO thread_view_band VALUES ('v1', 'brief', 25);
      INSERT INTO derivation VALUES
        ('turn', 'old-selected', 'turn_summary', 'ready', 'selected summary');
    `);
  }
  db.close();
  return path;
}

describe("thread view measurements", () => {
  it("keeps pre-compact turns omitted by the view out of the live tail", () => {
    const result = threadViewArrangement(fixture());

    expect(result.liveTail.map((turn) => turn.turnId)).toEqual(["post-compact"]);
    expect(result.liveTailTokens).toBe(50);
    expect(result.archivedHistory.map((turn) => turn.turnId)).toEqual(["old-omitted"]);
    expect(result.archivedHistoryTokens).toBe(1000);
    expect(result.retainedArchiveTokens).toBe(1100);
    expect(result.projectedViewTokens).toBe(75);
  });

  it("treats the whole canonical archive as live only before the first LHC view", () => {
    const result = threadViewArrangement(fixture({ withView: false }));

    expect(result.view).toBeNull();
    expect(result.liveTailTokens).toBe(1150);
    expect(result.archivedHistory).toEqual([]);
    expect(result.archivedHistoryTokens).toBe(0);
    expect(result.retainedArchiveTokens).toBe(0);
    expect(result.projectedViewTokens).toBe(1150);
  });

  it("qualifies projected serving, archive estimates, provider input, and actionable work", () => {
    const path = fixture();
    const db = new DatabaseSync(path);
    db.exec(`
      INSERT INTO work_item VALUES ('done', 'completed'), ('queued', 'queued'), ('claimed', 'claimed');
      INSERT INTO derivation VALUES
        ('turn', 'old-selected', 'legacy', 'failed', NULL),
        ('turn', 'old-omitted', 'legacy', 'blocked', NULL);
    `);
    db.close();

    const stats = threadQuickStats(path);
    expect(stats.retainedArchiveTokenEstimate).toBe(1150);
    expect(stats.projectedViewTokenEstimate).toBe(75);
    expect(stats.latestProviderInputTokens).toBe(100);
    expect(stats.activeWorkItems).toBe(2);
    expect(stats.historicalFailedDerivations).toBe(2);
  });

  it("marks the projection as an upper bound when visibility pruning applies", () => {
    const path = fixture();
    const db = new DatabaseSync(path);
    db.exec("INSERT INTO view_boundary(thread_singleton, position) VALUES (1, 50)");
    db.close();

    expect(threadQuickStats(path).projectedViewIsUpperBound).toBe(true);
    expect(threadViewArrangement(path).projectedViewIsUpperBound).toBe(true);
  });
});
