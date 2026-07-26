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
  messages: (hostId: string, threadId: string, turnId?: string) => {
    const suffix = turnId ? `?turn=${encodeURIComponent(turnId)}` : "";
    return get<MessageRow[]>(`/api/threads/${hostId}/${threadId}/messages${suffix}`);
  },
};
