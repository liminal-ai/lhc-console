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
