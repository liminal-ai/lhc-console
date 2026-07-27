/**
 * Server-owned PTY sessions.
 *
 * The console is read-only wrt every SQLite file it touches; terminals are the
 * one place it starts a process. The spawned host writes its own state — that
 * is the point of the feature, and it never goes through this server.
 *
 * A terminal outlives the browser: output accumulates in a capped ring buffer,
 * sockets attach and detach freely (several at once), and an exited terminal
 * stays in the map with its final screen until someone dismisses it.
 */

import { homedir } from "node:os";
import { spawn, type IPty } from "@lydell/node-pty";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import { launchRecipe, writerPolicyFor, type ThreadSummary } from "@lhc-console/core";
import { detectAttachedOne, invalidateProcessScan, type OwnTerminal } from "./attach-detect.ts";

/** Total scrollback kept per terminal. Oldest output is dropped first. */
const BUFFER_CAP = 2_000_000;
/** Concurrently running terminals. Beyond this, POST answers 429. */
const MAX_RUNNING = 8;
/** Grace between SIGHUP and SIGKILL on delete. */
const KILL_GRACE_MS = 3000;

export interface ThreadRef {
  hostId: string;
  threadId: string;
  title: string | null;
}

interface Terminal {
  id: string;
  pty: IPty;
  threadRef: ThreadRef;
  command: string;
  cwd: string;
  createdAt: string;
  status: "running" | "exited";
  exitCode: number | null;
  cols: number;
  rows: number;
  /** Ring buffer of pty output, as strings — `chars` is their total length. */
  chunks: string[];
  chars: number;
  sockets: Set<WebSocket>;
  /** DELETE arrived while still running: drop it once the exit is delivered. */
  removeOnExit: boolean;
  killTimer: NodeJS.Timeout | null;
}

const terminals = new Map<string, Terminal>();
let seq = 0;

function newId(): string {
  seq += 1;
  return `t${seq}_${Math.random().toString(36).slice(2, 8)}`;
}

function publicView(t: Terminal): Record<string, unknown> {
  return {
    id: t.id,
    hostId: t.threadRef.hostId,
    threadId: t.threadRef.threadId,
    title: t.threadRef.title,
    command: t.command,
    cwd: t.cwd,
    status: t.status,
    exitCode: t.exitCode,
    createdAt: t.createdAt,
    cols: t.cols,
    rows: t.rows,
  };
}

/** Append to the ring buffer, dropping whole chunks off the front when over cap. */
function record(t: Terminal, data: string): void {
  t.chunks.push(data);
  t.chars += data.length;
  while (t.chars > BUFFER_CAP && t.chunks.length > 1) {
    t.chars -= t.chunks.shift()!.length;
  }
  // A single chunk larger than the cap: keep its tail, which is the live screen.
  if (t.chars > BUFFER_CAP && t.chunks.length === 1) {
    const only = t.chunks[0].slice(-BUFFER_CAP);
    t.chunks[0] = only;
    t.chars = only.length;
  }
}

function sendControl(socket: WebSocket, frame: Record<string, unknown>): void {
  if (socket.readyState !== 1) return;
  try {
    socket.send(JSON.stringify(frame));
  } catch {
    // socket died mid-send; the close handler will clean it up
  }
}

/**
 * Output goes out as *binary* frames and control messages as JSON *text*, so
 * the client never has to guess which is which — pty bytes can contain
 * anything, including something that parses as JSON.
 */
function broadcastOutput(t: Terminal, data: string): void {
  const bytes = Buffer.from(data, "utf8");
  for (const s of t.sockets) {
    if (s.readyState !== 1) continue;
    try {
      s.send(bytes);
    } catch {
      // ditto
    }
  }
}

function broadcastControl(t: Terminal, frame: Record<string, unknown>): void {
  for (const s of t.sockets) sendControl(s, frame);
}

function onExit(t: Terminal, exitCode: number, signal?: number): void {
  t.status = "exited";
  t.exitCode = exitCode;
  if (t.killTimer) {
    clearTimeout(t.killTimer);
    t.killTimer = null;
  }
  broadcastControl(t, { type: "exit", exitCode, signal: signal ?? null });
  if (t.removeOnExit) {
    terminals.delete(t.id);
    for (const s of t.sockets) {
      try {
        s.close();
      } catch {
        // already gone
      }
    }
    t.sockets.clear();
  }
}

export interface SpawnSpec {
  command: string;
  cwd: string;
  threadRef: ThreadRef;
  cols: number;
  rows: number;
}

/**
 * The server may itself have been (re)started from inside a Claude Code
 * session, whose env markers (CLAUDECODE, CLAUDE_CODE_CHILD_SESSION, …) then
 * leak into spawned terminals and make a launched claude treat itself as a
 * nested child session — silently disabling session persistence. Strip every
 * claude-session marker; the launched host must see a clean shell env.
 * Verified empirically 2026-07-27: with these vars claude writes no session
 * file; scrubbed, it persists normally.
 */
function scrubbedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === "CLAUDECODE" || k === "AI_AGENT") continue;
    if (k.startsWith("CLAUDE_")) continue;
    env[k] = v;
  }
  return env;
}

