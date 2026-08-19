import { existsSync } from "node:fs";
import { join } from "node:path";
import { describeHost, listTurns, resolveThread } from "@lhc-console/core";

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
      return summarize(turns, input);
    }
    return summarize(listTurns(thread.filePath), input);
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
  };
  // A closed newest row is not a correlated span. Console has no write-side
  // native-id index in the host store; unique correlation is a real-seat
  // proof obligation. This reader therefore never claims closure.
  return {
    closed: false,
    span: {
      ...span,
      reason: turns.length === 0 ? "empty_uncorrelated" : "correlation_not_proved",
      allRowsClosed: open.length === 0,
    },
  };
}
