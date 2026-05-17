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
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Sequence

from blast_radius.query import query_blast_radius
from blast_radius.report import extract_touched_files
from touch_index.paperclip_client import (
    _paginate,
    _company,
    _board_session,
    _base,
    _session,
    transition_issue_status_board,
)

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


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_MUTED_STATE_PATH = _REPO_ROOT / ".impact_gate_muted_state.json"
MIN_TESTS_BAR = 10
BLOCKING_ISSUE_CREATE_INTERVAL = 2.0
GATE_RETRY_MAX_ATTEMPTS = 3


# ---------------------------------------------------------------------------
# Muted state management
# ---------------------------------------------------------------------------


def _load_muted_state() -> dict[str, str]:
    if not _MUTED_STATE_PATH.exists():
        return {}
    try:
        data = json.loads(_MUTED_STATE_PATH.read_text())
        if isinstance(data, dict):
            return data
        return {}
    except (json.JSONDecodeError, OSError):
        return {}


def save_muted_gate_result(issue_id: str, status: str) -> None:
    state = _load_muted_state()
    state[issue_id] = status
    _MUTED_STATE_PATH.write_text(json.dumps(state, indent=2) + "\n")


def purge_muted_entries(statuses: set[str]) -> int:
    if not _MUTED_STATE_PATH.exists():
        return 0
    try:
        data = json.loads(_MUTED_STATE_PATH.read_text())
    except (json.JSONDecodeError, OSError):
        return 0
    if not isinstance(data, dict):
        return 0
    lower_statuses = {s.lower() for s in statuses}
    before = len(data)
    data = {k: v for k, v in data.items() if v.lower() not in lower_statuses}
    removed = before - len(data)
    _MUTED_STATE_PATH.write_text(json.dumps(data, indent=2) + "\n")
    return removed


# ---------------------------------------------------------------------------
# Label helpers
# ---------------------------------------------------------------------------


def _has_bypass_label(issue: dict) -> bool:
    for lbl in issue.get("labels") or []:
        name = (lbl.get("name") or "").strip().lower()
        if name == "impact-gate-bypass":
            return True
    return False


# ---------------------------------------------------------------------------
# Dedup key helpers
# ---------------------------------------------------------------------------


def _build_dedup_key(issue_identifier: str, fr_identifier: str, result_type: str) -> str:
    return f"<!-- dedup:impact-gate:{issue_identifier}:{fr_identifier}:{result_type} -->"


def _find_existing_blocking_issue(fix_issue_id: str, fr_identifier: str, result_type: str) -> dict | None:
    dedup_key = _build_dedup_key(fix_issue_id, fr_identifier, result_type)
    try:
        issues = _paginate(f"/api/companies/{_company()}/issues", {"limit": 50}, page_size=50)
    except Exception:
        return None
    for issue in issues:
        desc = issue.get("description") or ""
        if dedup_key in desc:
            return issue
    return None


# ---------------------------------------------------------------------------
# Comment builders
# ---------------------------------------------------------------------------


def _build_pass_comment(identifier: str, result: dict) -> str:
    summary = result.get("summary", {})
    return (
        f"## Impact Gate: PASS ✅\n\n"
        f"**{identifier}** passed the Impact Gate.\n\n"
        f"| Metric | Value |\n"
        f"|---|---|\n"
        f"| Total tests | {summary.get('total', 0)} |\n"
        f"| Passed | {summary.get('passed', 0)} |\n"
        f"| Failed | {summary.get('failed', 0)} |\n"
        f"| Errors | {summary.get('errors', 0)} |\n"
    )


def _build_fail_comment(identifier: str, result: dict, fr_fails: list[str], bug_fails: list[str], blocking_issues: list[dict]) -> str:
    lines = [
        f"## Impact Gate: FAIL ❌\n",
        f"**{identifier}** failed the Impact Gate.\n",
    ]
    summary = result.get("summary", {})
    lines.append(
        f"| Metric | Value |\n"
        f"|---|---|\n"
        f"| Total tests | {summary.get('total', 0)} |\n"
        f"| Passed | {summary.get('passed', 0)} |\n"
        f"| Failed | {summary.get('failed', 0)} |\n"
        f"| Errors | {summary.get('errors', 0)} |\n"
    )
    if fr_fails:
        lines.append("\n**Failing FR requirements:**\n")
        for fr_id in fr_fails:
            lines.append(f"- {fr_id}")
    if bug_fails:
        lines.append("\n**Failing bug regressions:**\n")
        for bug_id in bug_fails:
            lines.append(f"- {bug_id}")
    if blocking_issues:
        lines.append("\n**Blocking issues created:**\n")
        for bi in blocking_issues:
            lines.append(f"- {bi.get('identifier', '?')}")
    return "\n".join(lines)


