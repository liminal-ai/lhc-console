import { withDb } from "./db.ts";

/** Cheap per-thread stats for the aggregated list view. */
export interface ThreadQuickStats {
  eventCount: number;
  messageCount: number;
  turnCount: number;
  closedTurnCount: number;
  totalTokenEstimate: number;
  lastEventAt: string | null;
  lastCompactAt: string | null;
  pendingWork: number;
  failedDerivations: number;
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
    const view = one<{ last: string | null }>("select max(created_at) last from thread_view");
    const work = one<{ c: number }>("select count(*) c from work_item");
    const failed = one<{ c: number }>(
      "select count(*) c from derivation where state in ('failed','blocked')",
    );

    return {
      eventCount: events.c,
      messageCount: messages.c,
      turnCount: turns.c,
      closedTurnCount: turns.closed ?? 0,
      totalTokenEstimate: messages.tokens ?? 0,
      lastEventAt: events.last,
      lastCompactAt: view.last,
      pendingWork: work.c,
      failedDerivations: failed.c,
    };
  });
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

export function listTurns(filePath: string): TurnListing[] {
  return withDb(filePath, (db) => {
    const turns = db
      .prepare(
        `select t.turn_id, t.turn_order, t.status, t.outcome, t.started_at, t.ended_at,
                count(m.message_id) message_count,
                coalesce(sum(m.token_estimate), 0) token_estimate
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
      outcome: string | null;
      started_at: string | null;
      ended_at: string | null;
      message_count: number;
      token_estimate: number;
    }[];

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
        startedAt: t.started_at,
        endedAt: t.ended_at,
        messageCount: t.message_count,
        tokenEstimate: t.token_estimate,
        promptExcerpt: prompt
          ? decodeBlockContent("text", prompt.content).text.slice(0, 200)
          : null,
      };
    });
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
