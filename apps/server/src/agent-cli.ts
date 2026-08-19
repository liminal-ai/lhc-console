#!/usr/bin/env node
import { chmodSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PublicAgent } from "./agent-routes.ts";
import { isRelayJobWaitSettled, type RelayJob } from "./relay.ts";

interface CliDeps {
  fetch: typeof fetch;
  token: string;
  v2Token?: string | null;
  baseUrl: string;
  agentId: string | null;
  readStdin: () => Promise<string>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const LEE_DESCRIPTION = 'One-way message to Lee (no reply; use lhc-agent lee "message")';

const HELP = `lhc-agent — discover and call durable agents

Run lhc-agent by itself to see the agents available to you.

Usage:
  lhc-agent
  lhc-agent <agent> "Your message"
  lhc-agent <agent> -                 Read the message from stdin
  lhc-agent [--from <agent>] [--priority] <agent> "Message"
  lhc-agent lee "Message"             One-way message to Lee (always async)
  lhc-agent start <agent> "Message"  Start a long call; print its job key
  lhc-agent start [--from <agent>] [--priority] <agent> "Message"
  lhc-agent job <job>                 Check a job; print its reply when done
  lhc-agent v2 <command> <agent>      Additive V2 plane (does not change one-shot calls)
  lhc-agent v2 <agent> <command>      Same, unless a V1 agent is named v2
  lhc-agent goal start <agent> "objective" [--every <duration>]
  lhc-agent goal list
  lhc-agent goal <id>
  lhc-agent goal done <id>
  lhc-agent goal blocked <id> "reason"
  lhc-agent goal cancel <id>
  lhc-agent help

Peer calls that may provoke a reply must use start (detached):
  lhc-agent start <agent> "Message"
Blocking mutual peer calls can deadlock until timeout.

Sender attribution (--from or LHC_AGENT_ID) is trusted only at the relay
token boundary. Recipients see a compact [from: agent] envelope when declared.

Examples:
  lhc-agent fable "Review this design."
  lhc-agent lee "Heads up from the build."
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
    if (args[0] === "goal") return await goal(args.slice(1), deps);
    if (args[0] === "start") return await start(args.slice(1), deps);
    if (args[0] === "job") return await job(args.slice(1), deps);
    if (args[0] === "v2") {
      // A V1 agent may be named "v2". Only enter the V2 plane when an action
      // token is present: `v2 start fable` or `v2 fable start`.
      if (isV2Subcommand(args[1]) || isV2Subcommand(args[2])) return await v2(args.slice(1), deps);
      return await call(args, deps, false);
    }
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
  deps.stdout("Special destinations:");
  deps.stdout(`  lee  ${LEE_DESCRIPTION}`);
  deps.stdout("");
  deps.stdout('Call one: lhc-agent <agent> "Your message"');
  if (agents[0]) deps.stdout(`Example:  lhc-agent ${agents[0].id} "Your message"`);
  deps.stdout('Lee:      lhc-agent lee "Your message"');
  deps.stdout("More:     lhc-agent help");
  return 0;
}

async function start(args: string[], deps: CliDeps): Promise<number> {
  return call(args, deps, true);
}

async function call(args: string[], deps: CliDeps, detached: boolean): Promise<number> {
  const { rest, prioritized, from } = parseCallFlags(args);
  const target = rest[0];
  if (!target) throw new Error(`usage: lhc-agent ${detached ? "start " : ""}<agent> <message|->`);
  const promptArgs = rest.slice(1);
  if (!promptArgs.length) throw new Error("prompt is required");
  const fromStdin = promptArgs.length === 1 && promptArgs[0] === "-";
  const prompt = fromStdin
    ? await deps.readStdin()
    : normalizeInlineLeeMessage(target, promptArgs.join(" "));
  if (!prompt.trim()) throw new Error("prompt is required");

  const sender = from ?? deps.agentId;
  if (target === "lee" && !sender) {
    throw new Error(
      "lee requires a sender: set LHC_AGENT_ID in the environment or pass --from <registered-agent-key>",
    );
  }

  const headers = new Headers({ "content-type": "application/json" });
  if (detached || target === "lee") headers.set("prefer", "respond-async");
  const result = (await api(deps, `/api/relay/targets/${encodeURIComponent(target)}/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      prompt: prompt.trim(),
      ...(prioritized ? { jobClass: "prioritized" } : {}),
      ...(sender ? { sender } : {}),
    }),
  })) as RelayJob;

  if (detached || target === "lee" || !isRelayJobWaitSettled(result)) {
    deps.stdout(result.id);
    return 0;
  }
  return printSettled(result, deps);
}

function normalizeInlineLeeMessage(target: string, prompt: string): string {
  if (target !== "lee") return prompt;
  return prompt.replace(/\\r\\n|\\n/g, "\n");
}

const V2_ACTIONS = new Set([
  "start",
  "stop",
  "turn",
  "steer",
  "next",
  "interrupt",
  "status",
  "handoff",
  "release",
]);