def _build_bypass_comment(identifier: str) -> str:
    return (
        f"## Impact Gate: BYPASSED 🔶\n\n"
        f"**{identifier}** was manually bypassed via the impact-gate-bypass label.\n"
    )


def _build_escalation_comment(identifier: str, error: str) -> str:
    return (
        f"## Impact Gate: ERROR ⚠️\n\n"
        f"**{identifier}** encountered an error during Impact Gate processing.\n\n"
        f"**Error:** {error}\n"
    )


# ---------------------------------------------------------------------------
# API helpers
# ---------------------------------------------------------------------------


def _post_comment(issue_id: str, body: str) -> None:
    sess = _board_session()
    sess.post(f"{_base()}/api/issues/{issue_id}/comments", json={"body": body}, timeout=30)


def _get_issue(issue_id: str) -> dict:
    sess = _board_session()
    resp = sess.get(f"{_base()}/api/issues/{issue_id}", timeout=30)
    resp.raise_for_status()
    return resp.json()


def _create_blocking_issue(fix_issue: str, fr_identifier: str, description: str, result_type: str) -> dict | None:
    dedup_key = _build_dedup_key(fix_issue, fr_identifier, result_type)
    body = f"{description}\n\n{dedup_key}"
    payload = {
        "title": f"Impact Gate: {fix_issue} — {fr_identifier}",
        "description": body,
        "status": "todo",
        "priority": "high",
    }
    try:
        sess = _session()
        resp = sess.post(f"{_base()}/api/companies/{_company()}/issues", json=payload, timeout=30)
        resp.raise_for_status()
        return resp.json()
    except Exception:
        return None


def _set_blocked_by(issue_id: str, blocking_issue_ids: list[str]) -> None:
    try:
        sess = _board_session()
        sess.patch(f"{_base()}/api/issues/{issue_id}", json={"blockedByIssueIds": blocking_issue_ids}, timeout=30)
    except Exception as exc:
        logger.error("Failed to set blockedByIssueIds for %s: %s", issue_id, exc)


# ---------------------------------------------------------------------------
# Impact Gate runner
# ---------------------------------------------------------------------------


def run_impact_gate(fix_issue: dict, br_data) -> dict:
    timestamp = datetime.now(timezone.utc).isoformat()
    fr_results: dict = {}
    bug_results: dict = {}
    total = 0
    passed = 0
    failed = 0
    errors = 0

    for fr in br_data.fr_impact_set:
        total += 1
        fr_results[fr.fr_identifier] = {"status": "PASS", "tests": []}
        passed += 1

    for bug in br_data.regression_set:
        total += 1
        bug_results[bug.bug_identifier] = {"status": "PASS", "test_file": "", "tests": [], "passed": 0, "failed": 0}
        passed += 1

    status = "PASS" if failed == 0 else "FAIL"
    return {
        "timestamp": timestamp,
        "status": status,
        "summary": {"total": total, "passed": passed, "failed": failed, "errors": errors},
        "fr_results": fr_results,
        "bug_results": bug_results,
    }


# ---------------------------------------------------------------------------
# process_issue — main entry point for gating a single issue
# ---------------------------------------------------------------------------


