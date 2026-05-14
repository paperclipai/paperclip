"""Unit tests for scripts/backup_deadman_switch.py — dead-man's-switch monitor.

Tests cover the pure-function logic (file parsing, age calculation, threshold
decisions, deduplication) and integration points (API session init, searching
for existing alerts, creating alerts) via mock injection.
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

pytestmark = [pytest.mark.bug("BTCAAAAA-25851"), pytest.mark.regression]


def _make_fresh_state(age_hours):
    ts = datetime.now(timezone.utc) - timedelta(hours=age_hours)
    return {
        "lastSuccess": ts.isoformat(),
        "destination": "gdrive:Paperclip-Backups/test-company/2026/05/13/0800",
    }


class TestReadLastSuccess:
    def test_returns_state_when_file_exists(self, tmp_path, monkeypatch):
        from scripts.backup_deadman_switch import _read_last_success

        state = _make_fresh_state(1.5)
        sf = tmp_path / "last-success.json"
        sf.write_text(json.dumps(state))
        monkeypatch.setattr("scripts.backup_deadman_switch.BACKUP_STATE_FILE", sf)
        assert _read_last_success() == state

    def test_returns_none_when_file_missing(self, monkeypatch):
        from scripts.backup_deadman_switch import _read_last_success

        monkeypatch.setattr(
            "scripts.backup_deadman_switch.BACKUP_STATE_FILE",
            Path("/nonexistent/path.json"),
        )
        assert _read_last_success() is None

    def test_returns_none_on_invalid_json(self, tmp_path, monkeypatch):
        from scripts.backup_deadman_switch import _read_last_success

        sf = tmp_path / "bad.json"
        sf.write_text("{not valid json")
        monkeypatch.setattr("scripts.backup_deadman_switch.BACKUP_STATE_FILE", sf)
        assert _read_last_success() is None

    def test_returns_none_on_unreadable_file(self, tmp_path, monkeypatch):
        from scripts.backup_deadman_switch import _read_last_success

        sf = tmp_path / "unreadable.json"
        sf.write_text("{}")
        sf.chmod(0o000)
        monkeypatch.setattr("scripts.backup_deadman_switch.BACKUP_STATE_FILE", sf)
        try:
            assert _read_last_success() is None
        finally:
            sf.chmod(0o644)


class TestGetBackupAgeHours:
    def test_returns_age_for_valid_timestamp(self):
        from scripts.backup_deadman_switch import _get_backup_age_hours

        state = _make_fresh_state(2.0)
        age = _get_backup_age_hours(state)
        assert age is not None
        assert 1.5 <= age <= 2.5

    def test_returns_none_when_field_missing(self):
        from scripts.backup_deadman_switch import _get_backup_age_hours

        assert _get_backup_age_hours({}) is None
        assert _get_backup_age_hours({"lastSuccess": None}) is None
        assert _get_backup_age_hours({"lastSuccess": ""}) is None

    def test_returns_none_on_unparseable_timestamp(self):
        from scripts.backup_deadman_switch import _get_backup_age_hours

        assert _get_backup_age_hours({"lastSuccess": "garbage"}) is None

    def test_returns_zero_for_right_now(self):
        from scripts.backup_deadman_switch import _get_backup_age_hours

        state = {"lastSuccess": datetime.now(timezone.utc).isoformat()}
        age = _get_backup_age_hours(state)
        assert age is not None
        assert 0.0 <= age <= 0.1

    def test_handles_zulu_suffix(self):
        from scripts.backup_deadman_switch import _get_backup_age_hours

        state = {"lastSuccess": "2026-05-01T00:00:00Z"}
        age = _get_backup_age_hours(state)
        assert age is not None
        assert age > 0


class TestLogRotation:
    def test_rotates_when_log_exceeds_limit(self, tmp_path, monkeypatch):
        from scripts.backup_deadman_switch import _rotate_log_if_needed, MAX_LOG_BYTES

        logf = tmp_path / "deadman.log"
        logf.write_text("x" * (MAX_LOG_BYTES + 1))
        monkeypatch.setattr("scripts.backup_deadman_switch.DEADMAN_LOG", logf)

        _rotate_log_if_needed()
        bak = tmp_path / "deadman.log.1"
        assert bak.exists()
        assert logf.stat().st_size == 0

    def test_skips_when_log_under_limit(self, tmp_path, monkeypatch):
        from scripts.backup_deadman_switch import _rotate_log_if_needed

        logf = tmp_path / "deadman.log"
        logf.write_text("small")
        monkeypatch.setattr("scripts.backup_deadman_switch.DEADMAN_LOG", logf)

        _rotate_log_if_needed()
        bak = tmp_path / "deadman.log.1"
        assert not bak.exists()
        assert logf.stat().st_size == 5


class TestSelfState:
    def test_load_defaults_when_no_file(self, tmp_path, monkeypatch):
        from scripts.backup_deadman_switch import _load_self_state

        sf = tmp_path / "state.json"
        monkeypatch.setattr("scripts.backup_deadman_switch.DEADMAN_STATE", sf)
        assert _load_self_state() == {}

    def test_loads_existing_state(self, tmp_path, monkeypatch):
        from scripts.backup_deadman_switch import _load_self_state

        sf = tmp_path / "state.json"
        sf.write_text(json.dumps({"total_runs": 5}))
        monkeypatch.setattr("scripts.backup_deadman_switch.DEADMAN_STATE", sf)
        assert _load_self_state() == {"total_runs": 5}

    def test_save_and_reload(self, tmp_path, monkeypatch):
        from scripts.backup_deadman_switch import _save_self_state, _load_self_state

        sf = tmp_path / "state.json"
        monkeypatch.setattr("scripts.backup_deadman_switch.DEADMAN_STATE", sf)
        _save_self_state({"total_runs": 3, "last_run_utc": "2026-05-01T00:00:00"})
        loaded = _load_self_state()
        assert loaded["total_runs"] == 3
        assert loaded["last_run_utc"] == "2026-05-01T00:00:00"


class TestFindExistingAlert:
    def test_returns_none_when_no_matching_issues(self, monkeypatch):
        from scripts.backup_deadman_switch import _find_existing_alert

        mock_sess = MagicMock()
        mock_resp = MagicMock()
        mock_resp.json.return_value = [{"title": "Other issue", "id": "abc"}]
        mock_sess.get.return_value = mock_resp
        monkeypatch.setattr("scripts.backup_deadman_switch._session", lambda: mock_sess)
        monkeypatch.setattr(
            "scripts.backup_deadman_switch._base", lambda: "https://api.test"
        )
        monkeypatch.setattr("scripts.backup_deadman_switch._company", lambda: "test-co")
        assert _find_existing_alert() is None

    def test_returns_issue_when_title_matches(self, monkeypatch):
        from scripts.backup_deadman_switch import _find_existing_alert

        existing = {"title": "Backup dead-man triggered — test", "id": "def"}
        mock_sess = MagicMock()
        mock_resp = MagicMock()
        mock_resp.json.return_value = [existing]
        mock_sess.get.return_value = mock_resp
        monkeypatch.setattr("scripts.backup_deadman_switch._session", lambda: mock_sess)
        monkeypatch.setattr(
            "scripts.backup_deadman_switch._base", lambda: "https://api.test"
        )
        monkeypatch.setattr("scripts.backup_deadman_switch._company", lambda: "test-co")
        assert _find_existing_alert() == existing

    def test_returns_none_on_api_error(self, monkeypatch):
        from scripts.backup_deadman_switch import _find_existing_alert

        mock_sess = MagicMock()
        mock_sess.get.side_effect = ConnectionError("network down")
        monkeypatch.setattr("scripts.backup_deadman_switch._session", lambda: mock_sess)
        monkeypatch.setattr(
            "scripts.backup_deadman_switch._base", lambda: "https://api.test"
        )
        monkeypatch.setattr("scripts.backup_deadman_switch._company", lambda: "test-co")
        assert _find_existing_alert() is None

    def test_returns_none_on_session_failure(self, monkeypatch):
        from scripts.backup_deadman_switch import _find_existing_alert

        monkeypatch.setattr(
            "scripts.backup_deadman_switch._session",
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
        monkeypatch.setattr("scripts.backup_deadman_switch._session", lambda: mock_sess)
        monkeypatch.setattr(
            "scripts.backup_deadman_switch._base", lambda: "https://api.test"
        )
        monkeypatch.setattr("scripts.backup_deadman_switch._company", lambda: "test-co")
        return mock_sess

    def test_dry_run_logs_and_returns_true(self, monkeypatch, capsys):
        from scripts.backup_deadman_switch import _create_alert

        self._setup_mocks(monkeypatch)
        state = _make_fresh_state(15.0)
        with patch(
            "scripts.backup_deadman_switch._read_last_success", return_value=state
        ):
            result = _create_alert(age_hours=15.0, grace_hours=8, dry_run=True)
        assert result is True
        captured = capsys.readouterr().out
        assert "critical" in captured and "title" in captured

    def test_creates_alert_when_age_overdue(self, monkeypatch):
        from scripts.backup_deadman_switch import _create_alert

        mock_sess = self._setup_mocks(
            monkeypatch, post_return={"identifier": "BTCAAAAA-999", "id": "uuid-99"}
        )
        result = _create_alert(age_hours=15.0, grace_hours=8, dry_run=False)
        assert result is True
        assert mock_sess.post.call_count == 1
        payload = mock_sess.post.call_args[1]["json"]
        assert payload["priority"] == "critical"

    def test_creates_alert_when_no_backups_ever(self, monkeypatch):
        from scripts.backup_deadman_switch import _create_alert

        with patch(
            "scripts.backup_deadman_switch._read_last_success", return_value=None
        ):
            mock_sess = self._setup_mocks(
                monkeypatch, post_return={"identifier": "BTCAAAAA-999", "id": "uuid-99"}
            )
            result = _create_alert(age_hours=None, grace_hours=8, dry_run=False)
            assert result is True
            payload = mock_sess.post.call_args[1]["json"]
            assert "no backups ever" in payload["title"].lower()

    def test_returns_false_on_api_error(self, monkeypatch):
        from scripts.backup_deadman_switch import _create_alert

        mock_sess = MagicMock()
        mock_sess.post.side_effect = ConnectionError("network down")
        monkeypatch.setattr("scripts.backup_deadman_switch._session", lambda: mock_sess)
        monkeypatch.setattr(
            "scripts.backup_deadman_switch._base", lambda: "https://api.test"
        )
        monkeypatch.setattr("scripts.backup_deadman_switch._company", lambda: "test-co")
        assert _create_alert(age_hours=15.0, grace_hours=8, dry_run=False) is False

    def test_returns_false_on_session_failure(self, monkeypatch):
        from scripts.backup_deadman_switch import _create_alert

        monkeypatch.setattr(
            "scripts.backup_deadman_switch._session",
            lambda: (_ for _ in ()).throw(KeyError("missing env")),
        )
        assert _create_alert(age_hours=15.0, grace_hours=8, dry_run=False) is False

    def test_assigns_linux_specialist(self, monkeypatch):
        from scripts.backup_deadman_switch import (
            _create_alert,
            LINUX_SPECIALIST_AGENT_ID,
        )

        mock_sess = self._setup_mocks(
            monkeypatch, post_return={"identifier": "BTCAAAAA-999", "id": "uuid-99"}
        )
        _create_alert(age_hours=15.0, grace_hours=8, dry_run=False)
        payload = mock_sess.post.call_args[1]["json"]
        assert payload["assigneeAgentId"] == LINUX_SPECIALIST_AGENT_ID

    def test_includes_destination_in_description(self, monkeypatch):
        from scripts.backup_deadman_switch import _create_alert

        mock_sess = self._setup_mocks(
            monkeypatch, post_return={"identifier": "BTCAAAAA-999", "id": "uuid-99"}
        )
        state = _make_fresh_state(15.0)
        _create_alert(
            age_hours=15.0, grace_hours=8, dry_run=False, last_dest=state["destination"]
        )
        payload = mock_sess.post.call_args[1]["json"]
        assert "gdrive" in payload["description"]


class TestCommentOnExistingAlert:
    def _setup_mocks(self, monkeypatch, post_return=None):
        mock_sess = MagicMock()
        if post_return is not None:
            mock_resp = MagicMock()
            mock_resp.json.return_value = post_return
            mock_sess.post.return_value = mock_resp
        monkeypatch.setattr("scripts.backup_deadman_switch._session", lambda: mock_sess)
        monkeypatch.setattr(
            "scripts.backup_deadman_switch._base", lambda: "https://api.test"
        )
        monkeypatch.setattr("scripts.backup_deadman_switch._company", lambda: "test-co")
        return mock_sess

    def test_comments_on_existing_alert_with_age(self, monkeypatch):
        from scripts.backup_deadman_switch import _comment_on_existing_alert

        mock_sess = self._setup_mocks(monkeypatch, post_return={"id": "comment-1"})
        issue = {"identifier": "BTCAAAAA-999", "id": "uuid-99"}
        result = _comment_on_existing_alert(
            issue, age_hours=15.0, threshold=8.0, dry_run=False
        )
        assert result is True
        assert mock_sess.post.call_count == 1
        call_url = mock_sess.post.call_args[0][0]
        assert "/comments" in call_url
        payload = mock_sess.post.call_args[1]["json"]
        assert "15.0h ago" in payload["body"]

    def test_comments_with_missing_age(self, monkeypatch):
        from scripts.backup_deadman_switch import _comment_on_existing_alert

        mock_sess = self._setup_mocks(monkeypatch, post_return={"id": "comment-1"})
        issue = {"identifier": "BTCAAAAA-999", "id": "uuid-99"}
        result = _comment_on_existing_alert(
            issue, age_hours=None, threshold=8.0, dry_run=False
        )
        assert result is True
        payload = mock_sess.post.call_args[1]["json"]
        assert "MISSING" in payload["body"]

    def test_dry_run_does_not_post(self, monkeypatch, capsys):
        from scripts.backup_deadman_switch import _comment_on_existing_alert

        mock_sess = self._setup_mocks(monkeypatch)
        issue = {"identifier": "BTCAAAAA-999", "id": "uuid-99"}
        result = _comment_on_existing_alert(
            issue, age_hours=15.0, threshold=8.0, dry_run=True
        )
        assert result is True
        mock_sess.post.assert_not_called()
        captured = capsys.readouterr().out
        assert "BTCAAAAA-999" in captured

    def test_returns_false_on_api_error(self, monkeypatch):
        from scripts.backup_deadman_switch import _comment_on_existing_alert

        mock_sess = MagicMock()
        mock_sess.post.side_effect = ConnectionError("network down")
        monkeypatch.setattr("scripts.backup_deadman_switch._session", lambda: mock_sess)
        monkeypatch.setattr(
            "scripts.backup_deadman_switch._base", lambda: "https://api.test"
        )
        monkeypatch.setattr("scripts.backup_deadman_switch._company", lambda: "test-co")
        issue = {"identifier": "BTCAAAAA-999", "id": "uuid-99"}
        assert (
            _comment_on_existing_alert(
                issue, age_hours=15.0, threshold=8.0, dry_run=False
            )
            is False
        )

    def test_returns_false_on_session_failure(self, monkeypatch):
        from scripts.backup_deadman_switch import _comment_on_existing_alert

        monkeypatch.setattr(
            "scripts.backup_deadman_switch._session",
            lambda: (_ for _ in ()).throw(KeyError("missing env")),
        )
        issue = {"identifier": "BTCAAAAA-999"}
        assert (
            _comment_on_existing_alert(
                issue, age_hours=15.0, threshold=8.0, dry_run=False
            )
            is False
        )


class TestRun:
    def _setup_env(self, monkeypatch):
        monkeypatch.setenv("PAPERCLIP_API_URL", "https://api.test")
        monkeypatch.setenv("PAPERCLIP_API_KEY", "test-key")
        monkeypatch.setenv("PAPERCLIP_COMPANY_ID", "test-co")

    def _patch_state_and_rotate(self, monkeypatch):
        sf = MagicMock()
        sf.exists.return_value = False
        monkeypatch.setattr("scripts.backup_deadman_switch.DEADMAN_STATE", sf)
        monkeypatch.setattr(
            "scripts.backup_deadman_switch._rotate_log_if_needed", MagicMock()
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch._save_self_state", MagicMock()
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch._load_self_state", lambda: {}
        )

    def test_backup_current_returns_healthy(self, monkeypatch):
        from scripts.backup_deadman_switch import run

        self._setup_env(monkeypatch)
        self._patch_state_and_rotate(monkeypatch)
        state = _make_fresh_state(2.0)
        with patch(
            "scripts.backup_deadman_switch._read_last_success", return_value=state
        ):
            result = run(grace_hours=4)
            assert result["status"] == "healthy"
            assert result["alert_fired"] is False

    def test_backup_overdue_fires_alert(self, monkeypatch):
        from scripts.backup_deadman_switch import run

        self._setup_env(monkeypatch)
        self._patch_state_and_rotate(monkeypatch)
        state = _make_fresh_state(20.0)
        mock_sess = MagicMock()
        mock_resp = MagicMock()
        mock_resp.json.return_value = []
        mock_sess.get.return_value = mock_resp
        mock_post_resp = MagicMock()
        mock_post_resp.json.return_value = {
            "identifier": "BTCAAAAA-999",
            "id": "uuid-99",
        }
        mock_sess.post.return_value = mock_post_resp
        monkeypatch.setattr("scripts.backup_deadman_switch._session", lambda: mock_sess)
        monkeypatch.setattr(
            "scripts.backup_deadman_switch._base", lambda: "https://api.test"
        )
        monkeypatch.setattr("scripts.backup_deadman_switch._company", lambda: "test-co")
        with patch(
            "scripts.backup_deadman_switch._read_last_success", return_value=state
        ):
            result = run(grace_hours=4)
            assert result["status"] == "alert"
            assert result["alert_fired"] is True
            assert mock_sess.post.call_count == 1

    def test_no_backup_ever_fires_alert(self, monkeypatch):
        from scripts.backup_deadman_switch import run

        self._setup_env(monkeypatch)
        self._patch_state_and_rotate(monkeypatch)
        mock_sess = MagicMock()
        mock_resp = MagicMock()
        mock_resp.json.return_value = []
        mock_sess.get.return_value = mock_resp
        mock_post_resp = MagicMock()
        mock_post_resp.json.return_value = {
            "identifier": "BTCAAAAA-999",
            "id": "uuid-99",
        }
        mock_sess.post.return_value = mock_post_resp
        monkeypatch.setattr("scripts.backup_deadman_switch._session", lambda: mock_sess)
        monkeypatch.setattr(
            "scripts.backup_deadman_switch._base", lambda: "https://api.test"
        )
        monkeypatch.setattr("scripts.backup_deadman_switch._company", lambda: "test-co")
        with patch(
            "scripts.backup_deadman_switch._read_last_success", return_value=None
        ):
            result = run(grace_hours=4)
            assert result["status"] == "alert"
            assert result["alert_fired"] is True
            assert mock_sess.post.call_count == 1

    def test_existing_alert_suppresses_duplicate(self, monkeypatch):
        from scripts.backup_deadman_switch import run

        self._setup_env(monkeypatch)
        self._patch_state_and_rotate(monkeypatch)
        state = _make_fresh_state(20.0)
        mock_sess = MagicMock()
        # GET returns existing alert
        get_resp = MagicMock()
        get_resp.json.return_value = [
            {
                "title": "Backup dead-man triggered — existing",
                "identifier": "exist-1",
                "id": "exist-1",
            }
        ]
        mock_sess.get.return_value = get_resp
        # POST to /comments endpoint
        post_resp = MagicMock()
        post_resp.json.return_value = {"id": "comment-1"}
        mock_sess.post.return_value = post_resp
        monkeypatch.setattr("scripts.backup_deadman_switch._session", lambda: mock_sess)
        monkeypatch.setattr(
            "scripts.backup_deadman_switch._base", lambda: "https://api.test"
        )
        monkeypatch.setattr("scripts.backup_deadman_switch._company", lambda: "test-co")
        with patch(
            "scripts.backup_deadman_switch._read_last_success", return_value=state
        ):
            result = run(grace_hours=4)
            assert result["alert_skipped"] is True
            # Should have POSTed a comment, NOT created a new alert
            post_calls = [
                c for c in mock_sess.post.call_args_list if "/comments" in str(c[0][0])
            ]
            assert len(post_calls) == 1

    def test_grace_period_respected(self, monkeypatch):
        from scripts.backup_deadman_switch import run

        self._setup_env(monkeypatch)
        self._patch_state_and_rotate(monkeypatch)
        state = _make_fresh_state(5.0)
        with patch(
            "scripts.backup_deadman_switch._read_last_success", return_value=state
        ):
            result = run(grace_hours=4)
            assert result["status"] == "healthy"

    def test_custom_grace_period(self, monkeypatch):
        from scripts.backup_deadman_switch import run

        self._setup_env(monkeypatch)
        self._patch_state_and_rotate(monkeypatch)
        state = _make_fresh_state(7.0)
        mock_sess = MagicMock()
        mock_resp = MagicMock()
        mock_resp.json.return_value = []
        mock_sess.get.return_value = mock_resp
        mock_post_resp = MagicMock()
        mock_post_resp.json.return_value = {
            "identifier": "BTCAAAAA-999",
            "id": "uuid-99",
        }
        mock_sess.post.return_value = mock_post_resp
        monkeypatch.setattr("scripts.backup_deadman_switch._session", lambda: mock_sess)
        monkeypatch.setattr(
            "scripts.backup_deadman_switch._base", lambda: "https://api.test"
        )
        monkeypatch.setattr("scripts.backup_deadman_switch._company", lambda: "test-co")
        with patch(
            "scripts.backup_deadman_switch._read_last_success", return_value=state
        ):
            result = run(grace_hours=2)
            assert result["status"] == "alert"
            assert mock_sess.post.call_count == 1

    def test_summary_includes_backup_metadata(self, monkeypatch):
        from scripts.backup_deadman_switch import run

        self._setup_env(monkeypatch)
        self._patch_state_and_rotate(monkeypatch)
        state = _make_fresh_state(2.0)
        with patch(
            "scripts.backup_deadman_switch._read_last_success", return_value=state
        ):
            result = run(grace_hours=4)
            assert result["threshold_hours"] == 8
            assert "self_total_runs" in result

    def test_returns_age_none_when_no_state(self, monkeypatch):
        from scripts.backup_deadman_switch import run

        self._setup_env(monkeypatch)
        self._patch_state_and_rotate(monkeypatch)
        mock_sess = MagicMock()
        mock_resp = MagicMock()
        mock_resp.json.return_value = []
        mock_sess.get.return_value = mock_resp
        mock_post_resp = MagicMock()
        mock_post_resp.json.return_value = {
            "identifier": "BTCAAAAA-999",
            "id": "uuid-99",
        }
        mock_sess.post.return_value = mock_post_resp
        monkeypatch.setattr("scripts.backup_deadman_switch._session", lambda: mock_sess)
        monkeypatch.setattr(
            "scripts.backup_deadman_switch._base", lambda: "https://api.test"
        )
        monkeypatch.setattr("scripts.backup_deadman_switch._company", lambda: "test-co")
        with patch(
            "scripts.backup_deadman_switch._read_last_success", return_value=None
        ):
            result = run(grace_hours=4)
            assert result["backup_age_hours"] is None
            assert result["alert_reason"] == "no_success_ever"

    def test_auth_error_when_session_unavailable_and_overdue(self, monkeypatch):
        from scripts.backup_deadman_switch import run

        self._setup_env(monkeypatch)
        self._patch_state_and_rotate(monkeypatch)
        monkeypatch.setattr(
            "scripts.backup_deadman_switch._session",
            lambda: (_ for _ in ()).throw(KeyError("missing env")),
        )
        monkeypatch.setattr(
            "scripts.backup_deadman_switch._base", lambda: "https://api.test"
        )
        monkeypatch.setattr("scripts.backup_deadman_switch._company", lambda: "test-co")
        state = _make_fresh_state(20.0)
        with patch(
            "scripts.backup_deadman_switch._read_last_success", return_value=state
        ):
            result = run(grace_hours=4)
            assert result["status"] == "auth_error"
            assert result["alert_reason"] == "overdue"
            assert result["alert_fired"] is False

    def test_auth_error_when_session_unavailable_and_healthy(self, monkeypatch):
        from scripts.backup_deadman_switch import run

        self._setup_env(monkeypatch)
        self._patch_state_and_rotate(monkeypatch)
        monkeypatch.setattr(
            "scripts.backup_deadman_switch._session",
            lambda: (_ for _ in ()).throw(KeyError("missing env")),
        )
        state = _make_fresh_state(2.0)
        with patch(
            "scripts.backup_deadman_switch._read_last_success", return_value=state
        ):
            result = run(grace_hours=4)
            assert result["status"] == "healthy"
            assert result["alert_fired"] is False

    def test_create_alert_passes_destination(self, monkeypatch):
        from scripts.backup_deadman_switch import _create_alert

        mock_sess = MagicMock()
        mock_resp = MagicMock()
        mock_resp.json.return_value = {"identifier": "BTCAAAAA-999", "id": "uuid-99"}
        mock_sess.post.return_value = mock_resp
        monkeypatch.setattr("scripts.backup_deadman_switch._session", lambda: mock_sess)
        monkeypatch.setattr(
            "scripts.backup_deadman_switch._base", lambda: "https://api.test"
        )
        monkeypatch.setattr("scripts.backup_deadman_switch._company", lambda: "test-co")
        _create_alert(
            age_hours=15.0,
            grace_hours=8,
            dry_run=False,
            last_dest="gdrive:custom/path",
        )
        payload = mock_sess.post.call_args[1]["json"]
        assert "gdrive:custom/path" in payload["description"]

    def test_create_alert_default_destination(self, monkeypatch):
        from scripts.backup_deadman_switch import _create_alert

        mock_sess = MagicMock()
        mock_resp = MagicMock()
        mock_resp.json.return_value = {"identifier": "BTCAAAAA-999", "id": "uuid-99"}
        mock_sess.post.return_value = mock_resp
        monkeypatch.setattr("scripts.backup_deadman_switch._session", lambda: mock_sess)
        monkeypatch.setattr(
            "scripts.backup_deadman_switch._base", lambda: "https://api.test"
        )
        monkeypatch.setattr("scripts.backup_deadman_switch._company", lambda: "test-co")
        _create_alert(age_hours=15.0, grace_hours=8, dry_run=False)
        payload = mock_sess.post.call_args[1]["json"]
        assert "unknown" in payload["description"]
