"""Data quality monitoring for Touch Index FR ingestion.

Provides coverage, freshness, and consistency checks for the
touch_index_fr_files table.  Designed to be called from the
validation script, the ingestion worker, or a standalone monitoring
cron job.

Usage:
    python -c "from touch_index.quality import run_quality_checks; print(run_quality_checks())"
"""

from __future__ import annotations

import logging
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Engine

from .paperclip_client import FDR_LABEL_ID, _company, _paginate

logger = logging.getLogger(__name__)


@dataclass
class CoverageReport:
    total_fdr_issues: int
    indexed_fdr_issues: int
    coverage_pct: float
    missing_issue_identifiers: list[str]

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class FreshnessReport:
    total_rows: int
    max_age_hours: float
    min_age_hours: float
    stale_rows: int
    stale_threshold_hours: int

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ConsistencyReport:
    null_owner_rows: int
    null_updated_at_rows: int
    duplicate_pairs: int
    unknown_source_rows: int
    orphan_fr_issue_ids: list[str]
    source_distribution: dict[str, int] | None = None

    def to_dict(self) -> dict:
        d = asdict(self)
        return d


@dataclass
class QualityReport:
    coverage: CoverageReport | None
    freshness: FreshnessReport | None
    consistency: ConsistencyReport | None
    passed: bool

    def to_dict(self) -> dict:
        d: dict[str, Any] = {"passed": self.passed}
        if self.coverage is not None:
            d["coverage"] = self.coverage.to_dict()
        if self.freshness is not None:
            d["freshness"] = self.freshness.to_dict()
        if self.consistency is not None:
            d["consistency"] = self.consistency.to_dict()
        return d


def compute_coverage(engine: Engine) -> CoverageReport:
    """Compare FDR issues in Paperclip vs touch_index_fr_files."""
    params: dict[str, Any] = {
        "labelId": FDR_LABEL_ID,
        "status": "todo,in_progress,in_review,done",
    }
    all_fdr = _paginate(f"/api/companies/{_company()}/issues", params)
    total = len(all_fdr)

    with engine.connect() as conn:
        indexed = (
            conn.execute(
                text("SELECT COUNT(DISTINCT fr_identifier) FROM touch_index_fr_files")
            ).scalar()
            or 0
        )

    pct = (indexed / total * 100) if total > 0 else 0.0

    indexed_set = set()
    with engine.connect() as conn:
        rows = conn.execute(
            text("SELECT DISTINCT fr_identifier FROM touch_index_fr_files")
        ).fetchall()
        indexed_set = {r[0] for r in rows}

    missing = sorted(
        i["identifier"] for i in all_fdr if i["identifier"] not in indexed_set
    )

    return CoverageReport(
        total_fdr_issues=total,
        indexed_fdr_issues=indexed,
        coverage_pct=round(pct, 1),
        missing_issue_identifiers=missing,
    )


def compute_freshness(
    engine: Engine,
    stale_threshold_hours: int = 168,
) -> FreshnessReport:
    """Report age statistics for touch_index_fr_files entries."""
    with engine.connect() as conn:
        total = (
            conn.execute(text("SELECT COUNT(*) FROM touch_index_fr_files")).scalar()
            or 0
        )

        oldest = conn.execute(
            text("SELECT MIN(updated_at) FROM touch_index_fr_files")
        ).scalar()
        newest = conn.execute(
            text("SELECT MAX(updated_at) FROM touch_index_fr_files")
        ).scalar()

    now = datetime.now(timezone.utc)
    max_age = (now - oldest).total_seconds() / 3600 if oldest else 0.0
    min_age = (now - newest).total_seconds() / 3600 if newest else 0.0

    cutoff = datetime.now(timezone.utc) - timedelta(hours=stale_threshold_hours)

    with engine.connect() as conn:
        stale = (
            conn.execute(
                text(
                    "SELECT COUNT(*) FROM touch_index_fr_files WHERE updated_at < :cutoff"
                ),
                {"cutoff": cutoff},
            ).scalar()
            or 0
        )

    return FreshnessReport(
        total_rows=total,
        max_age_hours=round(max_age, 1),
        min_age_hours=round(min_age, 1),
        stale_rows=stale,
        stale_threshold_hours=stale_threshold_hours,
    )


