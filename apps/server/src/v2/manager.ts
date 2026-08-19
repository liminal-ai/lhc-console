import { EventEmitter } from "node:events";
import { processIsAlive } from "../process-alive.ts";
import type { AttachInfo } from "../attach-detect.ts";
import type { AgentRecord } from "../agent-registry.ts";
import { PROVIDER_CAPABILITIES, ProviderUnavailableError } from "./adapter.ts";
import type { ProviderAdapter, ProviderNotification, SteerConsumptionEvidence } from "./adapter.ts";
import {
  isCommandId,
  isTerminalReceipt,
  isV2CommandKind,
  mintTurnId,
  type V2CommandKind,
  type V2Event,
  type V2Receipt,
  type V2RejectReason,
  type V2StopMode,
  type V2TargetStatus,
  type V2TurnCause,
  type V2TurnOutcome,
} from "./contract.ts";
import {
  resolveThreadIdentity,
  resolveWriterResource,
  requireV2Provider,
  WriterIdentityUnresolvedError,
  type WriterResource,
} from "./identity.ts";
import type { ResolvedV2OwnerPolicies } from "./policies.ts";
import { UnsettledOwnerPolicyError } from "./policies.ts";
import { nowIso, V2Store, type V2CommandRow, type V2RuntimeRow } from "./store.ts";
import {
  attachWriterLockOwner,
  closeWriterLockFd,
  isWriterLockHeld,
  markWriterLockHandedOff,
  releaseWriterLock,
  tryAcquireWriterLock,
  type HeldWriterLock,
} from "./writer-lock.ts";

export interface V2BusyProbe {
  (target: { hostId: string; threadId: string; recipeCommand?: string | null }): AttachInfo;
}

export interface V2V1RunningProbe {
  (resourceKey: string): boolean;
}

export interface V2DeliveryBridge {
  (input: {
    target: string;
    commandId: string;
    text: string;
    turnId: string;
  }): Promise<"delivered" | "failed">;
}

export interface V2CanonicalInspector {
  (input: {
    hostId: string;
    canonicalThreadId: string;
    commandId?: string | null;
    nativeTurnId?: string | null;
  }): Promise<{ closed: boolean; span?: Record<string, unknown> }>;
}

export interface AdapterFactory {
  (provider: "codex-lhc" | "pi-lhc", target: string): ProviderAdapter;
}

export interface RuntimeManagerOptions {
  store: V2Store;
  consoleHome: string;
  agents: AgentRecord[];
  policies: ResolvedV2OwnerPolicies;
  adapterFactory: AdapterFactory;
  detectBusy?: V2BusyProbe;
  v1Running?: V2V1RunningProbe;
  ownTerminals?: () => Array<{ hostId: string; threadId: string; pid: number }>;
  deliver?: V2DeliveryBridge;
  inspectCanonical?: V2CanonicalInspector;
}

interface LiveRuntime {
  adapter: ProviderAdapter;
  unsubscribe: () => void;
  heldLock: HeldWriterLock | null;
  queue: Promise<void>;
}

const INDETERMINATE_MESSAGE =
  "console lost track of this command after restart; the turn may have completed — check the durable thread";

export class RuntimeManager {
  readonly #store: V2Store;
  readonly #consoleHome: string;
  readonly #agents: Map<string, AgentRecord>;
  readonly #policies: ResolvedV2OwnerPolicies;
  readonly #adapterFactory: AdapterFactory;
  readonly #detectBusy: V2BusyProbe | undefined;
  readonly #v1Running: V2V1RunningProbe | undefined;
  readonly #ownTerminals: () => Array<{ hostId: string; threadId: string; pid: number }>;
  readonly #deliver: V2DeliveryBridge | undefined;
  readonly #inspectCanonical: V2CanonicalInspector | undefined;
  readonly #live = new Map<string, LiveRuntime>();
  /** Targets with a startup dispatch pass in flight; keeps passes from interleaving. */
  readonly #dispatching = new Set<string>();
  readonly #events = new EventEmitter();

  constructor(options: RuntimeManagerOptions) {
    this.#store = options.store;
    this.#consoleHome = options.consoleHome;
    this.#agents = new Map(options.agents.map((agent) => [agent.id, agent]));
    this.#policies = options.policies;
    this.#adapterFactory = options.adapterFactory;
    this.#detectBusy = options.detectBusy;
    this.#v1Running = options.v1Running;
    this.#ownTerminals = options.ownTerminals ?? (() => []);
    this.#deliver = options.deliver;
    this.#inspectCanonical = options.inspectCanonical;
    for (const agent of options.agents) {
      if (!agent.v2) continue;
      this.#ensureRuntimeRow(agent);
    }
  }

  onEvent(listener: (event: V2Event) => void): () => void {
    this.#events.on("event", listener);
    return () => this.#events.off("event", listener);
  }

  getAgent(target: string): AgentRecord | undefined {
    return this.#agents.get(target);
  }

