import type { DatabaseSync } from "node:sqlite";
import { withDb } from "./db.ts";

/** Cheap per-thread stats for the aggregated list view. */
export interface ThreadQuickStats {
  eventCount: number;
  messageCount: number;
  turnCount: number;
  closedTurnCount: number;
  totalTokenEstimate: number;
  /**
   * What a resume would serve: stored band token counts plus the live tail
   * after the compact point. With no view, every non-deleted message counts.
   */
  contextTokens: number;
  lastEventAt: string | null;
  lastCompactAt: string | null;
  pendingWork: number;
  failedDerivations: number;
  /**
   * Non-deleted `user_prompt` messages. Zero on a thread that has other
   * messages marks an agent-spawned sub-session (codex review swarms get
   * their task as an agent message, never a user prompt).
   */
  userPromptCount: number;
  /** Short description: latest ready chunk_summary_brief, else first prompt. */
  summary: string | null;
}

/** Max characters of `summary` carried in the aggregated list. */
const SUMMARY_CAP = 240;

/** Max characters of the overview's readable summary paragraph. */
const SUMMARY_CAP_LONG = 2400;

function tidySummary(text: string, cap = SUMMARY_CAP): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > cap ? `${flat.slice(0, cap - 1).trimEnd()}…` : flat;
}

export function threadQuickStats(filePath: string): ThreadQuickStats {
  return withDb(filePath, (db) => {
    const one = <T>(sql: string): T => db.prepare(sql).get() as unknown as T;

    const events = one<{ c: number; last: string | null }>(
      "select count(*) c, max(recorded_at) last from event",
    );
    const messages = one<{ c: number; tokens: number | null }>(
      "select count(*) c, sum(token_estimate) tokens from message where deleted_at is null",
    );
    const turns = one<{ c: number; closed: number }>(
      "select count(*) c, sum(status = 'closed') closed from turns where deleted_at is null",
    );
    const userPrompts = one<{ c: number }>(
      "select count(*) c from message where deleted_at is null and kind = 'user_prompt'",
    );
    const view = one<{ last: string | null }>("select max(created_at) last from thread_view");
    const work = one<{ c: number }>("select count(*) c from work_item");
    const failed = one<{ c: number }>(
      "select count(*) c from derivation where state in ('failed','blocked')",
    );

    const totalTokens = messages.tokens ?? 0;

    const viewRow = db
      .prepare("select view_id, compact_point from thread_view where singleton = 1")
      .get() as unknown as { view_id: string; compact_point: number } | undefined;

    let contextTokens = totalTokens;
    if (viewRow) {
      const bands = db
        .prepare("select coalesce(sum(token_count), 0) t from thread_view_band where view_id = ?")
        .get(viewRow.view_id) as unknown as { t: number };
      const tail = db
        .prepare(
          `select coalesce(sum(token_estimate), 0) t from message
           where deleted_at is null and source_event_order > ?`,
        )
        .get(viewRow.compact_point) as unknown as { t: number };
      contextTokens = bands.t + tail.t;
    }

    return {
      eventCount: events.c,
      messageCount: messages.c,
      turnCount: turns.c,
      closedTurnCount: turns.closed ?? 0,
      totalTokenEstimate: totalTokens,
      contextTokens,
      lastEventAt: events.last,
      lastCompactAt: view.last,
      pendingWork: work.c,
      failedDerivations: failed.c,
      userPromptCount: userPrompts.c,
      summary: threadSummaryText(db),
    };
  });
}

/**
 * Best available one-line description of a thread: the content of the latest
 * ready `chunk_summary_brief` (highest chunk_order), falling back to the
 * decoded text of the first user prompt. Null when the thread has neither.
 */
