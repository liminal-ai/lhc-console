import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  isWriterLockHeld,
  markWriterLockHandedOff,
  releaseWriterLock,
  releaseWriterLockByKey,
  tryAcquireWriterLock,
  writerResourceKey,
} from "../src/v2/writer-lock.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function resource(canonical = "th_shared") {
  const hostHome = "/tmp/fake-host-home";
  return {
    key: writerResourceKey(hostHome, canonical),
    hostId: "pi-lhc",
    hostHome,
    hostThreadId: "session",
    canonicalThreadId: canonical,
  };
}

describe("canonical writer lock", () => {
  it("is exclusive for one resource and independent across resources", () => {
    const home = mkdtempSync(join(tmpdir(), "lhc-v2-lock-"));
    dirs.push(home);
    const a = resource("th_a");
    const b = resource("th_b");
    const first = tryAcquireWriterLock(home, a);
    expect(first.ok).toBe(true);
    expect(isWriterLockHeld(home, a.key)).toBe(true);
    const second = tryAcquireWriterLock(home, a);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("busy");
    const other = tryAcquireWriterLock(home, b);
    expect(other.ok).toBe(true);
    releaseWriterLock(first.held);
    releaseWriterLock(other.held);
    expect(isWriterLockHeld(home, a.key)).toBe(false);
  });

  it("aliases the same canonical thread to one lock key", () => {
    const keyA = writerResourceKey("/home/host", "th_same");
    const keyB = writerResourceKey("/home/host", "th_same");
    const keyC = writerResourceKey("/home/other", "th_same");
    expect(keyA).toBe(keyB);
    expect(keyA).not.toBe(keyC);
  });

  it("keeps a pinned handoff claim held until it is released explicitly", () => {
    const home = mkdtempSync(join(tmpdir(), "lhc-v2-lock-handoff-"));
    dirs.push(home);
    const a = resource("th_handoff");
    const first = tryAcquireWriterLock(home, a);
    expect(first.ok).toBe(true);
    markWriterLockHandedOff(first.held!);
    expect(isWriterLockHeld(home, a.key)).toBe(true);
    const second = tryAcquireWriterLock(home, a);
    expect(second.ok).toBe(false);
    releaseWriterLockByKey(home, a.key);
    expect(isWriterLockHeld(home, a.key)).toBe(false);
  });
});
