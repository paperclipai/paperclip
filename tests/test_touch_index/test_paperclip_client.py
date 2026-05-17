"""Unit tests for paperclip_client.py retry and API helpers.

All external HTTP I/O is mocked so tests run offline.
"""

from __future__ import annotations

import os
from unittest.mock import MagicMock, patch

from urllib3.util import Retry as RetryStrategy
import pytest


class TestRetryStrategy:
    """Verify the retry strategy is configured correctly."""

    def test_retry_on_session(self):
        """_session() mounts an adapter with the retry strategy."""
        from touch_index.paperclip_client import _session, _RETRY_STRATEGY

        # We need env vars for the session constructor
        with patch.dict(
            os.environ,
            {
                "PAPERCLIP_API_KEY": "test-key",
                "PAPERCLIP_API_URL": "https://api.example.com",
                "PAPERCLIP_COMPANY_ID": "test-company",
            },
            clear=True,
        ):
            s = _session()
            # HTTPAdapter uses an internal Retry object; we verify via the
            # adapter's get_connection method but the simplest check is that
            # the session has adapters mounted for both protocols.
            https_adapter = s.get_adapter("https://api.example.com/foo")
            http_adapter = s.get_adapter("http://api.example.com/foo")
            assert https_adapter.max_retries is not None
            assert http_adapter.max_retries is not None
            # Both adapters use the same retry instance
            assert https_adapter.max_retries.total == 3
            assert http_adapter.max_retries.total == 3
            assert https_adapter.max_retries.backoff_factor == 0.5
            assert http_adapter.max_retries.backoff_factor == 0.5

    def test_retry_on_board_session(self):
        """_board_session() mounts an adapter with the same retry strategy."""
        from touch_index.paperclip_client import _board_session

        with patch.dict(
            os.environ,
            {
                "PAPERCLIP_API_KEY": "test-key",
                "PAPERCLIP_API_URL": "https://api.example.com",
                "PAPERCLIP_COMPANY_ID": "test-company",
            },
            clear=True,
        ):
            s = _board_session()
            https_adapter = s.get_adapter("https://api.example.com/foo")
            assert https_adapter.max_retries.total == 3
            assert https_adapter.max_retries.backoff_factor == 0.5

    def test_retry_status_codes(self):
        """Retry should cover 408, 429, 5xx."""
        from touch_index.paperclip_client import _RETRY_STRATEGY

        assert isinstance(_RETRY_STRATEGY, RetryStrategy)
        assert 408 in _RETRY_STRATEGY.status_forcelist
        assert 429 in _RETRY_STRATEGY.status_forcelist
        assert 500 in _RETRY_STRATEGY.status_forcelist
        assert 502 in _RETRY_STRATEGY.status_forcelist
        assert 503 in _RETRY_STRATEGY.status_forcelist
        assert 504 in _RETRY_STRATEGY.status_forcelist

    def test_retry_allowed_methods(self):
        """GET, PATCH, and POST should be retryable."""
        from touch_index.paperclip_client import _RETRY_STRATEGY

        assert "GET" in _RETRY_STRATEGY.allowed_methods
        assert "PATCH" in _RETRY_STRATEGY.allowed_methods
        assert "POST" in _RETRY_STRATEGY.allowed_methods

    def test_retry_count(self):
        """Should retry up to 3 times."""
        from touch_index.paperclip_client import _RETRY_STRATEGY

        assert _RETRY_STRATEGY.total == 3


# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# _parse_iso_ts — ISO timestamp parser used across all paperclip API functions
# ---------------------------------------------------------------------------


class TestParseIsoTs:
    """Direct unit tests for _parse_iso_ts (used by get_fdr_issues, etc.)."""

    def test_z_suffix(self):
        from touch_index.paperclip_client import _parse_iso_ts

        result = _parse_iso_ts("2026-05-11T10:30:00Z")
        from datetime import timezone, datetime

        assert result == datetime(2026, 5, 11, 10, 30, 0, tzinfo=timezone.utc)

    def test_none_value(self):
        from touch_index.paperclip_client import _parse_iso_ts

        assert _parse_iso_ts(None) is None

    def test_empty_string(self):
        from touch_index.paperclip_client import _parse_iso_ts

        assert _parse_iso_ts("") is None

    def test_malformed_timestamp(self):
        """Malformed ISO string returns None instead of crashing."""
        from touch_index.paperclip_client import _parse_iso_ts

        result = _parse_iso_ts("not-a-date")
        assert result is None

    def test_non_string_value(self):
        """Non-string raw (e.g. int, list) returns None instead of AttributeError crash."""
        from touch_index.paperclip_client import _parse_iso_ts

        result = _parse_iso_ts(12345)
        assert result is None


# ---------------------------------------------------------------------------
# Timestamp filtering
# ---------------------------------------------------------------------------


