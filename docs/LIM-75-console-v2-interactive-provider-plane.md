# LIM-75 — LHC Console V2 interactive-provider plane (design)

| Field        | Value                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------- |
| Issue        | LIM-75 — Design the additive LHC Console V2 interactive-provider plane                    |
| Status       | Code-ready for controlled dogfood discussion. **Production handoff remains unsupported.** |
| Written      | 2026-08-16                                                                                |
| Scope        | Console-owned interactive control of long-lived Codex-LHC and Pi-LHC runtimes             |
| Out of scope | Workflow / project automation; any change to the V1 one-shot relay                        |

How to read this document. Every normative statement is tagged with one of four
labels so reviewers can see what is decided and what is being proposed:

- **SETTLED** — owner direction; not up for debate in this design.
- **RECOMMENDED** — this document's proposal; accept, amend, or reject.
- **OPEN** — a question that needs an owner or PM answer before build.
- **DEFERRED** — real, but explicitly later.

Section 13 lists every source cited. The provider claims were subsequently
checked against the local Codex and LHC/Pi forks; §13.2 records the resulting
corrections and the remaining proof obligations.

---

## 1. Summary

The console today drives agents through a **one-shot relay**: one job = one
`execFile` of a print-mode CLI with the prompt as the last argv item, output
collected on exit (`apps/server/src/relay-process.ts:12-56`). That plane is
simple, durable, and stays exactly as it is.

**V2 adds a second, separately owned plane** in which the console holds a
long-lived provider _runtime_ per target and drives it interactively:
ordinary turns, explicit steer, explicit follow-up, stop, status, live events,
reconnect/replay, and final delivery. Production handoff to a human-facing
interactive CLI remains explicitly unsupported in this slice. Two providers
are in scope from day one — **Codex-LHC** over
the Codex app-server JSON-RPC and **Pi-LHC** over an LHC-safe
`AgentSession`/RPC surface — and they are designed and built **together,
capability by capability**, against **one canonical Console V2 contract** that
neither provider defines alone.

The document specifies: the V2 command/event/runtime plane and its
separation from V1 (§5), the canonical contract (§6), writer ownership and CLI
handoff (§7), recovery and event sequencing (§8), thin per-provider adapter
notes and a capability matrix (§9), a paired cross-provider acceptance plan
(§10), and additive migration/rollback (§11). Recommendations, open questions
and deferred work are separated in §12.

---

## 2. Owner-settled direction (SETTLED)

Verbatim intent as given for LIM-75:

1. **Preserve the simple one-shot provider unchanged.** V1 relay behaviour,
   routes, schema and CLI (`lhc-agent`) are not modified by V2.
2. **V2 is additive and separately owned.** New routes, new runtime code, new
   durable state; V1 continues to work with V2 absent or disabled.
3. **Codex-LHC and Pi-LHC are designed and built together,
   capability-by-capability**, to prevent architectural anchoring on either
   host's native model.
4. **Neither provider defines the shared contract alone.** The Console V2
   contract is provider-neutral; adapters translate to and from it.
5. **The initial design phase authorized no implementation.** The resulting
   implementation is now code-ready only for controlled dogfood discussion;
   this status does not authorize production handoff or deployment.
6. **Workflow / project automation is out of scope.**

PM requirements the design must satisfy (checked in §14):

- one canonical Console V2 contract;
- capability matrix;
- writer ownership and CLI handoff;
- recovery / event sequencing contract;
- cross-provider acceptance plan;
- thin host-specific adapter notes;
- one design story; no implementation stories.

---

## 3. Current state: the V1 one-shot plane (as built)

This section grounds the design in what exists; nothing here changes.

| Concern             | V1 behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target registry     | `~/.lhc-console/agents.json` (version 1). Each agent carries `relay: {hostId, threadId, cwd, command, args, timeoutMs?, env?}` — `apps/server/src/agent-registry.ts:187-224`. The field called `relay.threadId` is the identifier passed to the host runtime; it is **not proven to be the canonical LHC `th_…` id for every host** (the registry already has a separate `health.threadId` where that distinction matters). V2 must resolve and persist both identities before claiming ownership. `command`/`args` name the print-mode CLI. |
| Job model           | `relay_jobs` in `~/.lhc-console/relay.sqlite`; statuses `queued → blocked → running → completed/failed/cancelled` — `apps/server/src/relay.ts:9-15,168-196`. One job per target at a time (`#runTarget`, `relay.ts:578-793`); prioritized-before-deprioritized ordering; `outbound` jobs for `lee` delivery.                                                                                                                                                                                                                                 |
| Execution           | `executeRelayTarget` = `execFile(command, [...args, prompt])`, stdin closed, timeout default 20 min, output = stdout — `apps/server/src/relay-process.ts:12-56`. There is **no channel into a running turn** and no per-event stream.                                                                                                                                                                                                                                                                                                        |
| One-writer guard    | `isBusy` (`apps/server/src/index.ts:100-114`) calls `detectAttachedOne` with `includeOwnProcesses: true`; a hit anywhere in `ps` argv marks the job `blocked` and defers (`relay.ts:637-655`). Detection is argv pattern-matching per host — `apps/server/src/attach-detect.ts:163-203`, and it is documented as best-effort ("treat a miss as unknown, never as safe", `attach-detect.ts:11-15`, `docs/spec.md:462-472`). Writer policy: `single` for cc-lhc/codex-lhc, `shared` for pi-lhc/hermes — `packages/core/src/hosts.ts:14-33`.    |
| Restart uncertainty | A `running` row whose `owner_pid` is dead is failed with "relay lost track of this job after restart; the turn may have completed — check the durable thread" — `relay.ts:585-610,686-709`; README "One-shot relay" paragraph.                                                                                                                                                                                                                                                                                                               |
| Delivery            | Completed output optionally delivered to Photon with a lease/heartbeat/retry protocol — `relay.ts:857-994`, `apps/server/src/relay-delivery.ts`. Group-wake metadata advances catch-up cursors on delivery.                                                                                                                                                                                                                                                                                                                                  |
| Routes              | `POST /api/relay/targets/:target/jobs`, `GET /api/relay/jobs/:id` (bearer token) — `apps/server/src/relay-routes.ts:29-147`. Goals, monitors and Photon inbound all enqueue through the same queue (`goal.ts`, `monitor.ts:238`, `photon-connector.ts:377-388`).                                                                                                                                                                                                                                                                             |
| Interactive CLIs    | Console-owned tmux terminals (`-L lhc-console`) launch `codex-lhc resume … <sid>` / `pi-lhc --lhc-thread <id>` — `packages/core/src/launch.ts:128-201`, `apps/server/src/terminals.ts:1287-1432`. `POST /api/terminals` 409s on single-policy hosts when something is attached unless `force`.                                                                                                                                                                                                                                               |

**Why V1 cannot simply be stretched.** Steer, follow-up and stop all need a
live channel into an in-flight turn; V1 has none by construction (prompt in
argv, result on exit). Adding it inside `RelayQueue` would change the
semantics the goals, monitors and Photon paths rely on. Hence a separate
plane.

---

## 4. Terms used by the V2 contract

