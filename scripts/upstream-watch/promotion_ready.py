#!/usr/bin/env python3
"""LIM-40 promotion-ready packages + approval correlation (no auto-promote).

Records exact fork/version/source SHA/artifact digests, notifies CTO (and
optionally Lee via async one-way), and stores durable approval correlation so
the release qualifier can resume without rebuilding.

Does **not** call GitHub promote workflows. Residual: GitHub `production`
environment approval is not bound to this store — see docs/UPSTREAM_OWNER.md.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Reuse dispatch helpers
from dispatch import (
    DEFAULT_STATE_DIR,
    RELEASE_QUALIFIER,
    UPSTREAM_OWNER,
    already_sent,
    load_dispatched,
    mark_sent,
    run_lhc_agent_start,
    save_dispatched,
    utc_now,
)

CTO_AGENT = "cto"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$", re.I)


def packages_path(state_dir: Path) -> Path:
    return state_dir / "promotion_ready.json"


def load_packages(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {"version": 1, "packages": {}}
    return json.loads(path.read_text(encoding="utf-8"))


def save_packages(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def make_approval_id(fields: dict[str, str]) -> str:
    """Stable id over exact promote identity (not wall-clock)."""
    parts = [
        fields.get("fork", ""),
        fields.get("product_version", ""),
        fields.get("source_sha", ""),
        fields.get("candidate_run_id", ""),
        fields.get("candidate_digest", ""),
        fields.get("smoke_run_id", ""),
        fields.get("qualification_digest", ""),
    ]
    h = hashlib.sha256("|".join(parts).encode()).hexdigest()[:16]
    return f"pr-{fields.get('fork', 'fork')}-{fields.get('product_version', '0')}-{h}"


def parse_block(text: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    for line in text.splitlines():
        if ":" not in line:
            continue
        k, _, v = line.partition(":")
        k, v = k.strip(), v.strip()
        if k and not k.startswith("PROMOTION_READY"):
            fields[k] = v
    return fields


def validate_package(fields: dict[str, str]) -> tuple[bool, str]:
    required = [
        "fork",
        "product_version",
        "source_sha",
        "candidate_run_id",
        "candidate_digest",
        "smoke_run_id",
        "qualification_digest",
    ]
    for k in required:
        if not fields.get(k):
            return False, f"missing {k}"
    if fields["fork"] not in ("codex-lhc", "grok-build-lhc"):
        return False, "bad fork"
    if not SHA_RE.match(fields["source_sha"]):
        return False, "source_sha must be full 40-char hex"
    for dk in ("candidate_digest", "qualification_digest"):
        if not DIGEST_RE.match(fields[dk]):
            return False, f"{dk} must be sha256:<64 hex>"
    return True, "ok"


def render_package(fields: dict[str, str]) -> str:
    order = [
        "fork",
        "repo",
        "product_version",
        "source_sha",
        "upstream_base",
        "source_rev",
        "lhc_sdk_pin",
        "candidate_run_id",
        "candidate_artifact_id",
        "candidate_digest",
        "smoke_run_id",
        "qualification_artifact_id",
        "qualification_digest",
        "schema",
        "produced_by",
        "produced_at",
        "approval_status",
        "approval_id",
    ]
    lines = ["PROMOTION_READY v1"]
    for k in order:
        lines.append(f"{k}: {fields.get(k, 'none')}")
    return "\n".join(lines) + "\n"


def cmd_record(args: argparse.Namespace) -> int:
    text = Path(args.file).read_text(encoding="utf-8") if args.file else sys.stdin.read()
    fields = parse_block(text)
    ok, reason = validate_package(fields)
    if not ok:
        print(f"FAIL: {reason}", file=sys.stderr)
        return 1

    fields.setdefault("produced_at", utc_now())
    fields.setdefault("produced_by", "codex-fork-steward")
    fields.setdefault("approval_status", "pending")
    fields["approval_id"] = make_approval_id(fields)

    state_dir = Path(args.state_dir)
    path = packages_path(state_dir)
    data = load_packages(path)
    aid = fields["approval_id"]
    prev = (data.get("packages") or {}).get(aid)
    if prev and prev.get("approval_status") == "approved" and not args.force:
        # Immutable once approved — refuse overwrite of identity
        if any(prev.get(k) != fields.get(k) for k in (
            "source_sha",
            "candidate_digest",
            "qualification_digest",
            "candidate_run_id",
            "smoke_run_id",
        )):
            print(
                "FAIL: package id collision with different digests/sha (refusing)",
                file=sys.stderr,
            )
            return 1
        print(json.dumps({"status": "exists", "approval_id": aid, "package": prev}, indent=2))
        return 0

    pkg = dict(fields)
    data.setdefault("packages", {})[aid] = pkg
    save_packages(path, data)

    # Write human block
    out_dir = state_dir / "reports"
    out_dir.mkdir(parents=True, exist_ok=True)
    block = render_package(pkg)
    (out_dir / f"PROMOTION_READY_{pkg['fork']}_{aid}.txt").write_text(block, encoding="utf-8")
    (out_dir / f"PROMOTION_READY_{pkg['fork']}_latest.txt").write_text(block, encoding="utf-8")

    notify = not args.no_notify
    dry = args.dry_run
    notify_results: list[dict[str, Any]] = []
    if notify:
        msg = (
            "[from: release-qualify / LIM-40]\n"
            "PROMOTION_READY — exact Linux qualification complete. "
            "Promotion requires Lee or CTO approval of this approval_id only. "
            "Do not rebuild. Qualifier resumes promote with these digests only.\n\n"
            f"{block}\n"
            "CTO: you may async-notify Lee (lhc-agent lee …) with this block. "
            "Record approval: python3 scripts/upstream-watch/promotion_ready.py "
            f"approve {aid} --by cto|lee\n"
        )
        # Dedup notify to CTO
        ddata = load_dispatched(state_dir / "dispatched.json")
        nkey = f"promotion_ready_notify:{aid}"
        if already_sent(ddata, nkey) and not args.force:
            notify_results.append({"target": CTO_AGENT, "skipped": True, "reason": "already notified"})
        else:
            code, out = run_lhc_agent_start(
                CTO_AGENT, msg, dry_run=dry, from_agent="codex-fork-steward"
            )
            notify_results.append(
                {"target": CTO_AGENT, "exit": code, "out": out[:300], "dry_run": dry}
            )
            if code == 0 and not dry:
                mark_sent(
                    ddata,
                    nkey,
                    {"kind": "promotion_ready_notify", "approval_id": aid},
                )
                save_dispatched(state_dir / "dispatched.json", ddata)

    print(
        json.dumps(
            {
                "status": "recorded",
                "approval_id": aid,
                "package": pkg,
                "notify": notify_results,
            },
            indent=2,
        )
    )
    return 0


def cmd_approve(args: argparse.Namespace) -> int:
    state_dir = Path(args.state_dir)
    path = packages_path(state_dir)
    data = load_packages(path)
    pkg = (data.get("packages") or {}).get(args.approval_id)
    if not pkg:
        print(f"FAIL: unknown approval_id {args.approval_id}", file=sys.stderr)
        return 1

    # Bind approval to exact stored digests — caller cannot pass different bytes
    if args.expect_candidate_digest and args.expect_candidate_digest != pkg.get(
        "candidate_digest"
    ):
        print("FAIL: expect-candidate-digest mismatch — refusing (different bytes)", file=sys.stderr)
        return 1
    if args.expect_qualification_digest and args.expect_qualification_digest != pkg.get(
        "qualification_digest"
    ):
        print(
            "FAIL: expect-qualification-digest mismatch — refusing (different bytes)",
            file=sys.stderr,
        )
        return 1
    if args.expect_source_sha and args.expect_source_sha != pkg.get("source_sha"):
        print("FAIL: expect-source-sha mismatch — refusing", file=sys.stderr)
        return 1

    if pkg.get("approval_status") == "approved":
        # Idempotent if same package; still notify qualifier once more only if forced
        print(json.dumps({"status": "already_approved", "package": pkg}, indent=2))
        if not args.force_renotify:
            return 0

    pkg["approval_status"] = "approved"
    pkg["approved_by"] = args.by
    pkg["approved_at"] = utc_now()
    if args.note:
        pkg["approval_note"] = args.note
    data["packages"][args.approval_id] = pkg
    save_packages(path, data)

    # Resume instruction for qualifier — exact promote inputs, no rebuild
    resume = (
        "[from: approval-correlation / LIM-40]\n"
        f"APPROVED promotion package {args.approval_id} by {args.by}.\n"
        "Resume GitHub promote with THESE EXACT identities only — do not rebuild:\n\n"
        f"{render_package(pkg)}\n"
        "Codex promote inputs: version, candidate_run_id, smoke_run_id "
        "(and Grok equivalent). Reject if artifact digests differ.\n"
    )
    dry = args.dry_run
    code, out = run_lhc_agent_start(
        RELEASE_QUALIFIER, resume, dry_run=dry, from_agent="cto"
    )
    print(
        json.dumps(
            {
                "status": "approved",
                "approval_id": args.approval_id,
                "package": pkg,
                "qualifier_notify_exit": code,
                "qualifier_notify_out": out[:400],
                "dry_run": dry,
            },
            indent=2,
        )
    )
    return 0 if code == 0 or dry else 1


def cmd_show(args: argparse.Namespace) -> int:
    data = load_packages(packages_path(Path(args.state_dir)))
    if args.approval_id:
        pkg = (data.get("packages") or {}).get(args.approval_id)
        if not pkg:
            print("not found", file=sys.stderr)
            return 1
        print(render_package(pkg))
        return 0
    print(json.dumps(data, indent=2))
    return 0


def cmd_reject(args: argparse.Namespace) -> int:
    data = load_packages(packages_path(Path(args.state_dir)))
    pkg = (data.get("packages") or {}).get(args.approval_id)
    if not pkg:
        print("not found", file=sys.stderr)
        return 1
    pkg["approval_status"] = "rejected"
    pkg["rejected_by"] = args.by
    pkg["rejected_at"] = utc_now()
    if args.note:
        pkg["approval_note"] = args.note
    data["packages"][args.approval_id] = pkg
    save_packages(packages_path(Path(args.state_dir)), data)
    print(json.dumps({"status": "rejected", "package": pkg}, indent=2))
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="LIM-40 promotion-ready + approval correlation")
    p.add_argument("--state-dir", type=Path, default=DEFAULT_STATE_DIR)
    sub = p.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("record", help="Record PROMOTION_READY and notify CTO")
    r.add_argument("--file", type=Path, help="File with PROMOTION_READY block (default stdin)")
    r.add_argument("--no-notify", action="store_true")
    r.add_argument("--dry-run", action="store_true")
    r.add_argument("--force", action="store_true")

    a = sub.add_parser("approve", help="Record Lee/CTO approval for exact package")
    a.add_argument("approval_id")
    a.add_argument("--by", required=True, choices=["lee", "cto"])
    a.add_argument("--note", default="")
    a.add_argument("--expect-source-sha", default="")
    a.add_argument("--expect-candidate-digest", default="")
    a.add_argument("--expect-qualification-digest", default="")
    a.add_argument("--dry-run", action="store_true")
    a.add_argument("--force-renotify", action="store_true")

    j = sub.add_parser("reject", help="Reject a pending package")
    j.add_argument("approval_id")
    j.add_argument("--by", required=True, choices=["lee", "cto"])
    j.add_argument("--note", default="")

    s = sub.add_parser("show", help="Show package(s)")
    s.add_argument("approval_id", nargs="?", default="")

    args = p.parse_args(argv)
    if args.cmd == "record":
        return cmd_record(args)
    if args.cmd == "approve":
        return cmd_approve(args)
    if args.cmd == "reject":
        return cmd_reject(args)
    if args.cmd == "show":
        return cmd_show(args)
    return 2


if __name__ == "__main__":
    sys.exit(main())
