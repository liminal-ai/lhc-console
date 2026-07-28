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
  (read-only). No lineage row → recover the id from the rollout files (below),
  else `cd <cwd> && cc-lhc --continue` with `fallback: "continue"`.
- codex-lhc: `cd <cwd> && codex-lhc resume <sessionId>` from `codex_session_lineage`
  in `~/.codex-lhc/codex-lhc.sqlite`; no row → no command, with a reason.
- hermes: `hermes --resume <sessionStem>` plus `--profile <name>` when the thread
  lives under a profile; no cd (hermes restores the session's recorded cwd itself).
- t3code: null (web-managed host).

**Every non-t3code thread has the affordance**, recipe or not — "no recipe → no
affordance" left rows that were perfectly resumable looking dead, with nowhere to
ask why. So `launchRecipe` returns null only for t3code; every other host returns a
recipe whose `command` may be null, carrying `reason` (one sentence the modal
prints). Recipes also carry `recovered: true` (id found in the rollout files, not
the lineage DB) and `fallback: "continue"`, both of which the modal states in dim
text so the user knows how sure the command is.

**cc-lhc lineage-independent recovery** (`packages/core/src/cc-rollout.ts`), for
when `cc-lhc.sqlite` is wiped or corrupt — which it has been, repeatedly. Every
cc-lhc event's idempotency key is `cc-lhc:rollout:<lineUuid>:<blockIndex>:<kind>`,
and `lineUuid` is the `uuid` of a line in Claude Code's own rollout JSONL under
`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. Encoding is per character:
every non-`[a-zA-Z0-9]` becomes `-` (`/srv/work/lhc-console` →
`-srv-work-lhc-console`; case is preserved). Take the newest 20 rollout-keyed
idempotency keys from the thread file, list the cwd's rollouts, and open them in an
interleaved order — newest mtime ⊕ mtime nearest the thread's last event — because
newest alone misses a thread parked months ago in a directory of 160 rollouts and
proximity alone misses the session that is live right now. First file containing any
uuid names the session; its stem is the id. Bounded at 6 files, tail 512KB then head
128KB (tail first: a resumed session appends), tail only past 50MB, cached per
thread file mtime, entirely read-only. On the real host this recovers 9 of 10 cc-lhc
threads that have zero lineage rows (the tenth has no rollout-keyed events at all).

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

### New sessions & plain shells (slice 11)

The console is also the front door for _starting_ work, not just resuming it.
One entry point per surface, same components everywhere:

- **List page**: a `new session` button in the header (shortcut `n`).
- **Workspace split popover** grows to four entries with identical semantics:
  move an existing terminal here / resume a thread (both exist today) /
  new LHC session / new shell.

The modal flow: pick what to run — the _launchable_ hosts (cc-lhc, pi-lhc,
hermes; codex-lhc when installed; never t3code) **plus a plain shell** ($SHELL,
no LHC) — then pick a directory, then the standard two actions: open in
terminal / copy command. Commands are trivial: `cd <dir> && cc-lhc`,
`cd <dir> && pi-lhc`, `hermes` / `hermes --profile <name>` (hermes ignores cwd;
show a profile picker instead of a directory when profiles exist), `cd <dir>
&& exec $SHELL -l` for plain shells. New-session spawns bypass the one-writer
guard (nothing to conflict) and plain shells bypass thread association
entirely. Shell tabs label by directory basename, join screens/splits like any
pane. POST /api/terminals accepts a new-session form (host+cwd or shell+cwd)
— still server-computed commands only, never client-supplied strings.

**pathPicker** (reusable component, `apps/web/src/pathpicker.ts`): an input +
sectioned suggestion list. Config: section providers (label + `(query) =>
entries`), seed/root, dirs-only filter, validate hook. Keyboard: arrows move,
Enter selects, Tab completes-and-descends, typing narrows all sections.
Sections for new-session: (1) **quick selects** — distinct cwds across all
host registries ranked by most recent thread activity, annotated (basename ·
N threads · hosts · last active); (2) **filesystem browse** via `GET
/api/fs/browse?path=<partial>` (server splits partial into parent+prefix,
readdirs, returns dirs only, hidden dirs filtered, bounded count). No pinning
— recency does the ranking; the only user-set value is the default root
(prefs, `/srv/work`, per-host override allowed). From the split popover the
picker seeds with the _focused pane's cwd_ instead of the root (the common
split is "shell/agent next to this one, same repo").

**Newborn-thread association**: a terminal spawned as a new LHC session has no
thread id yet. The terminal manager watches the host's registry (mtime poll is
fine) for a new row whose cwd matches and whose created_at falls in the spawn
window, then binds it: tab title becomes the thread title, the list row gains
its has-term marker, terminal→thread links light up. Until then the tab shows
`<host>: <dir basename>`.

**Activity indicators**: per-terminal, server-tracked `lastOutputAt` (and
`lastInputAt`); the workspace bar marks non-visible screens with output since
last view (dot) and running-but-quiet-for-N-minutes (dim pulse — "probably
waiting for you"). List rows with a live terminal reuse the same signal. No
new plumbing — the PTY manager already sees every byte; expose timestamps on
GET /api/terminals and let the client derive states.

## API surface (server)

Existing: `/api/hosts`, `/api/threads` (aggregated + quick stats, mtime-cached),
`/api/threads/:host/:id` (overview), `…/turns`, `…/messages`, `…/view`.
Terminals: `GET/POST /api/terminals`, `DELETE /api/terminals/:id`,
`GET /api/terminals/:id/ws` (websocket; JSON text frames are control —
replay/exit/resize/ping/**associated** — and binary frames are raw pty bytes
both ways). New sessions: `GET /api/new-session/options` (launchable hosts,
hermes profiles, picker roots), `GET /api/new-session/preview` (the command
that _would_ run — the modal never composes one itself, so what is copied and
what is spawned cannot drift), `GET /api/fs/browse?path=`, `GET /api/quick-dirs`.
`POST /api/terminals` also takes `{newSession: {hostId, cwd, profile}}` or
`{shell: {cwd}}`.

Extend as slices need — keep endpoints coarse (one fetch per screen where possible)
and fast (avoid N+1 file opens; the aggregate list must stay instant on cached mtimes).

## Quality bar

- `vp check` clean; server stays up under `node --watch`.
- Every list/detail interaction should feel instant on ~40 threads / multi-MB thread
  files; no blocking the event loop with huge JSON payloads (cap content transport).
- Handle absent data gracefully everywhere: missing thread file, no view, no
  derivations, open turns, deleted messages.

### One-writer guard

Some sessions take one writer, and only those. On cc-lhc, two hosts attached to
the same session id fight over the rollout file: it freezes for one of them and
that side's turns are lost for good (this happened — a second
`cc-lhc --resume <sid>` started while the first was still alive).

So the guard is scoped by **host writer policy** (`writerPolicyFor` in
`packages/core/src/hosts.ts`, surfaced on `HostDescriptor.writerPolicy` and on
every launch recipe the API serves):

- **`"single"` — cc-lhc, codex-lhc.** Closed harnesses owning a rollout file that
  demonstrably (cc-lhc) or presumably (codex-lhc, same shape) takes one writer.
  These keep the full treatment: warn strip, "attach anyway", 409-unless-`force`.
- **`"shared"` — hermes, pi-lhc.** Both write through lhc's own store rather than
  a harness-owned rollout file, and a real hermes double-attach has been observed
  doing no harm. **This is not confirmed** — it is a presumption, and if a
  shared-host double-attach is ever seen to lose turns, move the host back to
  `"single"`. Multi-attach here is reported as neutral dim information ("also
  attached: pid 465727 · hermes --resume …"), the primary button stays an ordinary
  "open in terminal", and `POST /api/terminals` does not 409.

Before the console helps anyone attach on a single-writer host, it looks for a
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
`409 {error: "session in use", attached}` when something is attached to a
**single**-policy thread and the body lacks `force: true` — the idempotent "you
already have a terminal for this thread" return happens first, so the ordinary
path is unchanged. On shared-policy hosts POST never 409s for attachment. The
launch modal shows a warn strip with the offending pids and an "attach anyway"
button (posting `force`) on single-policy hosts, and a plain dim "also attached"
line on shared ones; list rows and the detail header carry a small `attached`
marker with the pid in the title, warn-coloured for single and dim-neutral for
shared.

**This is best-effort pattern matching, and it can miss.** It only matches
explicit session-id / thread-id arguments, so a host started fresh rather than
resumed is invisible: a bare `node …/cc-lhc/dist/bin.js` with no `--resume` (and
its `claude` child) is a real live writer that this guard does not see — a bare
`cc-lhc` line is deliberately not matched, because it could belong to any
session and matching it would flag every cc-lhc thread at once. Detection needs
a `sessionRef`, so a `--continue` fallback recipe gets no guard. False positives
are possible in the other direction: any command line that happens to contain
the id (a script, an editor, a `grep`) reads as an attachment. Treat a hit on a
single-writer host as a strong warning and a miss as "unknown" — never as
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

### Thread names

Host titles are not names — a cwd basename, a t3code uuid, a hermes timestamp
stem — and the list "summary" is the latest `chunk_summary_brief`, which is
about the last few turns rather than about the thread. So the console keeps its
own title and description per thread in the same prefs file
(`names`, keyed `hostId/threadId`, `{title, description, updatedAt}`), overlaying
what the hosts provide and never writing a host registry.

`PATCH /api/threads/:host/:id/name` with `{title?, description?}` is a partial
update: an absent field is untouched, null clears, both cleared deletes the
entry. Values are trimmed and capped (title 80, description 300) by
`packages/core/src/names.ts` — pure trim/cap/merge/normalize rules, so a
hand-edited prefs file reads exactly like one the API wrote. `/api/threads` rows
and the detail response carry `custom: {title, description} | null` **alongside**
the untouched host `title`; the client decides display (`custom.title ?? title`,
`custom.description ?? stats.summary`) and the search matches both.

UI: a dim ✎ on hover over the list's title and summary cells and next to the
detail title/description swaps the cell for an input — Enter saves (optimistic,
reverts with error styling on failure), Esc and blur cancel, and the editor
starts from what is STORED, not the displayed fallback, so Enter on an untouched
field cannot copy a registry title into the prefs. While an editor is open the
page's single-key shortcuts stand down. A displaced host title moves to the row
tooltip and stays visible as "registry title" in the detail Overview.
