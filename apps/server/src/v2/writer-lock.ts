/**
 * Shared canonical-thread writer fence.
 *
 * The fence is keyed by host home + canonical LHC thread, not by target name,
 * and it is a **kernel-held lock**: a Linux abstract-namespace unix socket
 * bound by the console process.
 *
 *   - `bind(2)` on an abstract name is atomic. A second bind fails with
 *     EADDRINUSE. There is no file to read, no PID to compare, no lease to
 *     renew, and no reclaim protocol — so there is no window in which two
 *     acquirers can both believe they won.
 *   - The bound name lives exactly as long as some process holds a descriptor
 *     for that socket. Console passes the descriptor to the writer child as
 *     part of `spawn`, and the kernel duplicates it into the child's table
 *     atomically. The fence is therefore continuously held across the spawn
 *     boundary: there is no "spawned but not yet recorded" gap for a crash to
 *     land in, and no sidecar write to race.
 *   - When the last holder dies the kernel drops the name. A stale claim
 *     cannot exist, so nothing ever needs to be reclaimed, renamed or
 *     unlinked, and no successor's claim can be destroyed by a late arrival.
 *
 * The `.owner` file is **inspectable metadata only**. It is never consulted to
 * decide exclusion. It is written after the fence is held and removed before
 * the fence is dropped, and its removal is token-scoped, so it can neither
 * outlive nor precede the claim it describes.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import type { EventEmitter } from "node:events";
import { createServer, type Server } from "node:net";
import { dirname, join, resolve } from "node:path";
import { processStartTicks } from "../process-alive.ts";
import { writerResourceKey, type WriterResource } from "./identity.ts";

export { writerResourceKey };

/** Descriptor number the writer child receives the inherited fence on. */
export const WRITER_LOCK_FD = 3;

export interface HeldWriterLock {
  resourceKey: string;
  /** Abstract-socket name that IS the fence (leading NUL, not a filesystem path). */
  fenceName: string;
  /** Inspectable metadata path. Not the exclusion primitive. */
  ownerPath: string;
  token: string;
  ownerPid: number;
  ownerStartedAt: string;
  /** Open fence descriptor, inherited by writer children. */
  fd: number;
}

export interface WriterLockAttempt {
  ok: boolean;
  held: HeldWriterLock | null;
  reason?: "busy" | "unavailable";
}

/** libuv handle exposed for the inheritable descriptor; absent means unbound. */
type FenceHandle = { fd?: number } | null | undefined;

function fenceFd(server: Server): number | null {
  const fd = (server as unknown as { _handle?: FenceHandle })._handle?.fd;
  return typeof fd === "number" && fd >= 0 ? fd : null;
}

/** Fences this process currently holds, keyed by abstract-socket name. */
const heldFences = new Map<string, { server: Server; held: HeldWriterLock }>();
/** Fences pinned open by an explicit handoff record; only an explicit release frees them. */
const pinnedFences = new Set<string>();

export function writerLockDir(consoleHome: string): string {
  return join(consoleHome, "v2-locks");
}

export function writerOwnerPath(consoleHome: string, resourceKey: string): string {
  return join(writerLockDir(consoleHome), `${resourceKey}.owner`);
}

/**
 * The fence name is derived from the console home as well as the resource key
 * so two consoles rooted at different homes (and every test tempdir) cannot
 * collide in the machine-global abstract namespace.
 */
export function writerFenceName(consoleHome: string, resourceKey: string): string {
  const digest = createHash("sha256")
    .update(`${resolve(consoleHome)}\0${resourceKey}`)
    .digest("hex");
  return `\0lhc-v2-writer.${digest}`;
}

/**
 * Bind the fence, or return null when someone else already holds it.
 *
 * `listen` assigns `_handle` synchronously when the bind succeeds and leaves
 * it null when it fails (the error itself is emitted on the next tick), so the
 * exclusion decision is made before this function returns.
 */
function bindFence(fenceName: string): Server | null {
  const server = createServer();
  // A failed bind still emits asynchronously; swallow it so an EADDRINUSE
  // (someone else holds the fence) is a return value, not a crash.
  (server as unknown as EventEmitter).on("error", () => {});
  try {
    server.listen(fenceName);
  } catch {
    return null;
  }
  if (fenceFd(server) === null) {
    try {
      server.close();
    } catch {
      // never bound
    }
    return null;
  }
  server.unref();
  return server;
}

function writeOwnerMetadata(held: HeldWriterLock, writerPid: number): void {
  const ticks = processStartTicks(writerPid) ?? "";
  mkdirSync(dirname(held.ownerPath), { recursive: true });
  writeFileSync(held.ownerPath, `${writerPid}\n${held.token}\n${held.ownerStartedAt}\n${ticks}\n`, {
    mode: 0o600,
  });
}

