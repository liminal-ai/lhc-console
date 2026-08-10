import { readFileSync, statSync } from "node:fs";

export class EnvFileError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EnvFileError";
  }
}

/** Load owner-only key=value env files without logging secret values. */
export function loadEnvFile(path: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new EnvFileError(
      `could not read env file at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export function assertOwnerOnlyFile(path: string, label = path): void {
  let mode: number;
  try {
    mode = statSync(path).mode & 0o777;
  } catch (error) {
    throw new EnvFileError(
      `could not stat ${label}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (mode & 0o077) {
    throw new EnvFileError(`${label} must be owner-only (mode ${mode.toString(8)})`);
  }
}

export function loadPhotonEnvFile(path: string): Record<string, string> {
  assertOwnerOnlyFile(path);
  const env = loadEnvFile(path);
  if (!env.PHOTON_PROJECT_ID?.trim()) {
    throw new EnvFileError(`${path} must set a nonempty PHOTON_PROJECT_ID`);
  }
  if (!env.PHOTON_PROJECT_SECRET?.trim()) {
    throw new EnvFileError(`${path} must set a nonempty PHOTON_PROJECT_SECRET`);
  }
  return env;
}

export function redactEnvForLogs(env: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    redacted[key] = isSecretKey(key) ? "[redacted]" : value;
  }
  return redacted;
}

function isSecretKey(key: string): boolean {
  const lowered = key.toLowerCase();
  return (
    lowered.includes("secret") ||
    lowered.includes("token") ||
    lowered.includes("password") ||
    lowered.includes("credential")
  );
}
