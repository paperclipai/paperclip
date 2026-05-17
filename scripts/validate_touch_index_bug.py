"""Touch Index Bug data quality validation — run after ingestion.

Delegates to ``touch_index.quality.run_bug_quality_checks`` for all checks:
coverage, freshness, and consistency.

Usage:
    python scripts/validate_touch_index_bug.py [--stale-days 30]
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from sqlalchemy.engine import Engine

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")

from touch_index.db import get_engine, health_check
from touch_index.quality import run_bug_quality_checks

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("touch_index.validate_bug")


def _run_checks(stale_days: int, engine: Engine | None = None) -> int:
    """Run all validation checks via quality.run_bug_quality_checks.

    Returns number of failures (0 = clean).

    Args:
        stale_days: Alert threshold for stale rows in days.
        engine: Optional pre-configured SQLAlchemy engine. If not provided,
                a new engine is created from environment variables.
    """
    if engine is None:
        engine = get_engine()
        if not health_check(engine):
            logger.error("DB health check failed — aborting")
            sys.exit(1)

    report = run_bug_quality_checks(engine, stale_threshold_days=stale_days)

    if not report.passed:
        logger.error("VALIDATION COMPLETE: checks FAILED — investigate")
        return 1

    logger.info("VALIDATION COMPLETE: all checks PASSED")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Touch Index Bug data quality validation"
    )
    parser.add_argument(
        "--stale-days",
        type=int,
        default=30,
        help="Alert if updated_at is older than this many days (default: 30)",
    )
    args = parser.parse_args()

    logger.info(
        "Touch Index Bug validation — stale threshold: %d days", args.stale_days
    )
    failures = _run_checks(args.stale_days)
    if failures:
        sys.exit(1)


if __name__ == "__main__":
    main()
