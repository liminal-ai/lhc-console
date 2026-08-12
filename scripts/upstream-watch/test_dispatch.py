#!/usr/bin/env python3
"""Hermetic tests for LIM-40 dispatch dedupe and policy gates."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import dispatch as d


class DispatchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.state = Path(self.tmp.name)
        self.reports = self.state / "reports"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def watch_fields(self, **over):
        base = {
            "fork": "grok-build-lhc",
            "action": "assess",
            "upstream_sha": "a" * 40,
            "upstream_release_event": "none",
            "behind": "3",
        }
        base.update(over)
        return base

    def test_no_change_silence(self) -> None:
        fields = self.watch_fields(action="none")
        r = d.dispatch_watch_attention(
            fields,
            "WATCH_REPORT v1\naction: none\n",
            state_dir=self.state,
            report_dir=self.reports,
            dry_run=True,
        )
        self.assertTrue(r["skipped"])
        self.assertFalse(r["dispatched"])
        self.assertEqual(r["reason"], "no attention action")

    def test_new_tag_attention_dispatches_owner_not_qualifier(self) -> None:
        fields = self.watch_fields(
            action="assess",
            upstream_release_event="tag:v9.9.9",
            behind="0",
        )
        calls: list[tuple] = []

        def fake_start(agent, message, **kw):
            calls.append((agent, message, kw))
            return 0, "job-1"

        with mock.patch.object(d, "run_lhc_agent_start", side_effect=fake_start):
            r = d.dispatch_watch_attention(
                fields,
                "WATCH_REPORT v1\naction: assess\nupstream_release_event: tag:v9.9.9\n",
                state_dir=self.state,
                report_dir=self.reports,
                dry_run=False,
            )
        self.assertTrue(r["dispatched"])
        self.assertEqual(r["target"], d.UPSTREAM_OWNER)
        self.assertEqual(calls[0][0], d.UPSTREAM_OWNER)
        self.assertNotEqual(calls[0][0], d.RELEASE_QUALIFIER)
        self.assertIn("NOT release qualification", calls[0][1])

    def test_drift_attention(self) -> None:
        fields = self.watch_fields(action="sync_candidate", behind="12")
        with mock.patch.object(d, "run_lhc_agent_start", return_value=(0, "job-2")):
            r = d.dispatch_watch_attention(
                fields,
                "WATCH_REPORT v1\naction: sync_candidate\n",
                state_dir=self.state,
                report_dir=self.reports,
            )
        self.assertTrue(r["dispatched"])

    def test_dedupe_restart_silence(self) -> None:
        fields = self.watch_fields(action="assess")
        with mock.patch.object(d, "run_lhc_agent_start", return_value=(0, "job-3")) as m:
            r1 = d.dispatch_watch_attention(
                fields,
                "report",
                state_dir=self.state,
                report_dir=self.reports,
            )
            r2 = d.dispatch_watch_attention(
                fields,
                "report",
                state_dir=self.state,
                report_dir=self.reports,
            )
        self.assertTrue(r1["dispatched"])
        self.assertTrue(r2["skipped"])
        self.assertEqual(r2["reason"], "already dispatched")
        self.assertEqual(m.call_count, 1)

    def test_handoff_requires_green_qualify(self) -> None:
        path = self.state / "bad.txt"
        path.write_text(
            "CANDIDATE_HANDOFF v1\n"
            "fork: grok-build-lhc\n"
            f"candidate_sha: {'b' * 40}\n"
            "tripwire: RED\n"
            "recommended: QUALIFY\n",
            encoding="utf-8",
        )
        r = d.dispatch_handoff_file(
            path, state_dir=self.state, report_dir=self.reports, dry_run=True
        )
        self.assertTrue(r["skipped"])
        self.assertIn("tripwire", r["reason"])

    def test_handoff_qualify_goes_to_release_qualifier(self) -> None:
        sha = "c" * 40
        path = self.state / "good.txt"
        path.write_text(
            "CANDIDATE_HANDOFF v1\n"
            "fork: codex-lhc\n"
            f"candidate_sha: {sha}\n"
            "tripwire: GREEN\n"
            "recommended: QUALIFY\n",
            encoding="utf-8",
        )
        calls: list[str] = []

        def fake_start(agent, message, **kw):
            calls.append(agent)
            return 0, "job-h"

        with mock.patch.object(d, "run_lhc_agent_start", side_effect=fake_start):
            r = d.dispatch_handoff_file(
                path, state_dir=self.state, report_dir=self.reports
            )
            r2 = d.dispatch_handoff_file(
                path, state_dir=self.state, report_dir=self.reports
            )
        self.assertTrue(r["dispatched"])
        self.assertEqual(calls, [d.RELEASE_QUALIFIER])
        self.assertTrue(r2["skipped"])

    def test_failure_visibility(self) -> None:
        fields = self.watch_fields(action="assess")
        with mock.patch.object(
            d, "run_lhc_agent_start", return_value=(1, "relay down")
        ):
            r = d.dispatch_watch_attention(
                fields,
                "report",
                state_dir=self.state,
                report_dir=self.reports,
            )
        self.assertFalse(r["dispatched"])
        self.assertIn("error", r)
        fail_log = self.reports / "DISPATCH_FAILURES.log"
        self.assertTrue(fail_log.is_file())
        self.assertIn("FAIL watch dispatch", fail_log.read_text())


if __name__ == "__main__":
    unittest.main()
