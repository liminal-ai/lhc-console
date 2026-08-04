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
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
    maxBuffer: 8 * 1024 * 1024,
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
sh=$LHC_SHELL
[ -x "$sh" ] || sh=/bin/bash
sock=\${LHC_TMUX_SOCKET:-lhc-console}
# Readiness adapter: a NEW generation token at every prompt. bash only; other
# shells simply never stamp, which classifies as busy (confirm-gated resume).
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
const CONF = `# lhc-console pool server — generated; do not edit (docs/spec.md tmux pool)
set -g default-terminal tmux-256color
set -s escape-time 15
set -s extended-keys on
set -g focus-events on
set -g allow-passthrough on
set -g status off
set -s set-clipboard external
set -g history-limit 50000
set -g remain-on-exit on
set -sa terminal-features 'xterm-256color:RGB:extkeys:focus'
`;

/** Idempotent: write config + wrapper. The server starts on first session. */
export async function ensureServer(): Promise<void> {
  if (bootstrapped) return;
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(join(stateDir(), "wrapper.sh"), WRAPPER, { mode: 0o755 });
  writeFileSync(confPath(), CONF);
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
    `LHC_SHELL=${process.env.SHELL?.startsWith("/") ? process.env.SHELL : "/bin/bash"}`,
    "-e",
    `LHC_TMUX_SOCKET=${SOCKET}`,
    "-P",
    "-F",
    "#{session_id}",
    "bash",
    wrapperPath,
  ];
  const sessionId = (await tmux(args)).trim();
  const opts: [string, string][] = [
    ["@lhc_uuid", uuid],
    ["@lhc_owner", OWNER],
    ["@lhc_schema", SCHEMA],
    ["@lhc_kind", input.kind],
    ["@lhc_host", input.hostId],
    ["@lhc_thread", input.threadId ?? ""],
  ];
  for (const [k, v] of opts) await tmux(["set", "-t", sessionId, k, v]);
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

export async function killSession(sessionId: string): Promise<void> {
  await tmuxList(["kill-session", "-t", sessionId]);
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
  await tmux(["set-environment", "-t", sessionId, "LHC_CMD_FILE", cmdFile]);
  const wrapperPath = join(stateDir(), "wrapper.sh");
  await tmux(["respawn-pane", "-k", "-t", sessionId, "bash", wrapperPath]);
  await tmux(["set-environment", "-t", sessionId, "-r", "LHC_CMD_FILE"]);
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
].join(SEP);

export async function listSessions(): Promise<TmuxPaneRow[]> {
  const out = await tmuxList(["list-panes", "-a", "-F", FMT]);
  const rows: TmuxPaneRow[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const f = line.split(SEP);
    if (f.length < 14) continue;
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