| Term         | Meaning                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **target**   | A registered agent key (same keys as V1, `agents.json`). A target resolves to one host runtime identity and one canonical durable LHC thread; those identifiers may differ and must be recorded separately. Multiple target keys may alias the same canonical thread, so target identity is not a writer-lock key.                                                                                      |
| **provider** | The host family driven interactively: `codex-lhc` or `pi-lhc` in this design.                                                                                                                                                                                                                                                                                                                           |
| **runtime**  | One long-lived provider process the console owns for a target (Codex app-server session, or a Pi RPC/AgentSession process). At most one runtime per target and, independently, at most one writer for the resolved canonical thread.                                                                                                                                                                    |
| **turn**     | One Console V2 operation from accepted `turn.start` through provider settlement. Console assigns an opaque `turnId` and records the provider-native id. A V2 turn is **not required to equal one canonical LHC turn row**: LHC compact continuation, provider retry, or Pi run settlement can produce a correlated contiguous span of canonical turns while the provider operation remains one V2 turn. |
| **command**  | A client request that mutates runtime state: `turn.start`, `turn.steer`, `turn.followUp`, `turn.interrupt`, `command.cancel`, `runtime.start`, `runtime.stop`, `handoff.request`, `handoff.release`.                                                                                                                                                                                                    |
| **receipt**  | The durable record of what happened to a command: `accepted`, `applied`, `rejected`, `superseded`, `indeterminate` (§6.5).                                                                                                                                                                                                                                                                              |
| **event**    | A durable, per-target, monotonically sequenced record of something that happened (§8). Receipts are events.                                                                                                                                                                                                                                                                                             |
| **cursor**   | The last event `seq` a client has consumed; used for replay on reconnect.                                                                                                                                                                                                                                                                                                                               |
| **writer**   | Any process appending to the target's durable thread: a V1 job's child, a V2 runtime, a console terminal, or an external CLI.                                                                                                                                                                                                                                                                           |
| **handoff**  | The settled transfer of writer ownership from a V2 runtime to an interactive CLI (and back).                                                                                                                                                                                                                                                                                                            |

---

## 5. Architecture: an additive plane

### 5.1 Placement (RECOMMENDED)

```
                      ┌────────────────────────────────────────────────┐
  lhc-agent (V1)      │ apps/server                                     │
  Photon / goals /  ─▶│  relay-routes ─▶ RelayQueue ─▶ execFile child   │  V1 plane (unchanged)
  monitors            │  relay.sqlite       isBusy ─▶ attach-detect     │
                      │                                    ▲            │
                      │                                    │ consults   │
                      │  v2/routes ─▶ v2/runtime-manager ──┼─▶ v2 store │  V2 plane (new)
  lhc-agent v2 /   ─▶ │        │             │             │            │
  future clients      │        │        provider adapter   │            │
                      │        │        ┌────┴─────┐       │            │
                      │        ▼        ▼          ▼       │            │
                      │  events log  codex-lhc   pi-lhc    │            │
                      │  (v2 store)  app-server  RPC/      │            │
                      │              JSON-RPC    AgentSess │            │
                      └────────────────────────────────────────────────┘
                                   │                    │
                                   ▼                    ▼
                          ~/.codex/lhc thread    ~/.pi-lhc thread   (durable, canonical)
```

- **Separate module tree.** V2 lives under a new directory (e.g.
  `apps/server/src/v2/`) with its own routes, runtime manager, event log and
  adapters. It imports V1 only for the token check and the Photon delivery
  primitive. V1 gains only the shared writer-arbitration admission seam
  described below; its public routes, job schema, ordering and delivery
  semantics do not change.
- **Separate durable state, shared arbitration.** A new file (e.g.
  `~/.lhc-console/v2.sqlite`) holds V2 runtimes, commands/receipts, events and
  cursors. Cross-plane writer arbitration cannot be a read-only check across
  two databases: `isBusy` followed by a later V1 claim has a check/claim race.
  A small shared arbitration primitive must therefore fence V1 jobs, V2
  runtimes and terminal handoff atomically. The lock is keyed by a stable
  **canonical writer resource**, not by target name: resolved host storage root
  plus canonical LHC thread identity (or a collision-resistant digest of that
  pair). This prevents two registry targets that alias one thread from becoming
  concurrent writers. The writer child/wrapper inherits and holds the locked
  file description for its whole lifetime; a Console crash must not release
  the fence while an orphan child can still write. Durable owner metadata is
  for inspection and reconciliation, not exclusion. This changes no V1 route
  or job semantics, but it is a deliberate internal V1 admission seam.
  That seam is active only for canonical writer resources opted into V2. With
  V2 disabled or no `v2` block present, V1 does not resolve or acquire this new
  fence and retains its current admission behavior exactly. Once a resource is
  opted in, all V1 launches for any alias of that resource use the fence even
  while its V2 runtime is stopped.
  Removing `v2.sqlite` loses no V1 job or thread data and must not remove the
  shared writer fence while a V2 runtime or handed-off wrapper is alive.
- **Separate routes.** `/api/v2/…` (bearer-authenticated). No V1 route
  changes shape.
- **Separate registry block.** `agents.json` gains an _optional_ `v2` object
  per agent (provider, runtime command/args, provider options). Absent → the
  target is V1-only. The V1 `relay` block stays required (SETTLED: V1
  unchanged) so every V2 target can still receive one-shot jobs when its
  runtime is stopped.
- **One writer, one owner.** The runtime manager is the only component that
  starts, stops, or talks to a runtime process. Routes never touch adapters
  directly.

### 5.2 Components (RECOMMENDED)

| Component            | Responsibility                                                                                                                                                                                                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **v2 routes**        | Validate, authenticate, translate HTTP/CLI into commands; expose status and event stream; never hold runtime state.                                                                                                                                                                                 |
| **runtime manager**  | Per-target serialized command loop; owns runtime lifecycle, shared writer fence, expected-turn fencing, receipts, console-owned follow-up queue, restart reconciliation, handoff choreography.                                                                                                      |
| **provider adapter** | Thin translation of contract commands to one provider's wire calls and of provider notifications to contract events. **Must not** hold queues, fences, or ownership; **must** report native ids and outcomes faithfully (§9).                                                                       |
| **event log**        | Append-only, per-target `seq`, durable before acknowledgement, replayable from a cursor, retention policy.                                                                                                                                                                                          |
| **delivery bridge**  | On `turn.completed`, optional Photon delivery of the final text using the same delivery primitive V1 uses (`relay-delivery.ts` behaviour: truncation to 8 000 chars, lease/retry). Recommend extracting the send-and-lease helper so both planes call one function; V1 call sites remain unchanged. |
| **client CLI**       | Additive subcommands (e.g. `lhc-agent v2 <target> …` or a sibling binary). `lhc-agent <agent> "msg"` keeps its V1 meaning.                                                                                                                                                                          |

---

## 6. The canonical Console V2 contract

This is the single contract both adapters implement. Where a provider lacks a
native primitive, the adapter _emulates_ it or reports `unsupported`; the
contract does not bend to the provider (SETTLED: neither provider defines it).

### 6.1 Runtime states

```
stopped ──runtime.start──▶ starting ──▶ idle ◀──────────────┐
   ▲                          │          │  turn.start       │ turn.completed
   │                          │          ▼                   │
   │                          │        active ───────────────┘
   │                          │          │
   │  runtime.stop /          │          │ handoff.request
   │  exit / crash            ▼          ▼
   └──────────────────── draining ──▶ handed_off ──handoff.release──▶ stopped
                                         (writer = interactive CLI)

   any state ──console restart──▶ unknown ──reconcile──▶ unknown | stopped
```

- `stopped` — no runtime process; target reachable by V1 only.
- `starting` — provider process spawned, thread not yet resumed/attached.
- `idle` — thread attached, no active turn.
- `active` — exactly one turn in flight; `currentTurnId` set.
- `draining` — no new turns; waiting for the active turn to finish or be
  interrupted (used by `runtime.stop` and `handoff.request`).
- `handed_off` — console released the writer to an interactive CLI; V2
  commands other than status/handoff.release are rejected.
- `unknown` — after console restart before reconciliation (§8.4).

`indeterminate` is a command/turn outcome, not a runtime state. Reconciliation
keeps the runtime `unknown` while a surviving writer or held lock cannot be
resolved; it reaches `stopped` only after writer absence is proved. Any
ambiguous active turn is then closed in the V2 event plane with outcome
`indeterminate` without claiming that its canonical LHC span is closed.

### 6.2 Commands

All commands: `POST /api/v2/targets/:target/commands` with a JSON body
`{ commandId, kind, ...params }`. `commandId` is a client-supplied idempotency
key (UUID). Re-posting the same `commandId` returns the existing receipt.
Responses are receipts (§6.5). Long-poll/wait is available via
`GET /api/v2/commands/:commandId?wait=terminal`; it returns when the receipt
reaches `applied`, `rejected`, `superseded`, or `indeterminate`. A waiter must
not hang merely because a command was rejected rather than applied.

