# Upstream owner — Codex + Grok LHC forks (LIM-40)

**Owner seat:** cross-fork **upstream management** (monitor official upstream,
assess changes, merge when authorized, repair compatibility, hand off coherent
candidates).

**Not owned here:** GitHub promote/publish execution. **Release qualification
for both forks** is owned by **codex-fork-steward**. Upstream owner stops at
**CANDIDATE_HANDOFF** (and may help record PROMOTION_READY).

## Approval model (Lee / CTO)

| May continue **without** Lee          | Requires **stop / escalate**              | Requires **explicit Lee or CTO approval**   |
| ------------------------------------- | ----------------------------------------- | ------------------------------------------- |
| Routine watch, assessment             | Consequential **product** decisions       | **Promotion** of a qualified exact artifact |
| Compatible upstream sync + repair     | Unsafe **history** changes (reset)        |                                             |
| Handoff, candidate build, Linux smoke | Material **cost/risk**                    |                                             |
|                                       | **Failed gates** (tripwire/smoke/qualify) |                                             |

**Never automatic:** tag/publish/promote without the approval path below.
Routine merge of compatible upstream is **not** blocked on Lee.

### Promotion coordination (durable)

1. Qualifier finishes exact-artifact Linux smoke → records **PROMOTION_READY v1**
   (`promotion_ready.py record`) with fork, version, `source_sha`, run ids, digests.
2. Package is stored under `~/.lhc-console/upstream-watch/promotion_ready.json`
   with stable **`approval_id`** (hash of exact identity).
3. **CTO** is notified (`lhc-agent start cto`). CTO may **async** notify Lee
   (`lhc-agent lee "…"` with the same block) — Lee need not be in the qualify loop.
4. Approval:
   `python3 scripts/upstream-watch/promotion_ready.py approve <approval_id> --by cto|lee`
   Optional `--expect-source-sha` / `--expect-*-digest` **refuse** if bytes differ.
5. On approve, **codex-fork-steward** is notified with the **same** digests/run ids
   so promote can resume **without rebuild**.
6. Duplicate/late approval cannot retarget different bytes (identity is keyed by
   digests; mismatch → hard fail).

Schema: [`../scripts/upstream-watch/schemas/PROMOTION_READY.v1.md`](../scripts/upstream-watch/schemas/PROMOTION_READY.v1.md).

### Residual (do not fake)

Console/relay **does not** bind `approval_id` into GitHub Actions
`environment: production` gates. Promote workflows still take
`version` + `candidate_run_id` + `smoke_run_id` (and re-verify digests in-job).
**Human/agent discipline:** only dispatch promote with inputs from an
**approved** package in `promotion_ready.json`.

**Smallest follow-up (not this change):** optional promote workflow input
`approval_id` + job step that loads the store (or a checked-in attestation)
and asserts digests match artifacts before publish — coordinate with console

- qualifier.

### After promote succeeds (Lee one-off)

**Only after** CTO-approved promotion **and** public release verification
pass, the release qualifier sends Lee **exactly one** concise notification:

```bash
python3 scripts/upstream-watch/release_notify.py lee-success \
  --fork grok-build-lhc \
  --version 0.2.1 \
  --product "Grok Build LHC" \
  --summary "Long-horizon context on by default with Replace compact." \
  --platforms "Linux x86_64" \
  --limitations "Windows and macOS not published in this cut."
```

| Rule           | Detail                                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------- |
| Timing         | **After** public verify success — never before, never on PROMOTION_READY alone                      |
| Content        | Product/version; plain what-changed; published platform(s); material limitation/action if any       |
| Omit           | Raw run IDs, digests, internal process (success path)                                               |
| Dedupe         | Exact **fork + tag** in `dispatched.json` (`lee_release_success:…`) — retries do not double-message |
| Failure verify | Optional `lee-failure` only if public verification failed                                           |

Schemas (exact):

- [`../scripts/upstream-watch/schemas/WATCH_REPORT.v1.md`](../scripts/upstream-watch/schemas/WATCH_REPORT.v1.md)
- [`../scripts/upstream-watch/schemas/CANDIDATE_HANDOFF.v1.md`](../scripts/upstream-watch/schemas/CANDIDATE_HANDOFF.v1.md)
- Grok product seams for qualification: coordinate with codex-fork-steward
  (Linux-only lane, default-on LHC). Identity triple: `candidate_sha` (product
  tip), `source_rev` from file `SOURCE_REV` (xAI monorepo), `patches_base` /
  public-git `upstream_base` — **never require monorepo ≡ public BASE**

Automation: [`../scripts/upstream-watch/`](../scripts/upstream-watch/).

Fork product drills remain authoritative per tree:

- Grok: `/srv/work/grok-build/FORK.md`
- Codex: `/srv/work/codex/FORK.md`

---

## Roles

| Role              | Agent key                                                        | Responsibility                                                                                                              |
| ----------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Upstream owner    | `grok-build-fork-steward` (interim host seat; duties cross-fork) | Watch, assess, sync drill, tripwire, **CANDIDATE_HANDOFF** for both forks                                                   |
| Release qualifier | `codex-fork-steward`                                             | **Qualify both forks**: handoff → candidate → smoke; record **PROMOTION_READY**; promote **only** after correlated approval |
| Portfolio CTO     | `cto`                                                            | Receives PROMOTION_READY; may async Lee; records approve/reject                                                             |
| Lee               | `lhc-agent lee`                                                  | Async one-way; may approve via operator running `promotion_ready.py approve --by lee`                                       |
| Control plane     | `console`                                                        | Relay/monitors; not merge/promote authority                                                                                 |