def check_consistency(engine: Engine) -> ConsistencyReport:
    """Check for orphan rows, null values, and duplicates."""
    with engine.connect() as conn:
        null_owner = (
            conn.execute(
                text(
                    "SELECT COUNT(*) FROM touch_index_fr_files "
                    "WHERE fr_owner_agent_id = '00000000-0000-0000-0000-000000000000'"
                )
            ).scalar()
            or 0
        )

        null_updated = (
            conn.execute(
                text(
                    "SELECT COUNT(*) FROM touch_index_fr_files WHERE updated_at IS NULL"
                )
            ).scalar()
            or 0
        )

        unknown_source = (
            conn.execute(
                text(
                    "SELECT COUNT(*) FROM touch_index_fr_files WHERE source = 'unknown'"
                )
            ).scalar()
            or 0
        )

        dups = (
            conn.execute(
                text("""
                SELECT COUNT(*) FROM (
                    SELECT file_path, fr_issue_id, COUNT(*)
                    FROM touch_index_fr_files
                    GROUP BY file_path, fr_issue_id
                    HAVING COUNT(*) > 1
                ) dups
            """)
            ).scalar()
            or 0
        )

        orphan_rows = conn.execute(
            text("SELECT DISTINCT fr_issue_id FROM touch_index_fr_files")
        ).fetchall()

        # Source distribution — how many rows from each extraction method
        source_dist: dict[str, int] = {}
        try:
            src_rows = conn.execute(
                text(
                    "SELECT source, COUNT(*) cnt FROM touch_index_fr_files"
                    " GROUP BY source"
                )
            ).fetchall()
            source_dist = {str(r[0]): r[1] for r in src_rows}
        except Exception:
            logger.warning("Could not query source distribution")

    orphan_ids: list[str] = []
    if orphan_rows:
        db_ids = {str(row[0]) for row in orphan_rows}
        try:
            from .paperclip_client import get_all_issue_ids

            paperclip_ids = get_all_issue_ids()
            orphan_ids = sorted(db_ids - paperclip_ids)
        except Exception:
            logger.warning("Could not fetch Paperclip issue IDs for orphan check")

    return ConsistencyReport(
        null_owner_rows=null_owner,
        null_updated_at_rows=null_updated,
        duplicate_pairs=dups,
        unknown_source_rows=unknown_source,
        orphan_fr_issue_ids=orphan_ids,
        source_distribution=source_dist,
    )


def run_quality_checks(
    engine: Engine,
    stale_threshold_hours: int = 168,
) -> QualityReport:
    """Run all data quality checks and return a consolidated report."""
    coverage = None
    freshness = None
    consistency = None
    failures = 0

    try:
        coverage = compute_coverage(engine)
        if coverage.coverage_pct < 90:
            logger.warning(
                "COVERAGE: %.1f%% (%d/%d) — %d missing issues",
                coverage.coverage_pct,
                coverage.indexed_fdr_issues,
                coverage.total_fdr_issues,
                len(coverage.missing_issue_identifiers),
            )
            failures += 1
        else:
            logger.info(
                "COVERAGE: %.1f%% (%d/%d)",
                coverage.coverage_pct,
                coverage.indexed_fdr_issues,
                coverage.total_fdr_issues,
            )
    except Exception:
        logger.exception("Coverage check failed")
        failures += 1

    try:
        freshness = compute_freshness(engine, stale_threshold_hours)
        if freshness.stale_rows > 0:
            logger.warning(
                "FRESHNESS: %d stale rows (>%d hours), max age %.1f hours",
                freshness.stale_rows,
                freshness.stale_threshold_hours,
                freshness.max_age_hours,
            )
            failures += 1
        else:
            logger.info(
                "FRESHNESS: %d rows, max age %.1f hours",
                freshness.total_rows,
                freshness.max_age_hours,
            )
    except Exception:
        logger.exception("Freshness check failed")
        failures += 1

    try:
        consistency = check_consistency(engine)
        issues = []
        if consistency.null_owner_rows:
            issues.append(f"{consistency.null_owner_rows} null-owner rows")
        if consistency.null_updated_at_rows:
            issues.append(f"{consistency.null_updated_at_rows} null-updated rows")
        if consistency.duplicate_pairs:
            issues.append(f"{consistency.duplicate_pairs} duplicate pairs")
        if consistency.unknown_source_rows:
            issues.append(f"{consistency.unknown_source_rows} unknown-source rows")
        if consistency.orphan_fr_issue_ids:
            issues.append(f"{len(consistency.orphan_fr_issue_ids)} orphans")
        src_dist = consistency.source_distribution or {}
        src_summary = (
            ", ".join(f"{k}={v}" for k, v in sorted(src_dist.items()))
            if src_dist
            else "no rows"
        )
        if issues:
            logger.warning(
                "CONSISTENCY: %s | source distribution: %s",
                "; ".join(issues),
                src_summary,
            )
            failures += 1
        else:
            logger.info(
                "CONSISTENCY: clean | source distribution: %s",
                src_summary,
            )
    except Exception:
        logger.exception("Consistency check failed")
        failures += 1

    return QualityReport(
        coverage=coverage,
        freshness=freshness,
        consistency=consistency,
        passed=failures == 0,
    )


