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
          ownerSenderIds: ["+155****4567"],
          mentionPatterns: ["\\bfable\\b"],
          health: {
            hostId: "pi-lhc",
            threadId: "th_canonical_fable",
          },
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
      ownerSenderIds: ["+155****4567"],
      mentionPatterns: ["\\bfable\\b"],
      health: {
        hostId: "pi-lhc",
        threadId: "th_canonical_fable",
      },
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

  it("rejects an incomplete canonical health reference", () => {
    const home = mkdtempSync(join(tmpdir(), "lhc-agents-"));
    dirs.push(home);
    writeRegistry(home, {
      version: 1,
      agents: {
        fable: {
          ownerSenderIds: ["owner"],
          health: { hostId: "pi-lhc" },
          relay: {
            hostId: "pi-lhc",
            threadId: "runtime-session-id",
            cwd: "/tmp",
            command: "pi-lhc",
            args: ["-p"],
          },
        },
      },
    });

    expect(() => loadAgentRegistry(home)).toThrow(/health\.threadId/);
  });

  it("loads an optional v2 block without changing the required relay block", () => {
    const home = mkdtempSync(join(tmpdir(), "lhc-agents-"));
    dirs.push(home);
    writeRegistry(home, {
      version: 1,
      agents: {
        fable: {
          ownerSenderIds: ["owner"],
          health: { hostId: "pi-lhc", threadId: "th_canonical" },
          relay: {
            hostId: "pi-lhc",
            threadId: "th_canonical",
            cwd: "/tmp",
            command: "pi-lhc",
            args: ["-p"],
          },
          v2: {
            provider: "pi-lhc",
            command: "pi-lhc",
            args: ["--lhc-thread", "th_canonical", "--mode", "rpc"],
          },
        },
      },
    });
    const loaded = loadAgentRegistry(home);
    expect(loaded.agents[0]?.v2).toMatchObject({
      provider: "pi-lhc",
      command: "pi-lhc",
    });
    expect(loaded.relayTargets.fable.command).toBe("pi-lhc");
  });

  it("loads a hermes v2 block with the disposable-home env it will start under", () => {
    const home = mkdtempSync(join(tmpdir(), "lhc-agents-"));
    dirs.push(home);
    writeRegistry(home, {
      version: 1,
      agents: {
        courier: {
          ownerSenderIds: ["owner"],
          health: { hostId: "hermes", threadId: "th_hermes_canonical" },
          relay: {
            hostId: "hermes",
            threadId: "20260819_000000_abc123",
            cwd: "/tmp",
            command: "hermes",
            args: [],
          },
          v2: {
            provider: "hermes",
            env: { HERMES_HOME: "/tmp/hermes-disposable" },
          },
        },
      },
    });
    const loaded = loadAgentRegistry(home);
    expect(loaded.agents[0]?.v2).toMatchObject({
      provider: "hermes",
      env: { HERMES_HOME: "/tmp/hermes-disposable" },
    });
  });

  it("rejects an unknown v2 provider with the full provider list", () => {
    const home = mkdtempSync(join(tmpdir(), "lhc-agents-"));
    dirs.push(home);
    writeRegistry(home, {
      version: 1,
      agents: {
        fable: {
          ownerSenderIds: ["owner"],
          relay: {
            hostId: "mystery",
            threadId: "th_test",
            cwd: "/tmp",
            command: "mystery",
            args: ["-p"],
          },
          v2: { provider: "mystery" },
        },
      },
    });
    expect(() => loadAgentRegistry(home)).toThrow(
      /v2\.provider must be one of codex-lhc, pi-lhc, hermes/,
    );
  });

  it("rejects a v2 provider that does not match relay.hostId", () => {
    const home = mkdtempSync(join(tmpdir(), "lhc-agents-"));
    dirs.push(home);
    writeRegistry(home, {
      version: 1,
      agents: {
        fable: {
          ownerSenderIds: ["owner"],
          relay: {
            hostId: "pi-lhc",
            threadId: "th_test",
            cwd: "/tmp",
            command: "pi-lhc",
            args: ["-p"],
          },
          v2: { provider: "codex-lhc" },
        },
      },
    });
    expect(() => loadAgentRegistry(home)).toThrow(/v2\.provider must match/);
  });

  it("rejects agent keys reserved by the CLI", () => {
    for (const key of ["help", "goal"]) {
      const home = mkdtempSync(join(tmpdir(), "lhc-agents-"));
      dirs.push(home);
      writeRegistry(home, {
        version: 1,
        agents: {
          [key]: {
            ownerSenderIds: ["owner"],
            relay: {
              hostId: "pi-lhc",
              threadId: "th_test",
              cwd: "/tmp",
              command: "pi-lhc",
              args: ["-p"],
            },
          },
        },
      });
      expect(() => loadAgentRegistry(home)).toThrow(`reserved agent key: ${key}`);
    }
  });

  it("does not reserve v2 as a V1 target name when the agent has no v2 block", () => {
    const home = mkdtempSync(join(tmpdir(), "lhc-agents-"));
    dirs.push(home);
    writeRegistry(home, {
      version: 1,
      agents: {
        v2: {
          ownerSenderIds: ["owner"],
          relay: {
            hostId: "pi-lhc",
            threadId: "th_test",
            cwd: "/tmp",
            command: "pi-lhc",
            args: ["-p"],
          },
        },
      },
    });
    const loaded = loadAgentRegistry(home);
    expect(loaded.agents[0]?.id).toBe("v2");
  });

  it("reserves v2 only when that agent opts into the V2 plane", () => {
    const home = mkdtempSync(join(tmpdir(), "lhc-agents-"));
    dirs.push(home);
    writeRegistry(home, {
      version: 1,
      agents: {
        v2: {
          ownerSenderIds: ["owner"],
          relay: {
            hostId: "pi-lhc",
            threadId: "th_test",
            cwd: "/tmp",
            command: "pi-lhc",
            args: ["-p"],
          },
          v2: { provider: "pi-lhc" },
        },
      },
    });
    expect(() => loadAgentRegistry(home)).toThrow("reserved agent key: v2");
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
