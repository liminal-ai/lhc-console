/**
 * Pure decision logic for the tmux terminal pool.
 *
 * Everything here is a function of its inputs — no tmux, no /proc, no clock —
 * so the state classification, reconciliation matrix, re-key confirmation and
 * frame-ordering rules can be tested directly. The server's pool manager
 * gathers the facts (tmux list-panes, /proc reads, catalog rows) and asks.
 *
 * Design contract: docs/spec.md "tmux terminal pool" (v3, converged).
 */

/** Pool states. `cold` (no session) exists only implicitly — a thread with no
 * pool row. `busy` is rendered as running in the UI but is never auto-mutated. */
export type PaneState = "running" | "idle" | "busy" | "dead";

/** Facts about one pane, gathered by the manager. */
export interface PaneFacts {
  /** #{pane_dead} */
  dead: boolean;
  /** The pane's root process (the wrapper shell) pid — #{pane_pid}. */
  panePid: number;
  /** tpgid of the pane tty's foreground process group, from /proc/<panePid>/stat. */
  foregroundPid: number | null;
  /** comm of the foreground process, when readable. */
  foregroundComm: string | null;
  /** True when any descendant of panePid is not a shell (bash/zsh/sh/dash). */
  hasNonShellDescendants: boolean;
  /** @lhc_ready generation token as currently set on the pane, "" when absent. */
  readyToken: string;
  /** The token the server recorded when it last forwarded input, "" for none. */
  recordedToken: string;
  /** True when the wrapper installed a readiness adapter (bash/zsh). */
  adapterSupported: boolean;
}

const SHELL_COMMS = new Set(["bash", "zsh", "sh", "dash", "fish"]);
/** Foreground commands that make a pane opaque: we cannot see what runs behind them. */
const OPAQUE_COMMS = new Set(["ssh", "tmux"]);

/**
 * Classify one pane. The rule errs toward `busy`: the cost of a false busy is
 * one manual click; the cost of a false idle is respawn-pane destroying work.
 */
export function classifyPane(f: PaneFacts): PaneState {
  if (f.dead) return "dead";
  if (f.foregroundComm !== null && OPAQUE_COMMS.has(f.foregroundComm)) return "busy";
  const shellIsForeground =
    f.foregroundPid !== null &&
    f.foregroundPid === f.panePid &&
    f.foregroundComm !== null &&
    SHELL_COMMS.has(f.foregroundComm);
  if (!shellIsForeground || f.hasNonShellDescendants) return "running";
  // Shell in the foreground with nothing running under it. Idle only when the
  // readiness adapter proves a fresh prompt was painted since our last input —
  // a long-running builtin or a half-typed line never re-stamps the token.
  if (!f.adapterSupported) return "busy";
  if (f.readyToken === "" || f.readyToken === f.recordedToken) return "busy";
  return "idle";
}

// --- identity, naming --------------------------------------------------------

/** Display name: readable slug of the occupant + short uuid suffix (collision-proof). */
export function sessionDisplayName(label: string, uuid: string): string {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32)
      .replace(/-+$/g, "") || "term";
  return `${slug}-${uuid.slice(0, 6)}`;
}

// --- association frame ordering ---------------------------------------------

export interface FrameStamp {
  epoch: number;
  revision: number;
}

/** Clients compare revisions only within an epoch; a newer epoch is always adopted. */
export function frameIsStale(incoming: FrameStamp, lastSeen: FrameStamp | null): boolean {
  if (!lastSeen) return false;
  if (incoming.epoch > lastSeen.epoch) return false;
  if (incoming.epoch < lastSeen.epoch) return true;
  return incoming.revision <= lastSeen.revision;
}

// --- two-scan re-key confirmation -------------------------------------------

export interface RekeyCandidate {
  hostId: string;
  threadId: string;
  /** "argv" (process-tree match) or "registry" (newborn watch). */
  source: "argv" | "registry";
}

export interface RekeyPending {
  candidate: RekeyCandidate;
  scans: number;
}

/**
 * A re-key commits after two consecutive agreeing scans, or immediately when
 * an argv match is corroborated by a registry event (both sources agree).
 * A differing candidate restarts the count. Returns the new pending state and
 * whether to commit now.
 */
export function advanceRekey(
  pending: RekeyPending | null,
  observed: RekeyCandidate | null,
): { pending: RekeyPending | null; commit: RekeyCandidate | null } {
  if (!observed) return { pending: null, commit: null };
  const same =
    pending &&
    pending.candidate.hostId === observed.hostId &&
    pending.candidate.threadId === observed.threadId;
  if (same) {
    const corroborated = pending.candidate.source !== observed.source;
    const scans = pending.scans + 1;
    if (scans >= 2 || corroborated) return { pending: null, commit: observed };
    return { pending: { candidate: observed, scans }, commit: null };
  }
  return { pending: { candidate: observed, scans: 1 }, commit: null };
}

// --- boot reconciliation matrix ----------------------------------------------

export interface CatalogEntry {
  uuid: string;
  threadRef: { hostId: string; threadId: string | null; title: string | null };
  kind: string;
}

export interface LiveSession {
  uuid: string | null; // @lhc_uuid, null when unmarked
  sessionId: string; // live tmux $id handle
  owner: boolean; // @lhc_owner matches us
  state: PaneState;
  threadFromOptions: { hostId: string; threadId: string | null } | null;
}

export type ReconcileAction =
  | { kind: "bind"; uuid: string; sessionId: string; state: PaneState }
  | { kind: "adopt"; sessionId: string; uuid: string }
  | { kind: "tombstone"; uuid: string }
  | { kind: "foreign"; sessionId: string }
  | { kind: "conflict"; threadKey: string; uuids: string[] };

/** The boot matrix from the spec, as data in / decisions out. */
export function reconcile(catalog: CatalogEntry[], live: LiveSession[]): ReconcileAction[] {
  const actions: ReconcileAction[] = [];
  const liveByUuid = new Map<string, LiveSession>();
  for (const s of live) {
    if (s.uuid !== null && s.owner) liveByUuid.set(s.uuid, s);
    else actions.push({ kind: "foreign", sessionId: s.sessionId });
  }
  const known = new Set<string>();
  for (const c of catalog) {
    known.add(c.uuid);
    const s = liveByUuid.get(c.uuid);
    if (s) actions.push({ kind: "bind", uuid: c.uuid, sessionId: s.sessionId, state: s.state });
    else actions.push({ kind: "tombstone", uuid: c.uuid });
  }
  for (const [uuid, s] of liveByUuid) {
    if (!known.has(uuid)) actions.push({ kind: "adopt", sessionId: s.sessionId, uuid });
  }
  // Duplicate thread claims: never silently pick.
  const claims = new Map<string, string[]>();
  for (const [uuid, s] of liveByUuid) {
    const t = s.threadFromOptions;
    if (!t?.threadId) continue;
    const key = `${t.hostId}/${t.threadId}`;
    const list = claims.get(key);
    if (list) list.push(uuid);
    else claims.set(key, [uuid]);
  }
  for (const [threadKey, uuids] of claims) {
    if (uuids.length > 1) actions.push({ kind: "conflict", threadKey, uuids });
  }
  return actions;
}

// --- admission ----------------------------------------------------------------

/** The cap is an admission limit on console-initiated launches, not an invariant. */
export function admissionBlocked(
  states: PaneState[],
  cap: number,
): { blocked: boolean; counted: number } {
  const counted = states.filter((s) => s === "running" || s === "busy").length;
  return { blocked: counted >= cap, counted };
}
