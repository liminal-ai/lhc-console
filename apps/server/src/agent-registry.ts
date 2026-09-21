import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { assertOwnerOnlyFile } from "./env-file.ts";
import type { RelayTarget } from "./relay.ts";
import { isV2Provider, V2_PROVIDERS, type V2Provider } from "./v2/contract.ts";

export interface PhotonChannelConfig {
  address: string;
  envFile: string;
  notifySpaceId?: string;
}

export interface AgentChannels {
  photon?: PhotonChannelConfig;
}

export interface AgentHealthRef {
  hostId: string;
  threadId: string;
}

export interface AgentV2Config {
  provider: V2Provider;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  nativeThreadRef?: string;
}

export interface AgentRecord {
  id: string;
  name: string;
  description: string;
  duties: string[];
  ownerSenderIds: string[];
  mentionPatterns: string[];
  health?: AgentHealthRef;
  channels: AgentChannels;
  relay: RelayTarget;
  /** Absent → the target is V1-only. */
  v2?: AgentV2Config;
}

export type GroupCatchUp =
  | { mode: "all" }
  | { mode: "last" }
  | { mode: "window"; messages: number };

export interface AgentGroupConfig {
  members: string[];
  catchUp: GroupCatchUp;
}

/**
 * A group line: one owner-facing Photon DM whose tagged members (seats) answer
 * in-thread. Never a relay target, never a V2 target; it owns a transcript.
 */
export interface GroupRecord {
  id: string;
  name: string;
  description: string;
  duties: string[];
  ownerSenderIds: string[];
  mentionPatterns: string[];
  channels: AgentChannels;
  group: AgentGroupConfig;
}

export interface LoadedAgentRegistry {
  agents: AgentRecord[];
  groups: GroupRecord[];
  relayTargets: Record<string, RelayTarget>;
}

export function isRegisteredRelayTarget(
  relayTargets: Record<string, RelayTarget>,
  target: string,
): boolean {
  return Object.hasOwn(relayTargets, target);
}

interface RawRelayConfig {
  hostId?: unknown;
  threadId?: unknown;
  cwd?: unknown;
  command?: unknown;
  args?: unknown;
  timeoutMs?: unknown;
  env?: unknown;
  concurrent?: unknown;
}

interface RawPhotonChannel {
  address?: unknown;
  envFile?: unknown;
  notifySpaceId?: unknown;
}

interface RawChannels {
  photon?: RawPhotonChannel;
}

interface RawHealthRef {
  hostId?: unknown;
  threadId?: unknown;
}

interface RawV2Config {
  provider?: unknown;
  command?: unknown;
  args?: unknown;
  cwd?: unknown;
  env?: unknown;
  nativeThreadRef?: unknown;
}

interface RawAgentConfig {
  name?: unknown;
  description?: unknown;
  duties?: unknown;
  ownerSenderIds?: unknown;
  mentionPatterns?: unknown;
  health?: RawHealthRef;
  channels?: RawChannels;
  relay?: RawRelayConfig;
  v2?: RawV2Config;
  group?: RawGroupConfig;
}

