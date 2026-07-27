export interface QuickStats {
  eventCount: number;
  messageCount: number;
  turnCount: number;
  closedTurnCount: number;
  totalTokenEstimate: number;
  contextTokens: number;
  lastEventAt: string | null;
  lastCompactAt: string | null;
  pendingWork: number;
  failedDerivations: number;
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
  /** Resume recipe, null only for hosts with no resume path at all (t3code). */
  launch?: LaunchRecipe | null;
  /** Hidden from the default list by a console-side preference. */
  hidden?: boolean;
}

export interface HostRow {
  id: string;
  home: string;
  threadCount: number;
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
  afterCompact: boolean;
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
  tail: ViewTailTurn[];
  tailTokens: number;
  turnsSinceView: number;
  turnCount: number;
}

export interface TerminalRow {
  id: string;
  hostId: string;
  threadId: string;
  title: string | null;
  command: string;
  cwd: string;
  status: "running" | "exited";
  exitCode: number | null;
  createdAt: string;
  cols: number;
  rows: number;
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
  overview: (hostId: string, threadId: string) =>
    get<OverviewResponse>(`/api/threads/${hostId}/${threadId}`),
  turns: (hostId: string, threadId: string) =>
    get<TurnRow[]>(`/api/threads/${hostId}/${threadId}/turns`),
  turnKinds: (hostId: string, threadId: string) =>
    get<TurnKindRow[]>(`/api/threads/${hostId}/${threadId}/turn-kinds`),
  viewArrangement: (hostId: string, threadId: string) =>
    get<ViewArrangement>(`/api/threads/${hostId}/${threadId}/view-arrangement`),
  terminals: () => get<TerminalRow[]>("/api/terminals"),
  openTerminal: (body: {
    hostId?: string;
    threadId?: string;
    fresh?: boolean;
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
  killTerminal: (id: string) =>
    send<{ ok: boolean }>(`/api/terminals/${encodeURIComponent(id)}`, { method: "DELETE" }),
  messages: (hostId: string, threadId: string, turnId?: string) => {
    const suffix = turnId ? `?turn=${encodeURIComponent(turnId)}` : "";
    return get<MessageRow[]>(`/api/threads/${hostId}/${threadId}/messages${suffix}`);
  },
};
