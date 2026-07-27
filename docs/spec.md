# lhc-console — working spec

Console for finding, inspecting, and navigating long-horizon-context (LHC) threads
across hosts. Single user, local server reached over Tailscale. This document is the
implementation brief; keep it current when behavior changes.

## Non-negotiable constraints

- **Read-only.** Every SQLite open goes through `packages/core/src/db.ts` `openReadOnly`.
  The console must never write a host's registry, lineage DB, or thread file.
- **No `lhc` SDK dependency.** All read operations are console-owned, in `packages/core`.
- **Toolchain.** Vite+ (`vp`). `. ~/.vite-plus/env` to get the CLI. `vp check` must pass
  (format + oxlint + typecheck). Plain JS/TS, ESM, no framework in the web app.
- **Web app stays framework-free** (vanilla TS + DOM). Small, fast, no build heaviness.
- **Dev processes** (usually already running):
  - API: `cd apps/server && node --watch src/index.ts` → 127.0.0.1:5959
  - Web: `cd apps/web && vp dev --port 5175` → binds all interfaces (Tailscale access),
    proxies `/api` to the API server.

## Domain background

Read `../long-horizon-context/docs/onboard/01-core-concepts.md` and
`02-domain-design.md` for the LHC vocabulary (threads, turns, chunks, derivations,
bands, thread views, compact point, visibility boundary). Short version:

- Each host home (`~/.cc-lhc`, `~/.pi-lhc`, `~/.codex-lhc`, `~/.t3code-lhc`, …) has
  `registry.sqlite` (table `threads(thread_id, file_path, title, cwd, created_at)`) and
  `threads/<uuid>.sqlite` per thread.
- Thread file tables: `event`, `message` (kind, token_estimate, turn_id,
  source_event_order, deleted_at), `message_block` (block_type, content — see envelope
  below), `turns` (turn_order, status open/closed, opened/closed_at_event_order,
  started_at/ended_at, outcome), `chunk` / `chunk_member` (chunk_order, member turn ids),
  `derivation` (subject_kind message|turn|chunk, subject_id, derivation_type, state
  pending|ready|failed|blocked, content), `thread_view` (singleton row: view_id,
  created_at, compact_point, covered_from, profile_name, config_json, arrangement_json,
  gaps_json, source_state_json), `thread_view_band` (band brief|detailed|smooth,
  rendered_text, token_count), `view_boundary`, `work_item`, `thread_metadata`, `log`.
- Message kinds: `user_prompt`, `assistant_text`, `assistant_thinking`, `tool_call`,
  `tool_result`, `model_change`, `thinking_level_change`, `runtime_note`.
- **Block content envelope**: `message_block.content` is JSON —
  text-ish blocks `{"text": …}`; tool_call `{"toolCallId","toolName","arguments"}`;
  tool_result `{"toolCallId","content"}`. `decodeBlockContent` in
  `packages/core/src/thread.ts` decodes.
- **arrangement_json** (thread_view): array of
  `{band: "brief"|"detailed"|"smooth", subjectKind: "chunk"|"turn", subjectId,
derivationUsed, degraded}`. Chunk entries expand to turns via `chunk_member`.
  Everything after `compact_point` (an event order) is the live tail ("full" band, not
  stored). A thread with no `thread_view` row has never been compacted — all turns are
  effectively full/live.
- Useful derivation content for summaries: `chunk_summary_brief` (outcome-focused,
  short), `chunk_summary_detailed`, `turn_rendering` (composed account of one turn),
  `detailed_turn_compression`, `smoothed_prompt`.

## Product shape

### List page (`#/`)

Fast cross-host thread finder. Per row: host, directory (cwd), title,
summary description when available (best source: content of the latest ready
`chunk_summary_brief`, else first user prompt excerpt), turn count, current-context
tokens, created at, last activity. Sortable by any column (click header), filter by
host and directory, text search. Minimal, elegant, quality design that is not trying
hard — restrained dark monospace aesthetic, no decoration for its own sake.

"Current context tokens" ≈ what a resume would serve: sum of stored band token_counts
(if a view exists) + token estimate of messages after compact_point (tail). No view →
all message tokens.

