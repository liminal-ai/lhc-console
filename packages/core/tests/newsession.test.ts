import { describe, expect, it } from "vite-plus/test";
import {
  launchableHostIds,
  matchNewborn,
  planNewSession,
  type NewbornCandidate,
  type NewSessionEnv,
} from "../src/newsession.ts";

const env: NewSessionEnv = {
  launchable: ["cc-lhc", "pi-lhc", "codex-lhc", "hermes"],
  hermesProfiles: ["research", "work"],
  home: "/home/tester",
  shell: "/usr/bin/zsh",
};

function ok(plan: ReturnType<typeof planNewSession>): Extract<typeof plan, { ok: true }> {
  if (!plan.ok) throw new Error(`expected a plan, got: ${plan.error}`);
  return plan;
}

describe("launchableHostIds", () => {
  it("keeps only startable hosts that are present, never t3code", () => {
    expect(launchableHostIds(["cc-lhc", "t3code-lhc", "grok-lhc", "hermes", "hermes-lhc"])).toEqual(
      ["cc-lhc", "hermes"],
    );
  });

  it("is empty when nothing startable is installed", () => {
    expect(launchableHostIds(["t3code-lhc"])).toEqual([]);
  });
});

describe("planNewSession — commands", () => {
  it("builds a cc-lhc session in a directory", () => {
    const plan = ok(
      planNewSession({ kind: "newSession", hostId: "cc-lhc", cwd: "/srv/work" }, env),
    );
    expect(plan.command).toBe("cd /srv/work && cc-lhc");
    expect(plan.cwd).toBe("/srv/work");
    expect(plan.title).toBe("cc-lhc: work");
    expect(plan.matchCwd).toBe("/srv/work");
  });

  it("builds pi-lhc and codex-lhc the same way", () => {
    expect(
      ok(planNewSession({ kind: "newSession", hostId: "pi-lhc", cwd: "/srv/work/x" }, env)).command,
    ).toBe("cd /srv/work/x && pi-lhc");
    expect(
      ok(planNewSession({ kind: "newSession", hostId: "codex-lhc", cwd: "/srv/w" }, env)).command,
    ).toBe("cd /srv/w && codex-lhc");
  });

  it("drops the trailing slash Tab-completion leaves behind", () => {
    const plan = ok(
      planNewSession({ kind: "newSession", hostId: "cc-lhc", cwd: "/srv/work/lhc-console/" }, env),
    );
    expect(plan.command).toBe("cd /srv/work/lhc-console && cc-lhc");
    expect(plan.matchCwd).toBe("/srv/work/lhc-console");
    expect(plan.title).toBe("cc-lhc: lhc-console");
    expect(ok(planNewSession({ kind: "shell", cwd: "/srv/work/" }, env)).cwd).toBe("/srv/work");
    // The root is a directory too, and it is all slash.
    expect(ok(planNewSession({ kind: "shell", cwd: "/" }, env)).cwd).toBe("/");
  });

  it("quotes a directory the shell would mangle", () => {
    const plan = ok(
      planNewSession({ kind: "newSession", hostId: "cc-lhc", cwd: "/srv/my work" }, env),
    );
    expect(plan.command).toBe("cd '/srv/my work' && cc-lhc");
  });

  it("ignores cwd for hermes and spawns in $HOME", () => {
    const plan = ok(
      planNewSession({ kind: "newSession", hostId: "hermes", cwd: "/srv/work" }, env),
    );
    expect(plan.command).toBe("hermes");
    expect(plan.cwd).toBe("/home/tester");
    expect(plan.title).toBe("hermes: default");
    expect(plan.matchCwd).toBeNull();
  });

  it("accepts a discovered hermes profile", () => {
    expect(
      ok(planNewSession({ kind: "newSession", hostId: "hermes", profile: "work" }, env)).command,
    ).toBe("hermes --profile work");
  });

  it("rejects a hermes profile that does not exist", () => {
    const plan = planNewSession({ kind: "newSession", hostId: "hermes", profile: "nope" }, env);
    expect(plan).toEqual({ ok: false, error: 'unknown hermes profile "nope"' });
  });

  it("builds a plain shell with exec and a login flag", () => {
    const plan = ok(planNewSession({ kind: "shell", cwd: "/srv/work" }, env));
    expect(plan.command).toBe("cd /srv/work && exec /usr/bin/zsh -l");
    expect(plan.hostId).toBe("shell");
    expect(plan.title).toBe("sh: work");
    expect(plan.matchCwd).toBeNull();
  });

  it("falls back to /bin/bash when $SHELL is absent or odd", () => {
    expect(ok(planNewSession({ kind: "shell", cwd: "/x" }, { ...env, shell: null })).command).toBe(
      "cd /x && exec /bin/bash -l",
    );
    expect(ok(planNewSession({ kind: "shell", cwd: "/x" }, { ...env, shell: "zsh" })).command).toBe(
      "cd /x && exec /bin/bash -l",
    );
  });
});