class TestGetClosedNonFdrIssues:
    """get_closed_non_fdr_issues — done non-FDR issues with optional time filter."""

    def _make_issues(self, completed_ats: list[str | None]) -> list[dict]:
        return [
            {
                "id": f"id-{i}",
                "identifier": f"BTCAAAAA-{100 + i}",
                "status": "done",
                "completedAt": ts,
            }
            for i, ts in enumerate(completed_ats)
        ]

    def test_no_filter_returns_all(self):
        """Without closed_after, all non-FDR done issues are returned."""
        from touch_index.paperclip_client import get_closed_non_fdr_issues

        issues = self._make_issues([None, "2026-05-11T10:00:00Z"])
        with (
            patch("touch_index.paperclip_client._paginate", return_value=issues),
            patch("touch_index.paperclip_client._company", return_value="c"),
        ):
            result = get_closed_non_fdr_issues()
        assert len(result) == 2

    def test_includes_issues_with_recent_completed_at(self):
        """Issues with completedAt >= cutoff are included."""
        from datetime import datetime, timedelta, timezone
        from touch_index.paperclip_client import get_closed_non_fdr_issues

        now = datetime.now(timezone.utc)
        cutoff = now - timedelta(hours=1)
        issues = self._make_issues([(now - timedelta(minutes=5)).isoformat()])
        with (
            patch("touch_index.paperclip_client._paginate", return_value=issues),
            patch("touch_index.paperclip_client._company", return_value="c"),
        ):
            result = get_closed_non_fdr_issues(closed_after=cutoff)
        assert len(result) == 1

    def test_excludes_old_completed_at(self):
        """Issues with completedAt < cutoff are excluded."""
        from datetime import datetime, timedelta, timezone
        from touch_index.paperclip_client import get_closed_non_fdr_issues

        now = datetime.now(timezone.utc)
        cutoff = now - timedelta(hours=1)
        issues = self._make_issues([(now - timedelta(days=30)).isoformat()])
        with (
            patch("touch_index.paperclip_client._paginate", return_value=issues),
            patch("touch_index.paperclip_client._company", return_value="c"),
        ):
            result = get_closed_non_fdr_issues(closed_after=cutoff)
        assert len(result) == 0

    def test_includes_missing_completed_at(self):
        """NULL or missing completedAt — included (regression: was skipped)."""
        from datetime import datetime, timedelta, timezone
        from touch_index.paperclip_client import get_closed_non_fdr_issues

        cutoff = datetime.now(timezone.utc) - timedelta(hours=1)
        issues = self._make_issues([None, None])
        with (
            patch("touch_index.paperclip_client._paginate", return_value=issues),
            patch("touch_index.paperclip_client._company", return_value="c"),
        ):
            result = get_closed_non_fdr_issues(closed_after=cutoff)
        assert len(result) == 2

    def test_includes_malformed_completed_at(self):
        """Malformed completedAt — included (regression: was skipped)."""
        from datetime import datetime, timedelta, timezone
        from touch_index.paperclip_client import get_closed_non_fdr_issues

        cutoff = datetime.now(timezone.utc) - timedelta(hours=1)
        issues = self._make_issues(["not-a-date", "also-bad"])
        with (
            patch("touch_index.paperclip_client._paginate", return_value=issues),
            patch("touch_index.paperclip_client._company", return_value="c"),
        ):
            result = get_closed_non_fdr_issues(closed_after=cutoff)
        assert len(result) == 2

    def test_excludes_fdr_labelled(self):
        """FDR-labelled issues are excluded."""
        from touch_index.paperclip_client import (
            FDR_LABEL_ID,
            get_closed_non_fdr_issues,
        )

        issues = [
            {
                "id": "id-fdr",
                "identifier": "BTCAAAAA-200",
                "status": "done",
                "labelIds": [FDR_LABEL_ID],
            },
            {
                "id": "id-bug",
                "identifier": "BTCAAAAA-201",
                "status": "done",
            },
        ]
        with (
            patch("touch_index.paperclip_client._paginate", return_value=issues),
            patch("touch_index.paperclip_client._company", return_value="c"),
        ):
            result = get_closed_non_fdr_issues()
        assert [i["identifier"] for i in result] == ["BTCAAAAA-201"]


class TestGetFdrIssues:
    """get_fdr_issues — FDR-labelled issues with optional time filter."""

    def _make_issues(self, updated_ats: list[str | None]) -> list[dict]:
        from touch_index.paperclip_client import FDR_LABEL_ID

        return [
            {
                "id": f"id-{i}",
                "identifier": f"BTCAAAAA-{300 + i}",
                "labelIds": [FDR_LABEL_ID],
                "updatedAt": ts,
            }
            for i, ts in enumerate(updated_ats)
        ]

    def test_no_filter_returns_all(self):
        from touch_index.paperclip_client import FDR_LABEL_ID, get_fdr_issues

        issues = self._make_issues([None, "2026-05-11T10:00:00Z"])
        with (
            patch("touch_index.paperclip_client._paginate", return_value=issues),
            patch("touch_index.paperclip_client._company", return_value="c"),
        ):
            result = get_fdr_issues()
        assert len(result) == 2

    def test_includes_recent_updated_at(self):
        from datetime import datetime, timedelta, timezone
        from touch_index.paperclip_client import get_fdr_issues

        now = datetime.now(timezone.utc)
        cutoff = now - timedelta(hours=1)
        issues = self._make_issues([(now - timedelta(minutes=5)).isoformat()])
        with (
            patch("touch_index.paperclip_client._paginate", return_value=issues),
            patch("touch_index.paperclip_client._company", return_value="c"),
        ):
            result = get_fdr_issues(updated_after=cutoff)
        assert len(result) == 1

    def test_excludes_old_updated_at(self):
        from datetime import datetime, timedelta, timezone
        from touch_index.paperclip_client import get_fdr_issues

        now = datetime.now(timezone.utc)
        cutoff = now - timedelta(hours=1)
        issues = self._make_issues([(now - timedelta(days=30)).isoformat()])
        with (
            patch("touch_index.paperclip_client._paginate", return_value=issues),
            patch("touch_index.paperclip_client._company", return_value="c"),
        ):
            result = get_fdr_issues(updated_after=cutoff)
        assert len(result) == 0

    def test_includes_missing_updated_at(self):
        """NULL or missing updatedAt — included (regression: was skipped)."""
        from datetime import datetime, timedelta, timezone
        from touch_index.paperclip_client import get_fdr_issues

        cutoff = datetime.now(timezone.utc) - timedelta(hours=1)
        issues = self._make_issues([None, None])
        with (
            patch("touch_index.paperclip_client._paginate", return_value=issues),
            patch("touch_index.paperclip_client._company", return_value="c"),
        ):
            result = get_fdr_issues(updated_after=cutoff)
        assert len(result) == 2


