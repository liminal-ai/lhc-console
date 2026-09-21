import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { AgentRecord, GroupRecord } from "../src/agent-registry.ts";
import { registerGroupRoutes } from "../src/group-routes.ts";
import { GroupTranscript } from "../src/group-transcript.ts";
import type { RelayJob } from "../src/relay.ts";

const apps: Array<ReturnType<typeof Fastify>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const relay = { hostId: "t3code", threadId: "th", cwd: "/tmp", command: "true", args: [] };
function seat(id: string, name: string): AgentRecord {
  return {
    id,
    name,
    description: "seat",
    duties: [],
    ownerSenderIds: ["+1"],
    mentionPatterns: [String.raw`(?<![\w@])@?${id}\b[,\-:]?`],
    channels: {},
    relay,
  };
}
const group: GroupRecord = {
  id: "spec-group",
  name: "spec-group",
  description: "group line",
  duties: [],
  ownerSenderIds: ["+1"],
  mentionPatterns: [],
  channels: { photon: { address: "+1999", envFile: "secret.env", notifySpaceId: "dm-space" } },
  group: { members: ["sable", "flint"], catchUp: { mode: "all" } },
};

function setup() {
  const app = Fastify();
  apps.push(app);
  const transcript = new GroupTranscript(":memory:");
  const jobs: Array<{ target: string; prompt: string; delivery: RelayJob["delivery"] }> = [];
  registerGroupRoutes(app, {
    groups: [group],
    agents: [seat("sable", "Sable"), seat("flint", "Flint")],
    openTranscript: () => transcript,
    queue: {
      enqueue: (input) => {
        jobs.push({ target: input.target, prompt: input.prompt, delivery: input.delivery ?? null });
        return { id: `job-${jobs.length}`, target: input.target } as RelayJob;
      },
    },
  });
  return { app, transcript, jobs };
}
const auth = {};

describe("group line web API", () => {
  it("lists groups with member labels and no channel secrets", async () => {
    const { app } = setup();
    const response = await app.inject({ method: "GET", url: "/api/groups", headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      {
        id: "spec-group",
        name: "spec-group",
        description: "group line",
        members: [
          { id: "sable", label: "Sable" },
          { id: "flint", label: "Flint" },
        ],
        catchUp: { mode: "all" },
        channels: ["photon"],
      },
    ]);
    expect(response.body).not.toContain("secret.env");
    expect(response.body).not.toContain("+1999");
  });

  it("posts an owner message through the router: transcript line, wakes, and the same delivery target", async () => {
    const { app, transcript, jobs } = setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/groups/spec-group/messages",
      headers: auth,
      payload: { text: "@flint status?" },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ seq: 1, wakes: [{ jobId: "job-1", memberId: "flint" }] });
    expect(jobs[0]?.prompt).toContain("[from: lee, channel: web group spec-group]");
    expect(jobs[0]?.delivery?.destination).toEqual({ spaceId: "dm-space" });
    expect(transcript.list().map((line) => [line.senderLabel, line.text])).toEqual([
      ["Lee", "@flint status?"],
    ]);
  });

  it("is idempotent on a client-supplied message id", async () => {
    const { app, transcript, jobs } = setup();
    for (let i = 0; i < 2; i += 1) {
      await app.inject({
        method: "POST",
        url: "/api/groups/spec-group/messages",
        headers: auth,
        payload: { text: "@all hi", id: "client-1" },
      });
    }
    expect(transcript.list()).toHaveLength(1);
    expect(jobs).toHaveLength(2);
  });

  it("reads the transcript since a seq and reports the last seq", async () => {
    const { app, transcript } = setup();
    transcript.append({ senderId: "lee", senderLabel: "Lee", text: "one", inboundMessageId: "a" });
    transcript.append({ senderId: "flint", senderLabel: "Flint", text: "two", jobId: "j" });
    const all = await app.inject({
      method: "GET",
      url: "/api/groups/spec-group/messages",
      headers: auth,
    });
    expect(all.json().messages.map((m: { text: string }) => m.text)).toEqual(["one", "two"]);
    expect(all.json().lastSeq).toBe(2);
    const since = await app.inject({
      method: "GET",
      url: "/api/groups/spec-group/messages?since=1",
      headers: auth,
    });
    expect(since.json().messages).toEqual([
      { seq: 2, senderId: "flint", senderLabel: "Flint", text: "two", at: expect.any(String) },
    ]);
    const bad = await app.inject({
      method: "GET",
      url: "/api/groups/spec-group/messages?since=x",
      headers: auth,
    });
    expect(bad.statusCode).toBe(400);
  });

  it("rejects unknown groups and empty text", async () => {
    const { app } = setup();
    expect(
      (await app.inject({ method: "GET", url: "/api/groups/nope/messages", headers: auth }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/groups/spec-group/messages",
          headers: auth,
          payload: { text: "   " },
        })
      ).statusCode,
    ).toBe(400);
  });
});