# ---------------------------------------------------------------------------
# Bug data quality monitoring — touch_index_bug_files
# ---------------------------------------------------------------------------


@dataclass
class BugCoverageReport:
    total_bug_issues: int
    indexed_bug_issues: int
    coverage_pct: float
    missing_issue_identifiers: list[str]
    eligible_bug_issues: int = 0
    eligible_coverage_pct: float = 0.0
    missing_eligible_identifiers: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class BugFreshnessReport:
    total_rows: int
    max_age_hours: float
    min_age_hours: float
    stale_rows: int
    stale_threshold_days: int

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class BugConsistencyReport:
    null_closed_at_rows: int
    null_updated_at_rows: int
    duplicate_pairs: int
    unknown_source_rows: int
    orphan_bug_issue_ids: list[str]
    source_distribution: dict[str, int] | None = None

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class BugQualityReport:
    coverage: BugCoverageReport | None
    freshness: BugFreshnessReport | None
    consistency: BugConsistencyReport | None
    passed: bool

    def to_dict(self) -> dict:
        d: dict[str, Any] = {"passed": self.passed}
        if self.coverage is not None:
            d["coverage"] = self.coverage.to_dict()
        if self.freshness is not None:
            d["freshness"] = self.freshness.to_dict()
        if self.consistency is not None:
            d["consistency"] = self.consistency.to_dict()
        return d


def compute_bug_coverage(engine: Engine) -> BugCoverageReport:
    """Compare done non-FDR issues in Paperclip vs touch_index_bug_files.

    Reports two coverage metrics:
      - ``coverage_pct``: indexed / ALL done non-FDR issues (low because many
        org-level issues have no code changes).
      - ``eligible_coverage_pct``: indexed / issues that appear in git commit
        messages (the set of issues that *can* be indexed by the bug worker).

    The pass/fail gate in ``run_bug_quality_checks`` uses the eligible
    coverage so the CI pipeline doesn't fail on issues that can never be
    indexed.
    """
    from .git_extractor import get_all_referenced_issue_ids

    params: dict[str, Any] = {
        "status": "done",
    }
    all_done = _paginate(f"/api/companies/{_company()}/issues", params)
    # Filter out FDR-labelled issues (those are handled by FR worker)
    non_fdr_done = [
        i for i in all_done if FDR_LABEL_ID not in (i.get("labelIds") or [])
    ]
    total = len(non_fdr_done)

    with engine.connect() as conn:
        indexed = (
            conn.execute(
                text("SELECT COUNT(DISTINCT bug_identifier) FROM touch_index_bug_files")
            ).scalar()
            or 0
        )

    pct = (indexed / total * 100) if total > 0 else 0.0

    indexed_set = set()
    with engine.connect() as conn:
        rows = conn.execute(
            text("SELECT DISTINCT bug_identifier FROM touch_index_bug_files")
        ).fetchall()
        indexed_set = {r[0] for r in rows}

    missing = sorted(
        i["identifier"] for i in non_fdr_done if i["identifier"] not in indexed_set
    )

    # Determine eligible issues — those referenced in git commit messages.
    # Issues without git references can never be indexed by the bug
    # worker, so they are excluded from the eligibility-based coverage.
    git_ids = get_all_referenced_issue_ids()
    eligible = [i for i in non_fdr_done if i["identifier"] in git_ids]
    eligible_total = len(eligible)
    eligible_indexed = sum(1 for i in eligible if i["identifier"] in indexed_set)
    eligible_pct = (
        (eligible_indexed / eligible_total * 100) if eligible_total > 0 else 0.0
    )

    missing_eligible = sorted(
        i["identifier"] for i in eligible if i["identifier"] not in indexed_set
    )

    return BugCoverageReport(
        total_bug_issues=total,
        indexed_bug_issues=indexed,
        coverage_pct=round(pct, 1),
        missing_issue_identifiers=missing,
        eligible_bug_issues=eligible_total,
        eligible_coverage_pct=round(eligible_pct, 1),
        missing_eligible_identifiers=missing_eligible,
    )


