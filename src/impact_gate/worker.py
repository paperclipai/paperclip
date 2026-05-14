"""Impact Gate polling worker — scan done fix issues and run the gate.

The impact gate verifies that every recently-done fix/bug issue has at
least one fix commit referencing its identifier touching real source
files.  Issues that pass the gate contribute to the quality score; issues
that fail produce an alert so the team can remediate.

Polling mode (default): queries Paperclip for all done issues closed in
the last N minutes, runs the gate, writes a JSON summary.

Webhook mode (--issue-id): gates a single issue by UUID (triggered by
Paperclip issue_status_changed events).

Usage:
    python scripts/run_impact_gate_worker.py [--lookback-minutes N] [--dry-run]
    python scripts/run_impact_gate_worker.py --issue-id <uuid> [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import logging
import subprocess
import sys
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Sequence

logger = logging.getLogger(__name__)

_REPO_ROOT = Path(__file__).parents[2]

_SOURCE_EXTENSIONS = {".py", ".ts", ".tsx", ".js", ".jsx", ".go", ".rs", ".java"}
_SKIP_PREFIXES = (".", "alembic/", "docs/", ".github/", "archived/")


def _is_source_file(path: str) -> bool:
    if any(path.startswith(p) for p in _SKIP_PREFIXES):
        return False
    return Path(path).suffix in _SOURCE_EXTENSIONS


def _parse_completed_at(issue: dict) -> datetime | None:
    raw = issue.get("completedAt")
    if raw is None or raw == "":
        return None
    if not isinstance(raw, str):
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None


def _get_fix_commits(issue_identifier: str) -> list[dict]:
    """Find fix commits referencing issue_identifier, return SHAs + files."""
    try:
        out = subprocess.run(
            ["git", "log", "--all", "--format=%H", f"--grep={issue_identifier}"],
            cwd=str(_REPO_ROOT),
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError) as exc:
        logger.error("git log failed for %s: %s", issue_identifier, exc)
        return []

    hashes = [h.strip() for h in out.stdout.splitlines() if h.strip()]
    results = []
    for sha in hashes[:20]:
        try:
            show = subprocess.run(
                ["git", "show", "--name-only", "--format=", sha],
                cwd=str(_REPO_ROOT),
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
            continue
        files = [
            f.strip()
            for f in show.stdout.splitlines()
            if f.strip() and _is_source_file(f.strip())
        ]
        if files:
            results.append({"sha": sha, "files": sorted(set(files))})
    return results


@dataclass
class GateResult:
    issue_id: str
    issue_identifier: str
    status: str  # "pass" | "fail" | "skip"
    reason: str = ""
    fix_commits: int = 0
    source_files: list[str] = field(default_factory=list)
    completed_at: str | None = None
    issue_title: str = ""


def gate_issue(
    issue: dict,
    *,
    dry_run: bool = False,
) -> GateResult:
    """Run the impact gate on a single done issue."""
    identifier = issue.get("identifier", "")
    issue_id = issue.get("id", "")
    title = issue.get("title", "")
    completed_at = issue.get("completedAt")

    # Skip FDR-labelled issues
    if "d523cb2d-acd9-423d-b87a-bb79cee42c40" in (issue.get("labelIds") or []):
        return GateResult(
            issue_id=issue_id,
            issue_identifier=identifier,
            status="skip",
            reason="FDR-labelled issue",
            issue_title=title,
        )

    if issue.get("status") != "done":
        return GateResult(
            issue_id=issue_id,
            issue_identifier=identifier,
            status="skip",
            reason=f"status is {issue.get('status')!r}, not done",
            issue_title=title,
        )

    fix_commits = _get_fix_commits(identifier)

    if not fix_commits:
        return GateResult(
            issue_id=issue_id,
            issue_identifier=identifier,
            status="fail",
            reason="no fix commits found referencing this issue",
            issue_title=title,
            completed_at=completed_at,
        )

    all_files = sorted(set(f for c in fix_commits for f in c["files"]))

    if not all_files:
        return GateResult(
            issue_id=issue_id,
            issue_identifier=identifier,
            status="fail",
            reason="fix commits found but no source files touched",
            issue_title=title,
            completed_at=completed_at,
        )

    return GateResult(
        issue_id=issue_id,
        issue_identifier=identifier,
        status="pass",
        reason="ok",
        fix_commits=len(fix_commits),
        source_files=all_files,
        completed_at=completed_at,
        issue_title=title,
    )


def run_gate(
    issues: Sequence[dict],
    *,
    dry_run: bool = False,
) -> list[GateResult]:
    """Run the impact gate on a batch of issues."""
    results = []
    for issue in issues:
        try:
            result = gate_issue(issue, dry_run=dry_run)
            results.append(result)
            level = logging.INFO if result.status == "pass" else logging.WARNING
            logger.log(
                level,
                "Gate %s: %s \u2014 %s",
                result.issue_identifier,
                result.status.upper(),
                result.reason,
            )
            if result.source_files:
                logger.info("  %d source file(s)", len(result.source_files))
        except Exception:
            logger.exception("Gate error for %s", issue.get("identifier"))
            results.append(
                GateResult(
                    issue_id=issue.get("id", ""),
                    issue_identifier=issue.get("identifier", ""),
                    status="fail",
                    reason="exception during gate check",
                    issue_title=issue.get("title", ""),
                )
            )
    return results


def format_summary(results: list[GateResult]) -> dict:
    """Summarize gate results as a JSON-serialisable dict."""
    total = len(results)
    passed = sum(1 for r in results if r.status == "pass")
    failed = sum(1 for r in results if r.status == "fail")
    skipped = sum(1 for r in results if r.status == "skip")
    return {
        "gate": "impact_gate",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "total": total,
        "passed": passed,
        "failed": failed,
        "skipped": skipped,
        "pass_rate": round(passed / total * 100, 1) if total else 100.0,
        "results": [asdict(r) for r in results],
    }


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Impact Gate \u2014 scan done fix/bug issues for quality gate."
    )
    parser.add_argument(
        "--issue-id",
        help="Gate a single issue by UUID (webhook mode).",
        default="",
    )
    parser.add_argument(
        "--lookback-minutes",
        type=int,
        default=10,
        help="Scan done issues completed within this many minutes (polling mode).",
    )
    parser.add_argument(
        "--json-summary",
        action="store_true",
        help="Print JSON summary to stdout after run.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Log what would be done but make no changes.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    """CLI entry point."""
    args = _parse_args(argv or sys.argv[1:])

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    try:
        from impact_gate.paperclip_client import (
            get_all_done_issues,
            get_issue_by_id,
        )
    except ImportError:
        # Fallback: touch_index has the same paperclip_client module
        sys.path.insert(0, str(_REPO_ROOT / "src"))
        from touch_index.paperclip_client import (
            get_all_done_issues,
            get_issue_by_id,
        )

    if args.issue_id:
        issue = get_issue_by_id(args.issue_id)
        if issue is None:
            logger.error("Issue %s not found", args.issue_id)
            return 1
        results = run_gate([issue], dry_run=args.dry_run)
    else:
        cutoff = datetime.now(timezone.utc)
        issues = get_all_done_issues(completed_after=cutoff)
        if not issues:
            logger.info("No done issues found in lookback window \u2014 nothing to gate")
            return 0
        logger.info("Gating %d done issue(s)", len(issues))
        results = run_gate(issues, dry_run=args.dry_run)

    summary = format_summary(results)
    logger.info(
        "Gate complete: %d/%d passed (%.1f%%), %d failed, %d skipped",
        summary["passed"],
        summary["total"],
        summary["pass_rate"],
        summary["failed"],
        summary["skipped"],
    )

    if args.json_summary:
        print(json.dumps(summary, indent=2))

    return 0 if summary["failed"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
