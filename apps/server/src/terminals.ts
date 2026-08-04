/**
 * The tmux terminal pool.
 *
 * Terminals are tmux sessions on the dedicated `-L lhc-console` socket — they
 * survive this server's restarts and are equally reachable from raw ssh. Each
 * session wraps a durable shell (see tmux.ts WRAPPER); the console *observes*
 * sessions rather than owning them, and the thread a terminal belongs to is
 * derived from evidence (process tree, registry newborn watch) and re-keyed
 * when the user repurposes a shell by hand.
 *
 * Contract: docs/spec.md "tmux terminal pool" (v3, converged with codex).
 * Pure decision logic lives in @lhc-console/core (tmuxpool.ts).
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, type IPty } from "@lydell/node-pty";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import {
  admissionBlocked,
  advanceRekey,
  classifyPane,
  discoverHosts,
  hermesProfiles,
  isExistingDir,
  launchableHostIds,
  launchRecipe,
  listThreads,
  matchNewborn,
  planNewSession,
  writerPolicyFor,
  type NewSessionEnv,
  type NewTerminalKind,
  type PaneState,
  type RekeyPending,
  type ThreadSummary,
} from "@lhc-console/core";
import { detectAttachedOne, invalidateProcessScan, type OwnTerminal } from "./attach-detect.ts";
import { threadName } from "./prefs.ts";
import * as tmx from "./tmux.ts";

/** Total scrollback kept per terminal in the warm ring. tmux holds 50k lines more. */
const BUFFER_CAP = 2_000_000;
/** Admission limit for console-initiated launches: running+busy panes count. */
const MAX_ACTIVE = 8;
/** Observation cadence while any session exists. */
const OBSERVE_MS = 3000;
/** How often an unassociated new session looks for its registry row. */
const ASSOCIATE_POLL_MS = 3000;
/** After this long with no matching row, stop looking. */
const ASSOCIATE_WINDOW_MS = 5 * 60_000;
/** Bridge reattach backoff after an unexpected bridge death. */
const BRIDGE_RETRY_MS = 1500;

export interface ThreadRef {
  hostId: string;
  threadId: string | null;
  title: string | null;
}

interface PendingAssociation {
  hostId: string;
  cwd: string;
  spawnedAt: string;
}

type TerminalState = PaneState | "exited";

interface Terminal {
  id: string;
  uuid: string;
  /** Live tmux handle; refreshed each observation tick. Null once exited. */
  sessionId: string | null;
  name: string;
  threadRef: ThreadRef;
  kind: "thread" | NewTerminalKind | "dev";
  command: string | null;
  cwd: string;
  createdAt: string;
  state: TerminalState;
  cols: number;
  rows: number;
  chunks: string[];
  chars: number;
  /** Monotonic output sequence — the seed/live barrier (throughSeq). */
  seq: number;
  sockets: Set<WebSocket>;
  // oxlint-disable-next-line typescript/no-redundant-type-constituents -- @fastify/websocket's type resolves loosely here
  inputOwner: WebSocket | null;
  humanAttached: boolean;
  lastOutputAt: string | null;
  lastInputAt: string | null;
  /** The readiness token observed when input was last forwarded. */
  recordedToken: string;
  pending: PendingAssociation | null;
  rekeyPending: RekeyPending | null;
  bridge: IPty | null;
  bridgeRetry: NodeJS.Timeout | null;
  removeOnExit: boolean;
}

const terminals = new Map<string, Terminal>();
let ready = false;
let epoch = 0;
let revision = 0;
let seqCounter = 0;

function newId(): string {
  seqCounter += 1;
  return `t${seqCounter}_${Math.random().toString(36).slice(2, 8)}`;
}

// --- catalog + cross-process lock --------------------------------------------

function stateDir(): string {
  return process.env.LHC_CONSOLE_HOME ?? join(homedir(), ".lhc-console");
}

/**
 * Cross-process lease: two console processes (watcher handover, accidental
 * dual start) must not both mutate the pool. O_EXCL pidfile with staleness
 * check — crash-releasing because a dead pid frees the lock.
 */
function acquirePoolLock(): void {
  const path = join(stateDir(), "pool.lock");
  mkdirSync(stateDir(), { recursive: true });
  for (let i = 0; i < 3; i++) {
    try {
      const fd = openSync(path, "wx");
      writeFileSync(path, String(process.pid));
      closeSync(fd);
      process.on("exit", () => {
        try {
          if (readFileSync(path, "utf8").trim() === String(process.pid)) writeFileSync(path, "");
        } catch {
          // lock file gone; nothing to release
        }
      });
      return;
    } catch {
      let holder = Number.NaN;
      try {
        holder = Number(readFileSync(path, "utf8").trim());
      } catch {
        // unreadable — treat as stale
      }
      let alive = false;
      if (Number.isFinite(holder) && holder > 0) {
        try {
          process.kill(holder, 0);
          alive = holder !== process.pid;
        } catch {
          alive = false;
        }
      }
      if (alive) throw new Error(`pool locked by pid ${holder}`);
      try {
        writeFileSync(path, "");
        unlinkSync(path);
      } catch {
        // raced; retry
      }
    }
  }
  throw new Error("could not acquire pool lock");
}

