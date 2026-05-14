"""Unit tests for scripts/deadman_switch_local_monitor.py — local backup monitor.

Tests cover state file parsing, age calculation, threshold decisions,
alert deduplication, and the run() orchestration function.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock

import pytest

REPO_ROOT = Path(__file__).parents[2]
sys.path.insert(0, str(REPO_ROOT / "src"))


def _make_deadman_state(age_minutes: float) -> dict:
    ts = datetime.now(timezone.utc) - timedelta(minutes=age_minutes)
    return {
        "total_runs": 42,
        "last_run_utc": ts.isoformat(),
        "last_alert_utc": None,
    }


class TestReadDeadmanState:
    def test_returns_none_when_file_missing(self, tmp_path, monkeypatch):
        from scripts.deadman_switch_local_monitor import _read_deadman_state

        sf = tmp_path / "state.json"
        monkeypatch.setattr("scripts.deadman_switch_local_monitor.DEADMAN_STATE", sf)
        assert _read_deadman_state() is None

    def test_returns_parsed_state(self, tmp_path, monkeypatch):
        from scripts.deadman_switch_local_monitor import _read_deadman_state

        sf = tmp_path / "state.json"
        data = {"total_runs": 5, "last_run_utc": "2026-05-01T00:00:00+00:00"}
        sf.write_text(json.dumps(data))
        monkeypatch.setattr("scripts.deadman_switch_local_monitor.DEADMAN_STATE", sf)
        result = _read_deadman_state()
        assert result == data

    def test_returns_none_on_corrupt_json(self, tmp_path, monkeypatch):
        from scripts.deadman_switch_local_monitor import _read_deadman_state

        sf = tmp_path / "state.json"
        sf.write_text("not json")
        monkeypatch.setattr("scripts.deadman_switch_local_monitor.DEADMAN_STATE", sf)
        assert _read_deadman_state() is None


class TestGetDeadmanAge:
    def test_returns_age_for_valid_timestamp(self):
        from scripts.deadman_switch_local_monitor import _get_deadman_age_minutes

        state = _make_deadman_state(10.0)
        age = _get_deadman_age_minutes(state)
        assert age is not None
        assert 9.0 <= age <= 11.0

    def test_returns_none_when_no_last_run_utc(self):
        from scripts.deadman_switch_local_monitor import _get_deadman_age_minutes

        assert _get_deadman_age_minutes({}) is None

    def test_returns_none_for_unparseable_ts(self):
        from scripts.deadman_switch_local_monitor import _get_deadman_age_minutes

        assert _get_deadman_age_minutes({"last_run_utc": "not a date"}) is None


class TestSelfState:
    def test_load_defaults_when_no_file(self, tmp_path, monkeypatch):
        from scripts.deadman_switch_local_monitor import _load_self_state

        sf = tmp_path / "monitor_state.json"
        monkeypatch.setattr("scripts.deadman_switch_local_monitor.MONITOR_STATE", sf)
        assert _load_self_state() == {}

    def test_loads_existing_state(self, tmp_path, monkeypatch):
        from scripts.deadman_switch_local_monitor import _load_self_state

        sf = tmp_path / "monitor_state.json"
        sf.write_text(json.dumps({"total_runs": 7}))
        monkeypatch.setattr("scripts.deadman_switch_local_monitor.MONITOR_STATE", sf)
        assert _load_self_state() == {"total_runs": 7}

    def test_save_and_reload(self, tmp_path, monkeypatch):
        from scripts.deadman_switch_local_monitor import _save_self_state, _load_self_state

        sf = tmp_path / "monitor_state.json"
        monkeypatch.setattr("scripts.deadman_switch_local_monitor.MONITOR_STATE", sf)
        _save_self_state({"total_runs": 3, "last_run_utc": "2026-05-01T00:00:00"})
        loaded = _load_self_state()
        assert loaded["total_runs"] == 3


class TestFindExistingAlert:
    def test_returns_none_when_no_matching_issues(self, monkeypatch):
        from scripts.deadman_switch_local_monitor import _find_existing_alert

        mock_sess = MagicMock()
        mock_resp = MagicMock()
        mock_resp.json.return_value = [{"title": "Other issue", "id": "abc"}]
        mock_sess.get.return_value = mock_resp
        monkeypatch.setattr("scripts.deadman_switch_local_monitor._session", lambda: mock_sess)
        monkeypatch.setattr("scripts.deadman_switch_local_monitor._base", lambda: "https://api.test")
        monkeypatch.setattr("scripts.deadman_switch_local_monitor._company", lambda: "test-co")
        assert _find_existing_alert() is None

    def test_returns_issue_when_title_matches(self, monkeypatch):
        from scripts.deadman_switch_local_monitor import _find_existing_alert

        existing = {"title": "Dead-man's-switch local monitor alert — test", "id": "def"}
        mock_sess = MagicMock()
        mock_resp = MagicMock()
        mock_resp.json.return_value = [existing]
        mock_sess.get.return_value = mock_resp
        monkeypatch.setattr("scripts.deadman_switch_local_monitor._session", lambda: mock_sess)
        monkeypatch.setattr("scripts.deadman_switch_local_monitor._base", lambda: "https://api.test")
        monkeypatch.setattr("scripts.deadman_switch_local_monitor._company", lambda: "test-co")
        assert _find_existing_alert() == existing

    def test_returns_none_on_api_error(self, monkeypatch):
        from scripts.deadman_switch_local_monitor import _find_existing_alert

        mock_sess = MagicMock()
        mock_sess.get.side_effect = ConnectionError("network down")
        monkeypatch.setattr("scripts.deadman_switch_local_monitor._session", lambda: mock_sess)
        monkeypatch.setattr("scripts.deadman_switch_local_monitor._base", lambda: "https://api.test")
        monkeypatch.setattr("scripts.deadman_switch_local_monitor._company", lambda: "test-co")
        assert _find_existing_alert() is None


class TestCreateAlert:
    def _setup_mocks(self, monkeypatch, post_return=None):
        mock_sess = MagicMock()
        if post_return is not None:
            mock_resp = MagicMock()
            mock_resp.json.return_value = post_return
            mock_sess.post.return_value = mock_resp
        monkeypatch.setattr("scripts.deadman_switch_local_monitor._session", lambda: mock_sess)
        monkeypatch.setattr("scripts.deadman_switch_local_monitor._base", lambda: "https://api.test")
        monkeypatch.setattr("scripts.deadman_switch_local_monitor._company", lambda: "test-co")
        return mock_sess

    def test_dry_run_logs_and_returns_true(self, monkeypatch, capsys):
        from scripts.deadman_switch_local_monitor import _create_alert

        self._setup_mocks(monkeypatch)
        result = _create_alert(age_minutes=60.0, threshold_minutes=45, dry_run=True)
        assert result is True
        captured = capsys.readouterr().out
        assert "critical" in captured and "title" in captured

    def test_creates_alert_when_overdue(self, monkeypatch):
        from scripts.deadman_switch_local_monitor import _create_alert

        mock_sess = self._setup_mocks(
            monkeypatch, post_return={"identifier": "BTCAAAAA-999", "id": "uuid-99"}
        )
        result = _create_alert(age_minutes=60.0, threshold_minutes=45, dry_run=False)
        assert result is True
        assert mock_sess.post.call_count == 1
        payload = mock_sess.post.call_args[1]["json"]
        assert payload["priority"] == "critical"

    def test_creates_alert_when_state_unavailable(self, monkeypatch):
        from scripts.deadman_switch_local_monitor import _create_alert

        mock_sess = self._setup_mocks(
            monkeypatch, post_return={"identifier": "BTCAAAAA-999", "id": "uuid-99"}
        )
        result = _create_alert(age_minutes=None, threshold_minutes=45, dry_run=False)
        assert result is True
        payload = mock_sess.post.call_args[1]["json"]
        assert "state file missing" in payload["title"].lower()

    def test_returns_false_on_api_error(self, monkeypatch):
        from scripts.deadman_switch_local_monitor import _create_alert

        mock_sess = MagicMock()
        mock_sess.post.side_effect = ConnectionError("network down")
        monkeypatch.setattr("scripts.deadman_switch_local_monitor._session", lambda: mock_sess)
        monkeypatch.setattr("scripts.deadman_switch_local_monitor._base", lambda: "https://api.test")
        monkeypatch.setattr("scripts.deadman_switch_local_monitor._company", lambda: "test-co")
        assert _create_alert(60.0, 45, dry_run=False) is False

    def test_assigns_cto_agent(self, monkeypatch):
        from scripts.deadman_switch_local_monitor import _create_alert, CTO_AGENT_ID

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
        monkeypatch.setattr("scripts.deadman_switch_local_monitor.MONITOR_STATE", sf)
        monkeypatch.setattr("scripts.deadman_switch_local_monitor._rotate_log_if_needed", MagicMock())
        monkeypatch.setattr("scripts.deadman_switch_local_monitor._save_self_state", MagicMock())
        monkeypatch.setattr("scripts.deadman_switch_local_monitor._load_self_state", lambda: {})

    def _mock_deadman_state(self, monkeypatch, state: dict | None):
        monkeypatch.setattr(
            "scripts.deadman_switch_local_monitor._read_deadman_state",
            lambda: state,
        )

    def test_workflow_healthy_returns_healthy(self, monkeypatch):
        from scripts.deadman_switch_local_monitor import run

        self._setup_env(monkeypatch)
        self._patch_state_and_rotate(monkeypatch)
        self._mock_deadman_state(monkeypatch, _make_deadman_state(10.0))
        result = run(threshold_minutes=45)
        assert result["status"] == "healthy"
        assert result["alert_fired"] is False
        assert result["monitor_type"] == "local"

    def test_workflow_stalled_fires_alert(self, monkeypatch):
        from scripts.deadman_switch_local_monitor import run

        self._setup_env(monkeypatch)
        self._patch_state_and_rotate(monkeypatch)
        self._mock_deadman_state(monkeypatch, _make_deadman_state(90.0))
        mock_sess = MagicMock()
        mock_resp = MagicMock()
        mock_resp.json.return_value = []
        mock_sess.get.return_value = mock_resp
        mock_post_resp = MagicMock()
        mock_post_resp.json.return_value = {"identifier": "BTCAAAAA-999", "id": "uuid-99"}
        mock_sess.post.return_value = mock_post_resp
        monkeypatch.setattr("scripts.deadman_switch_local_monitor._session", lambda: mock_sess)
        monkeypatch.setattr("scripts.deadman_switch_local_monitor._base", lambda: "https://api.test")
        monkeypatch.setattr("scripts.deadman_switch_local_monitor._company", lambda: "test-co")
        result = run(threshold_minutes=45)
        assert result["status"] == "alert"
        assert result["alert_fired"] is True
        assert result["alert_reason"] == "overdue"
        assert mock_sess.post.call_count == 1

    def test_state_unavailable_fires_alert(self, monkeypatch):
        from scripts.deadman_switch_local_monitor import run

        self._setup_env(monkeypatch)
        self._patch_state_and_rotate(monkeypatch)
        self._mock_deadman_state(monkeypatch, None)
        mock_sess = MagicMock()
        mock_resp = MagicMock()
        mock_resp.json.return_value = []
        mock_sess.get.return_value = mock_resp
        mock_post_resp = MagicMock()
        mock_post_resp.json.return_value = {"identifier": "BTCAAAAA-999", "id": "uuid-99"}
        mock_sess.post.return_value = mock_post_resp
        monkeypatch.setattr("scripts.deadman_switch_local_monitor._session", lambda: mock_sess)
        monkeypatch.setattr("scripts.deadman_switch_local_monitor._base", lambda: "https://api.test")
        monkeypatch.setattr("scripts.deadman_switch_local_monitor._company", lambda: "test-co")
        result = run(threshold_minutes=45)
        assert result["status"] == "alert"
        assert result["alert_reason"] == "state_unavailable"
        assert mock_sess.post.call_count == 1

    def test_existing_alert_suppresses_duplicate(self, monkeypatch):
        from scripts.deadman_switch_local_monitor import run

        self._setup_env(monkeypatch)
        self._patch_state_and_rotate(monkeypatch)
        self._mock_deadman_state(monkeypatch, _make_deadman_state(90.0))
        mock_sess = MagicMock()
        mock_resp = MagicMock()
        mock_resp.json.return_value = [
            {"title": "Dead-man's-switch local monitor alert — existing", "id": "exist-1"}
        ]
        mock_sess.get.return_value = mock_resp
        monkeypatch.setattr("scripts.deadman_switch_local_monitor._session", lambda: mock_sess)
        monkeypatch.setattr("scripts.deadman_switch_local_monitor._base", lambda: "https://api.test")
        monkeypatch.setattr("scripts.deadman_switch_local_monitor._company", lambda: "test-co")
        result = run(threshold_minutes=45)
        assert result["alert_skipped"] is True
        mock_sess.post.assert_not_called()

    def test_custom_threshold(self, monkeypatch):
        from scripts.deadman_switch_local_monitor import run

        self._setup_env(monkeypatch)
        self._patch_state_and_rotate(monkeypatch)
        self._mock_deadman_state(monkeypatch, _make_deadman_state(20.0))
        mock_sess = MagicMock()
        mock_resp = MagicMock()
        mock_resp.json.return_value = []
        mock_sess.get.return_value = mock_resp
        mock_post_resp = MagicMock()
        mock_post_resp.json.return_value = {"identifier": "BTCAAAAA-999", "id": "uuid-99"}
        mock_sess.post.return_value = mock_post_resp
        monkeypatch.setattr("scripts.deadman_switch_local_monitor._session", lambda: mock_sess)
        monkeypatch.setattr("scripts.deadman_switch_local_monitor._base", lambda: "https://api.test")
        monkeypatch.setattr("scripts.deadman_switch_local_monitor._company", lambda: "test-co")
        result = run(threshold_minutes=15)
        assert result["status"] == "alert"
        assert mock_sess.post.call_count == 1

    def test_summary_includes_metadata(self, monkeypatch):
        from scripts.deadman_switch_local_monitor import run

        self._setup_env(monkeypatch)
        self._patch_state_and_rotate(monkeypatch)
        self._mock_deadman_state(monkeypatch, _make_deadman_state(10.0))
        result = run(threshold_minutes=45)
        assert result["monitor_type"] == "local"
        assert result["deadman_interval_minutes"] == 30
        assert result["monitor_threshold_minutes"] == 45
        assert "self_total_runs" in result

    def test_summary_has_monitor_type_local(self, monkeypatch):
        from scripts.deadman_switch_local_monitor import run

        self._setup_env(monkeypatch)
        self._patch_state_and_rotate(monkeypatch)
        self._mock_deadman_state(monkeypatch, _make_deadman_state(10.0))
        result = run(threshold_minutes=45)
        assert result["monitor_type"] == "local"
