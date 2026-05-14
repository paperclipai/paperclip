"""Unit tests for touch_index.quality data quality monitoring.

All external I/O (DB engine, Paperclip API) is mocked so tests run offline.
"""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import MagicMock, call, patch

import pytest

from touch_index.quality import (
    CoverageReport,
    FreshnessReport,
    ConsistencyReport,
    QualityReport,
    compute_coverage,
    compute_freshness,
    check_consistency,
    run_quality_checks,
    BugCoverageReport,
    BugFreshnessReport,
    BugConsistencyReport,
    BugQualityReport,
    compute_bug_coverage,
    compute_bug_freshness,
    check_bug_consistency,
    run_bug_quality_checks,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_scalar_result(val, rows=None):
    r = MagicMock()
    r.scalar = MagicMock(return_value=val)
    if rows is not None:
        r.fetchall = MagicMock(return_value=rows)
    else:
        r.fetchall = MagicMock(return_value=[])
    return r


def _make_engine(execute_results):
    """Return an engine whose connect() context-manager yields a conn
    whose execute() returns results from *execute_results* in order."""
    idx = [0]

    def _execute(*a, **kw):
        i = idx[0]
        idx[0] += 1
        if i < len(execute_results):
            return execute_results[i]
        return _make_scalar_result(0)

    conn = MagicMock()
    conn.execute = _execute
    ctx = MagicMock()
    ctx.__enter__ = MagicMock(return_value=conn)
    ctx.__exit__ = MagicMock(return_value=False)
    engine = MagicMock()
    engine.connect = MagicMock(return_value=ctx)
    return engine


def _make_coverage(**kw):
    defaults = dict(
        total_fdr_issues=0,
        indexed_fdr_issues=0,
        coverage_pct=0.0,
        missing_issue_identifiers=[],
    )
    defaults.update(kw)
    return CoverageReport(**defaults)


def _make_freshness(**kw):
    defaults = dict(
        total_rows=0,
        max_age_hours=0.0,
        min_age_hours=0.0,
        stale_rows=0,
        stale_threshold_hours=168,
    )
    defaults.update(kw)
    return FreshnessReport(**defaults)


def _make_consistency(**kw):
    defaults = dict(
        null_owner_rows=0,
        null_updated_at_rows=0,
        duplicate_pairs=0,
        unknown_source_rows=0,
        orphan_fr_issue_ids=[],
    )
    defaults.update(kw)
    return ConsistencyReport(**defaults)


# ---------------------------------------------------------------------------
# compute_coverage
# ---------------------------------------------------------------------------


class TestComputeCoverage:
    def test_full_coverage(self):
        engine = _make_engine(
            [
                _make_scalar_result(2),  # COUNT(DISTINCT fr_identifier)
                _make_scalar_result(
                    0,
                    rows=[  # DISTINCT fr_identifier rows
                        ("BTCAAAAA-100",),
                        ("BTCAAAAA-101",),
                    ],
                ),
            ]
        )

        with patch(
            "touch_index.quality._paginate",
            return_value=[
                {"identifier": "BTCAAAAA-100"},
                {"identifier": "BTCAAAAA-101"},
            ],
        ) as mock_api:
            report = compute_coverage(engine)

        assert report.total_fdr_issues == 2
        assert report.indexed_fdr_issues == 2
        assert report.coverage_pct == 100.0
        assert report.missing_issue_identifiers == []
        mock_api.assert_called_once()

    def test_partial_coverage(self):
        engine = _make_engine(
            [
                _make_scalar_result(1),
                _make_scalar_result(0, rows=[("BTCAAAAA-100",)]),
            ]
        )

        with patch(
            "touch_index.quality._paginate",
            return_value=[
                {"identifier": "BTCAAAAA-100"},
                {"identifier": "BTCAAAAA-101"},
                {"identifier": "BTCAAAAA-102"},
            ],
        ):
            report = compute_coverage(engine)

        assert report.total_fdr_issues == 3
        assert report.indexed_fdr_issues == 1
        assert report.coverage_pct == pytest.approx(33.3, rel=0.1)
        assert report.missing_issue_identifiers == ["BTCAAAAA-101", "BTCAAAAA-102"]

    def test_zero_indexed(self):
        engine = _make_engine(
            [
                _make_scalar_result(0),
                _make_scalar_result(0, rows=[]),
            ]
        )

        with patch(
            "touch_index.quality._paginate",
            return_value=[
                {"identifier": "BTCAAAAA-100"},
                {"identifier": "BTCAAAAA-101"},
            ],
        ):
            report = compute_coverage(engine)

        assert report.total_fdr_issues == 2
        assert report.indexed_fdr_issues == 0
        assert report.coverage_pct == 0.0
        assert len(report.missing_issue_identifiers) == 2

    def test_zero_fdr_issues(self):
        engine = _make_engine(
            [
                _make_scalar_result(0),
                _make_scalar_result(0, rows=[]),
            ]
        )

        with patch("touch_index.quality._paginate", return_value=[]):
            report = compute_coverage(engine)

        assert report.total_fdr_issues == 0
        assert report.indexed_fdr_issues == 0
        assert report.coverage_pct == 0.0
        assert report.missing_issue_identifiers == []


# ---------------------------------------------------------------------------
# compute_freshness
# ---------------------------------------------------------------------------


class TestComputeFreshness:
    def test_empty_table(self):
        now = datetime.now(timezone.utc)
        engine = _make_engine(
            [
                _make_scalar_result(0),  # COUNT(*)
                _make_scalar_result(None),  # MIN(updated_at) — None
                _make_scalar_result(None),  # MAX(updated_at) — None
                _make_scalar_result(0),  # stale count
            ]
        )

        with patch("touch_index.quality.datetime") as mock_dt:
            mock_dt.now.return_value = now

            report = compute_freshness(engine)

        assert report.total_rows == 0
        assert report.max_age_hours == 0.0
        assert report.stale_rows == 0

    def test_fresh_data(self):
        now = datetime(2026, 5, 12, 12, 0, 0, tzinfo=timezone.utc)
        old_dt = datetime(2026, 5, 11, 12, 0, 0, tzinfo=timezone.utc)

        engine = _make_engine(
            [
                _make_scalar_result(5),  # COUNT(*)
                _make_scalar_result(old_dt),  # MIN
                _make_scalar_result(now),  # MAX
                _make_scalar_result(0),  # stale
            ]
        )

        with patch("touch_index.quality.datetime") as mock_dt_patch:
            mock_dt_patch.now.return_value = now
            mock_dt_patch.timedelta = __import__("datetime").timedelta
            report = compute_freshness(engine)

        assert report.total_rows == 5
        assert report.max_age_hours == 24.0
        assert report.stale_rows == 0


# ---------------------------------------------------------------------------
# check_consistency
# ---------------------------------------------------------------------------


class TestCheckConsistency:
    def test_clean_data(self):
        """When data is clean, all counts are zero and no orphans."""
        engine = _make_engine(
            [
                _make_scalar_result(0),  # null_owner
                _make_scalar_result(0),  # null_updated
                _make_scalar_result(0),  # unknown_source
                _make_scalar_result(0),  # duplicates
                _make_scalar_result(0, rows=[]),  # DISTINCT fr_issue_ids
            ]
        )

        with patch(
            "touch_index.paperclip_client.get_all_issue_ids",
            return_value=set(),
        ):
            report = check_consistency(engine)

        assert report.null_owner_rows == 0
        assert report.null_updated_at_rows == 0
        assert report.duplicate_pairs == 0
        assert report.orphan_fr_issue_ids == []

    def test_detects_null_owner(self):
        """Rows with sentinel owner UUID are counted."""
        engine = _make_engine(
            [
                _make_scalar_result(3),  # null_owner
                _make_scalar_result(0),  # null_updated
                _make_scalar_result(0),  # unknown_source
                _make_scalar_result(0),  # duplicates
                _make_scalar_result(0, rows=[]),  # DISTINCT
            ]
        )

        with patch(
            "touch_index.paperclip_client.get_all_issue_ids",
            return_value=set(),
        ):
            report = check_consistency(engine)

        assert report.null_owner_rows == 3
        assert report.null_updated_at_rows == 0
        assert report.duplicate_pairs == 0

    def test_detects_orphans(self):
        """Issue IDs not found in Paperclip are reported as orphans."""
        engine = _make_engine(
            [
                _make_scalar_result(0),  # null_owner
                _make_scalar_result(0),  # null_updated
                _make_scalar_result(0),  # unknown_source
                _make_scalar_result(0),  # duplicates
                _make_scalar_result(0, rows=[("orphan-1",), ("orphan-2",)]),
            ]
        )

        with patch(
            "touch_index.paperclip_client.get_all_issue_ids",
            return_value={"existing-id"},
        ):
            report = check_consistency(engine)

        assert len(report.orphan_fr_issue_ids) == 2
        assert "orphan-1" in report.orphan_fr_issue_ids

    def test_source_distribution_query_failure_logs_warning(self, caplog):
        """When source distribution query fails, a warning is logged and source_distribution is empty."""
        import logging

        call_count = [0]

        def _execute(*a, **kw):
            call_count[0] += 1
            if call_count[0] == 6:
                raise RuntimeError("Source distribution query failed")
            r = MagicMock()
            r.scalar = MagicMock(return_value=0)
            r.fetchall = MagicMock(return_value=[])
            return r

        conn = MagicMock()
        conn.execute = _execute
        ctx = MagicMock()
        ctx.__enter__ = MagicMock(return_value=conn)
        ctx.__exit__ = MagicMock(return_value=False)
        engine = MagicMock()
        engine.connect = MagicMock(return_value=ctx)

        with (
            patch(
                "touch_index.paperclip_client.get_all_issue_ids",
                return_value=set(),
            ),
            caplog.at_level(logging.WARNING),
        ):
            report = check_consistency(engine)

        assert report.source_distribution == {}
        assert any(
            "Could not query source distribution" in r.message for r in caplog.records
        )


# ---------------------------------------------------------------------------
# run_quality_checks
# ---------------------------------------------------------------------------


class TestRunQualityChecks:
    def test_all_pass(self):
        engine = MagicMock()

        with (
            patch(
                "touch_index.quality.compute_coverage",
                return_value=_make_coverage(
                    total_fdr_issues=2, indexed_fdr_issues=2, coverage_pct=100.0
                ),
            ),
            patch(
                "touch_index.quality.compute_freshness",
                return_value=_make_freshness(total_rows=5, max_age_hours=2.0),
            ),
            patch(
                "touch_index.quality.check_consistency",
                return_value=_make_consistency(),
            ),
        ):
            report = run_quality_checks(engine)

        assert report.passed is True
        assert report.coverage is not None
        assert report.freshness is not None
        assert report.consistency is not None

    def test_unknown_source_rows_fails(self):
        engine = MagicMock()

        with (
            patch(
                "touch_index.quality.compute_coverage",
                return_value=_make_coverage(
                    total_fdr_issues=2, indexed_fdr_issues=2, coverage_pct=100.0
                ),
            ),
            patch(
                "touch_index.quality.compute_freshness",
                return_value=_make_freshness(total_rows=5, max_age_hours=1.0),
            ),
            patch(
                "touch_index.quality.check_consistency",
                return_value=_make_consistency(unknown_source_rows=3),
            ),
        ):
            report = run_quality_checks(engine)

        assert report.passed is False
        assert report.consistency is not None
        assert report.consistency.unknown_source_rows == 3

    def test_low_coverage_fails(self):
        engine = MagicMock()

        with (
            patch(
                "touch_index.quality.compute_coverage",
                return_value=_make_coverage(
                    total_fdr_issues=10, indexed_fdr_issues=5, coverage_pct=50.0
                ),
            ),
            patch(
                "touch_index.quality.compute_freshness",
                return_value=_make_freshness(total_rows=5, max_age_hours=1.0),
            ),
            patch(
                "touch_index.quality.check_consistency",
                return_value=_make_consistency(),
            ),
        ):
            report = run_quality_checks(engine)

        assert report.passed is False

    def test_stale_rows_fails(self):
        engine = MagicMock()

        with (
            patch(
                "touch_index.quality.compute_coverage",
                return_value=_make_coverage(
                    total_fdr_issues=2, indexed_fdr_issues=2, coverage_pct=100.0
                ),
            ),
            patch(
                "touch_index.quality.compute_freshness",
                return_value=_make_freshness(
                    total_rows=5, stale_rows=3, stale_threshold_hours=168
                ),
            ),
            patch(
                "touch_index.quality.check_consistency",
                return_value=_make_consistency(),
            ),
        ):
            report = run_quality_checks(engine)

        assert report.passed is False

    def test_consistency_issues_fail(self):
        engine = MagicMock()

        with (
            patch(
                "touch_index.quality.compute_coverage",
                return_value=_make_coverage(
                    total_fdr_issues=2, indexed_fdr_issues=2, coverage_pct=100.0
                ),
            ),
            patch(
                "touch_index.quality.compute_freshness",
                return_value=_make_freshness(total_rows=5, max_age_hours=1.0),
            ),
            patch(
                "touch_index.quality.check_consistency",
                return_value=_make_consistency(null_owner_rows=2),
            ),
        ):
            report = run_quality_checks(engine)

        assert report.passed is False

    def test_exception_in_coverage_still_runs_others(self):
        engine = MagicMock()

        with (
            patch(
                "touch_index.quality.compute_coverage",
                side_effect=RuntimeError("API timeout"),
            ),
            patch(
                "touch_index.quality.compute_freshness",
                return_value=_make_freshness(total_rows=5),
            ),
            patch(
                "touch_index.quality.check_consistency",
                return_value=_make_consistency(),
            ),
        ):
            report = run_quality_checks(engine)

        assert report.passed is False
        assert report.coverage is None
        assert report.freshness is not None
        assert report.consistency is not None


# ---------------------------------------------------------------------------
# compute_bug_coverage
# ---------------------------------------------------------------------------


class TestComputeBugCoverage:
    def test_full_coverage(self):
        engine = _make_engine(
            [
                _make_scalar_result(2),  # COUNT(DISTINCT bug_identifier)
                _make_scalar_result(
                    0,
                    rows=[  # DISTINCT bug_identifier rows
                        ("BTCAAAAA-100",),
                        ("BTCAAAAA-101",),
                    ],
                ),
            ]
        )

        with patch(
            "touch_index.quality._paginate",
            return_value=[
                {"identifier": "BTCAAAAA-100"},
                {"identifier": "BTCAAAAA-101"},
            ],
        ) as mock_api:
            report = compute_bug_coverage(engine)

        assert report.total_bug_issues == 2
        assert report.indexed_bug_issues == 2
        assert report.coverage_pct == 100.0
        assert report.missing_issue_identifiers == []
        mock_api.assert_called_once()

    def test_partial_coverage(self):
        engine = _make_engine(
            [
                _make_scalar_result(1),
                _make_scalar_result(0, rows=[("BTCAAAAA-100",)]),
            ]
        )

        with patch(
            "touch_index.quality._paginate",
            return_value=[
                {"identifier": "BTCAAAAA-100"},
                {"identifier": "BTCAAAAA-101"},
                {"identifier": "BTCAAAAA-102"},
            ],
        ):
            report = compute_bug_coverage(engine)

        assert report.total_bug_issues == 3
        assert report.indexed_bug_issues == 1
        assert report.coverage_pct == pytest.approx(33.3, rel=0.1)
        assert report.missing_issue_identifiers == ["BTCAAAAA-101", "BTCAAAAA-102"]

    def test_zero_indexed(self):
        engine = _make_engine(
            [
                _make_scalar_result(0),
                _make_scalar_result(0, rows=[]),
            ]
        )

        with patch(
            "touch_index.quality._paginate",
            return_value=[
                {"identifier": "BTCAAAAA-100"},
                {"identifier": "BTCAAAAA-101"},
            ],
        ):
            report = compute_bug_coverage(engine)

        assert report.total_bug_issues == 2
        assert report.indexed_bug_issues == 0
        assert report.coverage_pct == 0.0
        assert len(report.missing_issue_identifiers) == 2

    def test_zero_issues(self):
        engine = _make_engine(
            [
                _make_scalar_result(0),
                _make_scalar_result(0, rows=[]),
            ]
        )

        with patch("touch_index.quality._paginate", return_value=[]):
            report = compute_bug_coverage(engine)

        assert report.total_bug_issues == 0
        assert report.indexed_bug_issues == 0
        assert report.coverage_pct == 0.0
        assert report.missing_issue_identifiers == []

    def test_filters_fdr_labelled(self):
        """FDR-labelled done issues are excluded from the coverage denominator."""
        engine = _make_engine(
            [
                _make_scalar_result(1),
                _make_scalar_result(0, rows=[("BTCAAAAA-200",)]),
            ]
        )

        with patch(
            "touch_index.quality._paginate",
            return_value=[
                {
                    "identifier": "BTCAAAAA-100",
                    "labelIds": ["d523cb2d-acd9-423d-b87a-bb79cee42c40"],
                },
                {"identifier": "BTCAAAAA-200"},
            ],
        ):
            report = compute_bug_coverage(engine)

        assert report.total_bug_issues == 1  # FDR filtered out
        assert report.indexed_bug_issues == 1
        assert report.coverage_pct == 100.0

    def test_eligible_coverage_full(self):
        """All eligible (git-referenced) issues are indexed."""
        engine = _make_engine(
            [
                _make_scalar_result(2),  # COUNT(DISTINCT bug_identifier)
                _make_scalar_result(
                    0,
                    rows=[
                        ("BTCAAAAA-100",),
                        ("BTCAAAAA-101",),
                    ],
                ),
            ]
        )

        with (
            patch(
                "touch_index.quality._paginate",
                return_value=[
                    {"identifier": "BTCAAAAA-100"},
                    {"identifier": "BTCAAAAA-101"},
                    {"identifier": "BTCAAAAA-102"},
                ],
            ),
            patch(
                "touch_index.git_extractor.get_all_referenced_issue_ids",
                return_value={"BTCAAAAA-100", "BTCAAAAA-101"},
            ),
        ):
            report = compute_bug_coverage(engine)

        assert report.total_bug_issues == 3
        assert report.indexed_bug_issues == 2
        assert report.coverage_pct == pytest.approx(66.7, rel=0.1)
        assert report.eligible_bug_issues == 2
        assert report.eligible_coverage_pct == 100.0
        assert report.missing_eligible_identifiers == []

    def test_eligible_coverage_partial(self):
        """Some eligible issues are missing from the index."""
        engine = _make_engine(
            [
                _make_scalar_result(1),  # COUNT(DISTINCT bug_identifier)
                _make_scalar_result(
                    0,
                    rows=[("BTCAAAAA-101",)],
                ),
            ]
        )

        with (
            patch(
                "touch_index.quality._paginate",
                return_value=[
                    {"identifier": "BTCAAAAA-100"},
                    {"identifier": "BTCAAAAA-101"},
                    {"identifier": "BTCAAAAA-102"},
                ],
            ),
            patch(
                "touch_index.git_extractor.get_all_referenced_issue_ids",
                return_value={"BTCAAAAA-100", "BTCAAAAA-101"},
            ),
        ):
            report = compute_bug_coverage(engine)

        assert report.eligible_bug_issues == 2
        assert report.eligible_coverage_pct == 50.0
        assert report.missing_eligible_identifiers == ["BTCAAAAA-100"]

    def test_eligible_coverage_none_eligible(self):
        """When no issues have git references, eligible coverage is 0 and gate passes automatically."""
        engine = _make_engine(
            [
                _make_scalar_result(0),  # COUNT(DISTINCT bug_identifier)
                _make_scalar_result(0, rows=[]),
            ]
        )

        with (
            patch(
                "touch_index.quality._paginate",
                return_value=[
                    {"identifier": "BTCAAAAA-100"},
                ],
            ),
            patch(
                "touch_index.git_extractor.get_all_referenced_issue_ids",
                return_value=set(),
            ),
        ):
            report = compute_bug_coverage(engine)

        assert report.total_bug_issues == 1
        assert report.indexed_bug_issues == 0
        assert report.coverage_pct == 0.0
        assert report.eligible_bug_issues == 0
        assert report.eligible_coverage_pct == 0.0
        assert report.missing_eligible_identifiers == []


# ---------------------------------------------------------------------------
# compute_bug_freshness
# ---------------------------------------------------------------------------


class TestComputeBugFreshness:
    def test_empty_table(self):
        now = datetime.now(timezone.utc)
        engine = _make_engine(
            [
                _make_scalar_result(0),  # COUNT(*)
                _make_scalar_result(None),  # MIN(updated_at)
                _make_scalar_result(None),  # MAX(updated_at)
                _make_scalar_result(0),  # stale
            ]
        )

        with patch("touch_index.quality.datetime") as mock_dt:
            mock_dt.now.return_value = now
            report = compute_bug_freshness(engine)

        assert report.total_rows == 0
        assert report.max_age_hours == 0.0
        assert report.stale_rows == 0

    def test_fresh_data(self):
        now = datetime(2026, 5, 12, 12, 0, 0, tzinfo=timezone.utc)
        old_dt = datetime(2026, 5, 11, 12, 0, 0, tzinfo=timezone.utc)

        engine = _make_engine(
            [
                _make_scalar_result(5),  # COUNT(*)
                _make_scalar_result(old_dt),  # MIN(updated_at)
                _make_scalar_result(now),  # MAX(updated_at)
                _make_scalar_result(0),  # stale
            ]
        )

        with patch("touch_index.quality.datetime") as mock_dt_patch:
            mock_dt_patch.now.return_value = now
            mock_dt_patch.timedelta = __import__("datetime").timedelta
            report = compute_bug_freshness(engine)

        assert report.total_rows == 5
        assert report.max_age_hours == 24.0
        assert report.stale_rows == 0

    def test_stale_data(self):
        now = datetime(2026, 6, 12, 12, 0, 0, tzinfo=timezone.utc)
        old_dt = datetime(2026, 4, 1, 12, 0, 0, tzinfo=timezone.utc)

        engine = _make_engine(
            [
                _make_scalar_result(3),
                _make_scalar_result(old_dt),
                _make_scalar_result(now),
                _make_scalar_result(1),  # stale
            ]
        )

        with patch("touch_index.quality.datetime") as mock_dt_patch:
            mock_dt_patch.now.return_value = now
            mock_dt_patch.timedelta = __import__("datetime").timedelta
            report = compute_bug_freshness(engine, stale_threshold_days=30)

        assert report.total_rows == 3
        assert report.stale_rows == 1


# ---------------------------------------------------------------------------
# check_bug_consistency
# ---------------------------------------------------------------------------


class TestCheckBugConsistency:
    def test_clean_data(self):
        engine = _make_engine(
            [
                _make_scalar_result(0),  # null_closed_at
                _make_scalar_result(0),  # null_updated_at
                _make_scalar_result(0),  # duplicates
                _make_scalar_result(0),  # unknown_source
                _make_scalar_result(0, rows=[]),  # DISTINCT bug_issue_ids
            ]
        )

        with patch(
            "touch_index.paperclip_client.get_all_issue_ids",
            return_value=set(),
        ):
            report = check_bug_consistency(engine)

        assert report.null_closed_at_rows == 0
        assert report.duplicate_pairs == 0
        assert report.orphan_bug_issue_ids == []

    def test_detects_null_closed_at(self):
        engine = _make_engine(
            [
                _make_scalar_result(5),  # null_closed_at
                _make_scalar_result(0),  # null_updated_at
                _make_scalar_result(0),  # duplicates
                _make_scalar_result(0, rows=[]),
            ]
        )

        with patch(
            "touch_index.paperclip_client.get_all_issue_ids",
            return_value=set(),
        ):
            report = check_bug_consistency(engine)

        assert report.null_closed_at_rows == 5
        assert report.duplicate_pairs == 0

    def test_detects_duplicates(self):
        engine = _make_engine(
            [
                _make_scalar_result(0),  # null_closed_at
                _make_scalar_result(0),  # null_updated_at
                _make_scalar_result(3),  # duplicates
                _make_scalar_result(0),  # unknown_source
                _make_scalar_result(0, rows=[]),
            ]
        )

        with patch(
            "touch_index.paperclip_client.get_all_issue_ids",
            return_value=set(),
        ):
            report = check_bug_consistency(engine)

        assert report.duplicate_pairs == 3

    def test_detects_orphans(self):
        engine = _make_engine(
            [
                _make_scalar_result(0),  # null_closed_at
                _make_scalar_result(0),  # null_updated_at
                _make_scalar_result(0),  # duplicates
                _make_scalar_result(0),  # unknown_source
                _make_scalar_result(
                    0, rows=[("orphan-1",), ("orphan-2",)]
                ),  # DISTINCT bug_issue_ids
            ]
        )

        with patch(
            "touch_index.paperclip_client.get_all_issue_ids",
            return_value={"existing-id"},
        ):
            report = check_bug_consistency(engine)

        assert len(report.orphan_bug_issue_ids) == 2
        assert "orphan-1" in report.orphan_bug_issue_ids

    def test_bug_source_distribution_query_failure_logs_warning(self, caplog):
        """When bug source distribution query fails, a warning is logged and source_distribution is empty."""
        import logging

        call_count = [0]

        def _execute(*a, **kw):
            call_count[0] += 1
            if call_count[0] == 6:
                raise RuntimeError("Bug source distribution query failed")
            r = MagicMock()
            r.scalar = MagicMock(return_value=0)
            r.fetchall = MagicMock(return_value=[])
            return r

        conn = MagicMock()
        conn.execute = _execute
        ctx = MagicMock()
        ctx.__enter__ = MagicMock(return_value=conn)
        ctx.__exit__ = MagicMock(return_value=False)
        engine = MagicMock()
        engine.connect = MagicMock(return_value=ctx)

        with (
            patch(
                "touch_index.paperclip_client.get_all_issue_ids",
                return_value=set(),
            ),
            caplog.at_level(logging.WARNING),
        ):
            report = check_bug_consistency(engine)

        assert report.source_distribution == {}
        assert any(
            "Could not query bug source distribution" in r.message
            for r in caplog.records
        )


# ---------------------------------------------------------------------------
# run_bug_quality_checks
# ---------------------------------------------------------------------------


class TestRunBugQualityChecks:
    def test_all_pass(self):
        engine = MagicMock()

        with (
            patch(
                "touch_index.quality.compute_bug_coverage",
                return_value=BugCoverageReport(
                    total_bug_issues=2,
                    indexed_bug_issues=2,
                    coverage_pct=100.0,
                    missing_issue_identifiers=[],
                    eligible_bug_issues=2,
                    eligible_coverage_pct=100.0,
                    missing_eligible_identifiers=[],
                ),
            ),
            patch(
                "touch_index.quality.compute_bug_freshness",
                return_value=BugFreshnessReport(
                    total_rows=5,
                    max_age_hours=2.0,
                    min_age_hours=0.1,
                    stale_rows=0,
                    stale_threshold_days=30,
                ),
            ),
            patch(
                "touch_index.quality.check_bug_consistency",
                return_value=BugConsistencyReport(
                    null_closed_at_rows=0,
                    null_updated_at_rows=0,
                    duplicate_pairs=0,
                    orphan_bug_issue_ids=[],
                    unknown_source_rows=0,
                ),
            ),
        ):
            report = run_bug_quality_checks(engine)

        assert report.passed is True
        assert report.coverage is not None
        assert report.freshness is not None
        assert report.consistency is not None

    def test_bug_unknown_source_rows_fails(self):
        """Unknown source rows in bug consistency trigger a failure."""
        engine = MagicMock()

        with (
            patch(
                "touch_index.quality.compute_bug_coverage",
                return_value=BugCoverageReport(
                    total_bug_issues=2,
                    indexed_bug_issues=2,
                    coverage_pct=100.0,
                    missing_issue_identifiers=[],
                    eligible_bug_issues=2,
                    eligible_coverage_pct=100.0,
                    missing_eligible_identifiers=[],
                ),
            ),
            patch(
                "touch_index.quality.compute_bug_freshness",
                return_value=BugFreshnessReport(
                    total_rows=5,
                    max_age_hours=2.0,
                    min_age_hours=0.1,
                    stale_rows=0,
                    stale_threshold_days=30,
                ),
            ),
            patch(
                "touch_index.quality.check_bug_consistency",
                return_value=BugConsistencyReport(
                    null_closed_at_rows=0,
                    null_updated_at_rows=0,
                    duplicate_pairs=0,
                    unknown_source_rows=3,
                    orphan_bug_issue_ids=[],
                ),
            ),
        ):
            report = run_bug_quality_checks(engine)

        assert report.passed is False
        assert report.consistency is not None
        assert report.consistency.unknown_source_rows == 3

    def test_low_coverage_fails(self):
        engine = MagicMock()

        with (
            patch(
                "touch_index.quality.compute_bug_coverage",
                return_value=BugCoverageReport(
                    total_bug_issues=10,
                    indexed_bug_issues=5,
                    coverage_pct=50.0,
                    missing_issue_identifiers=["BTCAAAAA-101"],
                    eligible_bug_issues=8,
                    eligible_coverage_pct=62.5,
                    missing_eligible_identifiers=["BTCAAAAA-101"],
                ),
            ),
            patch(
                "touch_index.quality.compute_bug_freshness",
                return_value=BugFreshnessReport(
                    total_rows=5,
                    max_age_hours=1.0,
                    min_age_hours=0.1,
                    stale_rows=0,
                    stale_threshold_days=30,
                ),
            ),
            patch(
                "touch_index.quality.check_bug_consistency",
                return_value=BugConsistencyReport(
                    null_closed_at_rows=0,
                    null_updated_at_rows=0,
                    duplicate_pairs=0,
                    orphan_bug_issue_ids=[],
                    unknown_source_rows=0,
                ),
            ),
        ):
            report = run_bug_quality_checks(engine)

        assert report.passed is False

    def test_stale_rows_fails(self):
        engine = MagicMock()

        with (
            patch(
                "touch_index.quality.compute_bug_coverage",
                return_value=BugCoverageReport(
                    total_bug_issues=2,
                    indexed_bug_issues=2,
                    coverage_pct=100.0,
                    missing_issue_identifiers=[],
                    eligible_bug_issues=2,
                    eligible_coverage_pct=100.0,
                    missing_eligible_identifiers=[],
                ),
            ),
            patch(
                "touch_index.quality.compute_bug_freshness",
                return_value=BugFreshnessReport(
                    total_rows=5,
                    max_age_hours=800.0,
                    min_age_hours=2.0,
                    stale_rows=3,
                    stale_threshold_days=30,
                ),
            ),
            patch(
                "touch_index.quality.check_bug_consistency",
                return_value=BugConsistencyReport(
                    null_closed_at_rows=0,
                    null_updated_at_rows=0,
                    duplicate_pairs=0,
                    orphan_bug_issue_ids=[],
                    unknown_source_rows=0,
                ),
            ),
        ):
            report = run_bug_quality_checks(engine)

        assert report.passed is False

    def test_consistency_issues_fail(self):
        engine = MagicMock()

        with (
            patch(
                "touch_index.quality.compute_bug_coverage",
                return_value=BugCoverageReport(
                    total_bug_issues=2,
                    indexed_bug_issues=2,
                    coverage_pct=100.0,
                    missing_issue_identifiers=[],
                    eligible_bug_issues=2,
                    eligible_coverage_pct=100.0,
                    missing_eligible_identifiers=[],
                ),
            ),
            patch(
                "touch_index.quality.compute_bug_freshness",
                return_value=BugFreshnessReport(
                    total_rows=5,
                    max_age_hours=1.0,
                    min_age_hours=0.1,
                    stale_rows=0,
                    stale_threshold_days=30,
                ),
            ),
            patch(
                "touch_index.quality.check_bug_consistency",
                return_value=BugConsistencyReport(
                    null_closed_at_rows=3,
                    null_updated_at_rows=0,
                    duplicate_pairs=0,
                    orphan_bug_issue_ids=[],
                    unknown_source_rows=0,
                ),
            ),
        ):
            report = run_bug_quality_checks(engine)

        # null_closed_at rows are non-blocking (issue completedAt not set in Paperclip)
        assert report.passed is True

    def test_exception_in_coverage_still_runs_others(self):
        engine = MagicMock()

        with (
            patch(
                "touch_index.quality.compute_bug_coverage",
                side_effect=RuntimeError("API timeout"),
            ),
            patch(
                "touch_index.quality.compute_bug_freshness",
                return_value=BugFreshnessReport(
                    total_rows=5,
                    max_age_hours=1.0,
                    min_age_hours=0.1,
                    stale_rows=0,
                    stale_threshold_days=30,
                ),
            ),
            patch(
                "touch_index.quality.check_bug_consistency",
                return_value=BugConsistencyReport(
                    null_closed_at_rows=0,
                    null_updated_at_rows=0,
                    duplicate_pairs=0,
                    orphan_bug_issue_ids=[],
                    unknown_source_rows=0,
                ),
            ),
        ):
            report = run_bug_quality_checks(engine)

        assert report.passed is False
        assert report.coverage is None
        assert report.freshness is not None
        assert report.consistency is not None


# ---------------------------------------------------------------------------
# Added coverage tests for uncovered edge cases in quality.py
# ---------------------------------------------------------------------------


class TestCheckConsistencyExtended:
    """Additional edge-case tests for check_consistency."""

    def test_api_error_logged_and_continues(self, caplog):
        """When get_issue_by_id raises, the error is logged but iteration continues."""
        import logging

        engine = _make_engine(
            [
                _make_scalar_result(0),
                _make_scalar_result(0),
                _make_scalar_result(0),
                _make_scalar_result(0),
                _make_scalar_result(0, rows=[("id-1",), ("id-2",)]),
            ]
        )
        with (
            patch(
                "touch_index.paperclip_client.get_all_issue_ids",
                side_effect=RuntimeError("API timeout"),
            ),
            caplog.at_level(logging.WARNING),
        ):
            report = check_consistency(engine)
        assert len(report.orphan_fr_issue_ids) == 0
        assert any("Paperclip issue IDs" in r.message for r in caplog.records)

    def test_detects_null_updated_at(self):
        """Rows with NULL updated_at are counted."""
        engine = _make_engine(
            [
                _make_scalar_result(0),
                _make_scalar_result(2),
                _make_scalar_result(0),
                _make_scalar_result(0),
                _make_scalar_result(0, rows=[]),
            ]
        )
        with patch(
            "touch_index.paperclip_client.get_all_issue_ids",
            return_value=set(),
        ):
            report = check_consistency(engine)
        assert report.null_updated_at_rows == 2
        assert report.duplicate_pairs == 0

    def test_detects_duplicates_in_fr(self):
        """Duplicate (file_path, fr_issue_id) pairs are counted."""
        engine = _make_engine(
            [
                _make_scalar_result(0),
                _make_scalar_result(0),
                _make_scalar_result(0),
                _make_scalar_result(4),
                _make_scalar_result(0, rows=[]),
            ]
        )
        with patch(
            "touch_index.paperclip_client.get_all_issue_ids",
            return_value=set(),
        ):
            report = check_consistency(engine)
        assert report.duplicate_pairs == 4


class TestRunQualityChecksExtended:
    """Additional edge-case tests for run_quality_checks."""

    def test_exception_in_freshness_still_runs_others(self):
        """When compute_freshness raises, coverage and consistency still run."""
        engine = MagicMock()
        with (
            patch(
                "touch_index.quality.compute_coverage",
                return_value=_make_coverage(
                    total_fdr_issues=2, indexed_fdr_issues=2, coverage_pct=100.0
                ),
            ),
            patch(
                "touch_index.quality.compute_freshness",
                side_effect=RuntimeError("DB timeout"),
            ),
            patch(
                "touch_index.quality.check_consistency",
                return_value=_make_consistency(),
            ),
        ):
            report = run_quality_checks(engine)
        assert report.passed is False
        assert report.coverage is not None
        assert report.freshness is None
        assert report.consistency is not None

    def test_exception_in_consistency_still_runs_others(self):
        """When check_consistency raises, coverage and freshness still run."""
        engine = MagicMock()
        with (
            patch(
                "touch_index.quality.compute_coverage",
                return_value=_make_coverage(
                    total_fdr_issues=2, indexed_fdr_issues=2, coverage_pct=100.0
                ),
            ),
            patch(
                "touch_index.quality.compute_freshness",
                return_value=_make_freshness(total_rows=5, max_age_hours=2.0),
            ),
            patch(
                "touch_index.quality.check_consistency",
                side_effect=RuntimeError("Consistency error"),
            ),
        ):
            report = run_quality_checks(engine)
        assert report.passed is False
        assert report.coverage is not None
        assert report.freshness is not None
        assert report.consistency is None

    def test_consistency_null_updated_at_fails(self):
        """Null updated_at rows trigger consistency failure."""
        engine = MagicMock()
        with (
            patch(
                "touch_index.quality.compute_coverage",
                return_value=_make_coverage(
                    total_fdr_issues=2, indexed_fdr_issues=2, coverage_pct=100.0
                ),
            ),
            patch(
                "touch_index.quality.compute_freshness",
                return_value=_make_freshness(total_rows=5, max_age_hours=2.0),
            ),
            patch(
                "touch_index.quality.check_consistency",
                return_value=_make_consistency(null_updated_at_rows=3),
            ),
        ):
            report = run_quality_checks(engine)
        assert report.passed is False

    def test_consistency_duplicates_fails(self):
        """Duplicate pairs trigger consistency failure."""
        engine = MagicMock()
        with (
            patch(
                "touch_index.quality.compute_coverage",
                return_value=_make_coverage(
                    total_fdr_issues=2, indexed_fdr_issues=2, coverage_pct=100.0
                ),
            ),
            patch(
                "touch_index.quality.compute_freshness",
                return_value=_make_freshness(total_rows=5, max_age_hours=2.0),
            ),
            patch(
                "touch_index.quality.check_consistency",
                return_value=_make_consistency(duplicate_pairs=2),
            ),
        ):
            report = run_quality_checks(engine)
        assert report.passed is False

    def test_consistency_orphans_fails(self):
        """Orphan issue IDs trigger consistency failure."""
        engine = MagicMock()
        with (
            patch(
                "touch_index.quality.compute_coverage",
                return_value=_make_coverage(
                    total_fdr_issues=2, indexed_fdr_issues=2, coverage_pct=100.0
                ),
            ),
            patch(
                "touch_index.quality.compute_freshness",
                return_value=_make_freshness(total_rows=5, max_age_hours=2.0),
            ),
            patch(
                "touch_index.quality.check_consistency",
                return_value=_make_consistency(orphan_fr_issue_ids=["orphan-1"]),
            ),
        ):
            report = run_quality_checks(engine)
        assert report.passed is False


class TestCheckBugConsistencyExtended:
    """Additional edge-case tests for check_bug_consistency."""

    def test_api_error_logged_and_continues_bug(self, caplog):
        """When get_issue_by_id raises in bug check, the error is logged."""
        import logging

        engine = _make_engine(
            [
                _make_scalar_result(0),  # null_closed_at
                _make_scalar_result(0),  # null_updated_at
                _make_scalar_result(0),  # duplicates
                _make_scalar_result(0),  # unknown_source
                _make_scalar_result(0, rows=[("id-1",)]),  # DISTINCT bug_issue_ids
            ]
        )
        with (
            patch(
                "touch_index.paperclip_client.get_all_issue_ids",
                side_effect=RuntimeError("API timeout"),
            ),
            caplog.at_level(logging.WARNING),
        ):
            report = check_bug_consistency(engine)
        assert len(report.orphan_bug_issue_ids) == 0
        assert any("bug orphan check" in r.message for r in caplog.records)

    def test_detects_duplicates_in_bug(self):
        """Duplicate (file_path, bug_issue_id) pairs are counted."""
        engine = _make_engine(
            [
                _make_scalar_result(0),  # null_closed_at
                _make_scalar_result(0),  # null_updated_at
                _make_scalar_result(2),  # duplicates
                _make_scalar_result(0),  # unknown_source
                _make_scalar_result(0, rows=[]),  # DISTINCT bug_issue_ids
            ]
        )
        with patch(
            "touch_index.paperclip_client.get_all_issue_ids",
            return_value=set(),
        ):
            report = check_bug_consistency(engine)
        assert report.duplicate_pairs == 2


class TestRunBugQualityChecksExtended:
    """Additional edge-case tests for run_bug_quality_checks."""

    def test_exception_in_freshness_still_runs_others_bug(self):
        """When compute_bug_freshness raises, coverage and consistency still run."""
        engine = MagicMock()
        with (
            patch(
                "touch_index.quality.compute_bug_coverage",
                return_value=BugCoverageReport(
                    total_bug_issues=2,
                    indexed_bug_issues=2,
                    coverage_pct=100.0,
                    missing_issue_identifiers=[],
                ),
            ),
            patch(
                "touch_index.quality.compute_bug_freshness",
                side_effect=RuntimeError("DB timeout"),
            ),
            patch(
                "touch_index.quality.check_bug_consistency",
                return_value=BugConsistencyReport(
                    null_closed_at_rows=0,
                    null_updated_at_rows=0,
                    duplicate_pairs=0,
                    orphan_bug_issue_ids=[],
                    unknown_source_rows=0,
                ),
            ),
        ):
            report = run_bug_quality_checks(engine)
        assert report.passed is False
        assert report.coverage is not None
        assert report.freshness is None
        assert report.consistency is not None

    def test_exception_in_consistency_still_runs_others_bug(self):
        """When check_bug_consistency raises, coverage and freshness still run."""
        engine = MagicMock()
        with (
            patch(
                "touch_index.quality.compute_bug_coverage",
                return_value=BugCoverageReport(
                    total_bug_issues=2,
                    indexed_bug_issues=2,
                    coverage_pct=100.0,
                    missing_issue_identifiers=[],
                ),
            ),
            patch(
                "touch_index.quality.compute_bug_freshness",
                return_value=BugFreshnessReport(
                    total_rows=5,
                    max_age_hours=2.0,
                    min_age_hours=0.1,
                    stale_rows=0,
                    stale_threshold_days=30,
                ),
            ),
            patch(
                "touch_index.quality.check_bug_consistency",
                side_effect=RuntimeError("Consistency error"),
            ),
        ):
            report = run_bug_quality_checks(engine)
        assert report.passed is False
        assert report.coverage is not None
        assert report.freshness is not None
        assert report.consistency is None

    def test_consistency_duplicates_fails_bug(self):
        """Duplicate pairs trigger bug consistency failure."""
        engine = MagicMock()
        with (
            patch(
                "touch_index.quality.compute_bug_coverage",
                return_value=BugCoverageReport(
                    total_bug_issues=2,
                    indexed_bug_issues=2,
                    coverage_pct=100.0,
                    missing_issue_identifiers=[],
                ),
            ),
            patch(
                "touch_index.quality.compute_bug_freshness",
                return_value=BugFreshnessReport(
                    total_rows=5,
                    max_age_hours=2.0,
                    min_age_hours=0.1,
                    stale_rows=0,
                    stale_threshold_days=30,
                ),
            ),
            patch(
                "touch_index.quality.check_bug_consistency",
                return_value=BugConsistencyReport(
                    null_closed_at_rows=0,
                    null_updated_at_rows=0,
                    duplicate_pairs=3,
                    orphan_bug_issue_ids=[],
                    unknown_source_rows=0,
                ),
            ),
        ):
            report = run_bug_quality_checks(engine)
        assert report.passed is False

    def test_consistency_null_updated_at_fails_bug(self):
        """Null updated_at rows trigger bug consistency failure."""
        engine = MagicMock()
        with (
            patch(
                "touch_index.quality.compute_bug_coverage",
                return_value=BugCoverageReport(
                    total_bug_issues=2,
                    indexed_bug_issues=2,
                    coverage_pct=100.0,
                    missing_issue_identifiers=[],
                ),
            ),
            patch(
                "touch_index.quality.compute_bug_freshness",
                return_value=BugFreshnessReport(
                    total_rows=5,
                    max_age_hours=2.0,
                    min_age_hours=0.1,
                    stale_rows=0,
                    stale_threshold_days=30,
                ),
            ),
            patch(
                "touch_index.quality.check_bug_consistency",
                return_value=BugConsistencyReport(
                    null_closed_at_rows=0,
                    null_updated_at_rows=3,
                    duplicate_pairs=0,
                    orphan_bug_issue_ids=[],
                    unknown_source_rows=0,
                ),
            ),
        ):
            report = run_bug_quality_checks(engine)
        assert report.passed is False

    def test_consistency_orphans_fails_bug(self):
        """Orphan bug issue IDs trigger consistency failure."""
        engine = MagicMock()
        with (
            patch(
                "touch_index.quality.compute_bug_coverage",
                return_value=BugCoverageReport(
                    total_bug_issues=2,
                    indexed_bug_issues=2,
                    coverage_pct=100.0,
                    missing_issue_identifiers=[],
                ),
            ),
            patch(
                "touch_index.quality.compute_bug_freshness",
                return_value=BugFreshnessReport(
                    total_rows=5,
                    max_age_hours=2.0,
                    min_age_hours=0.1,
                    stale_rows=0,
                    stale_threshold_days=30,
                ),
            ),
            patch(
                "touch_index.quality.check_bug_consistency",
                return_value=BugConsistencyReport(
                    null_closed_at_rows=0,
                    null_updated_at_rows=0,
                    duplicate_pairs=0,
                    orphan_bug_issue_ids=["orphan-1"],
                    unknown_source_rows=0,
                ),
            ),
        ):
            report = run_bug_quality_checks(engine)
        assert report.passed is False


class TestReportToDict:
    """Coverage for report dataclass to_dict() methods."""

    def test_coverage_report_to_dict(self):
        r = CoverageReport(
            total_fdr_issues=5,
            indexed_fdr_issues=3,
            coverage_pct=60.0,
            missing_issue_identifiers=["BTCAAAAA-100"],
        )
        d = r.to_dict()
        assert d["total_fdr_issues"] == 5
        assert d["coverage_pct"] == 60.0

    def test_freshness_report_to_dict(self):
        r = FreshnessReport(
            total_rows=10,
            max_age_hours=24.0,
            min_age_hours=1.0,
            stale_rows=0,
            stale_threshold_hours=168,
        )
        d = r.to_dict()
        assert d["stale_threshold_hours"] == 168

    def test_consistency_report_to_dict(self):
        r = ConsistencyReport(
            null_owner_rows=2,
            null_updated_at_rows=0,
            duplicate_pairs=0,
            unknown_source_rows=0,
            orphan_fr_issue_ids=["orphan-1"],
        )
        d = r.to_dict()
        assert d["null_owner_rows"] == 2
        assert d["orphan_fr_issue_ids"] == ["orphan-1"]

    def test_quality_report_to_dict_all_none(self):
        r = QualityReport(coverage=None, freshness=None, consistency=None, passed=True)
        d = r.to_dict()
        assert d["passed"] is True
        assert "coverage" not in d
        assert "freshness" not in d
        assert "consistency" not in d

    def test_quality_report_to_dict_with_subset(self):
        cov = CoverageReport(
            total_fdr_issues=5,
            indexed_fdr_issues=3,
            coverage_pct=60.0,
            missing_issue_identifiers=[],
        )
        r = QualityReport(coverage=cov, freshness=None, consistency=None, passed=False)
        d = r.to_dict()
        assert d["passed"] is False
        assert d["coverage"]["total_fdr_issues"] == 5
        assert "freshness" not in d

    def test_bug_coverage_report_to_dict(self):
        r = BugCoverageReport(
            total_bug_issues=3,
            indexed_bug_issues=2,
            coverage_pct=66.7,
            missing_issue_identifiers=["BTCAAAAA-200"],
        )
        d = r.to_dict()
        assert d["total_bug_issues"] == 3
        assert d["coverage_pct"] == 66.7

    def test_bug_freshness_report_to_dict(self):
        r = BugFreshnessReport(
            total_rows=10,
            max_age_hours=48.0,
            min_age_hours=2.0,
            stale_rows=1,
            stale_threshold_days=30,
        )
        d = r.to_dict()
        assert d["stale_threshold_days"] == 30

    def test_bug_consistency_report_to_dict(self):
        r = BugConsistencyReport(
            null_closed_at_rows=0,
            null_updated_at_rows=0,
            duplicate_pairs=2,
            orphan_bug_issue_ids=[],
            unknown_source_rows=0,
        )
        d = r.to_dict()
        assert d["duplicate_pairs"] == 2

    def test_bug_quality_report_to_dict_all_none(self):
        r = BugQualityReport(
            coverage=None, freshness=None, consistency=None, passed=True
        )
        d = r.to_dict()
        assert d["passed"] is True
        assert "coverage" not in d

    def test_bug_quality_report_to_dict_with_subset(self):
        fresh = BugFreshnessReport(
            total_rows=5,
            max_age_hours=12.0,
            min_age_hours=1.0,
            stale_rows=0,
            stale_threshold_days=30,
        )
        r = BugQualityReport(
            coverage=None, freshness=fresh, consistency=None, passed=True
        )
        d = r.to_dict()
        assert d["freshness"]["total_rows"] == 5
        assert "coverage" not in d
        assert "consistency" not in d


class TestReportToDictExtended:
    """Cover remaining uncovered branches in QualityReport.to_dict and BugQualityReport.to_dict."""

    def test_quality_report_freshness_branch(self):
        fresh = FreshnessReport(
            total_rows=5,
            max_age_hours=12.0,
            min_age_hours=1.0,
            stale_rows=0,
            stale_threshold_hours=168,
        )
        r = QualityReport(coverage=None, freshness=fresh, consistency=None, passed=True)
        d = r.to_dict()
        assert d["freshness"]["total_rows"] == 5
        assert "coverage" not in d
        assert "consistency" not in d

    def test_quality_report_consistency_branch(self):
        cons = ConsistencyReport(
            null_owner_rows=0,
            null_updated_at_rows=0,
            duplicate_pairs=0,
            unknown_source_rows=0,
            orphan_fr_issue_ids=[],
        )
        r = QualityReport(coverage=None, freshness=None, consistency=cons, passed=True)
        d = r.to_dict()
        assert d["consistency"]["null_owner_rows"] == 0
        assert "coverage" not in d
        assert "freshness" not in d

    def test_quality_report_all_present(self):
        cov = CoverageReport(
            total_fdr_issues=2,
            indexed_fdr_issues=2,
            coverage_pct=100.0,
            missing_issue_identifiers=[],
        )
        fresh = FreshnessReport(
            total_rows=5,
            max_age_hours=12.0,
            min_age_hours=1.0,
            stale_rows=0,
            stale_threshold_hours=168,
        )
        cons = ConsistencyReport(
            null_owner_rows=0,
            null_updated_at_rows=0,
            duplicate_pairs=0,
            unknown_source_rows=0,
            orphan_fr_issue_ids=[],
        )
        r = QualityReport(coverage=cov, freshness=fresh, consistency=cons, passed=True)
        d = r.to_dict()
        assert d["coverage"]["coverage_pct"] == 100.0
        assert d["freshness"]["total_rows"] == 5
        assert d["consistency"]["null_owner_rows"] == 0

    def test_bug_quality_report_freshness_branch(self):
        fresh = BugFreshnessReport(
            total_rows=5,
            max_age_hours=12.0,
            min_age_hours=1.0,
            stale_rows=0,
            stale_threshold_days=30,
        )
        r = BugQualityReport(
            coverage=None, freshness=fresh, consistency=None, passed=True
        )
        d = r.to_dict()
        assert d["freshness"]["total_rows"] == 5
        assert "coverage" not in d
        assert "consistency" not in d

    def test_bug_quality_report_consistency_branch(self):
        cons = BugConsistencyReport(
            null_closed_at_rows=0,
            null_updated_at_rows=0,
            duplicate_pairs=0,
            orphan_bug_issue_ids=[],
            unknown_source_rows=0,
        )
        r = BugQualityReport(
            coverage=None, freshness=None, consistency=cons, passed=True
        )
        d = r.to_dict()
        assert d["consistency"]["null_closed_at_rows"] == 0
        assert "coverage" not in d
        assert "freshness" not in d


class TestBugQualityReportToDictExtended:
    """Cover remaining uncovered branch in BugQualityReport.to_dict coverage."""

    def test_bug_quality_report_coverage_branch(self):
        cov = BugCoverageReport(
            total_bug_issues=5,
            indexed_bug_issues=3,
            coverage_pct=60.0,
            missing_issue_identifiers=[],
        )
        r = BugQualityReport(
            coverage=cov, freshness=None, consistency=None, passed=True
        )
        d = r.to_dict()
        assert d["coverage"]["coverage_pct"] == 60.0
        assert "freshness" not in d
        assert "consistency" not in d
