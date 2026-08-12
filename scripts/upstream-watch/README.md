# upstream-watch (LIM-40)

Cross-fork **upstream owner** tooling for `codex-lhc` and `grok-build-lhc`.

- Schemas: `schemas/WATCH_REPORT.v1.md`, `schemas/CANDIDATE_HANDOFF.v1.md`
- Config: `forks.json`
- CLI: `upstream_watch.py`
- Tests: `python3 test_upstream_watch.py`
- Runbook: `../../docs/UPSTREAM_OWNER.md`
- Timers (CTO install): `../../deploy/lhc-upstream-watch*.timer`

Does **not** merge upstream or publish releases.