def compute_bug_freshness(
    engine: Engine,
    stale_threshold_days: int = 30,
) -> BugFreshnessReport:
    """Report age statistics for touch_index_bug_files entries using updated_at."""
    with engine.connect() as conn:
        total = (
            conn.execute(text("SELECT COUNT(*) FROM touch_index_bug_files")).scalar()
            or 0
        )

        oldest = conn.execute(
            text("SELECT MIN(updated_at) FROM touch_index_bug_files")
        ).scalar()
        newest = conn.execute(
            text("SELECT MAX(updated_at) FROM touch_index_bug_files")
        ).scalar()

    now = datetime.now(timezone.utc)
    max_age = (now - oldest).total_seconds() / 3600 if oldest else 0.0
    min_age = (now - newest).total_seconds() / 3600 if newest else 0.0

    cutoff = datetime.now(timezone.utc) - timedelta(days=stale_threshold_days)

    with engine.connect() as conn:
        stale = (
            conn.execute(
                text(
                    "SELECT COUNT(*) FROM touch_index_bug_files "
                    "WHERE updated_at < :cutoff"
                ),
                {"cutoff": cutoff},
            ).scalar()
            or 0
        )

    return BugFreshnessReport(
        total_rows=total,
        max_age_hours=round(max_age, 1),
        min_age_hours=round(min_age, 1),
        stale_rows=stale,
        stale_threshold_days=stale_threshold_days,
    )


def check_bug_consistency(engine: Engine) -> BugConsistencyReport:
    """Check for orphan rows, null closed_at, duplicates, and unknown source in touch_index_bug_files."""
    with engine.connect() as conn:
        null_closed = (
            conn.execute(
                text(
                    "SELECT COUNT(*) FROM touch_index_bug_files WHERE closed_at IS NULL"
                )
            ).scalar()
            or 0
        )

        null_updated = (
            conn.execute(
                text(
                    "SELECT COUNT(*) FROM touch_index_bug_files WHERE updated_at IS NULL"
                )
            ).scalar()
            or 0
        )

        dups = (
            conn.execute(
                text("""
                SELECT COUNT(*) FROM (
                    SELECT file_path, bug_issue_id, COUNT(*)
                    FROM touch_index_bug_files
                    GROUP BY file_path, bug_issue_id
                    HAVING COUNT(*) > 1
                ) dups
            """)
            ).scalar()
            or 0
        )

        unknown_source = (
            conn.execute(
                text(
                    "SELECT COUNT(*) FROM touch_index_bug_files WHERE source = 'unknown'"
                )
            ).scalar()
            or 0
        )

        orphan_rows = conn.execute(
            text("SELECT DISTINCT bug_issue_id FROM touch_index_bug_files")
        ).fetchall()

        # Source distribution — how many rows from each extraction method
        source_dist: dict[str, int] = {}
        try:
            src_rows = conn.execute(
                text(
                    "SELECT source, COUNT(*) cnt FROM touch_index_bug_files"
                    " GROUP BY source"
                )
            ).fetchall()
            source_dist = {str(r[0]): r[1] for r in src_rows}
        except Exception:
            logger.warning("Could not query bug source distribution")

    orphan_ids: list[str] = []
    if orphan_rows:
        db_ids = {str(row[0]) for row in orphan_rows}
        try:
            from .paperclip_client import get_all_issue_ids

            paperclip_ids = get_all_issue_ids()
            orphan_ids = sorted(db_ids - paperclip_ids)
        except Exception:
            logger.warning("Could not fetch Paperclip issue IDs for bug orphan check")

    return BugConsistencyReport(
        null_closed_at_rows=null_closed,
        null_updated_at_rows=null_updated,
        duplicate_pairs=dups,
        unknown_source_rows=unknown_source,
        orphan_bug_issue_ids=orphan_ids,
        source_distribution=source_dist,
    )


