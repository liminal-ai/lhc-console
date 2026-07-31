import { statSync } from "node:fs";
import { join } from "node:path";
import { recoverRolloutSessionId } from "./cc-rollout.ts";
import { describeHost } from "./hosts.ts";
import type { ThreadSummary } from "./registry.ts";
import { withDb } from "./db.ts";

/**
 * How a thread resumes on its host.
 *
 * Every non-t3code thread gets one of these, even when there is no command to
 * run: "no recipe → no affordance" left the user staring at rows with nothing
 * to click and no explanation, which is worse than an honest dead end. When
 * `command` is null, `reason` says why in one sentence the UI can print.
 */
export interface LaunchRecipe {
  /** The command to run, or null when this thread cannot be resumed. */
  command: string | null;
  /**
   * The identifier the host resumes by — cc/codex lineage session id, the
   * hermes session stem, the thread id for pi-lhc. Null when the host resumes
   * without one. Attach detection matches this against live process args, so
   * it is computed here rather than re-derived (and re-read) downstream.
   */
  sessionRef: string | null;
  /** Why there is no command. Only set when `command` is null. */
  reason?: string;
  /** Session id found in the rollout files rather than the lineage DB. */
  recovered?: boolean;
  /**
   * The command resumes something weaker than this exact session:
   * `"continue"` means `--continue`, i.e. the newest session in the cwd.
   */
  fallback?: "continue";
}

/** Shell-quote only when the value has characters a shell would treat specially. */
export function shArg(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function withCwd(cwd: string | null, command: string): string {
  return cwd ? `cd ${shArg(cwd)} && ${command}` : command;
}

interface LineageSpec {
  /** Lineage DB filename inside the host home. */
  file: string;
  table: string;
}

const LINEAGE: Record<string, LineageSpec> = {
  "cc-lhc": { file: "cc-lhc.sqlite", table: "cc_session_lineage" },
  "codex-lhc": { file: "codex-lhc.sqlite", table: "codex_session_lineage" },
};

/**
 * Newest session id per thread, keyed by lineage DB path and invalidated on
 * mtime — these DBs are tiny, so one read serves a whole list request.
 */
const lineageCache = new Map<string, { key: string; byThread: Map<string, string> }>();

function lineageFor(hostId: string): Map<string, string> {
  const spec = LINEAGE[hostId];
  if (!spec) return new Map();
  const path = join(describeHost(hostId).home, spec.file);
  let key: string;
  try {
    const st = statSync(path);
    key = `${st.mtimeMs}:${st.size}`;
  } catch {
    return new Map(); // no lineage DB on this machine
  }
  const hit = lineageCache.get(path);
  if (hit && hit.key === key) return hit.byThread;

  const byThread = new Map<string, string>();
  try {
    withDb(path, (db) => {
      // Column names differ per host; the session id is the table's own key.
      const cols = db.prepare(`pragma table_info(${spec.table})`).all() as unknown as {
        name: string;
      }[];
      const idCol = cols.find((c) => c.name.endsWith("session_id"))?.name;
      if (!idCol) return;
      const rows = db
        .prepare(
          `select ${idCol} sid, thread_id, updated_at from ${spec.table} order by updated_at`,
        )
        .all() as unknown as { sid: string; thread_id: string }[];
      // Ascending order means the last row per thread wins — the newest one.
      for (const r of rows) if (r.sid && r.thread_id) byThread.set(r.thread_id, r.sid);
    });
  } catch {
    // missing table or corrupt lineage DB — treat as "no lineage"
  }
  lineageCache.set(path, { key, byThread });
  return byThread;
}

function unavailable(reason: string): LaunchRecipe {
  return { command: null, sessionRef: null, reason };
}

/*
 * Console launches run unattended in workspace panes, so the underlying
 * harnesses skip their per-action permission prompts. cc-lhc passes unknown
 * flags through to claude; codex-lhc passes them through to codex.
 */
export const CC_SKIP_PERMISSIONS = "--dangerously-skip-permissions";
export const CODEX_SKIP_PERMISSIONS = "--dangerously-bypass-approvals-and-sandbox";

/**
 * How this thread resumes on its host. Null only for hosts with no resume path
 * at all (t3code is web-managed) — every other thread gets a recipe, which may
 * itself carry `command: null` plus a reason.
 */
export function launchRecipe(thread: ThreadSummary): LaunchRecipe | null {
  switch (thread.hostId) {
    case "pi-lhc":
      return {
        command: withCwd(thread.cwd, `pi-lhc --lhc-thread ${shArg(thread.threadId)}`),
        sessionRef: thread.threadId,
      };
    case "cc-lhc": {
      const sid = lineageFor("cc-lhc").get(thread.threadId);
      if (sid)
        return {
          command: withCwd(thread.cwd, `cc-lhc ${CC_SKIP_PERMISSIONS} --resume ${shArg(sid)}`),
          sessionRef: sid,
        };
      /*
       * No lineage row. That DB is wipeable and has been wiped, so treat its
       * silence as missing bookkeeping rather than a missing session: look the
       * id up in Claude Code's own rollout files, and fall back to
       * `--continue` (newest session in this directory) when even that misses.
       */
      if (!thread.cwd) {
        return unavailable(
          "no lineage row for this thread and no recorded directory, so there is nothing to resume by",
        );
      }
      const recovered = recoverRolloutSessionId(thread.filePath, thread.cwd, thread.fileMtime);
      if (recovered) {
        return {
          command: withCwd(
            thread.cwd,
            `cc-lhc ${CC_SKIP_PERMISSIONS} --resume ${shArg(recovered)}`,
          ),
          sessionRef: recovered,
          recovered: true,
        };
      }
      return {
        command: withCwd(thread.cwd, `cc-lhc ${CC_SKIP_PERMISSIONS} --continue`),
        sessionRef: null,
        fallback: "continue",
      };
    }
    case "codex-lhc": {
      const sid = lineageFor("codex-lhc").get(thread.threadId);
      return sid
        ? {
            command: withCwd(
              thread.cwd,
              `codex-lhc resume ${CODEX_SKIP_PERMISSIONS} ${shArg(sid)}`,
            ),
            sessionRef: sid,
          }
        : unavailable(
            "no codex session lineage row for this thread, so the session id to resume is unknown",
          );
    }
    case "hermes": {
      if (!thread.sessionId) {
        return unavailable("this hermes thread has no session file stem to resume by");
      }
      // Hermes restores the session's own recorded cwd, so no `cd` part.
      const profile = thread.profile ? `--profile ${shArg(thread.profile)} ` : "";
      return {
        command: `hermes ${profile}--resume ${shArg(thread.sessionId)}`,
        sessionRef: thread.sessionId,
      };
    }
    case "t3code-lhc":
      return null; // web-managed host: nothing to launch, no affordance
    default:
      return unavailable(`no resume path is known for host ${thread.hostId}`);
  }
}