class TestGetClosedBugIssues:
    """get_closed_bug_issues — done issues with bug title prefix."""

    def _make_bugs(self, completed_ats: list[str | None]) -> list[dict]:
        return [
            {
                "id": f"id-{i}",
                "identifier": f"BTCAAAAA-{400 + i}",
                "title": "Bug: test issue",
                "status": "done",
                "completedAt": ts,
            }
            for i, ts in enumerate(completed_ats)
        ]

    def test_includes_missing_completed_at(self):
        """NULL completedAt — included."""
        from datetime import datetime, timedelta, timezone
        from touch_index.paperclip_client import get_closed_bug_issues

        cutoff = datetime.now(timezone.utc) - timedelta(hours=1)
        with (
            patch(
                "touch_index.paperclip_client._paginate",
                return_value=self._make_bugs([None]),
            ),
            patch("touch_index.paperclip_client._company", return_value="c"),
        ):
            result = get_closed_bug_issues(closed_after=cutoff)
        assert len(result) == 1


class TestGetAllDoneIssues:
    """get_all_done_issues — all done issues with optional time filter."""

    def _make_issues(self, completed_ats: list[str | None]) -> list[dict]:
        return [
            {
                "id": f"id-{i}",
                "identifier": f"BTCAAAAA-{500 + i}",
                "status": "done",
                "completedAt": ts,
            }
            for i, ts in enumerate(completed_ats)
        ]

    def test_includes_missing_completed_at(self):
        """NULL completedAt — included."""
        from datetime import datetime, timedelta, timezone
        from touch_index.paperclip_client import get_all_done_issues

        cutoff = datetime.now(timezone.utc) - timedelta(hours=1)
        with (
            patch(
                "touch_index.paperclip_client._paginate",
                return_value=self._make_issues([None]),
            ),
            patch("touch_index.paperclip_client._company", return_value="c"),
        ):
            result = get_all_done_issues(completed_after=cutoff)
        assert len(result) == 1


# ---------------------------------------------------------------------------
# _paginate — core pagination helper
# ---------------------------------------------------------------------------


class TestPaginate:
    """_paginate — paginated API requests with page_size boundary."""

    def test_single_page(self):
        """When results fit in one page, no further requests are made."""
        from touch_index.paperclip_client import _paginate

        page = [{"id": "1"}, {"id": "2"}]
        with (
            patch("touch_index.paperclip_client._session") as mock_session_factory,
            patch("touch_index.paperclip_client._base", return_value="https://api.x"),
        ):
            sess = mock_session_factory.return_value.__enter__.return_value
            resp = MagicMock()
            resp.json.return_value = page
            sess.get.return_value = resp

            result = _paginate("/issues", {"status": "done"}, page_size=100)

        assert result == page
        sess.get.assert_called_once()

    def test_multi_page(self):
        """When results span multiple pages, pagination iterates."""
        from touch_index.paperclip_client import _paginate

        page1 = [{"id": str(i)} for i in range(100)]
        page2 = [{"id": "100"}]

        with (
            patch("touch_index.paperclip_client._session") as mock_session_factory,
            patch("touch_index.paperclip_client._base", return_value="https://api.x"),
        ):
            sess = mock_session_factory.return_value.__enter__.return_value
            sess.get.side_effect = [
                MagicMock(json=lambda: page1),
                MagicMock(json=lambda: page2),
            ]

            result = _paginate("/issues", {"status": "done"}, page_size=100)

        assert len(result) == 101
        assert sess.get.call_count == 2

    def test_empty_response(self):
        """Empty page stops iteration immediately."""
        from touch_index.paperclip_client import _paginate

        with (
            patch("touch_index.paperclip_client._session") as mock_session_factory,
            patch("touch_index.paperclip_client._base", return_value="https://api.x"),
        ):
            sess = mock_session_factory.return_value.__enter__.return_value
            resp = MagicMock()
            resp.json.return_value = []
            sess.get.return_value = resp

            result = _paginate("/issues", {"status": "done"})

        assert result == []
        sess.get.assert_called_once()

    def test_raises_on_http_error(self):
        """When the API returns an error status, raise_for_status is called."""
        from touch_index.paperclip_client import _paginate

        with (
            patch("touch_index.paperclip_client._session") as mock_session_factory,
            patch("touch_index.paperclip_client._base", return_value="https://api.x"),
        ):
            sess = mock_session_factory.return_value.__enter__.return_value
            resp = MagicMock()
            resp.raise_for_status.side_effect = RuntimeError("500 Server Error")
            sess.get.return_value = resp

            with pytest.raises(RuntimeError):
                _paginate("/issues", {"status": "done"})


