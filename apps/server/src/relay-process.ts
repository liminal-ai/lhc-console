import { execFile } from "node:child_process";
import type { EventEmitter } from "node:events";
import type { RelayTarget } from "./relay.ts";

interface ExecuteOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  onSpawn?: () => void;
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
    if (options.onSpawn) {
      let spawned = false;
      (child as unknown as EventEmitter).once("spawn", () => {
        if (spawned) return;
        spawned = true;
        options.onSpawn?.();
      });
    }
    // Print-mode CLIs commonly read piped stdin before starting their turn.
    // No relay payload is sent there, so close it immediately to deliver EOF.
    child.stdin?.end();
  });
}
