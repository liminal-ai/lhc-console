import type { ChildProcess } from "node:child_process";
import type { EventEmitter } from "node:events";

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

/**
 * The exit-event surface adapters are allowed to touch on a child process.
 *
 * The configured TypeScript surface for `ChildProcess` does not expose its
 * EventEmitter methods (`once`/`off`/`listenerCount`), so calling them on the
 * `ChildProcess` type directly fails `vp check`. Every exit-event listen goes
 * through this one seam; the cast lives here and nowhere else.
 */
export type ChildExitEvents = Pick<EventEmitter, "once" | "off" | "listenerCount">;

export function childExitEvents(child: ChildProcess): ChildExitEvents {
  return child as unknown as ChildExitEvents;
}

/**
 * A stop that ran out its final SIGKILL bound without ever observing the
 * child's "exit". The child may still be alive, so the adapter retains its
 * child/transport state and never emits `exited`; callers must treat the
 * runtime as unproven rather than stopped.
 */
export class StopUnprovenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StopUnprovenError";
  }
}

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
  const events = childExitEvents(child);
  return new Promise((resolve) => {
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timer);
      resolve({ exited: true, code, signal });
    };
    const timer = setTimeout(() => {
      events.off("exit", onExit);
      resolve({ exited: false, code: child.exitCode, signal: child.signalCode });
    }, timeoutMs);
    events.once("exit", onExit);
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
