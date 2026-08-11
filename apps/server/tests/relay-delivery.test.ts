import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { deliverRelayJob, type RelayDeliveryContext } from "../src/relay-delivery.ts";
import { RelayQueue, type RelayJob } from "../src/relay.ts";

function job(overrides: Partial<RelayJob> = {}): RelayJob {
  return {
    id: "job-1",
    target: "fable",
    prompt: "hello",
    status: "completed",
    jobClass: "deprioritized",
    jobKind: "agent",
    sender: null,
    output: "reply",
    error: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:00.000Z",
    notify: null,
    delivery: { channel: "photon", destination: { spaceId: "chat-1" } },
    deliveryStatus: "pending",
    deliveryError: null,
    ...overrides,
  };
}

describe("deliverRelayJob", () => {
  it("fails closed for unknown delivery channels", async () => {
    const context: RelayDeliveryContext = {
      agents: [],
      consoleHome: "/tmp",
      photonConnectors: null,
    };
    await expect(
      deliverRelayJob(job({ delivery: { channel: "mail", destination: { inbox: "x" } } }), context),
    ).rejects.toThrow("unsupported delivery channel: mail");
  });

  it("defaults Photon notifications to the target's latest known direct destination", async () => {
    const consoleHome = mkdtempSync(join(tmpdir(), "lhc-delivery-default-"));
    const queue = new RelayQueue({
      dbPath: join(consoleHome, "relay.sqlite"),
      targets: {
        fable: { hostId: "pi", threadId: "th_1", cwd: consoleHome, command: "true", args: [] },
      },
      isBusy: () => false,
      execute: async () => "unused",
    });
    queue.enqueue({
      target: "fable",
      prompt: "owner message",
      delivery: { channel: "photon", destination: { spaceId: "owner-dm" } },
    });
    await queue.close();
    const sent: Array<{ agentId: string; spaceId: string; text: string }> = [];

    await deliverRelayJob(job({ notify: "photon", delivery: null }), {
      agents: [],
      consoleHome,
      photonConnectors: {
        send: async (agentId: string, spaceId: string, text: string) => {
          sent.push({ agentId, spaceId, text });
        },
      } as RelayDeliveryContext["photonConnectors"],
    });

    expect(sent).toEqual([{ agentId: "fable", spaceId: "owner-dm", text: "reply" }]);
    rmSync(consoleHome, { recursive: true, force: true });
  });

  it("delivers lee outbound jobs from the sender connector", async () => {
    const sent: Array<{ agentId: string; spaceId: string; text: string }> = [];
    await deliverRelayJob(
      job({
        target: "lee",
        prompt: "ping",
        output: "ping",
        jobKind: "outbound",
        delivery: {
          channel: "photon",
          destination: { spaceId: "fable-home" },
          metadata: { kind: "outbound_lee", senderAgentId: "fable", connectorAgentId: "fable" },
        },
      }),
      {
        agents: [
          {
            id: "fable",
            name: "Fable",
            description: "durable agent",
            duties: [],
            ownerSenderIds: ["owner"],
            mentionPatterns: [],
            channels: {
              photon: {
                address: "http://127.0.0.1:1",
                envFile: ".env",
                notifySpaceId: "fable-home",
              },
            },
            relay: {
              hostId: "pi",
              threadId: "th_fable",
              cwd: "/tmp",
              command: "true",
              args: [],
            },
          },
        ],
        consoleHome: "/tmp",
        photonConnectors: {
          send: async (agentId: string, spaceId: string, text: string) => {
            sent.push({ agentId, spaceId, text });
          },
        } as RelayDeliveryContext["photonConnectors"],
      },
    );
    expect(sent).toEqual([{ agentId: "fable", spaceId: "fable-home", text: "ping" }]);
  });

  it("fails lee delivery without exposing secrets when no connector is usable", async () => {
    await expect(
      deliverRelayJob(
        job({
          target: "lee",
          prompt: "ping",
          output: "ping",
          jobKind: "outbound",
          delivery: {
            channel: "photon",
            destination: { spaceId: "missing" },
            metadata: { kind: "outbound_lee", senderAgentId: "scribe", connectorAgentId: "scribe" },
          },
        }),
        {
          agents: [
            {
              id: "scribe",
              name: "Scribe",
              description: "durable agent",
              duties: [],
              ownerSenderIds: ["owner"],
              mentionPatterns: [],
              channels: {},
              relay: {
                hostId: "pi",
                threadId: "th_scribe",
                cwd: "/tmp",
                command: "true",
                args: [],
              },
            },
          ],
          consoleHome: "/tmp",
          photonConnectors: {
            send: async () => undefined,
          } as unknown as RelayDeliveryContext["photonConnectors"],
        },
      ),
    ).rejects.toThrow(/no photon connector is configured/i);
  });
});
