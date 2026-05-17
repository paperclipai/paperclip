"""Bug-close Touch Index ingestion worker — upserts touch_index_bug_files rows.

Triggered by run_touch_index_bug_worker.py every 15 minutes for all done
non-FDR issues (bug titles and fix-type commits).  Excludes FDR-labelled
issues which are ingested by the FR worker.

For each closed issue:
  - Find git commits that reference the issue identifier.
  - Collect the source files touched by those commits.
  - Fall back to Paperclip issue comments if git returns nothing.
  - Upsert one row per (file_path, bug_issue_id) into touch_index_bug_files,
    setting closed_at from completedAt.

The upsert is idempotent — safe to re-run on the same issues.

Catch-up tracking
-----------------
``catch_up_eligible_bug_issues`` tracks issues that were attempted but
yielded no source files (e.g. commits touching only docs/, .md, .sh, .json).
These *unindexable* identifiers are persisted to a JSON tracker file so they
are not re-processed on every 15-minute cycle.  Delete the tracker file to
force a full re-attempt on the next catch-up run.
"""

from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Sequence

from sqlalchemy import text
from sqlalchemy.engine import Engine

from .comment_extractor import extract_files_from_text, fetch_and_extract
from .git_extractor import get_all_referenced_issue_ids, get_files_for_issue
from .paperclip_client import FDR_LABEL_ID, get_issue_by_id, get_issue_by_identifier

logger = logging.getLogger(__name__)

# Tracker for issues attempted by catch-up that yielded no source files,
# preventing infinite re-processing every 15-minute cycle.
_CATCHUP_UNINDEXABLE_PATH: Path = (
    Path(__file__).parents[2] / "data" / "touch_index_catchup_unindexable.json"
)


def _set_catchup_tracker_path(path: Path) -> None:
    """Override the tracker path (used by tests to isolate from disk state)."""
    global _CATCHUP_UNINDEXABLE_PATH
    _CATCHUP_UNINDEXABLE_PATH = path

_UPSERT_SQL = text("""
    INSERT INTO touch_index_bug_files
        (id, file_path, bug_issue_id, bug_identifier, closed_at, source, updated_at)
    VALUES
        (:id, :file_path, :bug_issue_id, :bug_identifier, :closed_at, :source, :updated_at)
    ON CONFLICT (file_path, bug_issue_id)
    DO UPDATE SET
        bug_identifier = EXCLUDED.bug_identifier,
        closed_at      = COALESCE(EXCLUDED.closed_at, touch_index_bug_files.closed_at),
        source         = EXCLUDED.source,
        updated_at     = EXCLUDED.updated_at
""")


@dataclass
class BugIngestionResult:
    issue_identifier: str
    issue_id: str
    files_indexed: int
    source: str  # "git" | "comments" | "description" | "none"
    skipped_no_commits: bool
    issue_status: str | None = None  # Paperclip status at time of ingestion


def ingest_bug_issue(
    engine: Engine,
    issue_id: str,
    issue_identifier: str,
    completed_at: datetime | None,
    description: str = "",
    *,
    dry_run: bool = False,
    issue_status: str | None = None,
) -> BugIngestionResult:
    """Process a single closed bug issue and upsert its touched files."""
    files = get_files_for_issue(issue_identifier)
    source = "git"

    if not files:
        files = fetch_and_extract(issue_id)
        source = "comments"

    if not files and description:
        files = extract_files_from_text(description)
        source = "description"

    if not files:
        logger.info(
            "Bug %s: no files found in git or comments — skipping", issue_identifier
        )
        return BugIngestionResult(
            issue_id=issue_id,
            issue_identifier=issue_identifier,
            files_indexed=0,
            source="none",
            skipped_no_commits=True,
            issue_status=issue_status,
        )

    rows = [
        {
            "id": str(uuid.uuid4()),
            "file_path": f,
            "bug_issue_id": issue_id,
            "bug_identifier": issue_identifier,
            "closed_at": completed_at,
            "source": source,
            "updated_at": datetime.now(timezone.utc),
        }
        for f in files
    ]

    if dry_run:
        logger.info(
            "Bug %s: DRY RUN — would index %d file(s) via %s",
            issue_identifier,
            len(rows),
            source,
        )
        for r in rows:
            logger.info("  DRY RUN row: file_path=%s", r["file_path"])
    else:
        with engine.begin() as conn:
            conn.execute(_UPSERT_SQL, rows)
        logger.info(
            "Bug %s: indexed %d file(s) via %s", issue_identifier, len(rows), source
        )
    return BugIngestionResult(
        issue_id=issue_id,
        issue_identifier=issue_identifier,
        files_indexed=len(rows),
        source=source,
        skipped_no_commits=False,
        issue_status=issue_status,
    )


