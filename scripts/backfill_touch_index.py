"""90-day Touch Index backfill script — one-shot population.

Strategy
--------
FRs (FDR-labelled issues):
  Extract file paths from issue comments (done-comments by implementing agents
  contain the files they changed).  Fall back to git commits referencing the
  issue identifier, then to the description text.

Bugs (fix-type issues):
  Scan git log for all commits whose message references a BTCAAAAA-NNN issue
  ID.  Look up each issue in Paperclip; if it is done (closed) and NOT
  FDR-labelled, treat it as a bug fix and upsert to touch_index_bug_files.
  This captures issues closed under titles like "Fix BacktestDataProvider
  cache key" that don't carry a "Bug:" prefix.

After the window-based pass, a catch-up step scans ALL git history
(via ``get_all_referenced_issue_ids``) and indexes any eligible done non-FDR
issues not yet in the DB. This ensures the backfill catches body-referenced
issue IDs from old commits that the window-based scan misses, keeping bug
coverage in sync with ``compute_bug_coverage()`` which uses the same
all-history scan.

Coverage denominator:
  FRs  — all FDR-labelled issues updated in the window.
  Bugs — all done non-FDR issues that appear in git commit messages (window)
         plus any eligible issues not yet indexed (catch-up).

Usage:
    python scripts/backfill_touch_index.py [--days N]
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from dotenv import load_dotenv
from sqlalchemy import text

load_dotenv(Path(__file__).parent.parent / ".env")

from touch_index.db import get_engine, health_check
from touch_index.paperclip_client import (
    FDR_LABEL_ID,
    get_fdr_issues,
    get_issue_by_identifier,
)
from touch_index.fr_worker import run_fr_worker, FRIngestionResult
from touch_index.bug_worker import (
    run_bug_worker,
    BugIngestionResult,
    ingest_bug_issue,
    _parse_completed_at,
)
from touch_index.git_extractor import (
    get_all_referenced_issue_ids,
    get_files_for_issue,
    _REPO_ROOT,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("touch_index.backfill")

_RE_ISSUE_ID = re.compile(r"BTCAAAAA-\d+")


def _report(msg: str = "") -> None:
    """Print a line to stdout (report output, not logging)."""
    print(msg)  # noqa: T201 - intentional CLI report output


def _git_commits_in_window(days: int) -> list[tuple[str, str, datetime]]:
    """Return (sha, body, commit_dt) for commits in the last `days` days. Uses %B (full body) to catch issue IDs in commit bodies."""
    since = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")
    out = subprocess.run(
        [
            "git",
            "-C",
            str(_REPO_ROOT),
            "log",
            "--all",
            f"--since={since}",
            "--format=%H\x1f%B\x1f%aI",
        ],
        capture_output=True,
        text=True,
        timeout=60,
    ).stdout.strip()

    results = []
    for line in out.splitlines():
        parts = line.split("\x1f", 2)
        if len(parts) == 3:
            sha, body, ts_str = parts
            try:
                dt = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
            except ValueError:
                continue
            results.append((sha.strip(), body.strip(), dt))
    return results


def _extract_issue_ids(text: str) -> list[str]:
    return list(set(_RE_ISSUE_ID.findall(text)))


def main() -> None:
    parser = argparse.ArgumentParser(description="Touch Index 90-day backfill")
    parser.add_argument("--days", type=int, default=90)
    args = parser.parse_args()

    engine = get_engine()
    if not health_check(engine):
        logger.error("DB health check failed — aborting")
        sys.exit(1)

    cutoff = datetime.now(timezone.utc) - timedelta(days=args.days)
    logger.info("Backfill window: last %d days (since %s)", args.days, cutoff.date())

    # ── Step 1: FR ingestion (FDR-labelled issues) ─────────────────────────
    logger.info("Fetching FDR-labelled issues for backfill …")
    all_fdr_issues = get_fdr_issues(updated_after=None)
    fdr_issues = []
    for i in all_fdr_issues:
        raw_ts = i.get("updatedAt")
        if not raw_ts:
            fdr_issues.append(i)
            continue
        try:
            ts = datetime.fromisoformat(raw_ts.replace("Z", "+00:00"))
        except ValueError:
            logger.warning(
                "FDR issue %s has malformed updatedAt %r — including anyway",
                i.get("identifier", "unknown"),
                raw_ts,
            )
            fdr_issues.append(i)
            continue
        if ts >= cutoff:
            fdr_issues.append(i)
    logger.info(
        "FDR issues in window: %d / total: %d", len(fdr_issues), len(all_fdr_issues)
    )

    fr_results: list[FRIngestionResult] = run_fr_worker(engine, fdr_issues)
    fr_indexed = sum(1 for r in fr_results if r.files_indexed > 0)
    fr_files_total = sum(r.files_indexed for r in fr_results)
    fr_skipped = sum(1 for r in fr_results if r.files_indexed == 0)

    # ── Step 2: Bug ingestion (git-first, all commit-referenced done issues) ─
    logger.info("Scanning git commits in window for BTCAAAAA-NNN references …")
    commits = _git_commits_in_window(args.days)
    logger.info("Found %d commits in window", len(commits))

    # Collect unique issue IDs from commit full bodies (subject + body text)
    issue_ids_in_commits: set[str] = set()
    for _, body, _ in commits:
        issue_ids_in_commits.update(_extract_issue_ids(body))

    logger.info("Unique issue IDs referenced in commits: %d", len(issue_ids_in_commits))

    fdr_identifiers = {i["identifier"] for i in all_fdr_issues}

    bug_results: list[BugIngestionResult] = []
    bug_total_eligible = 0

    for identifier in sorted(issue_ids_in_commits):
        # Skip issues already handled as FDRs
        if identifier in fdr_identifiers:
            continue

        issue = get_issue_by_identifier(identifier)
        if issue is None:
            logger.debug("Issue %s not found in Paperclip — skipping", identifier)
            continue
        if issue["status"] != "done":
            logger.debug(
                "Issue %s is %s (not done) — skipping", identifier, issue["status"]
            )
            continue
        # Skip FDR-labelled issues (handled above)
        if FDR_LABEL_ID in (issue.get("labelIds") or []):
            continue

        bug_total_eligible += 1
        completed_at = _parse_completed_at(issue)

        try:
            result = ingest_bug_issue(
                engine,
                issue_id=issue["id"],
                issue_identifier=identifier,
                completed_at=completed_at,
            )
            bug_results.append(result)
        except Exception:
            logger.exception("Bug ingestion error for %s", identifier)

    # ── Step 3: Catch-up on eligible issues not yet indexed ────────────────
    # The quality check (compute_bug_coverage) uses get_all_referenced_issue_ids()
    # which scans ALL git history. Issues referenced in old commit bodies are
    # invisible to the window-based scan. Catch them here by scanning all git
    # history and processing any eligible done non-FDR issues not yet indexed.
    logger.info("Scanning all git history for eligible issues not yet indexed …")
    all_git_ids = get_all_referenced_issue_ids()
    logger.info("Found %d unique issue IDs in all git history", len(all_git_ids))

    # Determine what's already in the DB index
    with engine.connect() as conn:
        indexed_rows = conn.execute(
            text("SELECT DISTINCT bug_identifier FROM touch_index_bug_files")
        ).fetchall()
    indexed_in_db: set[str] = {r[0] for r in indexed_rows}
    logger.info("Already in DB index: %d bug identifiers", len(indexed_in_db))

    catchup_eligible = 0
    catchup_results: list[BugIngestionResult] = []
    for identifier in sorted(all_git_ids):
        if identifier in indexed_in_db:
            continue
        if identifier in fdr_identifiers:
            continue

        issue = get_issue_by_identifier(identifier)
        if issue is None:
            logger.debug("Catch-up: issue %s not found in Paperclip", identifier)
            continue
        if issue["status"] != "done":
            logger.debug(
                "Catch-up: issue %s is %s (not done)", identifier, issue["status"]
            )
            continue
        if FDR_LABEL_ID in (issue.get("labelIds") or []):
            continue

        catchup_eligible += 1
        try:
            result = ingest_bug_issue(
                engine,
                issue_id=issue["id"],
                issue_identifier=identifier,
                completed_at=_parse_completed_at(issue),
            )
            catchup_results.append(result)
        except Exception:
            logger.exception("Catch-up ingestion error for %s", identifier)

    logger.info(
        "Catch-up complete: %d eligible, %d indexed, %d skipped",
        catchup_eligible,
        sum(1 for r in catchup_results if r.files_indexed > 0),
        sum(1 for r in catchup_results if r.files_indexed == 0),
    )

    # Merge catch-up results into totals
    bug_results.extend(catchup_results)
    bug_total_eligible += catchup_eligible

    bug_indexed = sum(1 for r in bug_results if r.files_indexed > 0)
    bug_files_total = sum(r.files_indexed for r in bug_results)
    bug_skipped = sum(1 for r in bug_results if r.files_indexed == 0)

    # ── Coverage stats ─────────────────────────────────────────────────────
    fr_coverage = (fr_indexed / len(fdr_issues) * 100) if fdr_issues else 0.0
    bug_coverage = (
        (bug_indexed / bug_total_eligible * 100) if bug_total_eligible else 0.0
    )

    _report("\n" + "=" * 60)
    _report("TOUCH INDEX BACKFILL — COVERAGE REPORT")
    _report("=" * 60)
    _report(f"Window         : last {args.days} days (since {cutoff.date()})")
    _report()
    _report("FRs (FDR-labelled issues):")
    _report(f"  Total FDRs in system              : {len(all_fdr_issues)}")
    _report(f"  FDRs in window                    : {len(fdr_issues)}")
    _report(f"  FDRs indexed (≥1 file)            : {fr_indexed}")
    _report(f"  FDRs with no extractable files    : {fr_skipped}")
    _report(f"  Total file rows upserted          : {fr_files_total}")
    _report(f"  Coverage (indexed / in-window)    : {fr_coverage:.1f}%")
    _report()
    _report("Bugs (done issues referenced by fix commits):")
    _report(f"  Unique issue IDs in git log       : {len(issue_ids_in_commits)}")
    _report(f"  Window eligible done non-FDR      : {bug_total_eligible - catchup_eligible}")
    _report(f"  Catch-up eligible (from all git)  : {catchup_eligible}")
    _report(f"  Total eligible done non-FDR       : {bug_total_eligible}")
    _report(f"  Bugs indexed (≥1 file)            : {bug_indexed}")
    _report(f"  Bugs with no git files found      : {bug_skipped}")
    _report(f"  Total file rows upserted          : {bug_files_total}")
    _report(f"  Coverage (indexed / eligible)     : {bug_coverage:.1f}%")
    _report()

    # Gate check
    gate_fr = fr_coverage >= 80.0 or not fdr_issues
    gate_bug = bug_coverage >= 80.0 or bug_total_eligible == 0
    if gate_fr and gate_bug:
        _report("RESULT: PASS — both coverage targets met (≥80%)")
    else:
        failing = []
        if not gate_fr:
            failing.append(f"FR coverage {fr_coverage:.1f}% < 80%")
        if not gate_bug:
            failing.append(f"Bug coverage {bug_coverage:.1f}% < 80%")
        _report(f"RESULT: BELOW TARGET — {'; '.join(failing)}")
        if not gate_fr:
            _report()
            _report("  FR note: FDR issues are requirements specs, not implementation")
            _report("  issues. Coverage improves when implementing agents post done-")
            _report("  comments naming the files they changed.")

    _report("=" * 60)

    summary = {
        "window_days": args.days,
        "run_at": datetime.now(timezone.utc).isoformat(),
        "fr": {
            "total_in_system": len(all_fdr_issues),
            "in_window": len(fdr_issues),
            "indexed": fr_indexed,
            "no_files": fr_skipped,
            "file_rows": fr_files_total,
            "coverage_pct": round(fr_coverage, 1),
        },
        "bug": {
            "unique_commit_ids": len(issue_ids_in_commits),
            "window_eligible": bug_total_eligible - catchup_eligible,
            "catchup_eligible": catchup_eligible,
            "eligible_done": bug_total_eligible,
            "indexed": bug_indexed,
            "no_files": bug_skipped,
            "file_rows": bug_files_total,
            "coverage_pct": round(bug_coverage, 1),
        },
    }
    _report("\nJSON summary:")
    _report(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
