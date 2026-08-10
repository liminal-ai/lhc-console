import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { loadRelayToken } from "../src/relay-config.ts";
import { RelayQueue } from "../src/relay.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("loadRelayToken", () => {
  it("creates one persistent owner-only token", () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-relay-token-"));
    dirs.push(dir);
    const first = loadRelayToken(dir);
    const second = loadRelayToken(dir);

    expect(first).toBe(second);
    expect(first).toHaveLength(64);
    expect(readFileSync(join(dir, "relay-token"), "utf8").trim()).toBe(first);
    expect(statSync(join(dir, "relay-token")).mode & 0o777).toBe(0o600);
  });
});

describe("relay database permissions", () => {
  it("keeps queued prompts and replies owner-only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-relay-db-"));
    dirs.push(dir);
    const dbPath = join(dir, "relay.sqlite");
    const queue = new RelayQueue({
      dbPath,
      targets: {},
      isBusy: () => false,
      execute: async () => "unused",
    });
    try {
      expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    } finally {
      await queue.close();
    }
  });
});
