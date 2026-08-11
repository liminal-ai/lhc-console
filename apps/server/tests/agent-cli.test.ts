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

function deps(fetchImpl: typeof fetch, stdin = "") {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    value: {
      fetch: fetchImpl,
      token: "test-secret",
      baseUrl: "http://127.0.0.1:5959",
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
});