  optedInTargets(): string[] {
    return [...this.#agents.values()].filter((agent) => agent.v2).map((agent) => agent.id);
  }

  status(target: string): V2TargetStatus {
    const agent = this.#requireOptedIn(target);
    const runtime = this.#ensureRuntimeRow(agent);
    const followUps = this.#store.listFollowUps(target).map((row) => ({
      commandId: row.commandId,
      afterTurnId: row.afterTurnId,
      queuedAt: row.queuedAt,
    }));
    const pendingCommands = this.#store.listPendingCommands(target).map((row) => ({
      commandId: row.commandId,
      kind: row.kind,
      receipt: row.receipt,
    }));
    const external = this.#externalWriters(agent);
    // The kernel fence is the only thing that can answer this. An owner row
    // is inspectable bookkeeping and may outlive the claim it describes, so
    // it must never be able to report a fence nobody holds.
    const fenceHeld = isWriterLockHeld(this.#consoleHome, runtime.writerResourceKey);
    return {
      target,
      provider: requireV2Provider(runtime.provider),
      capabilities: { steerConsumption: this.#steerConsumptionEvidence(target) },
      state: runtime.state,
      runtime: {
        pid: runtime.ownerPid,
        startedAt: runtime.startedAt,
        generation: runtime.generation,
        leaseExpiresAt: runtime.leaseExpiresAt,
      },
      thread: {
        hostId: runtime.hostId,
        hostThreadId: runtime.hostThreadId,
        canonicalThreadId: runtime.canonicalThreadId,
        nativeThreadRef: runtime.nativeThreadRef,
      },
      currentTurn: runtime.currentTurnId
        ? {
            turnId: runtime.currentTurnId,
            nativeTurnId: runtime.currentNativeTurnId,
            startedAt: runtime.currentTurnStartedAt ?? runtime.updatedAt,
            cause: (runtime.currentTurnCause as V2TurnCause | null) ?? "turn.start",
            commandId: runtime.currentTurnCommandId ?? "",
          }
        : null,
      followUps,
      pendingCommands,
      lastEventSeq: this.#store.lastEventSeq(target),
      writers: {
        policy: "single",
        managedFenceHeld: fenceHeld,
        external: external.map((item) => ({
          pid: item.pid,
          args: item.args,
          source: item.source,
        })),
        console: {
          kind:
            runtime.ownerKind === "v2-runtime"
              ? "v2-runtime"
              : runtime.ownerKind === "v1-job"
                ? "v1-job"
                : runtime.ownerKind === "handed_off"
                  ? "handed_off"
                  : "none",
          pid: runtime.ownerPid,
        },
      },
      lastReconcile: { at: runtime.lastReconcileAt, result: runtime.lastReconcileResult },
    };
  }

  eventsAfter(target: string, after: number, limit?: number): V2Event[] {
    this.#requireOptedIn(target);
    return this.#store.listEventsAfter(target, after, limit);
  }

  minEventSeq(target: string): number | null {
    return this.#store.minEventSeq(target);
  }

  lastEventSeq(target: string): number {
    return this.#store.lastEventSeq(target);
  }

  getCommand(commandId: string): V2CommandRow | null {
    return this.#store.getCommand(commandId);
  }

  async submit(input: {
    target: string;
    commandId: unknown;
    kind: unknown;
    params?: unknown;
  }): Promise<V2Receipt> {
    if (!isCommandId(input.commandId)) {
      return this.#ephemeralReject(
        input.target,
        "command.cancel",
        "unknown_command",
        "commandId is required",
      );
    }
    if (!isV2CommandKind(input.kind)) {
      return this.#ephemeralReject(
        input.target,
        "command.cancel",
        "unsupported",
        "unknown command kind",
      );
    }
    const existing = this.#store.getCommand(input.commandId);
    if (existing) return this.#receiptFromRow(existing);
    const agent = this.#requireOptedIn(input.target);
    const params = asObject(input.params);
    const accepted = this.#accept(agent, input.commandId, input.kind, params);
    if (accepted.state !== "accepted") return accepted;
    const commandId = String(input.commandId);
    const kind = input.kind;
    return await this.#enqueue(agent.id, () => this.#apply(agent, commandId, kind, params));
  }

  async wait(commandId: string, timeoutMs = 10 * 60_000): Promise<V2Receipt | null> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const row = this.#store.getCommand(commandId);
      if (row && isTerminalReceipt(row.receipt)) return this.#receiptFromRow(row);
      await sleep(20);
    }
    const row = this.#store.getCommand(commandId);
    return row ? this.#receiptFromRow(row) : null;
  }

  /**
   * The console boot / reconciliation entry point.
   *
   * Reconciliation classifies every durable command by dispatch state, and the
   * commands it proves were never sent are dispatched here in the same pass.
   * Dispatch lives on this path rather than in a helper a caller may forget,
   * so a boot cannot leave a durably accepted command stranded forever.
   *
   * Every target is reconciled before anything is dispatched: dispatch decides
   * against post-reconcile state, never against a half-reconciled snapshot.
   */
  async reconcileAll(): Promise<void> {
    for (const agent of this.#agents.values()) {
      if (agent.v2) this.reconcile(agent.id);
    }
    for (const agent of this.#agents.values()) {
      if (agent.v2) await this.dispatchUnsent(agent.id);
    }
  }

  reconcile(target: string): void {
    const agent = this.#requireOptedIn(target);
    const runtime = this.#ensureRuntimeRow(agent);
    const lockHeld = isWriterLockHeld(this.#consoleHome, runtime.writerResourceKey);
    const ownerAlive = runtime.ownerPid !== null && processIsAlive(runtime.ownerPid);
    const at = nowIso();
    // Unconditional: a console can die with a command mid-dispatch while its
    // runtime row still reads clean. Settling the dispatch boundary before any
    // early return keeps such a command from staying falsely retryable.
    this.#settleDispatchBoundary(target);
    if (runtime.ownerKind === "handed_off") {
      this.#patchRuntime(target, {
        lastReconcileAt: at,
        lastReconcileResult: runtime.terminalId ? "handed_off" : "release_proposed",
      });
      return;
    }
    if (runtime.state === "stopped" && runtime.ownerKind === "none" && !lockHeld) {
      this.#patchRuntime(target, { lastReconcileAt: at, lastReconcileResult: "clean" });
      return;
    }
    this.#patchRuntimeAndEmit(
      target,
      { state: "unknown", lastReconcileAt: at, lastReconcileResult: "reconciling" },
      { kind: "runtime.state", data: { state: "unknown", reason: "console_restart" } },
    );
    const writerSurvives = Boolean(this.#live.get(target)) || ownerAlive || lockHeld;
    if (writerSurvives) {
      this.#patchRuntime(target, {
        state: "unknown",
        lastReconcileAt: at,
        lastReconcileResult: lockHeld
          ? "writer_lock_held"
          : ownerAlive
            ? "owner_alive"
            : "live_writer",
      });
      return;
    }
    if (runtime.currentTurnId) {
      this.#completeTurn(
        target,
        runtime.currentTurnId,
        "indeterminate",
        undefined,
        runtime.currentTurnCommandId,
      );
    }
    // Terminal transition: owner record, runtime state and the event a client
    // reads it from all land together or not at all.
    const stopped = this.#store.transaction(() => {
      this.#clearOwnerResource(runtime, "none");
      this.#patchRuntime(target, {
        state: "stopped",
        ownerKind: "none",
        ownerPid: null,
        ownerToken: null,
        lastReconcileAt: at,
        lastReconcileResult: "stopped",
      });
      return this.#store.appendEvent({
        target,
        kind: "runtime.state",
        data: { state: "stopped", reason: "reconciled" },
      });
    });
    this.#events.emit("event", stopped);
  }

  /**
   * Classify durable commands against the dispatch boundary.
   *
   * `not_sent` is proven undispatched and stays accepted for the startup
   * dispatch pass. `sending` crossed the boundary with no correlated
   * acknowledgement, so it becomes `indeterminate` — never replayed, never
   * claimed applied. `acknowledged` is already terminal and untouched.
   */
  #settleDispatchBoundary(target: string): void {
    for (const command of this.#store.listCommands(target)) {
      if (command.receipt !== "accepted") continue;
      if (command.dispatchState !== "sending") continue;
      this.#updateCommandAndEmit(
        target,
        command.commandId,
        { receipt: "indeterminate", message: INDETERMINATE_MESSAGE },
        {
          kind: "command.receipt",
          commandId: command.commandId,
          turnId: command.turnId,
          data: { state: "indeterminate", reason: "dispatch_boundary" },
        },
      );
    }
  }

  /**
   * Dispatch the commands reconciliation proved were never sent, in this
   * target's acceptance order.
   *
   * Only `accepted` + `not_sent` rows are eligible. A `sending` row already
   * crossed the durable dispatch boundary, so replaying it could duplicate a
   * provider effect it cannot observe; reconcile settles those as
   * `indeterminate` and this pass leaves them alone.
   *
   * Idempotence comes from the rows themselves: applying one moves it off
   * `not_sent`, and each row is re-read immediately before dispatch because an
   * earlier command in the same pass may have settled it. The re-entrancy
   * guard keeps a concurrent caller from interleaving a second pass.
   *
   * Dispatching a pending `runtime.start` is not an auto-restart: it is a
   * command a client issued and never got an answer to. Reconciliation still
   * refuses to resurrect a runtime on its own.
   */
  async dispatchUnsent(target: string): Promise<void> {
    const agent = this.#requireOptedIn(target);
    if (this.#dispatching.has(target)) return;
    this.#dispatching.add(target);
    try {
      for (const row of this.#store.listPendingCommands(target)) {
        const fresh = this.#store.getCommand(row.commandId);
        if (!fresh || fresh.receipt !== "accepted" || fresh.dispatchState !== "not_sent") continue;
        const params = JSON.parse(fresh.paramsJson) as Record<string, unknown>;
        await this.#enqueue(agent.id, () =>
          this.#apply(agent, fresh.commandId, fresh.kind, params),
        );
      }
    } finally {
      this.#dispatching.delete(target);
    }
  }

  writerResourceFor(target: string): WriterResource | null {
    const agent = this.#agents.get(target);
    if (!agent?.v2) return null;
    try {
      return resolveWriterResource(agent);
    } catch {
      return null;
    }
  }

  isResourceOptedIn(resourceKey: string): boolean {
    return (
      this.#store.listTargetsForResource(resourceKey).length > 0 ||
      [...this.#agents.values()].some((agent) => {
        if (!agent.v2) return false;
        try {
          return resolveWriterResource(agent).key === resourceKey;
        } catch {
          return false;
        }
      })
    );
  }

  ownsResource(resourceKey: string): boolean {
    const owner = this.#store.getOwnerResource(resourceKey);
    return Boolean(owner && owner.ownerKind !== "none");
  }

  staleV1Owner(resourceKey: string): boolean {
    const owner = this.#store.getOwnerResource(resourceKey);
    if (!owner || owner.ownerKind !== "v1-job") return false;
    return owner.ownerPid === null || !processIsAlive(owner.ownerPid);
  }

  noteManagedOwner(
    resource: WriterResource,
    ownerKind: "v1-job" | "v2-runtime" | "handed_off",
    ownerPid: number | null = null,
  ): void {
    this.#store.upsertOwnerResource({
      writerResourceKey: resource.key,
      hostId: resource.hostId,
      hostThreadId: resource.hostThreadId,
      canonicalThreadId: resource.canonicalThreadId,
      ownerKind,
      ownerPid,
    });
  }

  clearManagedOwner(resourceKey: string): void {
    const owner = this.#store.getOwnerResource(resourceKey);
    if (!owner || owner.ownerKind !== "v1-job") return;
    this.#store.upsertOwnerResource({
      writerResourceKey: owner.writerResourceKey,
      hostId: owner.hostId,
      hostThreadId: owner.hostThreadId,
      canonicalThreadId: owner.canonicalThreadId,
      ownerKind: "none",
    });
  }

  close(): void {
    for (const [target, live] of this.#live) {
      const runtime = this.#store.getRuntime(target);
      if (runtime?.ownerKind === "handed_off") {
        if (live.heldLock) markWriterLockHandedOff(live.heldLock);
        live.unsubscribe();
        continue;
      }
      // Stop the console-owned child so close cannot orphan a writer.
      void live.adapter.stop("kill").catch(() => undefined);
      live.unsubscribe();
      if (live.heldLock) closeWriterLockFd(live.heldLock);
    }
    this.#live.clear();
    this.#store.close();
  }

  #accept(
    agent: AgentRecord,
    commandId: string,
    kind: V2CommandKind,
    params: Record<string, unknown>,
  ): V2Receipt {
    const runtime = this.#ensureRuntimeRow(agent);
    const fence = this.#fenceAtAcceptance(runtime, kind, params);
    if (fence) {
      return this.#persistReceipt(agent.id, commandId, kind, params, {
        state: "rejected",
        reason: fence.reason,
        currentTurnId: runtime.currentTurnId,
        currentState: runtime.state,
        message: fence.message,
      });
    }
    return this.#persistReceipt(agent.id, commandId, kind, params, {
      state: "accepted",
      currentTurnId: runtime.currentTurnId,
      currentState: runtime.state,
    });
  }

  async #apply(
    agent: AgentRecord,
    commandId: string,
    kind: V2CommandKind,
    params: Record<string, unknown>,
  ): Promise<V2Receipt> {
    const runtime = this.#ensureRuntimeRow(agent);
    const fence = this.#fenceAtAcceptance(runtime, kind, params);
    if (fence) {
      this.#updateCommandAndEmit(
        agent.id,
        commandId,
        {
          receipt: "rejected",
          reason: fence.reason,
          message: fence.message ?? null,
        },
        {
          kind: "command.receipt",
          commandId,
          data: { state: "rejected", reason: fence.reason },
        },
      );
      return this.#receiptFromRow(this.#store.getCommand(commandId)!);
    }
    try {
      switch (kind) {
        case "runtime.start":
          return await this.#applyRuntimeStart(agent, commandId, params);
        case "turn.start":
          return await this.#applyTurnStart(agent, commandId, params, "turn.start");
        case "turn.steer":
          return await this.#applySteer(agent, commandId, params);
        case "turn.followUp":
          return this.#applyFollowUp(agent, commandId, params);
        case "turn.interrupt":
          return await this.#applyInterrupt(agent, commandId, params);
        case "command.cancel":
          return this.#applyCancel(agent, commandId, params);
        case "runtime.stop":
          return await this.#applyRuntimeStop(agent, commandId, params);
        case "handoff.request":
          return await this.#applyHandoffRequest(agent, commandId, params);
        case "handoff.release":
          return this.#applyHandoffRelease(agent, commandId);
        default:
          return this.#rejectApplied(agent.id, commandId, "unsupported");
      }
    } catch (error) {
      const existing = this.#store.getCommand(commandId);
      if (existing?.receipt === "indeterminate") return this.#receiptFromRow(existing);
      // A command already marked `sending` crossed the durable dispatch
      // boundary. A failure after that point cannot be reported as rejected:
      // the provider may well have applied it and we cannot prove otherwise.
      if (existing?.receipt === "accepted" && existing.dispatchState === "sending") {
        return this.#indeterminateDispatched(
          agent.id,
          commandId,
          error instanceof Error ? error.message : String(error),
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      return this.#rejectApplied(agent.id, commandId, rejectionReasonFor(error), message);
    }
  }

  async #applyRuntimeStart(
    agent: AgentRecord,
    commandId: string,
    params: Record<string, unknown>,
  ): Promise<V2Receipt> {
    const resource = resolveWriterResource(agent);
    const conflict = this.#writerConflict(agent, resource);
    if (conflict) return this.#rejectApplied(agent.id, commandId, "writer_conflict", conflict);
    const acquired = tryAcquireWriterLock(this.#consoleHome, resource);
    if (!acquired.ok || !acquired.held) {
      return this.#rejectApplied(
        agent.id,
        commandId,
        acquired.reason === "unavailable" ? "provider_unavailable" : "writer_conflict",
        "canonical writer lock is held or unavailable",
      );
    }
    const processPolicy = this.#policies.policies.runtimeProcess;
    if (processPolicy === "detached") {
      releaseWriterLock(acquired.held);
      return this.#rejectApplied(
        agent.id,
        commandId,
        "unsupported",
        "Q2 detached runtime supervision is selectable but unsupported in this plane",
      );
    }
    const runtime = this.#ensureRuntimeRow(agent);
    const generation = runtime.generation + 1;
    const startingEvent = this.#store.transaction(() => {
      this.#markSending(commandId);
      this.#patchRuntime(agent.id, { state: "starting", generation });
      return this.#store.appendEvent({
        target: agent.id,
        kind: "runtime.state",
        commandId,
        data: { state: "starting", generation },
      });
    });
    this.#events.emit("event", startingEvent);
    const adapter = this.#adapterFactory(requireV2Provider(agent.relay.hostId), agent.id);
    const unsubscribe = adapter.on((event) => this.#onProviderEvent(agent.id, event));
    this.#live.set(agent.id, {
      adapter,
      unsubscribe,
      heldLock: acquired.held,
      queue: Promise.resolve(),
    });
    try {
      const native = await adapter.start({
        hostThreadId: agent.relay.threadId,
        canonicalThreadId: resource.canonicalThreadId,
        cwd: agent.v2?.cwd ?? agent.relay.cwd,
        command: agent.v2?.command,
        args: agent.v2?.args,
        env: { ...agent.relay.env, ...agent.v2?.env, LHC_AGENT_ID: agent.id },
        approvalPolicy: this.#policies.policies.codexApprovals,
        writerLock: acquired.held,
        runtimeGeneration: generation,
        proveCanonicalSession: (nativeThreadRef, canonicalThreadId) =>
          this.#proveCanonicalSession(agent, nativeThreadRef, canonicalThreadId),
      });
      const ownerPid = adapter.pid();
      if (ownerPid !== null && processIsAlive(ownerPid)) {
        attachWriterLockOwner(acquired.held, ownerPid);
      }
      const events = this.#store.transaction(() => {
        this.#patchRuntime(agent.id, {
          state: "idle",
          generation,
          ownerKind: "v2-runtime",
          ownerPid,
          ownerToken: this.#store.newOwnerToken(),
          startedAt: nowIso(),
          nativeThreadRef: native,
        });
        this.#store.upsertOwnerResource({
          writerResourceKey: resource.key,
          hostId: resource.hostId,
          hostThreadId: resource.hostThreadId,
          canonicalThreadId: resource.canonicalThreadId,
          ownerKind: "v2-runtime",
          ownerPid,
          runtimeGeneration: generation,
        });
        this.#store.updateCommand(commandId, {
          receipt: "applied",
          dispatchState: "acknowledged",
          runtimeGeneration: generation,
        });
        const e1 = this.#store.appendEvent({
          target: agent.id,
          kind: "runtime.state",
          commandId,
          data: { state: "idle" },
        });
        const e2 = this.#store.appendEvent({
          target: agent.id,
          kind: "command.receipt",
          commandId,
          data: { state: "applied" },
        });
        return [e1, e2];
      });
      for (const event of events) this.#events.emit("event", event);
      const resumeFollowUps = this.#resumeFollowUps(params);
      if (resumeFollowUps) {
        this.#store.releaseHeldFollowUps(agent.id);
        void this.#maybeStartFollowUp(agent.id, "", "completed");
      }
      return this.#receiptFromRow(this.#store.getCommand(commandId)!);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let killed = true;
      try {
        await adapter.stop("kill");
      } catch {
        killed = false;
      }
      if (killed) {
        unsubscribe();
        this.#live.delete(agent.id);
        releaseWriterLock(acquired.held);
      }
      // Only claim the start was rejected once the spawned writer is proved
      // gone. If the kill failed or the fence is still held, a writer may have
      // attached the thread, so the outcome stays indeterminate and the fence
      // stays put rather than inviting a second writer. The live entry (and
      // its event subscription) is retained on an unproven kill so that a
      // later observed child exit can still settle ownership truthfully.
      if (!killed || isWriterLockHeld(this.#consoleHome, resource.key)) {
        const unresolved = this.#store.transaction(() => {
          this.#store.updateCommand(commandId, {
            receipt: "indeterminate",
            dispatchState: "sending",
            message,
          });
          this.#patchRuntime(agent.id, { state: "unknown" });
          const e1 = this.#store.appendEvent({
            target: agent.id,
            kind: "command.receipt",
            commandId,
            data: { state: "indeterminate", reason: "writer_unproven", message },
          });
          const e2 = this.#store.appendEvent({
            target: agent.id,
            kind: "runtime.state",
            commandId,
            data: { state: "unknown", reason: "start_failed_writer_unproven" },
          });
          return [e1, e2];
        });
        for (const event of unresolved) this.#events.emit("event", event);
        return this.#receiptFromRow(this.#store.getCommand(commandId)!);
      }
      const reason = rejectionReasonFor(error);
      const stopped = this.#store.transaction(() => {
        this.#clearOwnerResource(
          {
            writerResourceKey: resource.key,
            hostId: resource.hostId,
            hostThreadId: resource.hostThreadId,
            canonicalThreadId: resource.canonicalThreadId,
          },
          "none",
        );
        this.#patchRuntime(agent.id, {
          state: "stopped",
          ownerKind: "none",
          ownerPid: null,
          ownerToken: null,
          startedAt: null,
          nativeThreadRef: null,
        });
        this.#store.updateCommand(commandId, { receipt: "rejected", reason, message });
        const e1 = this.#store.appendEvent({
          target: agent.id,
          kind: "command.receipt",
          commandId,
          data: { state: "rejected", reason },
        });
        const e2 = this.#store.appendEvent({
          target: agent.id,
          kind: "runtime.state",
          commandId,
          data: { state: "stopped", reason: "start_failed" },
        });
        return [e1, e2];
      });
      for (const event of stopped) this.#events.emit("event", event);
      return {
        ...this.#receiptFromRow(this.#store.getCommand(commandId)!),
        currentState: "stopped",
      };
    }
  }

  async #applyTurnStart(
    agent: AgentRecord,
    commandId: string,
    params: Record<string, unknown>,
    cause: V2TurnCause,
  ): Promise<V2Receipt> {
    const live = this.#live.get(agent.id);
    if (!live) return this.#rejectApplied(agent.id, commandId, "runtime_not_ready");
    const text = requiredText(params.text);
    const turnId = mintTurnId();
    // Claim `active` before dispatching so a concurrent turn.start is fenced
    // out. The claim is observable through status, so it is written with its
    // event: a status snapshot never shows a turn the log cannot explain.
    const claimed = this.#store.transaction(() => {
      this.#markSending(commandId, turnId);
      this.#patchRuntime(agent.id, {
        state: "active",
        currentTurnId: turnId,
        currentNativeTurnId: null,
        currentTurnCommandId: commandId,
        currentTurnCause: cause,
        currentTurnStartedAt: nowIso(),
      });
      return this.#store.appendEvent({
        target: agent.id,
        kind: "runtime.state",
        commandId,
        turnId,
        data: { state: "active", cause, dispatch: "pending" },
      });
    });
    this.#events.emit("event", claimed);
    let nativeTurnId: string;
    try {
      nativeTurnId = await live.adapter.startTurn(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Indeterminate command outcome and the `unknown` runtime it produces are
      // both externally visible, so both land with their events atomically.
      const failure = this.#store.transaction(() => {
        this.#store.updateCommand(commandId, {
          receipt: "indeterminate",
          dispatchState: "sending",
          message,
        });
        this.#patchRuntime(agent.id, { state: "unknown" });
        const e1 = this.#store.appendEvent({
          target: agent.id,
          kind: "command.receipt",
          commandId,
          turnId,
          data: { state: "indeterminate", reason: "dispatch_boundary", message },
        });
        const e2 = this.#store.appendEvent({
          target: agent.id,
          kind: "runtime.state",
          commandId,
          data: { state: "unknown", reason: "turn_start_error" },
        });
        return [e1, e2];
      });
      for (const event of failure) this.#events.emit("event", event);
      throw error;
    }
    const events = this.#store.transaction(() => {
      this.#store.updateCommand(commandId, {
        receipt: "applied",
        dispatchState: "acknowledged",
        nativeTurnId,
        turnId,
      });
      this.#patchRuntime(agent.id, {
        state: "active",
        currentTurnId: turnId,
        currentNativeTurnId: nativeTurnId,
        currentTurnCommandId: commandId,
        currentTurnCause: cause,
        currentTurnStartedAt: nowIso(),
      });
      const e1 = this.#store.appendEvent({
        target: agent.id,
        kind: "command.receipt",
        commandId,
        turnId,
        data: { state: "applied", nativeTurnId },
        provider: { nativeTurnId },
      });
      const e2 = this.#store.appendEvent({
        target: agent.id,
        kind: "turn.started",
        commandId,
        turnId,
        data: { cause, commandId },
        provider: { nativeTurnId },
      });
      return [e1, e2];
    });
    for (const event of events) this.#events.emit("event", event);
    return this.#receiptFromRow(this.#store.getCommand(commandId)!);
  }

  async #applySteer(
    agent: AgentRecord,
    commandId: string,
    params: Record<string, unknown>,
  ): Promise<V2Receipt> {
    const live = this.#live.get(agent.id);
    const runtime = this.#ensureRuntimeRow(agent);
    if (!live || !runtime.currentNativeTurnId || !runtime.currentTurnId) {
      return this.#rejectApplied(agent.id, commandId, "no_active_turn");
    }
    const text = requiredText(params.text);
    this.#store.updateCommand(commandId, {
      dispatchState: "sending",
      effectStage: "queued",
      turnId: runtime.currentTurnId,
      nativeTurnId: runtime.currentNativeTurnId,
    });
    let providerResponseId: string | undefined;
    const offQueued = live.adapter.on((event) => {
      if (event.type === "steerQueued" && event.nativeTurnId === runtime.currentNativeTurnId) {
        providerResponseId = event.providerResponseId;
        if (event.providerResponseId) {
          this.#store.updateCommand(commandId, { providerResponseId: event.providerResponseId });
        }
      }
    });
    let result: Awaited<ReturnType<ProviderAdapter["steer"]>>;
    try {
      result = await live.adapter.steer(runtime.currentNativeTurnId, text);
    } finally {
      offQueued();
    }
    if (result === "mismatch") {
      return this.#rejectApplied(
        agent.id,
        commandId,
        "turn_mismatch",
        undefined,
        runtime.currentTurnId,
      );
    }
    if (result === "unsupported") {
      return this.#rejectApplied(agent.id, commandId, "unsupported");
    }
    this.#updateCommandAndEmit(
      agent.id,
      commandId,
      {
        receipt: "applied",
        dispatchState: "acknowledged",
        effectStage: "queued",
        turnId: runtime.currentTurnId,
        nativeTurnId: runtime.currentNativeTurnId,
        providerResponseId: providerResponseId ?? null,
      },
      {
        kind: "command.receipt",
        commandId,
        turnId: runtime.currentTurnId,
        data: { state: "applied", effectStage: "queued" },
        provider: { nativeTurnId: runtime.currentNativeTurnId, providerResponseId },
      },
    );
    return this.#receiptFromRow(this.#store.getCommand(commandId)!);
  }

  #applyFollowUp(
    agent: AgentRecord,
    commandId: string,
    params: Record<string, unknown>,
  ): V2Receipt {
    const afterTurnId = requiredText(params.afterTurnId, "afterTurnId");
    const text = requiredText(params.text);
    const queuedAt = nowIso();
    this.#store.enqueueFollowUp({
      commandId,
      target: agent.id,
      afterTurnId,
      text,
      delivery: typeof params.delivery === "string" ? params.delivery : null,
      cancelOnInterrupt: params.cancelOnInterrupt === true ? 1 : 0,
      queuedAt,
      held: 0,
    });
    this.#updateCommandAndEmit(
      agent.id,
      commandId,
      {
        receipt: "applied",
        dispatchState: "acknowledged",
        afterTurnId,
      },
      {
        kind: "command.receipt",
        commandId,
        data: { state: "applied", queued: true, afterTurnId },
      },
    );
    return this.#receiptFromRow(this.#store.getCommand(commandId)!);
  }

  async #applyInterrupt(
    agent: AgentRecord,
    commandId: string,
    _params: Record<string, unknown>,
  ): Promise<V2Receipt> {
    const live = this.#live.get(agent.id);
    const runtime = this.#ensureRuntimeRow(agent);
    if (!live || !runtime.currentNativeTurnId || runtime.state !== "active") {
      return this.#rejectApplied(agent.id, commandId, "no_active_turn");
    }
    this.#markSending(commandId, runtime.currentTurnId);
    const expectedNative = runtime.currentNativeTurnId;
    const expectedTurn = runtime.currentTurnId;
    await live.adapter.interrupt(expectedNative);
    const settled = await this.#waitTurnIdle(agent.id, 5_000);
    const completed = this.#store
      .listEventsAfter(agent.id, 0, 10_000)
      .reverse()
      .find(
        (event) =>
          event.kind === "turn.completed" &&
          event.turnId === expectedTurn &&
          event.provider?.nativeTurnId === expectedNative,
      );
    if (!settled || !completed) {
      this.#updateCommandAndEmit(
        agent.id,
        commandId,
        {
          receipt: "indeterminate",
          dispatchState: "sending",
          turnId: expectedTurn,
          nativeTurnId: expectedNative,
          message: "interrupt dispatched; correlated completion was not observed",
        },
        {
          kind: "command.receipt",
          commandId,
          turnId: expectedTurn,
          data: { state: "indeterminate", reason: "completion_not_observed" },
        },
      );
      return this.#receiptFromRow(this.#store.getCommand(commandId)!);
    }
    this.#updateCommandAndEmit(
      agent.id,
      commandId,
      {
        receipt: "applied",
        dispatchState: "acknowledged",
        turnId: expectedTurn,
        nativeTurnId: expectedNative,
      },
      {
        kind: "command.receipt",
        commandId,
        turnId: expectedTurn,
        data: { state: "applied", outcome: completed.data.outcome },
      },
    );
    return this.#receiptFromRow(this.#store.getCommand(commandId)!);
  }

  #applyCancel(agent: AgentRecord, commandId: string, params: Record<string, unknown>): V2Receipt {
    const targetCommandId = requiredText(params.targetCommandId, "targetCommandId");
    const target = this.#store.getCommand(targetCommandId);
    if (!target || target.target !== agent.id) {
      return this.#rejectApplied(agent.id, commandId, "unknown_command");
    }
    const queuedFollowUp = this.#store.removeFollowUp(targetCommandId);
    if (queuedFollowUp || (target.receipt === "accepted" && target.dispatchState === "not_sent")) {
      if (queuedFollowUp === null) {
        this.#store.removeFollowUp(targetCommandId);
      }
      const cancelEvents = this.#store.transaction(() => {
        this.#store.updateCommand(targetCommandId, {
          receipt: "superseded",
          reason: "cancelled",
          message: queuedFollowUp
            ? "follow-up cancelled before dispatch"
            : "command cancelled before dispatch",
        });
        this.#store.updateCommand(commandId, { receipt: "applied", dispatchState: "acknowledged" });
        const e1 = this.#store.appendEvent({
          target: agent.id,
          kind: "command.receipt",
          commandId: targetCommandId,
          data: { state: "superseded", reason: "cancelled" },
        });
        const e2 = this.#store.appendEvent({
          target: agent.id,
          kind: "command.receipt",
          commandId,
          data: { state: "applied" },
        });
        return [e1, e2];
      });
      for (const event of cancelEvents) this.#events.emit("event", event);
      return this.#receiptFromRow(this.#store.getCommand(commandId)!);
    }
    const runtime = this.#ensureRuntimeRow(agent);
    const inFlight =
      target.dispatchState === "sending" ||
      (target.receipt === "applied" && runtime.currentTurnCommandId === target.commandId);
    if (inFlight) {
      return this.#rejectApplied(agent.id, commandId, "already_dispatched");
    }
    if (isTerminalReceipt(target.receipt)) {
      return this.#rejectApplied(agent.id, commandId, "already_terminal");
    }
    const cancelEvents2 = this.#store.transaction(() => {
      this.#store.updateCommand(targetCommandId, {
        receipt: "superseded",
        reason: "cancelled",
        message: "command cancelled before dispatch",
      });
      this.#store.updateCommand(commandId, { receipt: "applied", dispatchState: "acknowledged" });
      const e1 = this.#store.appendEvent({
        target: agent.id,
        kind: "command.receipt",
        commandId: targetCommandId,
        data: { state: "superseded", reason: "cancelled" },
      });
      const e2 = this.#store.appendEvent({
        target: agent.id,
        kind: "command.receipt",
        commandId,
        data: { state: "applied" },
      });
      return [e1, e2];
    });
    for (const event of cancelEvents2) this.#events.emit("event", event);
    return this.#receiptFromRow(this.#store.getCommand(commandId)!);
  }

  async #applyRuntimeStop(
    agent: AgentRecord,
    commandId: string,
    params: Record<string, unknown>,
  ): Promise<V2Receipt> {
    const mode = (params.mode as V2StopMode | undefined) ?? "drain";
    const live = this.#live.get(agent.id);
    const runtime = this.#ensureRuntimeRow(agent);
    if (!live) {
      const lockHeld = isWriterLockHeld(this.#consoleHome, runtime.writerResourceKey);
      const ownerAlive = runtime.ownerPid !== null && processIsAlive(runtime.ownerPid);
      if (lockHeld || ownerAlive) {
        this.#updateCommandAndEmit(
          agent.id,
          commandId,
          {
            receipt: "indeterminate",
            dispatchState: "sending",
            message:
              "runtime.stop after restart: writer lock is held or owner process is alive; cannot prove stopped",
          },
          {
            kind: "command.receipt",
            commandId,
            data: { state: "indeterminate", reason: "writer_alive" },
          },
        );
        return this.#receiptFromRow(this.#store.getCommand(commandId)!);
      }
      if (runtime.currentTurnId) {
        this.#completeTurn(
          agent.id,
          runtime.currentTurnId,
          "indeterminate",
          undefined,
          runtime.currentTurnCommandId,
        );
      }
      const stopEvent = this.#store.transaction(() => {
        this.#clearOwnerResource(runtime, "none");
        this.#patchRuntime(agent.id, {
          state: "stopped",
          ownerKind: "none",
          ownerPid: null,
          ownerToken: null,
          currentTurnId: null,
          currentNativeTurnId: null,
          currentTurnCommandId: null,
        });
        this.#store.updateCommand(commandId, { receipt: "applied", dispatchState: "acknowledged" });
        return this.#store.appendEvent({
          target: agent.id,
          kind: "runtime.state",
          commandId,
          data: { state: "stopped", reason: "writer_absent" },
        });
      });
      this.#events.emit("event", stopEvent);
      return this.#receiptFromRow(this.#store.getCommand(commandId)!);
    }
    if (mode === "drain") {
      this.#store.holdFollowUps(agent.id);
      if (runtime.state === "active") {
        this.#patchRuntimeAndEmit(
          agent.id,
          { state: "draining" },
          { kind: "runtime.state", commandId, data: { state: "draining" } },
        );
        await this.#waitTurnIdle(agent.id, 30_000);
      }
    }
    if (mode === "interrupt" && runtime.currentNativeTurnId) {
      await live.adapter.interrupt(runtime.currentNativeTurnId);
    }
    this.#markSending(commandId);
    let exit: { code: number | null; signal: NodeJS.Signals | null };
    try {
      exit = await live.adapter.stop(mode);
    } catch (error) {
      const errEvent = this.#store.transaction(() => {
        this.#store.updateCommand(commandId, {
          receipt: "indeterminate",
          dispatchState: "sending",
          message: error instanceof Error ? error.message : String(error),
        });
        this.#patchRuntime(agent.id, { state: "unknown" });
        this.#store.appendEvent({
          target: agent.id,
          kind: "runtime.state",
          commandId,
          data: { state: "unknown", reason: "stop_error" },
        });
        return this.#store.appendEvent({
          target: agent.id,
          kind: "command.receipt",
          commandId,
          data: {
            state: "indeterminate",
            reason: "stop_error",
            message: error instanceof Error ? error.message : String(error),
          },
        });
      });
      this.#events.emit("event", errEvent);
      return this.#receiptFromRow(this.#store.getCommand(commandId)!);
    }
    live.unsubscribe();
    releaseWriterLock(live.heldLock);
    this.#live.delete(agent.id);
    if (runtime.currentTurnId && mode === "kill") {
      this.#completeTurn(
        agent.id,
        runtime.currentTurnId,
        "indeterminate",
        undefined,
        runtime.currentTurnCommandId,
      );
    }
    const stopEvt = this.#store.transaction(() => {
      this.#patchRuntime(agent.id, {
        state: "stopped",
        ownerKind: "none",
        ownerPid: null,
        ownerToken: null,
        currentTurnId: null,
        currentNativeTurnId: null,
        currentTurnCommandId: null,
      });
      this.#clearOwnerResource(runtime, "none");
      this.#store.updateCommand(commandId, { receipt: "applied", dispatchState: "acknowledged" });
      return this.#store.appendEvent({
        target: agent.id,
        kind: "runtime.state",
        commandId,
        data: { state: "stopped", exit },
      });
    });
    this.#events.emit("event", stopEvt);
    return this.#receiptFromRow(this.#store.getCommand(commandId)!);
  }

  async #applyHandoffRequest(
    agent: AgentRecord,
    commandId: string,
    _params: Record<string, unknown>,
  ): Promise<V2Receipt> {
    return this.#rejectApplied(
      agent.id,
      commandId,
      "unsupported",
      "production handoff is not supported in this slice",
    );
  }

  #applyHandoffRelease(agent: AgentRecord, commandId: string): V2Receipt {
    return this.#rejectApplied(
      agent.id,
      commandId,
      "unsupported",
      "production handoff is not supported in this slice",
    );
  }

  /**
   * The only accepted identity evidence is the canonical store's own resume
   * reference from a successful, identity-bearing span. String equality
   * between the native session id and the canonical thread id proves nothing
   * (any host can hand back a matching-looking id), and a missing or failed
   * span rejects even when the strings match.
   */
  async #proveCanonicalSession(
    agent: AgentRecord,
    nativeThreadRef: string,
    canonicalThreadId: string,
  ): Promise<boolean> {
    if (!this.#inspectCanonical || !nativeThreadRef) return false;
    let inspected: Awaited<ReturnType<V2CanonicalInspector>>;
    try {
      inspected = await this.#inspectCanonical({
        hostId: agent.relay.hostId,
        canonicalThreadId,
      });
    } catch {
      return false;
    }
    const evidence = inspected.span ?? {};
    return (
      typeof evidence.nativeThreadRef === "string" && evidence.nativeThreadRef === nativeThreadRef
    );
  }

  #onProviderEvent(target: string, event: ProviderNotification): void {
    const runtime = this.#store.getRuntime(target);
    if (!runtime) return;
    if (event.type === "item" && runtime.currentTurnId) {
      if (!this.#nativeMatches(runtime, event.nativeTurnId)) return;
      this.#emit(target, {
        kind: "turn.item",
        turnId: runtime.currentTurnId,
        commandId: runtime.currentTurnCommandId,
        data: { ...event.item },
        provider: { nativeTurnId: event.nativeTurnId },
      });
      return;
    }
    if (event.type === "steerConsumed" && runtime.currentTurnId) {
      // Hard gate: if the provider's capability says consumption cannot be
      // proved on its wire, no notification may be promoted to `consumed`.
      if (this.#steerConsumptionEvidence(target) !== "native") return;
      if (!this.#nativeMatches(runtime, event.nativeTurnId)) return;
      if (!event.providerResponseId) return;
      const queued = this.#store
        .listCommands(target)
        .filter(
          (command) =>
            command.kind === "turn.steer" &&
            command.turnId === runtime.currentTurnId &&
            command.effectStage === "queued" &&
            command.providerResponseId === event.providerResponseId,
        )
        .sort(
          (a, b) =>
            a.acceptedAt.localeCompare(b.acceptedAt) || a.commandId.localeCompare(b.commandId),
        );
      const command = queued[0];
      if (!command) return;
      this.#updateCommandAndEmit(
        target,
        command.commandId,
        { effectStage: "consumed" },
        {
          kind: "command.effect",
          commandId: command.commandId,
          turnId: runtime.currentTurnId,
          data: { stage: "consumed", evidence: event.evidence },
        },
      );
      return;
    }
    if (event.type === "turnCompleted" && runtime.currentTurnId) {
      if (!this.#nativeMatches(runtime, event.nativeTurnId)) return;
      this.#settleSteers(target, runtime.currentTurnId, event.outcome);
      this.#completeTurn(
        target,
        runtime.currentTurnId,
        event.outcome,
        event.finalText,
        runtime.currentTurnCommandId,
      );
      void this.#maybeDeliver(target, runtime.currentTurnCommandId, event.outcome, event.finalText);
      void this.#maybeStartFollowUp(target, runtime.currentTurnId, event.outcome);
      return;
    }
    if (event.type === "exited") {
      const current = this.#store.getRuntime(target);
      if (current?.state === "stopped" || current?.state === "handed_off") return;
      if (current?.currentTurnId) {
        this.#completeTurn(
          target,
          current.currentTurnId,
          "indeterminate",
          undefined,
          current.currentTurnCommandId,
        );
      }
      const live = this.#live.get(target);
      live?.unsubscribe();
      if (current?.ownerKind !== "handed_off") releaseWriterLock(live?.heldLock);
      this.#live.delete(target);
      const exitEvent = this.#store.transaction(() => {
        if (current) this.#clearOwnerResource(current, "none");
        this.#patchRuntime(target, {
          state: "stopped",
          ownerKind: "none",
          ownerPid: null,
          currentTurnId: null,
          currentNativeTurnId: null,
        });
        return this.#store.appendEvent({
          target,
          kind: "runtime.state",
          data: {
            state: "stopped",
            reason: "provider_exit",
            exit: { code: event.code, signal: event.signal },
          },
        });
      });
      this.#events.emit("event", exitEvent);
    }
  }

  /**
   * Settle every steer still queued when the turn ends.
   *
   * When the provider can prove consumption, `not_consumed` means the steer
   * demonstrably did not enter the turn. When it cannot, the same stage is
   * carried with an explicit reason so a client never reads "unprovable" as
   * "proved dropped".
   */
  #settleSteers(target: string, turnId: string, _outcome: V2TurnOutcome): void {
    const evidence = this.#steerConsumptionEvidence(target);
    for (const command of this.#store.listCommands(target)) {
      if (command.kind !== "turn.steer" || command.turnId !== turnId) continue;
      if (command.effectStage === "consumed") continue;
      if (command.receipt !== "applied") continue;
      this.#updateCommandAndEmit(
        target,
        command.commandId,
        { effectStage: "not_consumed" },
        {
          kind: "command.effect",
          commandId: command.commandId,
          turnId,
          data: {
            stage: "not_consumed",
            ...(evidence === "native" ? {} : { reason: "consumption_evidence_unsupported" }),
          },
        },
      );
    }
  }

  /** What this target's provider can actually prove about steer consumption. */
  #steerConsumptionEvidence(target: string): SteerConsumptionEvidence {
    const live = this.#live.get(target);
    if (live) return live.adapter.capabilities.steerConsumption;
    const agent = this.#agents.get(target);
    const provider = agent?.v2 ? requireV2Provider(agent.relay.hostId) : null;
    return provider ? PROVIDER_CAPABILITIES[provider].steerConsumption : "unsupported";
  }

  #completeTurn(
    target: string,
    turnId: string,
    outcome: V2TurnOutcome,
    finalText: string | undefined,
    commandId: string | null,
  ): void {
    const current = this.#store.getRuntime(target);
    if (!current) return;
    const event = this.#store.transaction(() => {
      this.#store.upsertRuntime({
        ...current,
        state: current.state === "draining" ? "draining" : "idle",
        currentTurnId: null,
        currentNativeTurnId: null,
        currentTurnCommandId: null,
        currentTurnCause: null,
        currentTurnStartedAt: null,
        updatedAt: nowIso(),
      });
      return this.#store.appendEvent({
        target,
        kind: "turn.completed",
        turnId,
        commandId,
        data: { outcome, finalText },
        provider: { nativeTurnId: current.currentNativeTurnId },
      });
    });
    this.#events.emit("event", event);
  }

  async #maybeDeliver(
    target: string,
    commandId: string | null,
    outcome: V2TurnOutcome,
    finalText: string | undefined,
  ): Promise<void> {
    if (!commandId || !this.#deliver || !finalText) return;
    const command = this.#store.getCommand(commandId);
    if (!command) return;
    const params = JSON.parse(command.paramsJson) as Record<string, unknown>;
    if (params.delivery !== "photon") return;
    if (outcome !== "completed" && params.deliverPartial !== true) return;
    this.#store.enqueueDelivery({
      commandId,
      target,
      turnId: command.turnId,
      text: finalText,
    });
    const status = await this.#deliver({
      target,
      commandId,
      text: finalText,
      turnId: command.turnId ?? "",
    });
    this.#emit(target, {
      kind: "delivery",
      commandId,
      turnId: command.turnId,
      data: { status },
    });
  }

  async #maybeStartFollowUp(
    target: string,
    completedTurnId: string,
    outcome: V2TurnOutcome,
  ): Promise<void> {
    const agent = this.#agents.get(target);
    if (!agent) return;
    if (outcome === "interrupted") {
      for (const follow of this.#store.listFollowUps(target)) {
        if (follow.afterTurnId !== completedTurnId || follow.cancelOnInterrupt !== 1) continue;
        this.#store.removeFollowUp(follow.commandId);
        this.#updateCommandAndEmit(
          target,
          follow.commandId,
          {
            receipt: "superseded",
            reason: "cancelled",
            message: "follow-up superseded because fenced turn was interrupted",
          },
          {
            kind: "command.receipt",
            commandId: follow.commandId,
            data: { state: "superseded", reason: "cancelled" },
          },
        );
      }
      return;
    }
    if (outcome !== "completed") return;
    const runtime = this.#store.getRuntime(target);
    if (!runtime || runtime.state === "draining" || runtime.state === "handed_off") return;
    const next = this.#nextReadyFollowUp(target, completedTurnId);
    if (!next) return;
    this.#store.removeFollowUp(next.commandId);
    await this.#applyTurnStart(
      agent,
      next.commandId,
      { text: next.text, delivery: next.delivery },
      "followUp",
    );
  }

  #nextReadyFollowUp(
    target: string,
    completedTurnId: string,
  ): ReturnType<V2Store["listFollowUps"]>[number] | null {
    const completed = new Set<string>([completedTurnId]);
    for (const event of this.#store.listEventsAfter(target, 0, 10_000)) {
      if (event.kind === "turn.completed" && event.turnId) completed.add(event.turnId);
    }
    return (
      this.#store.listFollowUps(target).find((row) => {
        return row.held === 0 && completed.has(row.afterTurnId);
      }) ?? null
    );
  }

  #fenceAtAcceptance(
    runtime: V2RuntimeRow,
    kind: V2CommandKind,
    params: Record<string, unknown>,
  ): { reason: V2RejectReason; message?: string } | null {
    if (runtime.state === "handed_off" && kind !== "handoff.release") {
      return { reason: "handed_off" };
    }
    switch (kind) {
      case "runtime.start":
        if (runtime.state !== "stopped" && runtime.state !== "unknown") {
          return { reason: runtime.state === "handed_off" ? "handed_off" : "writer_conflict" };
        }
        return null;
      case "turn.start":
        if (runtime.state !== "idle") {
          return runtime.state === "active"
            ? { reason: "turn_active" }
            : { reason: "runtime_not_ready" };
        }
        return null;
      case "turn.steer":
      case "turn.interrupt": {
        const expected = typeof params.expectedTurnId === "string" ? params.expectedTurnId : "";
        if (runtime.state !== "active" || !runtime.currentTurnId)
          return { reason: "no_active_turn" };
        if (expected !== runtime.currentTurnId) return { reason: "turn_mismatch" };
        return null;
      }
      case "turn.followUp": {
        const after = typeof params.afterTurnId === "string" ? params.afterTurnId : "";
        if (!after) return { reason: "turn_mismatch" };
        const known =
          after === runtime.currentTurnId ||
          this.#store.listFollowUps(runtime.target).some((row) => row.afterTurnId === after) ||
          this.#store.listCommands(runtime.target).some((row) => row.turnId === after);
        if (!known) return { reason: "turn_mismatch" };
        return null;
      }
      case "runtime.stop":
        return runtime.state === "stopped" ? { reason: "runtime_not_ready" } : null;
      case "handoff.request":
      case "handoff.release":
        return {
          reason: "unsupported",
          message: "production handoff is not supported in this slice",
        };
      case "command.cancel":
        return null;
      default:
        return { reason: "unsupported" };
    }
  }

  #writerConflict(agent: AgentRecord, resource: WriterResource): string | null {
    const owner = this.#store.getOwnerResource(resource.key);
    if (owner && owner.ownerKind !== "none") return `writer_conflict{${owner.ownerKind}}`;
    if (this.#v1Running?.(resource.key)) return "writer_conflict{v1-job}";
    if (
      this.#ownTerminals().some(
        (t) =>
          t.hostId === agent.relay.hostId &&
          (t.threadId === resource.canonicalThreadId || t.threadId === agent.relay.threadId),
      )
    ) {
      return "writer_conflict{terminal}";
    }
    const attached = this.#externalWriters(agent);
    if (attached.length > 0) return "writer_conflict{attached}";
    if (isWriterLockHeld(this.#consoleHome, resource.key)) return "writer_conflict{lock}";
    return null;
  }

  #externalWriters(agent: AgentRecord): AttachInfo["attached"] {
    if (!this.#detectBusy) return [];
    return this.#detectBusy({
      hostId: agent.relay.hostId,
      threadId: agent.health?.threadId ?? agent.relay.threadId,
      recipeCommand: agent.relay.command,
    }).attached;
  }

  #resumeFollowUps(params: Record<string, unknown>): boolean {
    if (typeof params.resumeFollowUps === "boolean") return params.resumeFollowUps;
    return this.#policies.policies.heldFollowUpResume === "resume";
  }

  #persistReceipt(
    target: string,
    commandId: string,
    kind: V2CommandKind,
    params: Record<string, unknown>,
    receipt: Omit<V2Receipt, "commandId" | "kind" | "target">,
  ): V2Receipt {
    const now = nowIso();
    const runtime = this.#store.getRuntime(target);
    const event = this.#store.transaction(() => {
      this.#store.insertCommand({
        commandId,
        target,
        kind,
        paramsJson: JSON.stringify(params),
        receipt: receipt.state,
        reason: receipt.reason ?? null,
        dispatchState: "not_sent",
        runtimeGeneration: runtime?.generation ?? null,
        nativeTurnId: receipt.nativeTurnId ?? null,
        providerResponseId: receipt.providerResponseId ?? null,
        effectStage: receipt.effectStage ?? null,
        turnId: null,
        expectedTurnId: typeof params.expectedTurnId === "string" ? params.expectedTurnId : null,
        afterTurnId: typeof params.afterTurnId === "string" ? params.afterTurnId : null,
        message: receipt.message ?? null,
        acceptedAt: now,
        updatedAt: now,
      });
      return this.#store.appendEvent({
        target,
        kind: "command.receipt",
        commandId,
        data: { state: receipt.state, reason: receipt.reason },
      });
    });
    this.#events.emit("event", event);
    return {
      commandId,
      kind,
      target,
      ...receipt,
    };
  }

  /**
   * Settle a command that failed after it crossed the dispatch boundary. The
   * receipt and its event are written together, so no client can observe a
   * terminal outcome the event log does not explain.
   */
  #indeterminateDispatched(target: string, commandId: string, message: string): V2Receipt {
    this.#updateCommandAndEmit(
      target,
      commandId,
      { receipt: "indeterminate", dispatchState: "sending", message },
      {
        kind: "command.receipt",
        commandId,
        data: { state: "indeterminate", reason: "dispatch_boundary", message },
      },
    );
    return this.#receiptFromRow(this.#store.getCommand(commandId)!);
  }

  #rejectApplied(
    target: string,
    commandId: string,
    reason: V2RejectReason,
    message?: string,
    currentTurnId?: string | null,
  ): V2Receipt {
    this.#updateCommandAndEmit(
      target,
      commandId,
      { receipt: "rejected", reason, message: message ?? null },
      {
        kind: "command.receipt",
        commandId,
        data: { state: "rejected", reason },
      },
    );
    const runtime = this.#store.getRuntime(target);
    const row = this.#store.getCommand(commandId)!;
    return {
      ...this.#receiptFromRow(row),
      currentTurnId: currentTurnId ?? runtime?.currentTurnId ?? null,
      currentState: runtime?.state,
    };
  }

  #receiptFromRow(row: V2CommandRow): V2Receipt {
    const runtime = this.#store.getRuntime(row.target);
    return {
      commandId: row.commandId,
      kind: row.kind,
      target: row.target,
      state: row.receipt,
      reason: (row.reason as V2RejectReason | null) ?? undefined,
      currentTurnId: runtime?.currentTurnId ?? null,
      currentState: runtime?.state,
      nativeTurnId: row.nativeTurnId,
      providerResponseId: row.providerResponseId,
      effectStage: row.effectStage ?? undefined,
      message: row.message ?? undefined,
    };
  }

  #ephemeralReject(
    target: string,
    kind: V2CommandKind,
    reason: V2RejectReason,
    message: string,
  ): V2Receipt {
    return { commandId: "", kind, target, state: "rejected", reason, message };
  }

  #markSending(commandId: string, turnId?: string | null): void {
    this.#store.updateCommand(commandId, {
      dispatchState: "sending",
      ...(turnId ? { turnId } : {}),
    });
  }

  #emit(
    target: string,
    input: {
      kind: V2Event["kind"];
      turnId?: string | null;
      commandId?: string | null;
      data?: Record<string, unknown>;
      provider?: V2Event["provider"];
    },
  ): V2Event {
    const event = this.#store.transaction(() => this.#store.appendEvent({ target, ...input }));
    this.#events.emit("event", event);
    return event;
  }

  #updateCommandAndEmit(
    target: string,
    commandId: string,
    patch: Parameters<V2Store["updateCommand"]>[1],
    input: {
      kind: V2Event["kind"];
      turnId?: string | null;
      commandId?: string | null;
      data?: Record<string, unknown>;
      provider?: V2Event["provider"];
    },
  ): V2Event {
    const event = this.#store.updateCommandAndEmit(commandId, patch, { target, ...input });
    this.#events.emit("event", event);
    return event;
  }

  #nativeMatches(runtime: V2RuntimeRow, nativeTurnId: string | null | undefined): boolean {
    if (!runtime.currentNativeTurnId) return false;
    return Boolean(nativeTurnId) && nativeTurnId === runtime.currentNativeTurnId;
  }

  #clearOwnerResource(
    runtime: Pick<
      V2RuntimeRow,
      "writerResourceKey" | "hostId" | "hostThreadId" | "canonicalThreadId"
    >,
    ownerKind: "none" | "handed_off" = "none",
  ): void {
    this.#store.upsertOwnerResource({
      writerResourceKey: runtime.writerResourceKey,
      hostId: runtime.hostId,
      hostThreadId: runtime.hostThreadId,
      canonicalThreadId: runtime.canonicalThreadId,
      ownerKind,
    });
  }

  /** Runtime state and the event that reports it, in one transaction. */
  #patchRuntimeAndEmit(
    target: string,
    patch: Partial<V2RuntimeRow>,
    input: {
      kind: V2Event["kind"];
      turnId?: string | null;
      commandId?: string | null;
      data?: Record<string, unknown>;
      provider?: V2Event["provider"];
    },
  ): void {
    const current = this.#store.getRuntime(target);
    if (!current) return;
    const event = this.#store.transaction(() => {
      this.#store.upsertRuntime({ ...current, ...patch, updatedAt: nowIso() });
      return this.#store.appendEvent({ target, ...input });
    });
    this.#events.emit("event", event);
  }

  #patchRuntime(target: string, patch: Partial<V2RuntimeRow>): void {
    const current = this.#store.getRuntime(target);
    if (!current) return;
    this.#store.upsertRuntime({ ...current, ...patch, updatedAt: nowIso() });
  }

  #ensureRuntimeRow(agent: AgentRecord): V2RuntimeRow {
    const existing = this.#store.getRuntime(agent.id);
    if (existing) return existing;
    const resource = resolveWriterResource(agent);
    const identity = resolveThreadIdentity(agent);
    const row: V2RuntimeRow = {
      target: agent.id,
      provider: requireV2Provider(agent.relay.hostId),
      state: "stopped",
      generation: 0,
      ownerKind: "none",
      ownerPid: null,
      ownerToken: null,
      leaseExpiresAt: null,
      startedAt: null,
      writerResourceKey: resource.key,
      hostId: identity.hostId,
      hostThreadId: identity.hostThreadId,
      canonicalThreadId: identity.canonicalThreadId,
      nativeThreadRef: null,
      currentTurnId: null,
      currentNativeTurnId: null,
      currentTurnCommandId: null,
      currentTurnCause: null,
      currentTurnStartedAt: null,
      terminalId: null,
      lastReconcileAt: null,
      lastReconcileResult: null,
      updatedAt: nowIso(),
    };
    this.#store.upsertRuntime(row);
    this.#store.upsertOwnerResource({
      writerResourceKey: resource.key,
      hostId: resource.hostId,
      hostThreadId: resource.hostThreadId,
      canonicalThreadId: resource.canonicalThreadId,
      ownerKind: "none",
    });
    return row;
  }

  #requireOptedIn(target: string): AgentRecord {
    const agent = this.#agents.get(target);
    if (!agent) throw new Error(`unknown relay target: ${target}`);
    if (!agent.v2) throw new Error(`target is not opted into V2: ${target}`);
    return agent;
  }

  async #enqueue<T>(target: string, fn: () => Promise<T>): Promise<T> {
    const live = this.#live.get(target);
    if (!live) return await fn();
    const next = live.queue.then(fn, fn);
    live.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return await next;
  }

  async #waitTurnIdle(target: string, timeoutMs: number): Promise<boolean> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const runtime = this.#store.getRuntime(target);
      if (!runtime?.currentTurnId) return true;
      await sleep(20);
    }
    return !this.#store.getRuntime(target)?.currentTurnId;
  }
}

/**
 * Classify a failed command. Used both by the generic apply catch and by
 * `runtime.start`, which settles its own failure once it has proved the
 * spawned writer is gone.
 *
 * Classification is by error type. Sniffing the message read `provider_error`
 * failures as `provider_unavailable` whenever their text happened to contain
 * "unavailable", and missed every unavailability whose wording did not — the
 * adapters raise `ProviderUnavailableError` precisely so the reason does not
 * depend on prose.
 */
function rejectionReasonFor(error: unknown): V2RejectReason {
  if (error instanceof UnsettledOwnerPolicyError) return "policy_unset";
  if (error instanceof WriterIdentityUnresolvedError) return "writer_identity_unresolved";
  if (error instanceof ProviderUnavailableError) return "provider_unavailable";
  return "provider_error";
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requiredText(value: unknown, label = "text"): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
