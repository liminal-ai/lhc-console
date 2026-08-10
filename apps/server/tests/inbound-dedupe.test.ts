import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { InboundDedupeStore } from "../src/inbound-dedupe.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("InboundDedupeStore", () => {
  it("claims a chat+message id once across restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-dedupe-"));
    dirs.push(dir);
    const dbPath = join(dir, "dedupe.sqlite");
    const first = new InboundDedupeStore(dbPath);
    expect(first.claim("dm:+15559876543", "dm-1")).toBe(true);
    expect(first.claim("dm:+15559876543", "dm-1")).toBe(false);

    const second = new InboundDedupeStore(dbPath);
    expect(second.claim("dm:+15559876543", "dm-1")).toBe(false);
    expect(second.claim("dm:+15559876543", "dm-2")).toBe(true);
  });
});
