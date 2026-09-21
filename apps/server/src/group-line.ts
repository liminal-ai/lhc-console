// Group line core: channel-agnostic routing, wake prompts and fan-in over one
// transcript. Transports (Photon DM, web) call handleGroupOwnerMessage with the
// owner's text and deliver what fanInGroupReply hands back. No channel
// knowledge lives here beyond the channel label in the prompt header.
import type { AgentRecord, GroupCatchUp, GroupRecord } from "./agent-registry.ts";
import type { GroupTranscript, TranscriptMessage } from "./group-transcript.ts";
import { compileMentionPatterns, matchesMention } from "./mention-patterns.ts";
import { renderRelayPrompt } from "./relay-prompt.ts";
import type { RelayJob, RelayQueue } from "./relay.ts";

export const GROUP_LINE_KIND = "group_line";
export const OWNER_SENDER_ID = "lee";
export const OWNER_LABEL = "Lee";
const PHONE_REPLY_GUIDANCE = "[reply for iPhone on the go]";
const DEFAULT_BROADCAST_PATTERNS = [String.raw`(?<![\w@])@(?:all|everyone|both)\b[,:\-]?`];

export type GroupChannel = "iMessage" | "web";

export interface GroupMember {
  id: string;
  label: string;
  patterns: RegExp[];
}

export interface GroupLineWakeMetadata extends Record<string, unknown> {
  kind: typeof GROUP_LINE_KIND;
  groupId: string;
  memberId: string;
  memberLabel: string;
  /** Transcript seq of the owner line that woke this member. */
  wakeSeq: number;
  channel: GroupChannel;
}

export function isGroupLineMetadata(value: unknown): value is GroupLineWakeMetadata {
  if (!value || typeof value !== "object") return false;
  const meta = value as Record<string, unknown>;
  return (
    meta.kind === GROUP_LINE_KIND &&
    typeof meta.groupId === "string" &&
    typeof meta.memberId === "string" &&
    typeof meta.memberLabel === "string" &&
    typeof meta.wakeSeq === "number"
  );
}

/** Members of a group in registry order; the registry already rejected bad ones. */
export function resolveGroupMembers(group: GroupRecord, agents: AgentRecord[]): GroupMember[] {
  const members: GroupMember[] = [];
  for (const id of group.group.members) {
    const record = agents.find((agent) => agent.id === id);
    if (!record) continue;
    members.push({
      id: record.id,
      label: record.name,
      patterns: compileMentionPatterns(record.mentionPatterns),
    });
  }
  return members;
}

export interface GroupRoute {
  /** Member ids to wake, in group order. Empty when nobody was tagged. */
  wakes: string[];
}

/**
 * Pure: who does this owner line wake. A member wakes when its own patterns
 * match, on a broadcast tag, or when listed in `wake`; untagged text wakes
 * nobody. Every woken member reads the owner's text verbatim: stripping the
 * member's own name made "Sable, Flint ..." read as addressed to the other one.
 */
export function routeGroupMessage(
  group: Pick<GroupRecord, "mentionPatterns">,
  members: GroupMember[],
  text: string,
  wake: readonly string[] = [],
): GroupRoute {
  const broadcast = compileMentionPatterns(
    group.mentionPatterns.length ? group.mentionPatterns : DEFAULT_BROADCAST_PATTERNS,
  );
  const all = matchesMention(text, broadcast);
  const wakes: string[] = [];
  for (const member of members) {
    if (!all && !wake.includes(member.id) && !matchesMention(text, member.patterns)) continue;
    wakes.push(member.id);
  }
  return { wakes };
}

export function groupPromptHeader(groupId: string, channel: GroupChannel): string {
  return `[from: lee, channel: ${channel} group ${groupId}]`;
}

/**
 * Rule 3/4: the transcript since the member's cursor (owner lines and other
 * members' replies, labeled, oldest first), then the owner's new text. The
 * history block is omitted when there is nothing to catch up on.
 */
export function buildGroupWakePrompt(input: {
  groupId: string;
  channel: GroupChannel;
  history: TranscriptMessage[];
  trimmed: number;
  newText: string;
}): string {
  const lines: string[] = [];
  if (input.trimmed > 0) {
    lines.push(`[${input.trimmed} earlier message${input.trimmed === 1 ? "" : "s"} trimmed]`);
  }
  for (const message of input.history) {
    lines.push(`${message.senderLabel}: ${message.text}`);
  }
  const context = lines.length
    ? `[${input.groupId} messages since your last reply]\n${lines.join("\n")}`
    : undefined;
  const body = renderRelayPrompt(input.newText, context);
  return `${groupPromptHeader(input.groupId, input.channel)}\n${body}\n\n${PHONE_REPLY_GUIDANCE}`;
}

