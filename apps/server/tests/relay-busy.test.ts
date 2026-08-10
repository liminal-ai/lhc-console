import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { detectAttachedOne, invalidateProcessScan } from "../src/attach-detect.ts";

const children: ReturnType<typeof spawn>[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGTERM");
  invalidateProcessScan();
});

describe("relay busy detection", () => {
  it("sees a matching writer launched by this server process", async () => {
    const child = spawn(process.execPath, [
      "-e",
      "setTimeout(() => {}, 5000)",
      "--",
      "--lhc-thread",
      "th_owned",
    ]);
    children.push(child);
    await new Promise((resolve) => setTimeout(resolve, 20));
    invalidateProcessScan();

    const info = detectAttachedOne(
      {
        hostId: "pi-lhc",
        threadId: "th_owned",
        recipe: { command: "pi-lhc", sessionRef: "th_owned" },
      },
      [],
      { includeOwnProcesses: true },
    );
    expect(info.attached.some((attachment) => attachment.pid === child.pid)).toBe(true);
  });
});