| Kind              | Params                                                                   | Precondition                                                     | Applied when                                                                                                                                                                                                                                                                          | Typical rejections                                                            |
| ----------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `runtime.start`   | `{ resume?: true }` (default true: attach the registered thread)         | state `stopped`; no other writer (§7)                            | provider confirms thread attached (Codex: `thread/resume` result; Pi: session ready)                                                                                                                                                                                                  | `writer_conflict`, `handed_off`, `provider_unavailable`                       |
| `turn.start`      | `{ text, delivery?: "photon" \| null, expectedState?: "idle" }`          | state `idle`                                                     | provider acknowledges a new turn with a native id                                                                                                                                                                                                                                     | `turn_active` (use steer/followUp), `runtime_not_ready`                       |
| `turn.steer`      | `{ text, expectedTurnId }`                                               | state `active` and `currentTurnId == expectedTurnId`             | provider accepts the steer into the fenced turn (`applied{effectStage:"queued"}`). A later `command.effect{stage:"consumed"}` requires evidence that the user message entered that turn at a safe boundary; if the turn ends first, emit `command.effect{stage:"not_consumed"}`.      | `turn_mismatch{currentTurnId}`, `no_active_turn`, `unsupported`               |
| `turn.followUp`   | `{ text, afterTurnId, delivery? }`                                       | `afterTurnId` is current or queued-known                         | recorded in the console-owned follow-up queue (applied = queued); later starts as its own turn, emitting `turn.started{cause: "followUp", commandId}`                                                                                                                                 | `turn_mismatch`, `handed_off`                                                 |
| `turn.interrupt`  | `{ expectedTurnId, reason? }`                                            | state `active` and `currentTurnId == expectedTurnId`             | provider reports the turn ended with outcome `interrupted`                                                                                                                                                                                                                            | `turn_mismatch`, `no_active_turn`                                             |
| `command.cancel`  | `{ targetCommandId }`                                                    | target command has not crossed an irreversible provider boundary | unapplied command becomes `superseded{reason:"cancelled"}`; a queued follow-up is removed atomically. It never interrupts an active turn.                                                                                                                                             | `already_dispatched`, `already_terminal`, `unknown_command`                   |
| `runtime.stop`    | `{ mode: "drain" \| "interrupt" \| "kill" }`                             | state ≠ `stopped`                                                | process exited and canonical writer lock released; any active V2 turn is settled from correlated provider/LHC evidence or marked `indeterminate`; `kill` does not claim canonical closure                                                                                             | —                                                                             |
| `handoff.request` | `{ mode: "drain" \| "interrupt", launch: "terminal" \| "command-only" }` | state `idle`/`active`/`draining`                                 | provider settled, post-settle host work quiesced, capture flush and correlated canonical-span closure proved, runtime stopped, ownership transferred without an unlocked gap, and (if `terminal`) Console terminal spawned; receipt returns terminal id or the fenced wrapper command | `writer_conflict`, `terminal_limit`, `capture_not_flushed`, `span_not_closed` |
| `handoff.release` | `{}`                                                                     | state `handed_off`; no external writer detected                  | ownership record cleared; state `stopped`                                                                                                                                                                                                                                             | `writer_conflict{attached}`                                                   |

Design notes (RECOMMENDED):

- **Explicit, not implicit.** `turn.start` while `active` is **rejected**, not
  queued. Callers must say what they mean: steer (change the current turn) or
  follow-up (after it). This is the "explicit steer / explicit next" owner
  direction made concrete, and it removes the ambiguity that bit V1 goals
  ("prioritized" jobs interleaving).
- **The follow-up queue is console-owned for both providers.** Pi has a
  native follow-up primitive and Codex does not; using Pi's would give the two
  targets different ordering, cancellation and restart semantics. Owning the
  queue in the runtime manager keeps one behaviour. Pi's native follow-up may
  be reconsidered later (DEFERRED D8).
- **Idempotency by `commandId`**, mirroring V1's `INSERT OR IGNORE` on job id
  (`relay.ts:308-343`).
- **Cancel is not stop.** `command.cancel` retracts durable work that has not
  crossed its dispatch boundary. `turn.interrupt` acts on the active provider
  turn. Cancelling an interrupt request cannot claim the turn was restored.

### 6.3 Ingress syntax: API and Photon (RECOMMENDED)

The API uses the command envelope in §6.2. Photon must not infer active-turn
intent from ordinary prose. On a target's dedicated line:

- ordinary unprefixed text keeps its existing V1 one-shot meaning;
- `/v2 <text>` submits `turn.start` and is valid only when the V2 runtime is
  idle;
- `/steer <text>` fetches the current status fence and submits
  `turn.steer{expectedTurnId}`; if no active turn exists, it rejects rather
  than becoming an ordinary message;
- `/next <text>` submits `turn.followUp{afterTurnId}` against the current turn;
- `/stop` submits `turn.interrupt{expectedTurnId}`; it does not clear queued
  follow-ups;
- `/v2-status` is read-only; `/cancel <commandId>` submits `command.cancel`.

Every Photon control acknowledgement includes the command id and receipt state.
Final response delivery remains attached to the `turn.start`/`turn.followUp`
that requested it; steering from another channel does not move delivery. These
commands are additive parsing branches. Unprefixed Photon, goals and monitors
remain V1 unless a later design explicitly migrates them.

### 6.4 Status

`GET /api/v2/targets/:target/status` →

```json
{
  "target": "fable",
  "provider": "codex-lhc",
  "state": "active",
  "runtime": { "pid": 12345, "startedAt": "…", "generation": 7, "leaseExpiresAt": "…" },
  "thread": { "hostId": "codex-lhc", "threadId": "…", "nativeThreadRef": "…" },
  "currentTurn": {
    "turnId": "t_…",
    "nativeTurnId": "…",
    "startedAt": "…",
    "cause": "turn.start",
    "commandId": "…"
  },
  "followUps": [{ "commandId": "…", "afterTurnId": "t_…", "queuedAt": "…" }],
  "pendingCommands": [{ "commandId": "…", "kind": "turn.steer", "receipt": "accepted" }],
  "lastEventSeq": 4182,
  "writers": { "policy": "single", "external": [], "console": { "kind": "v2-runtime" } },
  "lastReconcile": { "at": "…", "result": "clean" }
}
```

Status is derived from the same durable state that produces events, so a
status snapshot at `lastEventSeq = N` is consistent with the event log through
`N` (acceptance A8).

### 6.5 Receipts: accepted versus applied

| Receipt         | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `accepted`      | The console has durably recorded the command and its fence check **passed at acceptance time**. Nothing has reached the provider yet. Ordering among accepted commands for one target is the order of acceptance. An accepted command that has not crossed the durable dispatch boundary is safe to retry after restart.                                                                                                 |
| `applied`       | The provider has acknowledged the effect (turn started with native id; steer queued against the fenced turn; interrupt observed as `interrupted`; follow-up queued). Carries provider evidence (`nativeTurnId`, provider response id and, for steer, `effectStage: "queued"`). A queued steer is not yet a claim that the model saw it; later `command.effect` events report consumption.                                |
| `rejected`      | Not applied and will not be. Carries a machine-readable `reason` (`turn_active`, `turn_mismatch`, `no_active_turn`, `writer_conflict`, `handed_off`, `unsupported`, `runtime_not_ready`, `provider_error`) plus current state so the client can decide the next explicit command.                                                                                                                                        |
| `superseded`    | Accepted, then made moot before application by a later event (e.g. a steer accepted while the turn completed on its own; a follow-up whose `afterTurnId` turn was interrupted **and** the caller asked `cancelOnInterrupt`).                                                                                                                                                                                             |
| `indeterminate` | The command crossed the durable dispatch boundary, but the console cannot prove whether the provider applied it (runtime died or console restarted between send and ack). Mirrors V1's "the turn may have completed — check the durable thread" (`relay.ts:602-603`). It may move to `applied` only when later provider or canonical-thread evidence uniquely correlates the effect; never on inference or timing alone. |