def _parse_completed_at(issue: dict) -> datetime | None:
    raw = issue.get("completedAt")
    if raw is None or raw == "":
        return None
    if not isinstance(raw, str):
        logger.warning(
            "Bug issue %s: unexpected completedAt type %s (value=%r)",
            issue.get("identifier"),
            type(raw).__name__,
            raw,
        )
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        logger.warning(
            "Bug issue %s: malformed completedAt %r", issue.get("identifier"), raw
        )
        return None


def process_bug_issue(
    engine: Engine,
    issue_id: str,
    *,
    dry_run: bool = False,
) -> BugIngestionResult | None:
    """Fetch a single issue from Paperclip API and ingest as a bug.

    This is the webhook/event-driven entry point.  Returns None if the
    issue is not found or is FDR-labelled (handled by the FR worker).
    Non-done issues are accepted — the caller is expected to transition
    the issue to ``done`` after successful ingestion.
    """
    issue = get_issue_by_id(issue_id)
    if issue is None:
        logger.info("Bug issue %s not found — skipping", issue_id)
        return None
    if FDR_LABEL_ID in (issue.get("labelIds") or []):
        logger.info("Bug issue %s is FDR-labelled — skipping", issue_id)
        return None
    return ingest_bug_issue(
        engine,
        issue_id=issue["id"],
        issue_identifier=issue["identifier"],
        completed_at=_parse_completed_at(issue),
        description=issue.get("description", "") or "",
        dry_run=dry_run,
        issue_status=issue.get("status"),
    )


def run_bug_worker(
    engine: Engine,
    issues: Sequence[dict],
    *,
    dry_run: bool = False,
) -> list[BugIngestionResult]:
    """Ingest a list of closed bug issue dicts (from paperclip_client.get_closed_non_fdr_issues).

    When the list endpoint does not return the ``description`` field, the
    description fallback in ``ingest_bug_issue`` would never fire.  This
    function detects that case and fetches the full issue by ID to obtain
    the description, then retries.
    """
    results = []
    for issue in issues:
        try:
            result = ingest_bug_issue(
                engine,
                issue_id=issue["id"],
                issue_identifier=issue["identifier"],
                completed_at=_parse_completed_at(issue),
                description=issue.get("description", "") or "",
                dry_run=dry_run,
                issue_status=issue.get("status"),
            )
            if result.source == "none" and not issue.get("description"):
                full = get_issue_by_id(issue["id"])
                if full and full.get("description"):
                    result = ingest_bug_issue(
                        engine,
                        issue_id=full["id"],
                        issue_identifier=full["identifier"],
                        completed_at=_parse_completed_at(full),
                        description=full.get("description", "") or "",
                        dry_run=dry_run,
                        issue_status=full.get("status"),
                    )
            results.append(result)
        except Exception:
            logger.exception("Bug worker error for %s", issue.get("identifier"))
    return results


def main() -> None:
    """CLI entry point: dispatch to __main__._run_bug_cli() (unified CLI)."""
    from .__main__ import _run_bug_cli

    _run_bug_cli()


if __name__ == "__main__":
    main()


def _load_unindexable_ids() -> set[str]:
    """Load identifiers previously marked as unindexable from the tracker file."""
    if not _CATCHUP_UNINDEXABLE_PATH.exists():
        return set()
    try:
        raw = _CATCHUP_UNINDEXABLE_PATH.read_text().strip()
        if not raw:
            return set()
        return set(json.loads(raw))
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("Could not load catch-up unindexable tracker: %s", exc)
        return set()


def _save_unindexable_ids(ids: set[str]) -> None:
    """Persist unindexable identifiers to the tracker file."""
    try:
        _CATCHUP_UNINDEXABLE_PATH.parent.mkdir(parents=True, exist_ok=True)
        _CATCHUP_UNINDEXABLE_PATH.write_text(json.dumps(sorted(ids), indent=2) + "\n")
    except OSError as exc:
        logger.warning("Could not save catch-up unindexable tracker: %s", exc)


