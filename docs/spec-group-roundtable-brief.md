# Roundtable: rename, activity indicators, default recipients (spec-group slice 4)

Owner: Lee. Contact: Reed. Builder and orchestrator: Wrenn (own worktree off t3code `main` at or after db82ea4012, own
subagents, own continuation goal). Depends on slices 1-3 (live: t3code 0.0.42-lhc.1-local.2, console with bearer on group routes).

## Lee's feedback, verbatim in substance
1. Call it "Roundtable", not "Groups".
2. There is no indication of which agent is still working. When one or more agents are working on a reply, show it the way
   a normal t3code thread shows a turn in progress, and show which agents.
3. Checkboxes in or around the composer for default recipients, so with both checked Lee does not have to type @sable or
   @flint every time.

## Rename
User-facing term is Roundtable everywhere in t3code: sidebar section label, page heading, route (`/roundtable/<id>`),
empty states, tooltips. Console API paths and the registry `group` key stay as they are; only the UI vocabulary changes.

## Activity: who is working
Source of truth is the console. A member is working from the moment the router creates its wake job until that job's reply
is delivered (relay job with delivery_metadata.kind=group_line for that member, status running). Extend
`GET /api/groups/:id` so each member carries `activity: {state: "working", wakeSeq, since} | {state: "idle"}`.
t3code renders, from the existing 2s poll:
- A member strip at the top of the page (name, live dot when working, cursor position optional).
- A pending row at the bottom of the transcript per working member ("Sable is working"), using the same in-progress
  indicator the thread view uses for a running turn; it is replaced by the reply when it lands.
- The Roundtable sidebar row shows the running indicator while any member is working (nice, only if cheap).

## Default recipients
One checkbox per member in the composer footer (label = member name), plus the existing wake preview.
- Checked members are woken by every send from this page without tags in the text. `POST /api/groups/:id/messages`
  gains an optional `wake: [memberId]`; the router unions it with the tags parsed from the text. Untagged text with no
  boxes checked still wakes nobody. `@all` still works.
- Checkbox state persists per roundtable per browser (localStorage). Phone/iMessage semantics unchanged: tags only.
- The wake preview reflects the union, so Lee always sees who a send reaches before pressing Enter.

## Tests
Router union (pure function), activity derivation from relay job state, composer wake logic with checkbox state,
route rename. Existing suites green. Console side gets tests for the extended group record and the `wake` field.

## Install
Console restart for the API change (no warning needed). t3code as a local archive, `-local.3`, activated by t3code-steward.
Standing rule from Lee: t3code-steward warns Reed before any 3773 restart and waits for Lee's go relayed by Reed.
Scratch test-group (steward) may still exist at build time; if you need a send-path retest, use it with test-a/test-b and
never spec-group, Sable, or Flint.

## Operating contract
Wrenn owns the outcome end to end. Reed does not poll. Wrenn messages Reed only at: brief accepted (with decisions),
ready for activation (then the steward's warning goes through Reed), live on 3773, or blocked.
