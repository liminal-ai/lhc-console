import { describe, expect, it } from "vite-plus/test";
import { executeRelayTarget } from "../src/relay-process.ts";

const target = {
  hostId: "pi-lhc",
  threadId: "th_test",
  cwd: process.cwd(),
  command: process.execPath,
  args: ["-e", "process.stdout.write(process.argv[1])"],
};

describe("executeRelayTarget", () => {
  it("passes the complete prompt as one argv value without a shell", async () => {
    const prompt = 'hello; touch /tmp/never-created; $(printf nope) "quoted"';
    await expect(executeRelayTarget(target, prompt, { timeoutMs: 1000 })).resolves.toBe(prompt);
  });

  it("terminates a turn that exceeds its timeout", async () => {
    const slow = {
      ...target,
      args: ["-e", "setTimeout(() => {}, 1000)"],
    };
    await expect(executeRelayTarget(slow, "ignored", { timeoutMs: 20 })).rejects.toThrow(
      "timed out after 20ms",
    );
  });

  it("terminates a turn when shutdown aborts it", async () => {
    const controller = new AbortController();
    const slow = {
      ...target,
      args: ["-e", "setTimeout(() => {}, 1000)"],
    };
    const running = executeRelayTarget(slow, "ignored", {
      timeoutMs: 2000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(running).rejects.toThrow("aborted");
  });
});
