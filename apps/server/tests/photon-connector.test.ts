import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { AgentRecord } from "../src/agent-registry.ts";
import { PhotonConnector } from "../src/photon-connector.ts";
import { RelayQueue, type RelayTarget } from "../src/relay.ts";

type RelayExecute = (target: RelayTarget, prompt: string, signal: AbortSignal) => Promise<string>;

const dirs: string[] = [];
const servers: Server[] = [];
const queues: RelayQueue[] = [];
const connectors: PhotonConnector[] = [];

afterEach(async () => {
  await Promise.all(connectors.splice(0).map((connector) => connector.stop()));
  await Promise.all(queues.splice(0).map((queue) => queue.close()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface FakeSidecar {
  baseUrl: string;
  token: string;
  pushInbound(event: unknown): void;
  sent: Array<{ spaceId: string; text: string }>;
}

function agentRecord(): AgentRecord {
  return {
    id: "fable",
    ownerSenderIds: ["+15551234567"],
    mentionPatterns: [String.raw`\bfable\b`],
    channels: {
      photon: {
        address: "+15550001111",
        envFile: "/tmp/unused.env",
      },
    },
    relay: {
      hostId: "pi-lhc",
      threadId: "th_fable",
      cwd: "/tmp",
      command: "unused",
      args: [],
    },
  };
}

function relayQueue(execute: RelayExecute): RelayQueue {
  const dir = mkdtempSync(join(tmpdir(), "lhc-photon-relay-"));
  dirs.push(dir);
  const queue = new RelayQueue({
    dbPath: join(dir, "relay.sqlite"),
    targets: { fable: agentRecord().relay },
    isBusy: () => false,
    execute,
  });
  queues.push(queue);
  return queue;
}

function startFakeSidecar(): Promise<FakeSidecar> {
  const token = "sidecar-test-token";
  const sent: Array<{ spaceId: string; text: string }> = [];
  let inboundRes: ServerResponse | null = null;
  const pendingLines: string[] = [];

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.headers["x-hermes-sidecar-token"] !== token) {
      res.statusCode = 401;
      res.end();
      return;
    }
    const url = req.url ?? "";
    if (req.method === "POST" && url === "/healthz") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "GET" && url === "/inbound") {
      inboundRes = res;
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      for (const line of pendingLines.splice(0)) inboundRes.write(`${line}\n`);
      req.on("close", () => {
        inboundRes = null;
      });
      return;
    }
    if (req.method === "POST" && url === "/send") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        spaceId: string;
        text: string;
      };
      sent.push({ spaceId: body.spaceId, text: body.text });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, messageId: "out-1" }));
      return;
    }
    if (req.method === "POST" && url === "/shutdown") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("sidecar address unavailable"));
        return;
      }
      servers.push(server);
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        token,
        sent,
        pushInbound(event: unknown) {
          const line = JSON.stringify(event);
          if (inboundRes) inboundRes.write(`${line}\n`);
          else pendingLines.push(line);
        },
      });
    });
  });
}

