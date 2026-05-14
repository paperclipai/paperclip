#!/usr/bin/env python3
"""Health-check monitor for the Impact Gate scan-done pipeline.

Verifies the data quality snapshot produced by ``impact-gate-scan-done`` is
fresh, coverage meets threshold, and error/fail rates don't exceed limits.

Usage:
    python scripts/impact_gate_scan_health.py
    python scripts/impact_gate_scan_health.py --json-summary
    python scripts/impact_gate_scan_health.py --stale-threshold-min 15
    python scripts/impact_gate_scan_health.py --dry-run

Exit codes:
    0 — healthy
    1 — unhealthy (stale snapshot, low coverage, or high error rate)
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

logger = logging.getLogger("impact_gate_scan_health")

REPO_ROOT = Path(__file__).resolve().parent.parent
SNAPSHOT_GLOB = "data_quality_impact_gate_*.json"

DEFAULT_STALE_THRESHOLD_MIN = 15
DEFAULT_COVERAGE_THRESHOLD_PCT = 90.0
DEFAULT_ERROR_RATE_THRESHOLD_PCT = 35.0
DEFAULT_FAIL_RATE_THRESHOLD_PCT = 35.0


def _find_latest_snapshot():
    snapshots = sorted(REPO_ROOT.glob(SNAPSHOT_GLOB))
    if not snapshots:
        return None
    return snapshots[-1]


def _parse_iso_datetime(raw):
    if not raw:
        return None
    try:
        raw = raw.replace("Z", "+00:00")
    except Exception:
        pass
    try:
        return datetime.fromisoformat(raw)
    except ValueError:
        return None


def check_health(
    stale_threshold_min=DEFAULT_STALE_THRESHOLD_MIN,
    coverage_threshold_pct=DEFAULT_COVERAGE_THRESHOLD_PCT,
    error_rate_threshold_pct=DEFAULT_ERROR_RATE_THRESHOLD_PCT,
    fail_rate_threshold_pct=DEFAULT_FAIL_RATE_THRESHOLD_PCT,
):
    now = datetime.now(timezone.utc)

    snapshot_path = _find_latest_snapshot()
    thresholds = {
        "stale_min": stale_threshold_min,
        "coverage_pct": coverage_threshold_pct,
        "error_rate_pct": error_rate_threshold_pct,
        "fail_rate_pct": fail_rate_threshold_pct,
    }
    base = {
        "checked_at": now.isoformat(),
        "thresholds": thresholds,
    }

    if snapshot_path is None:
        return {
            **base,
            "status": "UNHEALTHY",
            "healthy": False,
            "reason": "No data quality snapshot found",
            "snapshot_path": None,
            "snapshot_age_minutes": None,
            "coverage_pct": None,
            "total_done_fix_issues": None,
            "error_count": None,
            "error_rate_pct": None,
            "fail_count": None,
            "fail_rate_pct": None,
            "ungated_count": None,
        }

    try:
        data = json.loads(snapshot_path.read_text())
    except json.JSONDecodeError as exc:
        return {
            **base,
            "status": "UNHEALTHY",
            "healthy": False,
            "reason": f"Failed to parse snapshot: {exc}",
            "snapshot_path": str(snapshot_path),
            "snapshot_age_minutes": None,
            "coverage_pct": None,
            "total_done_fix_issues": None,
            "error_count": None,
            "error_rate_pct": None,
            "fail_count": None,
            "fail_rate_pct": None,
            "ungated_count": None,
        }

    scan = data.get("impact_gate_scan", {})
    ts_raw = data.get("timestamp")
    snapshot_ts = _parse_iso_datetime(ts_raw)
    snapshot_age_min = (
        (now - snapshot_ts).total_seconds() / 60.0
        if snapshot_ts
        else None
    )

    total = scan.get("total_done_fix_issues", 0)
    gated = scan.get("gated", {})
    ungated = scan.get("ungated_count", 0)
    coverage_pct = scan.get("coverage_pct", 0.0)

    error_count = gated.get("error", 0)
    fail_count = gated.get("fail", 0)
    error_rate = round((error_count / total) * 100, 1) if total > 0 else 0.0
    fail_rate = round((fail_count / total) * 100, 1) if total > 0 else 0.0

    issues = []
    healthy = True
    status = "HEALTHY"

    if snapshot_age_min is None or snapshot_age_min > stale_threshold_min:
        healthy = False
        status = "UNHEALTHY"
        issues.append(
            f"Snapshot stale: {snapshot_age_min:.0f}min old "
            f"(threshold: {stale_threshold_min}min)"
            if snapshot_age_min is not None
            else "Snapshot timestamp missing"
        )

    if coverage_pct < coverage_threshold_pct:
        healthy = False
        status = "UNHEALTHY"
        issues.append(
            f"Coverage {coverage_pct}% below threshold {coverage_threshold_pct}%"
        )

    if error_rate > error_rate_threshold_pct:
        healthy = False
        status = "UNHEALTHY"
        issues.append(
            f"Error rate {error_rate}% exceeds threshold {error_rate_threshold_pct}%"
        )

    if fail_rate > fail_rate_threshold_pct:
        healthy = False
        status = "UNHEALTHY"
        issues.append(
            f"Fail rate {fail_rate}% exceeds threshold {fail_rate_threshold_pct}%"
        )

    reason = "; ".join(issues) if issues else "Pipeline healthy"

    return {
        **base,
        "status": status,
        "healthy": healthy,
        "reason": reason,
        "snapshot_path": str(snapshot_path),
        "snapshot_age_minutes": round(snapshot_age_min, 1) if snapshot_age_min is not None else None,
        "snapshot_timestamp": ts_raw,
        "coverage_pct": coverage_pct,
        "total_done_fix_issues": total,
        "ungated_count": ungated,
        "error_count": error_count,
        "error_rate_pct": error_rate,
        "fail_count": fail_count,
        "fail_rate_pct": fail_rate,
        "bypassed_count": gated.get("bypassed", 0),
        "skipped_count": gated.get("skipped", 0),
        "pass_count": gated.get("pass", 0),
    }


def main():
    parser = argparse.ArgumentParser(
        description="Health-check monitor for Impact Gate scan-done pipeline",
    )
    parser.add_argument(
        "--json-summary",
        action="store_true",
        help="Output structured JSON summary to stdout",
    )
    parser.add_argument(
        "--stale-threshold-min",
        type=int,
        default=DEFAULT_STALE_THRESHOLD_MIN,
        metavar="N",
    )
    parser.add_argument(
        "--coverage-threshold-pct",
        type=float,
        default=DEFAULT_COVERAGE_THRESHOLD_PCT,
        metavar="PCT",
    )
    parser.add_argument(
        "--error-rate-threshold-pct",
        type=float,
        default=DEFAULT_ERROR_RATE_THRESHOLD_PCT,
        metavar="PCT",
    )
    parser.add_argument(
        "--fail-rate-threshold-pct",
        type=float,
        default=DEFAULT_FAIL_RATE_THRESHOLD_PCT,
        metavar="PCT",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Run health check but suppress alert creation",
    )
    args = parser.parse_args()

    result = check_health(
        stale_threshold_min=args.stale_threshold_min,
        coverage_threshold_pct=args.coverage_threshold_pct,
        error_rate_threshold_pct=args.error_rate_threshold_pct,
        fail_rate_threshold_pct=args.fail_rate_threshold_pct,
    )

    if args.json_summary:
        result["dry_run"] = args.dry_run
        print(json.dumps(result, indent=2))  # noqa: T201
    else:
        status_icon = "OK" if result["healthy"] else "FAIL"
        print(f"Impact Gate Scan-Done Health: {status_icon}")  # noqa: T201
        print(f"  Status:       {result['status']}")  # noqa: T201
        print(f"  Reason:       {result['reason']}")  # noqa: T201
        print(f"  Snapshot:     {result['snapshot_path'] or 'N/A'}")  # noqa: T201
        print(f"  Snapshot age: {result['snapshot_age_minutes']}min")  # noqa: T201
        print(f"  Coverage:     {result['coverage_pct']}%")  # noqa: T201
        print(f"  Total issues: {result['total_done_fix_issues']}")  # noqa: T201
        print(f"  Ungated:      {result['ungated_count']}")  # noqa: T201
        print(f"  Errors:       {result['error_count']} ({result['error_rate_pct']}%)")  # noqa: T201
        print(f"  Fails:        {result['fail_count']} ({result['fail_rate_pct']}%)")  # noqa: T201

    return 0 if result["healthy"] else 1


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    sys.exit(main())
