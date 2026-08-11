/**
 * All contact with the tmux binary and /proc, for the terminal pool.
 *
 * Everything runs on the dedicated `-L lhc-console` socket: the user's
 * personal tmux server (default socket) is unreachable from here by
 * construction. Decision logic lives in @lhc-console/core tmuxpool.ts; this
 * module only gathers facts and performs verified mutations.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const SOCKET = process.env.LHC_CONSOLE_TMUX_SOCKET ?? "lhc-console";
const OWNER = "lhc-console";
const SCHEMA = "1";

function stateDir(): string {
  return process.env.LHC_CONSOLE_HOME ?? join(homedir(), ".lhc-console");
}

async function tmux(args: string[]): Promise<string> {
  // Scrubbed env on every call: whichever invocation happens to auto-start
  // the tmux server decides the env every future session inherits.
  const { stdout } = await exec("tmux", ["-L", SOCKET, "-f", confPath(), ...args], {
    encoding: "utf8",
    // 10k lines at the maximum 500-column pane width can approach 20 MiB
    // when every cell is four-byte UTF-8.
    maxBuffer: 32 * 1024 * 1024,
    env: scrubbedEnv({}),
  });
  return stdout;
}

/** tmux exits non-zero for "no server running" list calls; that means "none". */
async function tmuxList(args: string[]): Promise<string> {
  try {
    return await tmux(args);
  } catch {
    return "";
  }
}

// --- server bootstrap ---------------------------------------------------------

/**
 * The wrapper is a file, not an inline string, so there is exactly one layer
 * of quoting in the whole chain. It consumes LHC_CMD (unset before exec so
 * neither the CLI nor the shell inherits it), installs the bash readiness
 * adapter, and always ends as a login shell.
 */
const WRAPPER = `#!/usr/bin/env bash
# lhc-console pane wrapper — contract in docs/spec.md "tmux terminal pool".
# The command arrives via a one-shot file, never argv or lasting env: the tmux
# server keeps its starting client's argv forever, which would leak session
# ids into every ps scan (the one-writer guard would see a phantom writer).
cmdfile=$LHC_CMD_FILE
unset LHC_CMD_FILE
cmd=""
if [ -n "$cmdfile" ] && [ -f "$cmdfile" ]; then
  cmd=$(cat "$cmdfile")
  rm -f "$cmdfile"
fi
# Managed pool shells are bash by design (v1): the readiness adapter is the
# safety mechanism for idle relaunch, and it exists only for bash.
sh=/bin/bash
sock=\${LHC_TMUX_SOCKET:-lhc-console}
# Record which readiness adapter this pane actually has: observation derives
# adapterSupported from this instead of assuming. Non-bash shells get "none"
# and never auto-classify idle (confirm-gated resume).
case "$(basename "$sh")" in
  bash) command tmux -L "$sock" set -p @lhc_adapter bash 2>/dev/null ;;
  *) command tmux -L "$sock" set -p @lhc_adapter none 2>/dev/null ;;
esac
# Readiness adapter: a NEW generation token at every prompt (bash).
export PROMPT_COMMAND='LHC_GEN=$((LHC_GEN+1)); command tmux -L '"$sock"' set -p @lhc_ready "\${LHC_GEN}.$$" 2>/dev/null'
if [ -n "$cmd" ]; then
  eval "$cmd"
fi
exec "$sh" -l
`;

let bootstrapped = false;

/**
 * Claude session markers silently disable transcript persistence in spawned
 * claude CLIs (verified 2026-07-27, re-verified 2026-08-04 when a narrowed
 * list let CLAUDE_CODE_CHILD_SESSION through). The scrub is broad: anything
 * CLAUDE_*, plus CLAUDECODE and AI_AGENT.
 */
function isClaudeMarker(k: string): boolean {
  return k === "CLAUDECODE" || k === "AI_AGENT" || k.startsWith("CLAUDE_");
}

function confPath(): string {
  return join(stateDir(), "tmux.conf");
}

/**
 * Our options live in a config file passed with -f on EVERY invocation: a
 * tmux server with no sessions exits immediately, so post-start `set -g`
 * calls land on servers that are already gone — only a config survives every
 * (re)start. It also shadows ~/.tmux.conf, so personal settings (e.g. the
 * user's escape-time 10) never leak into the pool server.
 */