# ---------------------------------------------------------------------------
# get_issue_by_id — single issue lookup
# ---------------------------------------------------------------------------


class TestGetIssueById:
    def test_returns_none_on_404(self):
        """404 returns None."""
        from touch_index.paperclip_client import get_issue_by_id

        with (
            patch("touch_index.paperclip_client._session") as mock_session_factory,
            patch("touch_index.paperclip_client._base", return_value="https://api.x"),
        ):
            sess = mock_session_factory.return_value.__enter__.return_value
            not_found = MagicMock()
            not_found.status_code = 404
            sess.get.return_value = not_found

            result = get_issue_by_id("missing-uuid")
            assert result is None

    def test_raises_on_non_404_error(self):
        """Non-404 errors raise the HTTP error."""
        from touch_index.paperclip_client import get_issue_by_id

        with (
            patch("touch_index.paperclip_client._session") as mock_session_factory,
            patch("touch_index.paperclip_client._base", return_value="https://api.x"),
        ):
            sess = mock_session_factory.return_value.__enter__.return_value
            err_resp = MagicMock()
            err_resp.status_code = 500
            err_resp.raise_for_status.side_effect = RuntimeError("500 error")
            sess.get.return_value = err_resp

            with pytest.raises(RuntimeError):
                get_issue_by_id("error-uuid")

    def test_returns_issue_on_success(self):
        """Successful lookup returns the issue dict."""
        from touch_index.paperclip_client import get_issue_by_id

        issue = {"id": "uuid-1", "identifier": "BTCAAAAA-100"}
        with (
            patch("touch_index.paperclip_client._session") as mock_session_factory,
            patch("touch_index.paperclip_client._base", return_value="https://api.x"),
        ):
            sess = mock_session_factory.return_value.__enter__.return_value
            ok_resp = MagicMock()
            ok_resp.status_code = 200
            ok_resp.json.return_value = issue
            sess.get.return_value = ok_resp

            result = get_issue_by_id("uuid-1")
            assert result == issue


# ---------------------------------------------------------------------------
# get_issue_by_identifier — lookup by identifier string
# ---------------------------------------------------------------------------


class TestGetIssueByIdentifier:
    def test_found(self):
        """Matching identifier returns the issue."""
        from touch_index.paperclip_client import get_issue_by_identifier

        issues = [
            {"identifier": "BTCAAAAA-100"},
            {"identifier": "BTCAAAAA-101"},
        ]
        with (
            patch("touch_index.paperclip_client._paginate", return_value=issues),
            patch("touch_index.paperclip_client._company", return_value="c"),
        ):
            result = get_issue_by_identifier("BTCAAAAA-100")
            assert result == issues[0]

    def test_not_found(self):
        """No match returns None."""
        from touch_index.paperclip_client import get_issue_by_identifier

        with (
            patch("touch_index.paperclip_client._paginate", return_value=[]),
            patch("touch_index.paperclip_client._company", return_value="c"),
        ):
            result = get_issue_by_identifier("BTCAAAAA-999")
            assert result is None


# ---------------------------------------------------------------------------
# get_all_issue_ids — batch fetch for orphan detection
# ---------------------------------------------------------------------------


class TestGetAllIssueIds:
    def test_returns_set_of_ids(self):
        from touch_index.paperclip_client import get_all_issue_ids

        issues = [
            {"id": "uuid-1"},
            {"id": "uuid-2"},
            {"id": "uuid-3"},
        ]
        with (
            patch("touch_index.paperclip_client._paginate", return_value=issues),
            patch("touch_index.paperclip_client._company", return_value="c"),
        ):
            result = get_all_issue_ids()
        assert result == {"uuid-1", "uuid-2", "uuid-3"}

    def test_empty(self):
        from touch_index.paperclip_client import get_all_issue_ids

        with (
            patch("touch_index.paperclip_client._paginate", return_value=[]),
            patch("touch_index.paperclip_client._company", return_value="c"),
        ):
            result = get_all_issue_ids()
        assert result == set()


# ---------------------------------------------------------------------------
# transition_issue_status — basic status transition
# ---------------------------------------------------------------------------


class TestTransitionIssueStatus:
    def test_patches_issue_status(self):
        from touch_index.paperclip_client import transition_issue_status

        with (
            patch("touch_index.paperclip_client._session") as mock_session_factory,
            patch("touch_index.paperclip_client._base", return_value="https://api.x"),
        ):
            sess = mock_session_factory.return_value.__enter__.return_value
            resp = MagicMock()
            sess.patch.return_value = resp

            transition_issue_status("uuid-1", "done")

        sess.patch.assert_called_once_with(
            "https://api.x/api/issues/uuid-1",
            json={"status": "done"},
            timeout=30,
        )

    def test_raises_on_error(self):
        from touch_index.paperclip_client import transition_issue_status

        with (
            patch("touch_index.paperclip_client._session") as mock_session_factory,
            patch("touch_index.paperclip_client._base", return_value="https://api.x"),
        ):
            sess = mock_session_factory.return_value.__enter__.return_value
            resp = MagicMock()
            resp.raise_for_status.side_effect = RuntimeError("403 Forbidden")
            sess.patch.return_value = resp

            with pytest.raises(RuntimeError):
                transition_issue_status("uuid-1", "done")