interface RawGroupConfig {
  members?: unknown;
  catchUp?: unknown;
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
    if (isMissingFile(error)) return { agents: [], groups: [], relayTargets: {} };
    throw new Error(
      `could not read agent registry at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed.version !== 1) {
    throw new Error(`agent registry version must be 1 (got ${String(parsed.version)})`);
  }
  const agents: AgentRecord[] = [];
  const groups: GroupRecord[] = [];
  const relayTargets: Record<string, RelayTarget> = {};
  for (const [id, raw] of Object.entries(parsed.agents ?? {})) {
    if (raw?.group !== undefined) {
      groups.push(parseGroupRecord(id, raw, consoleHome));
      continue;
    }
    const record = parseAgent(id, raw, consoleHome);
    agents.push(record);
    relayTargets[id] = record.relay;
  }
  for (const group of groups) validateGroupMembers(group, agents, groups);
  return { agents, groups, relayTargets };
}

function parseGroupRecord(id: string, raw: RawAgentConfig, consoleHome: string): GroupRecord {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    throw new Error(`agent key must match [a-z][a-z0-9-]*: ${id}`);
  }
  if (reservedAgentKeys(true).has(id)) throw new Error(`reserved agent key: ${id}`);
  if (raw.relay !== undefined) throw new Error(`${id}.relay is not allowed on a group line`);
  if (raw.v2 !== undefined) throw new Error(`${id}.v2 is not allowed on a group line`);
  if (raw.health !== undefined) throw new Error(`${id}.health is not allowed on a group line`);
  const name = optionalString(raw.name) ?? id;
  const description = optionalString(raw.description) ?? `${name} group line`;
  const duties = raw.duties === undefined ? [] : requireStringArray(raw.duties, `${id}.duties`);
  const ownerSenderIds = requireStringArray(raw.ownerSenderIds, `${id}.ownerSenderIds`);
  if (!ownerSenderIds.length) {
    throw new Error(`${id}.ownerSenderIds must include at least one sender id`);
  }
  const mentionPatterns =
    raw.mentionPatterns === undefined ? [] : parseMentionPatterns(raw.mentionPatterns);
  const channels = parseChannels(id, raw.channels, consoleHome);
  if (!channels.photon) throw new Error(`${id}.channels.photon is required on a group line`);
  return {
    id,
    name,
    description,
    duties,
    ownerSenderIds,
    mentionPatterns,
    channels,
    group: parseGroup(id, raw.group),
  };
}

function parseGroup(id: string, raw: RawGroupConfig | undefined): AgentGroupConfig {
  if (!raw || typeof raw !== "object") throw new Error(`${id}.group must be an object`);
  const members = requireStringArray(raw.members, `${id}.group.members`);
  if (members.length < 2) throw new Error(`${id}.group.members must list at least two seats`);
  if (new Set(members).size !== members.length) {
    throw new Error(`${id}.group.members must not repeat a seat`);
  }
  return { members, catchUp: parseGroupCatchUp(id, raw.catchUp) };
}

function parseGroupCatchUp(id: string, raw: unknown): GroupCatchUp {
  if (raw === undefined || raw === "all") return { mode: "all" };
  if (raw === "last") return { mode: "last" };
  if (raw && typeof raw === "object" && "messages" in raw) {
    const messages = (raw as { messages: unknown }).messages;
    if (typeof messages === "number" && Number.isInteger(messages) && messages > 0) {
      return { mode: "window", messages };
    }
  }
  throw new Error(`${id}.group.catchUp must be "all", "last", or { "messages": N } with N >= 1`);
}

function validateGroupMembers(
  group: GroupRecord,
  agents: AgentRecord[],
  groups: GroupRecord[],
): void {
  for (const member of group.group.members) {
    if (groups.some((other) => other.id === member)) {
      throw new Error(`${group.id}.group.members: ${member} is a group line, not a seat`);
    }
    const seat = agents.find((agent) => agent.id === member);
    if (!seat) throw new Error(`${group.id}.group.members: unknown agent ${member}`);
    if (!seat.relay) throw new Error(`${group.id}.group.members: ${member} has no relay target`);
  }
}

const ALWAYS_RESERVED_AGENT_KEYS = new Set(["help", "list", "start", "job", "goal", "lee"]);

export function reservedAgentKeys(v2Enabled = false): Set<string> {
  return v2Enabled
    ? new Set([...ALWAYS_RESERVED_AGENT_KEYS, "v2"])
    : new Set(ALWAYS_RESERVED_AGENT_KEYS);
}

function parseAgent(id: string, raw: RawAgentConfig, consoleHome: string): AgentRecord {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    throw new Error(`agent key must match [a-z][a-z0-9-]*: ${id}`);
  }
  if (reservedAgentKeys(Boolean(raw.v2)).has(id)) throw new Error(`reserved agent key: ${id}`);
  const name = optionalString(raw.name) ?? id;
  const description = optionalString(raw.description) ?? `${name} durable agent`;
  const duties = raw.duties === undefined ? [] : requireStringArray(raw.duties, `${id}.duties`);
  const ownerSenderIds = requireStringArray(raw.ownerSenderIds, `${id}.ownerSenderIds`);
  if (!ownerSenderIds.length) {
    throw new Error(`${id}.ownerSenderIds must include at least one sender id`);
  }
  const mentionPatterns = parseMentionPatterns(raw.mentionPatterns);
  const health = parseHealth(id, raw.health);
  const channels = parseChannels(id, raw.channels, consoleHome);
  const relay = parseRelay(id, raw.relay);
  const v2 = parseV2(id, raw.v2, relay);
  return {
    id,
    name,
    description,
    duties,
    ownerSenderIds,
    mentionPatterns,
    health,
    channels,
    relay,
    ...(v2 ? { v2 } : {}),
  };
}

function parseHealth(id: string, raw: RawHealthRef | undefined): AgentHealthRef | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object") throw new Error(`${id}.health must be an object`);
  return {
    hostId: requireString(raw.hostId, `${id}.health.hostId`),
    threadId: requireString(raw.threadId, `${id}.health.threadId`),
  };
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
  if (raw.concurrent !== undefined) {
    if (typeof raw.concurrent !== "boolean") {
      throw new Error(`${id}.relay.concurrent must be a boolean`);
    }
    if (raw.concurrent) target.concurrent = true;
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

function parseV2(
  id: string,
  raw: RawV2Config | undefined,
  relay: RelayTarget,
): AgentV2Config | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object") throw new Error(`${id}.v2 must be an object`);
  const provider =
    raw.provider === undefined ? relay.hostId : requireString(raw.provider, `${id}.v2.provider`);
  if (!isV2Provider(provider)) {
    throw new Error(`${id}.v2.provider must be one of ${V2_PROVIDERS.join(", ")}`);
  }
  if (provider !== relay.hostId) {
    throw new Error(`${id}.v2.provider must match ${id}.relay.hostId (${relay.hostId})`);
  }
  const config: AgentV2Config = { provider };
  if (raw.command !== undefined) config.command = requireString(raw.command, `${id}.v2.command`);
  if (raw.args !== undefined) config.args = requireStringArray(raw.args, `${id}.v2.args`);
  if (raw.cwd !== undefined) config.cwd = requireString(raw.cwd, `${id}.v2.cwd`);
  if (raw.nativeThreadRef !== undefined) {
    config.nativeThreadRef = requireString(raw.nativeThreadRef, `${id}.v2.nativeThreadRef`);
  }
  if (raw.env !== undefined) {
    if (!raw.env || typeof raw.env !== "object" || Array.isArray(raw.env)) {
      throw new Error(`${id}.v2.env must be an object`);
    }
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(raw.env)) {
      if (typeof value !== "string") {
        throw new Error(`${id}.v2.env.${key} must be a string`);
      }
      env[key] = value;
    }
    config.env = env;
  }
  return config;
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
