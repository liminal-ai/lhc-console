// Group-line HTTP transport: read the transcript, post an owner message into
// the same router the Photon line uses. Owner bearer (the relay token) on every
// route; the t3code fork proxies these with the token from its own server, so
// no browser ever holds it. Pull-based: the page polls `since`; member replies
// still fan in to every transport the group enables (iMessage); readers poll.
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AgentRecord, GroupRecord } from "./agent-registry.ts";
import {
  deriveMemberActivity,
  handleGroupOwnerMessage,
  resolveGroupMembers,
  type MemberActivity,
} from "./group-line.ts";
import type { GroupTranscript, TranscriptMessage } from "./group-transcript.ts";
import type { RelayQueue } from "./relay.ts";

export interface GroupRouteOptions {
  groups: GroupRecord[];
  agents: AgentRecord[];
  token: string;
  queue: Pick<RelayQueue, "enqueue" | "listUnsettledGroupJobs">;
  openTranscript: (groupId: string) => GroupTranscript;
}

export interface PublicGroup {
  id: string;
  name: string;
  description: string;
  members: Array<{ id: string; label: string }>;
  catchUp: GroupRecord["group"]["catchUp"];
  channels: string[];
}

export interface PublicGroupDetail extends PublicGroup {
  /** Each member's cursor: the last transcript seq it has been shown. */
  members: Array<{ id: string; label: string; cursorSeq: number; activity: MemberActivity }>;
  lastSeq: number;
}

export interface PublicGroupMessage {
  seq: number;
  senderId: string;
  senderLabel: string;
  text: string;
  at: string;
}

const MAX_MESSAGE_LENGTH = 8_000;
const LIST_LIMIT = 500;

export function registerGroupRoutes(app: FastifyInstance, options: GroupRouteOptions): void {
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    if (!sameToken(supplied, options.token)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  };
  const find = (id: string): GroupRecord | undefined =>
    options.groups.find((group) => group.id === id);

  app.get("/api/groups", { preHandler: authorize }, async () =>
    options.groups.map((group) => toPublicGroup(group, options.agents)),
  );

  app.get<{ Params: { id: string } }>(
    "/api/groups/:id",
    { preHandler: authorize },
    async (request, reply) => {
      const group = find(request.params.id);
      if (!group) return reply.code(404).send({ error: `unknown group: ${request.params.id}` });
      const transcript = options.openTranscript(group.id);
      const base = toPublicGroup(group, options.agents);
      const activity = deriveMemberActivity(
        base.members,
        options.queue.listUnsettledGroupJobs(group.id),
      );
      const detail: PublicGroupDetail = {
        ...base,
        members: base.members.map((member) => ({
          ...member,
          cursorSeq: transcript.cursor(member.id),
          activity: activity[member.id] ?? { state: "idle" },
        })),
        lastSeq: transcript.lastSeq(),
      };
      return detail;
    },
  );

  app.get<{ Params: { id: string }; Querystring: { since?: string } }>(
    "/api/groups/:id/messages",
    { preHandler: authorize },
    async (request, reply) => {
      const group = find(request.params.id);
      if (!group) return reply.code(404).send({ error: `unknown group: ${request.params.id}` });
      const since = parseSince(request.query.since);
      if (since === null)
        return reply.code(400).send({ error: "since must be a non-negative integer" });
      const transcript = options.openTranscript(group.id);
      const messages = transcript.list(since, LIST_LIMIT).map(toPublicMessage);
      return { messages, lastSeq: transcript.lastSeq() };
    },
  );

  app.post<{ Params: { id: string }; Body: { text?: unknown; id?: unknown; wake?: unknown } }>(
    "/api/groups/:id/messages",
    { preHandler: authorize },
    async (request, reply) => {
      const group = find(request.params.id);
      if (!group) return reply.code(404).send({ error: `unknown group: ${request.params.id}` });
      const text = typeof request.body?.text === "string" ? request.body.text.trim() : "";
      if (!text) return reply.code(400).send({ error: "text is required" });
      if (text.length > MAX_MESSAGE_LENGTH) {
        return reply
          .code(400)
          .send({ error: `text must be at most ${MAX_MESSAGE_LENGTH} characters` });
      }
      const clientId = typeof request.body?.id === "string" && request.body.id.trim();
      const inboundMessageId = `web:${clientId || randomUUID()}`;
      const members = resolveGroupMembers(group, options.agents);
      const rawWake = request.body?.wake;
      if (rawWake !== undefined && !Array.isArray(rawWake)) {
        return reply.code(400).send({ error: "wake must be an array of member ids" });
      }
      const wake = (rawWake ?? []) as unknown[];
      const unknown = wake.filter(
        (id) => typeof id !== "string" || !members.some((member) => member.id === id),
      );
      if (unknown.length) {
        return reply.code(400).send({ error: `wake: unknown member(s): ${unknown.join(", ")}` });
      }
      const transcript = options.openTranscript(group.id);
      const spaceId = group.channels.photon?.notifySpaceId;
      const jobs = handleGroupOwnerMessage({
        group,
        members,
        transcript,
        queue: options.queue,
        text,
        channel: "web",
        inboundMessageId,
        destination: spaceId ? { spaceId } : {},
        wake: wake as string[],
      });
      const line = transcript
        .list(0, LIST_LIMIT)
        .find((m) => m.inboundMessageId === inboundMessageId);
      return reply.code(202).send({
        seq: line?.seq ?? null,
        wakes: jobs.map((job) => ({ jobId: job.id, memberId: job.target })),
      });
    },
  );
}

function parseSince(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return 0;
  if (!/^\d+$/.test(raw)) return null;
  return Number(raw);
}

function toPublicGroup(group: GroupRecord, agents: AgentRecord[]): PublicGroup {
  return {
    id: group.id,
    name: group.name,
    description: group.description,
    members: resolveGroupMembers(group, agents).map((member) => ({
      id: member.id,
      label: member.label,
    })),
    catchUp: group.group.catchUp,
    channels: Object.keys(group.channels).sort(),
  };
}

function toPublicMessage(message: TranscriptMessage): PublicGroupMessage {
  return {
    seq: message.seq,
    senderId: message.senderId,
    senderLabel: message.senderLabel,
    text: message.text,
    at: message.at,
  };
}

function sameToken(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
