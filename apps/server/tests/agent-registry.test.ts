import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { loadAgentRegistry } from "../src/agent-registry.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeRegistry(home: string, body: unknown): void {
  writeFileSync(join(home, "agents.json"), `${JSON.stringify(body, null, 2)}\n`, {
    mode: 0o600,
  });
}

describe("loadAgentRegistry", () => {
  it("rejects a world-readable agents.json", () => {
    const home = mkdtempSync(join(tmpdir(), "lhc-agents-"));
    dirs.push(home);
    writeRegistry(home, { version: 1, agents: {} });
    chmodSync(join(home, "agents.json"), 0o644);
    expect(() => loadAgentRegistry(home)).toThrow(/agents\.json must be owner-only/);
  });

  it("rejects registry entries missing relay command", () => {
    const home = mkdtempSync(join(tmpdir(), "lhc-agents-"));
    dirs.push(home);
    writeRegistry(home, {
      version: 1,
      agents: {
        fable: {
          ownerSenderIds: ["+15551234567"],
          channels: {
            photon: {
              address: "+15550001111",
              envFile: "agents/fable.env",
            },
          },
          relay: {
            hostId: "pi-lhc",
            threadId: "th_test",
            cwd: "/tmp",
            args: ["-p"],
          },
        },
      },
    });
    expect(() => loadAgentRegistry(home)).toThrow(/relay\.command/);
  });

  it("loads channel-scoped photon identity and relay targets", () => {
    const home = mkdtempSync(join(tmpdir(), "lhc-agents-"));
    dirs.push(home);
    mkdirSync(join(home, "agents"), { recursive: true });
    writeFileSync(join(home, "agents", "fable.env"), "PHOTON_PROJECT_ID=p1\n", { mode: 0o600 });
    writeRegistry(home, {
      version: 1,
      agents: {
        fable: {
          ownerSenderIds: ["+15551234567"],
          mentionPatterns: ["\\bfable\\b"],
          channels: {
            photon: {
              address: "+15550001111",
              envFile: "agents/fable.env",
              notifySpaceId: "+15559876543",
            },
          },
          relay: {
            hostId: "pi-lhc",
            threadId: "th_fable",
            cwd: "/srv/work/long-horizon-context",
            command: "pi-lhc",
            args: ["--lhc-thread", "th_fable", "-p"],
            timeoutMs: 1_800_000,
          },
        },
      },
    });

    const loaded = loadAgentRegistry(home);
    expect(loaded.agents).toHaveLength(1);
    expect(loaded.agents[0]).toMatchObject({
      id: "fable",
      ownerSenderIds: ["+15551234567"],
      mentionPatterns: ["\\bfable\\b"],
      channels: {
        photon: {
          address: "+15550001111",
          envFile: join(home, "agents", "fable.env"),
          notifySpaceId: "+15559876543",
        },
      },
    });
    expect(loaded.relayTargets.fable).toMatchObject({
      hostId: "pi-lhc",
      threadId: "th_fable",
      command: "pi-lhc",
      timeoutMs: 1_800_000,
    });
  });

  it("returns empty targets when no agents are configured", () => {
    const home = mkdtempSync(join(tmpdir(), "lhc-agents-"));
    dirs.push(home);
    writeRegistry(home, { version: 1, agents: {} });
    const loaded = loadAgentRegistry(home);
    expect(loaded.agents).toEqual([]);
    expect(loaded.relayTargets).toEqual({});
  });
});
