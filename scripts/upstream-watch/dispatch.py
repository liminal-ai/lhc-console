#!/usr/bin/env python3
"""Deduplicated lhc-agent dispatch for LIM-40 watch/handoff (no auto-merge/release).

Policy:
  - WATCH attention (assess / sync_candidate) → grok-build-fork-steward only
  - Never start release qualification from raw watch
  - CANDIDATE_HANDOFF with tripwire=GREEN and recommended=QUALIFY → codex-fork-steward only
  - Durable dedupe under ~/.lhc-console/upstream-watch/dispatched.json
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_STATE_DIR = Path.home() / ".lhc-console" / "upstream-watch"
DEFAULT_DISPATCH_FILE = "dispatched.json"
UPSTREAM_OWNER = "grok-build-fork-steward"
RELEASE_QUALIFIER = "codex-fork-steward"
LHC_AGENT = os.environ.get("LHC_AGENT_BIN", "lhc-agent")


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def dispatch_path(state_dir: Path) -> Path:
    return state_dir / DEFAULT_DISPATCH_FILE


def load_dispatched(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {"version": 1, "entries": {}}
    data = json.loads(path.read_text(encoding="utf-8"))
    if "entries" not in data:
        data = {"version": 1, "entries": data}
    return data


def save_dispatched(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def already_sent(data: dict[str, Any], key: str) -> bool:
    return key in (data.get("entries") or {})


def mark_sent(data: dict[str, Any], key: str, meta: dict[str, Any]) -> None:
    entries = data.setdefault("entries", {})
    entries[key] = {**meta, "sent_at": utc_now()}


def watch_dedupe_key(fields: dict[str, str]) -> str:
    """Stable key so restart/same tip does not re-spam."""
    fork = fields.get("fork", "unknown")
    action = fields.get("action", "none")
    up = fields.get("upstream_sha", "none")
    rel = fields.get("upstream_release_event", "none")
    behind = fields.get("behind", "0")
    return f"watch:{fork}:{action}:{up}:{rel}:behind={behind}"


def handoff_dedupe_key(fork: str, candidate_sha: str) -> str:
    return f"handoff:{fork}:{candidate_sha}"


def parse_handoff_block(text: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    for line in text.splitlines():
        if ":" not in line:
            continue
        k, _, v = line.partition(":")
        k, v = k.strip(), v.strip()
        if k and k != "CANDIDATE_HANDOFF v1":
            fields[k] = v
    return fields


def is_qualifying_handoff(fields: dict[str, str]) -> tuple[bool, str]:
    if fields.get("tripwire") != "GREEN":
        return False, "tripwire not GREEN"
    if fields.get("recommended") != "QUALIFY":
        return False, f"recommended={fields.get('recommended')!r} (need QUALIFY)"
    cand = fields.get("candidate_sha", "")
    if not re.fullmatch(r"[0-9a-f]{40}", cand):
        return False, "candidate_sha not full 40-char sha"
    fork = fields.get("fork", "")
    if fork not in ("codex-lhc", "grok-build-lhc"):
        return False, f"unknown fork {fork!r}"
    return True, "ok"


def run_lhc_agent_start(
    agent: str,
    message: str,
    *,
    dry_run: bool = False,
    from_agent: str | None = "upstream-watch",
) -> tuple[int, str]:
    """Detached start — never blocking peer call."""
    cmd = [LHC_AGENT, "start"]
    if from_agent:
        cmd.extend(["--from", from_agent])
    cmd.extend([agent, message])
    if dry_run:
        return 0, f"DRY_RUN {' '.join(cmd[:6])}… ({len(message)} bytes)"
    try:
        p = subprocess.run(
            cmd,
            check=False,
            text=True,
            capture_output=True,
            timeout=120,
        )
    except FileNotFoundError:
        return 1, f"lhc-agent not found ({LHC_AGENT})"
    except subprocess.TimeoutExpired:
        return 1, "lhc-agent start timed out"
    out = ((p.stdout or "") + (p.stderr or "")).strip()
    return p.returncode, out or f"exit {p.returncode}"


def log_failure(report_dir: Path | None, line: str) -> None:
    sys.stderr.write(line + "\n")
    if report_dir is None:
        return
    report_dir.mkdir(parents=True, exist_ok=True)
    path = report_dir / "DISPATCH_FAILURES.log"
    with path.open("a", encoding="utf-8") as f:
        f.write(f"{utc_now()} {line}\n")


def dispatch_watch_attention(
    fields: dict[str, str],
    report_text: str,
    *,
    state_dir: Path,
    report_dir: Path | None,
    dry_run: bool = False,
    force: bool = False,
) -> dict[str, Any]:
    """Notify upstream-owner only. Never release qualifier."""
    action = fields.get("action", "none")
    result: dict[str, Any] = {
        "kind": "watch",
        "fork": fields.get("fork"),
        "action": action,
        "dispatched": False,
        "skipped": False,
        "target": UPSTREAM_OWNER,
    }
    if action not in ("assess", "sync_candidate"):
        result["skipped"] = True
        result["reason"] = "no attention action"
        return result

    key = watch_dedupe_key(fields)
    result["dedupe_key"] = key
    data = load_dispatched(dispatch_path(state_dir))
    if not force and already_sent(data, key):
        result["skipped"] = True
        result["reason"] = "already dispatched"
        return result

    msg = (
        f"[from: upstream-watch / LIM-40]\n"
        f"WATCH attention — action={action} fork={fields.get('fork')}.\n"
        f"This is NOT release qualification. Do not promote/tag/smoke from this alone.\n"
        f"Assess and, if authorized, run FORK sync drill; then emit CANDIDATE_HANDOFF.\n\n"
        f"{report_text}"
    )
    code, out = run_lhc_agent_start(UPSTREAM_OWNER, msg, dry_run=dry_run)
    result["agent_exit"] = code
    result["agent_out"] = out[:500]
    if code != 0:
        log_failure(
            report_dir,
            f"FAIL watch dispatch key={key} exit={code} out={out[:200]}",
        )
        result["error"] = out
        return result

    if not dry_run:
        mark_sent(
            data,
            key,
            {
                "kind": "watch",
                "fork": fields.get("fork"),
                "action": action,
                "upstream_sha": fields.get("upstream_sha"),
                "job": out.splitlines()[-1] if out else "",
            },
        )
        save_dispatched(dispatch_path(state_dir), data)
    result["dispatched"] = True
    return result


def dispatch_handoff_file(
    path: Path,
    *,
    state_dir: Path,
    report_dir: Path | None,
    dry_run: bool = False,
    force: bool = False,
) -> dict[str, Any]:
    """Send QUALIFY handoff to release qualifier only."""
    text = path.read_text(encoding="utf-8")
    fields = parse_handoff_block(text)
    ok, reason = is_qualifying_handoff(fields)
    result: dict[str, Any] = {
        "kind": "handoff",
        "path": str(path),
        "fork": fields.get("fork"),
        "candidate_sha": fields.get("candidate_sha"),
        "dispatched": False,
        "skipped": False,
        "target": RELEASE_QUALIFIER,
    }
    if not ok:
        result["skipped"] = True
        result["reason"] = reason
        return result

    key = handoff_dedupe_key(fields["fork"], fields["candidate_sha"])
    result["dedupe_key"] = key
    data = load_dispatched(dispatch_path(state_dir))
    if not force and already_sent(data, key):
        result["skipped"] = True
        result["reason"] = "already dispatched"
        return result

    msg = (
        f"[from: upstream-owner / LIM-40]\n"
        f"CANDIDATE_HANDOFF ready for release qualification only.\n"
        f"Qualify exact candidate_sha; do not rebuild after smoke; promote only with Lee/CTO.\n\n"
        f"{text}"
    )
    code, out = run_lhc_agent_start(RELEASE_QUALIFIER, msg, dry_run=dry_run)
    result["agent_exit"] = code
    result["agent_out"] = out[:500]
    if code != 0:
        log_failure(
            report_dir,
            f"FAIL handoff dispatch key={key} exit={code} out={out[:200]}",
        )
        result["error"] = out
        return result

    if not dry_run:
        mark_sent(
            data,
            key,
            {
                "kind": "handoff",
                "fork": fields.get("fork"),
                "candidate_sha": fields.get("candidate_sha"),
                "job": out.splitlines()[-1] if out else "",
            },
        )
        save_dispatched(dispatch_path(state_dir), data)
    result["dispatched"] = True
    return result


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="LIM-40 deduplicated dispatch")
    sub = p.add_subparsers(dest="cmd", required=True)

    w = sub.add_parser("watch-report", help="Dispatch attention from a WATCH_REPORT file")
    w.add_argument("report", type=Path)
    w.add_argument("--state-dir", type=Path, default=DEFAULT_STATE_DIR)
    w.add_argument("--report-dir", type=Path, default=None)
    w.add_argument("--dry-run", action="store_true")
    w.add_argument("--force", action="store_true")

    h = sub.add_parser("handoff", help="Dispatch QUALIFY CANDIDATE_HANDOFF file to release qualifier")
    h.add_argument("handoff", type=Path)
    h.add_argument("--state-dir", type=Path, default=DEFAULT_STATE_DIR)
    h.add_argument("--report-dir", type=Path, default=None)
    h.add_argument("--dry-run", action="store_true")
    h.add_argument("--force", action="store_true")

    args = p.parse_args(argv)
    if args.cmd == "watch-report":
        text = args.report.read_text(encoding="utf-8")
        fields = parse_handoff_block(text)  # same key: value parser
        # ensure action field from WATCH
        r = dispatch_watch_attention(
            fields,
            text,
            state_dir=args.state_dir,
            report_dir=args.report_dir or args.state_dir / "reports",
            dry_run=args.dry_run,
            force=args.force,
        )
        print(json.dumps(r, indent=2))
        return 0 if r.get("dispatched") or r.get("skipped") else 1

    if args.cmd == "handoff":
        r = dispatch_handoff_file(
            args.handoff,
            state_dir=args.state_dir,
            report_dir=args.report_dir or args.state_dir / "reports",
            dry_run=args.dry_run,
            force=args.force,
        )
        print(json.dumps(r, indent=2))
        return 0 if r.get("dispatched") or r.get("skipped") else 1

    return 2


if __name__ == "__main__":
    sys.exit(main())
