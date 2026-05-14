"""Unit tests for touch_index.comment_extractor -- file path extraction from text.

All extraction logic is pure string processing; no external I/O needed.
"""

from __future__ import annotations

from touch_index.comment_extractor import (
    _has_allowed_prefix,
    _normalise,
    extract_files_from_text,
)


# ---------------------------------------------------------------------------
# _normalise
# ---------------------------------------------------------------------------


class TestNormalise:
    def test_no_prefix(self):
        assert _normalise("src/foo.py") == "src/foo.py"

    def test_btc_engine_v3_prefix(self):
        assert _normalise("BTC_Engine_v3/src/foo.py") == "src/foo.py"

    def test_btc_trade_engine_prefix(self):
        assert _normalise("BTC-Trade-Engine-PaperClip/src/foo.py") == "src/foo.py"

    def test_projects_prefix(self):
        """projects/<name>/... must return the path after <name>."""
        assert _normalise("projects/my-project/src/foo.py") == "src/foo.py"

    def test_projects_deep_nesting(self):
        assert _normalise("projects/foo/bar/baz/src/x.py") == "bar/baz/src/x.py"

    def test_projects_no_nested_path(self):
        """projects/<name> alone returns just the name."""
        assert _normalise("projects/foo") == "foo"

    def test_unknown_prefix_unchanged(self):
        assert _normalise("some_random/src/foo.py") == "some_random/src/foo.py"

    def test_empty_string(self):
        assert _normalise("") == ""


# ---------------------------------------------------------------------------
# _has_allowed_prefix
# ---------------------------------------------------------------------------


class TestHasAllowedPrefix:
    def test_allows_src(self):
        assert _has_allowed_prefix("src/foo/bar.py") is True

    def test_allows_tests(self):
        assert _has_allowed_prefix("tests/test_foo.py") is True

    def test_allows_scripts(self):
        assert _has_allowed_prefix("scripts/deploy.py") is True

    def test_rejects_bare_filename(self):
        assert _has_allowed_prefix("setup.py") is False

    def test_rejects_docs(self):
        assert _has_allowed_prefix("docs/guide.py") is False

    def test_rejects_alembic(self):
        assert _has_allowed_prefix("alembic/versions/abc.py") is False

    def test_rejects_dot_github(self):
        assert _has_allowed_prefix(".github/workflows/ci.py") is False

    def test_rejects_empty_string(self):
        assert _has_allowed_prefix("") is False


# ---------------------------------------------------------------------------
# extract_files_from_text
# ---------------------------------------------------------------------------


class TestExtractFilesFromText:
    def test_backtick_path(self):
        files = extract_files_from_text("Changed `src/foo.py` to fix X")
        assert files == ["src/foo.py"]

    def test_backtick_with_project_prefix(self):
        """Backtick-wrapped paths with projects/ prefix are normalised."""
        files = extract_files_from_text(
            "Changed `projects/BTC-Engine/src/foo.py` in PR #12"
        )
        assert files == ["src/foo.py"]

    def test_bare_path(self):
        files = extract_files_from_text("Modified src/foo/bar.py")
        assert files == ["src/foo/bar.py"]

    def test_bare_path_with_project_prefix(self):
        """Bare paths with projects/ prefix are handled correctly."""
        files = extract_files_from_text("Modified projects/X/src/foo.py")
        assert files == ["src/foo.py"]

    def test_multiple_files_returned_sorted(self):
        files = extract_files_from_text("Changed `src/b.py` and `src/a.py`")
        assert files == ["src/a.py", "src/b.py"]

    def test_no_paths_returns_empty(self):
        files = extract_files_from_text("No file paths here")
        assert files == []

    def test_deduplicates(self):
        files = extract_files_from_text("Changed `src/foo.py` and also `src/foo.py`")
        assert files == ["src/foo.py"]

    def test_code_extensions_only(self):
        """Non-code extensions like .txt, .md should not be extracted."""
        files = extract_files_from_text("See `README.md` and `docs/guide.txt`")
        assert files == []

    def test_repo_prefix_in_backtick(self):
        files = extract_files_from_text("Fix in `BTC_Engine_v3/src/worker.py`")
        assert files == ["src/worker.py"]

    def test_backtick_path_with_line_range(self):
        """Backtick-wrapped path with line-number suffix (e.g. file.py:229-332)."""
        files = extract_files_from_text("See `src/foo.py:229-332` for details")
        assert files == ["src/foo.py"]

    def test_backtick_path_with_single_line(self):
        files = extract_files_from_text("Fixed in `src/bar.py:42`")
        assert files == ["src/bar.py"]

    def test_backtick_path_with_line_number_and_prefix(self):
        """Line-number suffix combined with repo prefix inside backticks."""
        files = extract_files_from_text("Changed `BTC_Engine_v3/src/foo.py:10-20`")
        assert files == ["src/foo.py"]

    def test_rejects_bare_filename_without_source_prefix(self):
        files = extract_files_from_text("Changed `setup.py` to fix X")
        assert files == []

    def test_allows_path_with_known_prefix(self):
        files = extract_files_from_text("Changed `src/git_extractor.py`")
        assert files == ["src/git_extractor.py"]


# ---------------------------------------------------------------------------
# extract_files_from_comments
# ---------------------------------------------------------------------------


