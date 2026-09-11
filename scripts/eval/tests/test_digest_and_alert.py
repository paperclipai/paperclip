"""Tests for digest_and_alert.py — SAG-4341.

Covers the three acceptance criteria:
  (a) all-rows-timed-out class → INCONCLUSIVE, NOT a regression
  (b) genuine quality drop with 0 errors → still emits a REGRESSION alert
  (c) mixed (8/20 errored) → quality computed over 12 clean rows + INCONCLUSIVE

Run with: python3 -m pytest scripts/eval/tests/test_digest_and_alert.py -v
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from digest_and_alert import (
    ERROR_RATE_INCONCLUSIVE_THRESHOLD,
    MIN_CLEAN_ROWS_FOR_REGRESSION,
    ClassMetrics,
    Alert,
    compute_class_metrics,
    detect_regressions,
    format_digest_table,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _timed_out_row(gold_class: str) -> dict:
    return {"gold_class": gold_class, "task_correct": 0, "error": "timed out", "wall_s": 0.0}


def _clean_row(gold_class: str, task_correct: int = 1) -> dict:
    return {"gold_class": gold_class, "task_correct": task_correct, "error": None, "wall_s": 45.0}


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

def test_inconclusive_threshold_is_25_percent():
    assert ERROR_RATE_INCONCLUSIVE_THRESHOLD == 0.25


# ---------------------------------------------------------------------------
# compute_class_metrics
# ---------------------------------------------------------------------------

class TestComputeClassMetrics:
    def test_all_clean_rows(self):
        rows = [_clean_row("bookkeeping")] * 10
        m = compute_class_metrics("bookkeeping", rows)
        assert m.gold_class == "bookkeeping"
        assert m.total == 10
        assert m.errors == 0
        assert m.clean == 10
        assert m.error_rate == 0.0
        assert m.task_correct_rate == 1.0
        assert m.inconclusive is False

    def test_all_timed_out(self):
        rows = [_timed_out_row("code_review")] * 5
        m = compute_class_metrics("code_review", rows)
        assert m.total == 5
        assert m.errors == 5
        assert m.clean == 0
        assert m.error_rate == 1.0
        assert m.task_correct_rate == 0.0
        assert m.inconclusive is True

    def test_task_correct_rate_computed_over_clean_rows_only(self):
        # 3 clean correct, 2 clean incorrect, 5 timed-out
        clean_correct = [_clean_row("code_review", task_correct=1)] * 3
        clean_wrong = [_clean_row("code_review", task_correct=0)] * 2
        errored = [_timed_out_row("code_review")] * 5
        rows = clean_correct + clean_wrong + errored

        m = compute_class_metrics("code_review", rows)
        assert m.total == 10
        assert m.errors == 5
        assert m.clean == 5
        # 3 correct out of 5 clean = 0.6 (NOT 3/10 = 0.3)
        assert abs(m.task_correct_rate - 0.6) < 1e-9

    def test_clean_rate_is_fraction_of_non_errored_rows(self):
        rows = [_clean_row("code_review")] * 7 + [_timed_out_row("code_review")] * 3
        m = compute_class_metrics("code_review", rows)
        assert abs(m.clean_rate - 0.7) < 1e-9

    def test_exactly_at_inconclusive_threshold(self):
        # 25% errored → exactly at threshold → INCONCLUSIVE
        rows = [_clean_row("bookkeeping")] * 3 + [_timed_out_row("bookkeeping")] * 1
        m = compute_class_metrics("bookkeeping", rows)
        assert abs(m.error_rate - 0.25) < 1e-9
        assert m.inconclusive is True

    def test_just_below_inconclusive_threshold(self):
        # 24% errored → below threshold → NOT inconclusive
        rows = [_clean_row("bookkeeping")] * 19 + [_timed_out_row("bookkeeping")] * 6
        # 6/25 = 24%
        # let's do 24 clean + 6 errored = wait: 6/(24+6)=6/30=20%...
        # Use exact: 24 rows total, error_rate = x. Want x < 0.25.
        # 3 clean + 1 errored = 25% (at threshold, treated as INCONCLUSIVE above)
        # 4 clean + 1 errored = 20% < 25% → NOT inconclusive
        rows = [_clean_row("bookkeeping")] * 4 + [_timed_out_row("bookkeeping")] * 1
        m = compute_class_metrics("bookkeeping", rows)
        assert m.error_rate == 0.2
        assert m.inconclusive is False

    def test_non_null_error_string_other_than_timed_out(self):
        rows = [
            {"gold_class": "code_review", "task_correct": 0, "error": "OOM", "wall_s": 0.0},
            _clean_row("code_review"),
        ]
        m = compute_class_metrics("code_review", rows)
        assert m.errors == 1
        assert m.clean == 1

    def test_empty_rows(self):
        m = compute_class_metrics("code_review", [])
        assert m.total == 0
        assert m.errors == 0
        assert m.error_rate == 0.0
        assert m.task_correct_rate == 0.0
        assert m.inconclusive is False


# ---------------------------------------------------------------------------
# AC (a): all-rows-timed-out class → INCONCLUSIVE, NOT a regression
# ---------------------------------------------------------------------------

class TestAcceptanceCriteriaA:
    """AC (a): all rows timed out → INCONCLUSIVE only, zero REGRESSION alerts."""

    def test_all_timed_out_emits_inconclusive_not_regression(self):
        rows = [_timed_out_row("code_review")] * 10
        m = compute_class_metrics("code_review", rows)
        assert m.inconclusive is True

        baseline = {"code_review": 0.80}
        alerts = detect_regressions([m], baseline)

        inconclusive = [a for a in alerts if a.kind == "INCONCLUSIVE"]
        regressions = [a for a in alerts if a.kind == "REGRESSION"]

        assert len(inconclusive) == 1
        assert inconclusive[0].gold_class == "code_review"
        assert len(regressions) == 0

    def test_inconclusive_alert_records_error_rate(self):
        rows = [_timed_out_row("code_review")] * 5
        m = compute_class_metrics("code_review", rows)
        alerts = detect_regressions([m], {"code_review": 0.80})
        assert len(alerts) == 1
        assert alerts[0].error_rate == 1.0
        assert alerts[0].kind == "INCONCLUSIVE"


# ---------------------------------------------------------------------------
# AC (b): genuine quality drop, zero errors → REGRESSION
# ---------------------------------------------------------------------------

class TestAcceptanceCriteriaB:
    """AC (b): genuine quality drop with 0 errors → REGRESSION alert emitted."""

    def test_clean_drop_below_baseline_emits_regression(self):
        # baseline 80%, current 25% — clear drop
        rows = (
            [_clean_row("bookkeeping", task_correct=1)] * 1
            + [_clean_row("bookkeeping", task_correct=0)] * 3
        )
        m = compute_class_metrics("bookkeeping", rows)
        assert m.error_rate == 0.0
        assert m.inconclusive is False
        assert m.task_correct_rate == 0.25

        baseline = {"bookkeeping": 0.80}
        alerts = detect_regressions([m], baseline)
        regressions = [a for a in alerts if a.kind == "REGRESSION"]

        assert len(regressions) == 1
        assert regressions[0].gold_class == "bookkeeping"
        assert regressions[0].delta < 0  # delta is negative (drop)

    def test_stable_quality_no_alert(self):
        rows = [_clean_row("bookkeeping", task_correct=1)] * 8 + [_clean_row("bookkeeping", task_correct=0)] * 2
        m = compute_class_metrics("bookkeeping", rows)
        # task_correct_rate = 0.8, baseline = 0.8 → no drop
        alerts = detect_regressions([m], {"bookkeeping": 0.80})
        regressions = [a for a in alerts if a.kind == "REGRESSION"]
        assert len(regressions) == 0


# ---------------------------------------------------------------------------
# AC (c): mixed errors (8/20) → quality over 12 clean + INCONCLUSIVE
# ---------------------------------------------------------------------------

class TestAcceptanceCriteriaC:
    """AC (c): 8/20 errored → quality from 12 clean rows + INCONCLUSIVE flag."""

    def test_mixed_errors_quality_from_clean_rows_flagged_inconclusive(self):
        clean = [_clean_row("code_review", task_correct=1)] * 12
        errored = [_timed_out_row("code_review")] * 8
        rows = clean + errored

        m = compute_class_metrics("code_review", rows)
        assert m.total == 20
        assert m.errors == 8
        assert m.clean == 12
        assert abs(m.error_rate - 0.40) < 1e-9
        # Quality computed over 12 clean rows (all correct → 1.0)
        assert m.task_correct_rate == 1.0
        # 40% > 25% threshold → INCONCLUSIVE
        assert m.inconclusive is True

        baseline = {"code_review": 0.60}
        alerts = detect_regressions([m], baseline)
        inconclusive = [a for a in alerts if a.kind == "INCONCLUSIVE"]
        regressions = [a for a in alerts if a.kind == "REGRESSION"]
        assert len(inconclusive) == 1
        assert len(regressions) == 0

    def test_mixed_below_threshold_does_regress(self):
        # 4/20 = 20% errored → NOT inconclusive; quality drop must still fire
        clean_correct = [_clean_row("code_review", task_correct=1)] * 3
        clean_wrong = [_clean_row("code_review", task_correct=0)] * 13
        errored = [_timed_out_row("code_review")] * 4
        rows = clean_correct + clean_wrong + errored

        m = compute_class_metrics("code_review", rows)
        assert m.total == 20
        assert m.errors == 4
        assert m.clean == 16
        assert m.error_rate == 0.20
        assert m.inconclusive is False
        assert abs(m.task_correct_rate - 3 / 16) < 1e-9

        baseline = {"code_review": 0.80}
        alerts = detect_regressions([m], baseline)
        regressions = [a for a in alerts if a.kind == "REGRESSION"]
        assert len(regressions) == 1


# ---------------------------------------------------------------------------
# detect_regressions — edge cases
# ---------------------------------------------------------------------------

class TestDetectRegressions:
    def test_no_baseline_for_class_skips_regression(self):
        rows = [_clean_row("new_class", task_correct=0)] * 5
        m = compute_class_metrics("new_class", rows)
        alerts = detect_regressions([m], baseline={})
        assert alerts == []

    def test_too_few_clean_rows_skips_regression(self):
        # Only 2 clean rows — below MIN_CLEAN_ROWS_FOR_REGRESSION (3)
        rows = [_clean_row("bookkeeping", task_correct=0)] * 2
        m = compute_class_metrics("bookkeeping", rows)
        assert m.clean == 2
        assert m.clean < MIN_CLEAN_ROWS_FOR_REGRESSION

        alerts = detect_regressions([m], {"bookkeeping": 1.0})
        # No regression because too few clean rows for a meaningful signal
        regressions = [a for a in alerts if a.kind == "REGRESSION"]
        assert len(regressions) == 0

    def test_multiple_classes_classified_independently(self):
        m_inconclusive = compute_class_metrics("code_review", [_timed_out_row("code_review")] * 10)
        m_regression = compute_class_metrics(
            "bookkeeping",
            [_clean_row("bookkeeping", task_correct=0)] * 10,
        )
        m_ok = compute_class_metrics(
            "financial_reporting",
            [_clean_row("financial_reporting", task_correct=1)] * 10,
        )

        baseline = {"code_review": 0.8, "bookkeeping": 0.9, "financial_reporting": 0.5}
        alerts = detect_regressions([m_inconclusive, m_regression, m_ok], baseline)

        kinds = {a.gold_class: a.kind for a in alerts}
        assert kinds["code_review"] == "INCONCLUSIVE"
        assert kinds["bookkeeping"] == "REGRESSION"
        assert "financial_reporting" not in kinds


# ---------------------------------------------------------------------------
# format_digest_table
# ---------------------------------------------------------------------------

class TestFormatDigestTable:
    def test_table_includes_errors_column(self):
        rows = [_clean_row("bookkeeping")] * 8 + [_timed_out_row("bookkeeping")] * 2
        m = compute_class_metrics("bookkeeping", rows)
        table = format_digest_table([m])
        assert "errors" in table.lower()

    def test_table_marks_inconclusive_class(self):
        rows = [_timed_out_row("code_review")] * 10
        m = compute_class_metrics("code_review", rows)
        table = format_digest_table([m])
        assert "INCONCLUSIVE" in table

    def test_table_does_not_mark_clean_class_inconclusive(self):
        rows = [_clean_row("bookkeeping")] * 10
        m = compute_class_metrics("bookkeeping", rows)
        table = format_digest_table([m])
        assert "INCONCLUSIVE" not in table