# ---------------------------------------------------------------------------
# transition_issue_status_board — board-level transition
# ---------------------------------------------------------------------------


class TestTransitionIssueStatusBoard:
    def test_patches_with_board_session(self):
        from touch_index.paperclip_client import transition_issue_status_board

        with (
            patch("touch_index.paperclip_client._board_session") as mock_board_factory,
            patch("touch_index.paperclip_client._base", return_value="https://api.x"),
        ):
            sess = mock_board_factory.return_value.__enter__.return_value
            resp = MagicMock()
            sess.patch.return_value = resp

            transition_issue_status_board("uuid-1", "done")

        sess.patch.assert_called_once_with(
            "https://api.x/api/issues/uuid-1",
            json={"status": "done"},
            timeout=30,
        )


# ---------------------------------------------------------------------------
# get_issue_assignee
# ---------------------------------------------------------------------------


class TestGetIssueAssignee:
    def test_with_assignee(self):
        from touch_index.paperclip_client import get_issue_assignee

        issue = {"assigneeAgentId": "agent-uuid"}
        assert get_issue_assignee(issue) == "agent-uuid"

    def test_without_assignee(self):
        from touch_index.paperclip_client import get_issue_assignee

        assert get_issue_assignee({}) is None


# ---------------------------------------------------------------------------
# get_closed_bug_issues — time filter edge case
# ---------------------------------------------------------------------------


class TestGetClosedBugIssuesExtended:
    def test_excludes_old_completed_at(self):
        """Issues with completedAt < cutoff are excluded."""
        from datetime import datetime, timedelta, timezone
        from touch_index.paperclip_client import get_closed_bug_issues

        now = datetime.now(timezone.utc)
        cutoff = now - timedelta(hours=1)
        issues = [
            {
                "id": "id-1",
                "identifier": "BTCAAAAA-400",
                "title": "Bug: test issue",
                "status": "done",
                "completedAt": (now - timedelta(days=30)).isoformat(),
            }
        ]
        with (
            patch(
                "touch_index.paperclip_client._paginate",
                return_value=issues,
            ),
            patch("touch_index.paperclip_client._company", return_value="c"),
        ):
            result = get_closed_bug_issues(closed_after=cutoff)
        assert len(result) == 0

    def test_includes_recent_completed_at(self):
        """Issues with completedAt >= cutoff are included (covers ts >= cutoff branch)."""
        from datetime import datetime, timedelta, timezone
        from touch_index.paperclip_client import get_closed_bug_issues

        now = datetime.now(timezone.utc)
        cutoff = now - timedelta(hours=1)
        issues = [
            {
                "id": "id-1",
                "identifier": "BTCAAAAA-400",
                "title": "Bug: test issue",
                "status": "done",
                "completedAt": (now - timedelta(minutes=5)).isoformat(),
            }
        ]
        with (
            patch(
                "touch_index.paperclip_client._paginate",
                return_value=issues,
            ),
            patch("touch_index.paperclip_client._company", return_value="c"),
        ):
            result = get_closed_bug_issues(closed_after=cutoff)
        assert len(result) == 1


# ---------------------------------------------------------------------------
# get_all_done_issues — time filter edge case
# ---------------------------------------------------------------------------


class TestGetAllDoneIssuesExtended:
    def test_excludes_old_completed_at(self):
        from datetime import datetime, timedelta, timezone
        from touch_index.paperclip_client import get_all_done_issues

        now = datetime.now(timezone.utc)
        cutoff = now - timedelta(hours=1)
        issues = [
            {
                "id": "id-1",
                "identifier": "BTCAAAAA-500",
                "status": "done",
                "completedAt": (now - timedelta(days=30)).isoformat(),
            }
        ]
        with (
            patch(
                "touch_index.paperclip_client._paginate",
                return_value=issues,
            ),
            patch("touch_index.paperclip_client._company", return_value="c"),
        ):
            result = get_all_done_issues(completed_after=cutoff)
        assert len(result) == 0

    def test_includes_malformed_completed_at(self):
        from datetime import datetime, timedelta, timezone
        from touch_index.paperclip_client import get_all_done_issues

        cutoff = datetime.now(timezone.utc) - timedelta(hours=1)
        issues = [
            {
                "id": "id-1",
                "identifier": "BTCAAAAA-500",
                "status": "done",
                "completedAt": "not-a-date",
            }
        ]
        with (
            patch(
                "touch_index.paperclip_client._paginate",
                return_value=issues,
            ),
            patch("touch_index.paperclip_client._company", return_value="c"),
        ):
            result = get_all_done_issues(completed_after=cutoff)
        assert len(result) == 1

    def test_includes_recent_completed_at(self):
        """Issues with completedAt >= cutoff are included (covers ts >= cutoff branch)."""
        from datetime import datetime, timedelta, timezone
        from touch_index.paperclip_client import get_all_done_issues

        now = datetime.now(timezone.utc)
        cutoff = now - timedelta(hours=1)
        issues = [
            {
                "id": "id-1",
                "identifier": "BTCAAAAA-500",
                "status": "done",
                "completedAt": (now - timedelta(minutes=5)).isoformat(),
            }
        ]
        with (
            patch(
                "touch_index.paperclip_client._paginate",
                return_value=issues,
            ),
            patch("touch_index.paperclip_client._company", return_value="c"),
        ):
            result = get_all_done_issues(completed_after=cutoff)
        assert len(result) == 1


