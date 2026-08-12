#!/usr/bin/env python3
"""Hermetic tests for upstream_watch (empty HOME; no network)."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import upstream_watch as uw


def git(repo: Path, *args: str, env: dict[str, str] | None = None) -> str:
    p = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        text=True,
        capture_output=True,
        env=env,
    )
    return (p.stdout or "").strip()


def make_git_env(home: Path) -> dict[str, str]:
    """Isolate from global/user git config so commits work with empty HOME."""
    env = os.environ.copy()
    env["HOME"] = str(home)
    env["XDG_CONFIG_HOME"] = str(home / ".config")
    env["GIT_CONFIG_GLOBAL"] = str(home / "nonexistent-gitconfig")
    env["GIT_CONFIG_SYSTEM"] = "/dev/null"
    env["GIT_AUTHOR_NAME"] = "Upstream Watch Test"
    env["GIT_AUTHOR_EMAIL"] = "upstream-watch-test@example.com"
    env["GIT_COMMITTER_NAME"] = "Upstream Watch Test"
    env["GIT_COMMITTER_EMAIL"] = "upstream-watch-test@example.com"
    # Prevent local include/path surprises
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    return env


def init_repo(path: Path, env: dict[str, str]) -> None:
    path.mkdir(parents=True)
    git(path, "init", env=env)
    git(path, "config", "user.email", "test@example.com", env=env)
    git(path, "config", "user.name", "Test", env=env)
    (path / "README").write_text("a\n", encoding="utf-8")
    git(path, "add", "README", env=env)
    git(path, "commit", "-m", "init", env=env)
    git(path, "branch", "-M", "main", env=env)


class UpstreamWatchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.home = self.root / "empty-home"
        self.home.mkdir()
        self.env = make_git_env(self.home)

        self.upstream = self.root / "upstream"
        init_repo(self.upstream, self.env)
        self.up_main = git(self.upstream, "rev-parse", "HEAD", env=self.env)
        # historical tags present before any watch baseline
        git(self.upstream, "tag", "v0.0.1", env=self.env)
        git(self.upstream, "tag", "legacy-old", env=self.env)

        self.fork = self.root / "fork"
        subprocess.run(
            ["git", "clone", str(self.upstream), str(self.fork)],
            check=True,
            capture_output=True,
            env=self.env,
        )
        git(self.fork, "config", "user.email", "test@example.com", env=self.env)
        git(self.fork, "config", "user.name", "Test", env=self.env)
        git(self.fork, "checkout", "-b", "lhc", env=self.env)
        (self.fork / "FORK.md").write_text("fork\n", encoding="utf-8")
        git(self.fork, "add", "FORK.md", env=self.env)
        git(self.fork, "commit", "-m", "fork commit", env=self.env)

        self.origin = self.root / "origin"
        subprocess.run(
            ["git", "clone", str(self.fork), str(self.origin)],
            check=True,
            capture_output=True,
            env=self.env,
        )
        git(self.origin, "checkout", "lhc", env=self.env)
        git(self.fork, "remote", "remove", "origin", env=self.env)
        git(self.fork, "remote", "add", "origin", str(self.origin), env=self.env)
        git(self.fork, "remote", "add", "upstream", str(self.upstream), env=self.env)
        git(self.fork, "fetch", "origin", env=self.env)
        git(self.fork, "fetch", "upstream", env=self.env)

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

    def watch(self, **kwargs):
        defaults = dict(
            check_kind="daily",
            state_dir=self.state_dir,
            do_fetch=True,
            update_state=True,
            notes="none",
        )
        defaults.update(kwargs)
        with mock.patch.dict(os.environ, self.env, clear=False):
            return uw.watch_one(self.fork_cfg, **defaults)

    def test_watch_behind_and_state_update(self) -> None:
        (self.upstream / "README").write_text("b\n", encoding="utf-8")
        git(self.upstream, "add", "README", env=self.env)
        git(self.upstream, "commit", "-m", "up2", env=self.env)
        new_up = git(self.upstream, "rev-parse", "HEAD", env=self.env)

        r1 = self.watch()
        self.assertEqual(r1.fields["upstream_sha"], new_up)
        self.assertGreaterEqual(int(r1.fields["behind"]), 1)
        self.assertIn(r1.fields["action"], ("assess", "sync_candidate"))
        self.assertTrue(self.state_dir.joinpath("test-fork.json").is_file())
        # first cycle baselines historical tags — no release event from them
        self.assertEqual(r1.fields["upstream_release_event"], "none")
        st = json.loads(self.state_dir.joinpath("test-fork.json").read_text())
        self.assertIn("v0.0.1", st["known_upstream_tags"])
        self.assertIn("legacy-old", st["known_upstream_tags"])

        r2 = self.watch()
        self.assertEqual(r2.fields["action"], "none")
        self.assertEqual(r2.fields["last_seen_upstream_sha"], new_up)

    def test_new_tag_on_unchanged_tip_triggers_once(self) -> None:
        """Two-cycle fixture: tag on already-seen tip → event once, then silence."""
        # Cycle 0: baseline tip + historical tags
        r0 = self.watch(check_kind="daily")
        tip = r0.fields["upstream_sha"]
        self.assertEqual(r0.fields["upstream_release_event"], "none")

        # New official tag on the *same* commit (tip unchanged)
        git(self.upstream, "tag", "v9.9.9", env=self.env)
        tip_after = git(self.upstream, "rev-parse", "HEAD", env=self.env)
        self.assertEqual(tip, tip_after)

        r1 = self.watch(check_kind="release_event")
        self.assertEqual(r1.fields["upstream_sha"], tip)
        self.assertEqual(r1.fields["upstream_release_event"], "tag:v9.9.9")
        self.assertEqual(r1.fields["action"], "assess")
        self.assertIn("v9.9.9", r1.new_tag_names)

        # Cycle 2: same tip, same tags → no second event
        r2 = self.watch(check_kind="release_event")
        self.assertEqual(r2.fields["upstream_sha"], tip)
        self.assertEqual(r2.fields["upstream_release_event"], "none")
        self.assertEqual(r2.fields["action"], "none")
        self.assertEqual(r2.new_tag_names, [])

    def test_weekly_reconcile_flags_sync_candidate(self) -> None:
        (self.upstream / "README").write_text("c\n", encoding="utf-8")
        git(self.upstream, "add", "README", env=self.env)
        git(self.upstream, "commit", "-m", "up3", env=self.env)
        r = self.watch(check_kind="weekly_reconcile", update_state=False)
        self.assertEqual(r.fields["action"], "sync_candidate")
        block = r.render()
        self.assertTrue(block.startswith("WATCH_REPORT v1\n"))
        self.assertIn("fork: test-fork", block)

    def test_handoff_stub_shape(self) -> None:
        with mock.patch.dict(os.environ, self.env, clear=False):
            text = uw.emit_handoff_stub(self.fork_cfg, do_fetch=True)
        self.assertTrue(text.startswith("CANDIDATE_HANDOFF v1\n"))
        self.assertIn("recommended: HOLD", text)
        self.assertIn("tripwire: RED", text)
        self.assertIn("produced_by: upstream-owner", text)
        self.assertIn("source_rev:", text)
        self.assertIn("patches_base:", text)

    def test_decide_action(self) -> None:
        self.assertEqual(uw.decide_action("daily", 0, False, "none"), "none")
        self.assertEqual(uw.decide_action("daily", 1, True, "none"), "assess")
        self.assertEqual(uw.decide_action("daily", 0, False, "tag:v1"), "assess")
        self.assertEqual(
            uw.decide_action("weekly_reconcile", 2, False, "none"), "sync_candidate"
        )

    def test_detect_release_events_first_baseline(self) -> None:
        tags = {"v1.0.0": "abc", "old": "def"}
        event, names, first = uw.detect_release_events(tags, None)
        self.assertEqual(event, "none")
        self.assertTrue(first)
        self.assertEqual(set(names), {"v1.0.0", "old"})

    def test_detect_release_events_new_tag(self) -> None:
        known = {"v1.0.0"}
        tags = {"v1.0.0": "abc", "v1.1.0": "abc"}
        event, new, first = uw.detect_release_events(tags, known)
        self.assertFalse(first)
        self.assertEqual(event, "tag:v1.1.0")
        self.assertEqual(new, ["v1.1.0"])


if __name__ == "__main__":
    # Prove isolation: force empty HOME for the process before running tests.
    if not os.environ.get("UPSTREAM_WATCH_TEST_HOME_OK"):
        td = tempfile.mkdtemp(prefix="uw-empty-home-")
        env = make_git_env(Path(td))
        env["UPSTREAM_WATCH_TEST_HOME_OK"] = "1"
        env["PYTHONPATH"] = str(Path(__file__).resolve().parent)
        raise SystemExit(
            subprocess.call(
                [os.environ.get("PYTHON", "python3"), str(Path(__file__).resolve())],
                env=env,
                cwd=str(Path(__file__).resolve().parent),
            )
        )
    unittest.main()
