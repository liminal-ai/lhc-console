import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseV2OwnerPolicies,
  type ResolvedV2OwnerPolicies,
  type V2OwnerPolicies,
} from "./policies.ts";

export const V2_FLAG_ENV = "LHC_CONSOLE_V2";
export const V2_TOKEN_ENV = "LHC_CONSOLE_V2_TOKEN";

export function isV2Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[V2_FLAG_ENV];
  return value === "1" || value === "true";
}

export function v2DbPath(consoleHome: string): string {
  return join(consoleHome, "v2.sqlite");
}

export function loadConfiguredOwnerPolicies(
  consoleHome: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedV2OwnerPolicies | null {
  const inline = env.LHC_CONSOLE_V2_POLICIES;
  if (inline?.trim()) {
    const parsed = JSON.parse(inline) as unknown;
    return {
      policies: parseV2OwnerPolicies(parsed, "LHC_CONSOLE_V2_POLICIES"),
      source: "explicit",
    };
  }
  const path = join(consoleHome, "v2-policies.json");
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return { policies: parseV2OwnerPolicies(parsed, "v2-policies.json"), source: "explicit" };
}

export function v2BearerToken(
  policies: V2OwnerPolicies,
  v1Token: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (policies.authToken === "reuse-v1-relay-token") return v1Token;
  const token = env[V2_TOKEN_ENV]?.trim();
  if (!token) {
    throw new Error("Q1 owner-only-v2-token is selected but LHC_CONSOLE_V2_TOKEN is empty");
  }
  return token;
}