function confContent(): string {
  const evt = join(stateDir(), "attach-event");
  return `# lhc-console pool server — generated; do not edit (docs/spec.md tmux pool)
set -g default-terminal tmux-256color
set -s escape-time 15
set -s extended-keys on
set -g focus-events on
set -g allow-passthrough on
set -g status off
set -s set-clipboard external
set -g history-limit 50000
set -g remain-on-exit on
# Wheel/trackpad: without this, tmux's alt-screen makes xterm.js translate
# scroll into arrow keys. With it, the wheel scrolls tmux history naturally.
set -g mouse on
set -s terminal-features[100] 'xterm-256color:RGB:extkeys:focus'
# Attach/detach hooks close the human-attachment observation window: the pool
# re-observes within milliseconds instead of the 3s poll tick.
set-hook -g client-attached 'run-shell "touch ${evt}"'
set-hook -g client-detached 'run-shell "touch ${evt}"'
set-hook -g client-session-changed 'run-shell "touch ${evt}"'
`;
}

/** Idempotent: write config + wrapper. The server starts on first session. */
export async function ensureServer(): Promise<void> {
  if (bootstrapped) return;
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(join(stateDir(), "wrapper.sh"), WRAPPER, { mode: 0o755 });
  writeFileSync(confPath(), confContent());
  writeFileSync(join(stateDir(), "attach-event"), "");
  // A durable server that survived our restart still runs its OLD config —
  // -f only applies at server start. Source the fresh one into it; only a
  // confirmed no-server is ignorable (a syntax error must fail the boot, or
  // the old hooks silently stay active).
  try {
    await tmux(["source-file", confPath()]);
  } catch (e) {
    const msg = String(e);
    if (!msg.includes("no server running") && !msg.includes("error connecting")) throw e;
  }
  bootstrapped = true;
}

/** Env for spawned sessions: current env minus markers, plus overrides. */
export function scrubbedEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !isClaudeMarker(k)) env[k] = v;
  }
  return { ...env, ...extra };
}

// --- sessions -----------------------------------------------------------------

export interface CreateSessionInput {
  label: string;
  cwd: string;
  command: string | null; // null: plain shell
  kind: string;
  hostId: string;
  threadId: string | null;
}

export interface CreatedSession {
  uuid: string;
  sessionId: string;
  name: string;
}

function displayName(label: string, uuid: string): string {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32)
      .replace(/-+$/g, "") || "term";
  return `${slug}-${uuid.slice(0, 6)}`;
}

export async function createSession(input: CreateSessionInput): Promise<CreatedSession> {
  await ensureServer();
  const uuid = randomUUID();
  const name = displayName(input.label, uuid);
  const wrapperPath = join(stateDir(), "wrapper.sh");
  const cmdFile = writeCmdFile(uuid, input.command);
  const args = [
    "new-session",
    "-d",
    "-s",
    name,
    "-c",
    input.cwd,
    "-e",
    `LHC_CMD_FILE=${cmdFile}`,
    "-e",
    `LHC_TMUX_SOCKET=${SOCKET}`,
    "-P",
    "-F",
    "#{session_id}",
    "bash",
    wrapperPath,
  ];
  let sessionId: string;
  try {
    sessionId = (await tmux(args)).trim();
  } catch (e) {
    try {
      unlinkSync(cmdFile);
    } catch {
      // already consumed or never written
    }
    throw e;
  }
  const opts: [string, string][] = [
    ["@lhc_uuid", uuid],
    ["@lhc_owner", OWNER],
    ["@lhc_schema", SCHEMA],
    ["@lhc_kind", input.kind],
    ["@lhc_host", input.hostId],
    ["@lhc_thread", input.threadId ?? ""],
  ];
  try {
    for (const [k, v] of opts) await tmux(["set", "-t", sessionId, k, v]);
  } catch (e) {
    // A half-marked session would read as foreign forever. Kill exactly the
    // session we just made, drop its command file, and report the failure.
    await killSession(sessionId).catch(() => undefined);
    try {
      unlinkSync(cmdFile);
    } catch {
      // consumed already
    }
    throw e;
  }
  return { uuid, sessionId, name };
}

/** Resolve a uuid to its live session id, verifying the ownership marker. */
export async function resolveVerified(uuid: string): Promise<string | null> {
  const rows = await listSessions();
  const hit = rows.find((r) => r.uuid === uuid && r.owner);
  return hit?.sessionId ?? null;
}