def backfill_null_closed_at(
    engine: Engine,
    *,
    dry_run: bool = False,
) -> int:
    """Backfill null ``closed_at`` values in touch_index_bug_files.

    Queries for rows where ``closed_at`` is NULL, fetches the corresponding
    issue from the Paperclip API, and updates ``closed_at`` if the issue
    now has a ``completedAt`` timestamp.

    Returns the number of rows updated.
    """
    with engine.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT DISTINCT bug_issue_id, bug_identifier "
                "FROM touch_index_bug_files WHERE closed_at IS NULL"
            )
        ).fetchall()

    if not rows:
        return 0

    updated = 0
    for bug_issue_id, bug_identifier in rows:
        try:
            issue = get_issue_by_id(bug_issue_id)
            if issue is None:
                logger.info(
                    "Backfill: issue %s (%s) not found in Paperclip — skipping",
                    bug_issue_id,
                    bug_identifier,
                )
                continue
            completed_at = _parse_completed_at(issue)
            if completed_at is None:
                logger.info(
                    "Backfill: issue %s (%s) has no completedAt — skipping",
                    bug_issue_id,
                    bug_identifier,
                )
                continue
            if dry_run:
                logger.info(
                    "Backfill DRY RUN: would set closed_at=%s for %s (%s)",
                    completed_at.isoformat(),
                    bug_issue_id,
                    bug_identifier,
                )
            else:
                with engine.begin() as conn:
                    conn.execute(
                        text(
                            "UPDATE touch_index_bug_files "
                            "SET closed_at = :closed_at, updated_at = :updated_at "
                            "WHERE bug_issue_id = :bug_issue_id AND closed_at IS NULL"
                        ),
                        {
                            "closed_at": completed_at,
                            "bug_issue_id": bug_issue_id,
                            "updated_at": datetime.now(timezone.utc),
                        },
                    )
                logger.info(
                    "Backfill: set closed_at=%s for %s (%s)",
                    completed_at.isoformat(),
                    bug_issue_id,
                    bug_identifier,
                )
            updated += 1
        except Exception:
            logger.exception(
                "Backfill error for issue %s (%s)", bug_issue_id, bug_identifier
            )

    if updated:
        logger.info("Backfill complete: %d row(s) updated", updated)
    return updated


def catch_up_eligible_bug_issues(
    engine: Engine,
    *,
    dry_run: bool = False,
) -> list[BugIngestionResult]:
    """Scan all git history for eligible done non-FDR issues not yet indexed.

    New commits can reference old issues, making them eligible for indexing
    even though they were completed outside the worker's lookback window.
    This catch-up ensures those issues are indexed, keeping eligible coverage
    consistently above the quality threshold without requiring a full backfill.

    Issues that were previously attempted but yielded no source files (e.g.
    commits touching only docs/, .md, .sh, .json) are tracked and skipped on
    subsequent runs to avoid infinite re-processing every 15-minute cycle.
    """
    all_git_ids = get_all_referenced_issue_ids()
    if not all_git_ids:
        return []

    with engine.connect() as conn:
        indexed_rows = conn.execute(
            text("SELECT DISTINCT bug_identifier FROM touch_index_bug_files")
        ).fetchall()
    indexed_in_db: set[str] = {str(r[0]) for r in indexed_rows}

    unindexable = _load_unindexable_ids()
    newly_unindexable: set[str] = set()

    results: list[BugIngestionResult] = []
    for identifier in sorted(all_git_ids):
        if identifier in indexed_in_db:
            logger.debug("Catch-up: %s already indexed -- skipping", identifier)
            continue
        if identifier in unindexable:
            logger.debug(
                "Catch-up: %s previously unindexable -- skipping", identifier
            )
            continue
        try:
            issue = get_issue_by_identifier(identifier)
            if issue is None:
                logger.debug(
                    "Catch-up: %s not found in Paperclip -- skipping", identifier
                )
                continue
            if issue.get("status") != "done":
                logger.debug(
                    "Catch-up: %s has status %r -- skipping (only done issues eligible)",
                    identifier,
                    issue.get("status"),
                )
                continue
            if FDR_LABEL_ID in (issue.get("labelIds") or []):
                logger.debug("Catch-up: %s is FDR-labelled -- skipping", identifier)
                continue
        except Exception:
            logger.exception(
                "Catch-up: error fetching issue %s -- skipping", identifier
            )
            continue
        try:
            result = ingest_bug_issue(
                engine,
                issue_id=issue["id"],
                issue_identifier=identifier,
                completed_at=_parse_completed_at(issue),
                description=issue.get("description", "") or "",
                dry_run=dry_run,
                issue_status=issue.get("status"),
            )
            if result.source == "none" and not issue.get("description"):
                full = get_issue_by_id(issue["id"])
                if full and full.get("description"):
                    result = ingest_bug_issue(
                        engine,
                        issue_id=full["id"],
                        issue_identifier=identifier,
                        completed_at=_parse_completed_at(full),
                        description=full.get("description", "") or "",
                        dry_run=dry_run,
                        issue_status=full.get("status"),
                    )
            if result.source == "none":
                newly_unindexable.add(identifier)
                logger.info(
                    "Catch-up: %s yielded no source files -- "
                    "recording as unindexable to skip future cycles",
                    identifier,
                )
            results.append(result)
        except Exception:
            logger.exception("Catch-up ingestion error for %s", identifier)

    if newly_unindexable:
        all_unindexable = unindexable | newly_unindexable
        _save_unindexable_ids(all_unindexable)
        logger.info(
            "Catch-up: recorded %d newly unindexable issue(s) "
            "(%d total tracked)",
            len(newly_unindexable),
            len(all_unindexable),
        )

    if results:
        logger.info(
            "Catch-up complete: %d eligible issues processed, %d files indexed, %d skipped",
            len(results),
            sum(r.files_indexed for r in results),
            sum(1 for r in results if r.skipped_no_commits),
        )
    return results