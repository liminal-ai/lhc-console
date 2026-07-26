import { statSync } from "node:fs";
import type { HostDescriptor } from "./hosts.ts";
import { withDb } from "./db.ts";

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
}

interface RegistryRow {
  thread_id: string;
  file_path: string;
  title: string | null;
  cwd: string | null;
  created_at: string;
}

/** List every thread in a host's registry, stat-enriched. */
export function listThreads(host: HostDescriptor): ThreadSummary[] {
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