interface CatalogFile {
  epoch: number;
  terminals: Array<{
    id: string;
    uuid: string;
    threadRef: ThreadRef;
    kind: Terminal["kind"];
    command: string | null;
    cwd: string;
    createdAt: string;
  }>;
}

function catalogPath(): string {
  return join(stateDir(), "pool.json");
}

function loadCatalog(): CatalogFile {
  try {
    const raw = JSON.parse(readFileSync(catalogPath(), "utf8")) as CatalogFile;
    if (raw && typeof raw.epoch === "number" && Array.isArray(raw.terminals)) return raw;
  } catch {
    // first boot or corrupt — start fresh
  }
  return { epoch: 0, terminals: [] };
}

function persistCatalog(): void {
  const data: CatalogFile = {
    epoch,
    terminals: [...terminals.values()]
      .filter((t) => t.state !== "exited")
      .map((t) => ({
        id: t.id,
        uuid: t.uuid,
        threadRef: t.threadRef,
        kind: t.kind,
        command: t.command,
        cwd: t.cwd,
        createdAt: t.createdAt,
      })),
  };
  const tmp = catalogPath() + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 1));
  renameSync(tmp, catalogPath());
}

// --- serialization of pool mutations ------------------------------------------

let mutationChain: Promise<unknown> = Promise.resolve();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = mutationChain.then(fn, fn);
  mutationChain = next.catch(() => undefined);
  return next;
}

// --- views --------------------------------------------------------------------

function publicView(t: Terminal): Record<string, unknown> {
  return {
    id: t.id,
    uuid: t.uuid,
    hostId: t.threadRef.hostId,
    threadId: t.threadRef.threadId,
    title: t.threadRef.title,
    kind: t.kind,
    command: t.command,
    cwd: t.cwd,
    // busy is running to the UI; the distinction is internal (no auto-mutations).
    state: t.state === "busy" ? "running" : t.state,
    status: t.state === "exited" || t.state === "dead" ? "exited" : "running",
    exitCode: null,
    createdAt: t.createdAt,
    cols: t.cols,
    rows: t.rows,
    lastOutputAt: t.lastOutputAt,
    lastInputAt: t.lastInputAt,
    awaitingThread: t.pending !== null,
    name: t.name,
    humanAttached: t.humanAttached,
    attachCommand: t.sessionId ? `tmux -L ${tmx.SOCKET} attach -t ${t.name}` : null,
    epoch,
  };
}

function record(t: Terminal, data: string): void {
  t.lastOutputAt = new Date().toISOString();
  t.seq += data.length;
  t.chunks.push(data);
  t.chars += data.length;
  while (t.chars > BUFFER_CAP && t.chunks.length > 1) {
    t.chars -= t.chunks.shift()!.length;
  }
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
    // socket died mid-send
  }
}