/** Token-scoped: only ever removes metadata this claim wrote. */
function removeOwnerMetadata(held: HeldWriterLock): void {
  try {
    if (!readFileSync(held.ownerPath, "utf8").includes(held.token)) return;
  } catch {
    return;
  }
  try {
    unlinkSync(held.ownerPath);
  } catch {
    // already gone
  }
}

/**
 * Acquire the canonical writer fence. Success means this process holds a
 * kernel lock on the resource; nothing about the returned metadata is load
 * bearing for exclusion.
 */
export function tryAcquireWriterLock(
  consoleHome: string,
  resource: WriterResource,
): WriterLockAttempt {
  if (process.platform !== "linux") {
    // Fail closed: without the abstract namespace there is no hard fence, and
    // an approximation must never be presented as one.
    return { ok: false, held: null, reason: "unavailable" };
  }
  const fenceName = writerFenceName(consoleHome, resource.key);
  if (heldFences.has(fenceName)) return { ok: false, held: null, reason: "busy" };
  const server = bindFence(fenceName);
  if (!server) return { ok: false, held: null, reason: "busy" };
  const fd = fenceFd(server)!;
  const held: HeldWriterLock = {
    resourceKey: resource.key,
    fenceName,
    ownerPath: writerOwnerPath(consoleHome, resource.key),
    token: randomUUID(),
    ownerPid: process.pid,
    ownerStartedAt: new Date().toISOString(),
    fd,
  };
  heldFences.set(fenceName, { server, held });
  try {
    writeOwnerMetadata(held, process.pid);
  } catch {
    // Metadata is inspection only; losing it does not weaken the fence.
  }
  return { ok: true, held };
}

/**
 * Record which process is now the writer behind this fence. Inspection only —
 * liveness of this PID is never what excludes a second writer.
 */
export function attachWriterLockOwner(held: HeldWriterLock, pid: number): void {
  held.ownerPid = pid;
  try {
    writeOwnerMetadata(held, pid);
  } catch {
    // inspection only
  }
}

/**
 * Drop the console's copy of the fence descriptor after a child inherited it.
 * The kernel keeps the fence bound through the child's descriptor, so this is
 * a transfer, not a release: at no point is the resource unheld.
 */
export function closeWriterLockFd(held: HeldWriterLock): void {
  const entry = heldFences.get(held.fenceName);
  if (!entry) return;
  heldFences.delete(held.fenceName);
  pinnedFences.delete(held.fenceName);
  try {
    entry.server.close();
  } catch {
    // already closed
  }
}

export function releaseWriterLock(held: HeldWriterLock | null | undefined): void {
  if (!held) return;
  if (pinnedFences.has(held.fenceName)) return;
  removeOwnerMetadata(held);
  closeWriterLockFd(held);
}

/**
 * True when any process holds the fence — this console, a writer child that
 * inherited it, or a child of a console that has since died. Answered by the
 * kernel, never by reading a file or probing a PID.
 */
export function isWriterLockHeld(consoleHome: string, resourceKey: string): boolean {
  if (process.platform !== "linux") return true;
  const fenceName = writerFenceName(consoleHome, resourceKey);
  if (heldFences.has(fenceName)) return true;
  const probe = bindFence(fenceName);
  if (!probe) return true;
  try {
    probe.close();
  } catch {
    // nothing to close
  }
  return false;
}

/**
 * Pin a fence this console still holds so an ordinary release cannot drop it.
 *
 * Production handoff is unsupported in this slice: there is no wrapper process
 * to inherit the fence, so this does NOT claim the fence survives console
 * death. It only means the fence is freed by explicit release, not implicitly.
 */
export function markWriterLockHandedOff(held: HeldWriterLock): void {
  pinnedFences.add(held.fenceName);
}

export function releaseWriterLockByKey(consoleHome: string, resourceKey: string): void {
  const fenceName = writerFenceName(consoleHome, resourceKey);
  pinnedFences.delete(fenceName);
  const entry = heldFences.get(fenceName);
  if (entry) {
    removeOwnerMetadata(entry.held);
    closeWriterLockFd(entry.held);
    return;
  }
  try {
    unlinkSync(writerOwnerPath(consoleHome, resourceKey));
  } catch {
    // no metadata to clear
  }
}

export interface FencedSpawnOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  held: HeldWriterLock;
}

/**
 * Spawn a writer child that inherits the fence as `WRITER_LOCK_FD`.
 *
 * The console copy is dropped only once the child exists, so a failed spawn
 * leaves the fence with its original holder instead of releasing it into an
 * unowned gap.
 */
export function spawnFencedChild(options: FencedSpawnOptions): ChildProcess {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe", options.held.fd],
    detached: true,
  });
  if (typeof child.pid === "number") {
    attachWriterLockOwner(options.held, child.pid);
    closeWriterLockFd(options.held);
  }
  return child;
}
