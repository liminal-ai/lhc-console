/**
 * Starting work, rather than resuming it.
 *
 * The console's launch story so far was entirely about existing threads. This
 * is the other half: a *new* LHC session in a directory, or a plain shell.
 * The commands are trivial — the point of computing them here is that they are
 * computed here. A client names a host and a directory; it never names a
 * command, and no path through this module can produce one from client text.
 *
 * A brand-new session also has no thread id yet: the host writes its registry
 * row moments after start. `matchNewborn` is how a terminal finds the row that
 * turned out to be its own.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describeHost } from "./hosts.ts";
import { shArg } from "./launch.ts";

/**
 * Hosts a new session can be started on — never t3code-lhc, which is
 * web-managed and has no local entry point at all. `grok-lhc` and `hermes-lhc`
 * are excluded for the same reason as t3code: no known start command.
 */
const STARTABLE_HOST_IDS = ["cc-lhc", "pi-lhc", "codex-lhc", "hermes"] as const;

/** The startable hosts that actually exist on this machine. */
export function launchableHostIds(presentHostIds: string[]): string[] {
  const present = new Set(presentHostIds);
  return STARTABLE_HOST_IDS.filter((id) => present.has(id));
}

/** Hermes profile names (the default profile is unnamed and always present). */
export function hermesProfiles(): string[] {
  try {
    return readdirSync(join(describeHost("hermes").home, "profiles"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return []; // no profiles directory: the default profile is the whole host
  }
}

export type NewTerminalKind = "newSession" | "shell";

export interface NewSessionRequest {
  kind: NewTerminalKind;
  hostId?: string | null;
  cwd?: string | null;
  /** Hermes only: which profile to start in. Null/absent means the default. */
  profile?: string | null;
}

/** What the caller's machine offers, passed in so planning stays pure. */
export interface NewSessionEnv {
  /** Host ids that may be started here — see `launchableHostIds`. */
  launchable: string[];
  /** Named hermes profiles, for validating `profile`. */
  hermesProfiles: string[];
  /** Where hermes is spawned (it ignores cwd and restores its own). */
  home: string;
  /** `$SHELL`, when the environment has one. */
  shell: string | null;
}

export type NewSessionPlan =
  | {
      ok: true;
      kind: NewTerminalKind;
      /** Host the session belongs to; "shell" for a plain shell. */
      hostId: string;
      command: string;
      /** Directory the pty is spawned in. */
      cwd: string;
      /** Tab label until a thread row shows up and renames it. */
      title: string;
      /** Directory the newborn thread's registry row must match; null for shells. */
      matchCwd: string | null;
    }
  | { ok: false; error: string };

/**
 * Trim a typed directory. Tab-completion in the picker leaves a trailing
 * slash (it means "look inside"), which would otherwise end up in the command
 * and in the cwd the association match compares against.
 */
function tidyDir(raw: string | null | undefined): string {
  const cwd = raw?.trim() ?? "";
  return cwd.length > 1 && cwd.endsWith("/") ? cwd.replace(/\/+$/, "") || "/" : cwd;
}

function baseName(path: string): string {
  const trimmed = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  const cut = trimmed.lastIndexOf("/");
  return cut < 0 ? trimmed : trimmed.slice(cut + 1) || "/";
}

/**
 * Turn a host + directory into a command, or say why it cannot.
 *
 * Directory *existence* is checked by the caller (this stays free of fs so it
 * can be tested as a function of its inputs); everything else — the host being
 * startable at all, the profile being one that exists — is decided here.
 */
export function planNewSession(req: NewSessionRequest, env: NewSessionEnv): NewSessionPlan {
  if (req.kind === "shell") {
    const cwd = tidyDir(req.cwd);
    if (!cwd) return { ok: false, error: "a directory is required" };
    // `exec` so the pane's process IS the shell: no bash wrapper to outlive it.
    const shell = env.shell && env.shell.startsWith("/") ? env.shell : "/bin/bash";
    return {
      ok: true,
      kind: "shell",
      hostId: "shell",
      command: `cd ${shArg(cwd)} && exec ${shArg(shell)} -l`,
      cwd,
      title: `sh: ${baseName(cwd)}`,
      matchCwd: null,
    };
  }

  const hostId = req.hostId?.trim();
  if (!hostId) return { ok: false, error: "hostId is required" };
  if (!(STARTABLE_HOST_IDS as readonly string[]).includes(hostId)) {
    return { ok: false, error: `no new-session command is known for host ${hostId}` };
  }
  if (!env.launchable.includes(hostId)) {
    return { ok: false, error: `host ${hostId} is not installed here` };
  }

  if (hostId === "hermes") {
    // Hermes stores per profile and restores each session's own cwd, so the
    // directory is not a parameter at all — the profile is.
    const profile = req.profile?.trim() || null;
    if (profile && !env.hermesProfiles.includes(profile)) {
      return { ok: false, error: `unknown hermes profile "${profile}"` };
    }
    return {
      ok: true,
      kind: "newSession",
      hostId,
      command: profile ? `hermes --profile ${shArg(profile)}` : "hermes",
      cwd: env.home,
      title: `hermes: ${profile ?? "default"}`,
      matchCwd: null,
    };
  }

  const cwd = tidyDir(req.cwd);
  if (!cwd) return { ok: false, error: "a directory is required" };
  if (!cwd.startsWith("/")) return { ok: false, error: "the directory must be an absolute path" };
  return {
    ok: true,
    kind: "newSession",
    hostId,
    command: `cd ${shArg(cwd)} && ${hostId}`,
    cwd,
    title: `${hostId}: ${baseName(cwd)}`,
    matchCwd: cwd,
  };
}

// --- newborn thread association ---------------------------------------------

/** A registry row, reduced to what association needs. */
export interface NewbornCandidate {
  threadId: string;
  cwd: string | null;
  createdAt: string;
  title: string | null;
}

export interface NewbornQuery {
  /** The directory the session was started in. */
  cwd: string;
  /** ISO instant the pty was spawned. */
  spawnedAt: string;
  /** Thread ids already claimed by another terminal. */
  taken?: Iterable<string>;
  /** How far before the spawn a row may be dated and still count. */
  graceMs?: number;
}

/** Clocks are not synchronised with intent: a row written the instant before
 * the spawn is still plausibly ours, so the window opens slightly early. */
const DEFAULT_GRACE_MS = 10_000;

function sameDir(a: string | null, b: string): boolean {
  if (!a) return false;
  const norm = (p: string): string => (p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p);
  return norm(a) === norm(b);
}

/**
 * The registry row a freshly spawned session most likely wrote: same
 * directory, created inside the spawn window, not already claimed. Newest
 * wins when two qualify — a second session started in the same directory a
 * moment later takes the newer row, which is the one it just made.
 */
export function matchNewborn(
  rows: NewbornCandidate[],
  query: NewbornQuery,
): NewbornCandidate | null {
  const floor = Date.parse(query.spawnedAt) - (query.graceMs ?? DEFAULT_GRACE_MS);
  if (Number.isNaN(floor)) return null;
  const taken = new Set(query.taken ?? []);
  let best: NewbornCandidate | null = null;
  let bestAt = -Infinity;
  for (const r of rows) {
    if (taken.has(r.threadId)) continue;
    if (!sameDir(r.cwd, query.cwd)) continue;
    const at = Date.parse(r.createdAt);
    if (Number.isNaN(at) || at < floor) continue;
    if (at > bestAt) {
      best = r;
      bestAt = at;
    }
  }
  return best;
}