Registry live file: `~/.lhc-console/agents.json` (owner-only). Documented duty
strings should match this split — see §Registry wording.

---

## Durable state

Per fork file: `~/.lhc-console/upstream-watch/<fork-id>.json`

| Key                      | Purpose                                                |
| ------------------------ | ------------------------------------------------------ |
| `last_seen_upstream_sha` | Last observed `upstream/main` tip                      |
| `known_upstream_tags`    | Stable set of upstream tag **names** already baselined |

**Tag / release detection:** independent of tip movement. First successful
`--update-state` run **baselines** all current remote tags with **no**
`upstream_release_event` (avoids flooding on historical tags). Later runs emit
`tag:<name>[,…]` only for tag names not in `known_upstream_tags`, including a
new tag on an **unchanged** tip. Fetch pulls tags via explicit refspec (see
`fetch_upstream_refs`).

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
- Systemd units set `SuccessExitStatus=2` so attention is not a failed service
- **`--dispatch` (enabled on installed timers):** on attention only, dedupe-dispatch
  `lhc-agent start` to **`grok-build-fork-steward`** (upstream-owner). Durable keys in
  `~/.lhc-console/upstream-watch/dispatched.json`. Failures append
  `reports/DISPATCH_FAILURES.log`.
- **Never** dispatches to **codex-fork-steward** from raw watch — release qualification
  starts only from an explicit QUALIFY `CANDIDATE_HANDOFF` (see below).
- **No merge.** If `action=assess`, upstream-owner assesses and, if authorized, runs
  FORK sync drill.

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

If either fork reports `action=sync_candidate`, run that fork's **FORK.md sync
drill** in its repo (manual / authorized session). After green tripwire, emit
**CANDIDATE_HANDOFF** (not a stub) to **codex-fork-steward**.

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
2. Fill every field in `CANDIDATE_HANDOFF v1` (see schema). For Grok, also
   satisfy release-qualifier product seams (Linux artifact identity,
   default-on / Replace / `~/.grok-lhc`, tripwire evidence URL/path) and the
   **identity triple**: `candidate_sha`, `source_rev` (`SOURCE_REV` monorepo
   id), `patches_base` (public-git recovery base) — **separate**, not equal.
   Helper stub only (pre-sync):
   `python3 scripts/upstream-watch/upstream_watch.py --emit-handoff-stub --fork grok-build-lhc`
3. Send QUALIFY handoff to **codex-fork-steward** (deduped):

   ```bash
   python3 scripts/upstream-watch/dispatch.py handoff /path/to/CANDIDATE_HANDOFF.txt
   ```

   Only `tripwire: GREEN` + `recommended: QUALIFY` + full 40-char `candidate_sha`
   are sent. HOLD/RED handoffs are skipped (not release work).

4. Stop. Do not promote or publish.

---

## Schedule integration (CTO installs after review)

Unit files (not enabled by this change) — **all four**:

| File                                       | Role            |
| ------------------------------------------ | --------------- |
| `deploy/lhc-upstream-watch.service`        | Daily oneshot   |
| `deploy/lhc-upstream-watch.timer`          | Daily calendar  |
| `deploy/lhc-upstream-watch-weekly.service` | Weekly oneshot  |
| `deploy/lhc-upstream-watch-weekly.timer`   | Weekly calendar |

Proposed install (CTO) — copy **every** unit explicitly (do not rely on a
partial glob that might miss weekly units):

```bash
mkdir -p ~/.config/systemd/user
cp -f \
  /srv/work/lhc-console/deploy/lhc-upstream-watch.service \
  /srv/work/lhc-console/deploy/lhc-upstream-watch.timer \
  /srv/work/lhc-console/deploy/lhc-upstream-watch-weekly.service \
  /srv/work/lhc-console/deploy/lhc-upstream-watch-weekly.timer \
  ~/.config/systemd/user/
# equivalent: cp -f /srv/work/lhc-console/deploy/lhc-upstream-watch*.service \
#                  /srv/work/lhc-console/deploy/lhc-upstream-watch*.timer \
#                  ~/.config/systemd/user/
systemctl --user daemon-reload
# Review first; enable only after CTO approval:
# systemctl --user enable --now lhc-upstream-watch.timer
# systemctl --user enable --now lhc-upstream-watch-weekly.timer
```

Verify units before enable:

```bash
systemd-analyze --user verify \
  ~/.config/systemd/user/lhc-upstream-watch.service \
  ~/.config/systemd/user/lhc-upstream-watch.timer \
  ~/.config/systemd/user/lhc-upstream-watch-weekly.service \
  ~/.config/systemd/user/lhc-upstream-watch-weekly.timer
```

Logs: `journalctl --user -u lhc-upstream-watch.service`.

---

## Registry wording (suggested)

**`grok-build-fork-steward` duties:**

- cross-fork upstream watch (codex-lhc + grok-build-lhc)
- upstream merge and compatibility repair when authorized
- CANDIDATE_HANDOFF to release qualifier (both forks)
- grok product seat / dogfood

**`codex-fork-steward` duties:**

- release qualification for **both** codex-lhc and grok-build-lhc
- consume CANDIDATE_HANDOFF; run candidate/smoke/promote
- slice validation (codex)
- does not own daily cross-fork upstream watch

Live `~/.lhc-console/agents.json` is operator-owned; change only with console
care (owner-only file mode).

---

## Tests

```bash
cd /srv/work/lhc-console/scripts/upstream-watch
# Re-execs under empty HOME with isolated git identity
python3 test_upstream_watch.py
```

---

## Non-goals

- Auto-merge of `upstream/main`
- Editing release workflows owned by the release qualifier
- Enabling systemd timers without CTO review
- Single shared tripwire (host tripwires stay distinct)
