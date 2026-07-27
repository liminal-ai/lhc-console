/**
 * Lineage-independent recovery of a cc-lhc thread's rollout session id.
 *
 * `~/.cc-lhc/cc-lhc.sqlite` maps thread → rollout session, but that DB is
 * fragile (it has been wiped, and the host home is littered with
 * `cc-lhc.sqlite.corrupt-*` files). When the mapping is gone the thread is
 * still perfectly resumable — the evidence just lives elsewhere.
 *
 * Every cc-lhc event carries an idempotency key shaped
 * `cc-lhc:rollout:<lineUuid>:<blockIndex>:<kind>`, where `lineUuid` is the
 * `uuid` of the line in Claude Code's own rollout JSONL. Those rollouts live at
 * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, so finding the file
 * that contains one of the thread's line uuids names the session.
 *
 * Everything here is read-only, and bounded: a handful of uuids, at most
 * `MAX_FILES` candidate rollouts, and head/tail slices rather than whole files
 * (a project directory can hold 200 rollouts and tens of MB).
 */

import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { withDb } from "./db.ts";

/** Candidate rollout files opened before giving up. */
const MAX_FILES = 6;
/** Bytes read from the start of a rollout. */
const HEAD_BYTES = 128 * 1024;
/** Bytes read from the end of a rollout — where recent events land. */
const TAIL_BYTES = 512 * 1024;
/** Beyond this, only the tail is read; a head seek would cost too much. */
const BIG_FILE_BYTES = 50 * 1024 * 1024;
/** Line uuids pulled from the thread, newest first. */
const UUID_SAMPLE = 20;

/**
 * Claude Code's project-directory encoding: every character that is not
 * ASCII-alphanumeric becomes `-`. Verified against the real directory names
 * (`/srv/work/lhc-console` → `-srv-work-lhc-console`,
 * `/tmp/claude-1000/-home-leemoore/…` → `-tmp-claude-1000--home-leemoore-…`,
 * which shows the mapping is per-character and case-preserving).
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function claudeProjectsRoot(): string {
  return process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), ".claude", "projects");
}

interface ThreadTrace {
  /** Distinct rollout line uuids, newest event first. */
  uuids: string[];
  /** Epoch ms of the newest event, for candidate ordering. Null when unknown. */
  lastEventMs: number | null;
}

/** Newest rollout line uuids recorded by this thread, read-only. */
function readTrace(threadFilePath: string): ThreadTrace {
  try {
    return withDb(threadFilePath, (db) => {
      const rows = db
        .prepare(
          `select idempotency_key k, recorded_at r from event
             where idempotency_key like 'cc-lhc:rollout:%'
             order by event_order desc limit ?`,
        )
        .all(UUID_SAMPLE) as unknown as { k: string; r: string | null }[];
      const uuids: string[] = [];
      for (const row of rows) {
        // cc-lhc : rollout : <lineUuid> : <blockIndex> : <kind>
        const uuid = row.k.split(":")[2];
        if (uuid && !uuids.includes(uuid)) uuids.push(uuid);
      }
      const stamp = rows[0]?.r ? new Date(rows[0].r).getTime() : Number.NaN;
      return { uuids, lastEventMs: Number.isNaN(stamp) ? null : stamp };
    });
  } catch {
    return { uuids: [], lastEventMs: null };
  }
}

interface Candidate {
  sessionId: string;
  path: string;
  mtimeMs: number;
  size: number;
}

/**
 * Rollout files for a cwd, in the order worth opening.
 *
 * Two signals, interleaved rather than ranked, because each fails on the
 * other's easy case: newest-mtime finds the session that is live right now,
 * while nearest-to-the-thread's-last-event finds a thread parked months ago in
 * a directory with 160 rollouts. Interleaving costs one extra open in the worst
 * case and recovered 9 of 10 real threads where either alone recovered 6.
 */
function orderedCandidates(cwd: string, lastEventMs: number | null): Candidate[] {
  const dir = join(claudeProjectsRoot(), encodeProjectDir(cwd));
  let all: Candidate[];
  try {
    all = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .flatMap((f) => {
        try {
          const st = statSync(join(dir, f));
          return [
            {
              sessionId: f.slice(0, -".jsonl".length),
              path: join(dir, f),
              mtimeMs: st.mtimeMs,
              size: st.size,
            },
          ];
        } catch {
          return [];
        }
      });
  } catch {
    return []; // no project directory for this cwd
  }
  const newest = [...all].sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (lastEventMs === null) return newest;
  const nearest = [...all].sort(
    (a, b) => Math.abs(a.mtimeMs - lastEventMs) - Math.abs(b.mtimeMs - lastEventMs),
  );
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < all.length; i += 1) {
    for (const c of [newest[i], nearest[i]]) {
      if (c && !seen.has(c.sessionId)) {
        seen.add(c.sessionId);
        out.push(c);
      }
    }
  }
  return out;
}

/** Does this rollout mention any of the thread's line uuids? */
function fileMentions(c: Candidate, uuids: string[]): boolean {
  let fd: number;
  try {
    fd = openSync(c.path, "r");
  } catch {
    return false;
  }
  try {
    const slice = (pos: number, len: number): string => {
      const want = Math.min(len, c.size - pos);
      if (want <= 0) return "";
      const buf = Buffer.alloc(want);
      readSync(fd, buf, 0, want, pos);
      return buf.toString("utf8");
    };
    // The tail first: a resumed session appends, so the thread's newest events
    // are its newest lines.
    const tail = slice(Math.max(0, c.size - TAIL_BYTES), TAIL_BYTES);
    if (uuids.some((u) => tail.includes(u))) return true;
    if (c.size > BIG_FILE_BYTES) return false;
    const head = slice(0, HEAD_BYTES);
    return uuids.some((u) => head.includes(u));
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

/** Cache keyed by thread file, invalidated when the thread file changes. */
const cache = new Map<string, { key: string; sessionId: string | null }>();

/**
 * The rollout session id for a cc-lhc thread, found without the lineage DB.
 * Null when the thread has no cwd, no rollout-keyed events, no project
 * directory, or no candidate within the scan bound.
 */
export function recoverRolloutSessionId(
  threadFilePath: string,
  cwd: string | null,
  fileMtime?: string | null,
): string | null {
  if (!cwd) return null;
  let key = fileMtime ?? "";
  if (!key) {
    try {
      key = String(statSync(threadFilePath).mtimeMs);
    } catch {
      return null;
    }
  }
  const hit = cache.get(threadFilePath);
  if (hit && hit.key === key) return hit.sessionId;

  const trace = readTrace(threadFilePath);
  let found: string | null = null;
  if (trace.uuids.length > 0) {
    for (const c of orderedCandidates(cwd, trace.lastEventMs).slice(0, MAX_FILES)) {
      if (fileMentions(c, trace.uuids)) {
        found = c.sessionId;
        break;
      }
    }
  }
  cache.set(threadFilePath, { key, sessionId: found });
  return found;
}