The client-facing rule: **neither `accepted` nor generic `applied` means the
model saw the content.** `applied` proves only the command-specific provider
boundary in §6.2: a turn acquired a native id, a steer was queued, an interrupt
was observed, or a follow-up entered Console's queue. For steer, only
`command.effect{stage:"consumed"}` proves the message entered the active run at
a safe boundary; `turn.completed` proves provider settlement, not by itself
that every steer was consumed. Internally the command row also records
`dispatch_state = not_sent | sending | acknowledged`,
`runtime_generation`, provider request id and attempt. That durable boundary is
required for honest restart recovery; it is not an additional public receipt.

### 6.6 Expected-turn fencing

Every command that mutates an in-flight turn carries the turn it thinks it is
acting on (`expectedTurnId`; `afterTurnId` for follow-ups). The runtime
manager compares against `currentTurnId` **at acceptance and again at
application**; a mismatch at either point yields `rejected: turn_mismatch`
with the actual `currentTurnId`. Rationale: a phone-side or peer-agent client
often acts on stale status; fencing turns "steered the wrong turn" from a
silent hazard into a visible rejection.

Provider mapping: Codex app-server's `turn/steer` carries an `expectedTurnId`
natively (§9.1); Pi's `steer` does not, so the Pi adapter must apply the fence
itself immediately before forwarding, and must not forward when it cannot
verify which run is in flight (§9.2). Both behaviours satisfy the same
acceptance test (A3/A4).

`turnId` values are console-minted so fencing works identically across
providers; native ids are recorded, not exposed as the fence key.

---

## 7. Runtime ownership, one writer, and CLI handoff

### 7.1 Ownership record (RECOMMENDED)

The V2 store holds inspectable owner metadata for each canonical writer
resource and records every target currently mapped to it: `owner_kind` (`none`
| `v1-job` | `v2-runtime` | `handed_off`), `owner_pid`, `owner_token`,
`runtime_generation`, `lease_expires_at`, `terminal_id` (when handed off to a
console terminal), `writer_resource_key`, `host_thread_id`, `canonical_thread_id`
and `updated_at`. Metadata alone is not the exclusion primitive. The shared
canonical-thread lock must be acquired before either plane crosses its
writer-start boundary and held by the writer child/wrapper for its lifetime;
durable metadata and heartbeat make ownership diagnosable and stale takeover
fenced.

Hard invariant: **for a given canonical writer resource, at most one
Console-managed writer may hold the inherited fence**, even when multiple
target names alias it. Console-managed writers are V1 children, V2 runtimes,
Console terminals, and interactive CLIs launched through the fenced handoff
wrapper. An arbitrary external CLI that bypasses Console cannot be made part of
that hard invariant by this design; `attach-detect` remains a conservative,
best-effort admission check for it. V2 enforces the managed-writer invariant
explicitly, not by pattern-matching:

- `runtime.start` refuses (`writer_conflict`) when the canonical-thread lock is
  held, when a V1 job mapped to that writer resource is `running`, when
  `attach-detect` reports an attachment, or when a console terminal is bound to
  that thread (`ownTerminals()`, `apps/server/src/terminals.ts:1076`).
- Before V1 launches its child, it resolves and attempts the same
  canonical-thread lock. If a V2 runtime or handed-off console terminal owns
  it, the V1 job goes `blocked` exactly as it does for a detected terminal today
  (`relay.ts:637-655`). The existing `isBusy` check remains useful early
  feedback, but the lock acquired at the final launch boundary closes the
  check/claim race. Failure to resolve an unambiguous canonical writer key is
  `writer_identity_unresolved`, never permission to launch.
- `POST /api/terminals` for a thread whose target has a live V2 runtime should
  409 the same way it does for an external attachment (`terminals.ts:1399-1409`),
  again by consulting the ownership row rather than argv.

The residual race with an unmanaged external CLI is honest and bounded: if it
starts after the last attachment scan and does not use the fenced wrapper,
Console cannot prevent it. Dogfood and supported handoff paths must use the
wrapper; the status surface must distinguish `managedFenceHeld` from
best-effort `external` observations rather than claiming universal exclusion.

Why not rely on `attach-detect`? Because a Codex app-server process's argv
does not carry the thread id (the thread is chosen over JSON-RPC after start),
so argv matching would miss it entirely; and `attach-detect.ts` is documented
as best-effort in both directions. Explicit registration is required for V2.

### 7.2 Writer policy applies to V2 too

`writerPolicyFor` (`packages/core/src/hosts.ts:31-33`) says codex-lhc is
`single` and pi-lhc `shared`. V2 treats **both as single for its own runtime**
(RECOMMENDED): a second console-driven writer on a pi-lhc thread is never
useful, and "shared" was a UI-noise decision, not a safety guarantee
(`hosts.ts:20-25`, `docs/spec.md:430-436`). External pi-lhc attachments remain non-destructive under V1's observational
policy, but V2 `runtime.start` refuses them: deterministic ownership and safe
handoff require exclusivity even when the underlying store can tolerate two
writers.

### 7.3 Settled interactive CLI handoff

Handoff exists because a human sometimes needs the real TUI on the same
thread. The choreography (RECOMMENDED):

1. **`handoff.request{mode}`** — runtime enters `draining`. `drain` waits for
   the current turn to complete (follow-ups are **held**, not run); `interrupt`
   sends `turn.interrupt` first. New `turn.*` commands are rejected
   `handed_off`.
2. Runtime process is stopped cleanly (Codex: end the app-server session; Pi:
   end the RPC session). Before exit, the host must cross its capture
   flush/quiesce seam. The adapter confirms exit and Console verifies the
   command-correlated canonical turn span is durably present and closed. A
   merely closed newest row, an uncorrelated row, or a provider completion that
   outran capture is not sufficient.
3. Ownership row → `handed_off{terminal_id?}`. The writer fence is transferred
   through a Console-owned launch wrapper (for example, an inherited locked
   file descriptor); it is never released into an unowned gap. If
   `launch: "terminal"`, the
   console spawns the existing launch recipe through the terminal pool
   (`launchRecipe`, `packages/core/src/launch.ts:128-201`; `POST /api/terminals`
   path). If `command-only`, the receipt returns a **fenced wrapper command**,
   not the bare provider recipe. Arbitrary external launches that bypass that
   wrapper remain detectable only best-effort and cannot satisfy the handoff
   safety contract.
4. While `handed_off`, V1 sees the thread as busy (terminal or attachment),
   V2 answers status only, and held follow-ups stay visible in status.
5. **`handoff.release`** (explicit) — or, when the console terminal ends, an
   automatic release **proposal** surfaced in status (never automatic
   restart). Release requires no external attachment; then state → `stopped`.
   The caller decides whether to `runtime.start` again and whether held
   follow-ups run (`resumeFollowUps: true|false` on `runtime.start`; OPEN Q3).

The handoff is "settled" in the sense that every step leaves a durable record
and a status a client can act on; there is no window in which two writers are
both believed to own the thread by the console.

### 7.4 LHC continuity and capture ownership (RECOMMENDED)

The provider host remains the **only canonical-content writer**:
Codex-LHC's in-process Rust integration owns Codex capture, compact,
rollout replacement and host-validation receipts; the pi-lhc extension owns Pi
capture, LHC compact interception, seeding and rehydration. Console V2 records
commands, provider events and correlation metadata in `v2.sqlite`, but it must
not replay those events into LHC, create/close canonical turns, run a second
compact path, or treat its event log as canonical conversation content. This
avoids duplicate capture and keeps host-specific protected-tool and compact
semantics inside the certified integration.

A Console V2 turn maps to a **correlated canonical turn span**, not necessarily
one LHC row. Codex mid-turn compact continuation can close a canonical turn and
open `context_compact_continue` while one app-server turn continues. Pi closes
an LHC turn at each `agent_end`, while RPC `agent_settled` is the later boundary
that proves no retry, compact retry or queued continuation remains. Therefore:

- runtime turn completion is driven by provider settlement (`turn/completed`
  for Codex; `agent_settled` plus authoritative final assistant state for Pi).
  Pi's `agent_settled` proves the core run/retry/queued-continuation loop is
  finished, but the pi-lhc extension may start its own asynchronous smart
  compact from that hook; it is therefore not, by itself, a capture/compact
  quiescence receipt;
- reconciliation records the canonical event/turn interval observed for the V2
  command, including typed continuation markers, rather than asserting a 1:1
  turn-row mapping;
