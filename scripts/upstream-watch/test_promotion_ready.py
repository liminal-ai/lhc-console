#!/usr/bin/env python3
"""Hermetic tests for promotion_ready approval correlation."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import promotion_ready as pr


class PromotionReadyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.state = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def sample_block(self, **over) -> str:
        f = {
            "fork": "grok-build-lhc",
            "repo": "liminal-ai/grok-build-lhc",
            "product_version": "0.2.1",
            "source_sha": "c" * 40,
            "upstream_base": "b" * 40,
            "source_rev": "a" * 40,
            "lhc_sdk_pin": "d" * 40,
            "candidate_run_id": "111",
            "candidate_artifact_id": "222",
            "candidate_digest": "sha256:" + "1" * 64,
            "smoke_run_id": "333",
            "qualification_artifact_id": "444",
            "qualification_digest": "sha256:" + "2" * 64,
            "schema": "6",
            "produced_by": "codex-fork-steward",
        }
        f.update(over)
        lines = ["PROMOTION_READY v1"] + [f"{k}: {v}" for k, v in f.items()]
        return "\n".join(lines) + "\n"

    def test_record_and_notify_cto(self) -> None:
        path = self.state / "pr.txt"
        path.write_text(self.sample_block(), encoding="utf-8")
        calls: list[str] = []

        def fake(agent, msg, **kw):
            calls.append(agent)
            return 0, "job-x"

        with mock.patch.object(pr, "run_lhc_agent_start", side_effect=fake):
            rc = pr.main(
                [
                    "--state-dir",
                    str(self.state),
                    "record",
                    "--file",
                    str(path),
                ]
            )
        self.assertEqual(rc, 0)
        self.assertEqual(calls, [pr.CTO_AGENT])
        data = pr.load_packages(pr.packages_path(self.state))
        self.assertEqual(len(data["packages"]), 1)
        pkg = next(iter(data["packages"].values()))
        self.assertEqual(pkg["approval_status"], "pending")
        self.assertTrue(pkg["approval_id"].startswith("pr-"))

    def test_approve_notifies_qualifier_same_digests(self) -> None:
        path = self.state / "pr.txt"
        path.write_text(self.sample_block(), encoding="utf-8")
        with mock.patch.object(pr, "run_lhc_agent_start", return_value=(0, "j")):
            pr.main(["--state-dir", str(self.state), "record", "--file", str(path), "--no-notify"])
        aid = next(iter(pr.load_packages(pr.packages_path(self.state))["packages"]))
        pkg = pr.load_packages(pr.packages_path(self.state))["packages"][aid]
        calls: list[str] = []

        def fake(agent, msg, **kw):
            calls.append(agent)
            self.assertIn(pkg["candidate_digest"], msg)
            self.assertIn(pkg["source_sha"], msg)
            return 0, "j2"

        with mock.patch.object(pr, "run_lhc_agent_start", side_effect=fake):
            rc = pr.main(
                [
                    "--state-dir",
                    str(self.state),
                    "approve",
                    aid,
                    "--by",
                    "cto",
                    "--expect-candidate-digest",
                    pkg["candidate_digest"],
                    "--expect-qualification-digest",
                    pkg["qualification_digest"],
                    "--expect-source-sha",
                    pkg["source_sha"],
                ]
            )
        self.assertEqual(rc, 0)
        self.assertEqual(calls, [pr.RELEASE_QUALIFIER])
        pkg2 = pr.load_packages(pr.packages_path(self.state))["packages"][aid]
        self.assertEqual(pkg2["approval_status"], "approved")

    def test_approve_rejects_different_digest(self) -> None:
        path = self.state / "pr.txt"
        path.write_text(self.sample_block(), encoding="utf-8")
        with mock.patch.object(pr, "run_lhc_agent_start", return_value=(0, "j")):
            pr.main(["--state-dir", str(self.state), "record", "--file", str(path), "--no-notify"])
        aid = next(iter(pr.load_packages(pr.packages_path(self.state))["packages"]))
        rc = pr.main(
            [
                "--state-dir",
                str(self.state),
                "approve",
                aid,
                "--by",
                "lee",
                "--expect-candidate-digest",
                "sha256:" + "9" * 64,
            ]
        )
        self.assertEqual(rc, 1)

    def test_approval_id_stable(self) -> None:
        f = pr.parse_block(self.sample_block())
        a = pr.make_approval_id(f)
        b = pr.make_approval_id(f)
        self.assertEqual(a, b)
        f2 = dict(f)
        f2["candidate_digest"] = "sha256:" + "3" * 64
        self.assertNotEqual(a, pr.make_approval_id(f2))


if __name__ == "__main__":
    unittest.main()
