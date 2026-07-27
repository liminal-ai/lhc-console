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

export interface ThreadRow {
  hostId: string;
  threadId: string;
  filePath: string;
  title: string | null;
  cwd: string | null;
  createdAt: string;
  fileSizeBytes: number | null;
  fileMtime: string | null;
  stats: QuickStats | null;
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

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  hosts: () => get<HostRow[]>("/api/hosts"),
  threads: (params: { host?: string; q?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.host) qs.set("host", params.host);
    if (params.q) qs.set("q", params.q);
    const suffix = qs.size ? `?${qs}` : "";
    return get<ThreadRow[]>(`/api/threads${suffix}`);
  },
  overview: (hostId: string, threadId: string) =>
    get<OverviewResponse>(`/api/threads/${hostId}/${threadId}`),
  turns: (hostId: string, threadId: string) =>
    get<TurnRow[]>(`/api/threads/${hostId}/${threadId}/turns`),
  turnKinds: (hostId: string, threadId: string) =>
    get<TurnKindRow[]>(`/api/threads/${hostId}/${threadId}/turn-kinds`),
  viewArrangement: (hostId: string, threadId: string) =>
    get<ViewArrangement>(`/api/threads/${hostId}/${threadId}/view-arrangement`),
  messages: (hostId: string, threadId: string, turnId?: string) => {
    const suffix = turnId ? `?turn=${encodeURIComponent(turnId)}` : "";
    return get<MessageRow[]>(`/api/threads/${hostId}/${threadId}/messages${suffix}`);
  },
};