function spawnTerminal(spec: SpawnSpec): Terminal {
  const pty = spawn("bash", ["-lc", spec.command], {
    name: "xterm-256color",
    cols: spec.cols,
    rows: spec.rows,
    cwd: spec.cwd,
    env: { ...scrubbedEnv(), TERM: "xterm-256color" },
  });
  const t: Terminal = {
    id: newId(),
    pty,
    threadRef: spec.threadRef,
    command: spec.command,
    cwd: spec.cwd,
    createdAt: new Date().toISOString(),
    status: "running",
    exitCode: null,
    cols: spec.cols,
    rows: spec.rows,
    chunks: [],
    chars: 0,
    sockets: new Set(),
    removeOnExit: false,
    killTimer: null,
  };
  // node-pty hands us decoded strings, so UTF-8 sequences never split here.
  pty.onData((data) => {
    record(t, data);
    broadcastOutput(t, data);
  });
  pty.onExit(({ exitCode, signal }) => onExit(t, exitCode, signal));
  terminals.set(t.id, t);
  return t;
}

function runningCount(): number {
  let n = 0;
  for (const t of terminals.values()) if (t.status === "running") n += 1;
  return n;
}

function findRunningFor(hostId: string, threadId: string): Terminal | undefined {
  for (const t of terminals.values()) {
    if (
      t.status === "running" &&
      t.threadRef.hostId === hostId &&
      t.threadRef.threadId === threadId
    ) {
      return t;
    }
  }
  return undefined;
}

/**
 * Running PTYs and the thread each was launched for, for the one-writer guard:
 * a terminal of ours counts as an attachment, and anything under its pid is
 * that terminal rather than a stranger.
 */
export function ownTerminals(): OwnTerminal[] {
  const out: OwnTerminal[] = [];
  for (const t of terminals.values()) {
    if (t.status !== "running") continue;
    out.push({ pid: t.pty.pid, hostId: t.threadRef.hostId, threadId: t.threadRef.threadId });
  }
  return out;
}

function removeTerminal(t: Terminal): void {
  if (t.status === "exited") {
    terminals.delete(t.id);
    for (const s of t.sockets) {
      try {
        s.close();
      } catch {
        // already gone
      }
    }
    t.sockets.clear();
    return;
  }
  t.removeOnExit = true;
  try {
    t.pty.kill("SIGHUP");
  } catch {
    // process already reaped; onExit will still land
  }
  t.killTimer = setTimeout(() => {
    t.killTimer = null;
    if (t.status !== "running") return;
    try {
      t.pty.kill("SIGKILL");
    } catch {
      // nothing left to kill
    }
  }, KILL_GRACE_MS);
}

