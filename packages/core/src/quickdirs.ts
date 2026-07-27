/**
 * "Quick selects" for the path picker: the directories work actually happens
 * in, ranked by how recently anything happened there.
 *
 * Derived from the thread rows the list already has — no new file reads, no
 * pinning, no user-maintained list. Recency does the ranking, and the
 * annotation (thread count, which hosts, when) is what makes a bare path
 * recognisable at a glance.
 */

/** One thread's contribution: where it ran, on which host, when it last moved. */
export interface QuickDirInput {
  hostId: string;
  cwd: string | null;
  /** ISO instant of the thread's last activity; null rows are ignored. */
  lastActiveAt: string | null;
}

export interface QuickDir {
  path: string;
  basename: string;
  threadCount: number;
  /** Hosts that have threads here, alphabetical. */
  hosts: string[];
  lastActiveAt: string;
}

/** Directories offered as quick selects. Beyond this, browsing is the answer. */
export const QUICK_DIR_LIMIT = 15;

function basenameOf(path: string): string {
  const trimmed = path.endsWith("/") && path.length > 1 ? path.slice(0, -1) : path;
  const cut = trimmed.lastIndexOf("/");
  return cut < 0 ? trimmed : trimmed.slice(cut + 1) || "/";
}

/**
 * Distinct cwds across every host, most recently active first.
 *
 * Rows without a cwd are skipped — hermes threads have none, and a thread with
 * no directory cannot seed a new session anywhere.
 */
export function quickDirs(rows: QuickDirInput[], limit: number = QUICK_DIR_LIMIT): QuickDir[] {
  const byPath = new Map<string, { hosts: Set<string>; count: number; last: string }>();
  for (const r of rows) {
    if (!r.cwd || !r.lastActiveAt) continue;
    const path = r.cwd.length > 1 && r.cwd.endsWith("/") ? r.cwd.slice(0, -1) : r.cwd;
    const hit = byPath.get(path);
    if (hit) {
      hit.count += 1;
      hit.hosts.add(r.hostId);
      if (r.lastActiveAt > hit.last) hit.last = r.lastActiveAt;
    } else {
      byPath.set(path, { hosts: new Set([r.hostId]), count: 1, last: r.lastActiveAt });
    }
  }
  return [...byPath.entries()]
    .map(([path, v]) => ({
      path,
      basename: basenameOf(path),
      threadCount: v.count,
      hosts: [...v.hosts].sort(),
      lastActiveAt: v.last,
    }))
    .sort(
      (a, b) =>
        b.lastActiveAt.localeCompare(a.lastActiveAt) ||
        b.threadCount - a.threadCount ||
        a.path.localeCompare(b.path),
    )
    .slice(0, limit);
}
