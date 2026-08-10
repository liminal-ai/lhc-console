/**
 * One-writer guard: find processes already attached to a thread's session.
 *
 * On a "single" writer-policy host (cc-lhc, codex-lhc) two writers on one
 * session corrupt capture — the rollout file freezes for one of them and its
 * turns are lost for good. On "shared" hosts (hermes, pi-lhc) a second
 * attachment is ordinary and merely worth mentioning. This module answers "is
 * something already holding this session?" from a single `ps` scan matched
 * against per-host argv patterns; what that answer *means* is the policy's job.
 *
 * It is pattern matching, not bookkeeping: a host started without a session
 * argument (a fresh `cc-lhc` with no `--resume`) is invisible here, and a
 * matching string in an unrelated command line is a false positive. Treat a
 * hit as a strong warning and a miss as "unknown", never as "safe".
 */

import { execFileSync } from "node:child_process";
import { writerPolicyFor, type LaunchRecipe, type WriterPolicy } from "@lhc-console/core";

/** One live process (or console terminal) holding a thread's session. */
export interface Attachment {
  pid: number;
  /** "terminal" when it belongs to a PTY this console spawned. */
  source: "process" | "terminal";
  /** Command line, truncated for transport. */
  args: string;
  startedAt?: string;
}

export interface AttachInfo {
  attached: Attachment[];
  /** Any attachment that is NOT one of our own terminals. */
  inUse: boolean;
  /**
   * The host's writer policy, carried alongside the hits so every consumer
   * reads the same answer to "does this attachment matter?". "single" hosts
   * warn and refuse; "shared" hosts merely mention it.
   */
  writerPolicy: WriterPolicy;
}

const ARGS_CAP = 120;
/** A scan is reused for this long, so a list request costs one `ps`. */
const SCAN_TTL_MS = 3000;

interface Proc {
  pid: number;
  ppid: number;
  startedAt: string | null;
  args: string;
}

let cache: { at: number; procs: Proc[] } | null = null;

/**
 * `ps -eo pid,ppid,lstart,args`, no shell. `lstart` is a fixed 24-char English
 * date ("Mon Jul 27 13:19:20 2026") with internal spaces, so the row is parsed
 * positionally rather than by splitting on whitespace. ppid is carried so
 * processes under our own PTYs can be attributed to the terminal that owns
 * them instead of being reported as a stranger.
 */
function scanProcesses(): Proc[] {
  const now = Date.now();
  if (cache && now - cache.at < SCAN_TTL_MS) return cache.procs;
  let out = "";
  try {
    out = execFileSync("ps", ["-eo", "pid,ppid,lstart,args"], {
      encoding: "utf8",
      maxBuffer: 8_000_000,
    });
  } catch {
    // no ps, or it failed — detection degrades to "nothing found"
    cache = { at: now, procs: [] };
    return cache.procs;
  }
  const procs: Proc[] = [];
  for (const line of out.split("\n").slice(1)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+ \S+ +\d+ \d\d:\d\d:\d\d \d{4}) (.*)$/.exec(line);
    if (!m) continue;
    const started = new Date(m[3]);
    procs.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      startedAt: Number.isNaN(started.getTime()) ? null : started.toISOString(),
      args: m[4],
    });
  }
  cache = { at: now, procs };
  return procs;
}

/** Drop the cached scan — used by tests and right after we spawn a terminal. */
export function invalidateProcessScan(): void {
  cache = null;
}

/** Word-boundary-ish containment: avoids matching a longer id that starts the same. */
function hasToken(args: string, token: string): boolean {
  const i = args.indexOf(token);
  if (i < 0) return false;
  const after = args[i + token.length];
  return after === undefined || !/[\w-]/.test(after);
}

/**
 * Does this command line look like a live attachment to the given thread?
 *
 * Deliberately conservative: only explicit session-id / thread-id arguments
 * count. A bare `cc-lhc` with no `--resume` could be attached to anything, so
 * it is not matched at all (see the misses noted in docs/spec.md).
 */