function isLoopback(req: FastifyRequest): boolean {
  const ip = req.socket.remoteAddress ?? "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

/**
 * Gate on the devCommand escape.
 *
 * Loopback alone is NOT a gate: every browser request arrives through the Vite
 * dev proxy, which connects from 127.0.0.1, so any tailnet browser looked like
 * a local caller and could spawn an arbitrary command. Require a shared secret
 * as well, and when no secret is configured disable the escape outright.
 */
function devCommandGate(req: FastifyRequest): { code: number; error: string } | null {
  const secret = process.env.LHC_CONSOLE_DEV_SECRET;
  if (!secret) return { code: 403, error: "devCommand is disabled (no LHC_CONSOLE_DEV_SECRET)" };
  if (!isLoopback(req)) return { code: 403, error: "devCommand is loopback-only" };
  const offered = req.headers["x-lhc-dev"];
  const value = Array.isArray(offered) ? offered[0] : offered;
  if (value !== secret) return { code: 403, error: "devCommand requires a valid x-lhc-dev header" };
  return null;
}

function clampDim(v: unknown, fallback: number, max: number): number {
  const n = typeof v === "number" ? Math.floor(v) : Number.NaN;
  if (!Number.isFinite(n) || n < 2) return fallback;
  return Math.min(n, max);
}

type Lookup = { thread: ThreadSummary } | { code: number; error: string };

export function registerTerminalRoutes(
  app: FastifyInstance,
  lookupThread: (hostId: string, threadId: string) => Lookup,
): void {
  app.get("/api/terminals", async () => [...terminals.values()].map(publicView));

  app.post("/api/terminals", async (req, reply) => {
    const body = (req.body ?? {}) as {
      hostId?: string;
      threadId?: string;
      fresh?: boolean;
      force?: boolean;
      cols?: number;
      rows?: number;
      devCommand?: string;
    };
    const cols = clampDim(body.cols, 80, 500);
    const rows = clampDim(body.rows, 24, 200);

    /*
     * Dev escape: a loopback caller holding the shared secret may spawn an
     * arbitrary command, so the terminal plumbing can be exercised end to end
     * without starting a real agent session. It is the only path where a
     * client-supplied command is honoured, and it is off unless configured.
     */
    if (body.devCommand) {
      const denied = devCommandGate(req);
      if (denied) return reply.code(denied.code).send({ error: denied.error });
      if (runningCount() >= MAX_RUNNING) {
        return reply.code(429).send({ error: `terminal limit reached (${MAX_RUNNING})` });
      }
      const t = spawnTerminal({
        command: body.devCommand,
        cwd: process.env.HOME ?? homedir(),
        threadRef: {
          hostId: body.hostId ?? "dev",
          threadId: body.threadId ?? `dev-${Date.now()}`,
          title: `dev: ${body.devCommand}`.slice(0, 60),
        },
        cols,
        rows,
      });
      return reply.code(201).send(publicView(t));
    }

    if (!body.hostId || !body.threadId) {
      return reply.code(400).send({ error: "hostId and threadId are required" });
    }
    const found = lookupThread(body.hostId, body.threadId);
    if ("error" in found) return reply.code(found.code).send({ error: found.error });
    const { thread } = found;

    // The command is always recomputed here; a client never gets to name it.
    const recipe = launchRecipe(thread);
    if (!recipe?.command) {
      return reply
        .code(409)
        .send({ error: recipe?.reason ?? "thread has no launch recipe", reason: recipe?.reason });
    }
    const command = recipe.command;

    if (!body.fresh) {
      const existing = findRunningFor(thread.hostId, thread.threadId);
      // Idempotent return: this IS the attached writer, so no guard applies.
      if (existing) return reply.send(publicView(existing));
    }

    /*
     * One-writer guard, and only where it is real. On a "single" writer-policy
     * host (cc-lhc, codex-lhc) spawning past the idempotent return means adding
     * a second writer to a session that tolerates one, so refuse unless the
     * caller insists. On "shared" hosts (hermes, pi-lhc) a second attachment is
     * ordinary: the UI mentions it and the spawn goes through.
     */
    if (!body.force && writerPolicyFor(thread.hostId) === "single") {
      const info = detectAttachedOne(
        { hostId: thread.hostId, threadId: thread.threadId, recipe },
        ownTerminals(),
      );
      if (info.attached.length > 0) {
        return reply.code(409).send({ error: "session in use", attached: info.attached });
      }
    }

    if (runningCount() >= MAX_RUNNING) {
      return reply.code(429).send({ error: `terminal limit reached (${MAX_RUNNING})` });
    }
    const t = spawnTerminal({
      command,
      cwd: thread.cwd ?? process.env.HOME ?? homedir(),
      threadRef: {
        hostId: thread.hostId,
        threadId: thread.threadId,
        title: thread.title ?? thread.sessionId ?? thread.threadId,
      },
      cols,
      rows,
    });
    // The new pty must be visible to the next guard check, not hidden behind
    // the 3s scan cache — otherwise a double click spawns two writers.
    invalidateProcessScan();
    return reply.code(201).send(publicView(t));
  });

  app.delete("/api/terminals/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const t = terminals.get(id);
    if (!t) return reply.code(404).send({ error: "no such terminal" });
    removeTerminal(t);
    return { ok: true, id, status: t.status };
  });

  app.get("/api/terminals/:id/ws", { websocket: true }, (socket: WebSocket, req) => {
    const { id } = req.params as { id: string };
    const t = terminals.get(id);
    if (!t) {
      sendControl(socket, { type: "gone" });
      socket.close();
      return;
    }
    t.sockets.add(socket);
    // The buffer is the truth: a fresh attach replays it, then rides live.
    sendControl(socket, {
      type: "replay",
      data: t.chunks.join(""),
      status: t.status,
      exitCode: t.exitCode,
      cols: t.cols,
      rows: t.rows,
    });
    if (t.status === "exited") sendControl(socket, { type: "exit", exitCode: t.exitCode });

    socket.on("message", (raw: Buffer | string, isBinary?: boolean) => {
      if (t.status !== "running") return;
      if (isBinary === false || typeof raw === "string") {
        const text = raw.toString();
        // Text frames are control frames; anything else is a protocol slip.
        try {
          const msg = JSON.parse(text) as { type?: string; cols?: number; rows?: number };
          if (msg.type === "resize") {
            const c = clampDim(msg.cols, t.cols, 500);
            const r = clampDim(msg.rows, t.rows, 200);
            if (c !== t.cols || r !== t.rows) {
              t.cols = c;
              t.rows = r;
              try {
                t.pty.resize(c, r);
              } catch {
                // pty vanished between the check and the resize
              }
            }
            return;
          }
          if (msg.type === "ping") {
            sendControl(socket, { type: "pong" });
            return;
          }
        } catch {
          // not JSON — fall through and treat it as keystrokes
        }
        t.pty.write(text);
        return;
      }
      t.pty.write(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw));
    });

    const drop = (): void => {
      t.sockets.delete(socket);
    };
    socket.on("close", drop);
    socket.on("error", drop);
  });
}

/** Kill everything — used on server shutdown so no orphan agents survive. */
export function shutdownTerminals(): void {
  for (const t of terminals.values()) {
    if (t.status === "running") {
      try {
        t.pty.kill("SIGHUP");
      } catch {
        // best effort
      }
    }
  }
  terminals.clear();
}
