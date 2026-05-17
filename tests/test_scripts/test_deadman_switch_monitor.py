"""Unit tests for scripts/deadman_switch_monitor.py — watchdog for the backup dead-man's-switch.

Tests cover gh run list parsing, age calculation, threshold decisions,
alert deduplication, and the run() orchestration function.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

REPO_ROOT = Path(__file__).parents[2]
sys.path.insert(0, str(REPO_ROOT / "src"))

pytestmark = [pytest.mark.bug("BTCAAAAA-25882"), pytest.mark.regression]


def _make_run(conclusion: str, age_minutes: float) -> dict:
    ts = (datetime.now(timezone.utc) - timedelta(minutes=age_minutes)).isoformat()
    return {
        "status": "completed",
        "conclusion": conclusion,
        "createdAt": ts,
        "databaseId": 12345,
        "headSha": "abc123",
    }


class TestGhRunList:
    def test_returns_parsed_runs(self, monkeypatch):
        from scripts.deadman_switch_monitor import _gh_run_list

        mock_out = json.dumps([_make_run("success", 5.0), _make_run("failure", 10.0)])
        monkeypatch.setattr(
            "subprocess.run",
            lambda *a, **kw: MagicMock(returncode=0, stdout=mock_out, stderr=""),
        )
        runs = _gh_run_list("backup-deadman-switch.yml")
        assert len(runs) == 2
        assert runs[0]["conclusion"] == "success"

    def test_returns_empty_on_cli_error(self, monkeypatch):
        from scripts.deadman_switch_monitor import _gh_run_list

        monkeypatch.setattr(
            "subprocess.run",
            lambda *a, **kw: MagicMock(returncode=1, stdout="", stderr="gh: not found"),
        )
        runs = _gh_run_list("backup-deadman-switch.yml")
        assert runs == []

    def test_returns_none_on_auth_error(self, monkeypatch):
        from scripts.deadman_switch_monitor import _gh_run_list

        monkeypatch.setattr(
            "subprocess.run",
            lambda *a, **kw: MagicMock(
                returncode=1, stdout="", stderr="To get started with GitHub CLI, please run:  gh auth login",
            ),
        )
        runs = _gh_run_list("backup-deadman-switch.yml")
        assert runs is None

    def test_returns_none_on_missing_token(self, monkeypatch):
        from scripts.deadman_switch_monitor import _gh_run_list

        monkeypatch.setattr(
            "subprocess.run",
            lambda *a, **kw: MagicMock(
                returncode=1, stdout="",
                stderr="no oauth token found",
            ),
        )
        runs = _gh_run_list("backup-deadman-switch.yml")
        assert runs is None

    def test_returns_empty_on_invalid_json(self, monkeypatch):
        from scripts.deadman_switch_monitor import _gh_run_list

        monkeypatch.setattr(
            "subprocess.run",
            lambda *a, **kw: MagicMock(returncode=0, stdout="not json", stderr=""),
        )
        runs = _gh_run_list("backup-deadman-switch.yml")
        assert runs == []


class TestGetLatestSuccessAge:
    def test_returns_age_for_successful_run(self):
        from scripts.deadman_switch_monitor import _get_latest_success_age_minutes

        runs = [
            _make_run("success", 8.0),
            _make_run("failure", 5.0),
            _make_run("success", 15.0),
        ]
        age = _get_latest_success_age_minutes(runs)
        assert age is not None
        assert 7.0 <= age <= 9.0

    def test_returns_none_when_no_successes(self):
        from scripts.deadman_switch_monitor import _get_latest_success_age_minutes

        runs = [
            _make_run("failure", 5.0),
            _make_run("cancelled", 10.0),
        ]
        assert _get_latest_success_age_minutes(runs) is None

    def test_returns_none_when_empty_list(self):
        from scripts.deadman_switch_monitor import _get_latest_success_age_minutes

        assert _get_latest_success_age_minutes([]) is None

    def test_ignores_runs_without_conclusion(self):
        from scripts.deadman_switch_monitor import _get_latest_success_age_minutes

        runs = [
            {"status": "in_progress", "createdAt": datetime.now(timezone.utc).isoformat()},
            _make_run("success", 2.0),
        ]
        age = _get_latest_success_age_minutes(runs)
        assert age is not None
        assert 1.5 <= age <= 2.5


class TestHasAnyRecentRuns:
    def test_returns_true_when_recent_run_exists(self):
        from scripts.deadman_switch_monitor import _has_any_recent_runs

        runs = [_make_run("failure", 10.0), _make_run("success", 60.0)]
        assert _has_any_recent_runs(runs, minutes=20) is True

    def test_returns_false_when_all_runs_are_old(self):
        from scripts.deadman_switch_monitor import _has_any_recent_runs

        runs = [_make_run("failure", 120.0), _make_run("success", 90.0)]
        assert _has_any_recent_runs(runs, minutes=30) is False

    def test_returns_false_for_empty_list(self):
        from scripts.deadman_switch_monitor import _has_any_recent_runs

        assert _has_any_recent_runs([], minutes=30) is False


class TestSelfState:
    def test_load_defaults_when_no_file(self, tmp_path, monkeypatch):
        from scripts.deadman_switch_monitor import _load_self_state

        sf = tmp_path / "state.json"
        monkeypatch.setattr("scripts.deadman_switch_monitor.MONITOR_STATE", sf)
        assert _load_self_state() == {}

    def test_loads_existing_state(self, tmp_path, monkeypatch):
        from scripts.deadman_switch_monitor import _load_self_state

        sf = tmp_path / "state.json"
        sf.write_text(json.dumps({"total_runs": 7}))
        monkeypatch.setattr("scripts.deadman_switch_monitor.MONITOR_STATE", sf)
        assert _load_self_state() == {"total_runs": 7}

    def test_save_and_reload(self, tmp_path, monkeypatch):
        from scripts.deadman_switch_monitor import _save_self_state, _load_self_state

        sf = tmp_path / "state.json"
        monkeypatch.setattr("scripts.deadman_switch_monitor.MONITOR_STATE", sf)
        _save_self_state({"total_runs": 3, "last_run_utc": "2026-05-01T00:00:00"})
        loaded = _load_self_state()
        assert loaded["total_runs"] == 3


class TestFindExistingAlert:
    def test_returns_none_when_no_matching_issues(self, monkeypatch):
        from scripts.deadman_switch_monitor import _find_existing_alert

        mock_sess = MagicMock()
        mock_resp = MagicMock()
        mock_resp.json.return_value = [{"title": "Other issue", "id": "abc"}]
        mock_sess.get.return_value = mock_resp
        monkeypatch.setattr("scripts.deadman_switch_monitor._session", lambda: mock_sess)
        monkeypatch.setattr("scripts.deadman_switch_monitor._base", lambda: "https://api.test")
        monkeypatch.setattr("scripts.deadman_switch_monitor._company", lambda: "test-co")
        assert _find_existing_alert() is None

    def test_returns_issue_when_title_matches(self, monkeypatch):
        from scripts.deadman_switch_monitor import _find_existing_alert

        existing = {"title": "Dead-man's-switch monitor alert — test", "id": "def"}
        mock_sess = MagicMock()
        mock_resp = MagicMock()
        mock_resp.json.return_value = [existing]
        mock_sess.get.return_value = mock_resp
        monkeypatch.setattr("scripts.deadman_switch_monitor._session", lambda: mock_sess)
        monkeypatch.setattr("scripts.deadman_switch_monitor._base", lambda: "https://api.test")
        monkeypatch.setattr("scripts.deadman_switch_monitor._company", lambda: "test-co")
        assert _find_existing_alert() == existing

    def test_returns_none_on_api_error(self, monkeypatch):
        from scripts.deadman_switch_monitor import _find_existing_alert

        mock_sess = MagicMock()
        mock_sess.get.side_effect = ConnectionError("network down")
        monkeypatch.setattr("scripts.deadman_switch_monitor._session", lambda: mock_sess)
        monkeypatch.setattr("scripts.deadman_switch_monitor._base", lambda: "https://api.test")
        monkeypatch.setattr("scripts.deadman_switch_monitor._company", lambda: "test-co")
        assert _find_existing_alert() is None


class TestCreateAlert:
    def _setup_mocks(self, monkeypatch, post_return=None):
        mock_sess = MagicMock()
        if post_return is not None:
            mock_resp = MagicMock()
            mock_resp.json.return_value = post_return
            mock_sess.post.return_value = mock_resp
        monkeypatch.setattr("scripts.deadman_switch_monitor._session", lambda: mock_sess)
        monkeypatch.setattr("scripts.deadman_switch_monitor._base", lambda: "https://api.test")
        monkeypatch.setattr("scripts.deadman_switch_monitor._company", lambda: "test-co")
        return mock_sess

    def test_dry_run_logs_and_returns_true(self, monkeypatch, capsys):
        from scripts.deadman_switch_monitor import _create_alert

        self._setup_mocks(monkeypatch)
        result = _create_alert(age_minutes=60.0, threshold_minutes=45, dry_run=True)
        assert result is True
        captured = capsys.readouterr().out
        assert "critical" in captured and "title" in captured

    def test_creates_alert_when_overdue(self, monkeypatch):
        from scripts.deadman_switch_monitor import _create_alert

        mock_sess = self._setup_mocks(
            monkeypatch, post_return={"identifier": "BTCAAAAA-999", "id": "uuid-99"}
        )
        result = _create_alert(age_minutes=60.0, threshold_minutes=45, dry_run=False)
        assert result is True
        assert mock_sess.post.call_count == 1
        payload = mock_sess.post.call_args[1]["json"]
        assert payload["priority"] == "critical"

    def test_creates_alert_when_no_runs_ever(self, monkeypatch):
        from scripts.deadman_switch_monitor import _create_alert

        mock_sess = self._setup_mocks(
            monkeypatch, post_return={"identifier": "BTCAAAAA-999", "id": "uuid-99"}
        )
        result = _create_alert(age_minutes=None, threshold_minutes=45, dry_run=False)
        assert result is True
        payload = mock_sess.post.call_args[1]["json"]
        assert "no successful runs" in payload["title"].lower()

    def test_returns_false_on_api_error(self, monkeypatch):
        from scripts.deadman_switch_monitor import _create_alert

        mock_sess = MagicMock()
        mock_sess.post.side_effect = ConnectionError("network down")
        monkeypatch.setattr("scripts.deadman_switch_monitor._session", lambda: mock_sess)
        monkeypatch.setattr("scripts.deadman_switch_monitor._base", lambda: "https://api.test")
        monkeypatch.setattr("scripts.deadman_switch_monitor._company", lambda: "test-co")
        assert _create_alert(60.0, 45, dry_run=False) is False

    def test_assigns_cto_agent(self, monkeypatch):
        from scripts.deadman_switch_monitor import _create_alert, CTO_AGENT_ID

        mock_sess = self._setup_mocks(
            monkeypatch, post_return={"identifier": "BTCAAAAA-999", "id": "uuid-99"}
        )
        _create_alert(60.0, 45, dry_run=False)
        payload = mock_sess.post.call_args[1]["json"]
        assert payload["assigneeAgentId"] == CTO_AGENT_ID


class TestRun:
    def _setup_env(self, monkeypatch):
        monkeypatch.setenv("PAPERCLIP_API_URL", "https://api.test")
        monkeypatch.setenv("PAPERCLIP_API_KEY", "test-key")
        monkeypatch.setenv("PAPERCLIP_COMPANY_ID", "test-co")

    def _patch_state_and_rotate(self, monkeypatch):
        sf = MagicMock()
        sf.exists.return_value = False
        monkeypatch.setattr("scripts.deadman_switch_monitor.MONITOR_STATE", sf)
        monkeypatch.setattr("scripts.deadman_switch_monitor._rotate_log_if_needed", MagicMock())
        monkeypatch.setattr("scripts.deadman_switch_monitor._save_self_state", MagicMock())
        monkeypatch.setattr("scripts.deadman_switch_monitor._load_self_state", lambda: {})

    def _mock_gh_runs(self, monkeypatch, runs):
        monkeypatch.setattr(
            "scripts.deadman_switch_monitor._gh_run_list",
            lambda *a, **kw: runs,
        )

    def test_workflow_healthy_returns_healthy(self, monkeypatch):
        from scripts.deadman_switch_monitor import run

        self._setup_env(monkeypatch)
        self._patch_state_and_rotate(monkeypatch)
        self._mock_gh_runs(monkeypatch, [
            _make_run("success", 10.0),
            _make_run("success", 40.0),
        ])
        result = run(threshold_minutes=45)
        assert result["status"] == "healthy"
        assert result["alert_fired"] is False

    def test_workflow_stalled_fires_alert(self, monkeypatch):
        from scripts.deadman_switch_monitor import run

        self._setup_env(monkeypatch)
        self._patch_state_and_rotate(monkeypatch)
        self._mock_gh_runs(monkeypatch, [
            _make_run("success", 90.0),
            _make_run("failure", 60.0),
        ])
        mock_sess = MagicMock()
        mock_resp = MagicMock()
        mock_resp.json.return_value = []
        mock_sess.get.return_value = mock_resp
        mock_post_resp = MagicMock()
        mock_post_resp.json.return_value = {"identifier": "BTCAAAAA-999", "id": "uuid-99"}
        mock_sess.post.return_value = mock_post_resp
        monkeypatch.setattr("scripts.deadman_switch_monitor._session", lambda: mock_sess)
        monkeypatch.setattr("scripts.deadman_switch_monitor._base", lambda: "https://api.test")
        monkeypatch.setattr("scripts.deadman_switch_monitor._company", lambda: "test-co")
        result = run(threshold_minutes=45)
        assert result["status"] == "alert"
        assert result["alert_fired"] is True
        assert mock_sess.post.call_count == 1

    def test_no_runs_at_all_fires_alert(self, monkeypatch):
        from scripts.deadman_switch_monitor import run

        self._setup_env(monkeypatch)
        self._patch_state_and_rotate(monkeypatch)
        self._mock_gh_runs(monkeypatch, [])
        mock_sess = MagicMock()
        mock_resp = MagicMock()
        mock_resp.json.return_value = []
        mock_sess.get.return_value = mock_resp
        mock_post_resp = MagicMock()
        mock_post_resp.json.return_value = {"identifier": "BTCAAAAA-999", "id": "uuid-99"}
        mock_sess.post.return_value = mock_post_resp
        monkeypatch.setattr("scripts.deadman_switch_monitor._session", lambda: mock_sess)
        monkeypatch.setattr("scripts.deadman_switch_monitor._base", lambda: "https://api.test")
        monkeypatch.setattr("scripts.deadman_switch_monitor._company", lambda: "test-co")
        result = run(threshold_minutes=45)
        assert result["status"] == "alert"
        assert result["alert_reason"] == "no_runs_found"
        assert mock_sess.post.call_count == 1

    def test_all_runs_failing_fires_alert(self, monkeypatch):
        from scripts.deadman_switch_monitor import run

        self._setup_env(monkeypatch)
        self._patch_state_and_rotate(monkeypatch)
        self._mock_gh_runs(monkeypatch, [
            _make_run("failure", 5.0),
            _make_run("failure", 15.0),
            _make_run("cancelled", 25.0),
        ])
        mock_sess = MagicMock()
        mock_resp = MagicMock()
        mock_resp.json.return_value = []
        mock_sess.get.return_value = mock_resp
        mock_post_resp = MagicMock()
        mock_post_resp.json.return_value = {"identifier": "BTCAAAAA-999", "id": "uuid-99"}
        mock_sess.post.return_value = mock_post_resp
        monkeypatch.setattr("scripts.deadman_switch_monitor._session", lambda: mock_sess)
        monkeypatch.setattr("scripts.deadman_switch_monitor._base", lambda: "https://api.test")
        monkeypatch.setattr("scripts.deadman_switch_monitor._company", lambda: "test-co")
        result = run(threshold_minutes=45)
        assert result["status"] == "alert"
        assert result["alert_reason"] == "all_runs_failing"
        assert mock_sess.post.call_count == 1

    def test_existing_alert_suppresses_duplicate(self, monkeypatch):
        from scripts.deadman_switch_monitor import run

        self._setup_env(monkeypatch)
        self._patch_state_and_rotate(monkeypatch)
        self._mock_gh_runs(monkeypatch, [
            _make_run("success", 90.0),
        ])
        mock_sess = MagicMock()
        mock_resp = MagicMock()
        mock_resp.json.return_value = [
            {"title": "Dead-man's-switch monitor alert — existing", "id": "exist-1"}
        ]
        mock_sess.get.return_value = mock_resp
        monkeypatch.setattr("scripts.deadman_switch_monitor._session", lambda: mock_sess)
        monkeypatch.setattr("scripts.deadman_switch_monitor._base", lambda: "https://api.test")
        monkeypatch.setattr("scripts.deadman_switch_monitor._company", lambda: "test-co")
        result = run(threshold_minutes=45)
        assert result["alert_skipped"] is True
        mock_sess.post.assert_not_called()

    def test_custom_threshold(self, monkeypatch):
        from scripts.deadman_switch_monitor import run

        self._setup_env(monkeypatch)
        self._patch_state_and_rotate(monkeypatch)
        self._mock_gh_runs(monkeypatch, [
            _make_run("success", 20.0),
        ])
        mock_sess = MagicMock()
        mock_resp = MagicMock()
        mock_resp.json.return_value = []
        mock_sess.get.return_value = mock_resp
        mock_post_resp = MagicMock()
        mock_post_resp.json.return_value = {"identifier": "BTCAAAAA-999", "id": "uuid-99"}
        mock_sess.post.return_value = mock_post_resp
        monkeypatch.setattr("scripts.deadman_switch_monitor._session", lambda: mock_sess)
        monkeypatch.setattr("scripts.deadman_switch_monitor._base", lambda: "https://api.test")
        monkeypatch.setattr("scripts.deadman_switch_monitor._company", lambda: "test-co")
        result = run(threshold_minutes=15)
        assert result["status"] == "alert"
        assert mock_sess.post.call_count == 1

    def test_auth_error_returns_auth_error_status(self, monkeypatch):
        from scripts.deadman_switch_monitor import run

        self._setup_env(monkeypatch)
        self._patch_state_and_rotate(monkeypatch)
        monkeypatch.setattr(
            "scripts.deadman_switch_monitor._gh_run_list",
            lambda *a, **kw: None,
        )
        result = run(threshold_minutes=45)
        assert result["status"] == "auth_error"
        assert result["alert_fired"] is False
        assert result["last_success_age_minutes"] is None
        assert result["total_runs_checked"] == 0

    def test_summary_includes_metadata(self, monkeypatch):
        from scripts.deadman_switch_monitor import run

        self._setup_env(monkeypatch)
        self._patch_state_and_rotate(monkeypatch)
        self._mock_gh_runs(monkeypatch, [
            _make_run("success", 10.0),
        ])
        result = run(threshold_minutes=45)
        assert result["deadman_interval_minutes"] == 30
        assert result["monitor_threshold_minutes"] == 45
        assert "self_total_runs" in result
        assert result["total_runs_checked"] == 1

    def test_returns_age_none_when_no_success(self, monkeypatch):
        from scripts.deadman_switch_monitor import run

        self._setup_env(monkeypatch)
        self._patch_state_and_rotate(monkeypatch)
        self._mock_gh_runs(monkeypatch, [
            _make_run("failure", 5.0),
            _make_run("failure", 15.0),
        ])
        mock_sess = MagicMock()
        mock_resp = MagicMock()
        mock_resp.json.return_value = []
        mock_sess.get.return_value = mock_resp
        mock_post_resp = MagicMock()
        mock_post_resp.json.return_value = {"identifier": "BTCAAAAA-999", "id": "uuid-99"}
        mock_sess.post.return_value = mock_post_resp
        monkeypatch.setattr("scripts.deadman_switch_monitor._session", lambda: mock_sess)
        monkeypatch.setattr("scripts.deadman_switch_monitor._base", lambda: "https://api.test")
        monkeypatch.setattr("scripts.deadman_switch_monitor._company", lambda: "test-co")
        result = run(threshold_minutes=45)
        assert result["last_success_age_minutes"] is None
        assert result["alert_reason"] == "all_runs_failing"