function threadSummaryText(db: DatabaseSync, cap = SUMMARY_CAP): string | null {
  const brief = db
    .prepare(
      `select d.content from derivation d
       join chunk c on c.chunk_id = d.subject_id
       where d.subject_kind = 'chunk'
         and d.derivation_type = 'chunk_summary_brief'
         and d.state = 'ready'
         and d.content is not null
       order by c.chunk_order desc limit 1`,
    )
    .get() as unknown as { content: string } | undefined;
  if (brief?.content) return tidySummary(brief.content, cap);

  const prompt = db
    .prepare(
      `select mb.content from message m
       join message_block mb on mb.message_id = m.message_id
       where m.kind = 'user_prompt' and m.deleted_at is null
       order by m.source_event_order, mb.block_index limit 1`,
    )
    .get() as unknown as { content: string } | undefined;
  if (!prompt) return null;
  const text = tidySummary(decodeBlockContent("text", prompt.content).text, cap);
  return text.length > 0 ? text : null;
}

/** Summary text for one thread file, opened on its own. */
export function threadSummary(filePath: string): string | null {
  return withDb(filePath, threadSummaryText);
}

export interface ThreadOverview {
  threadId: string;
  createdAt: string;
  tokenEstimator: string;
  stats: ThreadQuickStats;
  messageKinds: Record<string, number>;
  derivationStates: Record<string, number>;
  chunkCount: number;
  view: ThreadViewInfo | null;
  visibilityBoundary: number | null;
  /** Readable summary paragraph (same source as `stats.summary`, less truncated). */
  summary: string | null;
}

export interface ThreadViewInfo {
  viewId: string;
  createdAt: string;
  compactPoint: number;
  coveredFrom: number;
  profileName: string | null;
  bands: { band: string; tokenCount: number }[];
}

export function threadOverview(filePath: string): ThreadOverview {
  const stats = threadQuickStats(filePath);
  return withDb(filePath, (db) => {
    const meta = db
      .prepare("select thread_id, created_at, token_estimator from thread_metadata where id = 1")
      .get() as unknown as {
      thread_id: string;
      created_at: string;
      token_estimator: string;
    };

    const messageKinds: Record<string, number> = {};
    for (const r of db
      .prepare("select kind, count(*) c from message where deleted_at is null group by kind")
      .all() as unknown as { kind: string; c: number }[]) {
      messageKinds[r.kind] = r.c;
    }

    const derivationStates: Record<string, number> = {};
    for (const r of db
      .prepare("select state, count(*) c from derivation group by state")
      .all() as unknown as { state: string; c: number }[]) {
      derivationStates[r.state] = r.c;
    }

    const chunk = db.prepare("select count(*) c from chunk").get() as unknown as { c: number };

    const viewRow = db
      .prepare(
        "select view_id, created_at, compact_point, covered_from, profile_name from thread_view where singleton = 1",
      )
      .get() as unknown as
      | {
          view_id: string;
          created_at: string;
          compact_point: number;
          covered_from: number;
          profile_name: string | null;
        }
      | undefined;

    let view: ThreadViewInfo | null = null;
    if (viewRow) {
      const bands = db
        .prepare("select band, token_count from thread_view_band where view_id = ? order by band")
        .all(viewRow.view_id) as unknown as {
        band: string;
        token_count: number;
      }[];
      view = {
        viewId: viewRow.view_id,
        createdAt: viewRow.created_at,
        compactPoint: viewRow.compact_point,
        coveredFrom: viewRow.covered_from,
        profileName: viewRow.profile_name,
        bands: bands.map((b) => ({ band: b.band, tokenCount: b.token_count })),
      };
    }

    const boundary = db
      .prepare("select position from view_boundary where thread_singleton = 1")
      .get() as unknown as { position: number } | undefined;

    return {
      threadId: meta.thread_id,
      createdAt: meta.created_at,
      tokenEstimator: meta.token_estimator,
      stats,
      messageKinds,
      derivationStates,
      chunkCount: chunk.c,
      view,
      visibilityBoundary: boundary ? boundary.position : null,
      summary: threadSummaryText(db, SUMMARY_CAP_LONG),
    };
  });
}

export interface TurnListing {
  turnId: string;
  turnOrder: number;
  status: string;
  outcome: string | null;
  startedAt: string | null;
  endedAt: string | null;
  messageCount: number;
  tokenEstimate: number;
  /** First user-prompt text of the turn, truncated for listing. */
  promptExcerpt: string | null;
}

/** Column names present on a table, for schema-tolerant queries. */
function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`pragma table_info(${table})`).all() as unknown as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

