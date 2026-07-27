import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Console-owned preferences. This is the ONLY file the console writes —
 * every host SQLite stays read-only. Kept out of `packages/core` on purpose:
 * core is a pure read layer over host files.
 */

export interface HiddenEntry {
  hiddenAt: string;
}

export interface Prefs {
  hiddenThreads: Record<string, HiddenEntry>;
}

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
  return { hiddenThreads: {} };
}

function normalize(raw: unknown): Prefs {
  const p = empty();
  if (!raw || typeof raw !== "object") return p;
  const hidden = (raw as { hiddenThreads?: unknown }).hiddenThreads;
  if (!hidden || typeof hidden !== "object") return p;
  for (const [key, value] of Object.entries(hidden as Record<string, unknown>)) {
    const at = (value as { hiddenAt?: unknown } | null)?.hiddenAt;
    p.hiddenThreads[key] = { hiddenAt: typeof at === "string" ? at : new Date(0).toISOString() };
  }
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

/** Test seam: drop the memo so a changed LHC_CONSOLE_HOME is re-read. */
export function resetPrefsCache(): void {
  cache = null;
  cachedDir = null;
}
