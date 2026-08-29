import { describe, expect, it, vi } from "vite-plus/test";
import { formatFailureNotice } from "../src/relay-delivery.ts";
import {
  executeRelayTarget,
  relayProcessFailureMessage,
  RelayProcessError,
} from "../src/relay-process.ts";
import type { RelayJob } from "../src/relay.ts";

function noticeFromError(error: Error, prompt: string): string {
  const job: RelayJob = {
    id: "job-blank-stderr",
    target: "fable",
    prompt,
    status: "failed",
    jobClass: "deprioritized",
    jobKind: "agent",
    sender: null,
    output: null,
    error: error.message,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:00.000Z",
    notify: "photon",
    delivery: { channel: "photon", destination: { spaceId: "chat-1" } },
    deliveryStatus: "pending",
    deliveryError: null,
  };
  return formatFailureNotice(job);
}

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

  it("returns a concise Claude provider refusal instead of wrapper teardown diagnostics", async () => {
    const providerFailure = [
      "API Error: Fable 5's safeguards flagged this message (https://www.anthropic.com/legal/aup). This sometimes happens with safe, normal conversations. Claude Code can't respond to this message with Fable 5.",
      "",
      "Try rephrasing the request in a new session or change your model.",
      "",
      "Learn more: https://support.claude.com/en/articles/15363606",
      "",
      "Details: `[reasoning_extraction]`",
      "",
      "Request ID: req_test_123",
    ].join("\n");
    const refusalTarget = {
      ...target,
      hostId: "cc-lhc",
      args: [
        "-e",
        [
          "process.stdout.write(process.argv[1])",
          'process.stderr.write("cc-lhc-capture lines=31 events=2 thread=th_test\\n")',
          "process.exitCode = 1",
        ].join(";"),
        providerFailure,
      ],
    };

    await expect(executeRelayTarget(refusalTarget, "harmless", { timeoutMs: 1000 })).resolves.toBe(
      [
        "Fable 5 could not respond because its safeguards rejected this request.",
        "Reason: reasoning_extraction",
        "Request ID: req_test_123",
        "No model change or prompt replay occurred.",
      ].join("\n"),
    );
  });

  it("returns the refusal when the envelope arrives through cc-lhc's pty framing", async () => {
    // cc-lhc runs Claude in a pty: ONLCR emits "\r\n" and Claude restores the
    // cursor (CSI ?25h) on exit. Observed byte-exact on an isolated crossing.
    const ptyStdout =
      [
        "API Error: Fable 5's safeguards flagged this message (https://www.anthropic.com/legal/aup). This sometimes happens with safe, normal conversations. Claude Code can't respond to this message with Fable 5.",
        "",
        "Try rephrasing the request in a new session or change your model.",
        "",
        "Learn more: https://support.claude.com/en/articles/15363606",
        "",
        "Details: `[reasoning_extraction]`",
        "",
        "Request ID: req_011CeS8JDeYdwPfHJuV14rdS",
        "",
      ].join("\r\n") + "\u001b[?25h";
    const ptyTarget = {
      ...target,
      hostId: "cc-lhc",
      args: [
        "-e",
        [
          "process.stdout.write(process.argv[1])",
          'process.stderr.write("cc-lhc-capture lines=13 events=2 thread=th_test\\n")',
          "process.exitCode = 1",
        ].join(";"),
        ptyStdout,
      ],
    };

    await expect(executeRelayTarget(ptyTarget, "harmless", { timeoutMs: 1000 })).resolves.toBe(
      [
        "Fable 5 could not respond because its safeguards rejected this request.",
        "Reason: reasoning_extraction",
        "Request ID: req_011CeS8JDeYdwPfHJuV14rdS",
        "No model change or prompt replay occurred.",
      ].join("\n"),
    );
  });

  it("does not promote a partial envelope hidden inside pty control sequences", async () => {
    const ptyTarget = {
      ...target,
      hostId: "cc-lhc",
      args: [
        "-e",
        [
          `process.stdout.write(${JSON.stringify(
            "\u001b[?25lAPI Error: Fable 5's safeguards flagged this message.\r\n\r\nDetails: `[reasoning_extraction]`\r\n\r\nRequest ID: req_spoofed\r\n\u001b[?25h",
          )})`,
          'process.stderr.write("actual failure")',
          "process.exitCode = 1",
        ].join(";"),
      ],
    };

    await expect(executeRelayTarget(ptyTarget, "harmless", { timeoutMs: 1000 })).rejects.toThrow(
      "actual failure",
    );
  });

  it("does not promote an incomplete safeguard-like envelope from a failed process", async () => {
    const failedTarget = {
      ...target,
      hostId: "cc-lhc",
      args: [
        "-e",
        [
          `process.stdout.write(${JSON.stringify(
            "API Error: Fable 5's safeguards flagged this message.\n\nDetails: `[reasoning_extraction]`\n\nRequest ID: req_spoofed",
          )})`,
          'process.stderr.write("actual failure")',
          "process.exitCode = 1",
        ].join(";"),
      ],
    };

    await expect(executeRelayTarget(failedTarget, "harmless", { timeoutMs: 1000 })).rejects.toThrow(
      "actual failure",
    );
  });

  it("invokes onSpawn once when the child process spawns", async () => {
    const spawned: string[] = [];
    await executeRelayTarget(target, "ok", {
      timeoutMs: 1000,
      onSpawn: () => spawned.push("spawned"),
    });
    expect(spawned).toEqual(["spawned"]);
  });

  it("does not invoke onSpawn when spawn fails", async () => {
    const spawned: string[] = [];
    await expect(
      executeRelayTarget(
        { ...target, command: "/definitely-missing-binary", args: [] },
        "ignored",
        { timeoutMs: 1000, onSpawn: () => spawned.push("spawned") },
      ),
    ).rejects.toThrow();
    expect(spawned).toEqual([]);
  });

  it("closes stdin so print-mode targets can observe EOF", async () => {
    const waitsForEof = {
      ...target,
      args: [
        "-e",
        "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(process.argv[1]))",
      ],
    };
    await expect(executeRelayTarget(waitsForEof, "after-eof", { timeoutMs: 1000 })).resolves.toBe(
      "after-eof",
    );
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

  it("uses a target-specific timeout when the caller does not override it", async () => {
    const slow = {
      ...target,
      timeoutMs: 20,
      args: ["-e", "setTimeout(() => {}, 1000)"],
    };
    await expect(executeRelayTarget(slow, "ignored")).rejects.toThrow("timed out after 20ms");
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
    await expect(running).rejects.toThrow("relay process exited with code ABORT_ERR");
  });

  it("injects LHC_AGENT_ID for durable agent self-identification", async () => {
    const prompt = "probe";
    const withAgentId = {
      ...target,
      args: ["-e", "process.stdout.write(process.env.LHC_AGENT_ID + ':' + process.argv[1])"],
    };
    await expect(
      executeRelayTarget(withAgentId, prompt, {
        timeoutMs: 1000,
        env: { LHC_AGENT_ID: "fable" },
      }),
    ).resolves.toBe("fable:probe");
  });

  it("preserves the service environment when a target adds its own variables", async () => {
    const withTargetEnv = {
      ...target,
      env: { LHC_AGENT_ID: "fable" },
      args: ["-e", "process.stdout.write(process.env.PATH + ':' + process.env.LHC_AGENT_ID)"],
    };
    await expect(executeRelayTarget(withTargetEnv, "ignored", { timeoutMs: 1000 })).resolves.toBe(
      `${process.env.PATH}:fable`,
    );
  });

  it("rejects a structured process error that preserves code, stdout, and stderr", async () => {
    const failedTarget = {
      ...target,
      args: [
        "-e",
        [
          "process.stdout.write('partial-out')",
          "process.stderr.write('boom-stderr\\n')",
          "process.exit(2)",
        ].join(";"),
      ],
    };
    const error = await executeRelayTarget(failedTarget, "harmless", { timeoutMs: 1000 }).then(
      () => {
        throw new Error("expected rejection");
      },
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(RelayProcessError);
    const processError = error as RelayProcessError;
    expect(processError.code).toBe(2);
    expect(processError.stdout).toBe("partial-out");
    expect(processError.stderr).toBe("boom-stderr\n");
    expect(processError.message).toBe("boom-stderr");
  });

  it("delivers nonblank stdout when exit code is 3 and stderr has a capture-degraded line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const degradedTarget = {
      ...target,
      hostId: "cc-lhc",
      args: [
        "-e",
        [
          "process.stdout.write('agent result after degraded capture')",
          "process.stderr.write('wrapper noise\\nCC_LHC_CAPTURE_DEGRADED: jsonl truncated\\nmore noise\\n')",
          "process.exit(3)",
        ].join(";"),
      ],
    };
    try {
      await expect(
        executeRelayTarget(degradedTarget, "harmless", { timeoutMs: 1000 }),
      ).resolves.toBe("agent result after degraded capture");
      const diagnostics = warn.mock.calls
        .map((args) => String(args[0] ?? ""))
        .filter((line) => line.includes("relay_capture_degraded"));
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toContain("CC_LHC_CAPTURE_DEGRADED: jsonl truncated");
      expect(diagnostics[0]).not.toContain("harmless");
    } finally {
      warn.mockRestore();
    }
  });

  it("records exactly one bounded diagnostic even when stderr has several degraded lines", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const longDetail = "x".repeat(800);
    const degradedTarget = {
      ...target,
      args: [
        "-e",
        [
          "process.stdout.write('kept result')",
          `process.stderr.write(${JSON.stringify(
            `CC_LHC_CAPTURE_DEGRADED: first ${longDetail}\nCC_LHC_CAPTURE_DEGRADED: second\n`,
          )})`,
          "process.exit(3)",
        ].join(";"),
      ],
    };
    try {
      await expect(
        executeRelayTarget(degradedTarget, "harmless", { timeoutMs: 1000 }),
      ).resolves.toBe("kept result");
      const diagnostics = warn.mock.calls
        .map((args) => String(args[0] ?? ""))
        .filter((line) => line.includes("relay_capture_degraded"));
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toContain("CC_LHC_CAPTURE_DEGRADED: first");
      expect(diagnostics[0]).not.toContain("second");
      expect(JSON.parse(diagnostics[0] as string).diagnostic.endsWith("…")).toBe(true);
      expect(JSON.parse(diagnostics[0] as string).diagnostic.length).toBeLessThanOrEqual(601);
    } finally {
      warn.mockRestore();
    }
  });

  it("does not treat code 3 with blank stdout as capture-degraded", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const blankTarget = {
      ...target,
      args: [
        "-e",
        [
          "process.stdout.write('  \\n\\t')",
          "process.stderr.write('CC_LHC_CAPTURE_DEGRADED: empty stdout\\n')",
          "process.exit(3)",
        ].join(";"),
      ],
    };
    try {
      await expect(
        executeRelayTarget(blankTarget, "harmless", { timeoutMs: 1000 }),
      ).rejects.toThrow("CC_LHC_CAPTURE_DEGRADED: empty stdout");
      expect(
        warn.mock.calls
          .map((args) => String(args[0] ?? ""))
          .filter((line) => line.includes("relay_capture_degraded")),
      ).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("does not treat a nonzero code other than 3 as capture-degraded", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const otherCode = {
      ...target,
      args: [
        "-e",
        [
          "process.stdout.write('would-be-result')",
          "process.stderr.write('CC_LHC_CAPTURE_DEGRADED: ignored\\n')",
          "process.exit(1)",
        ].join(";"),
      ],
    };
    try {
      await expect(executeRelayTarget(otherCode, "harmless", { timeoutMs: 1000 })).rejects.toThrow(
        "CC_LHC_CAPTURE_DEGRADED: ignored",
      );
      expect(
        warn.mock.calls
          .map((args) => String(args[0] ?? ""))
          .filter((line) => line.includes("relay_capture_degraded")),
      ).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("does not treat code 3 without the exact degraded prefix as capture-degraded", async () => {
    const otherStderr = {
      ...target,
      args: [
        "-e",
        [
          "process.stdout.write('would-be-result')",
          "process.stderr.write('note CC_LHC_CAPTURE_DEGRADED: not a prefix\\n')",
          "process.exit(3)",
        ].join(";"),
      ],
    };
    await expect(executeRelayTarget(otherStderr, "harmless", { timeoutMs: 1000 })).rejects.toThrow(
      "note CC_LHC_CAPTURE_DEGRADED: not a prefix",
    );
  });

  it("does not put the prompt into the rejection message when stderr is blank", async () => {
    const promptMarker = "LIM136_BLANK_STDERR_PROMPT_MARKER_c4d91a02";
    const blankStderrTarget = {
      ...target,
      args: ["-e", "process.exit(2)"],
    };
    const error = await executeRelayTarget(blankStderrTarget, promptMarker, {
      timeoutMs: 1000,
    }).then(
      () => {
        throw new Error("expected rejection");
      },
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(RelayProcessError);
    const processError = error as RelayProcessError;
    expect(processError.stderr.trim()).toBe("");
    expect(processError.message).toBe("relay process exited with code 2");
    expect(processError.message).not.toContain(promptMarker);
    const notice = noticeFromError(processError, promptMarker);
    expect(notice).toContain("relay process exited with code 2");
    expect(notice).not.toContain(promptMarker);
  });

  it("does not treat CSI-only stdout as capture-degraded", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const framingOnly = {
      ...target,
      args: [
        "-e",
        [
          `process.stdout.write(${JSON.stringify("\u001b[?25l\u001b]0;title\u0007\u001b[?25h\r")})`,
          "process.stderr.write('CC_LHC_CAPTURE_DEGRADED: jsonl truncated\\n')",
          "process.exit(3)",
        ].join(";"),
      ],
    };
    try {
      await expect(
        executeRelayTarget(framingOnly, "harmless", { timeoutMs: 1000 }),
      ).rejects.toThrow("CC_LHC_CAPTURE_DEGRADED: jsonl truncated");
      expect(
        warn.mock.calls
          .map((args) => String(args[0] ?? ""))
          .filter((line) => line.includes("relay_capture_degraded")),
      ).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("synthesizes a prompt-free message for a child that kills itself with SIGKILL", async () => {
    const promptMarker = "LIM136_BLANK_STDERR_PROMPT_MARKER_c4d91a02";
    const killTarget = {
      ...target,
      args: ["-e", "process.kill(process.pid, 'SIGKILL')"],
    };
    const error = await executeRelayTarget(killTarget, promptMarker, { timeoutMs: 2000 }).then(
      () => {
        throw new Error("expected rejection");
      },
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(RelayProcessError);
    const processError = error as RelayProcessError;
    expect(processError.message).toBe("relay process terminated by signal SIGKILL");
    expect(processError.message).not.toContain(promptMarker);
    expect(noticeFromError(processError, promptMarker)).not.toContain(promptMarker);
  });
});

describe("relayProcessFailureMessage", () => {
  it("names the terminating signal without using execFile's argv message", () => {
    expect(relayProcessFailureMessage({ code: null, signal: "SIGKILL" })).toBe(
      "relay process terminated by signal SIGKILL",
    );
    expect(relayProcessFailureMessage({ code: 2 })).toBe("relay process exited with code 2");
  });
});
