"""Unit tests for scripts/snapshot_touch_index_quality.py.

All external I/O (DB engine, Paperclip API) is mocked so tests run offline.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).parents[2] / "scripts"))
sys.path.insert(0, str(Path(__file__).parents[2] / "src"))

import importlib

_runner_path = Path(__file__).parents[2] / "scripts" / "snapshot_touch_index_quality.py"
_spec = importlib.util.spec_from_file_location(
    "snapshot_touch_index_quality", _runner_path
)
_runner = importlib.util.module_from_spec(_spec)
sys.modules["snapshot_touch_index_quality"] = _runner
_spec.loader.exec_module(_runner)
_build_fr_report = _runner._build_fr_report
_build_bug_report = _runner._build_bug_report


def _make_fr_report():
    """Return a mock QualityReport-like object with passing data."""

    class MockReport:
        passed = True

        class coverage:
            coverage_pct = 95.2
            indexed_fdr_issues = 40
            total_fdr_issues = 42
            missing_issue_identifiers = []

        class freshness:
            total_rows = 150
            stale_rows = 0
            max_age_hours = 12.5

        class consistency:
            null_owner_rows = 0
            null_updated_at_rows = 0
            unknown_source_rows = 0
            duplicate_pairs = 0
            orphan_fr_issue_ids = []
            source_distribution = {}

    return MockReport()


def _make_bug_report():
    """Return a mock BugQualityReport-like object with passing data."""

    class MockReport:
        passed = True

        class coverage:
            coverage_pct = 13.9
            indexed_bug_issues = 324
            total_bug_issues = 2326
            eligible_coverage_pct = 74.0
            eligible_bug_issues = 438
            missing_eligible_identifiers = ["BTCAAAAA-999", "BTCAAAAA-1000"]
            missing_issue_identifiers = [
                "BTCAAAAA-1",
                "BTCAAAAA-2",
                "BTCAAAAA-999",
                "BTCAAAAA-1000",
            ]

        class freshness:
            total_rows = 938
            stale_rows = 0
            max_age_hours = 48.0

        class consistency:
            null_closed_at_rows = 0
            null_updated_at_rows = 0
            unknown_source_rows = 0
            duplicate_pairs = 0
            orphan_bug_issue_ids = []
            source_distribution = {}

    return MockReport()


def _run_main(
    capsys=None,
    fr_report=None,
    bug_report=None,
) -> tuple[int, str]:
    """Run main() with patched deps and return (exit_code, stdout)."""
    if fr_report is None:
        fr_report = _make_fr_report()
    if bug_report is None:
        bug_report = _make_bug_report()

    with (
        patch("snapshot_touch_index_quality.get_engine") as mock_get_engine,
        patch("snapshot_touch_index_quality.health_check", return_value=True),
        patch(
            "snapshot_touch_index_quality.run_quality_checks",
            return_value=fr_report,
        ),
        patch(
            "snapshot_touch_index_quality.run_bug_quality_checks",
            return_value=bug_report,
        ),
    ):
        mock_get_engine.return_value = MagicMock()
        from snapshot_touch_index_quality import main

        try:
            main()
            return 0, (capsys.readouterr().out if capsys else "")
        except SystemExit as e:
            return e.code or 0, (capsys.readouterr().out if capsys else "")


# ---------------------------------------------------------------------------
# _build_fr_report
# ---------------------------------------------------------------------------


class TestBuildFrReport:
    def test_full_report(self):
        report = _make_fr_report()
        d = _build_fr_report(report)
        assert d["pass"] is True
        assert d["coverage_pct"] == 95.2
        assert d["indexed"] == 40
        assert d["total"] == 42
        assert d["missing_issue_identifiers"] == []
        assert d["total_rows"] == 150
        assert d["stale_rows"] == 0
        assert d["max_age_hours"] == 12.5
        assert d["null_owner_rows"] == 0
        assert d["null_updated_at_rows"] == 0
        assert d["unknown_source_rows"] == 0
        assert d["duplicate_pairs"] == 0
        assert d["orphan_count"] == 0

    def test_report_with_freshness_none(self):
        class MockReport:
            passed = False

            class coverage:
                coverage_pct = 95.0
                indexed_fdr_issues = 38
                total_fdr_issues = 40
                missing_issue_identifiers = []

            freshness = None
            consistency = None

        d = _build_fr_report(MockReport())
        assert d["pass"] is False
        assert d["coverage_pct"] == 95.0
        assert "total_rows" not in d

    def test_none_report(self):
        d = _build_fr_report(None)
        assert d["pass"] is False
        assert "error" in d

    def test_none_coverage(self):
        class MockReport:
            passed = False
            coverage = None

        d = _build_fr_report(MockReport())
        assert d["pass"] is False
        assert "error" in d

    def test_orphans_counted(self):
        class MockReport:
            passed = False

            class coverage:
                coverage_pct = 100.0
                indexed_fdr_issues = 5
                total_fdr_issues = 5
                missing_issue_identifiers = []

            class freshness:
                total_rows = 20
                stale_rows = 0
                max_age_hours = 1.0

            class consistency:
                null_owner_rows = 0
                null_updated_at_rows = 0
                unknown_source_rows = 0
                duplicate_pairs = 0
                orphan_fr_issue_ids = ["orphan-1", "orphan-2"]
                source_distribution = {}

        d = _build_fr_report(MockReport())
        assert d["orphan_count"] == 2
        assert d["pass"] is False

    def test_missing_issue_identifiers_populated(self):
        class MockReport:
            passed = False

            class coverage:
                coverage_pct = 88.0
                indexed_fdr_issues = 35
                total_fdr_issues = 40
                missing_issue_identifiers = ["BTCAAAAA-900", "BTCAAAAA-901"]

            class freshness:
                total_rows = 120
                stale_rows = 2
                max_age_hours = 200.0

            class consistency:
                null_owner_rows = 0
                null_updated_at_rows = 0
                unknown_source_rows = 0
                duplicate_pairs = 0
                orphan_fr_issue_ids = []
                source_distribution = {}

        d = _build_fr_report(MockReport())
        assert d["missing_issue_identifiers"] == ["BTCAAAAA-900", "BTCAAAAA-901"]
        assert d["pass"] is False


# ---------------------------------------------------------------------------
# _build_bug_report
# ---------------------------------------------------------------------------


class TestBuildBugReport:
    def test_full_report(self):
        report = _make_bug_report()
        d = _build_bug_report(report)
        assert d["pass"] is True
        assert d["coverage_pct"] == 13.9
        assert d["indexed"] == 324
        assert d["total"] == 2326
        assert d["coverage_eligible_pct"] == 74.0
        assert d["eligible_total"] == 438
        assert d["missing_eligible_count"] == 2
        assert d["missing_eligible_identifiers"] == ["BTCAAAAA-999", "BTCAAAAA-1000"]
        assert d["missing_total_count"] == 4
        assert d["total_rows"] == 938
        assert d["stale_rows"] == 0
        assert "source_distribution" in d

    def test_none_report(self):
        d = _build_bug_report(None)
        assert d["pass"] is False
        assert "error" in d

    def test_none_coverage(self):
        class MockReport:
            passed = False
            coverage = None

        d = _build_bug_report(MockReport())
        assert d["pass"] is False
        assert "error" in d

    def test_orphans_counted(self):
        class MockReport:
            passed = False

            class coverage:
                coverage_pct = 50.0
                indexed_bug_issues = 5
                total_bug_issues = 10
                eligible_coverage_pct = 100.0
                eligible_bug_issues = 5
                missing_eligible_identifiers = []
                missing_issue_identifiers = []

            class freshness:
                total_rows = 20
                stale_rows = 2
                max_age_hours = 200.0

            class consistency:
                null_closed_at_rows = 0
                null_updated_at_rows = 0
                unknown_source_rows = 0
                duplicate_pairs = 0
                orphan_bug_issue_ids = ["orphan-x"]
                source_distribution = {}

        d = _build_bug_report(MockReport())
        assert d["orphan_count"] == 1
        assert d["pass"] is False

    def test_stale_rows_tracked(self):
        class MockReport:
            passed = False

            class coverage:
                coverage_pct = 100.0
                indexed_bug_issues = 10
                total_bug_issues = 10
                eligible_coverage_pct = 100.0
                eligible_bug_issues = 10
                missing_eligible_identifiers = []
                missing_issue_identifiers = []

            class freshness:
                total_rows = 50
                stale_rows = 5
                max_age_hours = 720.0

            class consistency:
                null_closed_at_rows = 0
                null_updated_at_rows = 0
                unknown_source_rows = 0
                duplicate_pairs = 0
                orphan_bug_issue_ids = []
                source_distribution = {}

        d = _build_bug_report(MockReport())
        assert d["stale_rows"] == 5
        assert d["pass"] is False


# ---------------------------------------------------------------------------
# main() — CLI entry point
# ---------------------------------------------------------------------------


class TestMain:
    def test_stdout_emits_json(self, monkeypatch, capsys):
        """--stdout emits JSON to stdout without writing a file."""
        monkeypatch.setattr(
            sys, "argv", ["snapshot_touch_index_quality.py", "--stdout"]
        )
        code, out = _run_main(capsys)
        assert code == 0
        data = json.loads(out.strip())
        assert "timestamp" in data
        assert "touch_index_fr" in data
        assert "touch_index_bug" in data
        assert data["touch_index_fr"]["pass"] is True
        assert data["touch_index_bug"]["pass"] is True

    def test_stdout_fr_failure(self, monkeypatch, capsys):
        """--stdout with failing FR check still emits full JSON and exits 1."""
        monkeypatch.setattr(
            sys, "argv", ["snapshot_touch_index_quality.py", "--stdout"]
        )
        fr_report = _make_fr_report()
        fr_report.passed = False
        code, out = _run_main(capsys, fr_report=fr_report)
        assert code == 1
        data = json.loads(out.strip())
        assert data["touch_index_fr"]["pass"] is False
        assert data["touch_index_bug"]["pass"] is True

    def test_health_check_failure_exits(self, monkeypatch):
        """When health_check returns False, SystemExit is raised."""
        monkeypatch.setattr(sys, "argv", ["snapshot_touch_index_quality.py"])
        with (
            patch("snapshot_touch_index_quality.get_engine"),
            patch("snapshot_touch_index_quality.health_check", return_value=False),
        ):
            from snapshot_touch_index_quality import main

            with pytest.raises(SystemExit) as exc:
                main()
        assert exc.value.code == 1

    def test_custom_stale_hours_passed(self, monkeypatch):
        """--stale-hours argument is passed to run_quality_checks."""
        monkeypatch.setattr(
            sys,
            "argv",
            ["snapshot_touch_index_quality.py", "--stdout", "--stale-hours", "336"],
        )
        with (
            patch("snapshot_touch_index_quality.get_engine") as mock_get_engine,
            patch("snapshot_touch_index_quality.health_check", return_value=True),
            patch(
                "snapshot_touch_index_quality.run_quality_checks",
            ) as mock_fr,
            patch(
                "snapshot_touch_index_quality.run_bug_quality_checks",
                return_value=_make_bug_report(),
            ),
        ):
            mock_get_engine.return_value = MagicMock()
            from snapshot_touch_index_quality import main

            with pytest.raises(SystemExit):
                main()
        mock_fr.assert_called_once()
        _, kwargs = mock_fr.call_args
        assert kwargs.get("stale_threshold_hours") == 336

    def test_custom_stale_days_passed(self, monkeypatch):
        """--stale-days argument is passed to run_bug_quality_checks."""
        monkeypatch.setattr(
            sys,
            "argv",
            ["snapshot_touch_index_quality.py", "--stdout", "--stale-days", "60"],
        )
        with (
            patch("snapshot_touch_index_quality.get_engine") as mock_get_engine,
            patch("snapshot_touch_index_quality.health_check", return_value=True),
            patch(
                "snapshot_touch_index_quality.run_quality_checks",
                return_value=_make_fr_report(),
            ),
            patch(
                "snapshot_touch_index_quality.run_bug_quality_checks",
            ) as mock_bug,
        ):
            mock_get_engine.return_value = MagicMock()
            from snapshot_touch_index_quality import main

            with pytest.raises(SystemExit):
                main()
        mock_bug.assert_called_once()
        _, kwargs = mock_bug.call_args
        assert kwargs.get("stale_threshold_days") == 60

    def test_default_stale_hours(self, monkeypatch):
        """Default stale-hours should be 168."""
        monkeypatch.setattr(
            sys, "argv", ["snapshot_touch_index_quality.py", "--stdout"]
        )
        with (
            patch("snapshot_touch_index_quality.get_engine") as mock_get_engine,
            patch("snapshot_touch_index_quality.health_check", return_value=True),
            patch(
                "snapshot_touch_index_quality.run_quality_checks",
            ) as mock_fr,
            patch(
                "snapshot_touch_index_quality.run_bug_quality_checks",
                return_value=_make_bug_report(),
            ),
        ):
            mock_get_engine.return_value = MagicMock()
            from snapshot_touch_index_quality import main

            with pytest.raises(SystemExit):
                main()
        mock_fr.assert_called_once()
        _, kwargs = mock_fr.call_args
        assert kwargs.get("stale_threshold_hours") == 168

    def test_default_stale_days(self, monkeypatch):
        """Default stale-days should be 30."""
        monkeypatch.setattr(
            sys, "argv", ["snapshot_touch_index_quality.py", "--stdout"]
        )
        with (
            patch("snapshot_touch_index_quality.get_engine") as mock_get_engine,
            patch("snapshot_touch_index_quality.health_check", return_value=True),
            patch(
                "snapshot_touch_index_quality.run_quality_checks",
                return_value=_make_fr_report(),
            ),
            patch(
                "snapshot_touch_index_quality.run_bug_quality_checks",
            ) as mock_bug,
        ):
            mock_get_engine.return_value = MagicMock()
            from snapshot_touch_index_quality import main

            with pytest.raises(SystemExit):
                main()
        mock_bug.assert_called_once()
        _, kwargs = mock_bug.call_args
        assert kwargs.get("stale_threshold_days") == 30

    def test_overall_pass_exit_code_zero(self, monkeypatch):
        """When both FR and Bug pass, exit code is 0."""
        monkeypatch.setattr(
            sys, "argv", ["snapshot_touch_index_quality.py", "--stdout"]
        )
        code, _ = _run_main(fr_report=_make_fr_report(), bug_report=_make_bug_report())
        assert code == 0

    def test_overall_fail_exit_code_one(self, monkeypatch):
        """When FR fails, exit code is 1."""
        monkeypatch.setattr(
            sys, "argv", ["snapshot_touch_index_quality.py", "--stdout"]
        )
        fr_report = _make_fr_report()
        fr_report.passed = False
        code, _ = _run_main(fr_report=fr_report)
        assert code == 1

    def test_bug_failure_exit_code_one(self, monkeypatch):
        """When Bug fails, exit code is 1."""
        monkeypatch.setattr(
            sys, "argv", ["snapshot_touch_index_quality.py", "--stdout"]
        )
        bug_report = _make_bug_report()
        bug_report.passed = False
        code, _ = _run_main(bug_report=bug_report)
        assert code == 1

    def test_both_failure_exit_code_one(self, monkeypatch):
        """When both FR and Bug fail, exit code is 1."""
        monkeypatch.setattr(
            sys, "argv", ["snapshot_touch_index_quality.py", "--stdout"]
        )
        fr_report = _make_fr_report()
        fr_report.passed = False
        bug_report = _make_bug_report()
        bug_report.passed = False
        code, _ = _run_main(fr_report=fr_report, bug_report=bug_report)
        assert code == 1
