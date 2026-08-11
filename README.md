# lhc-console

One place to find, inspect, and manage long-horizon-context (LHC) threads across
every host on this machine — cc-lhc, pi-lhc, codex-lhc, t3code-lhc, and future
hosts (grok, hermes). A Fastify REST API backed by console-owned read operations
over the hosts' SQLite files, with an HTML/TypeScript front end.

The console opens host registries and thread files directly (always read-only)
and does not depend on the `lhc` SDK. Its operations live in
`packages/core` so they can later be broken out into a standalone sdk/cli.

## Layout

| Path            | What                                                                               |
| --------------- | ---------------------------------------------------------------------------------- |
| `packages/core` | Host discovery, registry reads, thread-file reads (`node:sqlite`, read-only)       |
| `apps/server`   | Fastify REST API (`/api/hosts`, `/api/threads`, thread detail/turns/messages/view) |
| `apps/web`      | Vite front end — thread finder, turn/message navigation                            |

## One-shot relay (loopback only)

### Agent CLI

`lhc-agent` is the zero-configuration front door for local callers. Running it
with no arguments lists every exposed agent key and a short description, then
shows the compact call syntax:

```bash
lhc-agent
lhc-agent fable "Review this design."
printf 'Review this design.' | lhc-agent fable -
lhc-agent lee "The build is ready for review."
```

Long calls can detach and be checked later:

```bash
job=$(lhc-agent start fable "Take a deep look.")
lhc-agent job "$job"
```

Agent-to-agent calls that may provoke a reply must use `start` so the caller
does not hold its own thread while waiting on the recipient; blocking mutual
calls can deadlock until timeout. `--from <agent>` or `LHC_AGENT_ID` adds a
compact sender envelope. The special `lee` destination is always detached and
delivers one-way through the sending agent's Photon identity, falling back to
Console's configured identity when needed.

The command discovers the loopback endpoint and owner-only token itself. Callers
use stable agent keys; URLs, credentials, thread IDs, phone numbers, working
directories, and runtime commands remain control-plane internals. Registry
discovery exposes only the key, display name, description, duties, and channel
types.

The server exposes a small authenticated job relay at `127.0.0.1:5959`. Relay
targets come from the owner-only `~/.lhc-console/agents.json` registry. Each
registered agent supplies its durable host, thread, working directory, command,
arguments, and optional environment. Jobs remain `blocked` while another
process holds the target thread.

On first server boot, an owner-only bearer token is created at
`~/.lhc-console/relay-token` (or set `LHC_RELAY_TOKEN`). Synchronous call:

```bash
TOKEN=$(<~/.lhc-console/relay-token)
curl -sS -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Reply with one short sentence."}' \
  http://127.0.0.1:5959/api/relay/targets/fable/jobs
```

For long turns, add `Prefer: respond-async`; the `202` response includes a job
id and `Location`, and `GET /api/relay/jobs/:id` reports
`queued|blocked|running|completed|failed`. Add `"notify":"photon"` for the
completed reply to be sent to Console's configured Photon home channel.

Group-chat connectors can also include an optional string `channelContext`.
The relay prepends it using Hermes' read-only catch-up envelope—followed by
`[New message]` and the addressed prompt—so console-hosted agents receive the
same prompt shape as Hermes agents. The connector remains responsible for
owner-only wake authorization, per-agent cursors, and durable group history;
this endpoint only accepts an already-authorized addressed turn. It must also
pseudonymize participant identifiers, label unverified participants, and wrap
their words as read-only background context before calling the relay. No
connector may pass raw participant text through `channelContext` without that
framing. A bearer holder already has full prompt authority, so the relay does
not attempt to re-authorize or sanitize this trusted envelope.

Turn timeouts may be configured per registered target with `relay.timeoutMs` in
`agents.json`; targets without one use the relay's 20-minute default. If a relay
process loses track of a running child across restart, the job is failed as
indeterminate: the durable agent thread is canonical and may contain a
completed turn even when relay telemetry does not.

## Goals and monitors

Goals are the minimal persistent-focus primitive. A goal emits prioritized
reminder turns while ordinary peer calls remain deprioritized:

