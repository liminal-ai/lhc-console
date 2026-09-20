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

  it("bounds long Photon replies while retaining the relay job reference", async () => {
    const sent: string[] = [];
    await deliverRelayJob(job({ id: "job-long", output: "x".repeat(9_000) }), {
      agents: [],
      consoleHome: "/tmp",
      photonConnectors: {
        send: async (_agentId: string, _spaceId: string, text: string) => {
          sent.push(text);
        },
      } as RelayDeliveryContext["photonConnectors"],
    });

    expect(sent[0]?.length).toBeLessThanOrEqual(8_000);
    expect(sent[0]).toContain("job-long");
    expect(sent[0]).toContain("truncated for iMessage");
  });

  it("sends one bounded failure notice for a failed direct job without replaying the prompt", async () => {
    const sent: string[] = [];
    await deliverRelayJob(
      job({
        id: "job-failed",
        status: "failed",
        output: null,
        prompt: "SECRET PROMPT TEXT",
        error: `codex exec exited with code 2\n${"x".repeat(3_000)}`,
      }),
      {
        agents: [],
        consoleHome: "/tmp",
        photonConnectors: {
          send: async (_agentId: string, _spaceId: string, text: string) => {
            sent.push(text);
          },
        } as RelayDeliveryContext["photonConnectors"],
      },
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/failed/i);
    expect(sent[0]).toContain("job-failed");
    expect(sent[0]).toContain("codex exec exited with code 2");
    expect(sent[0]).not.toContain("SECRET PROMPT TEXT");
    expect(sent[0]?.length).toBeLessThanOrEqual(1_000);
  });

  it("keeps a distinctive submitted prompt marker out of the failure-notice copy handed to Photon", async () => {
    const promptMarker = "LIM136_PROMPT_MARKER_a8f3e2c1_DO_NOT_LEAK";
    const sent: string[] = [];
    await deliverRelayJob(
      job({
        id: "job-redact",
        status: "failed",
        output: null,
        prompt: `please investigate ${promptMarker} immediately`,
        error: "codex exec exited with code 2",
      }),
      {
        agents: [],
        consoleHome: "/tmp",
        photonConnectors: {
          send: async (_agentId: string, _spaceId: string, text: string) => {
            sent.push(text);
          },
        } as RelayDeliveryContext["photonConnectors"],
      },
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/failed/i);
    expect(sent[0]).toContain("job-redact");
    expect(sent[0]).toContain("codex exec exited with code 2");
    expect(sent[0]).not.toContain(promptMarker);
    expect(sent[0]).not.toContain("please investigate");
  });

  it("does not send an empty Markdown payload when an agent returns an empty string", async () => {
    const sent: string[] = [];
    await deliverRelayJob(job({ output: "" }), {
      agents: [],
      consoleHome: "/tmp",
      photonConnectors: {
        send: async (_agentId: string, _spaceId: string, text: string) => {
          sent.push(text);
        },
      } as RelayDeliveryContext["photonConnectors"],
    });

    expect(sent).toEqual(["(empty reply)"]);
  });
});

function consoleAndFable(): RelayDeliveryContext["agents"] {
  const relay = { hostId: "pi", threadId: "th", cwd: "/tmp", command: "true", args: [] };
  const base = { description: "agent", duties: [], ownerSenderIds: ["owner"], mentionPatterns: [] };
  return [
    {
      ...base,
      id: "fable",
      name: "Fable",
      channels: {
        photon: { address: "http://127.0.0.1:1", envFile: ".env", notifySpaceId: "fable-home" },
      },
      relay,
    },
    {
      ...base,
      id: "console",
      name: "Console",
      channels: {
        photon: { address: "http://127.0.0.1:2", envFile: ".env", notifySpaceId: "console-home" },
      },
      relay,
    },
  ];
}

function leeJob(): RelayJob {
  return job({
    target: "lee",
    prompt: "ping",
    output: "ping",
    jobKind: "outbound",
    delivery: {
      channel: "photon",
      destination: { spaceId: "fable-home" },
      metadata: { kind: "outbound_lee", senderAgentId: "fable", connectorAgentId: "fable" },
    },
  });
}

describe("deliverRelayJob lee fallback", () => {
  it("retries once through Console's identity when the sender's line fails permanently", async () => {
    const sent: Array<{ agentId: string; spaceId: string }> = [];
    const receipt = await deliverRelayJob(leeJob(), {
      agents: consoleAndFable(),
      consoleHome: "/tmp",
      photonConnectors: {
        send: async (agentId: string, spaceId: string) => {
          sent.push({ agentId, spaceId });
          if (agentId === "fable") {
            throw Object.assign(new Error("sidecar /send failed with 500 (target_not_allowed)"), {
              permanent: true,
            });
          }
        },
      } as unknown as RelayDeliveryContext["photonConnectors"],
    });
    expect(sent).toEqual([
      { agentId: "fable", spaceId: "fable-home" },
      { agentId: "console", spaceId: "console-home" },
    ]);
    expect(receipt).toEqual({ deliveredVia: "console" });
  });

  it("reports the sender's own line on a first-try success", async () => {
    const receipt = await deliverRelayJob(leeJob(), {
      agents: consoleAndFable(),
      consoleHome: "/tmp",
      photonConnectors: {
        send: async () => undefined,
      } as unknown as RelayDeliveryContext["photonConnectors"],
    });
    expect(receipt).toEqual({ deliveredVia: "fable" });
  });

  it("leaves transient sender failures to the queue's retry schedule, no fallback", async () => {
    const sent: string[] = [];
    await expect(
      deliverRelayJob(leeJob(), {
        agents: consoleAndFable(),
        consoleHome: "/tmp",
        photonConnectors: {
          send: async (agentId: string) => {
            sent.push(agentId);
            throw new Error("sidecar /send failed with 503");
          },
        } as unknown as RelayDeliveryContext["photonConnectors"],
      }),
    ).rejects.toThrow(/503/);
    expect(sent).toEqual(["fable"]);
  });

  it("does not fall back when Console is already the sender's line", async () => {
    const sent: string[] = [];
    const consoleJob = job({
      ...leeJob(),
      delivery: {
        channel: "photon",
        destination: { spaceId: "console-home" },
        metadata: { kind: "outbound_lee", senderAgentId: "console", connectorAgentId: "console" },
      },
    });
    await expect(
      deliverRelayJob(consoleJob, {
        agents: consoleAndFable(),
        consoleHome: "/tmp",
        photonConnectors: {
          send: async (agentId: string) => {
            sent.push(agentId);
            throw Object.assign(new Error("sidecar /send failed with 401"), { permanent: true });
          },
        } as unknown as RelayDeliveryContext["photonConnectors"],
      }),
    ).rejects.toThrow(/401/);
    expect(sent).toEqual(["console"]);
  });
});