export async function setThreadOptions(
  sessionId: string,
  hostId: string,
  threadId: string | null,
): Promise<void> {
  await tmux(["set", "-t", sessionId, "@lhc_host", hostId]);
  await tmux(["set", "-t", sessionId, "@lhc_thread", threadId ?? ""]);
}

export async function renameSession(sessionId: string, label: string, uuid: string): Promise<void> {
  await tmuxList(["rename-session", "-t", sessionId, displayName(label, uuid)]);
}

/**
 * Strict kill: resolves only on confirmed kill or confirmed absence. Any
 * other failure throws — DELETE must not report success over a live session.
 */
export async function killSession(sessionId: string): Promise<void> {
  try {
    await tmux(["kill-session", "-t", sessionId]);
  } catch (e) {
    const msg = String(e);
    const absent =
      msg.includes("no server running") ||
      msg.includes("error connecting") ||
      msg.includes("can't find session") ||
      msg.includes("session not found");
    if (!absent) throw e;
  }
}

/** One-shot command file: the wrapper reads and deletes it. */
function writeCmdFile(uuid: string, command: string | null): string {
  const dir = join(stateDir(), "cmd");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, uuid);
  writeFileSync(path, command ?? "", { mode: 0o600 });
  return path;
}

/** Respawn the pane with the wrapper — used for idle relaunch and dead restart. */
export async function respawnPane(
  sessionId: string,
  uuid: string,
  command: string | null,
): Promise<void> {
  const cmdFile = writeCmdFile(uuid, command);
  try {
    await tmux(["set-environment", "-t", sessionId, "LHC_CMD_FILE", cmdFile]);
    const wrapperPath = join(stateDir(), "wrapper.sh");
    await tmux(["respawn-pane", "-k", "-t", sessionId, "bash", wrapperPath]);
    await tmux(["set-environment", "-t", sessionId, "-r", "LHC_CMD_FILE"]);
  } catch (e) {
    try {
      unlinkSync(cmdFile);
    } catch {
      // already consumed
    }
    throw e;
  }
}

/** Wipe the readiness marker (before respawn, so stale tokens cannot idle). */
export async function clearReady(sessionId: string): Promise<void> {
  await tmux(["set", "-p", "-t", sessionId, "@lhc_ready", ""]);
}

// --- observation --------------------------------------------------------------

export interface TmuxPaneRow {
  sessionId: string;
  sessionName: string;
  uuid: string | null;
  owner: boolean;
  kind: string;
  hostId: string;
  threadId: string | null;
  panePid: number;
  paneDead: boolean;
  alternateOn: boolean;
  currentCommand: string;
  currentPath: string;
  readyToken: string;
  attachedClients: number;
  /** Which readiness adapter the wrapper installed: "bash" | "none" | "". */
  adapter: string;
}

/*
 * tmux escapes non-printable characters in format OUTPUT as octal text
 * (\037), so a control-char separator never survives the round trip. Use a
 * printable sentinel no session name, path, or option value will contain.
 */
const SEP = "|;|";
const FMT = [
  "#{session_id}",
  "#{session_name}",
  "#{@lhc_uuid}",
  "#{@lhc_owner}",
  "#{@lhc_kind}",
  "#{@lhc_host}",
  "#{@lhc_thread}",
  "#{pane_pid}",
  "#{pane_dead}",
  "#{alternate_on}",
  "#{pane_current_command}",
  "#{pane_current_path}",
  "#{@lhc_ready}",
  "#{session_attached}",
  "#{@lhc_adapter}",
].join(SEP);

/**
 * Strict: only the canonical "no server running" maps to an empty list. Any
 * other failure (transient exec, resource, format error) throws — callers
 * must NOT interpret it as "all sessions gone" (that path tombstones panes).
 */
export async function listSessions(): Promise<TmuxPaneRow[]> {
  let out = "";
  try {
    out = await tmux(["list-panes", "-a", "-F", FMT]);
  } catch (e) {
    const msg = String(e);
    if (msg.includes("no server running") || msg.includes("error connecting")) return [];
    throw e;
  }
  const rows: TmuxPaneRow[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const f = line.split(SEP);
    if (f.length < 15) continue;
    rows.push({
      sessionId: f[0]!,
      sessionName: f[1]!,
      uuid: f[2] || null,
      owner: f[3] === OWNER,
      kind: f[4] || "thread",
      hostId: f[5] || "",
      threadId: f[6] || null,
      panePid: Number(f[7]) || 0,
      paneDead: f[8] === "1",
      alternateOn: f[9] === "1",
      currentCommand: f[10] ?? "",
      currentPath: f[11] ?? "",
      readyToken: f[12] ?? "",
      attachedClients: Number(f[13]) || 0,
      adapter: f[14] ?? "",
    });
  }
  return rows;
}