function isV2Subcommand(value: string | undefined): boolean {
  return Boolean(value && V2_ACTIONS.has(value));
}

async function v2(args: string[], deps: CliDeps): Promise<number> {
  let target = args[0];
  let action = args[1];
  let rest = args.slice(2);
  if (isV2Subcommand(target) && action) {
    rest = args.slice(2);
    [action, target] = [target, action];
  }
  if (!target || !action) {
    throw new Error(
      "usage: lhc-agent v2 <agent> <start|stop|turn|steer|next|interrupt|status|handoff|release> [text]",
    );
  }
  if (action === "status") {
    const status = await api(
      deps,
      `/api/v2/targets/${encodeURIComponent(target)}/status`,
      {},
      true,
    );
    deps.stdout(JSON.stringify(status));
    return 0;
  }
  const kind =
    action === "start"
      ? "runtime.start"
      : action === "stop"
        ? "runtime.stop"
        : action === "turn"
          ? "turn.start"
          : action === "steer"
            ? "turn.steer"
            : action === "next"
              ? "turn.followUp"
              : action === "interrupt"
                ? "turn.interrupt"
                : action === "handoff"
                  ? "handoff.request"
                  : action === "release"
                    ? "handoff.release"
                    : null;
  if (!kind) throw new Error(`unknown v2 command: ${action}`);
  const text = rest.join(" ").trim();
  const params: Record<string, unknown> =
    kind === "runtime.start"
      ? {}
      : kind === "runtime.stop"
        ? { mode: "drain" }
        : kind === "turn.start"
          ? { text }
          : kind === "turn.steer" || kind === "turn.followUp"
            ? { text, ...(kind === "turn.steer" ? { expectedTurnId: "" } : { afterTurnId: "" }) }
            : kind === "turn.interrupt"
              ? { expectedTurnId: "" }
              : kind === "handoff.request"
                ? { mode: "drain", launch: "command-only" }
                : {};
  if (
    (kind === "turn.steer" || kind === "turn.followUp" || kind === "turn.interrupt") &&
    !params.expectedTurnId &&
    !params.afterTurnId
  ) {
    const status = (await api(
      deps,
      `/api/v2/targets/${encodeURIComponent(target)}/status`,
      {},
      true,
    )) as {
      currentTurn?: { turnId?: string };
    };
    const turnId = status.currentTurn?.turnId;
    if (!turnId) throw new Error("no active V2 turn");
    if (kind === "turn.steer") Object.assign(params, { expectedTurnId: turnId });
    if (kind === "turn.followUp") Object.assign(params, { afterTurnId: turnId });
    if (kind === "turn.interrupt") Object.assign(params, { expectedTurnId: turnId });
  }
  const receipt = await api(
    deps,
    `/api/v2/targets/${encodeURIComponent(target)}/commands`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: crypto.randomUUID(), kind, params }),
    },
    true,
  );
  deps.stdout(JSON.stringify(receipt));
  return 0;
}

async function job(args: string[], deps: CliDeps): Promise<number> {
  if (args.length !== 1) throw new Error("usage: lhc-agent job <job>");
  const result = (await api(deps, `/api/relay/jobs/${encodeURIComponent(args[0]!)}`)) as RelayJob;
  if (!isRelayJobWaitSettled(result)) {
    deps.stdout(result.status);
    return 3;
  }
  return printSettled(result, deps);
}

function parseCallFlags(args: string[]): {
  rest: string[];
  prioritized: boolean;
  from: string | null;
} {
  const rest: string[] = [];
  let prioritized = false;
  let from: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--priority") {
      if (rest.length > 0) throw new Error("--priority must appear before the agent name");
      prioritized = true;
      continue;
    }
    if (arg === "--from") {
      if (rest.length > 0) throw new Error("--from must appear before the agent name");
      const value = args[index + 1];
      if (!value) throw new Error("--from requires a registered agent key");
      from = value;
      index += 1;
      continue;
    }
    rest.push(arg);
  }
  if (rest.includes("--priority")) {
    throw new Error("--priority must appear before the agent name");
  }
  if (rest.includes("--from")) {
    throw new Error("--from must appear before the agent name");
  }
  return { rest, prioritized, from };
}

async function goal(args: string[], deps: CliDeps): Promise<number> {
  if (!args.length || args[0] === "help" || args[0] === "--help") {
    deps.stdout(GOAL_HELP);
    return 0;
  }
  if (args[0] === "start") return await goalStart(args.slice(1), deps);
  if (args[0] === "list") return await goalList(args.slice(1), deps);
  if (args[0] === "done" || args[0] === "complete") return await goalDone(args.slice(1), deps);
  if (args[0] === "blocked") return await goalBlocked(args.slice(1), deps);
  if (args[0] === "cancel") return await goalCancel(args.slice(1), deps);
  if (args.length === 1) return await goalGet(args[0]!, deps);
  throw new Error(`unknown goal command: ${args[0]}`);
}

