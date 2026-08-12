#!/usr/bin/env python3
"""Hermetic tests for upstream_watch (no network, temp git repos)."""

from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

import upstream_watch as uw


def git(repo: Path, *args: str) -> str:
    p = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        text=True,
        capture_output=True,
    )
    return (p.stdout or "").strip()


def init_repo(path: Path) -> None:
    path.mkdir(parents=True)
    git(path, "init")
    git(path, "config", "user.email", "test@example.com")
    git(path, "config", "user.name", "Test")
    (path / "README").write_text("a\n", encoding="utf-8")
    git(path, "add", "README")
    git(path, "commit", "-m", "init")
    git(path, "branch", "-M", "main")


class UpstreamWatchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        # upstream bare-ish normal repo
        self.upstream = self.root / "upstream"
        init_repo(self.upstream)
        self.up_main = git(self.upstream, "rev-parse", "HEAD")

        # fork clone
        self.fork = self.root / "fork"
        subprocess.run(
            ["git", "clone", str(self.upstream), str(self.fork)],
            check=True,
            capture_output=True,
        )
        git(self.fork, "checkout", "-b", "lhc")
        (self.fork / "FORK.md").write_text("fork\n", encoding="utf-8")
        git(self.fork, "add", "FORK.md")
        git(self.fork, "commit", "-m", "fork commit")
        # remotes: origin = fork itself via path remote; upstream = upstream repo
        git(self.fork, "remote", "remove", "origin")
        git(self.fork, "remote", "add", "origin", str(self.fork))
        # origin needs branches for fetch: use a second clone as origin
        self.origin = self.root / "origin"
        subprocess.run(
            ["git", "clone", str(self.fork), str(self.origin)],
            check=True,
            capture_output=True,
        )
        git(self.origin, "checkout", "lhc")
        git(self.fork, "remote", "remove", "origin")
        git(self.fork, "remote", "add", "origin", str(self.origin))
        git(self.fork, "remote", "add", "upstream", str(self.upstream))
        git(self.fork, "fetch", "origin")
        git(self.fork, "fetch", "upstream")

        self.state_dir = self.root / "state"
        self.fork_cfg = {
            "id": "test-fork",
            "repo": "liminal-ai/test-fork",
            "path": str(self.fork),
            "origin": "origin",
            "upstream": "upstream",
            "product_branch": "lhc",
            "mirror_branch": "main",
            "upstream_branch": "main",
            "patches_base_file": "patches/BASE",
            "tripwire": "scripts/check-lhc-hooks.sh",
            "fork_doc": "FORK.md",
        }

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_watch_behind_and_state_update(self) -> None:
        # advance upstream
        (self.upstream / "README").write_text("b\n", encoding="utf-8")
        git(self.upstream, "add", "README")
        git(self.upstream, "commit", "-m", "up2")
        new_up = git(self.upstream, "rev-parse", "HEAD")

        r1 = uw.watch_one(
            self.fork_cfg,
            check_kind="daily",
            state_dir=self.state_dir,
            do_fetch=True,
            update_state=True,
            notes="none",
        )
        self.assertEqual(r1.fields["upstream_sha"], new_up)
        self.assertGreaterEqual(int(r1.fields["behind"]), 1)
        self.assertIn(r1.fields["action"], ("assess", "sync_candidate"))
        self.assertTrue(self.state_dir.joinpath("test-fork.json").is_file())

        # second check no upstream change → action none
        r2 = uw.watch_one(
            self.fork_cfg,
            check_kind="daily",
            state_dir=self.state_dir,
            do_fetch=True,
            update_state=True,
            notes="none",
        )
        self.assertEqual(r2.fields["action"], "none")
        self.assertEqual(r2.fields["last_seen_upstream_sha"], new_up)

    def test_weekly_reconcile_flags_sync_candidate(self) -> None:
        (self.upstream / "README").write_text("c\n", encoding="utf-8")
        git(self.upstream, "add", "README")
        git(self.upstream, "commit", "-m", "up3")
        r = uw.watch_one(
            self.fork_cfg,
            check_kind="weekly_reconcile",
            state_dir=self.state_dir,
            do_fetch=True,
            update_state=False,
            notes="none",
        )
        self.assertEqual(r.fields["action"], "sync_candidate")
        block = r.render()
        self.assertTrue(block.startswith("WATCH_REPORT v1\n"))
        self.assertIn("fork: test-fork", block)

    def test_handoff_stub_shape(self) -> None:
        text = uw.emit_handoff_stub(self.fork_cfg, do_fetch=True)
        self.assertTrue(text.startswith("CANDIDATE_HANDOFF v1\n"))
        self.assertIn("recommended: HOLD", text)
        self.assertIn("tripwire: RED", text)
        self.assertIn("produced_by: upstream-owner", text)

    def test_decide_action(self) -> None:
        self.assertEqual(uw.decide_action("daily", 0, False, "none"), "none")
        self.assertEqual(uw.decide_action("daily", 1, True, "none"), "assess")
        self.assertEqual(uw.decide_action("daily", 0, False, "tag:v1"), "assess")
        self.assertEqual(uw.decide_action("weekly_reconcile", 2, False, "none"), "sync_candidate")


if __name__ == "__main__":
    unittest.main()
