import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { HostDescriptor } from "./hosts.ts";
import { withDb } from "./db.ts";

/** Identity read out of a thread file's `thread_metadata` row. */
interface FileIdentity {
  threadId: string;
  createdAt: string;
}

/**
 * Identity per (path, mtime, size). Thread files are appended to constantly but
 * their identity never changes, so an unchanged file is never reopened; a
 * `null` value memoises "this file is unreadable or has no metadata".
 */
const identityCache = new Map<string, { key: string; identity: FileIdentity | null }>();

function readIdentity(filePath: string, key: string): FileIdentity | null {
  const hit = identityCache.get(filePath);
  if (hit && hit.key === key) return hit.identity;
  let identity: FileIdentity | null = null;
  try {
    identity = withDb(filePath, (db) => {
      const row = db
        .prepare("select thread_id, created_at from thread_metadata order by id limit 1")
        .get() as unknown as { thread_id?: string; created_at?: string } | undefined;
      if (!row?.thread_id) return null;
      return { threadId: row.thread_id, createdAt: row.created_at ?? "" };
    });
  } catch {
    // partial write, corrupt file, or a non-lhc sqlite — skip it silently
    identity = null;
  }
  identityCache.set(filePath, { key, identity });
  return identity;
}

/** One scanned thread file that carries usable identity. */
export interface ScannedThread {
  filePath: string;
  /** Filename stem — the host's session id (e.g. `20260721_174211_b5d6a6`). */
  sessionId: string;
  profile: string | null;
  threadId: string;
  createdAt: string;
  fileSizeBytes: number;
  fileMtime: string;
}

/**
 * Enumerate every readable thread file under a scan host's roots. Files that
 * fail to open or lack `thread_metadata` are skipped.
 */
export function scanHostThreads(host: HostDescriptor): ScannedThread[] {
  const out: ScannedThread[] = [];
  for (const root of host.scanRoots) {
    let names: string[];
    try {
      names = readdirSync(root.dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".sqlite")) continue; // ignores -wal / -shm sidecars
      const filePath = join(root.dir, name);
      let st;
      try {
        st = statSync(filePath);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const mtime = st.mtime.toISOString();
      const identity = readIdentity(filePath, `${mtime}:${st.size}`);
      if (!identity) continue;
      out.push({
        filePath,
        sessionId: name.slice(0, -".sqlite".length),
        profile: root.profile,
        threadId: identity.threadId,
        createdAt: identity.createdAt,
        fileSizeBytes: st.size,
        fileMtime: mtime,
      });
    }
  }
  return out;
}
