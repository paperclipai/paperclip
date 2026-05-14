"""One-time backfill: fix source column and remove orphans for touch_index_bug_files.

Background
----------
The bug-close ingestion worker was deployed before the ``source`` column tracking
was added (commits 90d097fc, 58c5dc66, 0a6674bd, bdfcd0e4 from 2026-05-12).
Rows inserted before those commits have ``source='unknown'`` (the column default)
and need their source determined retroactively.

This script:
  1. Finds all rows with ``source='unknown'`` in touch_index_bug_files.
  2. For each unique ``bug_issue_id``, determines the correct source:
     - git        (priority 1 -- commit references issue identifier)
     - comments   (priority 2 -- issue comment text mentions file paths)
     - none       (neither source found)
  3. Updates the ``source`` column for all rows of that issue.
  4. Deletes rows whose ``bug_issue_id`` no longer exists in Paperclip (orphans).

Usage:
    python scripts/backfill_touch_index_source.py [--dry-run]
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")

from sqlalchemy import text
from touch_index.db import get_engine, health_check
from touch_index.comment_extractor import fetch_and_extract
from touch_index.git_extractor import get_files_for_issue
from touch_index.paperclip_client import get_all_issue_ids

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger("touch_index.backfill_source")


def _resolve_source(bug_issue_id: str, bug_identifier: str) -> str:
    """Determine the best source for a bug issue.

    Priority: git > comments > none.
    """
    files = get_files_for_issue(bug_identifier)
    if files:
        return "git"

    files = fetch_and_extract(bug_issue_id)
    if files:
        return "comments"

    return "none"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Backfill source column and remove orphans in touch_index_bug_files",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Log actions without modifying the database",
    )
    args = parser.parse_args()

    engine = get_engine()
    if not health_check(engine):
        logger.error("DB health check failed -- aborting")
        sys.exit(1)

    # -- Step 1: Backfill source for unknown-source rows -------------------
    with engine.connect() as conn:
        unknown_rows = conn.execute(
            text("""
                SELECT DISTINCT bug_issue_id, bug_identifier
                FROM touch_index_bug_files
                WHERE source = 'unknown'
            """)
        ).fetchall()

    logger.info("Found %d distinct bug issue(s) with source=unknown", len(unknown_rows))

    updated = 0
    errors = 0
    for bug_issue_id, bug_identifier in unknown_rows:
        try:
            source = _resolve_source(bug_issue_id, bug_identifier)
            if args.dry_run:
                logger.info(
                    "DRY RUN: would set source=%s for bug_issue_id=%s (%s)",
                    source,
                    bug_issue_id,
                    bug_identifier,
                )
            else:
                with engine.begin() as conn:
                    result = conn.execute(
                        text(
                            "UPDATE touch_index_bug_files SET source = :source "
                            "WHERE bug_issue_id = :bug_issue_id AND source = 'unknown'"
                        ),
                        {"source": source, "bug_issue_id": bug_issue_id},
                    )
                logger.info(
                    "Set source=%s for bug_issue_id=%s (%s) -- %d rows",
                    source,
                    bug_issue_id,
                    bug_identifier,
                    result.rowcount,
                )
            updated += 1
        except Exception:
            logger.exception("Error resolving source for %s (%s)", bug_issue_id, bug_identifier)
            errors += 1

    logger.info("Source backfill complete -- %d processed, %d errors", updated, errors)

    # -- Step 2: Delete orphan rows ----------------------------------------
    with engine.connect() as conn:
        db_ids_rows = conn.execute(
            text("SELECT DISTINCT bug_issue_id FROM touch_index_bug_files")
        ).fetchall()

    if not db_ids_rows:
        logger.info("No rows in touch_index_bug_files -- skipping orphan cleanup")
    else:
        try:
            paperclip_ids = get_all_issue_ids()
        except Exception:
            logger.exception("Failed to fetch Paperclip issue IDs -- skipping orphan cleanup")
            paperclip_ids = set()

        db_ids = {str(row[0]) for row in db_ids_rows}
        orphan_ids = sorted(db_ids - paperclip_ids)

        if orphan_ids:
            logger.info("Found %d orphan bug_issue_id(s) to delete", len(orphan_ids))
            for oid in orphan_ids:
                if args.dry_run:
                    logger.info("DRY RUN: would delete rows for orphan bug_issue_id=%s", oid)
                else:
                    with engine.begin() as conn:
                        result = conn.execute(
                            text("DELETE FROM touch_index_bug_files WHERE bug_issue_id = :oid"),
                            {"oid": oid},
                        )
                    logger.info("Deleted %d row(s) for orphan bug_issue_id=%s", result.rowcount, oid)
        else:
            logger.info("No orphan bug_issue_ids found")

    if errors:
        logger.warning("Completed with %d error(s) -- check logs above", errors)


if __name__ == "__main__":
    main()
