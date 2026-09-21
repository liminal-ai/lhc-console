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

  it("parses relay.concurrent and rejects a non-boolean value", () => {
    const home = mkdtempSync(join(tmpdir(), "lhc-agents-"));
    dirs.push(home);
    const relay = {
      hostId: "t3code",
      threadId: "thread_wren",
      cwd: "/tmp",
      command: "t3code-inject",
      args: ["--thread", "thread_wren"],
    };
    writeRegistry(home, {
      version: 1,
      agents: {
        plain: { ownerSenderIds: ["owner"], relay },
        wren: { ownerSenderIds: ["owner"], relay: { ...relay, concurrent: true } },
      },
    });
    const loaded = loadAgentRegistry(home);
    expect(loaded.relayTargets.plain?.concurrent).toBeUndefined();
    expect(loaded.relayTargets.wren?.concurrent).toBe(true);

    writeRegistry(home, {
      version: 1,
      agents: { wren: { ownerSenderIds: ["owner"], relay: { ...relay, concurrent: "yes" } } },
    });
    expect(() => loadAgentRegistry(home)).toThrow(/wren\.relay\.concurrent must be a boolean/);
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

describe("group lines", () => {
  function seat(threadId: string) {
    return {
      ownerSenderIds: ["+1555"],
      relay: { hostId: "t3code", threadId, cwd: "/tmp", command: "true", args: [] },
    };
  }
  function home(): string {
    const dir = mkdtempSync(join(tmpdir(), "lhc-agents-"));
    dirs.push(dir);
    mkdirSync(join(dir, "agents"), { recursive: true });
    writeFileSync(join(dir, "agents", "spec-group.env"), "PHOTON_PROJECT_ID=p\n", { mode: 0o600 });
    return dir;
  }
  function groupEntry(members: string[], extra: Record<string, unknown> = {}) {
    return {
      ownerSenderIds: ["+1555"],
      channels: {
        photon: { address: "+1999", envFile: "agents/spec-group.env", notifySpaceId: "d" },
      },
      group: { members },
      ...extra,
    };
  }

  it("loads a group line separately from seats and never as a relay target", () => {
    const dir = home();
    writeRegistry(dir, {
      version: 1,
      agents: {
        sable: seat("th_s"),
        flint: seat("th_f"),
        "spec-group": groupEntry(["sable", "flint"], {
          mentionPatterns: ["(?<![\\w@])@all\\b"],
          group: { members: ["sable", "flint"], catchUp: { messages: 5 } },
        }),
      },
    });
    const registry = loadAgentRegistry(dir);
    expect(registry.agents.map((agent) => agent.id)).toEqual(["sable", "flint"]);
    expect(Object.keys(registry.relayTargets)).toEqual(["sable", "flint"]);
    expect(registry.groups).toHaveLength(1);
    expect(registry.groups[0]).toMatchObject({
      id: "spec-group",
      mentionPatterns: ["(?<![\\w@])@all\\b"],
      group: { members: ["sable", "flint"], catchUp: { mode: "window", messages: 5 } },
    });
  });

  it("defaults catchUp to all and accepts last", () => {
    const dir = home();
    writeRegistry(dir, {
      version: 1,
      agents: {
        a: seat("1"),
        b: seat("2"),
        g1: groupEntry(["a", "b"]),
        g2: groupEntry(["a", "b"], { group: { members: ["a", "b"], catchUp: "last" } }),
      },
    });
    const groups = loadAgentRegistry(dir).groups;
    expect(groups.map((group) => group.group.catchUp)).toEqual([{ mode: "all" }, { mode: "last" }]);
  });

  it.each([
    ["unknown member", ["sable", "ghost"], {}, /unknown agent ghost/],
    ["fewer than two", ["sable"], {}, /at least two/],
    ["duplicate", ["sable", "sable"], {}, /must not repeat/],
    ["relay on a group", ["sable", "flint"], { relay: { hostId: "x" } }, /relay is not allowed/],
    ["v2 on a group", ["sable", "flint"], { v2: { provider: "hermes" } }, /v2 is not allowed/],
    [
      "bad catchUp",
      ["sable", "flint"],
      { group: { members: ["sable", "flint"], catchUp: "some" } },
      /catchUp/,
    ],
  ])("rejects %s", (_label, members, extra, pattern) => {
    const dir = home();
    writeRegistry(dir, {
      version: 1,
      agents: {
        sable: seat("th_s"),
        flint: seat("th_f"),
        "spec-group": groupEntry(members, extra),
      },
    });
    expect(() => loadAgentRegistry(dir)).toThrow(pattern);
  });

  it("rejects a member that is itself a group line, and a group without a photon channel", () => {
    const dir = home();
    writeRegistry(dir, {
      version: 1,
      agents: {
        sable: seat("th_s"),
        flint: seat("th_f"),
        inner: groupEntry(["sable", "flint"]),
        outer: groupEntry(["sable", "inner"]),
      },
    });
    expect(() => loadAgentRegistry(dir)).toThrow(/inner is a group line/);
    writeRegistry(dir, {
      version: 1,
      agents: {
        sable: seat("th_s"),
        flint: seat("th_f"),
        g: { ownerSenderIds: ["+1"], group: { members: ["sable", "flint"] } },
      },
    });
    expect(() => loadAgentRegistry(dir)).toThrow(/channels.photon is required/);
  });
});