export function listTurns(filePath: string): TurnListing[] {
  return withDb(filePath, (db) => {
    // Older thread files predate turns.outcome/started_at/ended_at; select what
    // exists and recover timestamps from the event log below.
    const cols = tableColumns(db, "turns");
    const pick = (name: string): string => (cols.has(name) ? `t.${name}` : `null ${name}`);

    const turns = db
      .prepare(
        `select t.turn_id, t.turn_order, t.status, t.closed_at_event_order,
                ${pick("outcome")}, ${pick("started_at")}, ${pick("ended_at")},
                count(m.message_id) message_count,
                coalesce(sum(m.token_estimate), 0) token_estimate,
                min(m.source_event_order) first_event_order
         from turns t
         left join message m on m.turn_id = t.turn_id and m.deleted_at is null
         where t.deleted_at is null
         group by t.turn_id
         order by t.turn_order`,
      )
      .all() as unknown as {
      turn_id: string;
      turn_order: number;
      status: string;
      closed_at_event_order: number | null;
      outcome: string | null;
      started_at: string | null;
      ended_at: string | null;
      message_count: number;
      token_estimate: number;
      first_event_order: number | null;
    }[];

    const eventStmt = db.prepare("select recorded_at from event where event_order = ?");
    const stampAt = (order: number | null): string | null => {
      if (order == null) return null;
      const row = eventStmt.get(order) as unknown as { recorded_at: string } | undefined;
      return row?.recorded_at ?? null;
    };

    const promptStmt = db.prepare(
      `select mb.content from message m
       join message_block mb on mb.message_id = m.message_id
       where m.turn_id = ? and m.kind = 'user_prompt' and m.deleted_at is null
       order by m.source_event_order, mb.block_index limit 1`,
    );

    return turns.map((t) => {
      const prompt = promptStmt.get(t.turn_id) as unknown as { content: string } | undefined;
      return {
        turnId: t.turn_id,
        turnOrder: t.turn_order,
        status: t.status,
        outcome: t.outcome,
        startedAt: t.started_at ?? stampAt(t.first_event_order),
        endedAt: t.ended_at ?? (t.status === "closed" ? stampAt(t.closed_at_event_order) : null),
        messageCount: t.message_count,
        tokenEstimate: t.token_estimate,
        promptExcerpt: prompt
          ? decodeBlockContent("text", prompt.content).text.slice(0, 200)
          : null,
      };
    });
  });
}

/** Message-kind buckets the histogram stacks; `other` absorbs the rare kinds. */
export const TURN_KIND_BUCKETS = [
  "user_prompt",
  "assistant_text",
  "assistant_thinking",
  "tool_call",
  "tool_result",
  "other",
] as const;

export type TurnKindBucket = (typeof TURN_KIND_BUCKETS)[number];

function bucketOf(kind: string): TurnKindBucket {
  return (TURN_KIND_BUCKETS as readonly string[]).includes(kind)
    ? (kind as TurnKindBucket)
    : "other";
}

export interface TurnKindRow {
  turnId: string;
  turnOrder: number;
  status: string;
  startedAt: string | null;
  messageCount: number;
  /** Event-order span of the turn's messages; null when the turn has none. */
  firstEventOrder: number | null;
  lastEventOrder: number | null;
  /** Token estimate per bucket; every bucket present, zeroes included. */
  tokens: Record<TurnKindBucket, number>;
  totalTokens: number;
}

function emptyBuckets(): Record<TurnKindBucket, number> {
  return {
    user_prompt: 0,
    assistant_text: 0,
    assistant_thinking: 0,
    tool_call: 0,
    tool_result: 0,
    other: 0,
  };
}

/**
 * Per-turn token totals split by message-kind bucket — the histogram's data.
 * One grouped pass over `turns ⋈ message` (kept cheap on 400+ turn threads),
 * plus point lookups into `event` only where a turn timestamp has to be
 * recovered (older thread files have no `turns.started_at`).
 */
