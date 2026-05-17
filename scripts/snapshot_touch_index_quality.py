"""Touch Index data quality snapshot — automated monitoring.

Generates a standardised JSON report of FR and Bug data quality metrics
and persists it to ``data_quality_{YYYYMMDD}.json`` for dashboarding and
historical trend analysis.

Usage:
    python scripts/snapshot_touch_index_quality.py                     # write snapshot, exit 0/1
    python scripts/snapshot_touch_index_quality.py --stdout            # emit JSON to stdout only
    python scripts/snapshot_touch_index_quality.py --stale-hours 336   # custom FR stale threshold
    python scripts/snapshot_touch_index_quality.py --stale-days 60    # custom bug stale threshold
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")

from touch_index.db import get_engine, health_check
from touch_index.quality import run_quality_checks, run_bug_quality_checks

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger("touch_index.snapshot")


def _build_fr_report(fr_report) -> dict:
    if fr_report is None or fr_report.coverage is None:
        return {"pass": False, "error": "FR quality checks did not complete"}
    d: dict = {
        "pass": fr_report.passed,
        "coverage_pct": fr_report.coverage.coverage_pct,
        "indexed": fr_report.coverage.indexed_fdr_issues,
        "total": fr_report.coverage.total_fdr_issues,
        "missing_issue_identifiers": fr_report.coverage.missing_issue_identifiers,
    }
    if fr_report.freshness is not None:
        d["total_rows"] = fr_report.freshness.total_rows
        d["stale_rows"] = fr_report.freshness.stale_rows
        d["max_age_hours"] = fr_report.freshness.max_age_hours
    if fr_report.consistency is not None:
        d["null_owner_rows"] = fr_report.consistency.null_owner_rows
        d["null_updated_at_rows"] = fr_report.consistency.null_updated_at_rows
        d["unknown_source_rows"] = fr_report.consistency.unknown_source_rows
        d["duplicate_pairs"] = fr_report.consistency.duplicate_pairs
        d["orphan_count"] = len(fr_report.consistency.orphan_fr_issue_ids)
        d["source_distribution"] = fr_report.consistency.source_distribution or {}
    return d


def _build_bug_report(bug_report) -> dict:
    if bug_report is None or bug_report.coverage is None:
        return {"pass": False, "error": "Bug quality checks did not complete"}
    d: dict = {
        "pass": bug_report.passed,
        "coverage_pct": bug_report.coverage.coverage_pct,
        "indexed": bug_report.coverage.indexed_bug_issues,
        "total": bug_report.coverage.total_bug_issues,
        "coverage_eligible_pct": bug_report.coverage.eligible_coverage_pct,
        "eligible_total": bug_report.coverage.eligible_bug_issues,
        "missing_eligible_count": len(bug_report.coverage.missing_eligible_identifiers),
        "missing_eligible_identifiers": bug_report.coverage.missing_eligible_identifiers,
        "missing_total_count": len(bug_report.coverage.missing_issue_identifiers),
    }
    if bug_report.freshness is not None:
        d["total_rows"] = bug_report.freshness.total_rows
        d["stale_rows"] = bug_report.freshness.stale_rows
        d["max_age_hours"] = bug_report.freshness.max_age_hours
    if bug_report.consistency is not None:
        d["null_closed_at_rows"] = bug_report.consistency.null_closed_at_rows
        d["null_updated_at_rows"] = bug_report.consistency.null_updated_at_rows
        d["unknown_source_rows"] = bug_report.consistency.unknown_source_rows
        d["duplicate_pairs"] = bug_report.consistency.duplicate_pairs
        d["orphan_count"] = len(bug_report.consistency.orphan_bug_issue_ids)
        d["source_distribution"] = bug_report.consistency.source_distribution or {}
    return d


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Touch Index data quality snapshot",
    )
    parser.add_argument(
        "--stdout",
        action="store_true",
        help="Emit JSON to stdout instead of writing to file",
    )
    parser.add_argument(
        "--stale-hours",
        type=int,
        default=168,
        help="FR stale threshold in hours (default: 168 = 7d)",
    )
    parser.add_argument(
        "--stale-days",
        type=int,
        default=30,
        help="Bug stale threshold in days (default: 30)",
    )
    args = parser.parse_args()

    engine = get_engine()
    if not health_check(engine):
        logger.error("DB health check failed — aborting")
        sys.exit(1)

    fr_report = run_quality_checks(engine, stale_threshold_hours=args.stale_hours)
    bug_report = run_bug_quality_checks(engine, stale_threshold_days=args.stale_days)

    snapshot = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "touch_index_fr": _build_fr_report(fr_report),
        "touch_index_bug": _build_bug_report(bug_report),
    }

    if args.stdout:
        sys.stdout.write(json.dumps(snapshot, indent=2, default=str) + "\n")
    else:
        date_str = datetime.now(timezone.utc).strftime("%Y%m%d")
        output_path = Path(__file__).parent.parent / f"data_quality_{date_str}.json"
        output_path.write_text(
            json.dumps(snapshot, indent=2, default=str) + "\n"
        )
        logger.info("Snapshot written to %s", output_path)

    overall_pass = (
        snapshot["touch_index_fr"].get("pass", False)
        and snapshot["touch_index_bug"].get("pass", False)
    )
    sys.exit(0 if overall_pass else 1)


if __name__ == "__main__":
    main()
