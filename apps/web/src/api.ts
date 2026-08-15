export interface QuickStats {
  eventCount: number;
  messageCount: number;
  turnCount: number;
  closedTurnCount: number;
  retainedArchiveTokenEstimate: number;
  projectedViewTokenEstimate: number;
  projectedViewIsUpperBound: boolean;
  latestProviderInputTokens: number | null;
  lastEventAt: string | null;
  lastCompactAt: string | null;
  activeWorkItems: number;
  historicalFailedDerivations: number;
  summary: string | null;
}

/** A live process (or console terminal) already attached to a session. */
export interface Attachment {
  pid: number;
  source: "process" | "terminal";
  args: string;
  startedAt?: string;
}

export interface LaunchRecipe {
  /** The command to run, or null when this thread cannot be resumed. */
  command: string | null;
  /** Identifier the host resumes by; null when it resumes without one. */
  sessionRef?: string | null;
  /** Why there is no command. Only set when `command` is null. */
  reason?: string;
  /** Session id found in the rollout files because the lineage DB had no row. */
  recovered?: boolean;
  /** The command resumes something weaker: `--continue`, not this session. */
  fallback?: "continue";
  /** Something OTHER than one of our terminals is already attached. */
  inUse?: boolean;
  attached?: Attachment[];
  /**
   * Whether a second writer is destructive on this host. "single" (cc-lhc,
   * codex-lhc) warns and needs `force`; "shared" (hermes, pi-lhc) just notes it.
   */
  writerPolicy?: "single" | "shared";
}

/**
 * The console's own name for a thread. Host titles are cwd basenames, uuids
 * and timestamp stems; this is what a person decided to call the thing. Null
 * when nobody has named it, and either field can be null on its own.
 */
export interface CustomName {
  title: string | null;
  description: string | null;
  /** Present on the write response; the list rows carry the two fields only. */
  updatedAt?: string;
}

export interface ThreadRow {
  hostId: string;
  threadId: string;
  filePath: string;
  title: string | null;
  cwd: string | null;
  createdAt: string;
  fileSizeBytes: number | null;
  fileMtime: string | null;
  /** Host profile (registry-less hosts like hermes). */
  profile?: string | null;
  /** Host session id — the thread file's stem (registry-less hosts). */
  sessionId?: string | null;
  stats: QuickStats | null;
  /** Console-owned title/description, overlaying `title` and `stats.summary`. */
  custom?: CustomName | null;
  /** Resume recipe, null only for hosts with no resume path at all (t3code). */
  launch?: LaunchRecipe | null;
  /** Hidden from the default list by a console-side preference. */
  hidden?: boolean;
}

export interface HostRow {
  id: string;
  home: string;
  threadCount: number;
  /** A new session can be started on this host. */
  launchable?: boolean;
}

/** Everything the new-session modal needs to open, in one fetch. */
export interface NewSessionOptions {
  hosts: { id: string; writerPolicy: "single" | "shared"; picks: "directory" | "profile" }[];
  hermesProfiles: string[];
  defaultRoot: string;
  rootByHost: Record<string, string>;
}

/** A directory people actually work in, ranked by recent thread activity. */
export interface QuickDir {
  path: string;
  basename: string;
  threadCount: number;
  hosts: string[];
  lastActiveAt: string;
}

export interface BrowseResult {
  parentDir: string;
  prefix: string;
  entries: { name: string; path: string }[];
  truncated: boolean;
  /** Short reason the listing is empty — shown inline, never thrown. */
  error?: string;
}

export interface TurnRow {
  turnId: string;
  turnOrder: number;
  status: string;
  outcome: string | null;
  startedAt: string | null;
  endedAt: string | null;
  messageCount: number;
  tokenEstimate: number;
  promptExcerpt: string | null;
}

export type TurnKindBucket =
  | "user_prompt"
  | "assistant_text"
  | "assistant_thinking"
  | "tool_call"
  | "tool_result"
  | "other";

export interface TurnKindRow {
  turnId: string;
  turnOrder: number;
  status: string;
  startedAt: string | null;
  messageCount: number;
  firstEventOrder: number | null;
  lastEventOrder: number | null;
  tokens: Record<TurnKindBucket, number>;
  totalTokens: number;
}

export interface MessageBlock {
  blockIndex: number;
  blockType: string;
  content: string;
  contentLength: number;
  toolName?: string;
  toolCallId?: string;
}

export interface MessageRow {
  messageId: string;
  sourceEventOrder: number;
  kind: string;
  actor: string;
  turnId: string;
  tokenEstimate: number;
  blocks: MessageBlock[];
}