- a steer must appear in the same **V2 turn span** but may legally land in a
  continuation LHC turn after a compact boundary;
- handoff requires provider settlement, completion or cancellation of any
  host-triggered post-settle compact, a host capture flush/quiesce boundary,
  and proof that every canonical turn in the correlated span is closed. "The
  last turn is closed" without command/native-id correlation is insufficient;
- a hard kill may leave an open canonical turn. It produces an indeterminate
  outcome and keeps restart/handoff blocked until read-only reconciliation
  proves closure or an explicit repair owner resolves it.

Console may inspect host stores only through schema-compatible read-only
readers. Codex-LHC currently writes schema 11 while other LHC stores may differ;
V2 must not open a host database with a mismatched write SDK or lower its schema
version to make reconciliation succeed.

---

## 8. Recovery and event sequencing contract

### 8.1 Event envelope

```json
{ "seq": 4183, "target": "fable", "at": "2026-08-16T…Z", "kind": "turn.completed",
  "turnId": "t_…", "commandId": "…", "data": { … }, "provider": { "nativeTurnId": "…" } }
```

- `seq` is **per target and durable across console lifetimes**, strictly
  increasing for retained events, and assigned in the same transaction as the
  state/receipt transition it describes. Clients must not assume arithmetic
  gap-freedom after retention pruning; replay guarantees ordered retained
  events after a cursor or an explicit `410` re-baseline.
- Event kinds (minimum): `runtime.state` (state changes incl. `unknown`,
  reconcile results), `command.receipt` (every receipt transition),
  `command.effect` (`queued` steer resolved to `consumed` or `not_consumed`),
  `turn.started`, `turn.item` (agent message text and tool activity, coarse;
  deltas are DEFERRED D2), `turn.completed{outcome: completed|interrupted|failed|indeterminate, finalText?}`,
  `delivery` (final-delivery status), `handoff`.
- Adapters produce provider-native notifications; the runtime manager
  normalises and assigns `seq`. Adapters never assign `seq`.

### 8.2 Subscription and replay

- `GET /api/v2/targets/:target/events?after=<seq>` streams as SSE (RECOMMENDED;
  WebSocket already exists for terminals but SSE is simpler for
  cursor-resume). Server sends everything after the cursor from the
  durable log, then live events. Clients persist their cursor.
- Replay is exact: same events, same `seq`, no re-ordering. A client that
  reconnects with a cursor older than retention receives `410 gone` and a
  status snapshot; it must re-baseline from status (acceptance A9).
- Retention: RECOMMENDED per-target cap by count and age (e.g. 10 000 events
  or 14 days), configurable; the durable thread remains canonical for content.

### 8.3 Ordering guarantees

- Receipts for one command are monotone: `accepted → (applied | rejected |
superseded | indeterminate)`; an `indeterminate` receipt may later become
  `applied` only with uniquely correlated provider/canonical evidence. No
  command has two contradictory terminal effects.
- `turn.started` precedes any `turn.item` for that turn; `turn.completed` is
  the last event bearing that `turnId`.
- A steer's `applied{effectStage:"queued"}` receipt appears before the fenced
  turn completes. A later `command.effect{stage:"consumed"}` event requires
  provider evidence that the steer user message entered that turn at a safe
  boundary. Before emitting `turn.completed`, the manager settles every pending
  steer effect as `consumed` or `not_consumed`; this preserves the rule that
  `turn.completed` is the last event bearing that `turnId`. This makes both
  “accepted by the runtime” and “actually entered the turn” answerable without
  conflating them.
- Follow-up `turn.started{cause: "followUp"}` events appear in follow-up
  acceptance order, and only after the `turn.completed` they were fenced on.

### 8.4 Restart uncertainty and reconciliation

Runtime processes are supervised children of the console process (RECOMMENDED
— see OPEN Q2 for the detached alternative). The runtime/V1 child inherits the
canonical-thread lock file description and runs in a killable process group;
parent exit is expected to terminate it, but reconciliation never assumes that
without evidence. Consequences:

- Console exit normally terminates runtimes. On startup, every target with
  `owner_kind = v2-runtime` enters `unknown` until the owner token, PID start
  identity, lock state, provider state and canonical thread are reconciled. A
  surviving child or held lock remains a writer conflict; it is never relabelled
  `stopped` because the old Console PID died. There is no synthetic
  `indeterminate-closed` runtime state: ambiguity remains `unknown` until the
  writer is gone; indeterminacy is recorded on commands and turns.
- Reconcile classifies commands by durable dispatch state: `accepted` +
  `not_sent` remains accepted and retryable; `sending` without a correlated
  acknowledgement becomes `indeterminate`; `acknowledged` remains applied.
  Any active turn whose completion cannot be uniquely reconstructed gets
  `turn.completed{outcome: indeterminate}`. The console reads both provider
  durable state and the canonical LHC thread through schema-compatible,
  read-only inspection and records **evidence**, not a probability: correlated
  native turn/command metadata and a matching closed canonical turn span may
  settle the effect; an uncorrelated last closed turn does not. State becomes
  `stopped` only after no live writer/lock remains. Held follow-ups are preserved
  and surfaced in status; the runtime is **not** auto-restarted.
- If the console dies **while handed off**, the row is `handed_off` with a
  `terminal_id`; on restart the terminal pool's own reconcile
  (`terminals.ts` "reconcile") tells us if the terminal is alive; if not,
  release is proposed, not applied.
- Provider crash while console lives: adapter reports exit; runtime manager
  emits `turn.completed{indeterminate|failed}` per evidence, `runtime.state:
stopped{reason}`; same rules apply.

The wording of indeterminate outcomes reuses V1's phrasing so operators read
one message across planes.

### 8.5 Final delivery

`turn.completed{outcome: completed}` with `finalText` triggers optional Photon
delivery when the originating command asked for it (`delivery: "photon"`), via
the shared delivery primitive (§5.2), with V1's truncation and lease/retry
behaviour (`relay-delivery.ts:12,88-92`; `relay.ts:958-994`). Delivery status
is an event (`delivery{status}`) and part of status. Interrupted turns deliver
only if the command set `deliverPartial: true` (RECOMMENDED default false).

---

## 9. Provider adapter notes (thin) and capability matrix

Adapters translate; they do not decide. Each must expose the same TypeScript
interface (sketch, not code design):

```
start(thread) → nativeThreadRef        // resume/attach the durable thread
startTurn(text) → nativeTurnId
steer(nativeTurnId, text) → ok | mismatch | unsupported
interrupt(nativeTurnId) → ok
stop(mode) → exit evidence
on(event) → normalised provider notifications (turnStarted, item, turnCompleted{outcome, finalText}, exited)
```

### 9.1 Codex-LHC via app-server JSON-RPC (locally verified)

- Transport: spawn the codex-lhc fork's app-server (`codex app-server` on
  stdio; newline-delimited JSON-RPC, no `Content-Length` framing). Adapter
  sends `initialize`, then `thread/resume` with the target's native session
  id (the id `launchRecipe` derives from the lineage DB or the thread-file
  stem — `packages/core/src/launch.ts:170-186`).
- Mapping (verified in the local fork):
  `turn.start → turn/start{threadId, input}` (returns native `turnId`);
  `turn.steer → turn/steer{threadId, expectedTurnId, input}` — native fence;
  `turn.interrupt → turn/interrupt{threadId, turnId}`;
  events from `turn/started`, `item/started`, `item/completed`,
  `item/agentMessage/delta` (deferred), `turn/completed`, thread status
  notifications; `finalText` = last agent-message item of the turn.
- Approvals and sandbox are `thread/resume` / `turn/start` parameters in the
  app-server protocol, not app-server process flags. V2 must set the same
  effective policy as the selected dogfood seat and either handle every
  server request or deliberately choose the existing bypass posture (OPEN Q4).
- One-writer: codex-lhc is `single` policy; only the V2 runtime may hold the
  session. Its argv is not thread-identifying, hence §7.1's explicit row.
