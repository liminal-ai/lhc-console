import { describe, expect, it } from "vite-plus/test";
import type { AgentRecord, GroupRecord } from "../src/agent-registry.ts";
import {
  buildGroupWakePrompt,
  deriveMemberActivity,
  fanInGroupReply,
  formatGroupReply,
  handleGroupOwnerMessage,
  resolveGroupMembers,
  routeGroupMessage,
  type GroupLineWakeMetadata,
} from "../src/group-line.ts";
import { GroupTranscript } from "../src/group-transcript.ts";
import type { RelayJob } from "../src/relay.ts";

const relay = { hostId: "t3code", threadId: "th", cwd: "/tmp", command: "true", args: [] };

function seat(id: string, name: string): AgentRecord {
  return {
    id,
    name,
    description: `${name} seat`,
    duties: [],
    ownerSenderIds: ["+1555"],
    mentionPatterns: [String.raw`(?<![\w@])@?${id}\b[,\-:]?`],
    channels: {},
    relay,
  };
}

function group(overrides: Partial<GroupRecord["group"]> = {}): GroupRecord {
  return {
    id: "spec-group",
    name: "spec-group",
    description: "group line",
    duties: [],
    ownerSenderIds: ["+1555"],
    mentionPatterns: [],
    channels: { photon: { address: "+1999", envFile: "x.env", notifySpaceId: "dm" } },
    group: { members: ["sable", "flint"], catchUp: { mode: "all" }, ...overrides },
  };
}

const agents = [seat("sable", "Sable"), seat("flint", "Flint"), seat("reed", "Reed")];
const members = resolveGroupMembers(group(), agents);

interface FakeQueue {
  jobs: RelayJob[];
  enqueue: (input: {
    target: string;
    prompt: string;
    jobClass?: string;
    delivery?: RelayJob["delivery"] | null;
  }) => RelayJob;
}

function fakeQueue(): FakeQueue {
  const jobs: RelayJob[] = [];
  return {
    jobs,
    enqueue: (input) => {
      const job = {
        id: `job-${jobs.length + 1}`,
        target: input.target,
        prompt: input.prompt,
        status: "queued",
        output: null,
        error: null,
        createdAt: "t",
        startedAt: null,
        finishedAt: null,
        notify: null,
        delivery: input.delivery ?? null,
        deliveryStatus: "pending",
        deliveryError: null,
        jobClass: input.jobClass ?? "deprioritized",
        jobKind: "agent",
        sender: null,
      } as unknown as RelayJob;
      jobs.push(job);
      return job;
    },
  };
}

function owner(
  transcript: GroupTranscript,
  queue: FakeQueue,
  text: string,
  id: string,
  catchUp?: GroupRecord["group"]["catchUp"],
): RelayJob[] {
  const record = catchUp ? group({ catchUp }) : group();
  return handleGroupOwnerMessage({
    group: record,
    members: resolveGroupMembers(record, agents),
    transcript,
    queue,
    text,
    channel: "iMessage",
    inboundMessageId: id,
    destination: { spaceId: "dm" },
    at: "2026-09-21T00:00:00Z",
  });
}

function reply(transcript: GroupTranscript, job: RelayJob, output: string): void {
  const meta = job.delivery?.metadata as GroupLineWakeMetadata;
  fanInGroupReply(transcript, meta, { id: job.id, output, finishedAt: "2026-09-21T00:00:01Z" });
}

describe("routeGroupMessage", () => {
  it("wakes only the tagged member and strips its own tag", () => {
    const route = routeGroupMessage(group(), members, "@flint what is the status?");
    expect(route.wakes).toEqual(["flint"]);
    expect(route.stripped.get("flint")).toBe("what is the status?");
  });

  it("wakes both when both are tagged, leaving the other member's tag in place", () => {
    const route = routeGroupMessage(group(), members, "@flint @sable we're in a group, respond");
    expect(route.wakes).toEqual(["sable", "flint"]);
    expect(route.stripped.get("sable")).toBe("@flint we're in a group, respond");
    expect(route.stripped.get("flint")).toBe("@sable we're in a group, respond");
  });

  it("wakes everyone on @all and @everyone", () => {
    expect(routeGroupMessage(group(), members, "@all status?").wakes).toEqual(["sable", "flint"]);
    expect(routeGroupMessage(group(), members, "hey @everyone").wakes).toEqual(["sable", "flint"]);
    expect(routeGroupMessage(group(), members, "@all status?").stripped.get("flint")).toBe(
      "@all status?",
    );
  });

  it("uses the group's own broadcast patterns when configured", () => {
    const custom = { mentionPatterns: [String.raw`(?<![\w@])@team\b`] };
    expect(routeGroupMessage(custom, members, "@team go").wakes).toEqual(["sable", "flint"]);
    expect(routeGroupMessage(custom, members, "@all go").wakes).toEqual([]);
  });

  it("unions explicit wake ids with the tags; unknown ids are ignored; nothing without either", () => {
    expect(routeGroupMessage(group(), members, "no tags here", ["sable"]).wakes).toEqual(["sable"]);
    const both = routeGroupMessage(group(), members, "@flint look", ["sable"]);
    expect(both.wakes).toEqual(["sable", "flint"]);
    expect(both.stripped.get("flint")).toBe("look");
    expect(routeGroupMessage(group(), members, "@flint look", ["flint"]).wakes).toEqual(["flint"]);
    expect(routeGroupMessage(group(), members, "plain", ["reed"]).wakes).toEqual([]);
    expect(routeGroupMessage(group(), members, "plain", []).wakes).toEqual([]);
  });

  it("wakes nobody on untagged text or an unknown tag", () => {
    expect(routeGroupMessage(group(), members, "just thinking out loud").wakes).toEqual([]);
    expect(routeGroupMessage(group(), members, "@reed are you there?").wakes).toEqual([]);
  });
});