export function historyWindow(catchUp: GroupCatchUp): { lastN?: number; none?: boolean } {
  if (catchUp.mode === "last") return { none: true };
  if (catchUp.mode === "window") return { lastN: catchUp.messages };
  return {};
}

export interface OwnerMessageInput {
  group: GroupRecord;
  members: GroupMember[];
  transcript: GroupTranscript;
  queue: Pick<RelayQueue, "enqueue">;
  text: string;
  channel: GroupChannel;
  /** Transport message id for idempotency (Photon message id, web request id). */
  inboundMessageId?: string | null;
  /** Destination the member replies are delivered to (Photon space id). */
  destination: Record<string, string>;
  at?: string;
  /** Members to wake regardless of tags (web default recipients); unioned with the tags. */
  wake?: readonly string[];
}

export type MemberActivity =
  | { state: "working"; wakeSeq: number; since: string }
  | { state: "idle" };

/** Per-member activity from the group's unsettled wake jobs (oldest wake wins). */
export function deriveMemberActivity(
  members: readonly Pick<GroupMember, "id">[],
  unsettled: readonly Pick<RelayJob, "target" | "createdAt" | "delivery">[],
): Record<string, MemberActivity> {
  const out: Record<string, MemberActivity> = {};
  for (const member of members) out[member.id] = { state: "idle" };
  for (const job of unsettled) {
    const metadata = job.delivery?.metadata;
    if (!isGroupLineMetadata(metadata) || !(metadata.memberId in out)) continue;
    const current = out[metadata.memberId];
    if (current?.state === "working" && current.since <= job.createdAt) continue;
    out[metadata.memberId] = { state: "working", wakeSeq: metadata.wakeSeq, since: job.createdAt };
  }
  return out;
}

/**
 * Append the owner line and wake the tagged members. A repeated inbound id
 * (redelivery) appends nothing and wakes nobody. Returns the jobs enqueued.
 */
export function handleGroupOwnerMessage(input: OwnerMessageInput): RelayJob[] {
  const text = input.text.trim();
  if (!text) return [];
  const { message, inserted } = input.transcript.append({
    senderId: OWNER_SENDER_ID,
    senderLabel: OWNER_LABEL,
    text,
    at: input.at,
    inboundMessageId: input.inboundMessageId ?? null,
  });
  if (!inserted) return [];
  const route = routeGroupMessage(input.group, input.members, text, input.wake ?? []);
  const jobs: RelayJob[] = [];
  const window = historyWindow(input.group.group.catchUp);
  for (const memberId of route.wakes) {
    const member = input.members.find((entry) => entry.id === memberId)!;
    // The new owner line is delivered as [New message], never as history; the
    // member's own earlier replies never come back to it (rule 6).
    const slice = window.none
      ? { messages: [], trimmed: 0 }
      : input.transcript.since(input.transcript.cursor(memberId), { beforeSeq: message.seq });
    let history = slice.messages.filter((entry) => entry.senderId !== memberId);
    let trimmed = slice.trimmed;
    if (window.lastN !== undefined && history.length > window.lastN) {
      trimmed += history.length - window.lastN;
      history = history.slice(history.length - window.lastN);
    }
    const prompt = buildGroupWakePrompt({
      groupId: input.group.id,
      channel: input.channel,
      history,
      trimmed,
      newText: text,
    });
    const metadata: GroupLineWakeMetadata = {
      kind: GROUP_LINE_KIND,
      groupId: input.group.id,
      memberId,
      memberLabel: member.label,
      wakeSeq: message.seq,
      channel: input.channel,
    };
    jobs.push(
      input.queue.enqueue({
        target: memberId,
        prompt,
        jobClass: "prioritized",
        delivery: { channel: "photon", destination: input.destination, metadata },
      }),
    );
  }
  return jobs;
}

/**
 * Fan-in: write the member's reply, then park that member's cursor on the
 * owner line that woke it (already read as [New message]); everything after
 * it, minus the member's own lines, is that member's next history. Parking
 * on the wake rather than on the reply means a member that answered last
 * still sees the other members' answers to the same wake. Idempotent on job id.
 */
export function fanInGroupReply(
  transcript: GroupTranscript,
  meta: GroupLineWakeMetadata,
  job: Pick<RelayJob, "id" | "output" | "finishedAt">,
): TranscriptMessage {
  const { message } = transcript.append({
    senderId: meta.memberId,
    senderLabel: meta.memberLabel,
    text: (job.output ?? "").trim(),
    at: job.finishedAt ?? undefined,
    jobId: job.id,
  });
  transcript.advanceCursor(meta.memberId, meta.wakeSeq);
  return message;
}

/** iMessage rendering of a member line: bold display name, then the text. */
export function formatGroupReply(label: string, text: string): string {
  return `**${label}:** ${text}`;
}
