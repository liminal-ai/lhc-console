# Sidebar activity indicators (spec-group slice 5)

Owner: Lee. Contact: Reed. Builder and orchestrator: Wrenn (own worktree off t3code `main`, own goal). Read-only until accepted.

## Lee's feedback, verbatim in substance (2026-09-22)
"In the list of threads on the side, there's no indication anything's happening. I can't tell when there's new activity on a thread or when something's finished, nor can I tell if something's in progress. There was some laziness in setting that up on the side; a lot of basic capability isn't there."

## What exists today (evidence, t3code main 359816b6f4)
- Agent rows (`LhcAgentsSection.tsx:575-582`): text label "Running" while a turn runs, else a relative age; an unread marker only via `hasUnseenCompletion` when not running. No pulse/spinner, no distinction between running / just finished / unseen. Upstream's row uses `resolveThreadStatusPill` with a pulsing dot for running and terminal-status colors (`LegacySidebar.tsx:500,864`); the LHC row does not.
- Roundtable rows (`LhcGroupsSection.tsx`): name + members only. Working state and new-reply state are known to the page (2 s poll) but the list is polled every 30 s (`lhcGroups.ts:108`) and the sidebar dot was excluded in slice 4.

## Required
Every row in Agents and Roundtable must answer three questions at a glance, matching the stock thread row's vocabulary so it reads as one app:
1. **In progress**: pulsing status dot + "Running" (agents) / "Sable, Flint working" or "1 working" (roundtable), using upstream's status pill styles (`resolveThreadStatusPill`, `animate-status-pulse`), not a bare text label.
2. **New since I last looked**: bold title + unread dot when a turn completed or a roundtable reply landed after the row's last visit; cleared on open. Agents: reuse `hasUnseenCompletion`/`lastVisitedAt`. Roundtable: track last-seen transcript seq per group (localStorage like the recipient checkboxes) against the console's latest seq.
3. **Finished / failed**: terminal state visible (completed check or failed color) for the most recent turn, with the relative age.
Roundtable freshness: while any group is working or the roundtable page is open, list/detail polling must be fast enough that the sidebar changes within ~2-5 s, not 30 s. Cheapest route: have the groups list endpoint return per-group `working` count and `latestSeq`, and poll it at 5 s while any group is working, 15 s otherwise.

## Constraints
Fork-only files; if a shared helper from upstream (status pill resolver) is used, import it, do not copy it. Tests: pure logic for the three states on both row kinds; existing suites green. Preview on a copy of Lee's userdata with screenshots of each state (running, unread, finished, failed; agents and roundtable; desktop + 390 px). Install as -local.4 via t3code-steward; the steward warns Reed before the 3773 restart and waits for Lee's go.

## Operating contract
Wrenn owns it end to end. Message Reed at: accepted (with decisions), ready for activation, live, or blocked. Lee will keep sending Roundtable feedback; Reed batches it into follow-on briefs.
