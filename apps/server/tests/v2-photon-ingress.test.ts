import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import type { AgentRecord } from "../src/agent-registry.ts";
import { PhotonConnector } from "../src/photon-connector.ts";
import { RelayQueue } from "../src/relay.ts";
import { parsePhotonV2Control } from "../src/v2/photon-ingress.ts";

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

describe("Photon V2 ingress", () => {
  it("leaves unprefixed text as V1", () => {
    expect(parsePhotonV2Control("please review this")).toBeNull();
    expect(parsePhotonV2Control("steer this for me")).toBeNull();
  });

  it("parses explicit control prefixes only", () => {
    expect(parsePhotonV2Control("/v2 hello")).toEqual({ kind: "turn.start", text: "hello" });
    expect(parsePhotonV2Control("/steer course-correct")).toEqual({
      kind: "turn.steer",
      text: "course-correct",
    });
    expect(parsePhotonV2Control("/next after this")).toEqual({
      kind: "turn.followUp",
      text: "after this",
    });
    expect(parsePhotonV2Control("/stop")).toEqual({ kind: "turn.interrupt" });
    expect(parsePhotonV2Control("/v2-status")).toEqual({ kind: "status" });
    expect(parsePhotonV2Control("/cancel cmd-1")).toEqual({
      kind: "command.cancel",
      targetCommandId: "cmd-1",
    });
    expect(parsePhotonV2Control("/v2")).toBeNull();
    expect(parsePhotonV2Control("/steer")).toBeNull();
  });

  it("parses group mention leftovers after mention stripping the same way as DMs", () => {
    expect(parsePhotonV2Control("/v2 continue the goal")).toEqual({
      kind: "turn.start",
      text: "continue the goal",
    });
    expect(parsePhotonV2Control("please /steer later")).toBeNull();
  });

  it("A13 keeps explicit Photon V2 syntax on V1 when the target is not V2-configured", async () => {
    const sidecar = await startFakeSidecar();
    const dir = mkdtempSync(join(tmpdir(), "lhc-v2-photon-v1-"));
    dirs.push(dir);
    const agent = photonAgent();
    delete agent.v2;
    const queue = new RelayQueue({
      dbPath: join(dir, "relay.sqlite"),
      targets: { fable: agent.relay },
      isBusy: () => false,
      execute: async () => "should-not-matter",
      busyPollMs: 5,
      consoleHome: dir,
    });
    queues.push(queue);
    const connector = new PhotonConnector({
      agent,
      consoleHome: dir,
      queue,
      sidecar: { baseUrl: sidecar.baseUrl, token: sidecar.token },
    });
    connectors.push(connector);
    await connector.start();
    queue.start();
    sidecar.pushInbound(dmEvent({ text: "/v2 hello from phone" }));
    await expect
      .poll(() => {
        const db = new DatabaseSync(join(dir, "relay.sqlite"));
        try {
          return (
            db.prepare("SELECT prompt FROM relay_jobs LIMIT 1").get() as
              | { prompt: string }
              | undefined
          )?.prompt;
        } finally {
          db.close();
        }
      })
      .toMatch(/^\/v2 hello from phone/);
    expect(sidecar.sent.some((row) => /V2 is not enabled/.test(row.text))).toBe(false);
  });
});

function photonAgent(): AgentRecord {
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

function startFakeSidecar(): Promise<{
  baseUrl: string;
  token: string;
  sent: Array<{ spaceId: string; text: string }>;
  pushInbound(event: unknown): void;
}> {
  const token = "sidecar-v2-test-token";
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

function dmEvent(overrides: Partial<{ text: string }> = {}) {
  return {
    messageId: "dm-v2-1",
    platform: "iMessage",
    space: { id: "+15559876543", type: "dm", phone: "+15559876543" },
    sender: { id: "+15551234567" },
    content: { type: "text", text: overrides.text ?? "hello there" },
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}
