"""FR ingestion worker — upserts touch_index_fr_files rows.

Triggered on: issue_created or issue_updated where the issue has the FDR label.

File extraction strategy (in priority order):
  1. Done-comments on the FDR issue — the implementing agent typically posts a
     completion comment that names the files they changed (e.g.
     ``src/optimizer_v3/database/strategy_manager.py``).
  2. Git commits that reference the FDR identifier directly.
  3. Issue description text (lower-signal but catches spec-level file refs).
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
from .git_extractor import get_files_for_issue
from .paperclip_client import FDR_LABEL_ID, get_issue_by_id

logger = logging.getLogger(__name__)


# Tracker for FDR issues attempted by catch-up that yielded no source files,
# preventing infinite re-processing every polling cycle.
_CATCHUP_UNINDEXABLE_PATH: Path = (
    Path(__file__).parents[2] / "data" / "touch_index_fr_catchup_unindexable.json"
)


def _set_catchup_tracker_path(path: Path) -> None:
    global _CATCHUP_UNINDEXABLE_PATH
    _CATCHUP_UNINDEXABLE_PATH = path


def _load_unindexable_ids() -> set[str]:
    if not _CATCHUP_UNINDEXABLE_PATH.exists():
        return set()
    try:
        raw = _CATCHUP_UNINDEXABLE_PATH.read_text().strip()
        if not raw:
            return set()
        return set(json.loads(raw))
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("Could not load FR catch-up unindexable tracker: %s", exc)
        return set()


def _save_unindexable_ids(ids: set[str]) -> None:
    try:
        _CATCHUP_UNINDEXABLE_PATH.parent.mkdir(parents=True, exist_ok=True)
        _CATCHUP_UNINDEXABLE_PATH.write_text(json.dumps(sorted(ids), indent=2) + "\n")
    except OSError as exc:
        logger.warning("Could not save FR catch-up unindexable tracker: %s", exc)


_UPSERT_SQL = text("""
    INSERT INTO touch_index_fr_files
        (id, file_path, fr_issue_id, fr_identifier, fr_owner_agent_id, source, updated_at)
    VALUES
        (:id, :file_path, :fr_issue_id, :fr_identifier, :fr_owner_agent_id, :source, :updated_at)
    ON CONFLICT (file_path, fr_issue_id)
    DO UPDATE SET
        fr_identifier     = EXCLUDED.fr_identifier,
        fr_owner_agent_id = EXCLUDED.fr_owner_agent_id,
        source            = EXCLUDED.source,
        updated_at        = EXCLUDED.updated_at