# ---------------------------------------------------------------------------
# _board_session — key fallback
# ---------------------------------------------------------------------------


class TestBoardSession:
    def test_falls_back_to_api_key(self):
        """When BOARD_API_KEY is not set, PAPERCLIP_API_KEY is used."""
        from touch_index.paperclip_client import _board_session

        with patch.dict(
            os.environ,
            {
                "PAPERCLIP_API_KEY": "fallback-key",
                "PAPERCLIP_API_URL": "https://api.example.com",
                "PAPERCLIP_COMPANY_ID": "test-company",
            },
            clear=True,
        ):
            s = _board_session()
            assert s.headers["Authorization"] == "Bearer fallback-key"

    def test_uses_board_key_when_set(self):
        """When BOARD_API_KEY is set, it takes priority."""
        from touch_index.paperclip_client import _board_session

        with patch.dict(
            os.environ,
            {
                "PAPERCLIP_API_KEY": "regular-key",
                "PAPERCLIP_BOARD_API_KEY": "board-key",
                "PAPERCLIP_API_URL": "https://api.example.com",
                "PAPERCLIP_COMPANY_ID": "test-company",
            },
            clear=True,
        ):
            s = _board_session()
            assert s.headers["Authorization"] == "Bearer board-key"


# ---------------------------------------------------------------------------
# list_issues — basic issue listing
# ---------------------------------------------------------------------------


class TestListIssues:
    def test_default_params(self):
        from touch_index.paperclip_client import list_issues

        issues = [{"id": "1"}, {"id": "2"}]
        with (
            patch("touch_index.paperclip_client._session") as mock_session_factory,
            patch("touch_index.paperclip_client._base", return_value="https://api.x"),
            patch("touch_index.paperclip_client._company", return_value="c"),
        ):
            sess = mock_session_factory.return_value.__enter__.return_value
            resp = MagicMock()
            resp.json.return_value = issues
            sess.get.return_value = resp

            result = list_issues()

        assert result == issues
        sess.get.assert_called_once_with(
            "https://api.x/api/companies/c/issues",
            params={"limit": "200", "offset": "0"},
            timeout=30,
        )

    def test_with_status_filter(self):
        from touch_index.paperclip_client import list_issues

        with (
            patch("touch_index.paperclip_client._session") as mock_session_factory,
            patch("touch_index.paperclip_client._base", return_value="https://api.x"),
            patch("touch_index.paperclip_client._company", return_value="c"),
        ):
            sess = mock_session_factory.return_value.__enter__.return_value
            sess.get.return_value = MagicMock(json=lambda: [])

            list_issues(status="done")

        _, kwargs = sess.get.call_args
        assert kwargs["params"]["status"] == "done"

    def test_raises_on_error(self):
        from touch_index.paperclip_client import list_issues

        with (
            patch("touch_index.paperclip_client._session") as mock_session_factory,
            patch("touch_index.paperclip_client._base", return_value="https://api.x"),
            patch("touch_index.paperclip_client._company", return_value="c"),
        ):
            sess = mock_session_factory.return_value.__enter__.return_value
            resp = MagicMock()
            resp.raise_for_status.side_effect = RuntimeError("API error")
            sess.get.return_value = resp

            with pytest.raises(RuntimeError):
                list_issues()


# ---------------------------------------------------------------------------
# fetch_issue_comments
# ---------------------------------------------------------------------------


class TestFetchIssueComments:
    def test_returns_comments(self):
        from touch_index.paperclip_client import fetch_issue_comments

        comments = [{"id": "c1", "body": "Fixed src/foo.py"}]
        with (
            patch("touch_index.paperclip_client._session") as mock_session_factory,
            patch("touch_index.paperclip_client._base", return_value="https://api.x"),
        ):
            sess = mock_session_factory.return_value.__enter__.return_value
            resp = MagicMock()
            resp.json.return_value = comments
            sess.get.return_value = resp

            result = fetch_issue_comments("issue-uuid")
        assert result == comments

    def test_raises_on_error(self):
        from touch_index.paperclip_client import fetch_issue_comments

        with (
            patch("touch_index.paperclip_client._session") as mock_session_factory,
            patch("touch_index.paperclip_client._base", return_value="https://api.x"),
        ):
            sess = mock_session_factory.return_value.__enter__.return_value
            resp = MagicMock()
            resp.raise_for_status.side_effect = RuntimeError("API error")
            sess.get.return_value = resp

            with pytest.raises(RuntimeError):
                fetch_issue_comments("issue-uuid")


# ---------------------------------------------------------------------------
# _base and _company — env var readers
# ---------------------------------------------------------------------------


class TestBase:
    def test_reads_env(self):
        from touch_index.paperclip_client import _base

        with patch.dict(
            os.environ, {"PAPERCLIP_API_URL": "https://custom.url"}, clear=True
        ):
            assert _base() == "https://custom.url"