class TestExtractFilesFromComments:
    def test_aggregates_across_multiple_comments(self):
        from touch_index.comment_extractor import extract_files_from_comments

        comments = [
            {"body": "Changed `src/foo.py` in PR #1"},
            {"body": "Also touched `src/bar.py`"},
        ]
        files = extract_files_from_comments(comments)
        assert files == ["src/bar.py", "src/foo.py"]

    def test_deduplicates_across_comments(self):
        from touch_index.comment_extractor import extract_files_from_comments

        comments = [
            {"body": "Changed `src/foo.py`"},
            {"body": "Re-fixed `src/foo.py`"},
        ]
        files = extract_files_from_comments(comments)
        assert files == ["src/foo.py"]

    def test_no_paths_returns_empty(self):
        from touch_index.comment_extractor import extract_files_from_comments

        comments = [{"body": "LGTM"}, {"body": "Approved"}]
        assert extract_files_from_comments(comments) == []

    def test_empty_comment_list(self):
        from touch_index.comment_extractor import extract_files_from_comments

        assert extract_files_from_comments([]) == []

    def test_comment_without_body_key(self):
        from touch_index.comment_extractor import extract_files_from_comments

        comments = [{"id": "1"}, {"body": "Changed `src/a.py`"}]
        files = extract_files_from_comments(comments)
        assert files == ["src/a.py"]


# ---------------------------------------------------------------------------
# fetch_and_extract  (unit — mocks paperclip_client._session / _base)
# ---------------------------------------------------------------------------


class TestFetchAndExtract:
    def test_returns_files_from_api_response(self):
        from unittest.mock import patch
        from touch_index.comment_extractor import fetch_and_extract

        comments = [
            {"body": "Fixed in `src/worker.py`"},
            {"body": "Also `src/db.py`"},
        ]

        with (
            patch(
                "touch_index.paperclip_client.fetch_issue_comments",
                return_value=comments,
            ) as mock_fetch,
        ):
            files = fetch_and_extract("issue-uuid-1")

        assert files == ["src/db.py", "src/worker.py"]
        mock_fetch.assert_called_once_with("issue-uuid-1")

    def test_empty_comments_returns_empty(self):
        from unittest.mock import patch
        from touch_index.comment_extractor import fetch_and_extract

        with (
            patch(
                "touch_index.paperclip_client.fetch_issue_comments",
                return_value=[],
            ) as mock_fetch,
        ):
            assert fetch_and_extract("issue-uuid-2") == []
        mock_fetch.assert_called_once_with("issue-uuid-2")

    def test_api_error_propagates(self):
        from unittest.mock import patch
        import pytest
        from touch_index.comment_extractor import fetch_and_extract

        with (
            patch(
                "touch_index.paperclip_client.fetch_issue_comments",
                side_effect=RuntimeError("API timeout"),
            ) as mock_fetch,
        ):
            with pytest.raises(RuntimeError, match="API timeout"):
                fetch_and_extract("issue-uuid-3")
        mock_fetch.assert_called_once_with("issue-uuid-3")

    def test_http_error_raises(self):
        from unittest.mock import patch
        import pytest
        from requests import HTTPError
        from touch_index.comment_extractor import fetch_and_extract

        with (
            patch(
                "touch_index.paperclip_client.fetch_issue_comments",
                side_effect=HTTPError("403 Forbidden"),
            ) as mock_fetch,
        ):
            with pytest.raises(HTTPError, match="403 Forbidden"):
                fetch_and_extract("issue-uuid-4")
        mock_fetch.assert_called_once_with("issue-uuid-4")


# ---------------------------------------------------------------------------
# fetch_issue_comments  (unit — mocks paperclip_client._session / _base)
# ---------------------------------------------------------------------------


class TestFetchIssueComments:
    def test_returns_comments_from_api(self):
        from unittest.mock import MagicMock, patch
        from touch_index.paperclip_client import fetch_issue_comments

        mock_resp = MagicMock()
        mock_resp.json.return_value = [
            {"id": "c1", "body": "Fixed it", "createdAt": "2026-05-11T10:00:00Z"},
            {
                "id": "c2",
                "body": "Also touched src/db.py",
                "createdAt": "2026-05-11T10:01:00Z",
            },
        ]
        mock_sess = MagicMock()
        mock_sess.__enter__.return_value = mock_sess
        mock_sess.get.return_value = mock_resp

        with (
            patch("touch_index.paperclip_client._base", return_value="https://api.x"),
            patch("touch_index.paperclip_client._session", return_value=mock_sess),
        ):
            comments = fetch_issue_comments("issue-uuid-1")

        assert len(comments) == 2
        assert comments[0]["id"] == "c1"
        assert comments[1]["id"] == "c2"
        mock_sess.get.assert_called_once_with(
            "https://api.x/api/issues/issue-uuid-1/comments", timeout=30
        )

    def test_empty_comments(self):
        from unittest.mock import MagicMock, patch
        from touch_index.paperclip_client import fetch_issue_comments

        mock_resp = MagicMock()
        mock_resp.json.return_value = []
        mock_sess = MagicMock()
        mock_sess.__enter__.return_value = mock_sess
        mock_sess.get.return_value = mock_resp

        with (
            patch("touch_index.paperclip_client._base", return_value="https://api.x"),
            patch("touch_index.paperclip_client._session", return_value=mock_sess),
        ):
            assert fetch_issue_comments("empty-issue") == []

    def test_http_error_raises(self):
        from unittest.mock import MagicMock, patch
        import pytest
        from requests import HTTPError
        from touch_index.paperclip_client import fetch_issue_comments

        mock_resp = MagicMock()
        mock_resp.raise_for_status.side_effect = HTTPError("500 Server Error")
        mock_sess = MagicMock()
        mock_sess.__enter__.return_value = mock_sess
        mock_sess.get.return_value = mock_resp

        with (
            patch("touch_index.paperclip_client._base", return_value="https://api.x"),
            patch("touch_index.paperclip_client._session", return_value=mock_sess),
        ):
            with pytest.raises(HTTPError, match="500 Server Error"):
                fetch_issue_comments("error-issue")
