import { describe, expect, it } from "vite-plus/test";
import { deliverRelayJob, type RelayDeliveryContext } from "../src/relay-delivery.ts";
import type { RelayJob } from "../src/relay.ts";

function job(overrides: Partial<RelayJob> = {}): RelayJob {
  return {
    id: "job-1",
    target: "fable",
    prompt: "hello",
    status: "completed",
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
});