export interface ViewInfo {
  viewId: string;
  createdAt: string;
  compactPoint: number;
  coveredFrom: number;
  profileName: string | null;
  bands: { band: string; tokenCount: number }[];
}

export interface OverviewResponse {
  thread: ThreadRow;
  hidden: boolean;
  /** Console-owned name; `thread.title` stays the raw registry title. */
  custom: CustomName | null;
  launch: LaunchRecipe | null;
  overview: {
    threadId: string;
    createdAt: string;
    tokenEstimator: string;
    stats: QuickStats;
    messageKinds: Record<string, number>;
    derivationStates: Record<string, number>;
    chunkCount: number;
    view: ViewInfo | null;
    visibilityBoundary: number | null;
    hostMeasurements: {
      activeContextTokens: number | null;
      modelContextWindow: number | null;
      latestProviderUsageAt: string | null;
      latestNativeCompactAt: string | null;
      alarms: string[];
    };
    /** Readable summary paragraph; longer form of `stats.summary`. */
    summary: string | null;
  };
}

export interface ViewEntryTurn {
  turnId: string;
  turnOrder: number | null;
  status: string | null;
  missing: boolean;
}

export interface ViewEntry {
  index: number;
  band: string;
  subjectKind: string;
  subjectId: string;
  derivationUsed: string | null;
  degraded: boolean;
  turns: ViewEntryTurn[];
  turnOrderFrom: number | null;
  turnOrderTo: number | null;
  derivationState: string | null;
  gap: boolean;
  content: string;
  contentLength: number;
}

export interface ViewTailTurn {
  turnId: string;
  turnOrder: number;
  status: string;
  messageCount: number;
  tokenEstimate: number;
  firstEventOrder: number | null;
  promptExcerpt: string | null;
}

export interface ViewArrangement {
  view: {
    viewId: string;
    createdAt: string;
    profileName: string | null;
    compactPoint: number;
    coveredFrom: number;
    bands: { band: string; tokenCount: number }[];
    gaps: unknown[];
  } | null;
  entries: ViewEntry[];
  liveTail: ViewTailTurn[];
  liveTailTokens: number;
  archivedHistory: ViewTailTurn[];
  archivedHistoryTokens: number;
  retainedArchiveTokens: number;
  projectedViewTokens: number;
  projectedViewIsUpperBound: boolean;
  turnsSinceView: number;
  turnCount: number;
}

export interface TerminalRow {
  id: string;
  hostId: string;
  /** Null while a newborn session has not been matched to a thread row yet. */
  threadId: string | null;
  title: string | null;
  /** How it was started: resumed thread, fresh LHC session, or plain shell. */
  kind?: "thread" | "newSession" | "shell";
  command: string;
  cwd: string;
  status: "running" | "exited";
  exitCode: number | null;
  createdAt: string;
  cols: number;
  rows: number;
  /** Last pty output / client input, for the activity indicators. */
  lastOutputAt?: string | null;
  lastInputAt?: string | null;
  /** Still watching the host registry for this session's thread row. */
  awaitingThread?: boolean;
  /** Pool state: running | idle | dead | exited (busy renders as running). */
  state?: "running" | "idle" | "dead" | "exited";
  /** tmux display name; manual attach is `tmux -L lhc-console attach -t <name>`. */
  name?: string;
  attachCommand?: string | null;
  /** A non-bridge tmux client (raw ssh attach) holds the session. */
  humanAttached?: boolean;
  /** Another terminal claims the same thread; mutations refuse until resolved. */
  conflict?: boolean;
  uuid?: string;
  epoch?: number;
}

/** A non-2xx API response, carrying the status so callers can branch on 404. */
export class ApiError extends Error {
  status: number;
  detail: string;
  url: string;

  constructor(status: number, detail: string, url: string) {
    super(`${url} → ${status} ${detail}`);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
    this.url = url;
  }
}

async function send<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) detail = body.error;
    } catch {
      // non-JSON error body — the status line is the best we have
    }
    throw new ApiError(res.status, detail, url);
  }
  return res.json() as Promise<T>;
}

async function get<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) detail = body.error;
    } catch {
      // non-JSON error body — the status line is the best we have
    }
    throw new ApiError(res.status, detail, url);
  }
  return res.json() as Promise<T>;
}