class TestCompany:
    def test_reads_env(self):
        from touch_index.paperclip_client import _company

        with patch.dict(os.environ, {"PAPERCLIP_COMPANY_ID": "my-company"}, clear=True):
            assert _company() == "my-company"


# ---------------------------------------------------------------------------
# list_live_runs — list live heartbeat runs
# ---------------------------------------------------------------------------


class TestListLiveRuns:
    def test_returns_live_runs(self):
        from touch_index.paperclip_client import list_live_runs

        runs = [
            {"id": "run-1", "status": "running"},
            {"id": "run-2", "status": "queued"},
        ]
        with (
            patch("touch_index.paperclip_client._session") as mock_session_factory,
            patch("touch_index.paperclip_client._base", return_value="https://api.x"),
            patch("touch_index.paperclip_client._company", return_value="c"),
        ):
            sess = mock_session_factory.return_value.__enter__.return_value
            resp = MagicMock()
            resp.json.return_value = runs
            sess.get.return_value = resp

            result = list_live_runs()

        assert result == runs
        sess.get.assert_called_once_with(
            "https://api.x/api/companies/c/live-runs",
            params={"minCount": "50", "limit": "50"},
            timeout=30,
        )

    def test_default_min_count_and_limit(self):
        from touch_index.paperclip_client import list_live_runs

        with (
            patch("touch_index.paperclip_client._session") as mock_session_factory,
            patch("touch_index.paperclip_client._base", return_value="https://api.x"),
            patch("touch_index.paperclip_client._company", return_value="c"),
        ):
            sess = mock_session_factory.return_value.__enter__.return_value
            sess.get.return_value = MagicMock(json=lambda: [])

            list_live_runs()

        _, kwargs = sess.get.call_args
        assert kwargs["params"]["minCount"] == "50"
        assert kwargs["params"]["limit"] == "50"

    def test_custom_min_count_and_limit(self):
        from touch_index.paperclip_client import list_live_runs

        with (
            patch("touch_index.paperclip_client._session") as mock_session_factory,
            patch("touch_index.paperclip_client._base", return_value="https://api.x"),
            patch("touch_index.paperclip_client._company", return_value="c"),
        ):
            sess = mock_session_factory.return_value.__enter__.return_value
            sess.get.return_value = MagicMock(json=lambda: [])

            list_live_runs(min_count=10, limit=5)

        _, kwargs = sess.get.call_args
        assert kwargs["params"]["minCount"] == "10"
        assert kwargs["params"]["limit"] == "5"

    def test_raises_on_error(self):
        from touch_index.paperclip_client import list_live_runs

        with (
            patch("touch_index.paperclip_client._session") as mock_session_factory,
            patch("touch_index.paperclip_client._base", return_value="https://api.x"),
            patch("touch_index.paperclip_client._company", return_value="c"),
        ):
            sess = mock_session_factory.return_value.__enter__.return_value
            resp = MagicMock()
            resp.raise_for_status.side_effect = RuntimeError("API error")
            sess.get.return_value = resp

            with pytest.raises(RuntimeError):
                list_live_runs()


# ---------------------------------------------------------------------------
# cancel_heartbeat_run — board-level cancel
# ---------------------------------------------------------------------------


class TestCancelHeartbeatRun:
    def test_returns_cancelled_run(self):
        from touch_index.paperclip_client import cancel_heartbeat_run

        cancelled = {"id": "run-1", "status": "cancelled"}
        with (
            patch("touch_index.paperclip_client._board_session") as mock_board_factory,
            patch("touch_index.paperclip_client._base", return_value="https://api.x"),
        ):
            sess = mock_board_factory.return_value.__enter__.return_value
            resp = MagicMock()
            resp.status_code = 200
            resp.json.return_value = cancelled
            sess.post.return_value = resp

            result = cancel_heartbeat_run("run-1")
        assert result == cancelled

    def test_returns_none_on_404(self):
        from touch_index.paperclip_client import cancel_heartbeat_run

        with (
            patch("touch_index.paperclip_client._board_session") as mock_board_factory,
            patch("touch_index.paperclip_client._base", return_value="https://api.x"),
        ):
            sess = mock_board_factory.return_value.__enter__.return_value
            resp = MagicMock()
            resp.status_code = 404
            sess.post.return_value = resp

            result = cancel_heartbeat_run("run-1")
        assert result is None

    def test_raises_on_error(self):
        from touch_index.paperclip_client import cancel_heartbeat_run

        with (
            patch("touch_index.paperclip_client._board_session") as mock_board_factory,
            patch("touch_index.paperclip_client._base", return_value="https://api.x"),
        ):
            sess = mock_board_factory.return_value.__enter__.return_value
            resp = MagicMock()
            resp.status_code = 500
            resp.raise_for_status.side_effect = RuntimeError("API error")
            sess.post.return_value = resp

            with pytest.raises(RuntimeError):
                cancel_heartbeat_run("run-1")


# ---------------------------------------------------------------------------
# force_release_issue — admin release
# ---------------------------------------------------------------------------