describe("planNewSession — rejections", () => {
  it("refuses t3code-lhc outright", () => {
    expect(planNewSession({ kind: "newSession", hostId: "t3code-lhc", cwd: "/srv" }, env)).toEqual({
      ok: false,
      error: "no new-session command is known for host t3code-lhc",
    });
  });

  it("refuses a host that is not startable at all", () => {
    expect(planNewSession({ kind: "newSession", hostId: "grok-lhc", cwd: "/srv" }, env).ok).toBe(
      false,
    );
  });

  it("refuses a startable host that is not installed here", () => {
    const plan = planNewSession(
      { kind: "newSession", hostId: "codex-lhc", cwd: "/srv" },
      { ...env, launchable: ["cc-lhc"] },
    );
    expect(plan).toEqual({ ok: false, error: "host codex-lhc is not installed here" });
  });

  it("requires a hostId and a directory", () => {
    expect(planNewSession({ kind: "newSession", cwd: "/srv" }, env).ok).toBe(false);
    expect(planNewSession({ kind: "newSession", hostId: "cc-lhc" }, env).ok).toBe(false);
    expect(planNewSession({ kind: "shell", cwd: "  " }, env).ok).toBe(false);
  });

  it("requires an absolute directory", () => {
    expect(planNewSession({ kind: "newSession", hostId: "cc-lhc", cwd: "work" }, env)).toEqual({
      ok: false,
      error: "the directory must be an absolute path",
    });
  });
});

describe("matchNewborn", () => {
  const spawnedAt = "2026-07-27T12:00:00.000Z";
  const at = (offsetMs: number): string => new Date(Date.parse(spawnedAt) + offsetMs).toISOString();
  const rows: NewbornCandidate[] = [
    { threadId: "old", cwd: "/srv/work", createdAt: at(-60_000), title: "yesterday's" },
    { threadId: "elsewhere", cwd: "/srv/other", createdAt: at(2000), title: "other dir" },
    { threadId: "mine", cwd: "/srv/work", createdAt: at(2500), title: "fresh" },
  ];

  it("picks the row in the same directory inside the spawn window", () => {
    expect(matchNewborn(rows, { cwd: "/srv/work", spawnedAt })?.threadId).toBe("mine");
  });

  it("ignores rows created before the window", () => {
    expect(matchNewborn([rows[0]], { cwd: "/srv/work", spawnedAt })).toBeNull();
  });

  it("allows a row dated just before the spawn (clock grace)", () => {
    const early = [{ threadId: "early", cwd: "/srv/work", createdAt: at(-3000), title: null }];
    expect(matchNewborn(early, { cwd: "/srv/work", spawnedAt })?.threadId).toBe("early");
    expect(matchNewborn(early, { cwd: "/srv/work", spawnedAt, graceMs: 1000 })).toBeNull();
  });

  it("ignores a different directory, trailing slash aside", () => {
    expect(matchNewborn(rows, { cwd: "/srv/work/", spawnedAt })?.threadId).toBe("mine");
    expect(matchNewborn(rows, { cwd: "/srv/nothing", spawnedAt })).toBeNull();
  });

  it("ignores rows already claimed by another terminal", () => {
    const claimed = matchNewborn(rows, { cwd: "/srv/work", spawnedAt, taken: ["mine"] });
    expect(claimed).toBeNull();
  });

  it("takes the newest of several candidates", () => {
    const two = [
      { threadId: "a", cwd: "/srv/work", createdAt: at(1000), title: null },
      { threadId: "b", cwd: "/srv/work", createdAt: at(4000), title: null },
    ];
    expect(matchNewborn(two, { cwd: "/srv/work", spawnedAt })?.threadId).toBe("b");
  });

  it("ignores rows with no cwd at all (scan hosts)", () => {
    expect(
      matchNewborn([{ threadId: "h", cwd: null, createdAt: at(10), title: null }], {
        cwd: "/srv/work",
        spawnedAt,
      }),
    ).toBeNull();
  });
});
