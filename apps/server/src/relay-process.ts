import { execFile } from "node:child_process";
import type { EventEmitter } from "node:events";
import type { RelayTarget } from "./relay.ts";
import {
  attachWriterLockOwner,
  closeWriterLockFd,
  releaseWriterLock,
  type HeldWriterLock,
} from "./v2/writer-lock.ts";

interface ExecuteOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  onSpawn?: () => void;
  writerLock?: HeldWriterLock | null;
}

/**
 * cc-lhc runs Claude inside a pty, so its stdout carries terminal framing
 * rather than plain text: ONLCR turns "\n" into "\r\n", and Claude restores
 * the cursor (CSI ?25h) as it exits. Remove only that framing — CSI/OSC
 * control sequences and carriage returns — so the strict envelope match
 * below still sees the exact text Claude wrote.
 */
// oxlint-disable-next-line no-control-regex -- ESC/BEL are the subject here
const PTY_FRAMING = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\r/g;

export function stripPtyFraming(stdout: string): string {
  return stdout.replace(PTY_FRAMING, "");
}

export function relayProcessFailureMessage(error: {
  code?: string | number | null;
  signal?: string | number | null;
}): string {
  if (error.signal) return `relay process terminated by signal ${error.signal}`;
  return `relay process exited with code ${error.code}`;
}

/**
 * Claude Code writes a terminal provider refusal to stdout, then exits
 * nonzero. A wrapper may also write teardown diagnostics to stderr. The
 * refusal is the user-facing result; the diagnostics must not replace it.
 *
 * Keep this deliberately narrow. Arbitrary partial stdout from a crashed
 * process remains a failure and is never delivered as a completed reply.
 */
function formatClaudeProviderRefusal(stdout: string): string | null {
  const text = stripPtyFraming(stdout).trim();
  const match =
    /^API Error: ([^\n]+?)'s safeguards flagged this message \(https:\/\/www\.anthropic\.com\/legal\/aup\)\. This sometimes happens with safe, normal conversations\. Claude Code can't respond to this message with \1\.\n\nTry rephrasing the request in a new session or change your model\.\n\nLearn more: https:\/\/support\.claude\.com\/en\/articles\/15363606\n\nDetails: `\[([^\]\n]+)\]`\n\nRequest ID: (req_[A-Za-z0-9_-]+)$/.exec(
      text,
    );
  if (!match) return null;
  const [, model, reason, requestId] = match;
  return [
    `${model} could not respond because its safeguards rejected this request.`,
    `Reason: ${reason}`,
    `Request ID: ${requestId}`,
    "No model change or prompt replay occurred.",
  ].join("\n");
}

const CAPTURE_DEGRADED_PREFIX = "CC_LHC_CAPTURE_DEGRADED:";
const MAX_DEGRADED_DIAGNOSTIC_LENGTH = 600;

export interface RelayProcessResult {
  code: string | number | null | undefined;
  stdout: string;
  stderr: string;
}

export class RelayProcessError extends Error implements RelayProcessResult {
  readonly code: string | number | null | undefined;
  readonly stdout: string;
  readonly stderr: string;

  constructor(result: RelayProcessResult, message: string) {
    super(message);
    this.name = "RelayProcessError";
    this.code = result.code;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
  }
}

function captureDegradedLine(stderr: string): string | null {
  for (const line of stderr.split(/\r?\n/)) {
    if (line.startsWith(CAPTURE_DEGRADED_PREFIX)) return line;
  }
  return null;
}

function isDeliveredWithDegradation(
  code: string | number | null | undefined,
  stdout: string,
  stderr: string,
): boolean {
  return (
    code === 3 && stripPtyFraming(stdout).trim() !== "" && captureDegradedLine(stderr) !== null
  );
}

function recordCaptureDegradedDiagnostic(target: RelayTarget, line: string): void {
  const bounded =
    line.length > MAX_DEGRADED_DIAGNOSTIC_LENGTH
      ? `${line.slice(0, MAX_DEGRADED_DIAGNOSTIC_LENGTH)}…`
      : line;
  console.warn(
    JSON.stringify({
      event: "relay_capture_degraded",
      hostId: target.hostId,
      threadId: target.threadId,
      diagnostic: bounded,
    }),
  );
}

export function executeRelayTarget(
  target: RelayTarget,
  prompt: string,
  options: ExecuteOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? target.timeoutMs ?? 20 * 60_000;
  const env = { ...process.env, ...target.env, ...options.env };
  return new Promise((resolve, reject) => {
    const child = execFile(
      target.command,
      [...target.args, prompt],
      {
        cwd: target.cwd,
        env,
        timeout: timeoutMs,
        killSignal: "SIGTERM",
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
        signal: options.signal,
        ...(options.writerLock ? { stdio: ["pipe", "pipe", "pipe", options.writerLock.fd] } : {}),
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        if (error.killed) {
          reject(new Error(`relay process timed out after ${timeoutMs}ms`));
          return;
        }
        if (target.hostId === "cc-lhc") {
          const refusal = formatClaudeProviderRefusal(stdout);
          if (refusal !== null) {
            resolve(refusal);
            return;
          }
        }
        if (isDeliveredWithDegradation(error.code, stdout, stderr)) {
          const line = captureDegradedLine(stderr);
          if (line !== null) recordCaptureDegradedDiagnostic(target, line);
          resolve(stdout);
          return;
        }
        reject(
          new RelayProcessError(
            { code: error.code, stdout, stderr },
            stderr.trim() || relayProcessFailureMessage(error),
          ),
        );
      },
    );
    const emitter = child as unknown as EventEmitter;
    if (options.onSpawn || options.writerLock) {
      let spawned = false;
      emitter.once("spawn", () => {
        if (spawned) return;
        spawned = true;
        if (options.writerLock) {
          // Parent copy of the fd closes after inherit; the owner file stays
          // until the child exits so a Console crash cannot drop the fence.
          if (typeof child.pid === "number") attachWriterLockOwner(options.writerLock, child.pid);
          closeWriterLockFd(options.writerLock);
        }
        options.onSpawn?.();
      });
    }
    emitter.once("error", () => {
      if (options.writerLock) releaseWriterLock(options.writerLock);
    });
    // Print-mode CLIs commonly read piped stdin before starting their turn.
    // No relay payload is sent there, so close it immediately to deliver EOF.
    child.stdin?.end();
  });
}