function dmEvent(
  overrides: Partial<{
    messageId: string;
    spaceId: string;
    senderId: string;
    text: string;
  }> = {},
) {
  return {
    messageId: overrides.messageId ?? "dm-1",
    platform: "iMessage",
    space: { id: overrides.spaceId ?? "+15559876543", type: "dm", phone: "+15559876543" },
    sender: { id: overrides.senderId ?? "+15551234567" },
    content: { type: "text", text: overrides.text ?? "hello there" },
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

function groupEvent(
  overrides: Partial<{
    messageId: string;
    spaceId: string;
    senderId: string;
    text: string;
  }> = {},
) {
  return {
    messageId: overrides.messageId ?? "grp-1",
    platform: "iMessage",
    space: { id: overrides.spaceId ?? "chat-guid-group", type: "group", phone: null },
    sender: { id: overrides.senderId ?? "+15551234567" },
    content: { type: "text", text: overrides.text ?? "plain group chatter" },
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

describe("PhotonConnector", () => {
  it("routes authorized owner DMs through relay and replies in the originating space", async () => {
    const sidecar = await startFakeSidecar();
    const prompts: string[] = [];
    const queue = relayQueue(async (_target, prompt) => {
      prompts.push(prompt);
      return "agent reply";
    });
    const dir = mkdtempSync(join(tmpdir(), "lhc-photon-connector-"));
    dirs.push(dir);
    const connector = new PhotonConnector({
      agent: agentRecord(),
      consoleHome: dir,
      queue,
      sidecar: { baseUrl: sidecar.baseUrl, token: sidecar.token },
    });
    connectors.push(connector);
    await connector.start();
    sidecar.pushInbound(dmEvent({ text: "status?" }));
    await expect.poll(() => prompts, { timeout: 1_000 }).toEqual(["status?"]);
    await expect
      .poll(() => sidecar.sent, { timeout: 1_000 })
      .toEqual([{ spaceId: "+15559876543", text: "agent reply" }]);
  });

  it("deduplicates replayed owner DMs by chat and message id", async () => {
    const sidecar = await startFakeSidecar();
    let calls = 0;
    const queue = relayQueue(async (_target, prompt) => {
      calls += 1;
      return `reply:${prompt}`;
    });
    const dir = mkdtempSync(join(tmpdir(), "lhc-photon-connector-"));
    dirs.push(dir);
    const connector = new PhotonConnector({
      agent: agentRecord(),
      consoleHome: dir,
      queue,
      sidecar: { baseUrl: sidecar.baseUrl, token: sidecar.token },
    });
    connectors.push(connector);
    await connector.start();
    const event = dmEvent({ messageId: "dm-dup", text: "once" });
    sidecar.pushInbound(event);
    sidecar.pushInbound(event);
    await expect.poll(() => calls, { timeout: 1_000 }).toBe(1);
    await expect
      .poll(() => sidecar.sent, { timeout: 1_000 })
      .toEqual([{ spaceId: "+15559876543", text: "reply:once" }]);
  });

  it("drops unauthorized DMs without enqueueing relay work", async () => {
    const sidecar = await startFakeSidecar();
    let calls = 0;
    const queue = relayQueue(async () => {
      calls += 1;
      return "nope";
    });
    const dir = mkdtempSync(join(tmpdir(), "lhc-photon-connector-"));
    dirs.push(dir);
    const connector = new PhotonConnector({
      agent: agentRecord(),
      consoleHome: dir,
      queue,
      sidecar: { baseUrl: sidecar.baseUrl, token: sidecar.token },
    });
    connectors.push(connector);
    await connector.start();
    sidecar.pushInbound(dmEvent({ senderId: "+15559999999", text: "intruder" }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls).toBe(0);
    expect(sidecar.sent).toEqual([]);
  });

  it("buffers untagged group messages and wakes with chronological catch-up", async () => {
    const sidecar = await startFakeSidecar();
    const prompts: string[] = [];
    const queue = relayQueue(async (_target, prompt) => {
      prompts.push(prompt);
      return "group reply";
    });
    const dir = mkdtempSync(join(tmpdir(), "lhc-photon-connector-"));
    dirs.push(dir);
    const connector = new PhotonConnector({
      agent: agentRecord(),
      consoleHome: dir,
      queue,
      sidecar: { baseUrl: sidecar.baseUrl, token: sidecar.token },
    });
    connectors.push(connector);
    await connector.start();
    sidecar.pushInbound(
      groupEvent({ messageId: "g1", senderId: "+15550000001", text: "earlier point" }),
    );
    sidecar.pushInbound(
      groupEvent({ messageId: "g2", senderId: "+15550000002", text: "side note" }),
    );
    sidecar.pushInbound(
      groupEvent({ messageId: "g3", text: "fable summarize please", senderId: "+15551234567" }),
    );
    await expect.poll(() => prompts.length, { timeout: 1_000 }).toBe(1);
    expect(prompts[0]).toContain("[Group messages since your last reply]");
    expect(prompts[0]).toContain("[participant-1] earlier point");
    expect(prompts[0]).toContain("[unverified] [participant-2] side note");
    expect(prompts[0]).toContain("[New message]\nsummarize please");
    await expect
      .poll(() => sidecar.sent, { timeout: 1_000 })
      .toEqual([{ spaceId: "chat-guid-group", text: "group reply" }]);
  });

  it("buffers a failed authorized wake and replays it on the next successful wake", async () => {
    const sidecar = await startFakeSidecar();
    const prompts: string[] = [];
    let attempts = 0;
    const queue = relayQueue(async (_target, prompt) => {
      prompts.push(prompt);
      attempts += 1;
      if (attempts === 1) throw new Error("relay failed");
      return "group reply";
    });
    const dir = mkdtempSync(join(tmpdir(), "lhc-photon-connector-"));
    dirs.push(dir);
    const connector = new PhotonConnector({
      agent: agentRecord(),
      consoleHome: dir,
      queue,
      sidecar: { baseUrl: sidecar.baseUrl, token: sidecar.token },
    });
    connectors.push(connector);
    await connector.start();
    sidecar.pushInbound(groupEvent({ messageId: "bg-1", text: "background" }));
    sidecar.pushInbound(groupEvent({ messageId: "wake-1", text: "fable try again" }));
    await expect.poll(() => prompts.length, { timeout: 1_000 }).toBe(1);
    sidecar.pushInbound(groupEvent({ messageId: "wake-2", text: "fable retry" }));
    await expect.poll(() => prompts.length, { timeout: 1_000 }).toBe(2);
    expect(prompts[1]).toContain("background");
    expect(prompts[1]).toContain("[participant-1] try again");
    expect(prompts[1]).toContain("[New message]\nretry");
    await expect
      .poll(() => sidecar.sent, { timeout: 1_000 })
      .toEqual([{ spaceId: "chat-guid-group", text: "group reply" }]);
  });

  it("ignores reactions and polls without waking or buffering", async () => {
    const sidecar = await startFakeSidecar();
    let calls = 0;
    const queue = relayQueue(async () => {
      calls += 1;
      return "unused";
    });
    const dir = mkdtempSync(join(tmpdir(), "lhc-photon-connector-"));
    dirs.push(dir);
    const connector = new PhotonConnector({
      agent: agentRecord(),
      consoleHome: dir,
      queue,
      sidecar: { baseUrl: sidecar.baseUrl, token: sidecar.token },
    });
    connectors.push(connector);
    await connector.start();
    sidecar.pushInbound({
      messageId: "rx-1",
      platform: "iMessage",
      space: { id: "chat-guid-group", type: "group", phone: null },
      sender: { id: "+15551234567" },
      content: { type: "reaction", emoji: "👀", targetMessageId: "m1" },
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    sidecar.pushInbound({
      messageId: "poll-1",
      platform: "iMessage",
      space: { id: "chat-guid-group", type: "group", phone: null },
      sender: { id: "+15551234567" },
      content: { type: "poll_option", title: "yes", selected: true },
      timestamp: "2026-01-01T00:00:01.000Z",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls).toBe(0);
  });

  it("shuts down without leaving inbound handlers running", async () => {
    const sidecar = await startFakeSidecar();
    const queue = relayQueue(async () => "ok");
    const dir = mkdtempSync(join(tmpdir(), "lhc-photon-connector-"));
    dirs.push(dir);
    const connector = new PhotonConnector({
      agent: agentRecord(),
      consoleHome: dir,
      queue,
      sidecar: { baseUrl: sidecar.baseUrl, token: sidecar.token },
    });
    connectors.push(connector);
    await connector.start();
    await connector.stop();
    sidecar.pushInbound(dmEvent({ text: "late" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sidecar.sent).toEqual([]);
  });
});
