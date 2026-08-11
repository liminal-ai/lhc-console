#!/usr/bin/env node
import { chmodSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

interface CliDeps {
  fetch: typeof fetch;
  token: string;
  baseUrl: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

interface MonitorSummary {
  id: string;
  target: string;
  intervalMs: number;
  idleForMs: number;
  tickCount: number;
  maxTicks: number;
  active: boolean;
  lastJobId: string | null;
}

const HELP = `lhc-monitor — external periodic wake for an LHC relay target

Usage:
  lhc-monitor add <target> <interval> [--idle-for <duration>] --max-ticks <n> --prompt <text> [--quiet]
  lhc-monitor list
  lhc-monitor remove <id>

Examples:
  lhc-monitor add fable 5m --idle-for 3m --max-ticks 12 --prompt "Continue the goal."
  lhc-monitor list
  lhc-monitor remove <id>

Intervals and idle floors: 30s, 5m, 2h. --idle-for defaults to 3m.
Replies are delivered to the target's Photon channel by default; --quiet disables delivery.
Credentials come from LHC_RELAY_TOKEN or
~/.lhc-console/relay-token; the API defaults to http://127.0.0.1:5959.`;

export async function runMonitorCli(args: string[], deps: CliDeps): Promise<number> {
  if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    deps.stdout(HELP);
    return 0;
  }
  try {
    if (args[0] === "add") return await add(args.slice(1), deps);
    if (args[0] === "list") return await list(args.slice(1), deps);
    if (args[0] === "remove") return await remove(args.slice(1), deps);
    throw new Error(`unknown command: ${args[0]}`);
  } catch (error) {
    deps.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function add(args: string[], deps: CliDeps): Promise<number> {
  const target = args[0];
  const interval = args[1];
  if (!target || !interval)
    throw new Error(
      "usage: lhc-monitor add <target> <interval> [--idle-for <duration>] --max-ticks <n> --prompt <text>",
    );
  let prompt: string | undefined;
  let idleFor = "3m";
  let maxTicks: number | undefined;
  let quiet = false;
  for (let index = 2; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--quiet") {
      quiet = true;
    } else if (flag === "--prompt" && value !== undefined) {
      prompt = value;
      index += 1;
    } else if (flag === "--max-ticks" && value !== undefined) {
      maxTicks = Number(value);
      index += 1;
    } else if (flag === "--idle-for" && value !== undefined) {
      idleFor = value;
      index += 1;
    } else {
      throw new Error(`unknown or incomplete option: ${flag}`);
    }
  }
  if (!prompt?.trim()) throw new Error("--prompt is required");
  if (!Number.isSafeInteger(maxTicks) || Number(maxTicks) <= 0) {
    throw new Error("--max-ticks must be a positive integer");
  }
  const result = await api(deps, "/api/monitors", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target, interval, idleFor, maxTicks, prompt, quiet }),
  });
  deps.stdout(String((result as { id: string }).id));
  return 0;
}

async function list(args: string[], deps: CliDeps): Promise<number> {
  if (args.length) throw new Error("usage: lhc-monitor list");
  const monitors = (await api(deps, "/api/monitors")) as MonitorSummary[];
  if (monitors.length === 0) {
    deps.stdout("No monitors.");
    return 0;
  }
  deps.stdout("ID\tTARGET\tINTERVAL\tIDLE_FOR\tTICKS\tSTATE\tLAST_JOB");
  for (const monitor of monitors) {
    deps.stdout(
      [
        monitor.id,
        monitor.target,
        formatInterval(monitor.intervalMs),
        formatInterval(monitor.idleForMs),
        `${monitor.tickCount}/${monitor.maxTicks}`,
        monitor.active ? "active" : "complete",
        monitor.lastJobId ?? "-",
      ].join("\t"),
    );
  }
  return 0;
}

async function remove(args: string[], deps: CliDeps): Promise<number> {
  if (args.length !== 1) throw new Error("usage: lhc-monitor remove <id>");
  await api(deps, `/api/monitors/${encodeURIComponent(args[0]!)}`, { method: "DELETE" });
  deps.stdout(args[0]!);
  return 0;
}

async function api(deps: CliDeps, path: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${deps.token}`);
  const response = await deps.fetch(`${deps.baseUrl}${path}`, {
    ...init,
    headers,
  });
  if (response.status === 204) return null;
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok)
    throw new Error(body?.error ?? `monitor API failed with HTTP ${response.status}`);
  return body;
}

function formatInterval(intervalMs: number): string {
  if (intervalMs % 3_600_000 === 0) return `${intervalMs / 3_600_000}h`;
  if (intervalMs % 60_000 === 0) return `${intervalMs / 60_000}m`;
  return `${intervalMs / 1000}s`;
}

function productionDeps(): CliDeps {
  const home = process.env.LHC_CONSOLE_HOME ?? join(homedir(), ".lhc-console");
  const tokenPath = join(home, "relay-token");
  const token = process.env.LHC_RELAY_TOKEN?.trim() || readToken(tokenPath);
  const port = process.env.LHC_CONSOLE_PORT ?? "5959";
  return {
    fetch,
    token,
    baseUrl: process.env.LHC_CONSOLE_URL ?? `http://127.0.0.1:${port}`,
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
  process.exitCode = await runMonitorCli(process.argv.slice(2), productionDeps());
}
