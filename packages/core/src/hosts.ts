import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** One directory of thread files, for hosts that have no registry. */
export interface ScanRoot {
  /** Absolute directory holding `*.sqlite` thread files. */
  dir: string;
  /** Profile the directory belongs to; null for the host's default profile. */
  profile: string | null;
}

export interface HostDescriptor {
  /** Stable host id, e.g. "cc-lhc". */
  id: string;
  /** Display label. */
  label: string;
  /** Host home directory (absolute). */
  home: string;
  /**
   * How threads are discovered: "registry" hosts have a registry.sqlite,
   * "scan" hosts (hermes) are enumerated from directories of thread files.
   */
  kind: "registry" | "scan";
  /** Path to the host's thread registry SQLite; null for scan hosts. */
  registryPath: string | null;
  /** Directory holding per-thread SQLite files (the default one for scan hosts). */
  threadsDir: string;
  /** Directories scanned for thread files; empty for registry hosts. */
  scanRoots: ScanRoot[];
}

const REGISTRY_HOST_IDS = [
  "cc-lhc",
  "pi-lhc",
  "codex-lhc",
  "t3code-lhc",
  "grok-lhc",
  "hermes-lhc",
] as const;

/** Registry-less hosts, discovered by scanning directories of thread files. */
const SCAN_HOST_IDS = ["hermes"] as const;

function homeFor(id: string): string {
  const envKey = `${id.toUpperCase().replace(/-/g, "_")}_HOME`;
  return process.env[envKey] ?? join(homedir(), `.${id}`);
}

/**
 * Hermes stores threads per profile with no registry: `<home>/lhc/threads` for
 * the default profile plus `<home>/profiles/<name>/lhc/threads` for each named
 * one. Only directories that exist are returned.
 */
function hermesRoots(home: string): ScanRoot[] {
  const roots: ScanRoot[] = [];
  const base = join(home, "lhc", "threads");
  if (existsSync(base)) roots.push({ dir: base, profile: null });
  let profiles: string[] = [];
  try {
    profiles = readdirSync(join(home, "profiles"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    // no profiles directory — the default profile (if any) is the whole host
  }
  for (const name of profiles) {
    const dir = join(home, "profiles", name, "lhc", "threads");
    if (existsSync(dir)) roots.push({ dir, profile: name });
  }
  return roots;
}

export function describeHost(id: string): HostDescriptor {
  const home = homeFor(id);
  if ((SCAN_HOST_IDS as readonly string[]).includes(id)) {
    const scanRoots = hermesRoots(home);
    return {
      id,
      label: id,
      home,
      kind: "scan",
      registryPath: null,
      threadsDir: join(home, "lhc", "threads"),
      scanRoots,
    };
  }
  return {
    id,
    label: id,
    home,
    kind: "registry",
    registryPath: join(home, "registry.sqlite"),
    threadsDir: join(home, "threads"),
    scanRoots: [],
  };
}

/** Hosts that are actually present on this machine. */
export function discoverHosts(): HostDescriptor[] {
  return [...REGISTRY_HOST_IDS, ...SCAN_HOST_IDS]
    .map(describeHost)
    .filter((h) =>
      h.kind === "registry"
        ? !!h.registryPath && existsSync(h.registryPath)
        : h.scanRoots.length > 0,
    );
}