describe("deriveMemberActivity", () => {
  const job = (memberId: string, wakeSeq: number, createdAt: string) => ({
    target: memberId,
    createdAt,
    delivery: {
      channel: "photon" as const,
      destination: {},
      metadata: {
        kind: "group_line",
        groupId: "spec-group",
        memberId,
        memberLabel: memberId,
        wakeSeq,
        channel: "web",
      } satisfies GroupLineWakeMetadata,
    },
  });

  it("marks members with an unsettled wake as working since their oldest wake, others idle", () => {
    const activity = deriveMemberActivity(members, [
      job("flint", 9, "2026-09-21T16:00:09Z"),
      job("flint", 7, "2026-09-21T16:00:07Z"),
      job("reed", 8, "2026-09-21T16:00:08Z"),
    ]);
    expect(activity).toEqual({
      sable: { state: "idle" },
      flint: { state: "working", wakeSeq: 7, since: "2026-09-21T16:00:07Z" },
    });
  });

  it("ignores jobs without group-line metadata", () => {
    expect(
      deriveMemberActivity(members, [{ target: "sable", createdAt: "x", delivery: null }]),
    ).toEqual({ sable: { state: "idle" }, flint: { state: "idle" } });
  });
});

describe("buildGroupWakePrompt", () => {
  it("renders the header, labeled history oldest first, and the new message", () => {
    const prompt = buildGroupWakePrompt({
      groupId: "spec-group",
      channel: "iMessage",
      history: [
        {
          seq: 1,
          senderId: "lee",
          senderLabel: "Lee",
          text: "@flint hi",
          at: "t",
          jobId: null,
          inboundMessageId: "m1",
        },
        {
          seq: 2,
          senderId: "flint",
          senderLabel: "Flint",
          text: "hello",
          at: "t",
          jobId: "j1",
          inboundMessageId: null,
        },
      ],
      trimmed: 0,
      newText: "your turn",
    });
    expect(prompt).toBe(
      [
        "[from: lee, channel: iMessage group spec-group]",
        "[spec-group messages since your last reply]",
        "Lee: @flint hi",
        "Flint: hello",
        "",
        "[New message]",
        "your turn",
        "",
        "[reply for iPhone on the go]",
      ].join("\n"),
    );
  });

  it("omits the history block when there is nothing to catch up on, and marks trimmed lines", () => {
    expect(
      buildGroupWakePrompt({
        groupId: "spec-group",
        channel: "web",
        history: [],
        trimmed: 0,
        newText: "hi",
      }),
    ).toBe("[from: lee, channel: web group spec-group]\nhi\n\n[reply for iPhone on the go]");
    expect(
      buildGroupWakePrompt({
        groupId: "g",
        channel: "web",
        history: [],
        trimmed: 3,
        newText: "hi",
      }),
    ).toContain("[3 earlier messages trimmed]");
  });
});

