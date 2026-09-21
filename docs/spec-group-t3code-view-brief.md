# Group chat view in t3code (spec-group slice 3)

Owner: Lee. Contact: Reed. Builder and orchestrator: Wrenn (own worktree off t3code `main`, own subagents, own continuation).
Depends on `docs/spec-group-brief.md` slices 1 and 2 (live).

## Goal
A group-chat UI inside the t3code fork, optimized for the group line: a "Groups" category in the LHC sidebar and a page per
group that renders the console's transcript and posts through the console's router. The console stays the source of truth;
t3code learns nothing about groups beyond proxying and rendering. Lee's running spec-group conversation must continue from
the new page with no gap: same transcript, same cursors, phone keeps working alongside.

## Shape
**Server (t3code fork).** One HTTP layer, `/api/groups/*` -> `http://127.0.0.1:5959/api/groups/*`, adding the console owner
token read from `~/.lhc-console/relay-token`. Precedent: `otlpTracesProxyRouteLayer` in `apps/server/src/http.ts`. The
browser never holds the console token; t3code's own pairing auth is the boundary.

**Console.** Require the owner bearer on the group routes now that t3code proxies (closes the unauthenticated POST; the console
web page sends the token it already has for the relay routes, or drop that page). `GET /api/groups/:id` returns members with
display labels and each member's cursor seq.

**Sidebar.** A "Groups" section in `LhcSidebar` (fork-owned) listing the console's groups, above or below Agents, same row
style. Selecting one navigates to the group page. Fork-only files; no upstream sidebar file touched beyond the existing hook.

**Page.** `apps/web/src/routes/_chat.groups.$groupId.tsx` (precedent for a non-thread page in the chat shell:
`_chat.pull-requests.tsx`). Renders the transcript oldest-first with sender labels, Lee's lines right-aligned or otherwise
distinct, member replies via the existing `ChatMarkdown`. Polls `since=<seq>` every 2s while open. Composer: plain textarea,
`@` autocomplete over member keys plus `@all`, Enter sends, shows who the draft wakes before send (same router rule as the
phone: untagged wakes nobody). Mobile drawer and phone widths must work as the thread pages do.

**Nice, only if cheap.** Per-member "read to here" marker from the cursor seq. Click a member reply to open that turn in its
own thread (job id -> t3code turn). Desktop notification on a new member reply while the page is open.

## Constraints
- Fork-owned files: new route, new sidebar section, one proxy layer, tests. Any upstream file touched gets a line in FORK.md's
  Copies/inventory table. No version bump, no tag, no release.
- Install: local archive build (as `0.0.40-lhc.7-local.1` was), activation on 3773 by t3code-steward at an idle window (it
  restarts Claude seats, Reed's included). Wrenn coordinates that directly; Reed is not in the loop.
- Tests: proxy layer (token attached, console errors passed through), sidebar section renders groups, page renders a
  transcript fixture and posts through the proxy, wake-preview logic as a pure function. Existing suites green.

## Live test (Lee + Wrenn)
Open `#/groups/spec-group` on 3773: the existing conversation is all there. Send `@sable @flint <question>` from the page:
both reply on the page and on Lee's phone; their history blocks contain Lee's page message. Then Lee replies from the phone
and the page shows it within 2s. Same on a phone-width browser.

## Operating contract
Wrenn owns the outcome end to end (goal on `wrenn`, subagents, verification, install with the steward, live test with Lee).
Reed does not poll. Wrenn messages Reed only at: brief accepted (with decisions made), live on 3773, or blocked.