### Detail page (`#/thread/<host>/<threadId>`) — four tabs

1. **Overview** (default): all top-level details — identity, cwd, timestamps, counts,
   message-kind breakdown, derivation states, view/bands info, boundary, health.
2. **Histogram**: turn-by-turn stacked bar visualization of the full run — one bar per
   turn (x = turn order), height = token estimate, stacked segments by message kind
   (user prompt / assistant text / thinking / tool call / tool result / other). Hover
   or click a bar shows the turn's numbers; clicking navigates to that turn in the
   Turns tab. SVG rendered by hand, no chart library.
3. **Turns**: scrollable turn list on the left (order, status, tokens, prompt excerpt);
   selected turn's full message content on the right. Smooth to navigate (keyboard
   up/down, lazy content loading).
4. **Thread view**: scrollable per-turn view of the latest thread-view projection —
   every turn shown in its band (brief / detailed / smooth) as of the latest
   projection, plus turns arrived since (live tail, marked "full/live"). Shows band
   membership visually (color-coded rail), the summary/rendering content actually used
   for that band entry, and degraded/gap markers. No projection → whole thread is live.

### Hermes host (registry-less)

The Hermes agent (python fork at /srv/work/hermes-agent) embeds lhc-py. Storage is
per profile, with NO registry.sqlite:

- default profile: `~/.hermes/lhc/threads/*.sqlite`
- named profiles: `~/.hermes/profiles/<name>/lhc/threads/*.sqlite`
- `HERMES_HOME` env overrides `~/.hermes`.

Thread files use the identical schema (lhc-py is a byte-parity port). The filename
stem is the Hermes session id (e.g. `20260721_174211_b5d6a6`); thread id and
created_at come from `thread_metadata` inside the file. Title: no registry title
exists — use the session-id stem, plus the profile as a suffix or badge. cwd: null.
The console lists these by scanning the threads dirs (mtime-cached identity reads).

### Launch commands

Every non-t3code thread carries a launch recipe (server-computed):

- pi-lhc: `cd <cwd> && pi-lhc --lhc-thread <threadId>` (no cd part when cwd null)
- cc-lhc: `cd <cwd> && cc-lhc --resume <rolloutSessionId>` where rolloutSessionId is
  the newest `cc_session_lineage` row for the thread in `~/.cc-lhc/cc-lhc.sqlite`
  (read-only). No lineage row → no launch (null with a reason).
- codex-lhc: `cd <cwd> && codex-lhc resume <sessionId>` from `codex_session_lineage`
  in `~/.codex-lhc/codex-lhc.sqlite`; same null fallback.