export const api = {
  hosts: () => get<HostRow[]>("/api/hosts"),
  /**
   * One fetch for the whole list. The client always asks for hidden rows and
   * filters them itself — the list is small and client-side filtering is
   * already how host/dir/search work, so the hidden count stays live for free.
   */
  threads: (params: { host?: string; q?: string; includeHidden?: boolean } = {}) => {
    const qs = new URLSearchParams();
    if (params.host) qs.set("host", params.host);
    if (params.q) qs.set("q", params.q);
    if (params.includeHidden !== false) qs.set("includeHidden", "1");
    const suffix = qs.size ? `?${qs}` : "";
    return get<ThreadRow[]>(`/api/threads${suffix}`);
  },
  hideThread: (hostId: string, threadId: string, hidden: boolean) =>
    send<{ hidden: number; threadId: string }>(`/api/threads/${hostId}/${threadId}/hide`, {
      method: hidden ? "POST" : "DELETE",
    }),
  /**
   * Rename a thread, console-side. Partial: leave a field out to keep it,
   * pass null to clear it. Clearing both drops back to the host's title.
   */
  setThreadName: (
    hostId: string,
    threadId: string,
    patch: { title?: string | null; description?: string | null },
  ) =>
    send<{ threadId: string; custom: CustomName | null }>(
      `/api/threads/${hostId}/${threadId}/name`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      },
    ),
  overview: (hostId: string, threadId: string) =>
    get<OverviewResponse>(`/api/threads/${hostId}/${threadId}`),
  turns: (hostId: string, threadId: string) =>
    get<TurnRow[]>(`/api/threads/${hostId}/${threadId}/turns`),
  turnKinds: (hostId: string, threadId: string) =>
    get<TurnKindRow[]>(`/api/threads/${hostId}/${threadId}/turn-kinds`),
  viewArrangement: (hostId: string, threadId: string) =>
    get<ViewArrangement>(`/api/threads/${hostId}/${threadId}/view-arrangement`),
  terminals: () => get<TerminalRow[]>("/api/terminals"),
  /** Relaunch an idle terminal's thread in place (fresh recipe, one-writer scan). */
  resumeTerminal: (id: string, force = false) =>
    send<TerminalRow>(`/api/terminals/${id}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force }),
    }),
  restartShell: (id: string) =>
    send<TerminalRow>(`/api/terminals/${id}/restart-shell`, { method: "POST" }),
  newSessionOptions: () => get<NewSessionOptions>("/api/new-session/options"),
  quickDirs: () => get<QuickDir[]>("/api/quick-dirs"),
  /** Directory completion. Always resolves — errors arrive as `error`. */
  browse: (path: string, signal?: AbortSignal) =>
    get<BrowseResult>(`/api/fs/browse?path=${encodeURIComponent(path)}`, signal),
  /** What a new session would run, computed by the server that would run it. */
  newSessionPreview: (params: {
    kind: "newSession" | "shell";
    hostId?: string;
    cwd?: string;
    profile?: string | null;
  }) => {
    const qs = new URLSearchParams({ kind: params.kind });
    if (params.hostId) qs.set("hostId", params.hostId);
    if (params.cwd) qs.set("cwd", params.cwd);
    if (params.profile) qs.set("profile", params.profile);
    return get<{ command: string | null; cwd?: string; title?: string; error?: string }>(
      `/api/new-session/preview?${qs}`,
    );
  },
  openTerminal: (body: {
    hostId?: string;
    threadId?: string;
    fresh?: boolean;
    /** Start a fresh session: the server builds the command from these. */
    newSession?: { hostId: string; cwd?: string; profile?: string | null };
    /** Start a plain login shell here. */
    shell?: { cwd: string };
    /** Spawn even though the one-writer guard found an attachment. */
    force?: boolean;
    cols?: number;
    rows?: number;
    devCommand?: string;
    /** Shared secret for the devCommand escape; tests only. */
    devSecret?: string;
  }) => {
    const { devSecret, ...payload } = body;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (devSecret) headers["x-lhc-dev"] = devSecret;
    return send<TerminalRow>("/api/terminals", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  },
  terminalHistory: (id: string, lines = 10_000) =>
    get<{ text: string }>(
      `/api/terminals/${encodeURIComponent(id)}/history?lines=${encodeURIComponent(String(lines))}`,
    ),
  killTerminal: (id: string) =>
    send<{ ok: boolean }>(`/api/terminals/${encodeURIComponent(id)}`, { method: "DELETE" }),
  messages: (hostId: string, threadId: string, turnId?: string) => {
    const suffix = turnId ? `?turn=${encodeURIComponent(turnId)}` : "";
    return get<MessageRow[]>(`/api/threads/${hostId}/${threadId}/messages${suffix}`);
  },
};
