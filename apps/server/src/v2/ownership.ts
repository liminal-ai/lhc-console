import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describeHost } from "@lhc-console/core";
import { isV2Enabled, v2DbPath } from "./config.ts";
import type { WriterResource } from "./identity.ts";
import { tryAcquireWriterLock, type HeldWriterLock } from "./writer-lock.ts";

/**
 * Best-effort inspectable check used by terminal admission.
 * Durable owner metadata is not the exclusion primitive — the kernel-held
 * canonical writer fence is. A hit here is still enough to 409 a Console
 * terminal launch, because refusing on stale bookkeeping is the safe error.
 */
export function isV2WriterHeld(
  hostId: string,
  threadId: string,
  consoleHome = process.env.LHC_CONSOLE_HOME ?? join(homedir(), ".lhc-console"),
): boolean {
  if (!isV2Enabled()) return false;
  const path = v2DbPath(consoleHome);
  if (!existsSync(path)) return false;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db
      .prepare(
        `SELECT 1 AS hit FROM v2_owner_resources
         WHERE host_id = ?
           AND (canonical_thread_id = ? OR host_thread_id = ?)
           AND owner_kind IN ('v2-runtime', 'handed_off', 'v1-job')
         LIMIT 1`,
      )
      .get(hostId, threadId, threadId) as { hit: number } | undefined;
    if (row) return true;
    const runtime = db
      .prepare(
        `SELECT 1 AS hit FROM v2_runtimes
         WHERE host_id = ?
           AND (canonical_thread_id = ? OR host_thread_id = ?)
           AND owner_kind IN ('v2-runtime', 'handed_off', 'v1-job')
         LIMIT 1`,
      )
      .get(hostId, threadId, threadId) as { hit: number } | undefined;
    return Boolean(runtime);
  } catch {
    return false;
  } finally {
    db.close();
  }
}

/**
 * Acquire the canonical owner-file fence before a Console terminal spawn.
 * Check-then-spawn is not enough: two idle launches can race past a read-only
 * busy check. Failure is fail-closed.
 */
export function acquireTerminalWriterLock(
  hostId: string,
  threadId: string,
  consoleHome = process.env.LHC_CONSOLE_HOME ?? join(homedir(), ".lhc-console"),
): HeldWriterLock | "blocked" | "unresolved" | null {
  if (!isV2Enabled()) return null;
  if (
    !isV2ResourceOptedIn(hostId, threadId, consoleHome) &&
    !isV2WriterHeld(hostId, threadId, consoleHome)
  ) {
    return null;
  }
  if (isV2WriterHeld(hostId, threadId, consoleHome)) return "blocked";
  const resolved = resolveTerminalWriterResource(hostId, threadId, consoleHome);
  if (!resolved) return "unresolved";
  // Acquisition is atomic, so it is also the check: a separate probe would
  // hold the fence for an instant and could bounce a legitimate acquirer.
  const attempt = tryAcquireWriterLock(consoleHome, resolved);
  if (!attempt.ok || !attempt.held) return attempt.reason === "busy" ? "blocked" : "unresolved";
  return attempt.held;
}

function resolveTerminalWriterResource(
  hostId: string,
  threadId: string,
  consoleHome: string,
): WriterResource | null {
  const host = describeHost(hostId);
  if (!host.home) return null;
  const path = v2DbPath(consoleHome);
  if (existsSync(path)) {
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      const row = db
        .prepare(
          `SELECT canonical_thread_id, writer_resource_key FROM v2_runtimes
           WHERE host_id = ?
             AND (canonical_thread_id = ? OR host_thread_id = ?)
           LIMIT 1`,
        )
        .get(hostId, threadId, threadId) as
        | { canonical_thread_id: string; writer_resource_key: string }
        | undefined;
      if (row) {
        return {
          key: row.writer_resource_key,
          hostId,
          hostHome: host.home,
          hostThreadId: threadId,
          canonicalThreadId: row.canonical_thread_id,
        };
      }
    } catch {
      // fall through to default
    } finally {
      db?.close();
    }
  }
  // No DB record → cannot confirm threadId is canonical. Fail closed to
  // prevent alias thread IDs from producing wrong resource keys.
  return null;
}

function isV2ResourceOptedIn(hostId: string, threadId: string, consoleHome: string): boolean {
  const path = v2DbPath(consoleHome);
  if (!existsSync(path)) return false;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db
      .prepare(
        `SELECT 1 AS hit FROM v2_runtimes
         WHERE host_id = ?
           AND (canonical_thread_id = ? OR host_thread_id = ?)
         LIMIT 1`,
      )
      .get(hostId, threadId, threadId) as { hit: number } | undefined;
    return Boolean(row);
  } catch {
    return false;
  } finally {
    db.close();
  }
}
