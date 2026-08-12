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
    p2 = run_git(repo, "diff", "--name-only", f"{old}..{new}", check=False)
    names = [ln.strip() for ln in (p2.stdout or "").splitlines() if ln.strip()]
    themes: dict[str, int] = {}
    for n in names:
        top = n.split("/", 1)[0]
        themes[top] = themes.get(top, 0) + 1
    top_themes = sorted(themes.items(), key=lambda kv: (-kv[1], kv[0]))[:8]
    theme_s = ",".join(f"{k}:{v}" for k, v in top_themes) if top_themes else "none"
    return f"{short}; themes={theme_s}"


def fetch_upstream_refs(repo: Path, upstream: str, up_branch: str) -> None:
    """Fetch branch tip and all tags from upstream (required for release detection)."""
    run_git(repo, "fetch", upstream, "--prune", f"+refs/heads/{up_branch}:refs/remotes/{upstream}/{up_branch}", check=False)
    # Explicit tag refspec so newly published tags are available even when tip is unchanged.
    run_git(
        repo,
        "fetch",
        upstream,
        "--prune",
        "+refs/tags/*:refs/tags/upstream-watch/*",
        check=False,
    )


def list_remote_tags(repo: Path, remote: str) -> dict[str, str]:
    """Map tag name -> peeled object sha via ls-remote (authoritative remote view)."""
    p = run_git(repo, "ls-remote", "--tags", "--refs", remote, check=False)
    if p.returncode != 0:
        return {}
    out: dict[str, str] = {}
    for line in (p.stdout or "").splitlines():
        line = line.strip()
        if not line or "\t" not in line:
            continue
        sha, ref = line.split("\t", 1)
        if not ref.startswith("refs/tags/"):
            continue
        name = ref[len("refs/tags/") :]
        # Prefer peeled ^{} lines when present; ls-remote --refs omits ^{}.
        out[name] = sha
    return out


def detect_release_events(
    remote_tags: dict[str, str],
    known_tag_names: set[str] | None,
) -> tuple[str, list[str], bool]:
    """Return (release_event field, new_tag_names, is_first_baseline).

    First baseline (known_tag_names is None): record all current tags, emit no event.
    Later: tags in remote_tags not in known set are new official tags, independent of tip move.
    """
    names = sorted(remote_tags.keys())
    if known_tag_names is None:
        return "none", names, True
    new = sorted(set(names) - set(known_tag_names))
    if not new:
        return "none", [], False
    # Cap display; full list still used for state updates.
    shown = new[:5]
    return "tag:" + ",".join(shown), new, False


def remote_url(repo: Path, remote: str) -> str:
    p = run_git(repo, "remote", "get-url", remote, check=False)
    return (p.stdout or "").strip() or "none"


@dataclass
class WatchResult:
    fork_id: str
    fields: dict[str, str]
    # Internal: for tests / state
    new_tag_names: list[str]
    remote_tag_names: list[str]
    first_tag_baseline: bool

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
    known_tags_raw = prev.get("known_upstream_tags")
    if known_tags_raw is None:
        known_tag_names: set[str] | None = None
    else:
        known_tag_names = set(known_tags_raw)

    if do_fetch:
        run_git(repo, "fetch", origin, "--prune", check=False)
        fetch_upstream_refs(repo, upstream, up_branch)

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

    remote_tags = list_remote_tags(repo, upstream)
    release_event, new_or_all_tags, first_baseline = detect_release_events(
        remote_tags, known_tag_names
    )
    new_tag_names = [] if first_baseline else list(new_or_all_tags)
    remote_tag_names = sorted(remote_tags.keys())

    upstream_changed = last_seen == "none" or upstream_sha != last_seen
    action = decide_action(check_kind, behind, upstream_changed, release_event)

    note = notes
    if last_seen == "none" and note == "none":
        note = "no prior last-seen state"
    if first_baseline and remote_tag_names and note == "none":
        note = f"baselined {len(remote_tag_names)} upstream tags (no event)"
    elif first_baseline and remote_tag_names and note != "none":
        note = f"{note}; baselined {len(remote_tag_names)} upstream tags"

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
        # Always advance tip last-seen; for tags: baseline full set, or union new names.
        if known_tag_names is None:
            tags_for_state = remote_tag_names
        else:
            tags_for_state = sorted(set(known_tag_names) | set(remote_tag_names))
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
                "last_release_event": release_event,
                "known_upstream_tags": tags_for_state,
                "upstream_remote_url": remote_url(repo, upstream),
            },
        )
        fields["state_path"] = str(st_path)

    return WatchResult(
        fork_id=fork_id,
        fields=fields,
        new_tag_names=new_tag_names,
        remote_tag_names=remote_tag_names,
        first_tag_baseline=first_baseline,
    )


def emit_handoff_stub(fork: dict[str, Any], *, do_fetch: bool) -> str:
    """Fill known SHAs; leave tripwire/repairs for post-sync human fill."""
    repo = Path(fork["path"])
    origin = fork.get("origin", "origin")
    upstream = fork.get("upstream", "upstream")
    product = fork.get("product_branch", "lhc")
    up_branch = fork.get("upstream_branch", "main")
    if do_fetch:
        run_git(repo, "fetch", origin, "--prune", check=False)
        fetch_upstream_refs(repo, upstream, up_branch)

    candidate = rev_parse(repo, f"{origin}/{product}") or "none"
    up = rev_parse(repo, f"{upstream}/{up_branch}") or "none"
    base_file = repo / fork.get("patches_base_file", "patches/BASE")
    patches_base = (
        base_file.read_text(encoding="utf-8").strip() if base_file.is_file() else "none"
    )

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
        help="Write last-seen upstream SHA and tag baseline after a successful check",
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

    state_dir = expand(
        args.state_dir or cfg.get("state_dir_default", "~/.lhc-console/upstream-watch")
    )
    report_dir = expand(
        args.report_dir
        or cfg.get("report_dir_default", "~/.lhc-console/upstream-watch/reports")
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
            latest = report_dir / f"WATCH_{fid}_latest.txt"
            latest.write_text(block, encoding="utf-8")
            sys.stderr.write(f"wrote {out}\n")

        summaries.append(dict(result.fields))
        if result.fields["action"] in ("assess", "sync_candidate"):
            # Attention signal; systemd units set SuccessExitStatus=2.
            exit_code = max(exit_code, 2)

    if args.json_summary and summaries:
        sys.stderr.write(json.dumps({"reports": summaries}, indent=2) + "\n")

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
