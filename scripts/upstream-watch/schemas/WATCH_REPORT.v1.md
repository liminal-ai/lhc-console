# WATCH_REPORT v1

Lightweight upstream observation for one fork. **Not** a release candidate.
Produced by the upstream owner (daily check, release-triggered assessment, or weekly reconciliation).

## Exact field block

Render as a single fenced block (or plain text file) with these keys, one per line,
`key:` + spaces + value. Do not invent keys. Use `none` for empty optional values.

```
WATCH_REPORT v1
fork:                   codex-lhc | grok-build-lhc
repo:                   liminal-ai/codex-lhc | liminal-ai/grok-build-lhc
checked_at:             <ISO-8601 UTC>
check_kind:             daily | release_event | weekly_reconcile | manual
last_seen_upstream_sha: <40-char sha or none>
upstream_sha:           <40-char sha of upstream/main after fetch>
origin_lhc_sha:         <40-char sha of origin/lhc>
origin_main_sha:        <40-char sha of origin/main or none>
behind:                 <non-negative integer: origin/lhc..upstream/main>
ahead:                  <non-negative integer: upstream/main..origin/lhc>
upstream_release_event: none | tag:<name> | release:<tag>
changed_paths_themes:   <shortstat and/or path themes; or none>
action:                 none | assess | sync_candidate
notes:                  <optional one line; or none>
state_path:             <path to durable last-seen file written; or none>
produced_by:            upstream-owner
```

## Semantics

| Field | Meaning |
| --- | --- |
| `behind` / `ahead` | Counts of commits between `origin/lhc` and `upstream/main` after fetch |
| `action=none` | No change vs last-seen, or behind=0 and no release event |
| `action=assess` | New upstream tip and/or official release/tag event; human/agent should read themes |
| `action=sync_candidate` | Weekly reconcile or policy threshold: fork should run sync drill (still **no auto-merge**) |
| `upstream_release_event` | New upstream **tag names** vs durable `known_upstream_tags` baseline (independent of tip movement). First baseline of historical tags emits `none`. |

## Durable state (per fork)

In `~/.lhc-console/upstream-watch/<fork>.json` (when `--update-state`):

- `last_seen_upstream_sha` — last observed upstream branch tip
- `known_upstream_tags` — tag **names** already seen on the upstream remote

Fetch must obtain tags (explicit tag refspec in `fetch_upstream_refs`) and
`ls-remote --tags` is used for the remote tag set.

## Policy

- Daily lightweight check may update last-seen only when the operator opts in
  (`--update-state`) or when the installer timer is configured to update.
- Default watch writes reports; state update is explicit to avoid silent drift
  during dry runs.
- Never merge upstream from a WATCH_REPORT alone.
- Exit code `2` means attention (`assess` / `sync_candidate`); systemd units
  mark it successful via `SuccessExitStatus=2`.