export function turnKinds(filePath: string): TurnKindRow[] {
  return withDb(filePath, (db) => {
    const cols = tableColumns(db, "turns");
    const pick = (name: string): string => (cols.has(name) ? `t.${name}` : `null ${name}`);

    const rows = db
      .prepare(
        `select t.turn_id, t.turn_order, t.status, ${pick("started_at")},
                ${pick("opened_at_event_order")},
                m.kind,
                count(m.message_id) message_count,
                coalesce(sum(m.token_estimate), 0) token_estimate,
                min(m.source_event_order) first_event_order,
                max(m.source_event_order) last_event_order
         from turns t
         left join message m on m.turn_id = t.turn_id and m.deleted_at is null
         where t.deleted_at is null
         group by t.turn_id, m.kind
         order by t.turn_order`,
      )
      .all() as unknown as {
      turn_id: string;
      turn_order: number;
      status: string;
      started_at: string | null;
      opened_at_event_order: number | null;
      kind: string | null;
      message_count: number;
      token_estimate: number;
      first_event_order: number | null;
      last_event_order: number | null;
    }[];

    const byTurn = new Map<string, TurnKindRow>();
    const order: TurnKindRow[] = [];
    const stampOrder = new Map<string, number | null>();

    for (const r of rows) {
      let turn = byTurn.get(r.turn_id);
      if (!turn) {
        turn = {
          turnId: r.turn_id,
          turnOrder: r.turn_order,
          status: r.status,
          startedAt: r.started_at,
          messageCount: 0,
          firstEventOrder: null,
          lastEventOrder: null,
          tokens: emptyBuckets(),
          totalTokens: 0,
        };
        byTurn.set(r.turn_id, turn);
        order.push(turn);
        stampOrder.set(r.turn_id, r.opened_at_event_order);
      }
      // A turn with no messages joins to a single all-null row.
      if (r.kind == null) continue;
      turn.tokens[bucketOf(r.kind)] += r.token_estimate;
      turn.totalTokens += r.token_estimate;
      turn.messageCount += r.message_count;
      if (r.first_event_order != null) {
        turn.firstEventOrder =
          turn.firstEventOrder == null
            ? r.first_event_order
            : Math.min(turn.firstEventOrder, r.first_event_order);
      }
      if (r.last_event_order != null) {
        turn.lastEventOrder =
          turn.lastEventOrder == null
            ? r.last_event_order
            : Math.max(turn.lastEventOrder, r.last_event_order);
      }
    }

    const eventStmt = db.prepare("select recorded_at from event where event_order = ?");
    for (const turn of order) {
      if (turn.startedAt != null) continue;
      const at = turn.firstEventOrder ?? stampOrder.get(turn.turnId) ?? null;
      if (at == null) continue;
      const row = eventStmt.get(at) as unknown as { recorded_at: string } | undefined;
      turn.startedAt = row?.recorded_at ?? null;
    }

    order.sort((a, b) => a.turnOrder - b.turnOrder);
    return order;
  });
}

/**
 * Block content is stored as a JSON envelope keyed by block type
 * (`{"text": …}`, `{"toolCallId", "toolName", "arguments"}`,
 * `{"toolCallId", "content"}`). Decode to display text plus tool identifiers;
 * fall back to the raw string when it does not parse.
 */
export function decodeBlockContent(
  blockType: string,
  content: string,
): { text: string; toolName?: string; toolCallId?: string } {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (blockType === "tool_call") {
      return {
        text: JSON.stringify(parsed.arguments ?? parsed, null, 2),
        toolName: typeof parsed.toolName === "string" ? parsed.toolName : undefined,
        toolCallId: typeof parsed.toolCallId === "string" ? parsed.toolCallId : undefined,
      };
    }
    if (blockType === "tool_result") {
      const inner = parsed.content;
      return {
        text: typeof inner === "string" ? inner : JSON.stringify(inner, null, 2),
        toolCallId: typeof parsed.toolCallId === "string" ? parsed.toolCallId : undefined,
      };
    }
    if (typeof parsed.text === "string") return { text: parsed.text };
    return { text: JSON.stringify(parsed, null, 2) };
  } catch {
    return { text: content };
  }
}

export interface MessageListing {
  messageId: string;
  sourceEventOrder: number;
  kind: string;
  actor: string;
  turnId: string;
  tokenEstimate: number;
  blocks: {
    blockIndex: number;
    blockType: string;
    /** Decoded display text, truncated; `contentLength` carries the full size. */
    content: string;
    contentLength: number;
    toolName?: string;
    toolCallId?: string;
  }[];
}

