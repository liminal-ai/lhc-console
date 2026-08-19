import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { V2Event } from "./contract.ts";
import { RuntimeManager } from "./manager.ts";

export interface V2RouteOptions {
  manager: RuntimeManager;
  token: string;
  enabled: boolean;
  /**
   * Maximum events held while historical replay is still running. Reaching it
   * ends the stream with an explicit resnapshot requirement rather than
   * growing without bound or dropping an event quietly.
   */
  eventBacklogLimit?: number;
}

const DEFAULT_EVENT_BACKLOG_LIMIT = 5_000;
const EVENT_PAGE_LIMIT = 1000;

export function registerV2Routes(app: FastifyInstance, options: V2RouteOptions): void {
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!options.enabled) {
      return reply.code(404).send({ error: "v2 disabled" });
    }
    const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    if (!sameToken(supplied, options.token)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  };

  app.post(
    "/api/v2/targets/:target/commands",
    { preHandler: authorize },
    async (request, reply) => {
      const { target } = request.params as { target: string };
      const body = (request.body ?? {}) as {
        commandId?: unknown;
        kind?: unknown;
        params?: unknown;
      };
      try {
        const receipt = await options.manager.submit({
          target,
          commandId: body.commandId,
          kind: body.kind,
          params: body.params,
        });
        const status = receipt.state === "rejected" ? 409 : 200;
        return reply.code(status).send(receipt);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = message.includes("not opted") || message.includes("unknown relay") ? 404 : 400;
        return reply.code(code).send({ error: message });
      }
    },
  );

  app.get("/api/v2/targets/:target/status", { preHandler: authorize }, async (request, reply) => {
    const { target } = request.params as { target: string };
    try {
      return options.manager.status(target);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(404).send({ error: message });
    }
  });

  app.get("/api/v2/commands/:commandId", { preHandler: authorize }, async (request, reply) => {
    const { commandId } = request.params as { commandId: string };
    const query = request.query as { wait?: string };
    if (query.wait === "terminal") {
      const receipt = await options.manager.wait(commandId);
      if (!receipt) return reply.code(404).send({ error: "v2 command not found" });
      return receipt;
    }
    const row = options.manager.getCommand(commandId);
    if (!row) return reply.code(404).send({ error: "v2 command not found" });
    const receipt = await options.manager.wait(commandId, 0);
    return (
      receipt ?? {
        commandId: row.commandId,
        kind: row.kind,
        target: row.target,
        state: row.receipt,
      }
    );
  });

  app.get("/api/v2/targets/:target/events", { preHandler: authorize }, async (request, reply) => {
    const { target } = request.params as { target: string };
    const query = request.query as { after?: string; live?: string };
    const after = query.after !== undefined ? Number(query.after) : 0;
    if (!Number.isInteger(after) || after < 0) {
      return reply.code(400).send({ error: "after must be a non-negative integer" });
    }
    const backlogLimit = options.eventBacklogLimit ?? DEFAULT_EVENT_BACKLOG_LIMIT;
    try {
      const min = options.manager.minEventSeq(target);
      if (min !== null && after + 1 < min && after !== 0) {
        return reply.code(410).send({
          error: "event cursor is older than retention",
          snapshot: options.manager.status(target),
        });
      }
      if (query.live === "0") {
        // Snapshot read: no subscription is taken, so there is no replay-to-live
        // handoff to get wrong.
        const page = options.manager.eventsAfter(target, after, EVENT_PAGE_LIMIT);
        return {
          events: page,
          lastEventSeq: options.manager.lastEventSeq(target),
          nextAfter: page.at(-1)?.seq ?? after,
          truncated: page.length === EVENT_PAGE_LIMIT,
        };
      }
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });

      /**
       * One subscriber, installed before the first page read and removed only
       * when the connection ends. It starts in `buffer` mode and flips to
       * `live` in the same synchronous step that finishes replay. Unsubscribing
       * to flush and then re-subscribing would leave a window in which an
       * emitted event has no handler at all; there is no such window here.
       */
      let mode: "buffer" | "live" | "closed" = "buffer";
      const pending: V2Event[] = [];
      let firstUndeliveredSeq: number | null = null;

      /**
       * Per-target `seq` is strictly increasing, so a high-water mark is a
       * complete dedupe between the durable pages and anything buffered live —
       * and it is O(1) where the previous seen-set grew with the stream.
       */
      let lastDeliveredSeq = after;
      const writeEvent = (event: V2Event) => {
        if (event.seq <= lastDeliveredSeq) return;
        lastDeliveredSeq = event.seq;
        reply.raw.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
      };

      let unsubscribe = () => {};
      const stop = () => {
        if (mode === "closed") return;
        mode = "closed";
        pending.length = 0;
        unsubscribe();
      };

      /**
       * Bounded, and never silent: the client is told the stream stopped being
       * complete and at which seq, so it re-baselines from status the same way
       * a cursor older than retention does.
       */
      const endOverflowed = () => {
        const notice = {
          error: "event backlog exceeded before replay completed",
          reason: "replay_backlog_overflow",
          backlogLimit,
          lastDeliveredSeq,
          firstUndeliveredSeq,
          resnapshot: true,
        };
        stop();
        reply.raw.write(`event: overflow\ndata: ${JSON.stringify(notice)}\n\n`);
        reply.raw.end();
      };

      unsubscribe = options.manager.onEvent((event) => {
        if (mode === "closed") return;
        if (event.target !== target || event.seq <= after) return;
        if (mode === "live") {
          writeEvent(event);
          return;
        }
        if (pending.length >= backlogLimit) {
          if (firstUndeliveredSeq === null) firstUndeliveredSeq = event.seq;
          endOverflowed();
          return;
        }
        pending.push(event);
      });

      request.raw.on("close", () => {
        stop();
        reply.raw.end();
      });

      try {
        let cursor = after;
        let page = options.manager.eventsAfter(target, cursor, EVENT_PAGE_LIMIT);
        while (page.length > 0 && mode === "buffer") {
          for (const event of page) writeEvent(event);
          cursor = page[page.length - 1]!.seq;
          if (page.length < EVENT_PAGE_LIMIT) break;
          page = options.manager.eventsAfter(target, cursor, EVENT_PAGE_LIMIT);
        }
        if (mode === "buffer") {
          // Flush and flip in one synchronous step. From here the same
          // subscriber delivers directly, so nothing can land in between.
          pending.sort((a, b) => a.seq - b.seq);
          for (const event of pending) writeEvent(event);
          pending.length = 0;
          mode = "live";
        }
      } catch (error) {
        stop();
        throw error;
      }
      return reply;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(404).send({ error: message });
    }
  });
}

function sameToken(supplied: string, expected: string): boolean {
  if (!supplied || !expected) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