```bash
lhc-agent goal start fable "Finish the current hardening wave." --every 5m
lhc-agent goal list
lhc-agent goal done <id>
lhc-agent goal blocked <id> "Needs an owner decision"
lhc-agent goal cancel <id>
```

Ordinary `lhc-agent <agent> ...` calls are deprioritized by default; add
`--priority` only when the message belongs to the target's active focus.

**Monitor** is the org verb for an external periodic wake with a prompt, until
its exit condition is reached. Monitors live outside the target agent so work
keeps moving when an interactive session closes or a one-shot finishes without
another caller.

V1 monitors are durable in `~/.lhc-console/monitor.sqlite`, address registered
relay targets, and stop through either explicit removal or a maximum tick cap.
They use the relay's loopback-only bearer authentication. A due monitor does
not stack another tick while its previous relay job is still queued, blocked,
or running. It also waits until the target thread has been idle for three
minutes by default; `--idle-for` overrides that floor. Skipped ticks do not
consume the maximum tick budget. Monitor replies are delivered to Lee through
the target's existing Photon delivery path by default, with delivery failures
recorded on the relay job. Use `--quiet` only when a monitor is intentionally
noisy and should not reach the phone. Every registered monitor prompt also
ends with a standing instruction to return a short, plain-English,
phone-skimmable phase-level status without ids or jargon.

```bash
lhc-monitor add fable 5m --idle-for 3m --max-ticks 12 \
  --prompt "Inspect the goal, advance the next unfinished step, and report blockers."
lhc-monitor list
lhc-monitor remove <id>
```

Add `--quiet` to the `add` command to disable default reply delivery for that
monitor.

The corresponding authenticated API is `POST/GET /api/monitors` and
`DELETE /api/monitors/:id`. Generic command targets and richer goal-based exit
criteria are intentionally deferred until usage teaches us what is needed.

## Development

Two processes (Vite proxies `/api` to the server):

```bash
vp run dev:server   # Fastify on 127.0.0.1:5959 (LHC_CONSOLE_PORT to change)
vp run dev          # Vite dev server for apps/web
```

Checks and tests:

```bash
vp check            # format, lint, typecheck
vp run -r test
```

## API sketch

- `GET /api/hosts` — discovered hosts + thread counts
- `GET /api/threads?host=&cwd=&q=` — aggregated cross-host listing with quick stats (mtime-cached)
- `GET /api/threads/:hostId/:threadId` — overview: counts, message kinds, derivation states, view bands, visibility boundary
- `GET /api/threads/:hostId/:threadId/turns` — turn listing with prompt excerpts
- `GET /api/threads/:hostId/:threadId/messages?turn=&from=&to=&limit=&cap=` — messages with decoded blocks
- `GET /api/threads/:hostId/:threadId/view` — stored compact bands (rendered text)

Thread ids accept unique prefixes (e.g. `th_a485`).

## Features

- **Finder** — cross-host list with per-thread summaries (latest brief chunk summary), context tokens, sortable columns, host/directory/text filters, health dots, live refresh. Hosts: cc-lhc, pi-lhc, codex-lhc, t3code-lhc, and hermes (registry-less: scans `~/.hermes{,/profiles/<name>}/lhc/threads`)
- **Launch** — non-t3code threads get a launch link (list + detail) opening a modal that copies the one-shot resume command (`cd … && cc-lhc --resume …`, `pi-lhc --lhc-thread …`, `hermes --profile … --resume …`) to the clipboard
- **Detail tabs** — overview (identity/volume/view/health), histogram (per-turn stacked token bars by message kind, compact-point marker, click-through), turns (keyboard-navigable turn browser with full message content), thread view (band ribbon + per-turn projection with the derivation content actually used, plus the live tail since compact)
- Deep links throughout (`#/thread/<host>/<id>/<tab>[/<turn>]`), `/` to search, Esc to go back, j/k in turns

## Roadmap

1. **Search** — content search across threads (FTS index in a console-owned cache DB)
2. **More visualizations** — token mass over time, chunk maps, lineage/fork graphs
3. **Actions** — relaunch helpers, then edit/prune/smart-compact (via the LHC SDK, which owns mutation invariants)