- LHC ownership and restart: `thread/resume` uses the same native id after a
  clean stop. The local fork installs LHC capture in app-server's production
  extension registry and performs LHC-backed reconciliation before app-server
  history load. The adapter must not duplicate that capture from notifications.
  Real-seat dogfood must prove end-to-end native/canonical correlation, capture
  flush before handoff, LHC-only compact receipts, protected active tool-state
  continuity, and the full canonical turn span for each command. It must **not**
  assert one LHC row per app-server turn: `context_compact_continue` may split
  canonical storage while the app-server turn remains active.

### 9.2 Pi-LHC via LHC-safe AgentSession/RPC (upstream surface verified;

pi-lhc launcher seam not yet enabled)

- Transport: spawn the **pi-lhc** entry (never bare `pi`) in an RPC mode
  that keeps the LHC extension attached, addressed to `--lhc-thread <id>`
  (the same reference `launchRecipe` uses, `launch.ts:130-134`). "LHC-safe"
  means every turn the console drives is captured into the pi-lhc thread
  store exactly as a TUI turn would be; the adapter must refuse to start if
  the LHC extension is not active in the spawned session. The vendored Pi RPC
  protocol already has JSONL `prompt`, `steer`, `follow_up`, `abort`,
  `get_state`, queue-mode controls and session events, but the current pi-lhc
  launcher explicitly rejects `--mode rpc` (`launcher/run.ts:106-108`). The Pi
  implementation is therefore a small **pi-lhc launcher capability**, not a
  Console adapter over a currently available command.
- Mapping after that seam exists: `turn.start → prompt`; `turn.steer → steer`
  (adapter-side fence: forward only when the tracked in-flight run equals the
  fenced turn); `turn.followUp` → **not** Pi's native follow-up (console queue,
  §6.2); `turn.interrupt → abort`. `agent_start` begins the V2 turn and
  `agent_settled` is the terminal **agent-run** boundary. Pi's low-level `turn_start`
  / `turn_end`, message/tool events and one or more `agent_end` events are
  `turn.item`/correlation evidence, not V2 `turn.completed`; RPC documentation
  explicitly allows retry, core compaction retry or queued continuation after
  `agent_end`. `finalText` is read from the authoritative settled session state,
  not latched from the first `agent_end`. Pi's steer is a safe boundary
  operation: after current tool calls and before the next LLM call. Its response
  means queued, not yet model-seen. Pin steering mode to `one-at-a-time`; use
  `queue_update`, the correlated user `message_start`, and `agent_settled` to
  distinguish queued, consumed and completed. Native follow-up remains deferred
  so Console owns ordering, cancellation and recovery consistently. Because the
  pi-lhc extension may launch an additional smart compact from
  `agent_settled`, handoff must separately await that compact's completion or
  cancellation and the lifecycle flush; `agent_settled` alone is not a
  quiescence receipt.
- Capture/compact: the existing pi-lhc extension closes canonical turns at
  `agent_end`, triggers auto-compact at `agent_settled`, intercepts
  `session_before_compact`, and flushes on session replacement/shutdown. The RPC
  launcher seam must use the same launcher-owned startup, extension factory,
  seeded in-memory session and compact hooks; it must refuse startup if those
  hooks or the resolved canonical thread identity are absent. Console never
  invokes bare Pi native compaction or separately captures RPC events.
- One-writer: pi-lhc is `shared` policy for external attachments; V2 still
  requires one writer per canonical thread (§7.2).
- Restart: resume by `--lhc-thread <id>`; the pi-lhc thread store is the
  canonical record. Implementation must first reconcile the accepted
  selector/empty-tail line (`a57e520` shared selector semantics and pi-lhc
  `3d2f015` installed-receipt mapping) with the branch it builds from; current
  `main` at the recorded review point does not contain that complete line.

### 9.3 Capability matrix

Legend: **N** native, **E** emulated by adapter/runtime manager, **–**
unsupported (rejected `unsupported`), **V1** the one-shot plane for contrast.

| Capability                   | Contract element        | Codex-LHC (app-server)                                  | Pi-LHC (AgentSession/RPC)                                  | V1 one-shot                 |
| ---------------------------- | ----------------------- | ------------------------------------------------------- | ---------------------------------------------------------- | --------------------------- |
| Ordinary turn                | `turn.start`            | N (`turn/start`)                                        | N (`prompt`)                                               | N (execFile)                |
| Explicit safe-boundary steer | `turn.steer` + fence    | N fence + N queued steer                                | E fence + N queued boundary steer (after pi-lhc RPC seam)  | –                           |
| Explicit follow-up / next    | `turn.followUp`         | E (console queue)                                       | E (console queue; native follow-up unused)                 | E (queue of jobs; implicit) |
| Stop / interrupt             | `turn.interrupt`        | N (`turn/interrupt`; response waits for abort evidence) | N (`abort`; response waits for idle) after pi-lhc RPC seam | – (kill = job failed)       |
| Status snapshot              | `status`                | N + E (thread status + console state)                   | N + E (`get_state` after pi-lhc RPC seam + console state)  | job status only             |
| Live events                  | `events` (coarse items) | N                                                       | N upstream; E pi-lhc RPC exposure                          | –                           |
| Reconnect / replay           | cursor + durable log    | E (console log)                                         | E (console log)                                            | – (poll job)                |
| Final delivery to Photon     | `delivery`              | E (shared bridge)                                       | E (shared bridge)                                          | N                           |
| Expected-turn fencing        | `expectedTurnId`        | N (provider) + E (console)                              | E (console only)                                           | n/a                         |
| Accepted vs applied receipts | receipts                | E                                                       | E                                                          | – (queued/running only)     |
| Restart reconciliation       | `unknown → reconcile`   | E + durable thread read                                 | E + durable thread read                                    | N (owner_pid)               |
| Handoff to interactive CLI   | `handoff.*`             | E (`codex-lhc resume … <sid>` via terminals)            | E (`pi-lhc --lhc-thread <id>` via terminals)               | n/a                         |
| Approval prompts surfaced    | —                       | DEFERRED (bypass policy at spawn)                       | n/a                                                        | n/a                         |
| Streaming text deltas        | —                       | DEFERRED D2                                             | DEFERRED D2                                                | –                           |

Rule for building: a capability row is "done" only when both provider
columns pass the same paired acceptance scenario (§10). No row ships for one
provider alone (SETTLED: together, capability by capability).

---

## 10. Paired cross-provider acceptance plan

Every scenario is written once against the contract, run against a **fake
adapter** (deterministic unit harness) and against **both real adapters** in
a smoke lane. Pass criteria are identical across providers except where the
matrix marks N vs E (the observable receipts/events must still match).

