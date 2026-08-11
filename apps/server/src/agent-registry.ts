import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { assertOwnerOnlyFile } from "./env-file.ts";
import type { RelayTarget } from "./relay.ts";

export interface PhotonChannelConfig {
  address: string;
  envFile: string;
  notifySpaceId?: string;
}

export interface AgentChannels {
  photon?: PhotonChannelConfig;
}

export interface AgentRecord {
  id: string;
  name: string;
  description: string;
  duties: string[];
  ownerSenderIds: string[];
  mentionPatterns: string[];
  channels: AgentChannels;
  relay: RelayTarget;
}

export interface LoadedAgentRegistry {
  agents: AgentRecord[];
  relayTargets: Record<string, RelayTarget>;
}

interface RawRelayConfig {
  hostId?: unknown;
  threadId?: unknown;
  cwd?: unknown;
  command?: unknown;
  args?: unknown;
  timeoutMs?: unknown;
  env?: unknown;
}

interface RawPhotonChannel {
  address?: unknown;
  envFile?: unknown;
  notifySpaceId?: unknown;
}

interface RawChannels {
  photon?: RawPhotonChannel;
}

interface RawAgentConfig {
  name?: unknown;
  description?: unknown;
  duties?: unknown;
  ownerSenderIds?: unknown;
  mentionPatterns?: unknown;
  channels?: RawChannels;
  relay?: RawRelayConfig;
}

interface RawRegistry {
  version?: unknown;
  agents?: Record<string, RawAgentConfig>;
}

const DEFAULT_MENTION_PATTERNS = [
  String.raw`(?<![\w@])@?hermes\s+agent\b[,:\-]?`,
  String.raw`(?<![\w@])@?hermes\b[,:\-]?`,
];

export function loadAgentRegistry(consoleHome: string): LoadedAgentRegistry {
  const path = join(consoleHome, "agents.json");
  let parsed: RawRegistry;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as RawRegistry;
    assertOwnerOnlyFile(path, "agents.json");
  } catch (error) {
    if (isMissingFile(error)) return { agents: [], relayTargets: {} };
    throw new Error(
      `could not read agent registry at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed.version !== 1) {
    throw new Error(`agent registry version must be 1 (got ${String(parsed.version)})`);
  }
  const agents: AgentRecord[] = [];
  const relayTargets: Record<string, RelayTarget> = {};
  for (const [id, raw] of Object.entries(parsed.agents ?? {})) {
    const record = parseAgent(id, raw, consoleHome);
    agents.push(record);
    relayTargets[id] = record.relay;
  }
  return { agents, relayTargets };
}

const RESERVED_AGENT_KEYS = new Set(["help", "list", "start", "job"]);

function parseAgent(id: string, raw: RawAgentConfig, consoleHome: string): AgentRecord {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    throw new Error(`agent key must match [a-z][a-z0-9-]*: ${id}`);
  }
  if (RESERVED_AGENT_KEYS.has(id)) throw new Error(`reserved agent key: ${id}`);
  const name = optionalString(raw.name) ?? id;
  const description = optionalString(raw.description) ?? `${name} durable agent`;
  const duties = raw.duties === undefined ? [] : requireStringArray(raw.duties, `${id}.duties`);
  const ownerSenderIds = requireStringArray(raw.ownerSenderIds, `${id}.ownerSenderIds`);
  if (!ownerSenderIds.length) {
    throw new Error(`${id}.ownerSenderIds must include at least one sender id`);
  }
  const mentionPatterns = parseMentionPatterns(raw.mentionPatterns);
  const channels = parseChannels(id, raw.channels, consoleHome);
  const relay = parseRelay(id, raw.relay);
  return { id, name, description, duties, ownerSenderIds, mentionPatterns, channels, relay };
}

function parseChannels(
  id: string,
  raw: RawChannels | undefined,
  consoleHome: string,
): AgentChannels {
  const channels: AgentChannels = {};
  if (!raw || typeof raw !== "object") return channels;
  if (raw.photon !== undefined) {
    if (!raw.photon || typeof raw.photon !== "object") {
      throw new Error(`${id}.channels.photon must be an object`);
    }
    const envFile = resolveEnvFilePath(
      requireString(raw.photon.envFile, `${id}.channels.photon.envFile`),
      consoleHome,
    );
    channels.photon = {
      address: requireString(raw.photon.address, `${id}.channels.photon.address`),
      envFile,
      ...(raw.photon.notifySpaceId === undefined
        ? {}
        : {
            notifySpaceId: requireString(
              raw.photon.notifySpaceId,
              `${id}.channels.photon.notifySpaceId`,
            ),
          }),
    };
  }
  return channels;
}

function parseRelay(id: string, raw: RawRelayConfig | undefined): RelayTarget {
  if (!raw || typeof raw !== "object") {
    throw new Error(`${id}.relay is required`);
  }
  const command = requireString(raw.command, `${id}.relay.command`);
  const args = requireStringArray(raw.args, `${id}.relay.args`);
  const target: RelayTarget = {
    hostId: requireString(raw.hostId, `${id}.relay.hostId`),
    threadId: requireString(raw.threadId, `${id}.relay.threadId`),
    cwd: requireString(raw.cwd, `${id}.relay.cwd`),
    command,
    args,
  };
  if (raw.timeoutMs !== undefined) {
    if (
      typeof raw.timeoutMs !== "number" ||
      !Number.isFinite(raw.timeoutMs) ||
      raw.timeoutMs <= 0
    ) {
      throw new Error(`${id}.relay.timeoutMs must be a positive number`);
    }
    target.timeoutMs = raw.timeoutMs;
  }
  if (raw.env !== undefined) {
    if (!raw.env || typeof raw.env !== "object" || Array.isArray(raw.env)) {
      throw new Error(`${id}.relay.env must be an object`);
    }
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(raw.env)) {
      if (typeof value !== "string") {
        throw new Error(`${id}.relay.env.${key} must be a string`);
      }
      env[key] = value;
    }
    target.env = env;
  }
  return target;
}

function parseMentionPatterns(raw: unknown): string[] {
  if (raw === undefined) return [...DEFAULT_MENTION_PATTERNS];
  const patterns = requireStringArray(raw, "mentionPatterns");
  if (!patterns.length) throw new Error("mentionPatterns must not be empty when provided");
  for (const pattern of patterns) {
    try {
      new RegExp(pattern);
    } catch (error) {
      throw new Error(
        `invalid mention pattern ${JSON.stringify(pattern)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return patterns;
}

function resolveEnvFilePath(path: string, consoleHome: string): string {
  return isAbsolute(path) ? path : join(consoleHome, path);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
