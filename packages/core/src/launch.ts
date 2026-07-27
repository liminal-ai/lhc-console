import { statSync } from "node:fs";
import { join } from "node:path";
import { describeHost } from "./hosts.ts";
import type { ThreadSummary } from "./registry.ts";
import { withDb } from "./db.ts";

/** The command that resumes a thread in its own host. */
export interface LaunchRecipe {
  command: string;
}

/** Shell-quote only when the value has characters a shell would treat specially. */
function shArg(value: string): string {
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

/**
 * The command that resumes this thread on its host, or null when the host has
 * no resume path (t3code is web-managed) or its lineage is unknown.
 */
export function launchRecipe(thread: ThreadSummary): LaunchRecipe | null {
  switch (thread.hostId) {
    case "pi-lhc":
      return { command: withCwd(thread.cwd, `pi-lhc --lhc-thread ${shArg(thread.threadId)}`) };
    case "cc-lhc": {
      const sid = lineageFor("cc-lhc").get(thread.threadId);
      return sid ? { command: withCwd(thread.cwd, `cc-lhc --resume ${shArg(sid)}`) } : null;
    }
    case "codex-lhc": {
      const sid = lineageFor("codex-lhc").get(thread.threadId);
      return sid ? { command: withCwd(thread.cwd, `codex-lhc resume ${shArg(sid)}`) } : null;
    }
    case "hermes": {
      if (!thread.sessionId) return null;
      // Hermes restores the session's own recorded cwd, so no `cd` part.
      const profile = thread.profile ? `--profile ${shArg(thread.profile)} ` : "";
      return { command: `hermes ${profile}--resume ${shArg(thread.sessionId)}` };
    }
    default:
      return null;
  }
}
