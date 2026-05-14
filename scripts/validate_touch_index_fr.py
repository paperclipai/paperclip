"""Touch Index FR data quality validation — run after ingestion.

Delegates to ``touch_index.quality.run_quality_checks`` for all checks:
coverage, freshness, and consistency.

Usage:
    python scripts/validate_touch_index_fr.py [--stale-hours 168]
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
from touch_index.quality import run_quality_checks

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("touch_index.validate_fr")


def _run_checks(stale_hours: int, engine: Engine | None = None) -> int:
    """Run all validation checks via quality.run_quality_checks.

    Returns number of failures (0 = clean).

    Args:
        stale_hours: Alert threshold for stale rows in hours.
        engine: Optional pre-configured SQLAlchemy engine.
    """
    if engine is None:
        engine = get_engine()
        if not health_check(engine):
            logger.error("DB health check failed — aborting")
            sys.exit(1)

    report = run_quality_checks(engine, stale_threshold_hours=stale_hours)

    if not report.passed:
        logger.error("VALIDATION COMPLETE: checks FAILED — investigate")
        return 1

    logger.info("VALIDATION COMPLETE: all checks PASSED")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Touch Index FR data quality validation"
    )
    parser.add_argument(
        "--stale-hours",
        type=int,
        default=168,
        help="Alert if updated_at is older than this many hours (default: 168=7d)",
    )
    args = parser.parse_args()

    logger.info(
        "Touch Index FR validation — stale threshold: %d hours", args.stale_hours
    )
    failures = _run_checks(args.stale_hours)
    if failures:
        sys.exit(1)


if __name__ == "__main__":
    main()
