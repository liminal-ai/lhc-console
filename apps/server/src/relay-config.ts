import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function loadRelayToken(stateDir: string): string {
  const configured = process.env.LHC_RELAY_TOKEN?.trim();
  if (configured) return configured;
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, "relay-token");
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing) {
      chmodSync(path, 0o600);
      return existing;
    }
  } catch {
    // First boot: create below.
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(path, `${token}\n`, { mode: 0o600, flag: "wx" });
  return token;
}
