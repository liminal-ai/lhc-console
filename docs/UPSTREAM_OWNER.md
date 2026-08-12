# Upstream owner — Codex + Grok LHC forks (LIM-40)

**Owner seat:** cross-fork **upstream management** (monitor official upstream,
assess changes, merge when authorized, repair compatibility, hand off coherent
candidates).

**Not owned here:** GitHub Release publication, candidate smoke promote, or
Codex `lhc-release*` workflows — those are **release qualification**
(**codex-fork-steward** for codex-lhc; Grok publish only under explicit release
ownership).

**Policy (Lee / CTO):**

| Cadence | Action |
| --- | --- |
| **Daily** | Lightweight check: fetch + `WATCH_REPORT` (no merge) |
| **Official upstream release/tag** | Assessment `WATCH_REPORT` (`check_kind=release_event`) |
| **Weekly** | Reconciliation: `WATCH_REPORT` with `check_kind=weekly_reconcile`; if `behind>0` → `action=sync_candidate` |
| **Never automatic** | Merge, tag, publish, promote |

Schemas (exact):

- [`../scripts/upstream-watch/schemas/WATCH_REPORT.v1.md`](../scripts/upstream-watch/schemas/WATCH_REPORT.v1.md)
- [`../scripts/upstream-watch/schemas/CANDIDATE_HANDOFF.v1.md`](../scripts/upstream-watch/schemas/CANDIDATE_HANDOFF.v1.md)

Automation: [`../scripts/upstream-watch/`](../scripts/upstream-watch/).

Fork product drills remain authoritative per tree:

- Grok: `/srv/work/grok-build/FORK.md`
- Codex: `/srv/work/codex/FORK.md`

---

## Roles

| Role | Agent key | Responsibility |
| --- | --- | --- |
| Upstream owner | `grok-build-fork-steward` (interim host seat; duties cross-fork) | Watch, assess, sync drill, tripwire, **CANDIDATE_HANDOFF** |
| Release qualifier | `codex-fork-steward` | Consume handoff; smoke/qualify; promote/publish **only** their release path |
| Control plane | `console` | Relay/monitors that may schedule watch; not merge authority |

Registry live file: `~/.lhc-console/agents.json` (owner-only). Documented duty
strings should mention cross-fork upstream for the upstream owner and release
qualification for the Codex steward — see §Registry wording.

---

## Daily lightweight check

```bash
cd /srv/work/lhc-console
python3 scripts/upstream-watch/upstream_watch.py \
  --check-kind daily \
  --write-reports \
  --update-state
```

- Durable state: `~/.lhc-console/upstream-watch/<fork-id>.json`
- Reports: `~/.lhc-console/upstream-watch/reports/WATCH_<fork>_latest.txt`
- Exit codes: `0` quiet; `2` attention (`assess` / `sync_candidate`); `1` tool failure
- **No merge.** If `action=assess`, read themes and decide whether to schedule a sync drill.

### Official release / tag trigger

When an upstream release or tag is noticed (watch field `upstream_release_event`
or human alert):

```bash
python3 scripts/upstream-watch/upstream_watch.py \
  --check-kind release_event \
  --write-reports \
  --update-state
```

Then open a short assessment (path themes, risk to hooks/compact/ACP) in the
upstream-owner thread. Still **no auto-merge**.

---

## Weekly reconciliation

```bash
python3 scripts/upstream-watch/upstream_watch.py \
  --check-kind weekly_reconcile \
  --write-reports \
  --update-state
```

If either fork reports `action=sync_candidate`, run that fork’s **FORK.md sync
drill** in its repo (manual / authorized session). After green tripwire, emit
**CANDIDATE_HANDOFF** (not a stub).

### Sync drill pointers (do not fork the steps here)

1. Grok — `/srv/work/grok-build` · `FORK.md` § Sync drill  
   Tripwire: `./scripts/check-lhc-hooks.sh`  
   Remember: README banner, `patches/BASE`, FF `main`.
2. Codex — `/srv/work/codex` · `FORK.md` § Sync drill  
   Tripwire: `./scripts/check-lhc-hooks.sh`  
   Remember: regenerate **all** `patches/lhc/0001–0007` after BASE advance.

Preserve **distinct evidence** per fork (separate reports, separate handoffs).

---

## CANDIDATE_HANDOFF (after real sync)

1. Complete FORK sync + tripwire **GREEN**.
2. Fill every field in `CANDIDATE_HANDOFF v1` (see schema).  
   Helper stub only (pre-sync):  
   `python3 scripts/upstream-watch/upstream_watch.py --emit-handoff-stub --fork codex-lhc`
3. Send the block to **codex-fork-steward** via `lhc-agent` (one-shot or start job).
4. Stop. Do not run `lhc-release-promote` / Grok tag publish from this role.

---

## Schedule integration (CTO installs after review)

Unit files (not enabled by this change):

- [`../deploy/lhc-upstream-watch.service`](../deploy/lhc-upstream-watch.service)
- [`../deploy/lhc-upstream-watch.timer`](../deploy/lhc-upstream-watch.timer) — daily
- [`../deploy/lhc-upstream-watch-weekly.timer`](../deploy/lhc-upstream-watch-weekly.timer) — weekly reconcile

Proposed install (CTO):

```bash
mkdir -p ~/.config/systemd/user
cp /srv/work/lhc-console/deploy/lhc-upstream-watch.* ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now lhc-upstream-watch.timer
systemctl --user enable --now lhc-upstream-watch-weekly.timer
```

Logs: journalctl `--user -u lhc-upstream-watch.service`.  
Optional later: wire report path into a console monitor / one-shot to upstream owner.

---

## Registry wording (suggested)

**`grok-build-fork-steward` duties** (add/adjust):

- cross-fork upstream watch (codex-lhc + grok-build-lhc)
- upstream merge + compatibility repair when authorized
- CANDIDATE_HANDOFF to release qualifier
- grok product seat / dogfood (existing)

**`codex-fork-steward` duties** (add/adjust):

- release qualification for codex-lhc (candidate smoke/promote)
- consume CANDIDATE_HANDOFF; do not own daily upstream watch for both forks
- slice validation (existing)

Live `~/.lhc-console/agents.json` is operator-owned; change only with console
care (owner-only file mode).

---

## Tests

```bash
cd /srv/work/lhc-console/scripts/upstream-watch
python3 test_upstream_watch.py
```

---

## Non-goals

- Auto-merge of `upstream/main`
- Editing Codex `lhc-release*.yml` or Grok release publish from this role
- Single shared tripwire (host tripwires stay distinct)