describe("handleGroupOwnerMessage + fanInGroupReply", () => {
  it("live-test script: Flint alone, then Sable catches up on Lee's lines and Flint's replies, not her own", () => {
    const transcript = new GroupTranscript(":memory:");
    const queue = fakeQueue();
    const first = owner(transcript, queue, "@flint @sable we're in a group, respond", "m1");
    expect(first.map((job) => job.target)).toEqual(["sable", "flint"]);
    expect(first[0]!.jobClass).toBe("prioritized");
    // First wake: nothing to catch up on, so no history block and no [New message] label.
    expect(first[0]!.prompt).toBe(
      "[from: lee, channel: iMessage group spec-group]\n@flint we're in a group, respond\n\n[reply for iPhone on the go]",
    );
    reply(transcript, first[0]!, "Sable here.");
    reply(transcript, first[1]!, "Flint here.");

    const second = owner(transcript, queue, "@flint how is the build?", "m2");
    expect(second.map((job) => job.target)).toEqual(["flint"]);
    // Flint's history: Sable's reply only (his own is excluded, Lee's first line was his wake).
    expect(second[0]!.prompt).toContain(
      "[spec-group messages since your last reply]\nSable: Sable here.\n\n[New message]\nhow is the build?",
    );
    expect(second[0]!.prompt).not.toContain("Flint: Flint here.");
    reply(transcript, second[0]!, "Green.");

    const third = owner(transcript, queue, "@flint ship it", "m3");
    reply(transcript, third[0]!, "Shipped.");

    const fourth = owner(transcript, queue, "@sable your view?", "m4");
    expect(fourth.map((job) => job.target)).toEqual(["sable"]);
    const prompt = fourth[0]!.prompt;
    expect(prompt).toContain(
      [
        "[spec-group messages since your last reply]",
        "Flint: Flint here.",
        "Lee: @flint how is the build?",
        "Flint: Green.",
        "Lee: @flint ship it",
        "Flint: Shipped.",
        "",
        "[New message]",
        "your view?",
      ].join("\n"),
    );
    expect(prompt).not.toContain("Sable: Sable here.");
    expect(prompt).not.toContain("Lee: @sable your view?");
  });

  it("untagged owner text enters the transcript but wakes nobody", () => {
    const transcript = new GroupTranscript(":memory:");
    const queue = fakeQueue();
    expect(owner(transcript, queue, "thinking out loud", "m1")).toEqual([]);
    const wake = owner(transcript, queue, "@sable thoughts?", "m2");
    expect(wake[0]!.prompt).toContain("Lee: thinking out loud\n\n[New message]\nthoughts?");
  });

  it("is idempotent on the inbound message id and on the reply job id", () => {
    const transcript = new GroupTranscript(":memory:");
    const queue = fakeQueue();
    const jobs = owner(transcript, queue, "@flint hi", "m1");
    expect(owner(transcript, queue, "@flint hi", "m1")).toEqual([]);
    expect(queue.jobs).toHaveLength(1);
    reply(transcript, jobs[0]!, "hello");
    reply(transcript, jobs[0]!, "hello");
    expect(transcript.list()).toHaveLength(2);
    expect(transcript.cursor("flint")).toBe(1);
    expect(transcript.cursor("sable")).toBe(0);
  });

  it("fan-in advances only the replying member's cursor", () => {
    const transcript = new GroupTranscript(":memory:");
    const queue = fakeQueue();
    const jobs = owner(transcript, queue, "@all hi", "m1");
    reply(transcript, jobs[1]!, "Flint here.");
    expect(transcript.cursor("flint")).toBe(1);
    expect(transcript.cursor("sable")).toBe(0);
  });

  it("carries the group-line metadata and destination on each wake job", () => {
    const transcript = new GroupTranscript(":memory:");
    const queue = fakeQueue();
    const [job] = owner(transcript, queue, "@flint hi", "m1");
    expect(job!.delivery).toEqual({
      channel: "photon",
      destination: { spaceId: "dm" },
      metadata: {
        kind: "group_line",
        groupId: "spec-group",
        memberId: "flint",
        memberLabel: "Flint",
        wakeSeq: 1,
        channel: "iMessage",
      },
    });
  });

  it("honors catchUp last (no history) and { messages: N } (newest N since cursor)", () => {
    const transcript = new GroupTranscript(":memory:");
    const queue = fakeQueue();
    owner(transcript, queue, "one", "m1");
    owner(transcript, queue, "two", "m2");
    owner(transcript, queue, "three", "m3");
    const last = owner(transcript, queue, "@flint now", "m4", { mode: "last" });
    expect(last[0]!.prompt).not.toContain("since your last reply");
    const windowed = owner(transcript, queue, "@sable now", "m5", { mode: "window", messages: 2 });
    expect(windowed[0]!.prompt).toContain(
      "[2 earlier messages trimmed]\nLee: three\nLee: @flint now\n\n[New message]\nnow",
    );
  });
});

describe("GroupTranscript byte cap", () => {
  it("trims oldest lines, never refuses, and reports the trimmed count on the next read", () => {
    const transcript = new GroupTranscript(":memory:", { maxBytes: 600 });
    for (let index = 1; index <= 10; index += 1) {
      transcript.append({
        senderId: "lee",
        senderLabel: "Lee",
        text: `line ${index} ${"x".repeat(100)}`,
        inboundMessageId: `m${index}`,
      });
    }
    const kept = transcript.list();
    expect(kept.length).toBeLessThan(10);
    expect(kept.at(-1)!.text.startsWith("line 10")).toBe(true);
    const slice = transcript.since(0);
    expect(slice.trimmed).toBe(10 - kept.length);
    expect(slice.messages.map((message) => message.seq)).toEqual(kept.map((m) => m.seq));
    expect(transcript.since(kept[0]!.seq).trimmed).toBe(0);
  });
});

describe("formatGroupReply", () => {
  it("prefixes the member's display name in bold", () => {
    expect(formatGroupReply("Flint", "done")).toBe("**Flint:** done");
  });
});