const GOAL_HELP = `Goal commands:
  lhc-agent goal start <agent> "objective" [--every <duration>]
  lhc-agent goal list
  lhc-agent goal <id>
  lhc-agent goal done <id>
  lhc-agent goal blocked <id> "reason"
  lhc-agent goal cancel <id>

When a goal reminder arrives, continue the objective and mark it done or blocked:
  lhc-agent goal done <id>
  lhc-agent goal blocked <id> "reason"`;

async function goalStart(args: string[], deps: CliDeps): Promise<number> {
  const target = args[0];
  if (!target)
    throw new Error('usage: lhc-agent goal start <agent> "objective" [--every <duration>]');
  let objective: string | undefined;
  let every = "5m";
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--every" && value !== undefined) {
      every = value;
      index += 1;
    } else if (!objective) {
      objective = flag;
    } else {
      objective = `${objective} ${flag}`;
    }
  }
  if (!objective?.trim()) throw new Error("objective is required");
  const result = (await api(deps, "/api/goals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target, objective: objective.trim(), cadence: every }),
  })) as { id: string };
  deps.stdout(result.id);
  return 0;
}

async function goalList(args: string[], deps: CliDeps): Promise<number> {
  if (args.length) throw new Error("usage: lhc-agent goal list");
  const goals = (await api(deps, "/api/goals")) as Array<{
    id: string;
    target: string;
    objective: string;
    state: string;
  }>;
  if (!goals.length) {
    deps.stdout("No goals.");
    return 0;
  }
  deps.stdout("ID\tTARGET\tSTATE\tOBJECTIVE");
  for (const entry of goals) {
    deps.stdout([entry.id, entry.target, entry.state, entry.objective].join("\t"));
  }
  return 0;
}

async function goalGet(id: string, deps: CliDeps): Promise<number> {
  const entry = (await api(deps, `/api/goals/${encodeURIComponent(id)}`)) as Record<
    string,
    unknown
  >;
  for (const [key, value] of Object.entries(entry)) {
    const rendered =
      value === null || value === undefined
        ? "-"
        : typeof value === "string" || typeof value === "number" || typeof value === "boolean"
          ? String(value)
          : JSON.stringify(value);
    deps.stdout(`${key}: ${rendered}`);
  }
  return 0;
}

async function goalDone(args: string[], deps: CliDeps): Promise<number> {
  if (args.length !== 1) throw new Error("usage: lhc-agent goal done <id>");
  await api(deps, `/api/goals/${encodeURIComponent(args[0]!)}/complete`, { method: "POST" });
  deps.stdout(args[0]!);
  return 0;
}

async function goalBlocked(args: string[], deps: CliDeps): Promise<number> {
  if (args.length < 2) throw new Error('usage: lhc-agent goal blocked <id> "reason"');
  const id = args[0]!;
  const reason = args.slice(1).join(" ").trim();
  if (!reason) throw new Error("blocked reason is required");
  await api(deps, `/api/goals/${encodeURIComponent(id)}/blocked`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason }),
  });
  deps.stdout(id);
  return 0;
}

async function goalCancel(args: string[], deps: CliDeps): Promise<number> {
  if (args.length !== 1) throw new Error("usage: lhc-agent goal cancel <id>");
  await api(deps, `/api/goals/${encodeURIComponent(args[0]!)}/cancel`, { method: "POST" });
  deps.stdout(args[0]!);
  return 0;
}

function printSettled(job: RelayJob, deps: CliDeps): number {
  if (job.status === "failed" || job.status === "cancelled") {
    deps.stderr(
      job.error ?? (job.status === "cancelled" ? "agent call cancelled" : "agent call failed"),
    );
    return 2;
  }
  if (job.jobKind === "outbound" && job.deliveryStatus === "failed") {
    deps.stderr(job.deliveryError ?? "message delivery failed");
    return 2;
  }
  deps.stdout(job.output ?? "");
  return 0;
}

async function api(
  deps: CliDeps,
  path: string,
  init: RequestInit = {},
  v2 = false,
): Promise<unknown> {
  const headers = new Headers(init.headers);
  const token = v2 ? deps.v2Token?.trim() || deps.token : deps.token;
  headers.set("authorization", `Bearer ${token}`);
  const response = await deps.fetch(`${deps.baseUrl}${path}`, { ...init, headers });
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok)
    throw new Error(body?.error ?? `LHC gateway failed with HTTP ${response.status}`);
  return body;
}

function productionDeps(): CliDeps {
  const home = process.env.LHC_CONSOLE_HOME ?? join(homedir(), ".lhc-console");
  const token = process.env.LHC_RELAY_TOKEN?.trim() || readToken(join(home, "relay-token"));
  const v2Token = process.env.LHC_CONSOLE_V2_TOKEN?.trim() || null;
  const port = process.env.LHC_CONSOLE_PORT ?? "5959";
  const agentId = process.env.LHC_AGENT_ID?.trim() || null;
  return {
    fetch,
    token,
    v2Token,
    baseUrl: process.env.LHC_CONSOLE_URL ?? `http://127.0.0.1:${port}`,
    agentId,
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