/** Binary frames are raw pty bytes — never prefixed (seed barrier is a JSON frame). */
function broadcastOutput(t: Terminal, data: string): void {
  const bytes = Buffer.from(data, "utf8");
  for (const s of t.sockets) {
    if (s.readyState !== 1) continue;
    if (s.bufferedAmount > 4 * BUFFER_CAP) {
      // Slow client: evict rather than buffer without bound.
      try {
        s.close();
      } catch {
        // already gone
      }
      continue;
    }
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

function stamp(): { epoch: number; revision: number } {
  revision += 1;
  return { epoch, revision };
}

// --- bridge -------------------------------------------------------------------

function attachBridge(t: Terminal): void {
  if (!t.sessionId || t.bridge) return;
  const pty = spawn("tmux", ["-L", tmx.SOCKET, "attach", "-f", "ignore-size", "-t", t.sessionId], {
    name: "xterm-256color",
    cols: t.cols,
    rows: t.rows,
    cwd: process.env.HOME ?? homedir(),
    env: { ...tmx.scrubbedEnv({}), TERM: "xterm-256color" },
  });
  t.bridge = pty;
  pty.onData((data) => {
    record(t, data);
    broadcastOutput(t, data);
  });
  pty.onExit(() => {
    t.bridge = null;
    // Bridge death never touches the session; reattach while it exists.
    if (t.sessionId && t.state !== "exited" && !t.bridgeRetry) {
      t.bridgeRetry = setTimeout(() => {
        t.bridgeRetry = null;
        attachBridge(t);
      }, BRIDGE_RETRY_MS);
      t.bridgeRetry.unref();
    }
  });
}

function detachBridge(t: Terminal): void {
  if (t.bridgeRetry) {
    clearTimeout(t.bridgeRetry);
    t.bridgeRetry = null;
  }
  if (t.bridge) {
    try {
      t.bridge.kill();
    } catch {
      // already gone
    }
    t.bridge = null;
  }
}

// --- state observation ---------------------------------------------------------

let observeTimer: NodeJS.Timeout | null = null;

function startObserving(): void {
  if (observeTimer) return;
  observeTimer = setInterval(() => void observe(), OBSERVE_MS);
  observeTimer.unref();
}

function stopObserving(): void {
  if (!observeTimer) return;
  clearInterval(observeTimer);
  observeTimer = null;
}

function anySessions(): boolean {
  for (const t of terminals.values()) if (t.sessionId) return true;
  return false;
}

async function observe(): Promise<void> {
  if (!anySessions()) {
    stopObserving();
    return;
  }
  let rows: tmx.TmuxPaneRow[];
  try {
    rows = await tmx.listSessions();
  } catch {
    return;
  }
  const byUuid = new Map(rows.filter((r) => r.uuid && r.owner).map((r) => [r.uuid!, r]));
  for (const t of terminals.values()) {
    if (t.state === "exited") continue;
    const row = byUuid.get(t.uuid);
    if (!row) {
      // Session gone: user exited the shell, or an explicit kill landed.
      markExited(t);
      continue;
    }
    t.sessionId = row.sessionId;
    t.name = row.sessionName;
    const fg = tmx.procForeground(row.panePid);
    const state = classifyPane({
      dead: row.paneDead,
      panePid: row.panePid,
      foregroundPid: fg.foregroundPid,
      foregroundComm: fg.foregroundComm,
      hasNonShellDescendants: tmx.hasNonShellDescendants(row.panePid),
      readyToken: row.readyToken,
      recordedToken: t.recordedToken,
      adapterSupported: true, // the wrapper always installs the bash adapter
    });
    const humanNow = row.attachedClients > (t.bridge ? 1 : 0);
    if (humanNow !== t.humanAttached) {
      t.humanAttached = humanNow;
      void applySizingMode(t);
      broadcastControl(t, { type: "attachChanged", humanAttached: humanNow, ...stamp() });
    }
    if (state !== t.state) {
      const prev = t.state;
      t.state = state;
      broadcastControl(t, { type: "state", state: publicStateOf(t), ...stamp() });
      // shell → CLI transition: figure out what it is now running.
      if (state === "running" && (prev === "idle" || prev === "busy")) {
        t.rekeyPending = { candidate: rekeyObserve(t, row) ?? neverCandidate, scans: 0 };
      }
    }
    if (state === "running" && t.rekeyPending) {
      const observed = rekeyObserve(t, row);
      const { pending, commit } = advanceRekey(
        t.rekeyPending.scans === 0 ? null : t.rekeyPending,
        observed,
      );
      t.rekeyPending = pending;
      if (commit && commit !== neverCandidate) {
        await commitRekey(t, commit.hostId, commit.threadId);
      }
    }
  }
}

const neverCandidate = { hostId: "", threadId: "", source: "argv" as const };

function publicStateOf(t: Terminal): string {
  return t.state === "busy" ? "running" : t.state;
}

/** What is this pane running? Argv match against every thread's sessionRef. */
function rekeyObserve(
  t: Terminal,
  row: tmx.TmuxPaneRow,
): { hostId: string; threadId: string; source: "argv" | "registry" } | null {
  const pids = tmx.paneDescendants(row.panePid);
  const argvs: string[] = [];
  for (const pid of pids) {
    try {
      argvs.push(readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " "));
    } catch {
      // gone
    }
  }
  if (argvs.length === 0) return null;
  for (const host of discoverHosts()) {
    let threads: ThreadSummary[];
    try {
      threads = listThreads(host);
    } catch {
      continue;
    }
    for (const thread of threads) {
      const recipe = launchRecipe(thread);
      const ref = recipe?.sessionRef;
      if (!ref) continue;
      if (argvs.some((a) => a.includes(ref))) {
        return { hostId: thread.hostId, threadId: thread.threadId, source: "argv" };
      }
    }
  }
  // Fallback: a brand-new session in this pane's cwd (registry newborn watch).
  const path = row.currentPath || t.cwd;
  for (const host of discoverHosts()) {
    let threads: ThreadSummary[];
    try {
      threads = listThreads(host);
    } catch {
      continue;
    }
    const hit = matchNewborn(
      threads.map((r) => ({
        threadId: r.threadId,
        cwd: r.cwd,
        createdAt: r.createdAt,
        title: r.title,
      })),
      {
        cwd: path,
        spawnedAt: new Date(Date.now() - 2 * OBSERVE_MS).toISOString(),
        taken: takenThreadIds(),
      },
    );
    if (hit) return { hostId: host.id, threadId: hit.threadId, source: "registry" };
  }
  return null;
}

function takenThreadIds(): Set<string> {
  return new Set(
    [...terminals.values()].map((t) => t.threadRef.threadId).filter((id): id is string => !!id),
  );
}

async function commitRekey(t: Terminal, hostId: string, threadId: string): Promise<void> {
  await serialized(async () => {
    let title: string | null = null;
    try {
      const host = discoverHosts().find((h) => h.id === hostId);
      if (host) title = listThreads(host).find((r) => r.threadId === threadId)?.title ?? null;
    } catch {
      // title stays null
    }
    const prev = { ...t.threadRef };
    t.threadRef = { hostId, threadId, title };
    if (t.sessionId) {
      await tmx.setThreadOptions(t.sessionId, hostId, threadId);
      await tmx.renameSession(t.sessionId, title ?? threadId, t.uuid);
    }
    persistCatalog();
    broadcastControl(t, {
      type: "associated",
      hostId,
      threadId,
      title,
      previous: prev,
      state: publicStateOf(t),
      ...stamp(),
    });
  });
}

function markExited(t: Terminal): void {
  t.sessionId = null;
  t.state = "exited";
  detachBridge(t);
  broadcastControl(t, { type: "exit", exitCode: null, signal: null });
  persistCatalog();
  if (t.removeOnExit) dropTerminal(t);
}

function dropTerminal(t: Terminal): void {
  terminals.delete(t.id);
  for (const s of t.sockets) {
    try {
      s.close();
    } catch {
      // already gone
    }
  }
  t.sockets.clear();
  persistCatalog();
}

async function applySizingMode(t: Terminal): Promise<void> {
  if (!t.sessionId) return;
  if (t.humanAttached) {
    await tmx.setWindowSizeMode(t.sessionId, "latest");
  } else {
    await tmx.setWindowSizeMode(t.sessionId, "manual");
    // Switching to manual keeps the human's last dimensions; restore ours now.
    await tmx.resizeWindow(t.sessionId, t.cols, t.rows);
    try {
      t.bridge?.resize(t.cols, t.rows);
    } catch {
      // bridge mid-restart
    }
  }
}

// --- creation ------------------------------------------------------------------

interface CreateSpec {
  label: string;
  command: string | null;
  cwd: string;
  threadRef: ThreadRef;
  kind: Terminal["kind"];
  cols: number;
  rows: number;
  pending?: PendingAssociation | null;
}

async function createTerminal(spec: CreateSpec): Promise<Terminal> {
  return serialized(async () => {
    const created = await tmx.createSession({
      label: spec.label,
      cwd: spec.cwd,
      command: spec.command,
      kind: spec.kind,
      hostId: spec.threadRef.hostId,
      threadId: spec.threadRef.threadId,
    });
    const t: Terminal = {
      id: newId(),
      uuid: created.uuid,
      sessionId: created.sessionId,
      name: created.name,
      threadRef: spec.threadRef,
      kind: spec.kind,
      command: spec.command,
      cwd: spec.cwd,
      createdAt: new Date().toISOString(),
      state: "running",
      cols: spec.cols,
      rows: spec.rows,
      chunks: [],
      chars: 0,
      seq: 0,
      sockets: new Set(),
      inputOwner: null,
      humanAttached: false,
      lastOutputAt: null,
      lastInputAt: null,
      recordedToken: "",
      pending: spec.pending ?? null,
      rekeyPending: null,
      bridge: null,
      bridgeRetry: null,
      removeOnExit: false,
    };
    terminals.set(t.id, t);
    await applySizingMode(t);
    attachBridge(t);
    persistCatalog();
    startObserving();
    if (t.pending) startAssociationPoll();
    return t;
  });
}

// --- newborn association (console-initiated new sessions) ----------------------

let associateTimer: NodeJS.Timeout | null = null;
const registryKeys = new Map<string, string>();

function pendingTerminals(): Terminal[] {
  return [...terminals.values()].filter((t) => t.pending !== null);
}

function startAssociationPoll(): void {
  if (associateTimer) return;
  associateTimer = setInterval(() => void pollAssociations(), ASSOCIATE_POLL_MS);
  associateTimer.unref();
}

function stopAssociationPoll(): void {
  if (!associateTimer) return;
  clearInterval(associateTimer);
  associateTimer = null;
}

function registryChange(hostId: string): { changed: boolean; key: string | null } {
  const host = discoverHosts().find((h) => h.id === hostId);
  if (!host?.registryPath) return { changed: true, key: null };
  let key: string;
  try {
    const st = statSync(host.registryPath);
    key = `${st.mtimeMs}:${st.size}`;
  } catch {
    return { changed: false, key: null };
  }
  return { changed: registryKeys.get(hostId) !== key, key };
}

async function pollAssociations(): Promise<void> {
  const waiting = pendingTerminals();
  if (waiting.length === 0) {
    stopAssociationPoll();
    return;
  }
  const now = Date.now();
  const live: Terminal[] = [];
  for (const t of waiting) {
    const expired = now - Date.parse(t.pending!.spawnedAt) > ASSOCIATE_WINDOW_MS;
    if (expired || t.state === "exited" || t.state === "dead") t.pending = null;
    else live.push(t);
  }
  if (live.length === 0) {
    stopAssociationPoll();
    return;
  }
  const taken = takenThreadIds();
  const byHost = new Map<string, Terminal[]>();
  for (const t of live) {
    const list = byHost.get(t.pending!.hostId);
    if (list) list.push(t);
    else byHost.set(t.pending!.hostId, [t]);
  }
  for (const [hostId, group] of byHost) {
    const { changed, key } = registryChange(hostId);
    if (!changed) continue;
    const host = discoverHosts().find((h) => h.id === hostId);
    if (!host) continue;
    let rows: ThreadSummary[];
    try {
      rows = listThreads(host);
    } catch {
      continue; // registry mid-write; gate has not moved
    }
    if (key) registryKeys.set(hostId, key);
    const candidates = rows.map((r) => ({
      threadId: r.threadId,
      cwd: r.cwd,
      createdAt: r.createdAt,
      title: r.title,
    }));
    for (const t of group) {
      const hit = matchNewborn(candidates, {
        cwd: t.pending!.cwd,
        spawnedAt: t.pending!.spawnedAt,
        taken,
      });
      if (!hit) continue;
      taken.add(hit.threadId);
      t.pending = null;
      await commitRekey(t, hostId, hit.threadId);
    }
  }
  if (pendingTerminals().length === 0) stopAssociationPoll();
}

// --- boot ----------------------------------------------------------------------

async function boot(): Promise<void> {
  acquirePoolLock();
  const catalog = loadCatalog();
  epoch = catalog.epoch + 1;
  await tmx.ensureServer();
  const live = await tmx.listSessions();
  const liveByUuid = new Map(live.filter((r) => r.uuid && r.owner).map((r) => [r.uuid!, r]));
  for (const entry of catalog.terminals) {
    const row = liveByUuid.get(entry.uuid);
    if (!row) continue; // session died while we were away: tombstone by omission
    const t: Terminal = {
      id: entry.id,
      uuid: entry.uuid,
      sessionId: row.sessionId,
      name: row.sessionName,
      threadRef: entry.threadRef,
      kind: entry.kind,
      command: entry.command,
      cwd: entry.cwd,
      createdAt: entry.createdAt,
      state: row.paneDead ? "dead" : "running",
      cols: 100,
      rows: 30,
      chunks: [],
      chars: 0,
      seq: 0,
      sockets: new Set(),
      inputOwner: null,
      humanAttached: false,
      lastOutputAt: null,
      lastInputAt: null,
      recordedToken: "",
      pending: null,
      rekeyPending: null,
      bridge: null,
      bridgeRetry: null,
      removeOnExit: false,
    };
    terminals.set(t.id, t);
    liveByUuid.delete(entry.uuid);
    // Seed the warm buffer from tmux history so reconnecting browsers see the past.
    const cap = await tmx.capturePane(row.sessionId, 2000);
    if (cap.text) record(t, cap.text);
    attachBridge(t);
  }
  // Marked sessions the catalog forgot: adopt from their user options.
  for (const [uuid, row] of liveByUuid) {
    const t: Terminal = {
      id: newId(),
      uuid,
      sessionId: row.sessionId,
      name: row.sessionName,
      threadRef: { hostId: row.hostId, threadId: row.threadId, title: null },
      kind: (row.kind as Terminal["kind"]) || "thread",
      command: null,
      cwd: row.currentPath,
      createdAt: new Date().toISOString(),
      state: row.paneDead ? "dead" : "running",
      cols: 100,
      rows: 30,
      chunks: [],
      chars: 0,
      seq: 0,
      sockets: new Set(),
      inputOwner: null,
      humanAttached: false,
      lastOutputAt: null,
      lastInputAt: null,
      recordedToken: "",
      pending: null,
      rekeyPending: null,
      bridge: null,
      bridgeRetry: null,
      removeOnExit: false,
    };
    terminals.set(t.id, t);
    const cap = await tmx.capturePane(row.sessionId, 2000);
    if (cap.text) record(t, cap.text);
    attachBridge(t);
  }
  persistCatalog();
  if (anySessions()) startObserving();
  ready = true;
}

let bootPromise: Promise<void> | null = null;

function ensureBoot(): Promise<void> {
  if (!bootPromise) {
    bootPromise = boot().catch((e) => {
      ready = true; // serve empty rather than wedge; the error is logged
      console.error("terminal pool boot failed:", e);
    });
  }
  return bootPromise;
}

// --- guard integration ---------------------------------------------------------

/** Pool pane pids for the one-writer guard: pane-tree descendants are ours. */
export function ownTerminals(): OwnTerminal[] {
  const out: OwnTerminal[] = [];
  for (const t of terminals.values()) {
    if (t.state === "exited" || !t.threadRef.threadId) continue;
    // The pane pid stands in for the whole tree; attach-detect walks ancestors.
    out.push({
      pid: paneRootPid(t),
      hostId: t.threadRef.hostId,
      threadId: t.threadRef.threadId,
    });
  }
  return out.filter((o) => o.pid > 0);
}

const panePids = new Map<string, number>();

function paneRootPid(t: Terminal): number {
  return panePids.get(t.uuid) ?? 0;
}

/** Refresh pane pids opportunistically from observation rows. */
async function refreshPanePids(): Promise<void> {
  try {
    for (const row of await tmx.listSessions()) {
      if (row.uuid) panePids.set(row.uuid, row.panePid);
    }
  } catch {
    // next tick
  }
}

// --- helpers -------------------------------------------------------------------

function findFor(hostId: string, threadId: string): Terminal | undefined {
  for (const t of terminals.values()) {
    if (t.state === "exited") continue;
    if (t.threadRef.hostId === hostId && t.threadRef.threadId === threadId) return t;
  }
  return undefined;
}

function activeStates(): PaneState[] {
  return [...terminals.values()]
    .filter((t) => t.state !== "exited")
    .map((t) => (t.state === "exited" ? "dead" : t.state) as PaneState);
}

function isLoopback(req: FastifyRequest): boolean {
  const ip = req.socket.remoteAddress ?? "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

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

export function newSessionEnv(): NewSessionEnv {
  return {
    launchable: launchableHostIds(discoverHosts().map((h) => h.id)),
    hermesProfiles: hermesProfiles(),
    home: process.env.HOME ?? homedir(),
    shell: process.env.SHELL ?? null,
  };
}

/**
 * Idle relaunch: recompute the recipe and respawn the pane. Guards per spec:
 * inside the serialized mutation, pane alive, still idle, no human client,
 * and a FRESH one-writer scan — an idle terminal is not a writer and its
 * thread may have been resumed externally since it went idle.
 */
async function resumeIdle(
  t: Terminal,
  force: boolean,
): Promise<{ code: number; body: Record<string, unknown> }> {
  return serialized(async () => {
    if (t.state !== "idle" && !force) {
      return { code: 409, body: { error: "terminal is not idle", state: publicStateOf(t) } };
    }
    if (t.humanAttached) {
      return { code: 409, body: { error: "attached elsewhere — detach the tmux client first" } };
    }
    if (!t.sessionId) return { code: 409, body: { error: "session is gone" } };
    if (!t.threadRef.threadId) {
      return { code: 409, body: { error: "terminal has no thread to resume" } };
    }
    const host = discoverHosts().find((h) => h.id === t.threadRef.hostId);
    const thread = host
      ? listThreads(host).find((r) => r.threadId === t.threadRef.threadId)
      : undefined;
    const recipe = thread ? launchRecipe(thread) : null;
    if (!recipe?.command) {
      return { code: 409, body: { error: recipe?.reason ?? "no resume recipe" } };
    }
    if (writerPolicyFor(t.threadRef.hostId) === "single") {
      invalidateProcessScan();
      const info = detectAttachedOne(
        { hostId: t.threadRef.hostId, threadId: t.threadRef.threadId, recipe },
        ownTerminals().filter(
          (o) => o.threadId !== t.threadRef.threadId || o.pid !== paneRootPid(t),
        ),
      );
      if (info.attached.length > 0 && !force) {
        return { code: 409, body: { error: "session in use", attached: info.attached } };
      }
    }
    t.command = recipe.command;
    t.recordedToken = "";
    await tmx.respawnPane(t.sessionId, t.uuid, recipe.command);
    t.state = "running";
    broadcastControl(t, { type: "state", state: "running", ...stamp() });
    invalidateProcessScan();
    return { code: 200, body: publicView(t) };
  });
}

// --- routes --------------------------------------------------------------------

export function registerTerminalRoutes(
  app: FastifyInstance,
  lookupThread: (hostId: string, threadId: string) => Lookup,
): void {
  void ensureBoot();

  app.get("/api/terminals", async (_req, reply) => {
    await ensureBoot();
    if (!ready) return reply.code(503).header("retry-after", "1").send({ error: "reconciling" });
    await refreshPanePids();
    return [...terminals.values()].map(publicView);
  });

  app.post("/api/terminals", async (req, reply) => {
    await ensureBoot();
    const body = (req.body ?? {}) as {
      hostId?: string;
      threadId?: string;
      fresh?: boolean;
      force?: boolean;
      cols?: number;
      rows?: number;
      devCommand?: string;
      newSession?: { hostId?: string; cwd?: string; profile?: string | null };
      shell?: { cwd?: string };
    };
    const cols = clampDim(body.cols, 80, 500);
    const rows = clampDim(body.rows, 24, 200);

    const admission = admissionBlocked(activeStates(), MAX_ACTIVE);

    if (body.devCommand) {
      const denied = devCommandGate(req);
      if (denied) return reply.code(denied.code).send({ error: denied.error });
      if (admission.blocked) {
        return reply.code(429).send({ error: `terminal limit reached (${MAX_ACTIVE})` });
      }
      const t = await createTerminal({
        label: `dev ${body.devCommand}`.slice(0, 40),
        command: body.devCommand,
        cwd: process.env.HOME ?? homedir(),
        threadRef: {
          hostId: body.hostId ?? "dev",
          threadId: body.threadId ?? `dev-${Math.random().toString(36).slice(2, 8)}`,
          title: `dev: ${body.devCommand}`.slice(0, 60),
        },
        kind: "dev",
        cols,
        rows,
      });
      return reply.code(201).send(publicView(t));
    }

    if (body.newSession || body.shell) {
      const req_ = body.newSession
        ? {
            kind: "newSession" as const,
            hostId: body.newSession.hostId,
            cwd: body.newSession.cwd,
            profile: body.newSession.profile,
          }
        : { kind: "shell" as const, cwd: body.shell?.cwd };
      const plan = planNewSession(req_, newSessionEnv());
      if (!plan.ok) return reply.code(400).send({ error: plan.error });
      if (!isExistingDir(plan.cwd)) {
        return reply.code(400).send({ error: `not a directory: ${plan.cwd}` });
      }
      if (admission.blocked) {
        return reply.code(429).send({ error: `terminal limit reached (${MAX_ACTIVE})` });
      }
      const spawnedAt = new Date().toISOString();
      const t = await createTerminal({
        label: plan.title,
        command: plan.command,
        cwd: plan.cwd,
        kind: plan.kind,
        threadRef: { hostId: plan.hostId, threadId: null, title: plan.title },
        pending: plan.matchCwd ? { hostId: plan.hostId, cwd: plan.matchCwd, spawnedAt } : null,
        cols,
        rows,
      });
      invalidateProcessScan();
      return reply.code(201).send(publicView(t));
    }

    if (!body.hostId || !body.threadId) {
      return reply.code(400).send({ error: "hostId and threadId are required" });
    }
    const found = lookupThread(body.hostId, body.threadId);
    if ("error" in found) return reply.code(found.code).send({ error: found.error });
    const { thread } = found;

    const recipe = launchRecipe(thread);
    if (!recipe?.command) {
      return reply
        .code(409)
        .send({ error: recipe?.reason ?? "thread has no launch recipe", reason: recipe?.reason });
    }

    if (!body.fresh) {
      const existing = findFor(thread.hostId, thread.threadId);
      if (existing) {
        // Idempotent ONLY for running/busy — those are live writers. An idle
        // terminal must re-scan for external writers before respawning.
        if (existing.state === "running" || existing.state === "busy") {
          return reply.send(publicView(existing));
        }
        if (existing.state === "idle") {
          const r = await resumeIdle(existing, body.force === true);
          return reply.code(r.code).send(r.body);
        }
        // dead: fall through and spawn a fresh session; the tombstone remains
      }
    }

    if (!body.force && writerPolicyFor(thread.hostId) === "single") {
      const info = detectAttachedOne(
        { hostId: thread.hostId, threadId: thread.threadId, recipe },
        ownTerminals(),
      );
      if (info.attached.length > 0) {
        return reply.code(409).send({ error: "session in use", attached: info.attached });
      }
    }

    if (admission.blocked) {
      return reply.code(429).send({ error: `terminal limit reached (${MAX_ACTIVE})` });
    }
    // The tmux display name prefers the console's own title for the thread.
    const label =
      threadName(thread.hostId, thread.threadId)?.title ?? thread.title ?? thread.threadId;
    const t = await createTerminal({
      label,
      command: recipe.command,
      cwd: thread.cwd ?? process.env.HOME ?? homedir(),
      threadRef: {
        hostId: thread.hostId,
        threadId: thread.threadId,
        title: thread.title ?? thread.sessionId ?? thread.threadId,
      },
      kind: "thread",
      cols,
      rows,
    });
    invalidateProcessScan();
    return reply.code(201).send(publicView(t));
  });

  app.post("/api/terminals/:id/resume", async (req, reply) => {
    await ensureBoot();
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { force?: boolean };
    const t = terminals.get(id);
    if (!t) return reply.code(404).send({ error: "no such terminal" });
    const r = await resumeIdle(t, body.force === true);
    return reply.code(r.code).send(r.body);
  });

  app.post("/api/terminals/:id/restart-shell", async (req, reply) => {
    await ensureBoot();
    const { id } = req.params as { id: string };
    const t = terminals.get(id);
    if (!t) return reply.code(404).send({ error: "no such terminal" });
    return serialized(async () => {
      if (t.state !== "dead") return reply.code(409).send({ error: "pane is not dead" });
      if (t.humanAttached) {
        return reply.code(409).send({ error: "attached elsewhere — detach the tmux client first" });
      }
      if (!t.sessionId) return reply.code(409).send({ error: "session is gone" });
      await tmx.respawnPane(t.sessionId, t.uuid, null);
      t.state = "idle";
      t.command = null;
      t.recordedToken = "";
      broadcastControl(t, { type: "state", state: "idle", ...stamp() });
      return reply.send(publicView(t));
    });
  });

  app.delete("/api/terminals/:id", async (req, reply) => {
    await ensureBoot();
    const { id } = req.params as { id: string };
    const t = terminals.get(id);
    if (!t) return reply.code(404).send({ error: "no such terminal" });
    await serialized(async () => {
      if (t.sessionId) {
        // Resolve + verify the marker before killing exactly that session.
        const verified = await tmx.resolveVerified(t.uuid);
        if (verified) await tmx.killSession(verified);
        t.sessionId = null;
      }
      detachBridge(t);
      t.state = "exited";
      dropTerminal(t);
    });
    return { ok: true, id, status: "exited" };
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
    // First socket claims input by default; later sockets claim explicitly.
    if (!t.inputOwner || t.inputOwner.readyState !== 1) t.inputOwner = socket;
    sendControl(socket, {
      type: "replay",
      data: t.chunks.join(""),
      throughSeq: t.seq,
      status: t.state === "exited" || t.state === "dead" ? "exited" : "running",
      state: publicStateOf(t),
      humanAttached: t.humanAttached,
      inputOwner: t.inputOwner === socket,
      exitCode: null,
      cols: t.cols,
      rows: t.rows,
      epoch,
    });
    if (t.state === "exited") sendControl(socket, { type: "exit", exitCode: null });

    socket.on("message", (raw: Buffer | string, isBinary?: boolean) => {
      if (t.state === "exited") return;
      const writeInput = (text: string): void => {
        if (t.humanAttached) {
          sendControl(socket, { type: "inputSuspended", reason: "attached elsewhere" });
          return;
        }
        if (t.inputOwner !== socket) {
          sendControl(socket, { type: "inputDenied" });
          return;
        }
        t.lastInputAt = new Date().toISOString();
        // Record the readiness token we most recently saw: idle requires a NEW
        // prompt after this moment.
        void tmx
          .listSessions()
          .then((rows) => {
            const row = rows.find((r) => r.uuid === t.uuid);
            if (row) t.recordedToken = row.readyToken;
          })
          .catch(() => undefined);
        try {
          t.bridge?.write(text);
        } catch {
          // bridge mid-restart; user will retry
        }
      };
      if (isBinary === false || typeof raw === "string") {
        const text = raw.toString();
        try {
          const msg = JSON.parse(text) as { type?: string; cols?: number; rows?: number };
          if (msg.type === "resize") {
            if (t.inputOwner !== socket || t.humanAttached) return;
            const c = clampDim(msg.cols, t.cols, 500);
            const r = clampDim(msg.rows, t.rows, 200);
            if (c !== t.cols || r !== t.rows) {
              t.cols = c;
              t.rows = r;
              if (t.sessionId) void tmx.resizeWindow(t.sessionId, c, r);
              try {
                t.bridge?.resize(c, r);
              } catch {
                // bridge mid-restart
              }
            }
            return;
          }
          if (msg.type === "claimInput") {
            t.inputOwner = socket;
            sendControl(socket, { type: "inputOwner" });
            return;
          }
          if (msg.type === "ping") {
            sendControl(socket, { type: "pong" });
            return;
          }
        } catch {
          // not JSON — keystrokes
        }
        writeInput(text);
        return;
      }
      writeInput(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw));
    });

    const drop = (): void => {
      t.sockets.delete(socket);
      if (t.inputOwner === socket) {
        t.inputOwner = [...t.sockets][0] ?? null;
        if (t.inputOwner) sendControl(t.inputOwner, { type: "inputOwner" });
      }
    };
    socket.on("close", drop);
    socket.on("error", drop);
  });
}

/**
 * Server shutdown detaches bridge clients ONLY. Sessions are the durable
 * artifact — the whole point of the pool — and must never die with us.
 */
export function shutdownTerminals(): void {
  for (const t of terminals.values()) detachBridge(t);
}
