# Group line for the control plane (v1, plain build)

Owner: Lee. Gate: Steward (Fable). Builder: Wren. Repo: lhc-console, branch off `main`, own worktree.
Grade: current control plane is throwaway. Straightforward code that does the job. No new abstractions,
no framework, no config system. The fancy version belongs to the next control plane, not here.

## Goal
Lee texts one iMessage line and two or more agents read it, answer in that same thread, and each sees
what the others said. Photon shared-pool lines cannot join real iMessage groups, so the console fakes
the group over a DM.

## Shape (all in the console)
1. **Group line.** A registry entry in `agents.json` like any seat, with its own Photon project/line
   (Lee provisions it), `ownerSenderIds`, and one new field:
   `"group": { "members": ["flint", "sable"], "catchUp": "all" }`.
   A group entry has no relay target of its own; the console never runs a turn *as* the group.
   Members are existing registry ids. Reject unknown members at load.
2. **Router.** Inbound owner DM on a group line does not enqueue one job. For each member:
   - If the text matches that member's own `mentionPatterns` (from the member's registry entry), or
     matches `@all` / `@both` / `@everyone`, the member **wakes**: one relay job, `target = member`.
   - Otherwise the message is **buffered** into that member's group backlog.
   Untagged text from Lee wakes nobody and buffers for everyone. Only owner senders count; anything
   else on the line is dropped as today.
3. **Group-shaped turn** for a woken member:
   ```
   [from: lee, channel: iMessage group <group name>]
   <catch-up block: messages this member has not seen, oldest first, or nothing>

   [New message]
   <Lee's text verbatim (no tag stripping: the header names the group; the addressee is clear from the tags)>

   <existing PHONE_REPLY_GUIDANCE trailer>
   ```
   Reuse `renderRelayPrompt` and the catch-up store's `formatChannelContext`. Labels in the block are
   `lee` for the owner and the member display `name` for agents. Everything is authorized, so no
   `[unverified]` tags appear. One lead sentence at the top of the block: group name, and "reply only to
   the new message; the rest is catch-up."
4. **Fan-in.** When a member's job delivers, the text goes to the group line's DM via the *group's*
   connector (not the member's), prefixed with the member's display name in bold, e.g. `**Flint:** ...`.
   Then the reply is appended to every *other* member's group backlog with the member as sender.
   A member's own replies never enter its own backlog. Failure notices are prefixed the same way and
   are not appended to anyone's backlog.
5. **Catch-up setting** on the group entry, default `all`:
   - `all`: full backlog.
   - `last`: no backlog, only the new message.
   - `window`: `{ "messages": N }`, last N backlog lines.
   Backlog cap: keep a high byte cap, but when exceeded **trim oldest and insert one marker line**
   `[N earlier messages trimmed]`. Never refuse a wake because the backlog is large.

## Storage
Per-member backlog keyed by (group id, member id). Simplest: reuse `GroupCatchUpStore` with a chat key
like `group:<groupId>:<memberId>` in one sqlite under `agents/<groupId>/`. Cursor advance after delivery
works as it does for `photon_group_wake` today; carry `connectorAgentId` in delivery so `relay-delivery`
routes through the group's connector (the outbound-lee path already does this).

## Out of scope for v1
Agents waking each other (Flint tagging Sable does nothing), V2 control syntax on the group line,
stream mode, non-owner participants, typing indicator on the group line (do it only if it falls out
of the existing coordinator for free), any change to how member seats behave in their own DMs.

## Constraints
- Do not touch the live plane: no registry swap, no `lhc-console.service` restart, no writes under
  `~/.lhc-console`. Install and the Photon line are the Steward's job.
- Work in a worktree off `main`; commit on the branch; do not merge.
- Tests: the router as a pure function (inbound text + member patterns -> wakes/buffers per member;
  a delivered reply -> fan-in targets and prefixed text). Existing suite stays green.
- Report back: branch, commit, diff stat, the exact `agents.json` snippet for a group, and anything
  you chose that the brief did not decide.

## Live test after install (Steward + Lee)
Lee saves the group line as a contact, texts "@flint @sable we're in a group, can you each respond".
Both reply into the thread with name prefixes. Lee then talks to Flint alone for a few turns and tags
Sable; Sable's turn opens with the catch-up block containing Lee's lines and Flint's replies.
