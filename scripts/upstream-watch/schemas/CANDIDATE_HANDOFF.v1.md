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
upstream_base:    <public-git upstream tip merged into candidate; often equals patches_base>
upstream_range:   <old_public_upstream_sha>..<upstream_base>
merge_commit:     <full sha> | none
patches_base:     <contents of patches/BASE or patches/lhc/BASE after sync>
source_rev:       <Grok: contents of SOURCE_REV (xAI monorepo id); Codex: none or N/A>
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

## Grok identity triple (do not collapse)

These are **three different** values. Equality checks between monorepo and
public-git bases are **invalid** and will falsely fail candidate workflows.

| Field                            | Grok source                                           | Role                                                   |
| -------------------------------- | ----------------------------------------------------- | ------------------------------------------------------ |
| `candidate_sha`                  | `git rev-parse origin/lhc` (full)                     | Exact product tree to check out and build              |
| `source_rev`                     | repo file `SOURCE_REV`                                | **xAI monorepo** source revision (e.g. `27b3c666…`)    |
| `patches_base` / `upstream_base` | `patches/BASE` / public `upstream/main` tip merged in | **Public git** recovery / patch base (e.g. `8a14c91…`) |

- Manifests and handoffs must record **`source_rev` and `patches_base` separately**.
- Do **not** require `SOURCE_REV == patches/BASE` or `source_rev == upstream_base`.
- Do **not** treat monorepo `SOURCE_REV` as the git commit to check out; checkout is always **`candidate_sha`**.

Codex: `source_rev` may be `none`; `patches_base` remains the multi-patch BASE.

## Acceptance rules (consumer)

1. Reject if `tripwire` is not `GREEN`.
2. Qualify only **`candidate_sha`** exactly (no “nearby” tip).
3. For Grok: require non-empty `source_rev` (from `SOURCE_REV`) **and** non-empty
   `patches_base`; record both; never assert they are equal.
4. `recommended=HOLD` is still a valid handoff (document-only); do not publish.
5. Grok vs Codex evidence stays separate files / separate report instances.
6. Release workflows remain owned by the release qualifier (**codex-fork-steward**
   for both forks' qualify/promote lanes).

## When to emit

- After FORK.md sync drill for that fork: merge (if any), tripwire green,
  BASE/patches advanced, banner/members intact, FORK sync log entry.
- **Not** after a bare watch check.
