import { execFile } from "node:child_process";
import type { RelayTarget } from "./relay.ts";

interface ExecuteOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function executeRelayTarget(
  target: RelayTarget,
  prompt: string,
  options: ExecuteOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 20 * 60_000;
  return new Promise((resolve, reject) => {
    execFile(
      target.command,
      [...target.args, prompt],
      {
        cwd: target.cwd,
        env: target.env ?? process.env,
        timeout: timeoutMs,
        killSignal: "SIGTERM",
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
        signal: options.signal,
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
  });
}
