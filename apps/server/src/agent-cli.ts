#!/usr/bin/env node
import { chmodSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PublicAgent } from "./agent-routes.ts";
import type { RelayJob } from "./relay.ts";

interface CliDeps {
  fetch: typeof fetch;
  token: string;
  baseUrl: string;
  readStdin: () => Promise<string>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const HELP = `lhc-agent — discover and call durable agents

Run lhc-agent by itself to see the agents available to you.

Usage:
  lhc-agent
  lhc-agent <agent> "Your message"
  lhc-agent <agent> -                 Read the message from stdin
  lhc-agent start <agent> "Message"  Start a long call; print its job key
  lhc-agent job <job>                 Check a job; print its reply when done
  lhc-agent help

Examples:
  lhc-agent fable "Review this design."
  printf 'Review this design.' | lhc-agent fable -
  job=$(lhc-agent start fable "Take a deep look.")
  lhc-agent job "$job"

The command discovers agents and credentials automatically. You never need a URL,
token, thread ID, phone number, or runtime command.`;

export async function runAgentCli(args: string[], deps: CliDeps): Promise<number> {
  try {
    if (args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
      deps.stdout(HELP);
      return 0;
    }
    if (args.length === 0 || args[0] === "list") return await listAgents(deps);
    if (args[0] === "start") return await start(args.slice(1), deps);
    if (args[0] === "job") return await job(args.slice(1), deps);
    return await call(args, deps, false);
  } catch (error) {
    deps.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function listAgents(deps: CliDeps): Promise<number> {
  const agents = (await api(deps, "/api/agents")) as PublicAgent[];
  deps.stdout("Available agents:");
  if (!agents.length) {
    deps.stdout("  None configured.");
  } else {
    const width = Math.max(...agents.map((agent) => agent.id.length));
    for (const agent of agents) {
      deps.stdout(`  ${agent.id.padEnd(width)}  ${agent.description}`);
    }
  }
  deps.stdout("");
  deps.stdout('Call one: lhc-agent <agent> "Your message"');
  if (agents[0]) deps.stdout(`Example:  lhc-agent ${agents[0].id} "Your message"`);
  deps.stdout("More:     lhc-agent help");
  return 0;
}

async function start(args: string[], deps: CliDeps): Promise<number> {
  return call(args, deps, true);
}

async function call(args: string[], deps: CliDeps, detached: boolean): Promise<number> {
  const target = args[0];
  if (!target) throw new Error(`usage: lhc-agent ${detached ? "start " : ""}<agent> <message|->`);
  const promptArgs = args.slice(1);
  if (!promptArgs.length) throw new Error("prompt is required");
  const prompt =
    promptArgs.length === 1 && promptArgs[0] === "-"
      ? await deps.readStdin()
      : promptArgs.join(" ");
  if (!prompt.trim()) throw new Error("prompt is required");

  const headers = new Headers({ "content-type": "application/json" });
  if (detached) headers.set("prefer", "respond-async");
  const result = (await api(deps, `/api/relay/targets/${encodeURIComponent(target)}/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ prompt: prompt.trim() }),
  })) as RelayJob;

  if (detached || !isSettled(result)) {
    deps.stdout(result.id);
    return 0;
  }
  return printSettled(result, deps);
}

async function job(args: string[], deps: CliDeps): Promise<number> {
  if (args.length !== 1) throw new Error("usage: lhc-agent job <job>");
  const result = (await api(deps, `/api/relay/jobs/${encodeURIComponent(args[0]!)}`)) as RelayJob;
  if (!isSettled(result)) {
    deps.stdout(result.status);
    return 3;
  }
  return printSettled(result, deps);
}

function isSettled(job: RelayJob): boolean {
  return job.status === "completed" || job.status === "failed";
}

function printSettled(job: RelayJob, deps: CliDeps): number {
  if (job.status === "failed") {
    deps.stderr(job.error ?? "agent call failed");
    return 2;
  }
  deps.stdout(job.output ?? "");
  return 0;
}

async function api(deps: CliDeps, path: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${deps.token}`);
  const response = await deps.fetch(`${deps.baseUrl}${path}`, { ...init, headers });
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok)
    throw new Error(body?.error ?? `LHC gateway failed with HTTP ${response.status}`);
  return body;
}

function productionDeps(): CliDeps {
  const home = process.env.LHC_CONSOLE_HOME ?? join(homedir(), ".lhc-console");
  const token = process.env.LHC_RELAY_TOKEN?.trim() || readToken(join(home, "relay-token"));
  const port = process.env.LHC_CONSOLE_PORT ?? "5959";
  return {
    fetch,
    token,
    baseUrl: process.env.LHC_CONSOLE_URL ?? `http://127.0.0.1:${port}`,
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString("utf8");
    },
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  };
}

function readToken(path: string): string {
  chmodSync(path, 0o600);
  const token = readFileSync(path, "utf8").trim();
  if (!token) throw new Error(`empty relay token file: ${path}`);
  return token;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await runAgentCli(process.argv.slice(2), productionDeps());
}
