import type { ChildProcess } from "node:child_process";

/**
 * How long a graceful stop (drain/interrupt → EOF + SIGTERM) waits for the
 * child to exit before escalating. RuntimeManager serializes commands per
 * target, so an unbounded wait here wedges every later command for that
 * target — the bound exists to keep stop() a terminating operation.
 */
export const GRACEFUL_STOP_TIMEOUT_MS = 5_000;
/**
 * How long the post-SIGKILL settlement waits for the "exit" event. SIGKILL is
 * not interceptable, but a child stuck in uninterruptible kernel sleep can
 * still refuse to die; stop() must resolve anyway with truthful evidence.
 */
export const KILL_SETTLE_TIMEOUT_MS = 2_000;

export interface BoundedExit {
  /** True when the child actually emitted "exit" (or had already exited). */
  exited: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Wait for the child's "exit" event, but never longer than `timeoutMs`. On
 * timeout the temporary listener is removed and the child's current (still
 * truthful, usually null) exitCode/signalCode are reported — evidence is
 * never invented for an exit that did not happen.
 */
export function waitExitBounded(child: ChildProcess, timeoutMs: number): Promise<BoundedExit> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ exited: true, code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timer);
      resolve({ exited: true, code, signal });
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve({ exited: false, code: child.exitCode, signal: child.signalCode });
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

/** SIGKILL the child's process group, falling back to the child alone. */
export function killHard(child: ChildProcess): void {
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
  } catch {
    // process-group kill is best-effort; the direct kill below still runs
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // a dead or unkillable child must not turn stop() into a throw
  }
}
