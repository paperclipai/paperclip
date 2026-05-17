"""Unit tests for scripts/rclone_oauth_health.py — rclone OAuth token health monitor.

Tests cover token parsing, health analysis, connectivity checking, alert
creation, and deduplication logic.
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


FUTURE_EXPIRY = (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat()
PAST_EXPIRY = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
SOON_EXPIRY = (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat()


class TestParseRcloneConfigSection:
    def test_parses_valid_section(self):
        from scripts.rclone_oauth_health import _parse_rclone_config_section

        raw = """[gdrive]
type = drive
scope = drive
token = {"access_token":"abc","refresh_token":"xyz"}"""
        result = _parse_rclone_config_section(raw)
        assert result is not None
        assert result["type"] == "drive"
        assert result["scope"] == "drive"
        assert "abc" in result["token"]

    def test_returns_none_for_empty_input(self):
        from scripts.rclone_oauth_health import _parse_rclone_config_section

        assert _parse_rclone_config_section("") is None
        assert _parse_rclone_config_section("[other]\ntype = drive") is None

    def test_handles_multi_value_token(self):
        from scripts.rclone_oauth_health import _parse_rclone_config_section

        raw = """[gdrive]
token = {"access_token":"ya29.abc123","token_type":"Bearer","refresh_token":"1//xyz","expiry":"2026-05-15T00:00:00Z"}"""
        result = _parse_rclone_config_section(raw)
        assert result is not None
        assert "access_token" in result["token"]


class TestCheckTokenHealth:
    def test_valid_token_with_both_tokens(self):
        from scripts.rclone_oauth_health import _check_token_health

        token = {
            "access_token": "ya29.abc",
            "refresh_token": "1//xyz",
            "expiry": FUTURE_EXPIRY,
        }
        report = _check_token_health(token)
        assert report["has_access_token"] is True
        assert report["has_refresh_token"] is True
        assert report["expired"] is False
        assert report["expiry_secs_left"] is not None
        assert report["expiry_secs_left"] > 0

    def test_expired_token(self):
        from scripts.rclone_oauth_health import _check_token_health

        token = {
            "access_token": "ya29.abc",
            "refresh_token": "1//xyz",
            "expiry": PAST_EXPIRY,
        }
        report = _check_token_health(token)
        assert report["expired"] is True
        assert report["expiry_secs_left"] is not None
        assert report["expiry_secs_left"] < 0

    def test_soon_expiring_token(self):
        from scripts.rclone_oauth_health import _check_token_health

        token = {
            "access_token": "ya29.abc",
            "refresh_token": "1//xyz",
            "expiry": SOON_EXPIRY,
        }
        report = _check_token_health(token)
        assert report["warn_soon"] is True
        assert report["expired"] is False

    def test_missing_access_token(self):
        from scripts.rclone_oauth_health import _check_token_health

        token = {
            "refresh_token": "1//xyz",
        }
        report = _check_token_health(token)
        assert report["has_access_token"] is False
        assert report["has_refresh_token"] is True

    def test_missing_refresh_token(self):
        from scripts.rclone_oauth_health import _check_token_health

        token = {
            "access_token": "ya29.abc",
        }
        report = _check_token_health(token)
        assert report["has_access_token"] is True
        assert report["has_refresh_token"] is False

    def test_empty_token(self):
        from scripts.rclone_oauth_health import _check_token_health

        report = _check_token_health({})
        assert report["has_access_token"] is False
        assert report["has_refresh_token"] is False

    def test_handles_zulu_expiry(self):
        from scripts.rclone_oauth_health import _check_token_health

        token = {
            "access_token": "ya29.abc",
            "refresh_token": "1//xyz",
            "expiry": "2026-05-15T00:00:00Z",
        }
        report = _check_token_health(token)
        assert report["has_access_token"] is True
        assert report["expiry"] == "2026-05-15T00:00:00Z"

    def test_invalid_expiry_no_crash(self):
        from scripts.rclone_oauth_health import _check_token_health

        token = {
            "access_token": "ya29.abc",
            "refresh_token": "1//xyz",
            "expiry": "not-a-date",
        }
        report = _check_token_health(token)
        assert report["has_access_token"] is True
        assert report["expiry_secs_left"] is None


class TestReadRclonePass:
    def test_returns_none_when_file_missing(self, tmp_path, monkeypatch):
        from scripts.rclone_oauth_health import _read_rclone_pass

        monkeypatch.setattr(
            "scripts.rclone_oauth_health.RCLONE_PASS_FILE",
            tmp_path / "nonexistent",
        )
        assert _read_rclone_pass() is None

    def test_returns_content_when_file_exists(self, tmp_path, monkeypatch):
        from scripts.rclone_oauth_health import _read_rclone_pass

        pf = tmp_path / "pass"
        pf.write_text("secret123")
        monkeypatch.setattr("scripts.rclone_oauth_health.RCLONE_PASS_FILE", pf)
        assert _read_rclone_pass() == "secret123"

    def test_returns_none_for_empty_file(self, tmp_path, monkeypatch):
        from scripts.rclone_oauth_health import _read_rclone_pass

        pf = tmp_path / "pass"
        pf.write_text("  \n")
        monkeypatch.setattr("scripts.rclone_oauth_health.RCLONE_PASS_FILE", pf)
        assert _read_rclone_pass() is None


class TestGetDecryptedToken:
    def test_returns_parsed_token(self, monkeypatch):
        from scripts.rclone_oauth_health import _get_decrypted_token

        mock_dir = Path("/tmp/fake_rclone_config_show")
        monkeypatch.setattr(
            "scripts.rclone_oauth_health._read_rclone_pass",
            lambda: "secret",
        )
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = (
            "[gdrive]\n"
            "type = drive\n"
            'token = {"access_token":"abc","refresh_token":"xyz","expiry":"2026-05-15T00:00:00Z"}'
        )
        with patch("scripts.rclone_oauth_health.subprocess.run", return_value=mock_result):
            raw, parsed = _get_decrypted_token()
            assert parsed is not None
            assert parsed["access_token"] == "abc"
            assert parsed["refresh_token"] == "xyz"

    def test_returns_none_when_rclone_fails(self, monkeypatch):
        from scripts.rclone_oauth_health import _get_decrypted_token

        monkeypatch.setattr(
            "scripts.rclone_oauth_health._read_rclone_pass",
            lambda: "secret",
        )
        mock_result = MagicMock()
        mock_result.returncode = 1
        mock_result.stderr = "empty token found"
        with patch("scripts.rclone_oauth_health.subprocess.run", return_value=mock_result):
            raw, parsed = _get_decrypted_token()
            assert raw is None
            assert parsed is None

    def test_returns_none_for_empty_output(self, monkeypatch):
        from scripts.rclone_oauth_health import _get_decrypted_token

        monkeypatch.setattr(
            "scripts.rclone_oauth_health._read_rclone_pass",
            lambda: "secret",
        )
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = ""
        with patch("scripts.rclone_oauth_health.subprocess.run", return_value=mock_result):
            raw, parsed = _get_decrypted_token()
            assert raw is None
            assert parsed is None

    def test_returns_none_when_rclone_not_installed(self, monkeypatch):
        from scripts.rclone_oauth_health import _get_decrypted_token

        monkeypatch.setattr(
            "scripts.rclone_oauth_health._read_rclone_pass",
            lambda: "secret",
        )
        with patch("scripts.rclone_oauth_health.subprocess.run", side_effect=FileNotFoundError):
            raw, parsed = _get_decrypted_token()
            assert raw is None
            assert parsed is None


class TestCheckConnectivity:
    def test_returns_true_when_lsd_succeeds(self, monkeypatch):
        from scripts.rclone_oauth_health import _check_connectivity

        monkeypatch.setattr(
            "scripts.rclone_oauth_health._read_rclone_pass",
            lambda: "secret",
        )
        mock_result = MagicMock()
        mock_result.returncode = 0
        with patch("scripts.rclone_oauth_health.subprocess.run", return_value=mock_result):
            assert _check_connectivity() is True

    def test_returns_false_when_lsd_fails(self, monkeypatch):
        from scripts.rclone_oauth_health import _check_connectivity

        monkeypatch.setattr(
            "scripts.rclone_oauth_health._read_rclone_pass",
            lambda: "secret",
        )
        mock_result = MagicMock()
        mock_result.returncode = 1
        with patch("scripts.rclone_oauth_health.subprocess.run", return_value=mock_result):
            assert _check_connectivity() is False


class TestFindExistingAlert:
    def test_returns_none_when_no_matching_issues(self, monkeypatch):
        from scripts.rclone_oauth_health import _find_existing_alert

        mock_sess = MagicMock()
        mock_resp = MagicMock()
        mock_resp.json.return_value = [{"title": "Other issue", "id": "abc"}]
        mock_sess.get.return_value = mock_resp
        monkeypatch.setattr("scripts.rclone_oauth_health._session", lambda: mock_sess)
        monkeypatch.setattr("scripts.rclone_oauth_health._base", lambda: "https://api.test")
        monkeypatch.setattr("scripts.rclone_oauth_health._company", lambda: "test-co")
        assert _find_existing_alert() is None

    def test_returns_issue_when_title_matches(self, monkeypatch):
        from scripts.rclone_oauth_health import _find_existing_alert

        existing = {"title": "rclone OAuth health alert — test", "id": "def"}
        mock_sess = MagicMock()
        mock_resp = MagicMock()
        mock_resp.json.return_value = [existing]
        mock_sess.get.return_value = mock_resp
        monkeypatch.setattr("scripts.rclone_oauth_health._session", lambda: mock_sess)
        monkeypatch.setattr("scripts.rclone_oauth_health._base", lambda: "https://api.test")
        monkeypatch.setattr("scripts.rclone_oauth_health._company", lambda: "test-co")
        assert _find_existing_alert() == existing

    def test_returns_none_on_api_error(self, monkeypatch):
        from scripts.rclone_oauth_health import _find_existing_alert

        mock_sess = MagicMock()
        mock_sess.get.side_effect = ConnectionError("network down")
        monkeypatch.setattr("scripts.rclone_oauth_health._session", lambda: mock_sess)
        monkeypatch.setattr("scripts.rclone_oauth_health._base", lambda: "https://api.test")
        monkeypatch.setattr("scripts.rclone_oauth_health._company", lambda: "test-co")
        assert _find_existing_alert() is None


class TestCreateAlert:
    def _setup_mocks(self, monkeypatch, post_return=None):
        mock_sess = MagicMock()
        if post_return is not None:
            mock_resp = MagicMock()
            mock_resp.json.return_value = post_return
            mock_sess.post.return_value = mock_resp
        monkeypatch.setattr("scripts.rclone_oauth_health._session", lambda: mock_sess)
        monkeypatch.setattr("scripts.rclone_oauth_health._base", lambda: "https://api.test")
        monkeypatch.setattr("scripts.rclone_oauth_health._company", lambda: "test-co")
        return mock_sess

    def test_dry_run_returns_true(self, monkeypatch, capsys):
        from scripts.rclone_oauth_health import _create_alert

        self._setup_mocks(monkeypatch)
        th = {"has_access_token": False, "has_refresh_token": False}
        result = _create_alert("test failure", "detail text", th, dry_run=True)
        assert result is True

    def test_creates_alert_for_no_access_token(self, monkeypatch):
        from scripts.rclone_oauth_health import _create_alert, CTO_AGENT_ID

        mock_sess = self._setup_mocks(
            monkeypatch, post_return={"identifier": "BTCAAAAA-999", "id": "uuid-99"}
        )
        th = {"has_access_token": False, "has_refresh_token": False}
        result = _create_alert("access_token missing", "token was cleared", th, dry_run=False)
        assert result is True
        assert mock_sess.post.call_count == 1
        payload = mock_sess.post.call_args[1]["json"]
        assert payload["priority"] == "critical"
        assert payload["assigneeAgentId"] == CTO_AGENT_ID
        assert "access_token missing" in payload["title"]

    def test_returns_false_on_api_error(self, monkeypatch):
        from scripts.rclone_oauth_health import _create_alert

        mock_sess = MagicMock()
        mock_sess.post.side_effect = ConnectionError("network down")
        monkeypatch.setattr("scripts.rclone_oauth_health._session", lambda: mock_sess)
        monkeypatch.setattr("scripts.rclone_oauth_health._base", lambda: "https://api.test")
        monkeypatch.setattr("scripts.rclone_oauth_health._company", lambda: "test-co")
        th = {"has_access_token": True, "has_refresh_token": True}
        assert _create_alert("test", "detail", th, dry_run=False) is False

    def test_includes_fix_procedure(self, monkeypatch):
        from scripts.rclone_oauth_health import _create_alert

        mock_sess = self._setup_mocks(
            monkeypatch, post_return={"identifier": "BTCAAAAA-999", "id": "uuid-99"}
        )
        th = {"has_access_token": False, "has_refresh_token": False}
        _create_alert("token_expired", "expired token", th, dry_run=False)
        payload = mock_sess.post.call_args[1]["json"]
        assert "rclone authorize" in payload["description"]
        assert "rclone-headless-auth.sh" in payload["description"]


class TestRun:
    def _setup_env(self, monkeypatch):
        monkeypatch.setenv("PAPERCLIP_API_URL", "https://api.test")
        monkeypatch.setenv("PAPERCLIP_API_KEY", "test-key")
        monkeypatch.setenv("PAPERCLIP_COMPANY_ID", "test-co")

    def _patch_rotate_and_state(self, monkeypatch):
        monkeypatch.setattr("scripts.rclone_oauth_health._rotate_log_if_needed", MagicMock())
        monkeypatch.setattr("scripts.rclone_oauth_health._save_self_state", MagicMock())
        monkeypatch.setattr("scripts.rclone_oauth_health._load_self_state", lambda: {})

    def test_healthy_token_returns_healthy(self, monkeypatch):
        from scripts.rclone_oauth_health import run

        self._setup_env(monkeypatch)
        self._patch_rotate_and_state(monkeypatch)

        token = {
            "access_token": "ya29.abc",
            "refresh_token": "1//xyz",
            "expiry": FUTURE_EXPIRY,
        }
        monkeypatch.setattr(
            "scripts.rclone_oauth_health._get_decrypted_token",
            lambda: ('{"access_token":"ya29.abc",...}', token),
        )
        monkeypatch.setattr("scripts.rclone_oauth_health._check_connectivity", lambda: True)

        result = run(dry_run=True)
        assert result["status"] == "healthy"
        assert result["alert_fired"] is False

    def test_empty_token_fires_alert(self, monkeypatch):
        from scripts.rclone_oauth_health import run

        self._setup_env(monkeypatch)
        self._patch_rotate_and_state(monkeypatch)

        token = {"access_token": "", "refresh_token": ""}
        monkeypatch.setattr(
            "scripts.rclone_oauth_health._get_decrypted_token",
            lambda: ('{"access_token":"",...}', token),
        )
        monkeypatch.setattr("scripts.rclone_oauth_health._check_connectivity", lambda: False)

        mock_sess = MagicMock()
        mock_resp = MagicMock()
        mock_resp.json.return_value = []
        mock_sess.get.return_value = mock_resp
        mock_post_resp = MagicMock()
        mock_post_resp.json.return_value = {"identifier": "BTCAAAAA-999", "id": "uuid-99"}
        mock_sess.post.return_value = mock_post_resp
        monkeypatch.setattr("scripts.rclone_oauth_health._session", lambda: mock_sess)
        monkeypatch.setattr("scripts.rclone_oauth_health._base", lambda: "https://api.test")
        monkeypatch.setattr("scripts.rclone_oauth_health._company", lambda: "test-co")

        result = run(dry_run=False)
        assert result["status"] == "alert"
        assert result["alert_reason"] == "no_access_token"
        assert result["alert_fired"] is True

    def test_existing_alert_suppresses_duplicate(self, monkeypatch):
        from scripts.rclone_oauth_health import run

        self._setup_env(monkeypatch)
        self._patch_rotate_and_state(monkeypatch)

        token = {"access_token": "", "refresh_token": ""}
        monkeypatch.setattr(
            "scripts.rclone_oauth_health._get_decrypted_token",
            lambda: ('{"access_token":"",...}', token),
        )
        monkeypatch.setattr("scripts.rclone_oauth_health._check_connectivity", lambda: False)

        mock_sess = MagicMock()
        mock_resp = MagicMock()
        mock_resp.json.return_value = [
            {"title": "rclone OAuth health alert — something", "id": "exist-1"}
        ]
        mock_sess.get.return_value = mock_resp
        monkeypatch.setattr("scripts.rclone_oauth_health._session", lambda: mock_sess)
        monkeypatch.setattr("scripts.rclone_oauth_health._base", lambda: "https://api.test")
        monkeypatch.setattr("scripts.rclone_oauth_health._company", lambda: "test-co")

        result = run(dry_run=False)
        assert result["alert_skipped"] is True
        mock_sess.post.assert_not_called()

    def test_no_config_fires_alert(self, monkeypatch):
        from scripts.rclone_oauth_health import run

        self._setup_env(monkeypatch)
        self._patch_rotate_and_state(monkeypatch)

        missing = Path("/nonexistent/rclone.conf")
        monkeypatch.setattr("scripts.rclone_oauth_health.RCLONE_CONFIG", missing)

        mock_sess = MagicMock()
        mock_resp = MagicMock()
        mock_resp.json.return_value = []
        mock_sess.get.return_value = mock_resp
        mock_post_resp = MagicMock()
        mock_post_resp.json.return_value = {"identifier": "BTCAAAAA-999", "id": "uuid-99"}
        mock_sess.post.return_value = mock_post_resp
        monkeypatch.setattr("scripts.rclone_oauth_health._session", lambda: mock_sess)
        monkeypatch.setattr("scripts.rclone_oauth_health._base", lambda: "https://api.test")
        monkeypatch.setattr("scripts.rclone_oauth_health._company", lambda: "test-co")

        result = run(dry_run=False)
        assert result["status"] == "alert"
        assert result["alert_reason"] == "no_config_file"

    def test_summary_includes_metadata(self, monkeypatch):
        from scripts.rclone_oauth_health import run

        self._setup_env(monkeypatch)
        self._patch_rotate_and_state(monkeypatch)

        token = {
            "access_token": "ya29.abc",
            "refresh_token": "1//xyz",
            "expiry": FUTURE_EXPIRY,
        }
        monkeypatch.setattr(
            "scripts.rclone_oauth_health._get_decrypted_token",
            lambda: ('{"access_token":"...",...}', token),
        )
        monkeypatch.setattr("scripts.rclone_oauth_health._check_connectivity", lambda: True)

        result = run(dry_run=True)
        assert result["status"] == "healthy"
        assert result["remote"] == "gdrive"
        assert "self_total_runs" in result
        assert "token_health" in result
