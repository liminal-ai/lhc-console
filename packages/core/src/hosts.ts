import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface HostDescriptor {
  /** Stable host id, e.g. "cc-lhc". */
  id: string;
  /** Display label. */
  label: string;
  /** Host home directory (absolute). */
  home: string;
  /** Path to the host's thread registry SQLite. */
  registryPath: string;
  /** Directory holding per-thread SQLite files. */
  threadsDir: string;
}

const KNOWN_HOST_IDS = [
  "cc-lhc",
  "pi-lhc",
  "codex-lhc",
  "t3code-lhc",
  "grok-lhc",
  "hermes-lhc",
] as const;

function homeFor(id: string): string {
  const envKey = `${id.toUpperCase().replace(/-/g, "_")}_HOME`;
  return process.env[envKey] ?? join(homedir(), `.${id}`);
}

export function describeHost(id: string): HostDescriptor {
  const home = homeFor(id);
  return {
    id,
    label: id,
    home,
    registryPath: join(home, "registry.sqlite"),
    threadsDir: join(home, "threads"),
  };
}

/** Hosts whose registry exists on this machine. */
export function discoverHosts(): HostDescriptor[] {
  return KNOWN_HOST_IDS.map(describeHost).filter((h) => existsSync(h.registryPath));
}
