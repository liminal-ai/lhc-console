import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  describeHost,
  launchRecipe,
  listTurns,
  resolveThread,
  type ThreadSummary,
} from "@lhc-console/core";

/**
 * Read-only inspection of a host LHC store. Console never writes canonical
 * turns; this only reports whether the observed span is closed.
 */
export async function inspectCanonicalSpan(input: {
  hostId: string;
  canonicalThreadId: string;
  commandId?: string | null;
  nativeTurnId?: string | null;
}): Promise<{ closed: boolean; span?: Record<string, unknown> }> {
  const host = describeHost(input.hostId);
  try {
    const thread = resolveThread(host, input.canonicalThreadId);
    if (!thread?.filePath || !existsSync(thread.filePath)) {
      const fallback = join(host.threadsDir, `${input.canonicalThreadId}.sqlite`);
      if (!existsSync(fallback)) return { closed: false, span: { reason: "thread_file_missing" } };
      const turns = listTurns(fallback);
      // A bare file with no live registry row behind it: the span is real but
      // there is no thread record to derive a session identity from, so the
      // span carries none and identity proofs fail closed.
      return summarize(turns, input, null);
    }
    return summarize(listTurns(thread.filePath), input, thread);
  } catch (error) {
    return {
      closed: false,
      span: {
        reason: "inspect_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function summarize(
  turns: Array<{ turnId: string; status: string; turnOrder: number }>,
  input: {
    commandId?: string | null;
    nativeTurnId?: string | null;
  },
  thread: ThreadSummary | null,
): {
  closed: boolean;
  span?: Record<string, unknown>;
} {
  const open = turns.filter((turn) => turn.status !== "closed");
  const span = {
    fromTurnId: turns[0]?.turnId ?? null,
    toTurnId: turns[turns.length - 1]?.turnId ?? null,
    openCount: open.length,
    turnCount: turns.length,
    commandId: input.commandId ?? null,
    nativeTurnId: input.nativeTurnId ?? null,
    ...threadIdentity(thread),
  };
  // A closed newest row is not a correlated span. Console has no write-side
  // native-id index in the host store; unique correlation is a real-seat
  // proof obligation. This reader therefore never claims closure. Thread
  // identity above is a separate question and is answered where the host
  // itself answers it.
  return {
    closed: false,
    span: {
      ...span,
      reason: turns.length === 0 ? "empty_uncorrelated" : "correlation_not_proved",
      allRowsClosed: open.length === 0,
    },
  };
}

/**
 * Which native session this canonical thread resumes as, taken from the host's
 * own resume recipe — the same `sessionRef` the host would resume by, so it is
 * host evidence rather than a Console guess. Consumers (the runtime manager's
 * canonical-session proof) accept only `nativeThreadRef` as identity, so
 * omitting a field must mean "unproven", never "not looked up": fields are
 * absent only when no thread record backs the file, or when the host has no
 * resume reference at all (a cc-lhc `--continue` fallback has none).
 */
function threadIdentity(thread: ThreadSummary | null): Record<string, unknown> {
  if (!thread) return {};
  let sessionRef: string | null = null;
  try {
    sessionRef = launchRecipe(thread)?.sessionRef ?? null;
  } catch {
    // Recipe resolution reads host lineage/rollout state. Losing it costs the
    // identity fields, not the span.
    sessionRef = null;
  }
  return {
    hostThreadId: thread.threadId,
    ...(sessionRef ? { nativeThreadRef: sessionRef } : {}),
  };
}