/** Non-bridge clients attached to a session (bridge clients carry our flag). */
export async function humanClientCount(sessionId: string): Promise<number> {
  const out = await tmuxList(["list-clients", "-t", sessionId, "-F", "#{client_name}"]);
  return out
    .split("\n")
    .filter((l) => l.trim())
    .filter((n) => !bridgeClients.has(n.trim())).length;
}

/** Bridge client names register here so they are never counted as human. */
export const bridgeClients = new Set<string>();

export async function capturePane(
  sessionId: string,
  lines: number,
): Promise<{ text: string; alternateOn: boolean }> {
  const alt = (await tmuxList(["display", "-p", "-t", sessionId, "#{alternate_on}"])).trim();
  if (alt === "1") return { text: "", alternateOn: true };
  const text = await tmuxList([
    "capture-pane",
    "-p",
    "-e",
    "-t",
    sessionId,
    "-S",
    `-${lines}`,
    "-E",
    "-1",
  ]);
  return { text, alternateOn: false };
}

/** Plain-text pane history for copy/scrollback views (no terminal escapes). */
export async function capturePaneText(sessionId: string, lines: number): Promise<string> {
  return tmux(["capture-pane", "-p", "-t", sessionId, "-S", `-${lines}`]);
}

export async function setWindowSizeMode(sessionId: string, mode: "manual" | "latest") {
  await tmuxList(["set", "-t", sessionId, "window-size", mode]);
}

export async function resizeWindow(sessionId: string, cols: number, rows: number) {
  await tmuxList(["resize-window", "-t", sessionId, "-x", String(cols), "-y", String(rows)]);
}

// --- /proc facts --------------------------------------------------------------

/** tpgid (foreground process group) and its comm, from /proc. Nulls on any failure. */
export function procForeground(panePid: number): {
  foregroundPid: number | null;
  foregroundComm: string | null;
} {
  try {
    const stat = readFileSync(`/proc/${panePid}/stat`, "utf8");
    // comm can contain spaces/parens; fields start after the last ")".
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const tpgid = Number(rest[5]);
    if (!Number.isFinite(tpgid) || tpgid <= 0) return { foregroundPid: null, foregroundComm: null };
    const comm = readFileSync(`/proc/${tpgid}/comm`, "utf8").trim();
    return { foregroundPid: tpgid, foregroundComm: comm };
  } catch {
    return { foregroundPid: null, foregroundComm: null };
  }
}

const SHELL_COMMS = new Set(["bash", "zsh", "sh", "dash", "fish"]);

/** Walk /proc children of the pane shell; true when any descendant is not a shell. */
export function hasNonShellDescendants(panePid: number): boolean {
  const queue = [panePid];
  const seen = new Set<number>();
  while (queue.length) {
    const pid = queue.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    let children: number[] = [];
    try {
      const tasks = readdirSync(`/proc/${pid}/task`);
      for (const t of tasks) {
        const raw = readFileSync(`/proc/${pid}/task/${t}/children`, "utf8").trim();
        if (raw) children = children.concat(raw.split(/\s+/).map(Number));
      }
    } catch {
      continue;
    }
    for (const c of children) {
      if (!Number.isFinite(c)) continue;
      let comm = "";
      try {
        comm = readFileSync(`/proc/${c}/comm`, "utf8").trim();
      } catch {
        continue;
      }
      if (!SHELL_COMMS.has(comm)) return true;
      queue.push(c);
    }
  }
  return false;
}

/** All descendant pids of a pane (for own-process attribution in attach-detect). */
export function paneDescendants(panePid: number): number[] {
  const out: number[] = [];
  const queue = [panePid];
  const seen = new Set<number>();
  while (queue.length) {
    const pid = queue.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    try {
      for (const t of readdirSync(`/proc/${pid}/task`)) {
        const raw = readFileSync(`/proc/${pid}/task/${t}/children`, "utf8").trim();
        if (raw) for (const c of raw.split(/\s+/)) queue.push(Number(c));
      }
    } catch {
      // process went away mid-walk; fine
    }
  }
  return out;
}