def run_bug_quality_checks(
    engine: Engine,
    stale_threshold_days: int = 30,
) -> BugQualityReport:
    """Run all bug data quality checks and return a consolidated report."""
    coverage = None
    freshness = None
    consistency = None
    failures = 0

    try:
        coverage = compute_bug_coverage(engine)
        # Use eligible coverage for the pass/fail gate — issues without git
        # fix commits can never be indexed by the bug worker, so using the
        # raw total denominator would always fail (~16% coverage).
        # When there are zero eligible issues, the gate passes automatically.
        eligible_indexed = max(
            0, coverage.eligible_bug_issues - len(coverage.missing_eligible_identifiers)
        )
        if coverage.eligible_bug_issues > 0 and coverage.eligible_coverage_pct < 90:
            logger.warning(
                "BUG COVERAGE: %.1f%% (%d/%d) overall / %.1f%% (%d/%d) eligible — %d missing eligible",
                coverage.coverage_pct,
                coverage.indexed_bug_issues,
                coverage.total_bug_issues,
                coverage.eligible_coverage_pct,
                eligible_indexed,
                coverage.eligible_bug_issues,
                len(coverage.missing_eligible_identifiers),
            )
            failures += 1
        else:
            logger.info(
                "BUG COVERAGE: %.1f%% (%d/%d) overall / %.1f%% (%d/%d) eligible",
                coverage.coverage_pct,
                coverage.indexed_bug_issues,
                coverage.total_bug_issues,
                coverage.eligible_coverage_pct,
                eligible_indexed,
                coverage.eligible_bug_issues,
            )
    except Exception:
        logger.exception("Bug coverage check failed")
        failures += 1

    try:
        freshness = compute_bug_freshness(engine, stale_threshold_days)
        if freshness.stale_rows > 0:
            logger.warning(
                "BUG FRESHNESS: %d stale rows (>%d days), max age %.1f hours",
                freshness.stale_rows,
                freshness.stale_threshold_days,
                freshness.max_age_hours,
            )
            failures += 1
        else:
            logger.info(
                "BUG FRESHNESS: %d rows, max age %.1f hours",
                freshness.total_rows,
                freshness.max_age_hours,
            )
    except Exception:
        logger.exception("Bug freshness check failed")
        failures += 1

    try:
        consistency = check_bug_consistency(engine)
        issues = []
        if consistency.null_closed_at_rows:
            logger.warning(
                "BUG CONSISTENCY: %d null-closed_at rows — "
                "issue completedAt not set in Paperclip (non-blocking)",
                consistency.null_closed_at_rows,
            )
        if consistency.null_updated_at_rows:
            issues.append(f"{consistency.null_updated_at_rows} null-updated_at rows")
        if consistency.duplicate_pairs:
            issues.append(f"{consistency.duplicate_pairs} duplicate pairs")
        if consistency.unknown_source_rows:
            issues.append(f"{consistency.unknown_source_rows} unknown-source rows")
        if consistency.orphan_bug_issue_ids:
            issues.append(f"{len(consistency.orphan_bug_issue_ids)} orphans")
        src_dist = consistency.source_distribution or {}
        src_summary = (
            ", ".join(f"{k}={v}" for k, v in sorted(src_dist.items()))
            if src_dist
            else "no rows"
        )
        if issues:
            logger.warning(
                "BUG CONSISTENCY: %s | source distribution: %s",
                "; ".join(issues),
                src_summary,
            )
            failures += 1
        else:
            logger.info(
                "BUG CONSISTENCY: clean | source distribution: %s",
                src_summary,
            )
    except Exception:
        logger.exception("Bug consistency check failed")
        failures += 1

    return BugQualityReport(
        coverage=coverage,
        freshness=freshness,
        consistency=consistency,
        passed=failures == 0,
    )
