import { describe, expect, it } from "vite-plus/test";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { runMonitorCli } from "../src/monitor-cli.ts";

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

describe("lhc-monitor CLI", () => {
  it("runs through a PATH symlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-monitor-cli-"));
    const cliPath = join(dirname(fileURLToPath(import.meta.url)), "../src/monitor-cli.ts");
    const linkPath = join(dir, "lhc-monitor");
    symlinkSync(cliPath, linkPath);
    const result = spawnSync(linkPath, ["--help"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("lhc-monitor add");
  });

  it("shows the complete add/list/remove hot path with no arguments", async () => {
    const stdout: string[] = [];
    const code = await runMonitorCli([], {
      fetch: async () => response(500),
      token: "secret",
      baseUrl: "http://127.0.0.1:5959",
      stdout: (line) => stdout.push(line),
      stderr: () => undefined,
    });
    expect(code).toBe(0);
    expect(stdout.join("\n")).toContain(
      'lhc-monitor add fable 5m --idle-for 3m --max-ticks 12 --prompt "Continue the goal."',
    );
    expect(stdout.join("\n")).toContain("--quiet");
    expect(stdout.join("\n")).toContain("lhc-monitor list");
    expect(stdout.join("\n")).toContain("lhc-monitor remove <id>");
  });

  it("adds a monitor through the authenticated API", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const stdout: string[] = [];
    const code = await runMonitorCli(
      [
        "add",
        "fable",
        "5m",
        "--idle-for",
        "10m",
        "--max-ticks",
        "12",
        "--prompt",
        "Continue the goal.",
        "--quiet",
      ],
      {
        fetch: async (url, init) => {
          requests.push({ url: requestUrl(url), init });
          return response(201, { id: "mon-1", target: "fable", intervalMs: 300_000 });
        },
        token: "secret",
        baseUrl: "http://127.0.0.1:5959",
        stdout: (line) => stdout.push(line),
        stderr: () => undefined,
      },
    );
    expect(code).toBe(0);
    expect(requests[0]?.url).toBe("http://127.0.0.1:5959/api/monitors");
    expect(requests[0]?.init).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        target: "fable",
        interval: "5m",
        idleFor: "10m",
        maxTicks: 12,
        prompt: "Continue the goal.",
        quiet: true,
      }),
    });
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer secret");
    expect(headers.get("content-type")).toBe("application/json");
    expect(stdout).toEqual(["mon-1"]);
  });

  it("lists monitors and removes one", async () => {
    const stdout: string[] = [];
    const calls: string[] = [];
    const deps = {
      fetch: async (url: string | URL | Request, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${requestUrl(url)}`);
        return init?.method === "DELETE"
          ? response(204)
          : response(200, [
              {
                id: "mon-1",
                target: "fable",
                intervalMs: 300_000,
                idleForMs: 180_000,
                tickCount: 2,
                maxTicks: 12,
                active: true,
                lastJobId: "job-2",
              },
            ]);
      },
      token: "secret",
      baseUrl: "http://127.0.0.1:5959",
      stdout: (line: string) => stdout.push(line),
      stderr: () => undefined,
    };
    expect(await runMonitorCli(["list"], deps)).toBe(0);
    expect(stdout.join("\n")).toContain("mon-1");
    expect(stdout.join("\n")).toContain("fable");
    expect(await runMonitorCli(["remove", "mon-1"], deps)).toBe(0);
    expect(calls).toEqual([
      "GET http://127.0.0.1:5959/api/monitors",
      "DELETE http://127.0.0.1:5959/api/monitors/mon-1",
    ]);
  });
});