| ID  | Scenario                         | Steps (abridged)                                                                                                                                                                                           | Must observe                                                                                                                                                                                                                                                                                                    |
| --- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Ordinary turn, delivered         | `runtime.start`; `turn.start{delivery: photon}`                                                                                                                                                            | `accepted → applied{nativeTurnId}`; `turn.started`, ≥1 `turn.item`, `turn.completed{completed, finalText}`, `delivery{delivered}`; host capture yields one correlated, fully closed canonical turn **span** (one or more rows only when typed continuation/retry semantics require it)                          |
| A2  | Start while active is explicit   | `turn.start` twice quickly                                                                                                                                                                                 | second → `rejected: turn_active{currentTurnId}`; no second turn on the thread                                                                                                                                                                                                                                   |
| A3  | Steer with correct fence         | `turn.start`; `turn.steer{expectedTurnId}` mid-turn                                                                                                                                                        | `applied{effectStage:queued}` then `command.effect{stage:consumed}` before that V2 turn's `turn.completed`; provider evidence recorded; durable LHC span shows the steer text under the same V2 command, allowing a typed compact-continuation boundary between canonical rows                                  |
| A4  | Steer with stale fence           | steer with previous `turnId`                                                                                                                                                                               | `rejected: turn_mismatch{currentTurnId}`; provider never called                                                                                                                                                                                                                                                 |
| A5  | Follow-ups run in order          | `turn.start`; `followUp(a)`; `followUp(b)` fenced on the same turn                                                                                                                                         | both `applied` (queued); after `turn.completed`, `turn.started{cause: followUp}` for a then b; no interleaving; status shows queue depth throughout                                                                                                                                                             |
| A6  | Interrupt mid-turn               | `turn.start` (long); `turn.interrupt{expectedTurnId}`                                                                                                                                                      | `applied`; `turn.completed{interrupted}`; runtime `idle`; no delivery unless `deliverPartial`                                                                                                                                                                                                                   |
| A7  | Interrupt when idle              | `turn.interrupt` with last completed id                                                                                                                                                                    | `rejected: no_active_turn`; state unchanged                                                                                                                                                                                                                                                                     |
| A8  | Status is consistent with events | Random command mix; poll status and stream concurrently                                                                                                                                                    | for every status snapshot with `lastEventSeq=N`, replaying events ≤N yields the same state/turn/queue                                                                                                                                                                                                           |
| A9  | Reconnect with cursor            | Subscribe, drop the connection mid-turn, resubscribe `after=<cursor>`                                                                                                                                      | no gaps, no duplicates, same `seq`; cursor older than retention → `410` + snapshot                                                                                                                                                                                                                              |
| A10 | Console restart mid-turn         | `turn.start` (long); kill console; restart                                                                                                                                                                 | on boot: `runtime.state: unknown`; a surviving child/held canonical lock remains fenced; `not_sent` commands remain retryable, uncorrelated `sending` commands/turn become indeterminate, acknowledged commands remain applied; state becomes `stopped` only after no writer remains; no auto-restart           |
| A11 | Handoff and return               | `handoff.request{drain, terminal}`; use TUI; exit; `handoff.release`; `runtime.start`                                                                                                                      | provider settlement and any Pi post-settle compact finish before capture flush; flush receipt and correlated canonical span closure precede transfer; ownership transitions `v2-runtime → handed_off → none → v2-runtime`; V2 turn commands reject `handed_off`; V1 job posted during handoff remains `blocked` |
| A12 | Cross-plane exclusion            | (a) V1 job running → `runtime.start`; (b) V2 runtime idle → V1 job; (c) external CLI attached → `runtime.start`; (d) race V1 final launch against V2 start; (e) two target keys alias one canonical thread | (a) `rejected: writer_conflict`; (b) V1 job `blocked` until `runtime.stop`, then runs; (c) `writer_conflict{attached}` for both dogfood providers; (d) exactly one acquires the shared writer fence; (e) the alias cannot acquire a second writer lock                                                          |
| A13 | Additive rollback                | Run the V1 test suite with V2 disabled and with `v2.sqlite` deleted                                                                                                                                        | all V1 tests unchanged; V1 routes and `lhc-agent` behaviour byte-identical                                                                                                                                                                                                                                      |
| A14 | Provider process crash           | Kill the runtime child mid-turn                                                                                                                                                                            | `turn.completed{failed                                                                                                                                                                                                                                                                                          | indeterminate}` per correlated evidence; an open/unflushed canonical span blocks handoff; runtime becomes stopped only after the writer lock is gone; only ambiguous dispatched commands become indeterminate; follow-ups held |
| A15 | Cancel is not interrupt          | Queue two follow-ups; cancel one before dispatch; try to cancel the active turn command                                                                                                                    | queued command becomes `superseded{cancelled}` and never starts; active command returns `already_dispatched`; active turn continues until explicit interrupt                                                                                                                                                    |
| A16 | Crash at dispatch boundary       | Crash before send, after marking `sending`, and after provider acknowledgement                                                                                                                             | `not_sent` remains retryable; uncorrelated `sending` becomes indeterminate and is not replayed; acknowledged remains applied; no duplicate canonical command span                                                                                                                                               |

Acceptance is **paired capability-by-capability**: the scenarios relevant to a
matrix row must pass for Codex-LHC and Pi-LHC in the same change set before
that row is marked done. Foundational persistence, arbitration, recovery and
V1 non-interference scenarios (A8–A10, A12–A14) gate the first real-seat
dogfood. Handoff A11 gates handoff, not the earlier ordinary-turn row.

---

## 11. Coexistence, additive migration, rollback

### 11.1 Coexistence rules (RECOMMENDED)

- V1 public behavior is unchanged when V2 is disabled or the target/resource is
  not opted in. For a V2-opted canonical resource, its internal writer-start boundary gains
  the shared canonical-thread lock acquisition from §7.1, plus the existing
  early `isBusy` feedback. This is intentionally the only cross-plane execution seam;
  `RelayQueue` ordering, job state and delivery remain unchanged.
- V1 and V2 share `agents.json` keys and the bearer token (OPEN Q1) so
  clients address the same target names.
- Unprefixed Photon inbound, goals and monitors keep using V1. Only the
  explicit `/v2`, `/steer`, `/next`, `/stop`, `/v2-status` and `/cancel`
  controls in §6.3 enter V2. Policy-driven routing of ordinary messages is
  DEFERRED D4.

### 11.2 Additive migration path

1. Ship the V2 plane behind a flag (e.g. `LHC_CONSOLE_V2=1`), off by default;
   V2 routes 404 when off; no `v2.sqlite` is created.
2. Opt targets in one at a time by adding the `v2` block in `agents.json`;
   targets without it are V1-only and unaffected.
3. Capabilities land in matrix order, each with its paired A-scenarios.
4. Handoff (A11) and cross-plane exclusion (A12) land before any target is
   used interactively in anger.

### 11.3 Rollback

- Turn the flag off (or remove `v2` blocks): V2 runtimes are stopped on next
  boot; V1 keeps serving. Delete `v2.sqlite` only while Console is stopped and
  after proving no V2 runtime or handed-off writer remains; this discards V2
  command/event history but leaves durable threads and `relay.sqlite` untouched.
- No V1 schema migration is introduced by V2, so there is nothing to
  roll back in `relay.sqlite`.

---

## 12. Recommendations, open questions, deferred work

### 12.1 Recommendations (summary of RECOMMENDED items)

- R1 Separate `apps/server/src/v2/` tree, `/api/v2/*` routes, `v2.sqlite`.
- R2 Console-minted `turnId`; fencing at acceptance and at application; Codex
  native fence used as a second check, Pi fence emulated.
- R3 Console-owned follow-up queue for both providers.
- R4 `turn.start` while active is rejected, never queued.
- R5 Shared canonical-thread writer lock (alias-safe and inherited by the
  writer child/wrapper) plus inspectable ownership metadata, consulted by V1
  launch, V2 runtime start and terminal handoff.
- R6 Runtime processes as console children; restart → `unknown → reconcile`,
  never auto-restart.
- R7 SSE event stream with cursor replay and bounded retention.
- R8 One shared Photon delivery helper used by both planes.
- R9 Handoff choreography of §7.3, with explicit release.
- R10 Treat both providers as single-writer for V2's own runtime.

### 12.2 Open questions (OPEN)

- Q1 Reuse the V1 relay bearer token for `/api/v2`, or mint a second
  owner-only token? (Recommend reuse: same trust boundary, same file.)
- Q2 Runtime processes as console children (this design) versus detached
  runtimes (tmux/daemon) that survive console restarts. Detached would turn
  A10 from "indeterminate" into "reattach", at the cost of a second
  ownership mechanism. Recommend children first, revisit after A10 evidence.
- Q3 On `runtime.start` after handoff/restart, do held follow-ups resume by
  default?
- Q4 Codex approvals under V2: bypass at spawn (matches V1 launches) or
  surface `serverRequest` approvals as events with an `approval.respond`
  command.

The following are implementation defaults, not owner decisions: SSE is the
initial resumable event transport; Pi steering mode is pinned one-at-a-time;
native Pi follow-up stays deferred; runtimes do not auto-restart; retention is
configurable with the §8.2 default; and the first client surface may be chosen
without changing the wire contract.

### 12.3 Deferred (DEFERRED)

- D1 Approval prompts as first-class events/commands (see Q4).
- D2 Streaming text deltas to subscribers/phone.
- D3 Multiple runtimes per target, or one runtime spanning multiple threads.
- D4 Policy-driven routing of ordinary Photon inbound, goals, or monitors
  through V2 (explicit §6.3 controls are in scope).
