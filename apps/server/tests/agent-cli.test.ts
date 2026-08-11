import { describe, expect, it } from "vite-plus/test";
import { runAgentCli } from "../src/agent-cli.ts";

function response(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function deps(fetchImpl: typeof fetch, stdin = "", agentId: string | null = null) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    value: {
      fetch: fetchImpl,
      token: "test-secret",
      baseUrl: "http://127.0.0.1:5959",
      agentId,
      readStdin: async () => stdin,
      stdout: (line: string) => stdout.push(line),
      stderr: (line: string) => stderr.push(line),
    },
    stdout,
    stderr,
  };
}

describe("lhc-agent CLI", () => {
  it("onboards callers with one bare command", async () => {
    const state = deps(async () =>
      response(200, [
        {
          id: "fable",
          name: "Fable",
          description: "Principal long-horizon agent",
          duties: ["architecture"],
          channels: ["photon"],
        },
      ]),
    );

    expect(await runAgentCli([], state.value)).toBe(0);
    const output = state.stdout.join("\n");
    expect(output).toContain("Available agents");
    expect(output).toContain("fable");
    expect(output).toContain("Principal long-horizon agent");
    expect(output).toContain('lhc-agent fable "Your message"');
    expect(output).not.toContain("http://");
    expect(output).not.toContain("Bearer");
  });

  it("calls an agent by key and prints only its reply", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const state = deps(async (input, init) => {
      requests.push({ url: requestUrl(input), init });
      return response(200, { id: "job-1", status: "completed", output: "Fable reply" });
    });

    expect(await runAgentCli(["fable", "Review", "this"], state.value)).toBe(0);
    expect(state.stdout).toEqual(["Fable reply"]);
    expect(requests[0]?.url).toBe("http://127.0.0.1:5959/api/relay/targets/fable/jobs");
    expect(requests[0]?.init).toMatchObject({
      method: "POST",
      body: JSON.stringify({ prompt: "Review this" }),
    });
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe("Bearer test-secret");
  });

  it("accepts a prompt from stdin", async () => {
    const state = deps(async (_input, init) => {
      expect(init?.body).toBe(JSON.stringify({ prompt: "Message from stdin" }));
      return response(200, { id: "job-1", status: "completed", output: "done" });
    }, "Message from stdin\n");
    expect(await runAgentCli(["fable", "-"], state.value)).toBe(0);
    expect(state.stdout).toEqual(["done"]);
  });

  it("starts and checks long-running jobs without exposing transport details", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const state = deps(async (input, init) => {
      calls.push({ url: requestUrl(input), init });
      return calls.length === 1
        ? response(202, { id: "job-7", status: "queued" })
        : response(200, { id: "job-7", status: "completed", output: "finished" });
    });

    expect(await runAgentCli(["start", "fable", "Long", "task"], state.value)).toBe(0);
    expect(state.stdout).toEqual(["job-7"]);
    expect(new Headers(calls[0]?.init?.headers).get("prefer")).toBe("respond-async");
    expect(await runAgentCli(["job", "job-7"], state.value)).toBe(0);
    expect(state.stdout.at(-1)).toBe("finished");
  });

  it("reports cancelled jobs as settled failures", async () => {
    const state = deps(async () => response(200, { id: "job-8", status: "cancelled" }));

    expect(await runAgentCli(["job", "job-8"], state.value)).toBe(2);
    expect(state.stdout).toEqual([]);
    expect(state.stderr).toEqual(["agent call cancelled"]);
  });

  it("sends prioritized relay jobs when --priority is set", async () => {
    const requests: Array<{ init?: RequestInit }> = [];
    const state = deps(async (_input, init) => {
      requests.push({ init });
      return response(200, { id: "job-1", status: "completed", output: "done" });
    });

    expect(await runAgentCli(["--priority", "fable", "Urgent"], state.value)).toBe(0);
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      prompt: "Urgent",
      jobClass: "prioritized",
    });
  });

  it("rejects ambiguous --priority placement", async () => {
    let calls = 0;
    const state = deps(async () => {
      calls += 1;
      return response(500);
    });
    expect(await runAgentCli(["fable", "--priority", "hello"], state.value)).toBe(1);
    expect(calls).toBe(0);
    expect(state.stderr.join("\n")).toMatch(/--priority/);
  });

  it("starts and inspects goals through compact goal subcommands", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const state = deps(async (input, init) => {
      const url = requestUrl(input);
      calls.push({ url, init });
      if (url.endsWith("/api/goals") && init?.method === "POST") {
        return response(201, {
          id: "goal-1",
          target: "fable",
          objective: "Ship it",
          state: "active",
        });
      }
      if (url.endsWith("/api/goals")) {
        return response(200, [
          { id: "goal-1", target: "fable", objective: "Ship it", state: "active" },
        ]);
      }
      if (url.endsWith("/api/goals/goal-1/complete")) return response(200, { id: "goal-1" });
      return response(200, {
        id: "goal-1",
        target: "fable",
        objective: "Ship it",
        state: "active",
        cadenceMs: 300_000,
      });
    });

    expect(
      await runAgentCli(["goal", "start", "fable", "Ship it", "--every", "5m"], state.value),
    ).toBe(0);
    expect(state.stdout[0]).toBe("goal-1");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      target: "fable",
      objective: "Ship it",
      cadence: "5m",
    });

    expect(await runAgentCli(["goal", "list"], state.value)).toBe(0);
    expect(state.stdout.at(-1)).toContain("goal-1");

    expect(await runAgentCli(["goal", "goal-1"], state.value)).toBe(0);
    expect(state.stdout.join("\n")).toContain("objective: Ship it");

    expect(await runAgentCli(["goal", "done", "goal-1"], state.value)).toBe(0);
    expect(calls.some((call) => call.url.endsWith("/complete"))).toBe(true);
  });

  it("rejects empty prompts before making a request", async () => {
    let calls = 0;
    const state = deps(async () => {
      calls += 1;
      return response(500);
    });
    expect(await runAgentCli(["fable", "  "], state.value)).toBe(1);
    expect(calls).toBe(0);
    expect(state.stderr.join("\n")).toContain("prompt is required");
  });

  it("lists lee as a special one-way destination", async () => {
    const state = deps(async () =>
      response(200, [
        {
          id: "fable",
          name: "Fable",
          description: "Principal long-horizon agent",
          duties: [],
          channels: ["photon"],
        },
      ]),
    );

    expect(await runAgentCli([], state.value)).toBe(0);
    const output = state.stdout.join("\n");
    expect(output).toContain("lee");
    expect(output).toMatch(/one-way|no reply/i);
    expect(output).toContain("fable");
  });

  it("documents detached peer calls in help", async () => {
    const state = deps(async () => response(500));
    expect(await runAgentCli(["help"], state.value)).toBe(0);
    expect(state.stdout.join("\n")).toMatch(/start .*may provoke a reply|deadlock/i);
  });

  it("sends lee messages fire-and-forget with sender attribution", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const state = deps(async (input, init) => {
      requests.push({ url: requestUrl(input), init });
      return response(202, { id: "lee-job-1", status: "queued", jobKind: "outbound" });
    });
    state.value.readStdin = async () => "stdin body";

    expect(await runAgentCli(["--from", "fable", "lee", "-"], state.value)).toBe(0);
    expect(state.stdout).toEqual(["lee-job-1"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://127.0.0.1:5959/api/relay/targets/lee/jobs");
    expect(new Headers(requests[0]?.init?.headers).get("prefer")).toBe("respond-async");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      prompt: "stdin body",
      sender: "fable",
    });
  });

  it("auto-detects sender from LHC_AGENT_ID for lee", async () => {
    const requests: Array<{ init?: RequestInit }> = [];
    const state = deps(
      async (_input, init) => {
        requests.push({ init });
        return response(202, { id: "lee-job-2", status: "queued" });
      },
      "",
      "fable",
    );
    expect(await runAgentCli(["lee", "ping"], state.value)).toBe(0);
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      prompt: "ping",
      sender: "fable",
    });
  });

  it("requires an explicit sender for lee when LHC_AGENT_ID is absent", async () => {
    let calls = 0;
    const state = deps(async () => {
      calls += 1;
      return response(500);
    });
    expect(await runAgentCli(["lee", "ping"], state.value)).toBe(1);
    expect(calls).toBe(0);
    expect(state.stderr.join("\n")).toMatch(/sender|--from|LHC_AGENT_ID/i);
  });

  it("sends peer attribution for ordinary agent calls", async () => {
    const requests: Array<{ init?: RequestInit }> = [];
    const state = deps(
      async (_input, init) => {
        requests.push({ init });
        return response(200, { id: "job-1", status: "completed", output: "ok" });
      },
      "",
      "fable",
    );
    expect(await runAgentCli(["scribe", "hello"], state.value)).toBe(0);
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      prompt: "hello",
      sender: "fable",
    });
  });
});
