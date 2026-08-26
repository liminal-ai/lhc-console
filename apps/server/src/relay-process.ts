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
 * Claude Code writes a terminal provider refusal to stdout, then exits
 * nonzero. A wrapper may also write teardown diagnostics to stderr. The
 * refusal is the user-facing result; the diagnostics must not replace it.
 *
 * Keep this deliberately narrow. Arbitrary partial stdout from a crashed
 * process remains a failure and is never delivered as a completed reply.
 */
function formatClaudeProviderRefusal(stdout: string): string | null {
  const text = stdout.trim();
  const match =
    /^API Error: ([^\r\n]+?)'s safeguards flagged this message \(https:\/\/www\.anthropic\.com\/legal\/aup\)\. This sometimes happens with safe, normal conversations\. Claude Code can't respond to this message with \1\.\r?\n\r?\nTry rephrasing the request in a new session or change your model\.\r?\n\r?\nLearn more: https:\/\/support\.claude\.com\/en\/articles\/15363606\r?\n\r?\nDetails: `\[([^\]\r\n]+)\]`\r?\n\r?\nRequest ID: (req_[A-Za-z0-9_-]+)$/.exec(
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
        reject(new Error(stderr.trim() || error.message));
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
