"""Unit tests for token-gap escalation routine."""

import json
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch, MagicMock

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
import token_gap_escalation_routine as tger


class TestTokenGapDetection:
    """Tests for token gap error detection."""

    def test_detects_github_401_errors(self):
        """Should detect 401 Unauthorized errors from GitHub."""
        texts = [
            "Error: 401 Unauthorized from api.github.com",
            "api.github.com returned 401: Invalid token",
            "401 from github.com/api - check GITHUB_TOKEN",
        ]
        for text in texts:
            assert tger.is_token_gap_error(text), f"Should detect token gap: {text}"

    def test_detects_github_403_errors(self):
        """Should detect 403 Forbidden errors from GitHub."""
        texts = [
            "Error: 403 Forbidden from api.github.com",
            "api.github.com 403: token expired",
            "403 from github.com/api - permission denied",
        ]
        for text in texts:
            assert tger.is_token_gap_error(text), f"Should detect token gap: {text}"

    def test_detects_token_issues(self):
        """Should detect token/auth issues with GitHub."""
        texts = [
            "GitHub token credential expired",
            "github auth failed - invalid token",
            "github token revoked - please reconfigure",
        ]
        for text in texts:
            assert tger.is_token_gap_error(text), f"Should detect token gap: {text}"

    def test_ignores_unrelated_errors(self):
        """Should not detect unrelated errors as token gaps."""
        texts = [
            "404 Not Found",
            "Connection timeout",
            "Failed to resolve DNS",
            "Network error",
        ]
        for text in texts:
            assert not tger.is_token_gap_error(text), f"Should not detect token gap: {text}"

    def test_empty_text(self):
        """Should handle empty text gracefully."""
        assert not tger.is_token_gap_error("")
        assert not tger.is_token_gap_error(None)


class TestDeduplication:
    """Tests for escalation deduplication."""

    def test_first_escalation_allowed(self):
        """First escalation should be allowed."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmpdir_path = Path(tmpdir)
            state_file = tmpdir_path / "token_gap_state.json"

            with patch.object(tger, "STATE_FILE", state_file):
                issue_id = "test-issue-1"
                assert tger.should_escalate(issue_id), "First escalation should be allowed"

    def test_second_escalation_blocked_within_24h(self):
        """Second escalation within 24h should be blocked."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmpdir_path = Path(tmpdir)
            state_file = tmpdir_path / "token_gap_state.json"

            with patch.object(tger, "STATE_FILE", state_file):
                issue_id = "test-issue-2"

                # First escalation
                assert tger.should_escalate(issue_id)
                tger.record_escalation(issue_id)

                # Second escalation should be blocked
                assert not tger.should_escalate(issue_id), \
                    "Second escalation within 24h should be blocked"

    def test_third_escalation_allowed_after_24h(self):
        """Third escalation after 24h should be allowed."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmpdir_path = Path(tmpdir)
            state_file = tmpdir_path / "token_gap_state.json"

            with patch.object(tger, "STATE_FILE", state_file):
                issue_id = "test-issue-3"

                # First escalation
                tger.record_escalation(issue_id)

                # Mock time to be 25 hours later
                state = tger.load_state()
                old_time = datetime.now(timezone.utc) - timedelta(hours=25)
                state["escalated"][issue_id] = old_time.isoformat() + "Z"
                tger.save_state(state)

                # After 24h, escalation should be allowed again
                assert tger.should_escalate(issue_id), \
                    "Escalation should be allowed after 24h"


class TestBlockedDuration:
    """Tests for blocked duration calculation."""

    def test_calculates_duration_from_started_at(self):
        """Should calculate duration from startedAt timestamp."""
        now = datetime.now(timezone.utc)
        four_hours_ago = (now - timedelta(hours=4)).isoformat()

        issue = {
            "id": "test-1",
            "identifier": "TEST-1",
            "title": "Test issue",
            "startedAt": four_hours_ago,
        }

        duration = tger.check_blocked_duration(issue)
        assert duration >= 4.0, f"Duration should be >=4h, got {duration}h"

    def test_calculates_duration_from_created_at(self):
        """Should fall back to createdAt if startedAt is missing."""
        now = datetime.now(timezone.utc)
        five_hours_ago = (now - timedelta(hours=5)).isoformat()

        issue = {
            "id": "test-2",
            "identifier": "TEST-2",
            "title": "Test issue",
            "createdAt": five_hours_ago,
        }

        duration = tger.check_blocked_duration(issue)
        assert duration >= 5.0, f"Duration should be >=5h, got {duration}h"

    def test_returns_zero_for_missing_timestamp(self):
        """Should return 0 if both startedAt and createdAt are missing."""
        issue = {
            "id": "test-3",
            "identifier": "TEST-3",
            "title": "Test issue",
        }

        duration = tger.check_blocked_duration(issue)
        assert duration == 0.0, f"Should return 0 for missing timestamp, got {duration}"

    def test_handles_z_timezone(self):
        """Should handle ISO timestamps ending with Z."""
        now = datetime.now(timezone.utc)
        three_hours_ago = (now - timedelta(hours=3)).isoformat().replace("+00:00", "Z")

        issue = {
            "id": "test-4",
            "identifier": "TEST-4",
            "title": "Test issue",
            "startedAt": three_hours_ago,
        }

        duration = tger.check_blocked_duration(issue)
        assert duration >= 3.0, f"Should handle Z-timezone, got {duration}h"


class TestStateManagement:
    """Tests for state file operations."""

    def test_loads_nonexistent_state(self):
        """Should handle missing state file gracefully."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmpdir_path = Path(tmpdir)
            state_file = tmpdir_path / "nonexistent.json"

            with patch.object(tger, "STATE_FILE", state_file):
                state = tger.load_state()
                assert state == {"escalated": {}}, "Should return empty state for missing file"

    def test_saves_and_loads_state(self):
        """Should save and load state correctly."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmpdir_path = Path(tmpdir)
            state_file = tmpdir_path / "state.json"

            with patch.object(tger, "STATE_FILE", state_file):
                # Save state
                original_state = {
                    "escalated": {
                        "issue-1": "2026-05-30T12:00:00+00:00",
                        "issue-2": "2026-05-30T13:00:00+00:00",
                    }
                }
                tger.save_state(original_state)

                # Load and verify
                loaded_state = tger.load_state()
                assert loaded_state == original_state, "State should match after save/load"

    def test_handles_corrupted_state_file(self):
        """Should handle corrupted state file gracefully."""
        with tempfile.TemporaryDirectory() as tmpdir:
            tmpdir_path = Path(tmpdir)
            state_file = tmpdir_path / "state.json"
            state_file.write_text("{ invalid json }")

            with patch.object(tger, "STATE_FILE", state_file):
                state = tger.load_state()
                assert state == {"escalated": {}}, "Should return empty state for corrupted file"


if __name__ == "__main__":
    import pytest
    pytest.main([__file__, "-v"])