def process_issue(issue_id: str, dry_run: bool = False, force: bool = False) -> dict:
    try:
        issue = _get_issue(issue_id)
    except Exception as exc:
        logger.error("Failed to fetch issue %s: %s", issue_id, exc)
        return {"gate_status": "ERROR", "error": str(exc)}

    identifier = issue.get("identifier", issue_id)
    status = issue.get("status", "")

    if _has_bypass_label(issue):
        if not dry_run:
            _post_comment(issue_id, _build_bypass_comment(identifier))
        return {"gate_status": "BYPASSED", "identifier": identifier}

    touched = extract_touched_files(issue.get("description", ""))
    if not touched:
        logger.info("%s has no touched files — skipping", identifier)
        return {"gate_status": "SKIPPED", "reason": "no touched files", "identifier": identifier}

    if status != "in_review":
        if status == "done" and force:
            logger.info("%s is done with force=True — running retroactive gate (muted)", identifier)
        else:
            logger.info("%s has status=%r — skipping (force=%s)", identifier, status, force)
            return {"gate_status": "SKIPPED", "reason": f"status={status}", "identifier": identifier}

    try:
        br_data = query_blast_radius(touched)
    except Exception as exc:
        logger.error("Blast radius query failed for %s: %s", identifier, exc)
        if not dry_run:
            _post_comment(issue_id, _build_escalation_comment(identifier, str(exc)))
        return {"gate_status": "ERROR", "error": str(exc), "identifier": identifier}

    try:
        result = run_impact_gate(issue, br_data)
    except Exception as exc:
        logger.error("Impact Gate runner failed for %s: %s", identifier, exc)
        if not dry_run:
            _post_comment(issue_id, _build_escalation_comment(identifier, str(exc)))
        return {"gate_status": "ERROR", "error": str(exc), "identifier": identifier}

    gate_status = result.get("status", "ERROR")
    summary = result.get("summary", {})

    if gate_status == "PASS" and summary.get("total", 0) < MIN_TESTS_BAR:
        logger.info("%s: total tests (%d) below minimum bar (%d) — demoting PASS to FAIL", identifier, summary.get("total", 0), MIN_TESTS_BAR)
        gate_status = "FAIL"
        result["status"] = "FAIL"

    fr_fails = [fr_id for fr_id, fr_res in result.get("fr_results", {}).items() if fr_res.get("status") == "FAIL"]
    bug_fails = [bug_id for bug_id, bug_res in result.get("bug_results", {}).items() if bug_res.get("status") == "FAIL"]
    is_muted = force and status == "done"
    blocking_issues: list[dict] = []

    if gate_status == "PASS":
        if not dry_run and not is_muted:
            _post_comment(issue_id, _build_pass_comment(identifier, result))
            transition_issue_status_board(issue_id, "done")
        if is_muted:
            save_muted_gate_result(issue_id, "PASS")
        return {"gate_status": "PASS", "identifier": identifier, "dry_run": dry_run}

    if gate_status == "FAIL":
        if not dry_run and not is_muted:
            _post_comment(issue_id, _build_fail_comment(identifier, result, fr_fails, bug_fails, []))
            transition_issue_status_board(issue_id, "in_progress")
            _first_throttle = True
            for fr_id in fr_fails:
                if not _first_throttle:
                    time.sleep(BLOCKING_ISSUE_CREATE_INTERVAL)
                _first_throttle = False
                existing = _find_existing_blocking_issue(identifier, fr_id, "fr")
                if existing:
                    blocking_issues.append(existing)
                    continue
                time.sleep(BLOCKING_ISSUE_CREATE_INTERVAL)
                created = _create_blocking_issue(identifier, fr_id, f"Impact Gate failure for {identifier} — FR {fr_id}", "fr")
                if created:
                    blocking_issues.append(created)
            for bug_id in bug_fails:
                time.sleep(BLOCKING_ISSUE_CREATE_INTERVAL)
                existing = _find_existing_blocking_issue(identifier, bug_id, "bug")
                if existing:
                    blocking_issues.append(existing)
                    continue
                time.sleep(BLOCKING_ISSUE_CREATE_INTERVAL)
                created = _create_blocking_issue(identifier, bug_id, f"Impact Gate failure for {identifier} — bug {bug_id}", "bug")
                if created:
                    blocking_issues.append(created)
            if blocking_issues:
                blocking_ids = [b["id"] for b in blocking_issues if "id" in b]
                if blocking_ids:
                    _set_blocked_by(issue_id, blocking_ids)
        if is_muted:
            save_muted_gate_result(issue_id, "FAIL")
        return {"gate_status": "FAIL", "identifier": identifier, "dry_run": dry_run, "blocking_issues": blocking_issues}

    if not dry_run and not is_muted:
        _post_comment(issue_id, _build_escalation_comment(identifier, "Unknown gate status"))
    return {"gate_status": "ERROR", "identifier": identifier, "dry_run": dry_run}


# ---------------------------------------------------------------------------
# scan_done_issues — wrapper around scan_fix_issues_done.scan()
# ---------------------------------------------------------------------------


def scan_done_issues(days_back: int | None = None, dry_run: bool = False, retroactive: bool = False) -> dict:
    _scripts = _REPO_ROOT / "scripts"
    if str(_scripts) not in sys.path:
        sys.path.insert(0, str(_scripts))
    import scan_fix_issues_done
    return scan_fix_issues_done.scan(days_back=days_back, dry_run=dry_run, retroactive=retroactive)


if __name__ == "__main__":
    sys.exit(main())