export interface ListMessagesOptions {
  turnId?: string;
  fromOrder?: number;
  toOrder?: number;
  limit?: number;
  /** Per-block content cap in characters (default 4000; 0 = no content). */
  blockContentCap?: number;
}

export function listMessages(filePath: string, opts: ListMessagesOptions = {}): MessageListing[] {
  const cap = opts.blockContentCap ?? 4000;
  const limit = Math.min(opts.limit ?? 500, 2000);
  return withDb(filePath, (db) => {
    const where: string[] = ["m.deleted_at is null"];
    const params: (string | number)[] = [];
    if (opts.turnId) {
      where.push("m.turn_id = ?");
      params.push(opts.turnId);
    }
    if (opts.fromOrder !== undefined) {
      where.push("m.source_event_order >= ?");
      params.push(opts.fromOrder);
    }
    if (opts.toOrder !== undefined) {
      where.push("m.source_event_order <= ?");
      params.push(opts.toOrder);
    }
    const messages = db
      .prepare(
        `select m.message_id, m.source_event_order, m.kind, m.actor, m.turn_id, m.token_estimate
         from message m where ${where.join(" and ")}
         order by m.source_event_order limit ?`,
      )
      .all(...params, limit) as unknown as {
      message_id: string;
      source_event_order: number;
      kind: string;
      actor: string;
      turn_id: string;
      token_estimate: number;
    }[];

    const blockStmt = db.prepare(
      "select block_index, block_type, content from message_block where message_id = ? order by block_index",
    );

    return messages.map((m) => ({
      messageId: m.message_id,
      sourceEventOrder: m.source_event_order,
      kind: m.kind,
      actor: m.actor,
      turnId: m.turn_id,
      tokenEstimate: m.token_estimate,
      blocks: (
        blockStmt.all(m.message_id) as unknown as {
          block_index: number;
          block_type: string;
          content: string;
        }[]
      ).map((b) => {
        const decoded = decodeBlockContent(b.block_type, b.content);
        return {
          blockIndex: b.block_index,
          blockType: b.block_type,
          content: cap === 0 ? "" : decoded.text.slice(0, cap),
          contentLength: decoded.text.length,
          toolName: decoded.toolName,
          toolCallId: decoded.toolCallId,
        };
      }),
    }));
  });
}

// --- thread-view arrangement ------------------------------------------------

/** Max characters of one entry's derivation content carried over the wire. */
const VIEW_CONTENT_CAP = 6000;

/** One turn covered by a view entry; `missing` when the row is gone or deleted. */
export interface ViewEntryTurn {
  turnId: string;
  turnOrder: number | null;
  status: string | null;
  missing: boolean;
}

/** One arrangement entry, resolved to its turns and its rendered content. */
export interface ViewArrangementEntry {
  /** Position in `arrangement_json`, so the UI can key without a synthetic id. */
  index: number;
  band: string;
  subjectKind: string;
  subjectId: string;
  derivationUsed: string | null;
  degraded: boolean;
  turns: ViewEntryTurn[];
  /** Turn-order span of the resolved turns; null when none resolve. */
  turnOrderFrom: number | null;
  turnOrderTo: number | null;
  /** State of the derivation actually used; null when the row is absent. */
  derivationState: string | null;
  /** No usable content: derivation missing, not ready, or empty. */
  gap: boolean;
  /** Derivation content, capped at `VIEW_CONTENT_CAP`. */
  content: string;
  contentLength: number;
}

/** One live-tail turn — the same shape the turn list shows, plus placement. */
export interface ViewTailTurn {
  turnId: string;
  turnOrder: number;
  status: string;
  messageCount: number;
  tokenEstimate: number;
  firstEventOrder: number | null;
  /** False for a turn the projection skipped rather than one that arrived after. */
  afterCompact: boolean;
  promptExcerpt: string | null;
}

export interface ViewArrangementMeta {
  viewId: string;
  createdAt: string;
  profileName: string | null;
  compactPoint: number;
  coveredFrom: number;
  bands: { band: string; tokenCount: number }[];
  /** Parsed `gaps_json`; empty array when absent or unparseable. */
  gaps: unknown[];
}

