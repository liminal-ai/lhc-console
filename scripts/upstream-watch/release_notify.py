#!/usr/bin/env python3
"""Post-promote Lee notification (LIM-40 final acceptance).

Call **only after** CTO-approved promotion has succeeded **and** public release
verification has passed. Sends exactly one concise one-off via `lhc-agent lee`.

Dedupes by exact fork + release tag so retries do not message twice.
Does not notify on failure paths that skip verification (use lee-failure for
optional failed-verify notes). Does not promote, tag, or publish.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

from dispatch import (
    DEFAULT_STATE_DIR,
    already_sent,
    load_dispatched,
    mark_sent,
    run_lhc_agent_start,
    save_dispatched,
    utc_now,
)

# Registered agent key for --from (lee requires a sender).
DEFAULT_FROM = "codex-fork-steward"
TAG_RE = re.compile(r"^v?[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$")


def lee_success_dedupe_key(fork: str, tag: str) -> str:
    tag_n = tag if tag.startswith("v") else f"v{tag}"
    return f"lee_release_success:{fork}:{tag_n}"


def normalize_tag(version_or_tag: str) -> str:
    v = version_or_tag.strip()
    if not v:
        raise ValueError("empty version/tag")
    return v if v.startswith("v") else f"v{v}"


def build_lee_success_message(
    *,
    fork: str,
    version: str,
    summary: str,
    platforms: str,
    limitations: str = "",
    product: str = "",
) -> str:
    """Plain-language Lee note — no run IDs or digests."""
    product = product or fork
    ver = version.lstrip("v")
    lines = [
        f"{product} {ver} is published.",
        summary.strip(),
        f"Platforms: {platforms.strip()}.",
    ]
    lim = limitations.strip()
    if lim:
        lines.append(f"Note: {lim}")
    return "\n".join(lines) + "\n"


def build_lee_failure_message(
    *,
    fork: str,
    version: str,
    reason: str,
) -> str:
    """Only when public verification failed — may include minimal process detail."""
    ver = version.lstrip("v")
    return (
        f"{fork} {ver}: public release verification failed.\n"
        f"{reason.strip()}\n"
        "No further install recommended until fixed.\n"
    )


def notify_lee_success(
    *,
    fork: str,
    version: str,
    summary: str,
    platforms: str,
    limitations: str = "",
    product: str = "",
    tag: str | None = None,
    state_dir: Path = DEFAULT_STATE_DIR,
    from_agent: str = DEFAULT_FROM,
    dry_run: bool = False,
    force: bool = False,
) -> dict[str, Any]:
    tag_n = normalize_tag(tag or version)
    if not TAG_RE.match(tag_n):
        return {"ok": False, "error": f"invalid tag/version {tag_n!r}"}
    if fork not in ("codex-lhc", "grok-build-lhc"):
        return {"ok": False, "error": f"unknown fork {fork!r}"}

    key = lee_success_dedupe_key(fork, tag_n)
    data = load_dispatched(state_dir / "dispatched.json")
    if not force and already_sent(data, key):
        return {
            "ok": True,
            "dispatched": False,
            "skipped": True,
            "reason": "already notified for this fork/tag",
            "dedupe_key": key,
        }

    msg = build_lee_success_message(
        fork=fork,
        version=version,
        summary=summary,
        platforms=platforms,
        limitations=limitations,
        product=product,
    )
    # Guard: success path must not smuggle digests/run ids
    if "sha256:" in msg.lower() or re.search(r"\brun\s+\d{6,}\b", msg, re.I):
        return {
            "ok": False,
            "error": "success message must not include digests or run IDs",
        }

    code, out = run_lhc_agent_start(
        "lee",
        msg,
        dry_run=dry_run,
        from_agent=from_agent,
    )
    result: dict[str, Any] = {
        "ok": code == 0,
        "dispatched": code == 0 and not dry_run,
        "skipped": False,
        "dedupe_key": key,
        "agent_exit": code,
        "agent_out": out[:300],
        "dry_run": dry_run,
        "message": msg,
    }
    if code != 0:
        result["error"] = out
        # failure visibility
        log = state_dir / "reports" / "DISPATCH_FAILURES.log"
        log.parent.mkdir(parents=True, exist_ok=True)
        with log.open("a", encoding="utf-8") as f:
            f.write(f"{utc_now()} FAIL lee-success key={key} exit={code} {out[:200]}\n")
        return result

    if not dry_run:
        mark_sent(
            data,
            key,
            {
                "kind": "lee_release_success",
                "fork": fork,
                "tag": tag_n,
                "version": version.lstrip("v"),
            },
        )
        save_dispatched(state_dir / "dispatched.json", data)
    return result


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="LIM-40 post-verify Lee release notify")
    p.add_argument("--state-dir", type=Path, default=DEFAULT_STATE_DIR)
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser(
        "lee-success",
        help="One Lee notify after promote + public verification success",
    )
    s.add_argument("--fork", required=True, choices=["codex-lhc", "grok-build-lhc"])
    s.add_argument("--version", required=True, help="SemVer with or without v")
    s.add_argument("--tag", default="", help="Release tag (default v{version})")
    s.add_argument("--product", default="", help="Display name (default fork id)")
    s.add_argument(
        "--summary",
        required=True,
        help="Plain-language what changed (one or two sentences)",
    )
    s.add_argument(
        "--platforms",
        required=True,
        help="Supported published platforms, e.g. 'Linux x86_64'",
    )
    s.add_argument(
        "--limitations",
        default="",
        help="Material limitation or required action (optional)",
    )
    s.add_argument("--from-agent", default=DEFAULT_FROM)
    s.add_argument("--dry-run", action="store_true")
    s.add_argument("--force", action="store_true", help="Bypass dedupe (debug only)")

    f = sub.add_parser(
        "lee-failure",
        help="Optional Lee note when public verification failed (not for success path)",
    )
    f.add_argument("--fork", required=True, choices=["codex-lhc", "grok-build-lhc"])
    f.add_argument("--version", required=True)
    f.add_argument("--reason", required=True)
    f.add_argument("--from-agent", default=DEFAULT_FROM)
    f.add_argument("--dry-run", action="store_true")

    args = p.parse_args(argv)
    if args.cmd == "lee-success":
        r = notify_lee_success(
            fork=args.fork,
            version=args.version,
            summary=args.summary,
            platforms=args.platforms,
            limitations=args.limitations,
            product=args.product,
            tag=args.tag or None,
            state_dir=args.state_dir,
            from_agent=args.from_agent,
            dry_run=args.dry_run,
            force=args.force,
        )
        print(json.dumps(r, indent=2))
        if r.get("skipped"):
            return 0
        return 0 if r.get("ok") else 1

    if args.cmd == "lee-failure":
        msg = build_lee_failure_message(
            fork=args.fork, version=args.version, reason=args.reason
        )
        code, out = run_lhc_agent_start(
            "lee", msg, dry_run=args.dry_run, from_agent=args.from_agent
        )
        print(json.dumps({"ok": code == 0, "exit": code, "out": out[:300], "message": msg}, indent=2))
        return 0 if code == 0 else 1

    return 2


if __name__ == "__main__":
    sys.exit(main())
