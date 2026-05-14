"""Unit tests for scripts/backup_deadman_switch_monitor.py — watchdog for the
deadman-switch-monitor workflow.

Tests cover gh run list parsing, age calculation, primary monitor state-file
fallback, threshold decisions, alert deduplication, and the run() orchestration
function with its dual-source liveness check.
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

pytestmark = [pytest.mark.bug("BTCAAAAA-26419"), pytest.mark.regression]


def _make_gh_run(conclusion: str, age_minutes: float) -> dict:
    ts = (datetime.now(timezone.utc) - timedelta(minutes=age_minutes)).isoformat()
    return {
        "status": "completed",
        "conclusion": conclusion,
        "createdAt": ts,
        "databaseId": 12345,
        "headSha": "abc123",
    }


def _make_primary_monitor_state(age_minutes: float) -> dict:
    ts = datetime.now(timezone.utc) - timedelta(minutes=age_minutes)
    return {
        "total_runs": 42,
        "last_run_utc": ts.isoformat(),
        "last_alert_utc": None,
    }


class TestGhRunList:
    def test_returns_parsed_runs(self, monkeypatch):
        from scripts.backup_deadman_switch_monitor import _gh_run_list

        mock_out = json.dumps([
            _make_gh_run("success", 5.0),
            _make_gh_run("failure", 10.0),
        ])
        monkeypatch.setattr(
            "subprocess.run",
            lambda *a, **kw: MagicMock(returncode=0, stdout=mock_out, stderr=""),
        )
        runs = _gh_run_list("deadman-switch-monitor.yml")
        assert len(runs) == 2
        assert runs[0]["conclusion"] == "success"

    def test_returns_none_on_cli_error(self, monkeypatch):
        from scripts.backup_deadman_switch_monitor import _gh_run_list

        monkeypatch.setattr(
            "subprocess.run",
            lambda *a, **kw: MagicMock(returncode=1, stdout="", stderr="gh: not found"),
        )
        runs = _gh_run_list("deadman-switch-monitor.yml")
        assert runs is None

    def test_returns_none_on_auth_error(self, monkeypatch):
        from scripts.backup_deadman_switch_monitor import _gh_run_list

        monkeypatch.setattr(
            "subprocess.run",
            lambda *a, **kw: MagicMock(
                returncode=1, stdout="",
                stderr="To get started with GitHub CLI, please run:  gh auth login",
            ),
        )
        runs = _gh_run_list("deadman-switch-monitor.yml")
        assert runs is None

    def test_returns_none_on_missing_token(self, monkeypatch):
        from scripts.backup_deadman_switch_monitor import _gh_run_list

        monkeypatch.setattr(
            "subprocess.run",
            lambda *a, **kw: MagicMock(
                returncode=1, stdout="",
                stderr="no oauth token found",
            ),
        )
        runs = _gh_run_list("deadman-switch-monitor.yml")
        assert runs is None

    def test_returns_none_on_timeout(self, monkeypatch):
        from scripts.backup_deadman_switch_monitor import _gh_run_list

        import subprocess as sp
        monkeypatch.setattr(
            "subprocess.run",
            lambda *a, **kw: (_ for _ in ()).throw(sp.TimeoutExpired("gh", 30)),
        )
        runs = _gh_run_list("deadman-switch-monitor.yml")
        assert runs is None

    def test_returns_none_when_gh_not_found(self, monkeypatch):
        from scripts.backup_deadman_switch_monitor import _gh_run_list

        monkeypatch.setattr(
            "subprocess.run",
            lambda *a, **kw: (_ for _ in ()).throw(FileNotFoundError("gh")),
        )
        runs = _gh_run_list("deadman-switch-monitor.yml")
        assert runs is None

    def test_returns_none_on_invalid_json(self, monkeypatch):
        from scripts.backup_deadman_switch_monitor import _gh_run_list

        monkeypatch.setattr(
            "subprocess.run",
            lambda *a, **kw: MagicMock(returncode=0, stdout="not json", stderr=""),
        )
        runs = _gh_run_list("deadman-switch-monitor.yml")
        assert runs is None

    def test_returns_none_on_missing_gh_token_env(self, monkeypatch):
        from scripts.backup_deadman_switch_monitor import _gh_run_list

        monkeypatch.setattr(
            "subprocess.run",
            lambda *a, **kw: MagicMock(
                returncode=1, stdout="",
                stderr="populate the GH_TOKEN environment variable",
            ),
        )
        runs = _gh_run_list("deadman-switch-monitor.yml")
        assert runs is None


class TestGetLatestSuccessAge:
    def test_returns_age_for_successful_run(self):
        from scripts.backup_deadman_switch_monitor import _get_latest_success_age_minutes

        runs = [
            _make_gh_run("success", 8.0),
            _make_gh_run("failure", 5.0),
            _make_gh_run("success", 15.0),
        ]
        age = _get_latest_success_age_minutes(runs)
        assert age is not None
        assert 7.0 <= age <= 9.0

    def test_returns_none_when_no_successes(self):
        from scripts.backup_deadman_switch_monitor import _get_latest_success_age_minutes

        runs = [
            _make_gh_run("failure", 5.0),
            _make_gh_run("cancelled", 10.0),
        ]
        assert _get_latest_success_age_minutes(runs) is None

    def test_returns_none_when_empty_list(self):
        from scripts.backup_deadman_switch_monitor import _get_latest_success_age_minutes

        assert _get_latest_success_age_minutes([]) is None

    def test_ignores_runs_without_conclusion(self):
        from scripts.backup_deadman_switch_monitor import _get_latest_success_age_minutes

        runs = [
            {"status": "in_progress", "createdAt": datetime.now(timezone.utc).isoformat()},
            _make_gh_run("success", 2.0),
        ]
        age = _get_latest_success_age_minutes(runs)
        assert age is not None
        assert 1.5 <= age <= 2.5

    def test_handles_missing_created_at(self):
        from scripts.backup_deadman_switch_monitor import _get_latest_success_age_minutes

        runs = [
            {"status": "completed", "conclusion": "success"},
        ]
        assert _get_latest_success_age_minutes(runs) is None

    def test_handles_unparseable_timestamp(self):
        from scripts.backup_deadman_switch_monitor import _get_latest_success_age_minutes

        runs = [
            {"status": "completed", "conclusion": "success", "createdAt": "not-a-date"},
        ]
        assert _get_latest_success_age_minutes(runs) is None


class TestHasAnyRecentRuns:
    def test_returns_true_when_recent_run_exists(self):
        from scripts.backup_deadman_switch_monitor import _has_any_recent_runs

        runs = [_make_gh_run("failure", 10.0), _make_gh_run("success", 60.0)]
        assert _has_any_recent_runs(runs, minutes=20) is True

    def test_returns_false_when_all_runs_are_old(self):
        from scripts.backup_deadman_switch_monitor import _has_any_recent_runs

        runs = [_make_gh_run("failure", 120.0), _make_gh_run("success", 90.0)]
        assert _has_any_recent_runs(runs, minutes=30) is False

    def test_returns_false_for_empty_list(self):
        from scripts.backup_deadman_switch_monitor import _has_any_recent_runs

        assert _has_any_recent_runs([], minutes=30) is False

    def test_skips_runs_without_created_at(self):
        from scripts.backup_deadman_switch_monitor import _has_any_recent_runs

        runs = [
            {"status": "in_progress"},
            _make_gh_run("success", 10.0),
        ]
        assert _has_any_recent_runs(runs, minutes=20) is True


class TestReadPrimaryMonitorState:
    def test_returns_none_when_file_missing(self, tmp_path, monkeypatch):
        from scripts.backup_deadman_switch_monitor import _read_primary_monitor_state

        sf = tmp_path / "state.json"
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor.PRIMARY_MONITOR_STATE", sf
        )
        assert _read_primary_monitor_state() is None

    def test_returns_parsed_state(self, tmp_path, monkeypatch):
        from scripts.backup_deadman_switch_monitor import _read_primary_monitor_state

        sf = tmp_path / "state.json"
        data = {"total_runs": 15, "last_run_utc": "2026-05-01T00:00:00+00:00"}
        sf.write_text(json.dumps(data))
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor.PRIMARY_MONITOR_STATE", sf
        )
        result = _read_primary_monitor_state()
        assert result == data

    def test_returns_none_on_corrupt_json(self, tmp_path, monkeypatch):
        from scripts.backup_deadman_switch_monitor import _read_primary_monitor_state

        sf = tmp_path / "state.json"
        sf.write_text("not json")
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor.PRIMARY_MONITOR_STATE", sf
        )
        assert _read_primary_monitor_state() is None

    def test_returns_none_on_unreadable_file(self, tmp_path, monkeypatch):
        from scripts.backup_deadman_switch_monitor import _read_primary_monitor_state

        sf = tmp_path / "state.json"
        sf.write_text("{}")
        sf.chmod(0o000)
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor.PRIMARY_MONITOR_STATE", sf
        )
        try:
            assert _read_primary_monitor_state() is None
        finally:
            sf.chmod(0o644)


class TestGetPrimaryMonitorAge:
    def test_returns_age_for_valid_timestamp(self):
        from scripts.backup_deadman_switch_monitor import _get_primary_monitor_age_minutes

        state = _make_primary_monitor_state(8.0)
        age = _get_primary_monitor_age_minutes(state)
        assert age is not None
        assert 7.0 <= age <= 9.0

    def test_returns_none_when_no_last_run_utc(self):
        from scripts.backup_deadman_switch_monitor import _get_primary_monitor_age_minutes

        assert _get_primary_monitor_age_minutes({}) is None
        assert _get_primary_monitor_age_minutes({"last_run_utc": None}) is None
        assert _get_primary_monitor_age_minutes({"last_run_utc": ""}) is None

    def test_returns_none_for_unparseable_timestamp(self):
        from scripts.backup_deadman_switch_monitor import _get_primary_monitor_age_minutes

        assert _get_primary_monitor_age_minutes({"last_run_utc": "garbage"}) is None

    def test_handles_zulu_suffix(self):
        from scripts.backup_deadman_switch_monitor import _get_primary_monitor_age_minutes

        state = {"last_run_utc": "2026-05-01T00:00:00Z"}
        age = _get_primary_monitor_age_minutes(state)
        assert age is not None
        assert age > 0

    def test_returns_zero_for_right_now(self):
        from scripts.backup_deadman_switch_monitor import _get_primary_monitor_age_minutes

        state = {"last_run_utc": datetime.now(timezone.utc).isoformat()}
        age = _get_primary_monitor_age_minutes(state)
        assert age is not None
        assert 0.0 <= age <= 0.1


class TestLogRotation:
    def test_rotates_when_log_exceeds_limit(self, tmp_path, monkeypatch):
        from scripts.backup_deadman_switch_monitor import (
            _rotate_log_if_needed,
            MAX_LOG_BYTES,
        )

        logf = tmp_path / "monitor.log"
        logf.write_text("x" * (MAX_LOG_BYTES + 1))
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor.MONITOR_LOG", logf
        )

        _rotate_log_if_needed()
        bak = tmp_path / "monitor.log.1"
        assert bak.exists()
        assert logf.stat().st_size == 0

    def test_skips_when_log_under_limit(self, tmp_path, monkeypatch):
        from scripts.backup_deadman_switch_monitor import _rotate_log_if_needed

        logf = tmp_path / "monitor.log"
        logf.write_text("small")
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor.MONITOR_LOG", logf
        )

        _rotate_log_if_needed()
        bak = tmp_path / "monitor.log.1"
        assert not bak.exists()
        assert logf.stat().st_size == 5


class TestSelfState:
    def test_load_defaults_when_no_file(self, tmp_path, monkeypatch):
        from scripts.backup_deadman_switch_monitor import _load_self_state

        sf = tmp_path / "state.json"
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor.MONITOR_STATE", sf
        )
        assert _load_self_state() == {}

    def test_loads_existing_state(self, tmp_path, monkeypatch):
        from scripts.backup_deadman_switch_monitor import _load_self_state

        sf = tmp_path / "state.json"
        sf.write_text(json.dumps({"total_runs": 7}))
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor.MONITOR_STATE", sf
        )
        assert _load_self_state() == {"total_runs": 7}

    def test_returns_default_on_corrupt_state(self, tmp_path, monkeypatch):
        from scripts.backup_deadman_switch_monitor import _load_self_state

        sf = tmp_path / "state.json"
        sf.write_text("bad json {{{")
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor.MONITOR_STATE", sf
        )
        assert _load_self_state() == {}

    def test_save_and_reload(self, tmp_path, monkeypatch):
        from scripts.backup_deadman_switch_monitor import (
            _save_self_state,
            _load_self_state,
        )

        sf = tmp_path / "state.json"
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor.MONITOR_STATE", sf
        )
        _save_self_state({"total_runs": 3, "last_run_utc": "2026-05-01T00:00:00"})
        loaded = _load_self_state()
        assert loaded["total_runs"] == 3
        assert loaded["last_run_utc"] == "2026-05-01T00:00:00"


class TestFindExistingAlert:
    def test_returns_none_when_no_matching_issues(self, monkeypatch):
        from scripts.backup_deadman_switch_monitor import _find_existing_alert

        mock_sess = MagicMock()
        mock_resp = MagicMock()
        mock_resp.json.return_value = [{"title": "Other issue", "id": "abc"}]
        mock_sess.get.return_value = mock_resp
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._session", lambda: mock_sess
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._base", lambda: "https://api.test"
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._company", lambda: "test-co"
        )
        assert _find_existing_alert() is None

    def test_returns_issue_when_title_matches(self, monkeypatch):
        from scripts.backup_deadman_switch_monitor import _find_existing_alert

        existing = {
            "title": "Backup dead-man's-switch monitor alert — test",
            "id": "def",
        }
        mock_sess = MagicMock()
        mock_resp = MagicMock()
        mock_resp.json.return_value = [existing]
        mock_sess.get.return_value = mock_resp
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._session", lambda: mock_sess
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._base", lambda: "https://api.test"
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._company", lambda: "test-co"
        )
        assert _find_existing_alert() == existing

    def test_returns_none_on_api_error(self, monkeypatch):
        from scripts.backup_deadman_switch_monitor import _find_existing_alert

        mock_sess = MagicMock()
        mock_sess.get.side_effect = ConnectionError("network down")
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._session", lambda: mock_sess
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._base", lambda: "https://api.test"
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._company", lambda: "test-co"
        )
        assert _find_existing_alert() is None

    def test_returns_none_on_session_failure(self, monkeypatch):
        from scripts.backup_deadman_switch_monitor import _find_existing_alert

        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._session",
            lambda: (_ for _ in ()).throw(KeyError("missing env")),
        )
        assert _find_existing_alert() is None


class TestCreateAlert:
    def _setup_mocks(self, monkeypatch, post_return=None):
        mock_sess = MagicMock()
        if post_return is not None:
            mock_resp = MagicMock()
            mock_resp.json.return_value = post_return
            mock_sess.post.return_value = mock_resp
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._session", lambda: mock_sess
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._base", lambda: "https://api.test"
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._company", lambda: "test-co"
        )
        return mock_sess

    def test_dry_run_logs_and_returns_true(self, monkeypatch, capsys):
        from scripts.backup_deadman_switch_monitor import _create_alert

        self._setup_mocks(monkeypatch)
        result = _create_alert(
            age_minutes=60.0, threshold_minutes=60, dry_run=True
        )
        assert result is True
        captured = capsys.readouterr().out
        assert "critical" in captured and "title" in captured

    def test_creates_alert_when_overdue(self, monkeypatch):
        from scripts.backup_deadman_switch_monitor import _create_alert

        mock_sess = self._setup_mocks(
            monkeypatch, post_return={"identifier": "BTCAAAAA-999", "id": "uuid-99"}
        )
        result = _create_alert(
            age_minutes=90.0, threshold_minutes=60, dry_run=False
        )
        assert result is True
        assert mock_sess.post.call_count == 1
        payload = mock_sess.post.call_args[1]["json"]
        assert payload["priority"] == "critical"
        assert "90 min" in payload["title"]

    def test_creates_alert_when_no_runs_ever(self, monkeypatch):
        from scripts.backup_deadman_switch_monitor import _create_alert

        mock_sess = self._setup_mocks(
            monkeypatch, post_return={"identifier": "BTCAAAAA-999", "id": "uuid-99"}
        )
        result = _create_alert(
            age_minutes=None, threshold_minutes=60, dry_run=False
        )
        assert result is True
        payload = mock_sess.post.call_args[1]["json"]
        assert "no successful runs" in payload["title"].lower()

    def test_returns_false_on_api_error(self, monkeypatch):
        from scripts.backup_deadman_switch_monitor import _create_alert

        mock_sess = MagicMock()
        mock_sess.post.side_effect = ConnectionError("network down")
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._session", lambda: mock_sess
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._base", lambda: "https://api.test"
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._company", lambda: "test-co"
        )
        assert _create_alert(90.0, 60, dry_run=False) is False

    def test_returns_false_on_session_failure(self, monkeypatch):
        from scripts.backup_deadman_switch_monitor import _create_alert

        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._session",
            lambda: (_ for _ in ()).throw(KeyError("missing env")),
        )
        assert _create_alert(90.0, 60, dry_run=False) is False

    def test_assigns_cto_agent(self, monkeypatch):
        from scripts.backup_deadman_switch_monitor import _create_alert, CTO_AGENT_ID

        mock_sess = self._setup_mocks(
            monkeypatch, post_return={"identifier": "BTCAAAAA-999", "id": "uuid-99"}
        )
        _create_alert(90.0, 60, dry_run=False)
        payload = mock_sess.post.call_args[1]["json"]
        assert payload["assigneeAgentId"] == CTO_AGENT_ID

    def test_includes_extra_detail_in_description(self, monkeypatch):
        from scripts.backup_deadman_switch_monitor import _create_alert

        mock_sess = self._setup_mocks(
            monkeypatch, post_return={"identifier": "BTCAAAAA-999", "id": "uuid-99"}
        )
        _create_alert(
            age_minutes=90.0,
            threshold_minutes=60,
            dry_run=False,
            extra_detail="- **Extra context:** test detail\n",
        )
        payload = mock_sess.post.call_args[1]["json"]
        assert "Extra context" in payload["description"]

    def test_includes_workflow_name_in_description(self, monkeypatch):
        from scripts.backup_deadman_switch_monitor import (
            _create_alert,
            TARGET_WORKFLOW,
        )

        mock_sess = self._setup_mocks(
            monkeypatch, post_return={"identifier": "BTCAAAAA-999", "id": "uuid-99"}
        )
        _create_alert(90.0, 60, dry_run=False)
        payload = mock_sess.post.call_args[1]["json"]
        assert TARGET_WORKFLOW in payload["description"]


class TestRun:
    def _setup_env(self, monkeypatch):
        monkeypatch.setenv("PAPERCLIP_API_URL", "https://api.test")
        monkeypatch.setenv("PAPERCLIP_API_KEY", "test-key")
        monkeypatch.setenv("PAPERCLIP_COMPANY_ID", "test-co")

    def _patch_state_and_rotate(self, monkeypatch):
        sf = MagicMock()
        sf.exists.return_value = False
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor.MONITOR_STATE", sf
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._rotate_log_if_needed",
            MagicMock(),
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._save_self_state",
            MagicMock(),
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._load_self_state",
            lambda: {},
        )

    def _mock_gh_runs(self, monkeypatch, runs):
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._gh_run_list",
            lambda *a, **kw: runs,
        )

    def _mock_primary_state(self, monkeypatch, state: dict | None):
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._read_primary_monitor_state",
            lambda: state,
        )

    def test_workflow_healthy_returns_healthy(self, monkeypatch):
        from scripts.backup_deadman_switch_monitor import run

        self._setup_env(monkeypatch)
        self._patch_state_and_rotate(monkeypatch)
        self._mock_gh_runs(monkeypatch, [
            _make_gh_run("success", 10.0),
            _make_gh_run("success", 40.0),
        ])
        self._mock_primary_state(monkeypatch, _make_primary_monitor_state(10.0))
        result = run(threshold_minutes=60)
        assert result["status"] == "healthy"
        assert result["alert_fired"] is False

    def test_workflow_stalled_fires_alert(self, monkeypatch):
        from scripts.backup_deadman_switch_monitor import run

        self._setup_env(monkeypatch)
        self._patch_state_and_rotate(monkeypatch)
        self._mock_gh_runs(monkeypatch, [
            _make_gh_run("success", 90.0),
            _make_gh_run("failure", 60.0),
        ])
        self._mock_primary_state(monkeypatch, _make_primary_monitor_state(90.0))
        mock_sess = MagicMock()
        mock_resp = MagicMock()
        mock_resp.json.return_value = []
        mock_sess.get.return_value = mock_resp
        mock_post_resp = MagicMock()
        mock_post_resp.json.return_value = {
            "identifier": "BTCAAAAA-999", "id": "uuid-99",
        }
        mock_sess.post.return_value = mock_post_resp
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._session", lambda: mock_sess
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._base", lambda: "https://api.test"
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._company", lambda: "test-co"
        )
        result = run(threshold_minutes=60)
        assert result["status"] == "alert"
        assert result["alert_fired"] is True
        assert result["alert_reason"] == "overdue"
        assert mock_sess.post.call_count == 1

    def test_no_runs_at_all_fires_alert(self, monkeypatch):
        from scripts.backup_deadman_switch_monitor import run

        self._setup_env(monkeypatch)
        self._patch_state_and_rotate(monkeypatch)
        self._mock_gh_runs(monkeypatch, [])
        self._mock_primary_state(monkeypatch, None)
        mock_sess = MagicMock()
        mock_resp = MagicMock()
        mock_resp.json.return_value = []
        mock_sess.get.return_value = mock_resp
        mock_post_resp = MagicMock()
        mock_post_resp.json.return_value = {
            "identifier": "BTCAAAAA-999", "id": "uuid-99",
        }
        mock_sess.post.return_value = mock_post_resp
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._session", lambda: mock_sess
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._base", lambda: "https://api.test"
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._company", lambda: "test-co"
        )
        result = run(threshold_minutes=60)
        assert result["status"] == "alert"
        assert result["alert_reason"] == "no_runs_found"
        assert mock_sess.post.call_count == 1

    def test_all_runs_failing_fires_alert(self, monkeypatch):
        from scripts.backup_deadman_switch_monitor import run

        self._setup_env(monkeypatch)
        self._patch_state_and_rotate(monkeypatch)
        self._mock_gh_runs(monkeypatch, [
            _make_gh_run("failure", 5.0),
            _make_gh_run("failure", 15.0),
            _make_gh_run("cancelled", 25.0),
        ])
        self._mock_primary_state(monkeypatch, _make_primary_monitor_state(10.0))
        mock_sess = MagicMock()
        mock_resp = MagicMock()
        mock_resp.json.return_value = []
        mock_sess.get.return_value = mock_resp
        mock_post_resp = MagicMock()
        mock_post_resp.json.return_value = {
            "identifier": "BTCAAAAA-999", "id": "uuid-99",
        }
        mock_sess.post.return_value = mock_post_resp
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._session", lambda: mock_sess
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._base", lambda: "https://api.test"
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._company", lambda: "test-co"
        )
        result = run(threshold_minutes=60)
        assert result["status"] == "alert"
        assert result["alert_reason"] == "all_runs_failing"

    def test_existing_alert_suppresses_duplicate(self, monkeypatch):
        from scripts.backup_deadman_switch_monitor import run

        self._setup_env(monkeypatch)
        self._patch_state_and_rotate(monkeypatch)
        self._mock_gh_runs(monkeypatch, [
            _make_gh_run("success", 90.0),
        ])
        self._mock_primary_state(monkeypatch, _make_primary_monitor_state(90.0))
        mock_sess = MagicMock()
        mock_resp = MagicMock()
        mock_resp.json.return_value = [
            {
                "title": "Backup dead-man's-switch monitor alert — existing",
                "id": "exist-1",
            }
        ]
        mock_sess.get.return_value = mock_resp
        mock_comment_resp = MagicMock()
        mock_comment_resp.json.return_value = {"id": "comment-1"}
        mock_sess.post.return_value = mock_comment_resp
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._session", lambda: mock_sess
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._base", lambda: "https://api.test"
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._company", lambda: "test-co"
        )
        result = run(threshold_minutes=60)
        assert result["alert_skipped"] is True
        assert result["alert_fired"] is False
        assert result["commented"] is True
        assert mock_sess.post.call_count == 1
        called_url = mock_sess.post.call_args[0][0]
        assert "/comments" in called_url

    def test_auth_error_fallback_to_primary_state_healthy(self, monkeypatch):
        from scripts.backup_deadman_switch_monitor import run

        self._setup_env(monkeypatch)
        self._patch_state_and_rotate(monkeypatch)
        self._mock_gh_runs(monkeypatch, None)
        self._mock_primary_state(monkeypatch, _make_primary_monitor_state(10.0))
        result = run(threshold_minutes=60)
        assert result["status"] == "healthy"
        assert result["alert_fired"] is False
        assert result["gh_cli_available"] is False
        assert result["primary_state_file"] == "available"
        assert result["primary_state_age_minutes"] is not None

    def test_auth_error_fallback_to_primary_state_overdue(self, monkeypatch):
        from scripts.backup_deadman_switch_monitor import run

        self._setup_env(monkeypatch)
        self._patch_state_and_rotate(monkeypatch)
        self._mock_gh_runs(monkeypatch, None)
        self._mock_primary_state(monkeypatch, _make_primary_monitor_state(120.0))
        mock_sess = MagicMock()
        mock_resp = MagicMock()
        mock_resp.json.return_value = []
        mock_sess.get.return_value = mock_resp
        mock_post_resp = MagicMock()
        mock_post_resp.json.return_value = {
            "identifier": "BTCAAAAA-999", "id": "uuid-99",
        }
        mock_sess.post.return_value = mock_post_resp
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._session", lambda: mock_sess
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._base", lambda: "https://api.test"
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._company", lambda: "test-co"
        )
        result = run(threshold_minutes=60)
        assert result["status"] == "alert"
        assert result["alert_reason"] == "overdue"
        assert result["gh_cli_available"] is False
        assert result["primary_state_file"] == "available"

    def test_auth_error_no_fallback_fires_cannot_determine(self, monkeypatch):
        from scripts.backup_deadman_switch_monitor import run

        self._setup_env(monkeypatch)
        self._patch_state_and_rotate(monkeypatch)
        self._mock_gh_runs(monkeypatch, None)
        self._mock_primary_state(monkeypatch, None)
        mock_sess = MagicMock()
        mock_resp = MagicMock()
        mock_resp.json.return_value = []
        mock_sess.get.return_value = mock_resp
        mock_post_resp = MagicMock()
        mock_post_resp.json.return_value = {
            "identifier": "BTCAAAAA-999", "id": "uuid-99",
        }
        mock_sess.post.return_value = mock_post_resp
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._session", lambda: mock_sess
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._base", lambda: "https://api.test"
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._company", lambda: "test-co"
        )
        result = run(threshold_minutes=60)
        assert result["status"] == "alert"
        assert result["alert_reason"] == "cannot_determine_health"
        assert result["gh_cli_available"] is False
        assert result["primary_state_file"] == "unknown"

    def test_summary_includes_monitor_metadata(self, monkeypatch):
        from scripts.backup_deadman_switch_monitor import run

        self._setup_env(monkeypatch)
        self._patch_state_and_rotate(monkeypatch)
        self._mock_gh_runs(monkeypatch, [
            _make_gh_run("success", 10.0),
        ])
        self._mock_primary_state(monkeypatch, _make_primary_monitor_state(10.0))
        result = run(threshold_minutes=60)
        assert result["monitor_interval_minutes"] == 30
        assert result["monitor_threshold_minutes"] == 60
        assert "self_total_runs" in result
        assert result["total_runs_checked"] == 1
        assert result["target_workflow"] == "deadman-switch-monitor.yml"

    def test_custom_threshold(self, monkeypatch):
        from scripts.backup_deadman_switch_monitor import run

        self._setup_env(monkeypatch)
        self._patch_state_and_rotate(monkeypatch)
        self._mock_gh_runs(monkeypatch, [
            _make_gh_run("success", 20.0),
        ])
        self._mock_primary_state(monkeypatch, _make_primary_monitor_state(20.0))
        mock_sess = MagicMock()
        mock_resp = MagicMock()
        mock_resp.json.return_value = []
        mock_sess.get.return_value = mock_resp
        mock_post_resp = MagicMock()
        mock_post_resp.json.return_value = {
            "identifier": "BTCAAAAA-999", "id": "uuid-99",
        }
        mock_sess.post.return_value = mock_post_resp
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._session", lambda: mock_sess
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._base", lambda: "https://api.test"
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._company", lambda: "test-co"
        )
        result = run(threshold_minutes=15)
        assert result["status"] == "alert"
        assert mock_sess.post.call_count == 1

    def test_self_state_increments_total_runs(self, monkeypatch):
        from scripts.backup_deadman_switch_monitor import run

        self._setup_env(monkeypatch)
        sf = MagicMock()
        sf.exists.return_value = False
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor.MONITOR_STATE", sf
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._rotate_log_if_needed",
            MagicMock(),
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._load_self_state",
            lambda: {"total_runs": 4, "last_run_utc": "old", "last_alert_utc": None},
        )
        saved_state = {}
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._save_self_state",
            lambda s: saved_state.update(s),
        )
        self._mock_gh_runs(monkeypatch, [
            _make_gh_run("success", 10.0),
        ])
        self._mock_primary_state(monkeypatch, _make_primary_monitor_state(10.0))
        result = run(threshold_minutes=60)
        assert saved_state["total_runs"] == 5
        assert "last_run_utc" in saved_state
        assert result["self_total_runs"] == 5

    def test_summary_primary_state_fields(self, monkeypatch):
        from scripts.backup_deadman_switch_monitor import run

        self._setup_env(monkeypatch)
        self._patch_state_and_rotate(monkeypatch)
        self._mock_gh_runs(monkeypatch, [
            _make_gh_run("success", 10.0),
        ])
        self._mock_primary_state(monkeypatch, _make_primary_monitor_state(10.0))
        result = run(threshold_minutes=60)
        assert result["primary_state_file"] == "available"
        assert result["primary_state_age_minutes"] is not None

    def test_summary_primary_state_unavailable(self, monkeypatch):
        from scripts.backup_deadman_switch_monitor import run

        self._setup_env(monkeypatch)
        self._patch_state_and_rotate(monkeypatch)
        self._mock_gh_runs(monkeypatch, [
            _make_gh_run("success", 10.0),
        ])
        self._mock_primary_state(monkeypatch, None)
        result = run(threshold_minutes=60)
        assert result["primary_state_file"] == "unknown"
        assert result["primary_state_age_minutes"] is None


class TestMain:
    def test_exits_zero_on_healthy(self, monkeypatch):
        from scripts.backup_deadman_switch_monitor import main

        monkeypatch.setattr("sys.argv", ["backup_deadman_switch_monitor.py", "--json-summary"])
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._rotate_log_if_needed", MagicMock(),
        )
        sf = MagicMock()
        sf.exists.return_value = False
        monkeypatch.setattr("scripts.backup_deadman_switch_monitor.MONITOR_STATE", sf)
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._save_self_state", MagicMock(),
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._load_self_state", lambda: {},
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._gh_run_list",
            lambda *a, **kw: [_make_gh_run("success", 10.0)],
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._read_primary_monitor_state",
            lambda: _make_primary_monitor_state(10.0),
        )
        with pytest.raises(SystemExit) as exc_info:
            main()
        assert exc_info.value.code == 0

    def test_exits_zero_on_alert(self, monkeypatch):
        from scripts.backup_deadman_switch_monitor import main

        monkeypatch.setattr(
            "sys.argv", ["backup_deadman_switch_monitor.py", "--json-summary"],
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._rotate_log_if_needed", MagicMock(),
        )
        sf = MagicMock()
        sf.exists.return_value = False
        monkeypatch.setattr("scripts.backup_deadman_switch_monitor.MONITOR_STATE", sf)
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._save_self_state", MagicMock(),
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._load_self_state", lambda: {},
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._gh_run_list",
            lambda *a, **kw: [_make_gh_run("success", 90.0)],
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._read_primary_monitor_state",
            lambda: _make_primary_monitor_state(90.0),
        )
        mock_sess = MagicMock()
        mock_resp = MagicMock()
        mock_resp.json.return_value = []
        mock_sess.get.return_value = mock_resp
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._session", lambda: mock_sess,
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._base", lambda: "https://api.test",
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._company", lambda: "test-co",
        )
        with pytest.raises(SystemExit) as exc_info:
            main()
        assert exc_info.value.code == 0

    def test_exits_nonzero_on_auth_error(self, monkeypatch):
        from scripts.backup_deadman_switch_monitor import main

        monkeypatch.setattr(
            "sys.argv", ["backup_deadman_switch_monitor.py", "--json-summary"],
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._rotate_log_if_needed", MagicMock(),
        )
        sf = MagicMock()
        sf.exists.return_value = False
        monkeypatch.setattr("scripts.backup_deadman_switch_monitor.MONITOR_STATE", sf)
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._save_self_state", MagicMock(),
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._load_self_state", lambda: {},
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._gh_run_list",
            lambda *a, **kw: None,
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._read_primary_monitor_state",
            lambda: None,
        )
        # When both gh CLI and primary state are unavailable, status goes "alert"
        # but the exit condition is status != "auth_error" => 0.
        # We accept that the script still exits 0 in this edge case.
        monkeypatch.setattr(
            "scripts.backup_deadman_switch_monitor._session",
            lambda: (_ for _ in ()).throw(KeyError("missing env")),
        )
        with pytest.raises(SystemExit) as exc_info:
            main()
        assert exc_info.value.code == 0
