import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { AgentRecord } from "../src/agent-registry.ts";
import { GroupCatchUpStore } from "../src/group-catch-up.ts";
import { PhotonConnector, type PhotonConnectorManager } from "../src/photon-connector.ts";
import { deliverRelayJob } from "../src/relay-delivery.ts";
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
    name: "Fable",
    description: "Test agent",
    duties: [],
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

function relayQueue(execute: RelayExecute, sidecar: FakeSidecar, consoleHome: string): RelayQueue {
  mkdirSync(consoleHome, { recursive: true });
  const photonConnectors = {
    send: async (_agentId: string, spaceId: string, text: string) => {
      const response = await fetch(`${sidecar.baseUrl}/send`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Hermes-Sidecar-Token": sidecar.token,
        },
        body: JSON.stringify({ spaceId, text, format: "text" }),
      });
      if (!response.ok) throw new Error(`send failed with ${response.status}`);
    },
  } as PhotonConnectorManager;
  const queue = new RelayQueue({
    dbPath: join(consoleHome, "relay.sqlite"),
    targets: { fable: agentRecord().relay },
    isBusy: () => false,
    execute,
    deliver: async (job) => {
      await deliverRelayJob(job, {
        agents: [agentRecord()],
        consoleHome,
        photonConnectors,
      });
    },
    busyPollMs: 5,
    consoleHome,
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

async function startConnector(options: {
  sidecar: FakeSidecar;
  execute: RelayExecute;
  backlogLimits?: { maxBacklogMessages?: number; maxBacklogBytes?: number };
  spawnSidecar?: PhotonConnector["constructor"] extends new (opts: infer O) => unknown
    ? O extends { spawnSidecar?: infer S }
      ? S
      : never
    : never;
}): Promise<{ connector: PhotonConnector; dir: string; queue: RelayQueue }> {
  const dir = mkdtempSync(join(tmpdir(), "lhc-photon-connector-"));
  dirs.push(dir);
  const queue = relayQueue(options.execute, options.sidecar, dir);
  const connector = new PhotonConnector({
    agent: agentRecord(),
    consoleHome: dir,
    queue,
    sidecar: { baseUrl: options.sidecar.baseUrl, token: options.sidecar.token },
    backlogLimits: options.backlogLimits,
    spawnSidecar: options.spawnSidecar,
  });
  connectors.push(connector);
  await connector.start();
  queue.start();
  return { connector, dir, queue };
}

describe("PhotonConnector", () => {
  it("enqueues authorized owner DMs as prioritized relay jobs", async () => {
    const sidecar = await startFakeSidecar();
    const { dir, queue } = await startConnector({
      sidecar,
      execute: async () => "agent reply",
    });
    sidecar.pushInbound(dmEvent({ text: "status?" }));
    await expect
      .poll(
        () => {
          const db = new DatabaseSync(join(dir, "relay.sqlite"));
          try {
            const row = db.prepare("SELECT job_class FROM relay_jobs LIMIT 1").get() as
              | { job_class: string }
              | undefined;
            return row?.job_class;
          } finally {
            db.close();
          }
        },
        { timeout: 1_000 },
      )
      .toBe("prioritized");
    await queue.close();
  });

  it("routes authorized owner DMs through relay and replies in the originating space", async () => {
    const sidecar = await startFakeSidecar();
    const prompts: string[] = [];
    await startConnector({
      sidecar,
      execute: async (_target, prompt) => {
        prompts.push(prompt);
        return "agent reply";
      },
    });
    sidecar.pushInbound(dmEvent({ text: "status?" }));
    await expect.poll(() => prompts, { timeout: 1_000 }).toEqual(["status?"]);
    await expect
      .poll(() => sidecar.sent, { timeout: 1_000 })
      .toEqual([{ spaceId: "+15559876543", text: "agent reply" }]);
  });

  it("deduplicates replayed owner DMs by chat and message id", async () => {
    const sidecar = await startFakeSidecar();
    let calls = 0;
    await startConnector({
      sidecar,
      execute: async (_target, prompt) => {
        calls += 1;
        return `reply:${prompt}`;
      },
    });
    const event = dmEvent({ messageId: "dm-dup", text: "once" });
    sidecar.pushInbound(event);
    sidecar.pushInbound(event);
    await expect.poll(() => calls, { timeout: 1_000 }).toBe(1);
    await expect
      .poll(() => sidecar.sent, { timeout: 1_000 })
      .toEqual([{ spaceId: "+15559876543", text: "reply:once" }]);
  });

  it("reclaims an inbound DM after a crash before durable enqueue", async () => {
    const sidecar = await startFakeSidecar();
    let calls = 0;
    const dir = mkdtempSync(join(tmpdir(), "lhc-photon-connector-"));
    dirs.push(dir);
    const dedupePath = join(dir, "agents", "fable", "inbound-dedupe.sqlite");
    mkdirSync(dirname(dedupePath), { recursive: true });
    const seed = new DatabaseSync(dedupePath);
    seed.exec(`
      CREATE TABLE inbound_messages (
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        owner_pid INTEGER,
        owner_token TEXT,
        lease_expires_at TEXT,
        PRIMARY KEY (chat_id, message_id)
      )
    `);
    seed
      .prepare(
        `INSERT INTO inbound_messages
         (chat_id, message_id, state, updated_at, owner_pid, owner_token, lease_expires_at)
         VALUES (?, ?, 'processing', ?, ?, ?, ?)`,
      )
      .run(
        "+15559876543",
        "dm-reclaim",
        new Date().toISOString(),
        999_999_999,
        "dead",
        new Date(Date.now() + 60_000).toISOString(),
      );
    seed.close();
    const queue = relayQueue(
      async (_target, prompt) => {
        calls += 1;
        return `reply:${prompt}`;
      },
      sidecar,
      dir,
    );
    const connector = new PhotonConnector({
      agent: agentRecord(),
      consoleHome: dir,
      queue,
      sidecar: { baseUrl: sidecar.baseUrl, token: sidecar.token },
    });
    connectors.push(connector);
    await connector.start();
    queue.start();
    sidecar.pushInbound(dmEvent({ messageId: "dm-reclaim", text: "retry" }));
    await expect.poll(() => calls, { timeout: 1_000 }).toBe(1);
  });

  it("drops unauthorized DMs without enqueueing relay work", async () => {
    const sidecar = await startFakeSidecar();
    let calls = 0;
    await startConnector({
      sidecar,
      execute: async () => {
        calls += 1;
        return "nope";
      },
    });
    sidecar.pushInbound(dmEvent({ senderId: "+15559999999", text: "intruder" }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls).toBe(0);
    expect(sidecar.sent).toEqual([]);
  });

  it("buffers untagged group messages and wakes with chronological catch-up", async () => {
    const sidecar = await startFakeSidecar();
    const prompts: string[] = [];
    await startConnector({
      sidecar,
      execute: async (_target, prompt) => {
        prompts.push(prompt);
        return "group reply";
      },
    });
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
    await startConnector({
      sidecar,
      execute: async (_target, prompt) => {
        prompts.push(prompt);
        attempts += 1;
        if (attempts === 1) throw new Error("relay failed");
        return "group reply";
      },
    });
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

  it("advances group backlog only after successful reply delivery", async () => {
    const sidecar = await startFakeSidecar();
    const dir = mkdtempSync(join(tmpdir(), "lhc-photon-connector-"));
    dirs.push(dir);
    let deliverAttempts = 0;
    const relayDb = join(dir, "relay.sqlite");
    const photonConnectors = {
      send: async (_agentId: string, spaceId: string, text: string) => {
        deliverAttempts += 1;
        if (deliverAttempts === 1) throw new Error("send failed");
        const response = await fetch(`${sidecar.baseUrl}/send`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Hermes-Sidecar-Token": sidecar.token,
          },
          body: JSON.stringify({ spaceId, text, format: "text" }),
        });
        if (!response.ok) throw new Error(`send failed with ${response.status}`);
      },
    } as PhotonConnectorManager;
    const queue = new RelayQueue({
      dbPath: relayDb,
      targets: { fable: agentRecord().relay },
      isBusy: () => false,
      execute: async () => "group reply",
      deliver: async (job) => {
        await deliverRelayJob(job, {
          agents: [agentRecord()],
          consoleHome: dir,
          photonConnectors,
        });
      },
      busyPollMs: 5,
    });
    queues.push(queue);
    const connector = new PhotonConnector({
      agent: agentRecord(),
      consoleHome: dir,
      queue,
      sidecar: { baseUrl: sidecar.baseUrl, token: sidecar.token },
    });
    connectors.push(connector);
    await connector.start();
    queue.start();
    const catchUp = new GroupCatchUpStore(join(dir, "agents", "fable", "group-catch-up.sqlite"));
    sidecar.pushInbound(groupEvent({ messageId: "bg-1", text: "background" }));
    sidecar.pushInbound(groupEvent({ messageId: "wake-1", text: "fable hello" }));
    await expect.poll(() => deliverAttempts, { timeout: 1_000 }).toBe(1);
    expect(catchUp.pendingMessageIds("chat-guid-group")).toEqual(["bg-1"]);
    await expect
      .poll(() => catchUp.pendingMessageIds("chat-guid-group"), { timeout: 2_000 })
      .toEqual([]);
  });

  it("ignores reactions and polls without waking or buffering", async () => {
    const sidecar = await startFakeSidecar();
    let calls = 0;
    await startConnector({
      sidecar,
      execute: async () => {
        calls += 1;
        return "unused";
      },
    });
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

  it("shuts down within a bounded time without waiting on relay execution", async () => {
    const sidecar = await startFakeSidecar();
    const { connector } = await startConnector({
      sidecar,
      execute: async (_target, _prompt, signal) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve("late"), 5_000);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        }),
    });
    sidecar.pushInbound(dmEvent({ text: "slow" }));
    const started = Date.now();
    await connector.stop();
    expect(Date.now() - started).toBeLessThan(2_500);
  });

  it("shuts down without leaving inbound handlers running", async () => {
    const sidecar = await startFakeSidecar();
    const { connector } = await startConnector({
      sidecar,
      execute: async () => "ok",
    });
    await connector.stop();
    sidecar.pushInbound(dmEvent({ text: "late" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sidecar.sent).toEqual([]);
  });

  it("refuses oversized group wake while retaining backlog", async () => {
    const sidecar = await startFakeSidecar();
    const dir = mkdtempSync(join(tmpdir(), "lhc-photon-connector-"));
    dirs.push(dir);
    const catchUpPath = join(dir, "agents", "fable", "group-catch-up.sqlite");
    const seed = new GroupCatchUpStore(catchUpPath, { maxBacklogMessages: 10 });
    seed.append("chat-guid-group", {
      messageId: "bg-1",
      senderId: "+15550000001",
      text: "one",
      timestamp: "2026-01-01T00:00:00.000Z",
      senderAuthorized: false,
    });
    seed.append("chat-guid-group", {
      messageId: "bg-2",
      senderId: "+15550000001",
      text: "two",
      timestamp: "2026-01-01T00:00:01.000Z",
      senderAuthorized: false,
    });
    const queue = relayQueue(async () => "unused", sidecar, dir);
    const connector = new PhotonConnector({
      agent: agentRecord(),
      consoleHome: dir,
      queue,
      sidecar: { baseUrl: sidecar.baseUrl, token: sidecar.token },
      backlogLimits: { maxBacklogMessages: 1 },
    });
    connectors.push(connector);
    await connector.start();
    queue.start();
    sidecar.pushInbound(groupEvent({ messageId: "wake-1", text: "fable wake" }));
    await expect
      .poll(() => sidecar.sent, { timeout: 1_000 })
      .toEqual([
        {
          spaceId: "chat-guid-group",
          text: "group backlog has 2 messages, exceeding the safety limit of 1; wake refused; backlog retained.",
        },
      ]);
  });
});