export interface ThreadViewArrangement {
  /** Null when the thread has never been compacted; then every turn is tail. */
  view: ViewArrangementMeta | null;
  entries: ViewArrangementEntry[];
  tail: ViewTailTurn[];
  tailTokens: number;
  /** Tail turns that begin at or after the compact point. */
  turnsSinceView: number;
  turnCount: number;
}

/** Turn facts the arrangement and the tail both need, in one pass. */
interface ViewTurnRow {
  turnId: string;
  turnOrder: number;
  status: string;
  messageCount: number;
  tokenEstimate: number;
  firstEventOrder: number | null;
}

function viewTurnRows(db: DatabaseSync): ViewTurnRow[] {
  const rows = db
    .prepare(
      `select t.turn_id, t.turn_order, t.status,
              count(m.message_id) message_count,
              coalesce(sum(m.token_estimate), 0) token_estimate,
              coalesce(min(m.source_event_order), t.opened_at_event_order) first_event_order
       from turns t
       left join message m on m.turn_id = t.turn_id and m.deleted_at is null
       where t.deleted_at is null
       group by t.turn_id
       order by t.turn_order`,
    )
    .all() as unknown as {
    turn_id: string;
    turn_order: number;
    status: string;
    message_count: number;
    token_estimate: number;
    first_event_order: number | null;
  }[];
  return rows.map((r) => ({
    turnId: r.turn_id,
    turnOrder: r.turn_order,
    status: r.status,
    messageCount: r.message_count,
    tokenEstimate: r.token_estimate,
    firstEventOrder: r.first_event_order,
  }));
}

