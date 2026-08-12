# upstream-watch (LIM-40)

Cross-fork **upstream owner** tooling for `codex-lhc` and `grok-build-lhc`.

- Schemas: `schemas/WATCH_REPORT.v1.md`, `schemas/CANDIDATE_HANDOFF.v1.md`
- Config: `forks.json`
- CLI: `upstream_watch.py` (`--dispatch` for attention → upstream-owner)
- Dispatch: `dispatch.py` (watch attention vs QUALIFY handoff; durable dedupe)
- Promotion: `promotion_ready.py` (PROMOTION_READY record, CTO notify, approve/reject correlation)
- Tests: `python3 test_upstream_watch.py && python3 test_dispatch.py && python3 test_promotion_ready.py`
- Runbook: `../../docs/UPSTREAM_OWNER.md`
- Timers: `../../deploy/lhc-upstream-watch*.timer` (services use `--dispatch`)

Does **not** merge upstream or publish releases. Raw watch never starts
release qualification.
