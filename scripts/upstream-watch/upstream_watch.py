#!/usr/bin/env python3
"""Cross-fork upstream watch for liminal Codex/Grok LHC forks (LIM-40).

Daily lightweight check, optional release-event assessment, weekly reconcile
flag. No merges. No release publication.

Examples:
  python3 upstream_watch.py --check-kind daily
  python3 upstream_watch.py --fork grok-build-lhc --update-state
  python3 upstream_watch.py --check-kind weekly_reconcile --write-reports
  python3 upstream_watch.py --emit-handoff-stub --fork codex-lhc
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_FORKS_FILE = SCRIPT_DIR / "forks.json"
SCHEMA_VERSION_WATCH = "WATCH_REPORT v1"
SCHEMA_VERSION_HANDOFF = "CANDIDATE_HANDOFF v1"


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def expand(path: str) -> Path:
    return Path(os.path.expanduser(path)).resolve()


def run_git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        check=check,
        text=True,
        capture_output=True,
    )


def git_out(repo: Path, *args: str) -> str:
    p = run_git(repo, *args, check=True)
    return (p.stdout or "").strip()


def load_forks(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("version") != 1:
        raise SystemExit(f"forks.json version must be 1 (got {data.get('version')!r})")
    return data


def state_path(state_dir: Path, fork_id: str) -> Path:
    return state_dir / f"{fork_id}.json"


def load_state(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def save_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def rev_parse(repo: Path, ref: str) -> str | None:
    p = run_git(repo, "rev-parse", "-q", "--verify", ref, check=False)
    if p.returncode != 0:
        return None
    return (p.stdout or "").strip()


def count_range(repo: Path, a: str, b: str) -> int:
    """Commits reachable from b but not a (a..b)."""
    out = git_out(repo, "rev-list", "--count", f"{a}..{b}")
    return int(out or "0")


def shortstat_themes(repo: Path, old: str | None, new: str) -> str:
    if not old or old == new:
        return "none"
    p = run_git(repo, "diff", "--shortstat", f"{old}..{new}", check=False)
    short = (p.stdout or "").strip() or "none"
    # Path themes: top-level path prefixes in name-status
    p2 = run_git(repo, "diff", "--name-only", f"{old}..{new}", check=False)
    names = [ln.strip() for ln in (p2.stdout or "").splitlines() if ln.strip()]
    themes: dict[str, int] = {}
    for n in names:
        top = n.split("/", 1)[0]
        themes[top] = themes.get(top, 0) + 1
    top_themes = sorted(themes.items(), key=lambda kv: (-kv[1], kv[0]))[:8]
    theme_s = ",".join(f"{k}:{v}" for k, v in top_themes) if top_themes else "none"
    return f"{short}; themes={theme_s}"


def list_new_tags(repo: Path, upstream: str, since_sha: str | None) -> list[str]:
    """Tags on upstream/main ancestry newer than since_sha (best-effort)."""
    p = run_git(
        repo,
        "tag",
        "--merged",
        f"{upstream}/main",
        "--sort=-creatordate",
        check=False,
    )
    tags = [t.strip() for t in (p.stdout or "").splitlines() if t.strip()]
    if not since_sha:
        return tags[:5]
    new: list[str] = []
    for tag in tags:
        tip = rev_parse(repo, tag)
        if not tip:
            continue
        # tag is "new" if not an ancestor of since_sha (tag not in old main history)
        p = run_git(repo, "merge-base", "--is-ancestor", tip, since_sha, check=False)
        if p.returncode != 0:
            new.append(tag)
        if len(new) >= 5:
            break
    return new


def remote_url(repo: Path, remote: str) -> str:
    p = run_git(repo, "remote", "get-url", remote, check=False)
    return (p.stdout or "").strip() or "none"


@dataclass
class WatchResult:
    fork_id: str
    fields: dict[str, str]

    def render(self) -> str:
        lines = [SCHEMA_VERSION_WATCH]
        order = [
            "fork",
            "repo",
            "checked_at",
            "check_kind",
            "last_seen_upstream_sha",
            "upstream_sha",
            "origin_lhc_sha",
            "origin_main_sha",
            "behind",
            "ahead",
            "upstream_release_event",
            "changed_paths_themes",
            "action",
            "notes",
            "state_path",
            "produced_by",
        ]
        for k in order:
            lines.append(f"{k}: {self.fields.get(k, 'none')}")
        return "\n".join(lines) + "\n"


def decide_action(
    check_kind: str,
    behind: int,
    upstream_changed: bool,
    release_event: str,
) -> str:
    if check_kind == "weekly_reconcile" and behind > 0:
        return "sync_candidate"
    if release_event != "none":
        return "assess"
    if upstream_changed and behind > 0:
        return "assess"
    if upstream_changed:
        return "assess"
    return "none"


def watch_one(
    fork: dict[str, Any],
    *,
    check_kind: str,
    state_dir: Path,
    do_fetch: bool,
    update_state: bool,
    notes: str,
) -> WatchResult:
    fork_id = fork["id"]
    repo = Path(fork["path"])
    if not repo.is_dir():
        raise SystemExit(f"fork path missing: {repo} ({fork_id})")

    origin = fork.get("origin", "origin")
    upstream = fork.get("upstream", "upstream")
    product = fork.get("product_branch", "lhc")
    mirror = fork.get("mirror_branch", "main")
    up_branch = fork.get("upstream_branch", "main")

    st_path = state_path(state_dir, fork_id)
    prev = load_state(st_path)
    last_seen = prev.get("last_seen_upstream_sha") or "none"

    if do_fetch:
        # fetch only — never merge
        run_git(repo, "fetch", origin, "--prune", check=False)
        run_git(repo, "fetch", upstream, "--prune", check=False)

    up_ref = f"{upstream}/{up_branch}"
    lhc_ref = f"{origin}/{product}"
    main_ref = f"{origin}/{mirror}"

    upstream_sha = rev_parse(repo, up_ref)
    origin_lhc = rev_parse(repo, lhc_ref)
    origin_main = rev_parse(repo, main_ref)

    if not upstream_sha or not origin_lhc:
        raise SystemExit(
            f"{fork_id}: missing refs after fetch "
            f"(upstream={upstream_sha}, origin_lhc={origin_lhc})"
        )

    behind = count_range(repo, origin_lhc, upstream_sha)
    ahead = count_range(repo, upstream_sha, origin_lhc)

    old_for_diff = last_seen if last_seen != "none" else None
    themes = shortstat_themes(repo, old_for_diff, upstream_sha)

    new_tags = list_new_tags(repo, upstream, old_for_diff if old_for_diff else None)
    if new_tags and (old_for_diff is None or upstream_sha != old_for_diff):
        # only claim release event when we have a prior baseline or weekly/manual
        if old_for_diff:
            release_event = "tag:" + ",".join(new_tags[:3])
        else:
            release_event = "none"
    else:
        release_event = "none"

    upstream_changed = last_seen == "none" or upstream_sha != last_seen
    action = decide_action(check_kind, behind, upstream_changed, release_event)

    note = notes
    if last_seen == "none" and note == "none":
        note = "no prior last-seen state"

    fields = {
        "fork": fork_id,
        "repo": fork["repo"],
        "checked_at": utc_now(),
        "check_kind": check_kind,
        "last_seen_upstream_sha": last_seen,
        "upstream_sha": upstream_sha,
        "origin_lhc_sha": origin_lhc,
        "origin_main_sha": origin_main or "none",
        "behind": str(behind),
        "ahead": str(ahead),
        "upstream_release_event": release_event,
        "changed_paths_themes": themes,
        "action": action,
        "notes": note,
        "state_path": str(st_path) if update_state else "none",
        "produced_by": "upstream-owner",
    }

    if update_state:
        save_state(
            st_path,
            {
                "fork": fork_id,
                "repo": fork["repo"],
                "last_seen_upstream_sha": upstream_sha,
                "last_origin_lhc_sha": origin_lhc,
                "last_origin_main_sha": origin_main,
                "last_check_at": fields["checked_at"],
                "last_check_kind": check_kind,
                "last_behind": behind,
                "last_action": action,
                "upstream_remote_url": remote_url(repo, upstream),
            },
        )
        fields["state_path"] = str(st_path)

    return WatchResult(fork_id=fork_id, fields=fields)


def emit_handoff_stub(fork: dict[str, Any], *, do_fetch: bool) -> str:
    """Fill known SHAs; leave tripwire/repairs for post-sync human fill."""
    repo = Path(fork["path"])
    origin = fork.get("origin", "origin")
    upstream = fork.get("upstream", "upstream")
    product = fork.get("product_branch", "lhc")
    up_branch = fork.get("upstream_branch", "main")
    if do_fetch:
        run_git(repo, "fetch", origin, "--prune", check=False)
        run_git(repo, "fetch", upstream, "--prune", check=False)

    candidate = rev_parse(repo, f"{origin}/{product}") or "none"
    up = rev_parse(repo, f"{upstream}/{up_branch}") or "none"
    base_file = repo / fork.get("patches_base_file", "patches/BASE")
    patches_base = base_file.read_text(encoding="utf-8").strip() if base_file.is_file() else "none"

    vendor_candidates = [
        repo / "codex-rs/lhc/vendor/long-horizon-context",
        repo / "crates/lhc/vendor/long-horizon-context",
    ]
    pin = "none"
    for v in vendor_candidates:
        if v.is_dir():
            p = run_git(v, "rev-parse", "HEAD", check=False)
            if p.returncode == 0:
                pin = (p.stdout or "").strip()
                break

    lines = [
        SCHEMA_VERSION_HANDOFF,
        f"fork: {fork['id']}",
        f"repo: {fork['repo']}",
        "branch: lhc",
        f"candidate_sha: {candidate}",
        f"upstream_remote: {remote_url(repo, upstream)}",
        f"upstream_base: {up}",
        "upstream_range: FILL_AFTER_SYNC",
        "merge_commit: none",
        f"patches_base: {patches_base}",
        f"lhc_sdk_pin: {pin}",
        "tripwire: RED",
        "tripwire_summary: stub only — run FORK sync drill + tripwire before QUALIFY",
        "compat_repairs: none",
        "risks: none",
        "recommended: HOLD",
        "reason: handoff stub from watch tooling; not a completed sync",
        "evidence: none",
        "produced_by: upstream-owner",
        f"produced_at: {utc_now()}",
        "not_in_scope: release publish; smoke promote; version bump unless requested",
    ]
    return "\n".join(lines) + "\n"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="LIM-40 cross-fork upstream watch")
    p.add_argument(
        "--forks-file",
        type=Path,
        default=DEFAULT_FORKS_FILE,
        help="forks.json path",
    )
    p.add_argument(
        "--fork",
        action="append",
        dest="forks",
        help="Fork id (repeatable). Default: all forks in forks.json",
    )
    p.add_argument(
        "--check-kind",
        choices=["daily", "release_event", "weekly_reconcile", "manual"],
        default="daily",
    )
    p.add_argument(
        "--state-dir",
        type=str,
        default="",
        help="Durable last-seen dir (default from forks.json)",
    )
    p.add_argument(
        "--report-dir",
        type=str,
        default="",
        help="If set with --write-reports, write one file per fork",
    )
    p.add_argument("--no-fetch", action="store_true", help="Use existing refs only")
    p.add_argument(
        "--update-state",
        action="store_true",
        help="Write last-seen upstream SHA after a successful check",
    )
    p.add_argument(
        "--write-reports",
        action="store_true",
        help="Write WATCH_REPORT files under report-dir",
    )
    p.add_argument(
        "--emit-handoff-stub",
        action="store_true",
        help="Print CANDIDATE_HANDOFF stub(s) instead of watch",
    )
    p.add_argument("--notes", default="none")
    p.add_argument(
        "--json-summary",
        action="store_true",
        help="Also print machine-readable summary to stderr",
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    cfg = load_forks(args.forks_file)
    all_forks: dict[str, Any] = cfg["forks"]
    selected = args.forks or list(all_forks.keys())
    for fid in selected:
        if fid not in all_forks:
            raise SystemExit(f"unknown fork {fid!r}; known: {', '.join(all_forks)}")

    state_dir = expand(args.state_dir or cfg.get("state_dir_default", "~/.lhc-console/upstream-watch"))
    report_dir = expand(
        args.report_dir or cfg.get("report_dir_default", "~/.lhc-console/upstream-watch/reports")
    )

    summaries: list[dict[str, Any]] = []
    exit_code = 0

    for fid in selected:
        fork = all_forks[fid]
        if args.emit_handoff_stub:
            text = emit_handoff_stub(fork, do_fetch=not args.no_fetch)
            sys.stdout.write(f"===== {fid} =====\n")
            sys.stdout.write(text)
            if not text.endswith("\n"):
                sys.stdout.write("\n")
            continue

        try:
            result = watch_one(
                fork,
                check_kind=args.check_kind,
                state_dir=state_dir,
                do_fetch=not args.no_fetch,
                update_state=args.update_state,
                notes=args.notes,
            )
        except Exception as e:
            sys.stderr.write(f"FAIL {fid}: {e}\n")
            exit_code = 1
            continue

        block = result.render()
        sys.stdout.write(f"===== {fid} =====\n")
        sys.stdout.write(block)

        if args.write_reports:
            report_dir.mkdir(parents=True, exist_ok=True)
            ts = result.fields["checked_at"].replace(":", "").replace("-", "")
            out = report_dir / f"WATCH_{fid}_{ts}.txt"
            out.write_text(block, encoding="utf-8")
            # stable latest pointer
            latest = report_dir / f"WATCH_{fid}_latest.txt"
            latest.write_text(block, encoding="utf-8")
            sys.stderr.write(f"wrote {out}\n")

        summaries.append(dict(result.fields))
        if result.fields["action"] in ("assess", "sync_candidate"):
            exit_code = max(exit_code, 2)  # signal attention without hard fail of tooling

    if args.json_summary and summaries:
        sys.stderr.write(json.dumps({"reports": summaries}, indent=2) + "\n")

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