class TestForceReleaseIssue:
    def test_returns_release_result(self):
        from touch_index.paperclip_client import force_release_issue

        result = {"released": True}
        with (
            patch("touch_index.paperclip_client._board_session") as mock_board_factory,
            patch("touch_index.paperclip_client._base", return_value="https://api.x"),
        ):
            sess = mock_board_factory.return_value.__enter__.return_value
            resp = MagicMock()
            resp.status_code = 200
            resp.json.return_value = result
            sess.post.return_value = resp

            output = force_release_issue("issue-uuid")
        assert output == result

    def test_returns_none_on_404(self):
        from touch_index.paperclip_client import force_release_issue

        with (
            patch("touch_index.paperclip_client._board_session") as mock_board_factory,
            patch("touch_index.paperclip_client._base", return_value="https://api.x"),
        ):
            sess = mock_board_factory.return_value.__enter__.return_value
            resp = MagicMock()
            resp.status_code = 404
            sess.post.return_value = resp

            output = force_release_issue("issue-uuid")
        assert output is None

    def test_raises_on_error(self):
        from touch_index.paperclip_client import force_release_issue

        with (
            patch("touch_index.paperclip_client._board_session") as mock_board_factory,
            patch("touch_index.paperclip_client._base", return_value="https://api.x"),
        ):
            sess = mock_board_factory.return_value.__enter__.return_value
            resp = MagicMock()
            resp.status_code = 500
            resp.raise_for_status.side_effect = RuntimeError("API error")
            sess.post.return_value = resp

            with pytest.raises(RuntimeError):
                force_release_issue("issue-uuid")

    def test_passes_clear_assignee_params(self):
        from touch_index.paperclip_client import force_release_issue

        with (
            patch("touch_index.paperclip_client._board_session") as mock_board_factory,
            patch("touch_index.paperclip_client._base", return_value="https://api.x"),
        ):
            sess = mock_board_factory.return_value.__enter__.return_value
            sess.post.return_value = MagicMock(status_code=200, json=lambda: {})

            force_release_issue("issue-uuid", clear_assignee=True)

        url = sess.post.call_args[0][0]
        assert "clearAssignee=true" in url


class TestCheckPaperclipCredentials:
    """Tests for check_paperclip_credentials environment validation."""

    def test_returns_none_when_all_vars_present(self):
        from touch_index.paperclip_client import check_paperclip_credentials

        with patch.dict(
            os.environ,
            {
                "PAPERCLIP_API_URL": "https://api.paperclip.prod.com",
                "PAPERCLIP_API_KEY": "sk-real-token-abc123",
                "PAPERCLIP_COMPANY_ID": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
            },
            clear=True,
        ):
            result = check_paperclip_credentials()

        assert result is None

    def test_detects_missing_var(self):
        from touch_index.paperclip_client import check_paperclip_credentials

        with patch.dict(
            os.environ,
            {
                "PAPERCLIP_API_URL": "https://api.paperclip.prod.com",
                "PAPERCLIP_API_KEY": "sk-real-token-abc123",
            },
            clear=True,
        ):
            result = check_paperclip_credentials()

        assert result is not None
        assert "Missing" in result
        assert "PAPERCLIP_COMPANY_ID" in result

    def test_detects_placeholder_url(self):
        from touch_index.paperclip_client import check_paperclip_credentials

        with patch.dict(
            os.environ,
            {
                "PAPERCLIP_API_URL": "https://api.paperclip.example.com",
                "PAPERCLIP_API_KEY": "sk-real-token-abc123",
                "PAPERCLIP_COMPANY_ID": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
            },
            clear=True,
        ):
            result = check_paperclip_credentials()

        assert result is not None
        assert "placeholder" in result
        assert "example.com" in result

    def test_detects_placeholder_key(self):
        from touch_index.paperclip_client import check_paperclip_credentials

        with patch.dict(
            os.environ,
            {
                "PAPERCLIP_API_URL": "https://api.paperclip.prod.com",
                "PAPERCLIP_API_KEY": "your_paperclip_api_key_here",
                "PAPERCLIP_COMPANY_ID": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
            },
            clear=True,
        ):
            result = check_paperclip_credentials()

        assert result is not None
        assert "placeholder" in result
        assert "your_" in result

    def test_detects_zero_uuid_company_id(self):
        from touch_index.paperclip_client import check_paperclip_credentials

        with patch.dict(
            os.environ,
            {
                "PAPERCLIP_API_URL": "https://api.paperclip.prod.com",
                "PAPERCLIP_API_KEY": "sk-real-token-abc123",
                "PAPERCLIP_COMPANY_ID": "00000000-0000-0000-0000-000000000000",
            },
            clear=True,
        ):
            result = check_paperclip_credentials()

        assert result is not None
        assert "placeholder" in result
        assert "00000000" in result

    def test_detects_missing_all_vars(self):
        from touch_index.paperclip_client import check_paperclip_credentials

        with patch.dict(os.environ, {}, clear=True):
            result = check_paperclip_credentials()

        assert result is not None
        assert "Missing" in result
        assert "PAPERCLIP_API_URL" in result
        assert "PAPERCLIP_API_KEY" in result
        assert "PAPERCLIP_COMPANY_ID" in result

    def test_empty_string_treated_as_missing(self):
        from touch_index.paperclip_client import check_paperclip_credentials

        with patch.dict(
            os.environ,
            {
                "PAPERCLIP_API_URL": "",
                "PAPERCLIP_API_KEY": "",
                "PAPERCLIP_COMPANY_ID": "",
            },
            clear=True,
        ):
            result = check_paperclip_credentials()

        assert result is not None
        assert "Missing" in result
