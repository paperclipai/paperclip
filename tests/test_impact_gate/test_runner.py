"""Unit tests for scripts/run_impact_gate_worker.py main() entry point."""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).parents[2] / "scripts"))
sys.path.insert(0, str(Path(__file__).parents[2] / "src"))

import importlib

_runner_path = Path(__file__).parents[2] / "scripts" / "run_impact_gate_worker.py"
_spec = importlib.util.spec_from_file_location("run_impact_gate_worker", _runner_path)
_runner = importlib.util.module_from_spec(_spec)
sys.modules["run_impact_gate_worker"] = _runner
_spec.loader.exec_module(_runner)
main = _runner.main
_fetch_fn = _runner._fetch_in_review_fix_issues

_CLEAN_ARGV = ["run_impact_gate_worker.py"]


class TestFetchInReviewFixIssues:
    def test_filters_fix_issues(self, monkeypatch):
        monkeypatch.setattr(
            _runner,
            "_fetch_in_review_issues",
            lambda: [
                {
                    "id": "u1",
                    "title": "Fix the thing",
                    "labels": [{"name": "fix"}],
                    "status": "in_review",
                },
                {
                    "id": "u2",
                    "title": "New feature",
                    "labels": [{"name": "feature"}],
                    "status": "in_review",
                },
            ],
        )
        result = _fetch_fn()
        assert len(result) == 1
        assert result[0]["id"] == "u1"

    def test_detects_bug_in_title(self, monkeypatch):
        monkeypatch.setattr(
            _runner,
            "_fetch_in_review_issues",
            lambda: [
                {
                    "id": "u1",
                    "title": "Bug: crash on startup",
                    "labels": [],
                    "status": "in_review",
                },
            ],
        )
        result = _fetch_fn()
        assert len(result) == 1

    def test_detects_regression_in_title(self, monkeypatch):
        monkeypatch.setattr(
            _runner,
            "_fetch_in_review_issues",
            lambda: [
                {
                    "id": "u1",
                    "title": "Regression in optimizer",
                    "labels": [],
                    "status": "in_review",
                },
            ],
        )
        result = _fetch_fn()
        assert len(result) == 1

    def test_returns_empty_for_no_matches(self, monkeypatch):
        monkeypatch.setattr(
            _runner,
            "_fetch_in_review_issues",
            lambda: [
                {
                    "id": "u1",
                    "title": "Feature request",
                    "labels": [{"name": "enhancement"}],
                    "status": "in_review",
                },
            ],
        )
        result = _fetch_fn()
        assert len(result) == 0

    def test_handles_empty_results(self, monkeypatch):
        monkeypatch.setattr(
            _runner, "_fetch_in_review_issues", lambda: []
        )
        result = _fetch_fn()
        assert result == []

    def test_substring_fix_in_title_is_not_false_positive(self, monkeypatch):
        monkeypatch.setattr(
            _runner,
            "_fetch_in_review_issues",
            lambda: [
                {
                    "id": "u1",
                    "title": "Impact Gate: scan for fix issues done",
                    "labels": [],
                    "status": "in_review",
                },
                {
                    "id": "u2",
                    "title": "Prefix bug in the title",
                    "labels": [],
                    "status": "in_review",
                },
            ],
        )
        result = _fetch_fn()
        assert result == []


class TestRunnerMain:
    def test_default_calls_process_issue_on_all(self, monkeypatch):
        monkeypatch.setattr(sys, "argv", _CLEAN_ARGV)
        monkeypatch.setattr(
            _runner, "_fetch_in_review_fix_issues", lambda: [{"id": "u1"}]
        )
        called = []
        monkeypatch.setattr(
            _runner,
            "process_issue",
            lambda iid, dry_run=False, old_status=None: (
                called.append(iid) or {"gate_status": "PASS"}
            ),
        )
        main()
        assert called == ["u1"]

    def test_dry_run_flag_passed(self, monkeypatch):
        monkeypatch.setattr(sys, "argv", [_CLEAN_ARGV[0], "--dry-run"])
        monkeypatch.setattr(
            _runner, "_fetch_in_review_fix_issues", lambda: [{"id": "u1"}]
        )
        calls = []
        monkeypatch.setattr(
            _runner,
            "process_issue",
            lambda iid, dry_run=False, old_status=None: (
                calls.append((iid, dry_run)) or {"gate_status": "PASS"}
            ),
        )
        main()
        assert calls == [("u1", True)]

    def test_single_issue_mode(self, monkeypatch):
        monkeypatch.setattr(
            sys, "argv", [_CLEAN_ARGV[0], "--issue-id", "specific-uuid"]
        )
        called = []
        monkeypatch.setattr(
            _runner,
            "process_issue",
            lambda iid, dry_run=False, old_status=None: (
                called.append(iid) or {"gate_status": "PASS"}
            ),
        )
        main()
        assert called == ["specific-uuid"]

    def test_empty_issues_no_error(self, monkeypatch):
        monkeypatch.setattr(sys, "argv", _CLEAN_ARGV)
        monkeypatch.setattr(_runner, "_fetch_in_review_fix_issues", lambda: [])
        main()

    def test_exception_handling(self, monkeypatch):
        monkeypatch.setattr(sys, "argv", _CLEAN_ARGV)
        monkeypatch.setattr(
            _runner, "_fetch_in_review_fix_issues", lambda: [{"id": "u1"}, {"id": "u2"}]
        )
        call_count = 0

        def mock_process(iid, dry_run=False, old_status=None):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise RuntimeError("First failed")
            return {"gate_status": "PASS"}

        monkeypatch.setattr(_runner, "process_issue", mock_process)
        main()
        assert call_count == 2