function parseJsonArray(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * The latest thread-view projection, entry by entry, in thread order — each
 * arrangement entry resolved to the turns it covers and to the derivation
 * content the compact actually used — followed by the live tail.
 *
 * The tail is every non-deleted turn the arrangement does not cover, so
 * `entries ∪ tail` is exactly the thread's turns: nothing can fall between the
 * two. Turns that start at or after the compact point are the ones that truly
 * arrived since (`afterCompact`); a tail turn before it is one the projection
 * left out, and says so rather than being quietly dropped.
 */
export function threadViewArrangement(filePath: string): ThreadViewArrangement {
  return withDb(filePath, (db) => {
    const turnRows = viewTurnRows(db);
    const byTurnId = new Map(turnRows.map((t) => [t.turnId, t]));

    const viewRow = db
      .prepare(
        `select view_id, created_at, compact_point, covered_from, profile_name,
                arrangement_json, gaps_json
         from thread_view where singleton = 1`,
      )
      .get() as unknown as
      | {
          view_id: string;
          created_at: string;
          compact_point: number;
          covered_from: number;
          profile_name: string | null;
          arrangement_json: string | null;
          gaps_json: string | null;
        }
      | undefined;

    const promptStmt = db.prepare(
      `select mb.content from message m
       join message_block mb on mb.message_id = m.message_id
       where m.turn_id = ? and m.kind = 'user_prompt' and m.deleted_at is null
       order by m.source_event_order, mb.block_index limit 1`,
    );

    const tailTurn = (t: ViewTurnRow, compactPoint: number | null): ViewTailTurn => {
      const prompt = promptStmt.get(t.turnId) as unknown as { content: string } | undefined;
      return {
        turnId: t.turnId,
        turnOrder: t.turnOrder,
        status: t.status,
        messageCount: t.messageCount,
        tokenEstimate: t.tokenEstimate,
        firstEventOrder: t.firstEventOrder,
        afterCompact:
          compactPoint == null || (t.firstEventOrder != null && t.firstEventOrder >= compactPoint),
        promptExcerpt: prompt
          ? decodeBlockContent("text", prompt.content).text.slice(0, 200)
          : null,
      };
    };

    // Never compacted: the whole thread is live.
    if (!viewRow) {
      const tail = turnRows.map((t) => tailTurn(t, null));
      return {
        view: null,
        entries: [],
        tail,
        tailTokens: tail.reduce((s, t) => s + t.tokenEstimate, 0),
        turnsSinceView: tail.length,
        turnCount: turnRows.length,
      };
    }

    const members = new Map<string, string[]>();
    for (const r of db
      .prepare("select chunk_id, turn_id from chunk_member order by chunk_id, member_idx")
      .all() as unknown as { chunk_id: string; turn_id: string }[]) {
      const list = members.get(r.chunk_id);
      if (list) list.push(r.turn_id);
      else members.set(r.chunk_id, [r.turn_id]);
    }

    const derivStmt = db.prepare(
      `select state, content from derivation
       where subject_kind = ? and subject_id = ? and derivation_type = ?`,
    );

    const covered = new Set<string>();
    const entries: ViewArrangementEntry[] = [];

    for (const [index, raw] of parseJsonArray(viewRow.arrangement_json).entries()) {
      const e = (raw ?? {}) as Record<string, unknown>;
      const subjectKind = asString(e.subjectKind) ?? "turn";
      const subjectId = asString(e.subjectId) ?? "";
      const derivationUsed = asString(e.derivationUsed);

      const memberIds =
        subjectKind === "chunk" ? (members.get(subjectId) ?? []) : subjectId ? [subjectId] : [];
      const turns: ViewEntryTurn[] = memberIds.map((id) => {
        const t = byTurnId.get(id);
        if (t) covered.add(id);
        return {
          turnId: id,
          turnOrder: t?.turnOrder ?? null,
          status: t?.status ?? null,
          missing: !t,
        };
      });
      const orders = turns.map((t) => t.turnOrder).filter((o): o is number => o != null);

      const deriv = derivationUsed
        ? (derivStmt.get(subjectKind, subjectId, derivationUsed) as unknown as
            | { state: string; content: string | null }
            | undefined)
        : undefined;
      const content = deriv?.state === "ready" ? (deriv.content ?? "") : "";

      entries.push({
        index,
        band: asString(e.band) ?? "unknown",
        subjectKind,
        subjectId,
        derivationUsed,
        degraded: e.degraded === true,
        turns,
        turnOrderFrom: orders.length ? Math.min(...orders) : null,
        turnOrderTo: orders.length ? Math.max(...orders) : null,
        derivationState: deriv?.state ?? null,
        gap: content.length === 0,
        content: content.slice(0, VIEW_CONTENT_CAP),
        contentLength: content.length,
      });
    }

    const tail = turnRows
      .filter((t) => !covered.has(t.turnId))
      .map((t) => tailTurn(t, viewRow.compact_point));

    const bands = db
      .prepare(
        `select band, token_count from thread_view_band where view_id = ?
         order by case band when 'brief' then 0 when 'detailed' then 1 else 2 end`,
      )
      .all(viewRow.view_id) as unknown as { band: string; token_count: number }[];

    return {
      view: {
        viewId: viewRow.view_id,
        createdAt: viewRow.created_at,
        profileName: viewRow.profile_name,
        compactPoint: viewRow.compact_point,
        coveredFrom: viewRow.covered_from,
        bands: bands.map((b) => ({ band: b.band, tokenCount: b.token_count })),
        gaps: parseJsonArray(viewRow.gaps_json),
      },
      entries,
      tail,
      tailTokens: tail.reduce((s, t) => s + t.tokenEstimate, 0),
      turnsSinceView: tail.filter((t) => t.afterCompact).length,
      turnCount: turnRows.length,
    };
  });
}

/** Full stored view bands (rendered text) for a thread, if a compact exists. */
export function viewBands(
  filePath: string,
): { band: string; tokenCount: number; renderedText: string }[] {
  return withDb(filePath, (db) => {
    const rows = db
      .prepare(
        `select b.band, b.token_count, b.rendered_text
         from thread_view v join thread_view_band b on b.view_id = v.view_id
         where v.singleton = 1
         order by case b.band when 'brief' then 0 when 'detailed' then 1 else 2 end`,
      )
      .all() as unknown as {
      band: string;
      token_count: number;
      rendered_text: string;
    }[];
    return rows.map((r) => ({
      band: r.band,
      tokenCount: r.token_count,
      renderedText: r.rendered_text,
    }));
  });
}
