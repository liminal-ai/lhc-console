import { statSync } from "node:fs";
import type { HostDescriptor } from "./hosts.ts";
import { withDb } from "./db.ts";
import { scanHostThreads } from "./scan.ts";

export interface ThreadSummary {
  hostId: string;
  threadId: string;
  filePath: string;
  title: string | null;
  cwd: string | null;
  createdAt: string;
  /** Size of the thread file on disk, null when the file is missing. */
  fileSizeBytes: number | null;
  /** mtime of the thread file (ISO), null when missing. */
  fileMtime: string | null;
  /** Host profile the thread lives under (scan hosts only). */
  profile?: string | null;
  /** Host session id — the thread file's stem (scan hosts only). */
  sessionId?: string | null;
}

interface RegistryRow {
  thread_id: string;
  file_path: string;
  title: string | null;
  cwd: string | null;
  created_at: string;
}

/**
 * Registry-less hosts: identity comes from each thread file, the title from
 * its filename stem (the host session id), and there is no recorded cwd.
 */
function listScannedThreads(host: HostDescriptor): ThreadSummary[] {
  return scanHostThreads(host)
    .map((t) => ({
      hostId: host.id,
      threadId: t.threadId,
      filePath: t.filePath,
      title: t.sessionId,
      cwd: null,
      createdAt: t.createdAt,
      fileSizeBytes: t.fileSizeBytes,
      fileMtime: t.fileMtime,
      profile: t.profile,
      sessionId: t.sessionId,
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** List every thread a host exposes, stat-enriched. */
export function listThreads(host: HostDescriptor): ThreadSummary[] {
  if (host.kind === "scan" || !host.registryPath) return listScannedThreads(host);
  const rows = withDb(host.registryPath, (db) =>
    db
      .prepare(
        "select thread_id, file_path, title, cwd, created_at from threads order by created_at desc",
      )
      .all(),
  ) as unknown as RegistryRow[];

  return rows.map((r) => {
    let fileSizeBytes: number | null = null;
    let fileMtime: string | null = null;
    try {
      const st = statSync(r.file_path);
      fileSizeBytes = st.size;
      fileMtime = st.mtime.toISOString();
    } catch {
      // missing thread file — registry row is a convenience lookup, not authority
    }
    return {
      hostId: host.id,
      threadId: r.thread_id,
      filePath: r.file_path,
      title: r.title,
      cwd: r.cwd,
      createdAt: r.created_at,
      fileSizeBytes,
      fileMtime,
    };
  });
}

/**
 * Resolve a full or unique-prefix thread id within one host's registry.
 * Returns null when nothing matches; throws on an ambiguous prefix.
 */
export function resolveThread(host: HostDescriptor, idOrPrefix: string): ThreadSummary | null {
  const all = listThreads(host);
  const exact = all.find((t) => t.threadId === idOrPrefix);
  if (exact) return exact;
  const matches = all.filter((t) => t.threadId.startsWith(idOrPrefix));
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(
      `ambiguous thread prefix "${idOrPrefix}" in ${host.id}: ${matches
        .map((m) => m.threadId)
        .join(", ")}`,
    );
  }
  return matches[0];
}
