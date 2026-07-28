import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  mergeName,
  nameKey,
  normalizeNames,
  type ThreadName,
  type ThreadNamePatch,
} from "@lhc-console/core";

/**
 * Console-owned preferences. This is the ONLY file the console writes —
 * every host SQLite stays read-only. Kept out of `packages/core` on purpose:
 * core is a pure read layer over host files.
 */

export interface HiddenEntry {
  hiddenAt: string;
}

/**
 * Where the new-session path picker starts. One default root, plus a per-host
 * override the file shape supports and no UI writes yet — the shape is here so
 * a hand-edited prefs file already works when the UI arrives.
 */
export interface NewSessionPrefs {
  defaultRoot: string;
  rootByHost: Record<string, string>;
}

export interface Prefs {
  hiddenThreads: Record<string, HiddenEntry>;
  newSession: NewSessionPrefs;
  /**
   * The console's own title and description per thread, keyed
   * `hostId/threadId`. Overlays what the host registry calls a thread; the
   * registry itself is never touched.
   */
  names: Record<string, ThreadName>;
}

/** The root the picker seeds with when nothing else says otherwise. */
export const DEFAULT_NEW_SESSION_ROOT = "/srv/work";

function prefsDir(): string {
  return process.env.LHC_CONSOLE_HOME ?? join(homedir(), ".lhc-console");
}

function prefsPath(): string {
  return join(prefsDir(), "prefs.json");
}

/** Composite key; hiding is always per host + resolved full thread id. */
export function hiddenKey(hostId: string, threadId: string): string {
  return `${hostId}/${threadId}`;
}

let cache: Prefs | null = null;
/** The directory the cache was loaded from, so an env change reloads. */
let cachedDir: string | null = null;
/** A corrupt file is only ever backed up once per process. */
let salvaged = false;

function empty(): Prefs {
  return {
    hiddenThreads: {},
    newSession: { defaultRoot: DEFAULT_NEW_SESSION_ROOT, rootByHost: {} },
    names: {},
  };
}

function normalize(raw: unknown): Prefs {
  const p = empty();
  if (!raw || typeof raw !== "object") return p;
  const hidden = (raw as { hiddenThreads?: unknown }).hiddenThreads;
  if (hidden && typeof hidden === "object") {
    for (const [key, value] of Object.entries(hidden as Record<string, unknown>)) {
      const at = (value as { hiddenAt?: unknown } | null)?.hiddenAt;
      p.hiddenThreads[key] = { hiddenAt: typeof at === "string" ? at : new Date(0).toISOString() };
    }
  }
  const ns = (raw as { newSession?: unknown }).newSession;
  if (ns && typeof ns === "object") {
    const root = (ns as { defaultRoot?: unknown }).defaultRoot;
    if (typeof root === "string" && root.startsWith("/")) p.newSession.defaultRoot = root;
    const byHost = (ns as { rootByHost?: unknown }).rootByHost;
    if (byHost && typeof byHost === "object") {
      for (const [host, value] of Object.entries(byHost as Record<string, unknown>)) {
        if (typeof value === "string" && value.startsWith("/"))
          p.newSession.rootByHost[host] = value;
      }
    }
  }
  // The trim/cap/empty-is-absent rules live in core, so a hand-edited file
  // reads exactly like one the API wrote.
  p.names = normalizeNames((raw as { names?: unknown }).names);
  return p;
}

/** Lazy load; a missing file is simply "no prefs yet", a corrupt one is salvaged. */
export function loadPrefs(): Prefs {
  const dir = prefsDir();
  if (cache && cachedDir === dir) return cache;
  let text: string | null = null;
  try {
    text = readFileSync(prefsPath(), "utf8");
  } catch {
    // No prefs file yet (or unreadable) — start empty, write on first change.
  }
  let parsed: Prefs;
  if (text === null) {
    parsed = empty();
  } else {
    try {
      parsed = normalize(JSON.parse(text));
    } catch {
      // Corrupt JSON: keep a copy once so nothing is silently destroyed.
      if (!salvaged) {
        salvaged = true;
        try {
          renameSync(prefsPath(), `${prefsPath()}.bad`);
        } catch {
          // Best effort; an unwritable dir must not take the server down.
        }
      }
      parsed = empty();
    }
  }
  cache = parsed;
  cachedDir = dir;
  return parsed;
}

/** Atomic write: tmp file in the same dir, then rename over the target. */
function savePrefs(p: Prefs): void {
  const dir = prefsDir();
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.prefs.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(p, null, 2)}\n`, "utf8");
  renameSync(tmp, prefsPath());
  cache = p;
  cachedDir = dir;
}

export function isHidden(hostId: string, threadId: string): boolean {
  return hiddenKey(hostId, threadId) in loadPrefs().hiddenThreads;
}

export function hiddenCount(): number {
  return Object.keys(loadPrefs().hiddenThreads).length;
}

/** Hide a thread. Idempotent — an already-hidden thread keeps its timestamp. */
export function hideThread(hostId: string, threadId: string): number {
  const p = loadPrefs();
  const key = hiddenKey(hostId, threadId);
  if (!(key in p.hiddenThreads)) {
    p.hiddenThreads[key] = { hiddenAt: new Date().toISOString() };
    savePrefs(p);
  }
  return Object.keys(p.hiddenThreads).length;
}

/** Unhide a thread. Idempotent — unhiding a visible thread is a no-op. */
export function unhideThread(hostId: string, threadId: string): number {
  const p = loadPrefs();
  const key = hiddenKey(hostId, threadId);
  if (key in p.hiddenThreads) {
    delete p.hiddenThreads[key];
    savePrefs(p);
  }
  return Object.keys(p.hiddenThreads).length;
}

/** The console's own name for a thread, or null when it has never been named. */
export function threadName(hostId: string, threadId: string): ThreadName | null {
  return loadPrefs().names[nameKey(hostId, threadId)] ?? null;
}

/**
 * Partial update of one thread's name: an absent field keeps what is stored,
 * null clears it, and an entry with nothing left in it is removed rather than
 * kept as a pair of nulls. Returns what is now stored (null when deleted).
 *
 * A patch that changes neither field does not rewrite the file — the batch
 * job that fills these in runs many times over the same rows.
 */
export function setThreadName(
  hostId: string,
  threadId: string,
  patch: ThreadNamePatch,
): ThreadName | null {
  const p = loadPrefs();
  const key = nameKey(hostId, threadId);
  const current = p.names[key];
  const merged = mergeName(current, patch);
  if (
    (merged?.title ?? null) === (current?.title ?? null) &&
    (merged?.description ?? null) === (current?.description ?? null)
  ) {
    return current ?? null;
  }
  if (merged) p.names[key] = merged;
  else delete p.names[key];
  savePrefs(p);
  return merged;
}

/** Where the new-session picker should start, overall and per host. */
export function newSessionRoots(): NewSessionPrefs {
  return loadPrefs().newSession;
}

/** Test seam: drop the memo so a changed LHC_CONSOLE_HOME is re-read. */
export function resetPrefsCache(): void {
  cache = null;
  cachedDir = null;
}
