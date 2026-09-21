# spec-group: a group line for Lee, Sable, and Flint (v2 brief)

Owner: Lee. Point of contact: Reed. Builder and orchestrator: Wrenn (own worktree off `main`, own subagents, own continuation).
Supersedes `docs/group-line-brief.md` (Sept 6) and the uncommitted draft in `/srv/work/wt/lhc-console-group-line`
(branch `feat/group-line`, base 25ee962: registry `group` schema, catch-up store trim/labels, fan-in delivery). Salvage what
fits; that draft copies rows per member, this brief uses one transcript with cursors.

## Goal
Lee texts one iMessage number (contact name `spec-group`) and tagged agents answer in that thread, each seeing what the others
said only when Lee brings them back in. Photon shared-pool lines cannot join real iMessage groups, so the console fakes the
group over a DM, and the core is channel-agnostic so a second owner-side view (console web page) works without iMessage.

## Semantics (fixed)
1. Wake only by name. A message from Lee wakes each member whose `mentionPatterns` match, or all members on `@all` / `@everyone`.
   Untagged text wakes nobody; it enters the transcript only.
2. Replies go only to Lee. A member's reply is delivered to Lee's transports with the member's display name prefixed
   (`**Flint:** ...` on iMessage). It is never delivered to another member as a message.
3. History rides in on the next wake. A tagged member's prompt is: the transcript since that member's cursor (Lee's lines and
   the other members' replies, each labeled by display name, oldest first), then `[New message]` with Lee's text.
4. The new message is always Lee's. Other members' replies appear only inside the history block.
5. Tag both, both catch up: each wakes with the other's replies in history and Lee's follow-up as the new message.
6. Own replies excluded from own history: at fan-in, the member's cursor moves past its own reply.
7. Only owner senders (`ownerSenderIds`) count on the line; anything else is dropped before any turn, as today.

## Shape
**Registry.** `agents.json` entry `spec-group`: `channels.photon` (own line), `ownerSenderIds`, `mentionPatterns` for the
`@all` forms, and `"group": { "members": ["sable", "flint"], "catchUp": "all" }`. No `relay`, no `v2`; a group is never a
relay target. Reject unknown members, members that are groups, members without a relay target, fewer than two, duplicates.
`catchUp`: `all` (default), `last` (no history), `{ "messages": N }`.

**Transcript (source of truth).** One sqlite per group under `~/.lhc-console/agents/<group>/transcript.sqlite`:
`messages(seq, sender_id, sender_label, text, at, job_id NULL, inbound_message_id NULL)` and `cursors(member_id, seq)`.
Every owner message and every member reply is written here first. Idempotent on inbound message id and on job id.
Byte cap with trim-oldest and one `[N earlier messages trimmed]` marker line; never refuse a wake for size.

**Router (core, no channel knowledge).** `routeGroupMessage(group, members, text, wake?) -> { wakes: memberId[] }`
as a pure function with tests. On an owner message: append to transcript; for each woken member build the prompt
(history since cursor via the existing `renderRelayPrompt` shape, Lee's text verbatim: no tag stripping, since removing
a member's own name from "Sable, Flint ..." made it read as addressed to the other one) and enqueue one relay
job `target = member`, prioritized, header `[from: lee, channel: iMessage group spec-group]` (or `web group spec-group`),
existing phone-reply trailer, delivery metadata `{ kind: "group_line", groupId, memberId, memberLabel, wakeSeq }`.

**Fan-in.** On a member job's completion: append the reply to the transcript (sender = member), advance that member's cursor
to the reply's seq, then deliver to each transport the group enables. Failure notices are delivered prefixed but not written
to the transcript. Reuse last night's delivery receipts and permanent-failure classification (`a92b61f`).

**Transports.**
- iMessage: the group's Photon connector. Inbound owner DM -> router. Fan-in -> `photonConnectors.send(group, notifySpaceId,
  "**<Label>:** " + text)`. The only channel-specific code is the prefix and the first-contact rule.
- Web (slice 2): `GET /api/groups`, `GET /api/groups/:id/messages?since=<seq>`, `POST /api/groups/:id/messages { text }`
  (owner token, loopback; the web app already proxies `/api` and is served on the tailnet). A page in `apps/web` that lists
  the transcript by sender label and posts new messages into the same router. Pull-based; no delivery job for web.

## Slices
1. Core + iMessage: registry, transcript, router, wake prompt, fan-in, Photon transport, tests. Provision the `spec-group`
   Photon line (photon CLI is logged in; follow `docs/photon-seat-provisioning.md`), install by candidate + validate +
   `registry-swap-watchdog.sh` in a quiet relay window, then tell Reed the number so Lee texts it first.
2. Web view: endpoints + page + tests. Same transcript, same router.

## Tests
Router pure-function cases (tag one, tag both, `@all`, untagged, unknown tag); wake prompt contents per rule 3/4/6;
fan-in writes transcript, advances only the sender's cursor, delivers prefixed, failure not written; registry rejections;
idempotent redelivery. Existing server and web suites stay green (A13 in v2-photon-ingress is a known pre-existing failure).

## Out of scope
Members waking each other, non-owner participants, V2 control syntax on the line, typing indicator (only if free),
changes to how member seats behave in their own DMs, t3code changes of any kind.

## Live test (Lee + Wrenn)
Lee texts spec-group: `@flint @sable we're in a group, respond`; both reply in-thread with name prefixes. Lee talks to Flint
alone for a few turns, then tags Sable; Sable's turn opens with the history block containing Lee's lines and Flint's replies
and nothing of her own. Then the same from the web page.

## Operating contract for this build
Wrenn owns the outcome end to end: continuation (a goal on `wrenn`, sensible cadence), subagents (`grok-subagent` or the
subagent CLIs as he chooses), verification, install, and the live test with Lee. Reed does not poll. Wrenn sends Reed a
delivery message by relay at exactly these points: brief accepted (with any decision he made that the brief left open),
slice 1 live with the number, slice 2 live, or blocked with the reason. Lee asks Reed for status; Reed asks Wrenn then.
