/**
 * Directory browsing for the path picker.
 *
 * The client types a partial path and gets back the directories that could
 * continue it. Everything is read-only and bounded: one readdir per keystroke
 * (debounced client-side), directories only, and a hard cap so a directory of
 * ten thousand entries cannot become a payload.
 *
 * Errors are values, not exceptions — a nonexistent parent is an ordinary
 * state while someone is mid-word, and the picker prints the reason inline
 * rather than breaking.
 */

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Entries returned for one query. Beyond this the result is `truncated`. */
export const BROWSE_LIMIT = 50;

export interface BrowseSplit {
  /** Directory to read. Empty when the partial is not an absolute path. */
  parentDir: string;
  /** What the last segment has to start with; "" lists the whole directory. */
  prefix: string;
}

export interface BrowseEntry {
  name: string;
  path: string;
}

export interface BrowseResult extends BrowseSplit {
  entries: BrowseEntry[];
  /** More directories matched than the cap allows. */
  truncated: boolean;
  /** Short reason the listing is empty; absent when the read succeeded. */
  error?: string;
}

/**
 * Split a partial path into the directory to read and the prefix to match.
 *
 * `/srv/work` means "things in /srv starting with work" and `/srv/work/` means
 * "everything in /srv/work" — the trailing slash is the whole difference, and
 * it is what makes Tab-to-descend feel right. A leading `~` expands, because
 * people type it.
 */
export function splitBrowsePath(partial: string, home: string = homedir()): BrowseSplit {
  let s = partial.trim();
  if (s === "~" || s.startsWith("~/")) s = home + s.slice(1);
  if (!s.startsWith("/")) return { parentDir: "", prefix: s };
  const cut = s.lastIndexOf("/");
  return { parentDir: cut === 0 ? "/" : s.slice(0, cut), prefix: s.slice(cut + 1) };
}

/** One sentence for the picker, from whatever the filesystem threw. */
function reasonFor(e: unknown): string {
  const code = (e as { code?: string } | null)?.code;
  if (code === "ENOENT") return "no such directory";
  if (code === "ENOTDIR") return "not a directory";
  if (code === "EACCES" || code === "EPERM") return "permission denied";
  return e instanceof Error ? e.message : String(e);
}

function isDir(dir: string, name: string, isSymlink: boolean): boolean {
  if (!isSymlink) return true;
  try {
    // A symlink into a directory is a directory as far as `cd` is concerned.
    return statSync(join(dir, name)).isDirectory();
  } catch {
    return false; // dangling link
  }
}

/**
 * Directories under the partial path's parent whose name starts with its
 * prefix, case-insensitively. Dot directories stay out of the way unless the
 * prefix itself starts with a dot — asking for `.` is asking for them.
 */
export function browseDirs(
  partial: string,
  limit: number = BROWSE_LIMIT,
  home: string = homedir(),
): BrowseResult {
  const split = splitBrowsePath(partial, home);
  if (!split.parentDir) {
    return { ...split, entries: [], truncated: false, error: "type an absolute path" };
  }
  let names: { name: string; dir: boolean; link: boolean }[];
  try {
    names = readdirSync(split.parentDir, { withFileTypes: true }).map((d) => ({
      name: d.name,
      dir: d.isDirectory(),
      link: d.isSymbolicLink(),
    }));
  } catch (e) {
    return { ...split, entries: [], truncated: false, error: reasonFor(e) };
  }
  const wantHidden = split.prefix.startsWith(".");
  const needle = split.prefix.toLowerCase();
  const matched = names
    .filter((d) => d.dir || d.link)
    .filter((d) => wantHidden || !d.name.startsWith("."))
    .filter((d) => d.name.toLowerCase().startsWith(needle))
    .filter((d) => isDir(split.parentDir, d.name, !d.dir))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));
  const entries = matched.slice(0, limit).map((name) => ({
    name,
    path: split.parentDir === "/" ? `/${name}` : `${split.parentDir}/${name}`,
  }));
  return { ...split, entries, truncated: matched.length > entries.length };
}

/** Does this path exist and is it a directory? The one check a spawn needs. */
export function isExistingDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