- hermes: `hermes --resume <sessionStem>` plus `--profile <name>` when the thread
  lives under a profile; no cd (hermes restores the session's recorded cwd itself).
- t3code: null (web-managed host).

UI: a "launch" affordance on list rows and the detail header opens a modal showing
the command; it auto-copies to the clipboard on open when the Clipboard API allows
(plain-http origins over Tailscale do NOT have `navigator.clipboard` — fall back to
a hidden textarea + `document.execCommand("copy")`), and always offers a copy
button (copy → close). Esc, ✕, and backdrop click close it.

### Terminal workspace

Server-owned PTYs (spawned only from server-computed launch recipes; loopback-only
devCommand escape for tests) with WebSocket attach, server-side scrollback ring
(~2MB) replayed on reattach, so sessions survive wifi drops, reloads, and browser
absence. Cap 8 running; exited terminals keep their final screen until dismissed.

UI is two full-screen modes, not a shared screen (user rejected the t3code-style
always-present main pane): the browser (list/detail) and a terminal workspace at
`#/term` — one thin bar (← threads, screen tabs, split control), everything else
is terminal. A screen holds 1–3 panes side by side (draggable dividers); a
terminal lives on exactly one screen. Launch always creates a new screen (or
jumps to the thread's existing one); composing pairs is an in-workspace act:
split → move an existing terminal here, or launch from a mini thread picker.
ctrl+` flips modes and alt+1..9 switches screens (intercepted before xterm);
Esc always belongs to the TUI. Browser mode shows a fixed "terminals ● N"
button when any exist. Pane composition persists in localStorage, reconciled
against GET /api/terminals on load.

## API surface (server)

Existing: `/api/hosts`, `/api/threads` (aggregated + quick stats, mtime-cached),
`/api/threads/:host/:id` (overview), `…/turns`, `…/messages`, `…/view`.
Terminals: `GET/POST /api/terminals`, `DELETE /api/terminals/:id`,
`GET /api/terminals/:id/ws` (websocket; JSON text frames are control —
replay/exit/resize/ping — and binary frames are raw pty bytes both ways).

Extend as slices need — keep endpoints coarse (one fetch per screen where possible)
and fast (avoid N+1 file opens; the aggregate list must stay instant on cached mtimes).

## Quality bar

- `vp check` clean; server stays up under `node --watch`.
- Every list/detail interaction should feel instant on ~40 threads / multi-MB thread
  files; no blocking the event loop with huge JSON payloads (cap content transport).
- Handle absent data gracefully everywhere: missing thread file, no view, no
  derivations, open turns, deleted messages.

### One-writer guard

A session takes one writer. Two hosts attached to the same session id fight over
the rollout file: it freezes for one of them and that side's turns are lost for
good (this happened — a second `cc-lhc --resume <sid>` started while the first
was still alive). So before the console helps anyone attach, it looks for a
process that already has the session.

`apps/server/src/attach-detect.ts` runs one `ps -eo pid,ppid,lstart,args`
(`execFile`, no shell) per request batch, cached ~3s, and matches argv per host:
cc-lhc and hermes on `--resume <sessionRef>`, codex-lhc on `resume <sessionId>`,
pi-lhc on `--lhc-thread <threadId>` (accepting unique id prefixes of 8 chars or
more). The identifier comes from the launch recipe, which now carries
`sessionRef` alongside `command`. The console's own running terminals count as
attachments too, tagged `source: "terminal"`; anything under one of their PTYs
is attributed to that terminal rather than reported as a stranger, and the
server's own process tree is ignored. Launch recipes in `/api/threads` and
`/api/threads/:host/:id` gain `inUse` (true only for a NON-console attachment)
and `attached: [{pid, source, args, startedAt}]`. `POST /api/terminals` answers
`409 {error: "session in use", attached}` when anything is attached and the body
lacks `force: true` — the idempotent "you already have a terminal for this
thread" return happens first, so the ordinary path is unchanged. The launch
modal shows a warn strip with the offending pids and turns its primary button
into "attach anyway" (which posts `force`); list rows and the detail header
carry a small dim `attached` marker with the pid in the title.

**This is best-effort pattern matching, and it can miss.** It only matches
explicit session-id / thread-id arguments, so a host started fresh rather than
resumed is invisible: a bare `node …/cc-lhc/dist/bin.js` with no `--resume` (and
its `claude` child) is a real live writer that this guard does not see — a bare
`cc-lhc` line is deliberately not matched, because it could belong to any
session and matching it would flag every cc-lhc thread at once. Detection also
needs a launch recipe, so a thread whose lineage row is missing gets no guard.
False positives are possible in the other direction: any command line that
happens to contain the id (a script, an editor, a `grep`) reads as an
attachment. Treat a hit as a strong warning and a miss as "unknown" — never as
"nothing is attached".

### Hidden threads

Console-owned overlay, never written to host registries: `~/.lhc-console/prefs.json`
(`LHC_CONSOLE_HOME` override; atomic tmp+rename writes; corrupt file backed up to
`.bad` and reset). `/api/threads?includeHidden=1` returns all rows with a `hidden`
flag (the client always uses this and filters); default excludes hidden.
`POST`/`DELETE /api/threads/:host/:id/hide` toggle, keyed by resolved full thread
id. UI: hover "hide" on list rows, a quiet `hidden (N)` chip to reveal dimmed rows
with unhide, and a hidden badge + unhide on the detail header. The terminals
devCommand escape requires loopback AND `x-lhc-dev` matching
`LHC_CONSOLE_DEV_SECRET` (absent secret = disabled).
