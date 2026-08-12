#!/usr/bin/env python3
"""Tests for post-promote Lee notify (dedupe, content rules)."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

import release_notify as rn


class ReleaseNotifyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.state = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_message_plain_no_digests(self) -> None:
        msg = rn.build_lee_success_message(
            fork="grok-build-lhc",
            version="0.2.1",
            summary="Long-horizon context is on by default with Replace compact.",
            platforms="Linux x86_64",
            limitations="Windows and macOS builds are not published yet.",
            product="Grok Build LHC",
        )
        self.assertIn("Grok Build LHC 0.2.1 is published.", msg)
        self.assertIn("Linux x86_64", msg)
        self.assertIn("Note:", msg)
        self.assertNotIn("sha256:", msg)
        self.assertNotIn("31627906621", msg)

    def test_dedupe_by_fork_tag(self) -> None:
        calls: list[str] = []

        def fake(agent, msg, **kw):
            calls.append(agent)
            return 0, "ok"

        with mock.patch.object(rn, "run_lhc_agent_start", side_effect=fake):
            r1 = rn.notify_lee_success(
                fork="grok-build-lhc",
                version="0.2.1",
                summary="Sync and default-on LHC improvements.",
                platforms="Linux x86_64",
                state_dir=self.state,
            )
            r2 = rn.notify_lee_success(
                fork="grok-build-lhc",
                version="v0.2.1",
                summary="retry same release",
                platforms="Linux x86_64",
                state_dir=self.state,
            )
        self.assertTrue(r1["dispatched"])
        self.assertEqual(calls, ["lee"])
        self.assertTrue(r2["skipped"])
        self.assertEqual(r2["reason"], "already notified for this fork/tag")
        self.assertEqual(len(calls), 1)

    def test_different_tag_not_deduped(self) -> None:
        with mock.patch.object(rn, "run_lhc_agent_start", return_value=(0, "ok")) as m:
            rn.notify_lee_success(
                fork="codex-lhc",
                version="0.2.1",
                summary="A",
                platforms="Linux x86_64",
                state_dir=self.state,
            )
            rn.notify_lee_success(
                fork="codex-lhc",
                version="0.2.2",
                summary="B",
                platforms="Linux x86_64",
                state_dir=self.state,
            )
        self.assertEqual(m.call_count, 2)

    def test_rejects_digest_in_summary(self) -> None:
        with mock.patch.object(rn, "run_lhc_agent_start", return_value=(0, "ok")) as m:
            r = rn.notify_lee_success(
                fork="grok-build-lhc",
                version="0.2.1",
                summary="digest sha256:" + "a" * 64,
                platforms="Linux x86_64",
                state_dir=self.state,
            )
        self.assertFalse(r["ok"])
        self.assertIn("digest", r["error"])
        m.assert_not_called()

    def test_dry_run_no_dedupe_mark(self) -> None:
        with mock.patch.object(rn, "run_lhc_agent_start", return_value=(0, "ok")) as m:
            r = rn.notify_lee_success(
                fork="grok-build-lhc",
                version="0.3.0",
                summary="Feature work.",
                platforms="Linux x86_64",
                state_dir=self.state,
                dry_run=True,
            )
            self.assertTrue(r["ok"])
            self.assertTrue(r["dry_run"])
            self.assertFalse(r.get("dispatched"))
            # second real send should work (dry did not mark)
            r2 = rn.notify_lee_success(
                fork="grok-build-lhc",
                version="0.3.0",
                summary="Feature work.",
                platforms="Linux x86_64",
                state_dir=self.state,
                dry_run=False,
            )
            self.assertTrue(r2["dispatched"])
            self.assertEqual(m.call_count, 2)


if __name__ == "__main__":
    unittest.main()