- D5 Detached/daemonised runtimes (see Q2).
- D6 Any workflow/project automation (out of scope by owner direction).
- D7 Additional providers (cc-lhc, hermes) — the contract is provider-neutral
  by construction, but only Codex-LHC and Pi-LHC are in this design.
- D8 Replacing the Console-owned follow-up queue with a provider-native queue.

---

## 13. Sources and verification

### 13.1 Verified in this repository (read during design)

- `README.md` — V1 relay, monitors, goals, restart-uncertainty wording.
- `CLAUDE.md` — toolchain (`vp check`, `vp test`).
- `docs/spec.md` — constraints (read-only host stores), one-writer guard
  (`416-472`), terminal pool.
- `apps/server/src/relay.ts` — job statuses, claim/one-job-per-target loop,
  restart handling, delivery lease/heartbeat/retry.
- `apps/server/src/relay-routes.ts`, `relay-process.ts`, `relay-delivery.ts`,
  `relay-config.ts`, `relay-prompt.ts`, `process-alive.ts`.
- `apps/server/src/agent-registry.ts` — `agents.json` v1 shape.
- `apps/server/src/attach-detect.ts` — argv-based attach detection and its
  stated limits.
- `apps/server/src/index.ts` — wiring, `isBusy`, route registration.
- `apps/server/src/terminals.ts` (`1076`, `1287-1432`) — terminal pool
  admission and one-writer 409.
- `apps/server/src/agent-cli.ts`, `photon-connector.ts:377-388`,
  `monitor.ts:238`, `goal.ts:552` — V1 enqueue call sites.
- `packages/core/src/hosts.ts` — writer policy; `launch.ts` — resume recipes
  for codex-lhc / pi-lhc; `newsession.ts`.
- `docs/handoff-env-scrub.md` — precedent for env hygiene when spawning
  provider processes (V2 runtimes must apply the same scrub).

### 13.2 Provider verification performed in the local forks

Reviewed `/srv/work/codex` (branch `lhc`; current review checkout
`129f1b4ccc`, with v0.3.1 product source `6f849b7b3e`) and
`/srv/work/long-horizon-context` (branch `main`, commit `c922731`; that checkout
has unrelated existing changes). The accepted selector/empty-tail work is on
`a57e520` / `fix/pi-lhc-empty-tail` tip `3d2f015`, not fully in that `main`
checkout. No provider files were modified.

Codex evidence:

- `codex-rs/app-server/README.md`: stdio is JSONL; WebSocket is experimental.
- `app-server-protocol/src/protocol/v2/{thread,turn}.rs`: exact
  `thread/resume`, `turn/start`, `turn/steer{expectedTurnId}` and
  `turn/interrupt{turnId}` shapes.
- `app-server/src/request_processors/turn_processor.rs`: steer validates the
  active turn; interrupt response is held until abort evidence arrives.
- `app-server-protocol/src/protocol/{common,event_mapping}.rs`: turn/item and
  thread-status notification names.
- `app-server/src/extensions.rs` and
  `request_processors/thread_processor.rs`: LHC capture is registered on the
  app-server path and LHC reconciliation runs before resumed history loads.

Pi evidence:

- Vendored `modes/rpc/{rpc-types,rpc-mode}.ts`: JSONL commands include
  `prompt`, `steer`, `follow_up`, `abort`, `get_state`, queue-mode controls and
  session events. `agent_end` is explicitly a low-level run boundary;
  `agent_settled` proves no automatic retry, compaction retry or queued
  continuation remains.
- `core/agent-session.ts`: steer is delivered after current tool calls and
  before the next LLM call; follow-up waits until no tools or steers remain;
  abort waits for idle; runtime/session replacement requires re-subscription.
- `packages/pi-lhc/src/launcher/run.ts`: launcher constructs an LHC-attached
  `AgentSessionRuntime` but currently rejects `--mode rpc`. `index.ts` closes
  canonical turns at `agent_end`, triggers compact at `agent_settled`,
  intercepts compact, and flushes on session replacement/shutdown. Enabling the
  exact LHC-safe RPC path is a Pi-side prerequisite and must preserve
  launcher-owned startup, seeding, capture and compaction hooks.

Remaining proof obligations belong in paired real-seat acceptance, not in the
provider-claim backlog: Codex app-server and newly enabled pi-lhc RPC each
produce a correctly identified and fully closed canonical LHC **turn span**;
continuation boundaries are correlated rather than mistaken for duplicate
commands; steer consumption is correlatable; interrupt outcomes and open-turn
risk are captured; LHC compact remains the only compact writer; capture is
flushed before handoff; and settled handoff resumes the same native and
canonical identities.

---

## 14. PM requirement checklist

| Requirement                                                | Where                                     |
| ---------------------------------------------------------- | ----------------------------------------- |
| One canonical Console V2 contract                          | §6, §8                                    |
| Capability matrix                                          | §9.3                                      |
| Writer ownership and CLI handoff                           | §7                                        |
| Recovery / event sequencing contract                       | §8                                        |
| Cross-provider acceptance plan                             | §10                                       |
| Thin host-specific adapter notes                           | §9.1, §9.2                                |
| One design story, no implementation stories                | §2, §11.2 (capability order, not stories) |
| Owner-settled vs recommended vs open vs deferred separated | labels throughout; §12                    |

---

## 15. LHC architecture review — 2026-08-17

**Verdict: PASS WITH SOURCE-GROUNDED CORRECTIONS APPLIED.** The additive V2
shape is compatible with LHC and does not conflict with Lee's settled direction.
Codex-LHC and Pi-LHC should continue capability-by-capability against one
observable contract. No architectural case was found for silently reverting to
one-provider-first delivery.

Corrections applied during this review:

1. Writer exclusion is keyed by canonical host/thread resource, not target
   name, and the writer child/wrapper retains the lock across Console failure.
2. Console owns V2 commands/events but never duplicates host-owned LHC capture
   or compaction.
3. One V2 turn maps to a correlated canonical turn span, not necessarily one
   LHC row. This preserves Codex compact continuation and Pi retry/settlement
   semantics.
4. Pi completion uses `agent_settled`; `agent_end` remains the LHC capture
   close boundary and may occur more than once before one RPC operation settles.
5. Handoff now requires provider settlement, capture flush/quiescence and
   correlated canonical span closure. Hard-kill/open-turn states cannot hand
   off as clean.
6. Restart reconciliation accounts for surviving children/locks, PID identity,
   schema-compatible read-only LHC inspection and indeterminate open spans.
7. Pi implementation is explicitly gated on reconciling the accepted shared
   selector and pi-lhc empty-tail receipt fixes before the RPC seam is built.
8. Runtime `unknown` is kept distinct from indeterminate command/turn outcomes;
   restart reconciliation cannot manufacture canonical closure.
9. Receipt wording distinguishes provider acknowledgement from steer
   consumption, and long-poll waits on any terminal receipt rather than only
   success.
10. Pi `agent_settled` is an agent-run boundary, not proof that a pi-lhc
    post-settle smart compact and capture flush have quiesced.
11. The hard writer invariant covers Console-managed fenced writers; arbitrary
    external CLIs remain a documented best-effort detection boundary.

Unresolved implementation proof obligations, not design conflicts:

- define and test the exact host-native ↔ V2 command ↔ canonical turn-span
  correlation receipt for each provider;
- define the host flush/quiesce acknowledgement used before handoff;
- prove the canonical writer-resource resolver cannot alias or split one host
  thread across target keys;
- prove Pi RPC startup refuses a runtime without launcher-owned LHC startup,
  capture and compact hooks;
- run paired real-seat restart, compact-continuation, steer, interrupt and
  handoff scenarios before either provider capability row is marked done.

Implementation checkpoint evidence now supports a code-ready verdict for
controlled dogfood discussion. V1 remains unchanged and V2 remains separately
gated. Production handoff remains unsupported. Live SSE replay is gap-free and
its replay backlog is bounded, but live socket backpressure remains a named
dogfood risk: a slow connected client can still grow Node's socket write buffer.
Dogfood must monitor that risk and disconnect/resnapshot conservatively rather
than treating this checkpoint as production-ready.

This review does not authorize merge, push, deployment, service reload, test
agent creation, or production handoff.
