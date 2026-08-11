import { describe, expect, it } from "vite-plus/test";
import type { AgentRecord } from "../src/agent-registry.ts";
import {
  renderSenderAttribution,
  resolveDeclaredSender,
  resolveLeePhotonRoute,
  validateSenderAgent,
} from "../src/relay-sender.ts";

function agent(id: string, photon?: { notifySpaceId?: string }): AgentRecord {
  return {
    id,
    name: id,
    description: `${id} agent`,
    duties: [],
    ownerSenderIds: ["owner"],
    mentionPatterns: [],
    channels: photon
      ? { photon: { address: "http://127.0.0.1:1", envFile: ".env", ...photon } }
      : {},
    relay: {
      hostId: "pi",
      threadId: `th_${id}`,
      cwd: "/tmp",
      command: "true",
      args: [],
    },
  };
}

describe("relay sender helpers", () => {
  const agents = [
    agent("console", { notifySpaceId: "console-home" }),
    agent("fable", { notifySpaceId: "fable-home" }),
    agent("scribe"),
  ];

  it("validates sender keys against the registry", () => {
    expect(validateSenderAgent(agents, "fable")).toBe("fable");
    expect(() => validateSenderAgent(agents, "intruder")).toThrow(/unknown sender agent/);
  });

  it("prefers explicit --from over LHC_AGENT_ID", () => {
    expect(resolveDeclaredSender(agents, "console", "fable")).toBe("console");
    expect(resolveDeclaredSender(agents, undefined, "fable")).toBe("fable");
    expect(resolveDeclaredSender(agents, null, null)).toBeNull();
  });

  it("renders peer attribution only when a sender is declared", () => {
    expect(renderSenderAttribution("fable", "hello")).toBe("[from: fable]\nhello");
  });

  it("routes lee delivery through the sender connector when available", () => {
    expect(resolveLeePhotonRoute(agents, "fable")).toEqual({
      connectorAgentId: "fable",
      spaceId: "fable-home",
    });
  });

  it("falls back to the console connector when the sender has no usable photon route", () => {
    expect(resolveLeePhotonRoute(agents, "scribe")).toEqual({
      connectorAgentId: "console",
      spaceId: "console-home",
    });
  });

  it("uses the first deterministic configured connector when console is unavailable", () => {
    const withoutConsole = [agent("scribe"), agent("fable", { notifySpaceId: "fable-home" })];
    expect(resolveLeePhotonRoute(withoutConsole, "scribe")).toEqual({
      connectorAgentId: "fable",
      spaceId: "fable-home",
    });
  });

  it("fails without exposing secrets when no connector can deliver", () => {
    expect(() => resolveLeePhotonRoute([agent("scribe")], "scribe")).toThrow(
      /no photon connector is configured/i,
    );
  });
});
