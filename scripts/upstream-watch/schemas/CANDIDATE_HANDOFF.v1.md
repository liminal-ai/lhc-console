# CANDIDATE_HANDOFF v1

Coherent post-sync tip ready for **release qualification** (not publication).
Produced only by the upstream owner after a completed sync drill + green tripwire.
Consumed by **codex-fork-steward** (release qualification for **both**
codex-lhc and grok-build-lhc). Upstream owner does **not** publish GitHub
Releases or run promote workflows.

## Exact field block

```
CANDIDATE_HANDOFF v1
fork:             codex-lhc | grok-build-lhc
repo:             liminal-ai/codex-lhc | liminal-ai/grok-build-lhc
branch:           lhc
candidate_sha:    <full 40-char sha of origin/lhc tip to qualify>
upstream_remote:  <fetch URL of upstream remote>
upstream_base:    <full sha of upstream/main merged into candidate>
upstream_range:   <old_upstream_sha>..<new_upstream_sha>
merge_commit:     <full sha> | none
patches_base:     <contents of patches BASE after sync>
lhc_sdk_pin:      <vendor submodule sha or none>
tripwire:         GREEN | RED
tripwire_summary: <one line or path to log>
compat_repairs:   <semicolon-separated brief list or none>
risks:            <semicolon-separated themes or none>
recommended:      QUALIFY | HOLD
reason:           <one short paragraph>
evidence:         <URLs or paths; FORK sync entry>
produced_by:      upstream-owner
produced_at:      <ISO-8601 UTC>
not_in_scope:     release publish; smoke promote; version bump unless requested
```

## Acceptance rules (consumer)

1. Reject if `tripwire` is not `GREEN`.
2. Qualify only **`candidate_sha`** exactly (no “nearby” tip).
3. `recommended=HOLD` is still a valid handoff (document-only); do not publish.
4. Grok vs Codex evidence stays separate files / separate report instances.
5. Release workflows remain owned by the release qualifier (**codex-fork-steward**
   for both forks' qualify/promote lanes).

## When to emit

- After FORK.md sync drill for that fork: merge (if any), tripwire green,
  BASE/patches advanced, banner/members intact, FORK sync log entry.
- **Not** after a bare watch check.