""")


@dataclass
class FRIngestionResult:
    issue_identifier: str
    issue_id: str
    files_indexed: int
    source: str  # "comments" | "git" | "description" | "none"
    skipped_no_commits: bool  # True when no files found from any source
    issue_status: str | None = None  # Paperclip status at time of ingestion


def process_fr_issue(
    engine: Engine,
    issue_id: str,
    *,
    dry_run: bool = False,
) -> FRIngestionResult | None:
    """Fetch a single FDR issue from Paperclip API and ingest it.

    This is the webhook/event-driven entry point.  Returns None if the
    issue is not found or is not an FDR-labelled issue.
    """
    issue = get_issue_by_id(issue_id)
    if issue is None:
        logger.info("FR issue %s not found — skipping", issue_id)
        return None
    if FDR_LABEL_ID not in (issue.get("labelIds") or []):
        logger.info("Issue %s is not FDR-labelled — skipping", issue.get("identifier"))
        return None
    result = ingest_fr_issue(
        engine,
        issue_id=issue["id"],
        issue_identifier=issue["identifier"],
        owner_agent_id=issue.get("assigneeAgentId"),
        description=issue.get("description", "") or "",
        dry_run=dry_run,
    )
    if result is not None:
        result.issue_status = issue.get("status")
    return result


def ingest_fr_issue(
    engine: Engine,
    issue_id: str,
    issue_identifier: str,
    owner_agent_id: str | None,
    description: str = "",
    *,
    dry_run: bool = False,
    issue_status: str | None = None,
) -> FRIngestionResult:
    """Process a single FDR issue — extract files and upsert."""
    # 1. Comments (highest signal — implementing agent's done-comment)
    files = fetch_and_extract(issue_id)
    source = "comments"

    # 2. Git commits that reference the issue identifier
    if not files:
        files = get_files_for_issue(issue_identifier)
        source = "git"

    # 3. Description text
    if not files and description:
        files = extract_files_from_text(description)
        source = "description"

    if not files:
        logger.info(
            "FR %s: no files found in comments, git, or description", issue_identifier
        )
        return FRIngestionResult(
            issue_identifier=issue_identifier,
            issue_id=issue_id,
            files_indexed=0,
            source="none",
            skipped_no_commits=True,
            issue_status=issue_status,
        )

    owner = owner_agent_id or "00000000-0000-0000-0000-000000000000"
    now = datetime.now(timezone.utc)

    rows = [
        {
            "id": str(uuid.uuid4()),
            "file_path": f,
            "fr_issue_id": issue_id,
            "fr_identifier": issue_identifier,
            "fr_owner_agent_id": owner,
            "source": source,
            "updated_at": now,
        }
        for f in files
    ]

    if dry_run:
        logger.info(
            "FR %s: DRY RUN — would index %d file(s) via %s",
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
            "FR %s: indexed %d file(s) via %s", issue_identifier, len(rows), source
        )
    return FRIngestionResult(
        issue_identifier=issue_identifier,
        issue_id=issue_id,
        files_indexed=len(rows),
        source=source,
        skipped_no_commits=False,
        issue_status=issue_status,
    )


def run_fr_worker(
    engine: Engine,
    issues: Sequence[dict],
    *,
    dry_run: bool = False,
) -> list[FRIngestionResult]:
    """Ingest a list of FDR issue dicts (from paperclip_client.get_fdr_issues).

    When the list endpoint does not return the ``description`` field, the
    description fallback in ``ingest_fr_issue`` would never fire.  This
    function detects that case and fetches the full issue by ID to obtain
    the description, then retries.
    """
    results = []
    for issue in issues:
        try:
            result = ingest_fr_issue(
                engine,
                issue_id=issue["id"],
                issue_identifier=issue["identifier"],
                owner_agent_id=issue.get("assigneeAgentId"),
                description=issue.get("description", "") or "",
                dry_run=dry_run,
                issue_status=issue.get("status"),
            )
            if result.source == "none" and not issue.get("description"):
                full = get_issue_by_id(issue["id"])
                if full and full.get("description"):
                    result = ingest_fr_issue(
                        engine,
                        issue_id=full["id"],
                        issue_identifier=full["identifier"],
                        owner_agent_id=full.get("assigneeAgentId"),
                        description=full.get("description", "") or "",
                        dry_run=dry_run,
                        issue_status=full.get("status"),
                    )
            results.append(result)
        except Exception:
            logger.exception("FR worker error for %s", issue.get("identifier"))
    return results


def catch_up_eligible_fr_issues(
    engine: Engine,
    *,
    dry_run: bool = False,
) -> list[FRIngestionResult]:
    """Scan all FDR issues from Paperclip and index those not yet in touch_index_fr_files.

    New FDR issues can be created at any time. The worker's lookback window only
    catches issues updated within the last N minutes. This catch-up ensures all
    FDR issues are eventually indexed, keeping coverage above the quality
    threshold without requiring a separate backfill run.

    Issues that were previously attempted but yielded no source files (e.g.
    commits touching only docs/, .md, .sh, .json) are tracked and skipped on
    subsequent runs to avoid infinite re-processing every cycle.
    """
    from .paperclip_client import get_fdr_issues

    all_fdr = get_fdr_issues()
    if not all_fdr:
        return []

    with engine.connect() as conn:
        indexed_rows = conn.execute(
            text("SELECT DISTINCT fr_identifier FROM touch_index_fr_files")
        ).fetchall()
    indexed_in_db: set[str] = {str(r[0]) for r in indexed_rows}

    unindexable = _load_unindexable_ids()
    newly_unindexable: set[str] = set()

    results: list[FRIngestionResult] = []
    for issue in all_fdr:
        identifier = issue.get("identifier")
        if identifier in indexed_in_db:
            continue
        if identifier in unindexable:
            logger.debug(
                "Catch-up FR: %s previously unindexable -- skipping", identifier
            )
            continue
        try:
            result = ingest_fr_issue(
                engine,
                issue_id=issue["id"],
                issue_identifier=identifier,
                owner_agent_id=issue.get("assigneeAgentId"),
                description=issue.get("description", "") or "",
                dry_run=dry_run,
                issue_status=issue.get("status"),
            )
            if result.source == "none" and not issue.get("description"):
                full = get_issue_by_id(issue["id"])
                if full and full.get("description"):
                    result = ingest_fr_issue(
                        engine,
                        issue_id=full["id"],
                        issue_identifier=full["identifier"],
                        owner_agent_id=full.get("assigneeAgentId"),
                        description=full.get("description", "") or "",
                        dry_run=dry_run,
                        issue_status=full.get("status"),
                    )
            if result.source == "none":
                newly_unindexable.add(identifier)
                logger.info(
                    "Catch-up FR: %s yielded no source files -- "
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
            "Catch-up FR: recorded %d newly unindexable issue(s) "
            "(%d total tracked)",
            len(newly_unindexable),
            len(all_unindexable),
        )

    if results:
        logger.info(
            "Catch-up FR complete: %d FDR issues processed, %d files indexed, %d skipped",
            len(results),
            sum(r.files_indexed for r in results),
            sum(1 for r in results if r.skipped_no_commits),
        )
    return results


def main() -> None:
    """CLI entry point: dispatch to __main__._run_fr_cli() (unified CLI)."""
    from .__main__ import _run_fr_cli

    _run_fr_cli()


if __name__ == "__main__":
    main()