export function matchesThread(
  args: string,
  hostId: string,
  threadId: string,
  ref: string | null,
): boolean {
  switch (hostId) {
    case "cc-lhc":
      // The wrapper (`node …/cc-lhc/dist/bin.js --resume <sid>`) and the
      // `claude --resume <sid>` child both carry the id; both are reported.
      return !!ref && hasToken(args, `--resume ${ref}`);
    case "codex-lhc": {
      // Options may sit between the subcommand and the id (the launch command
      // itself puts the sandbox flag there): match `resume [flags…] <ref>` by
      // tokens, plus the plain `--resume <ref>` form.
      if (!ref) return false;
      if (hasToken(args, `--resume ${ref}`)) return true;
      const tokens = args.split(/\s+/);
      const at = tokens.indexOf("resume");
      if (at < 0) return false;
      for (let i = at + 1; i < tokens.length; i += 1) {
        const tok = tokens[i]!;
        if (tok.startsWith("-")) continue;
        return tok === ref;
      }
      return false;
    }
    case "pi-lhc": {
      const m = /--lhc-thread[= ](\S+)/.exec(args);
      if (!m) return false;
      const given = m[1].replace(/^['"]|['"]$/g, "");
      // pi accepts unique thread-id prefixes; honour those at 8 chars or more.
      return given === threadId || (given.length >= 8 && threadId.startsWith(given));
    }
    case "hermes":
      // The session stem (20260721_154423_1f15cb) is distinctive on its own.
      return !!ref && hasToken(args, `--resume ${ref}`);
    default:
      return false;
  }
}

/** Thread identity plus its recipe — everything detection needs about a row. */
export interface AttachSubject {
  hostId: string;
  threadId: string;
  recipe: LaunchRecipe | null;
}

/** PTYs this console owns: pid → the thread it was launched for. */
export interface OwnTerminal {
  pid: number;
  hostId: string;
  threadId: string;
}

export interface DetectOptions {
  /** Include matching descendants of this server (needed by the relay guard). */
  includeOwnProcesses?: boolean;
}

/**
 * Detect attachments for a batch of threads with one process scan.
 *
 * Returns a map keyed `hostId/threadId`. Threads with no launch recipe are
 * omitted (nothing to resume means nothing to collide with).
 */
export function detectAttached(
  subjects: AttachSubject[],
  ownTerminals: OwnTerminal[] = [],
  options: DetectOptions = {},
): Map<string, AttachInfo> {
  const wanted = subjects.filter((s) => s.recipe);
  const result = new Map<string, AttachInfo>();
  if (wanted.length === 0) return result;

  const procs = scanProcesses();
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const ownPids = new Set(ownTerminals.map((t) => t.pid));

  /** Walk up to `pid`'s ancestors, stopping at init or a cycle. */
  const ancestors = function* (p: Proc): Generator<Proc> {
    let cur: Proc | undefined = p;
    for (let hops = 0; cur && hops < 40; hops += 1) {
      yield cur;
      cur = byPid.get(cur.ppid);
    }
  };

  /** Nearest ancestor that is one of our terminal PTYs, if any. */
  const ownerTerminal = (p: Proc): number | null => {
    for (const a of ancestors(p)) if (ownPids.has(a.pid)) return a.pid;
    return null;
  };

  /**
   * This server, and anything it shelled out. Its own argv can quote a session
   * id (a test harness, a log line) and that is not a writer.
   */
  const isOurs = (p: Proc): boolean => {
    for (const a of ancestors(p)) if (a.pid === process.pid) return true;
    return false;
  };

  for (const s of wanted) {
    const key = `${s.hostId}/${s.threadId}`;
    const attached: Attachment[] = [];
    for (const t of ownTerminals) {
      if (t.hostId === s.hostId && t.threadId === s.threadId) {
        const p = byPid.get(t.pid);
        attached.push({
          pid: t.pid,
          source: "terminal",
          args: (p?.args ?? s.recipe!.command ?? "").slice(0, ARGS_CAP),
          ...(p?.startedAt ? { startedAt: p.startedAt } : {}),
        });
      }
    }
    for (const p of procs) {
      if (p.pid === process.pid) continue;
      // The pool's tmux plumbing (server/clients on our socket) is never a
      // writer; its argv can echo command text without holding any session.
      if (p.args.includes("-L lhc-console")) continue;
      if (!matchesThread(p.args, s.hostId, s.threadId, s.recipe!.sessionRef)) continue;
      const owner = ownerTerminal(p);
      // Our own shell-outs are not writers; our terminals are, and are listed
      // above as such — either way this row is not a stranger holding the id.
      if (owner === null && isOurs(p) && !options.includeOwnProcesses) continue;
      // Under one of our PTYs: it is that terminal, already listed above.
      if (owner !== null) continue;
      attached.push({
        pid: p.pid,
        source: "process",
        args: p.args.slice(0, ARGS_CAP),
        ...(p.startedAt ? { startedAt: p.startedAt } : {}),
      });
    }
    if (attached.length === 0) continue;
    result.set(key, {
      attached,
      inUse: attached.some((a) => a.source === "process"),
      writerPolicy: writerPolicyFor(s.hostId),
    });
  }
  return result;
}

/** Single-thread convenience; still one scan, still cached. */
export function detectAttachedOne(
  subject: AttachSubject,
  ownTerminals: OwnTerminal[] = [],
  options: DetectOptions = {},
): AttachInfo {
  return (
    detectAttached([subject], ownTerminals, options).get(
      `${subject.hostId}/${subject.threadId}`,
    ) ?? {
      attached: [],
      inUse: false,
      writerPolicy: writerPolicyFor(subject.hostId),
    }
  );
}
