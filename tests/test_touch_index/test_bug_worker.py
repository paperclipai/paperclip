"""Unit tests for the bug touch-index ingestion worker.

All external I/O (DB engine, Paperclip API, git subprocess) is mocked so these
tests run offline without a PostgreSQL instance or network.
"""

from __future__ import annotations

import tempfile
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock, call, patch

import pytest

from touch_index.bug_worker import (
    BugIngestionResult,
    _load_unindexable_ids,
    _save_unindexable_ids,
    _parse_completed_at,
    _set_catchup_tracker_path,
    catch_up_eligible_bug_issues,
    ingest_bug_issue,
    process_bug_issue,
    run_bug_worker,
)


# ---------------------------------------------------------------------------
# _parse_completed_at
# ---------------------------------------------------------------------------


class TestParseCompletedAt:
    def test_z_suffix(self):
        result = _parse_completed_at({"completedAt": "2026-05-11T10:30:00Z"})
        assert result == datetime(2026, 5, 11, 10, 30, 0, tzinfo=timezone.utc)

    def test_missing_key(self):
        assert _parse_completed_at({}) is None

    def test_none_value(self):
        assert _parse_completed_at({"completedAt": None}) is None

    def test_empty_string(self):
        assert _parse_completed_at({"completedAt": ""}) is None

    def test_malformed_timestamp(self):
        """Malformed completedAt returns None instead of crashing."""
        result = _parse_completed_at(
            {"completedAt": "not-a-date", "identifier": "BTCAAAAA-999"}
        )
        assert result is None

    def test_non_string_value(self):
        """Non-string completedAt (e.g. int, list) returns None instead of crashing."""
        result = _parse_completed_at(
            {"completedAt": 12345, "identifier": "BTCAAAAA-888"}
        )
        assert result is None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _mock_engine():
    """Return a mock SQLAlchemy engine whose context-manager .begin() and .connect() work."""
    conn = MagicMock()
    ctx = MagicMock()
    ctx.__enter__ = MagicMock(return_value=conn)
    ctx.__exit__ = MagicMock(return_value=False)
    engine = MagicMock()
    engine.begin = MagicMock(return_value=ctx)
    engine.connect = MagicMock(return_value=ctx)
    return engine, conn


ISSUE_ID = "cccccccc-0000-0000-0000-000000000001"
ISSUE_IDENTIFIER = "BTCAAAAA-1202"
COMPLETED_AT = datetime(2026, 5, 11, 12, 0, 0, tzinfo=timezone.utc)


# ---------------------------------------------------------------------------
# ingest_bug_issue
# ---------------------------------------------------------------------------


class TestIngestBugIssue:
    def test_ingest_uses_git_when_available(self):
        """Git returns files -> source is 'git', comment API not called."""
        engine, conn = _mock_engine()
        git_files = ["src/touch_index/bug_worker.py", "src/touch_index/db.py"]

        with (
            patch(
                "touch_index.bug_worker.get_files_for_issue", return_value=git_files
            ) as mock_git,
            patch("touch_index.bug_worker.fetch_and_extract") as mock_comments,
        ):
            result = ingest_bug_issue(engine, ISSUE_ID, ISSUE_IDENTIFIER, COMPLETED_AT)

        assert result.source == "git"
        assert result.files_indexed == 2
        assert result.skipped_no_commits is False
        mock_comments.assert_not_called()
        conn.execute.assert_called_once()

    def test_ingest_falls_back_to_comments(self):
        """Git returns empty -> comment extractor returns files -> source is 'comments', rows upserted."""
        engine, conn = _mock_engine()
        comment_files = ["src/touch_index/bug_worker.py"]

        with (
            patch("touch_index.bug_worker.get_files_for_issue", return_value=[]),
            patch(
                "touch_index.bug_worker.fetch_and_extract", return_value=comment_files
            ) as mock_comments,
        ):
            result = ingest_bug_issue(engine, ISSUE_ID, ISSUE_IDENTIFIER, COMPLETED_AT)

        assert result.source == "comments"
        assert result.files_indexed == 1
        assert result.skipped_no_commits is False
        mock_comments.assert_called_once_with(ISSUE_ID)
        conn.execute.assert_called_once()

    def test_ingest_falls_back_to_description(self):
        """Git and comments both empty, description has files -> source is 'description'."""
        engine, conn = _mock_engine()
        desc = "Fixed bug in `src/touch_index/bug_worker.py` and src/touch_index/db.py"

        with (
            patch("touch_index.bug_worker.get_files_for_issue", return_value=[]),
            patch("touch_index.bug_worker.fetch_and_extract", return_value=[]),
            patch(
                "touch_index.bug_worker.extract_files_from_text",
                return_value=["src/touch_index/bug_worker.py", "src/touch_index/db.py"],
            ) as mock_extract,
        ):
            result = ingest_bug_issue(
                engine, ISSUE_ID, ISSUE_IDENTIFIER, COMPLETED_AT, description=desc
            )

        assert result.source == "description"
        assert result.files_indexed == 2
        assert result.skipped_no_commits is False
        mock_extract.assert_called_once_with(desc)
        conn.execute.assert_called_once()

    def test_ingest_skips_description_when_git_has_files(self):
        """Git has files -> description is not consulted even if provided."""
        engine, conn = _mock_engine()
        desc = "Some description with `src/ignored.py`"

        with (
            patch(
                "touch_index.bug_worker.get_files_for_issue",
                return_value=["src/git_file.py"],
            ),
            patch("touch_index.bug_worker.fetch_and_extract") as mock_comments,
            patch("touch_index.bug_worker.extract_files_from_text") as mock_extract,
        ):
            result = ingest_bug_issue(
                engine, ISSUE_ID, ISSUE_IDENTIFIER, COMPLETED_AT, description=desc
            )

        assert result.source == "git"
        assert result.files_indexed == 1
        mock_comments.assert_not_called()
        mock_extract.assert_not_called()

    def test_ingest_skips_description_when_comments_have_files(self):
        """Comments have files -> description is not consulted even if provided."""
        engine, conn = _mock_engine()
        desc = "Some description with `src/ignored.py`"

        with (
            patch("touch_index.bug_worker.get_files_for_issue", return_value=[]),
            patch(
                "touch_index.bug_worker.fetch_and_extract",
                return_value=["src/comment_file.py"],
            ) as mock_comments,
            patch("touch_index.bug_worker.extract_files_from_text") as mock_extract,
        ):
            result = ingest_bug_issue(
                engine, ISSUE_ID, ISSUE_IDENTIFIER, COMPLETED_AT, description=desc
            )

        assert result.source == "comments"
        assert result.files_indexed == 1
        mock_comments.assert_called_once_with(ISSUE_ID)
        mock_extract.assert_not_called()

    def test_ingest_skips_when_both_empty(self):
        """Git and comments both empty -> skipped_no_commits=True, source 'none', nothing inserted."""
        engine, conn = _mock_engine()

        with (
            patch("touch_index.bug_worker.get_files_for_issue", return_value=[]),
            patch("touch_index.bug_worker.fetch_and_extract", return_value=[]),
        ):
            result = ingest_bug_issue(engine, ISSUE_ID, ISSUE_IDENTIFIER, COMPLETED_AT)

        assert result.source == "none"
        assert result.files_indexed == 0
        assert result.skipped_no_commits is True
        conn.execute.assert_not_called()

    def test_upsert_rows_contain_required_fields(self):
        """Each upserted row must carry id, file_path, bug_issue_id, bug_identifier, closed_at, source, updated_at."""
        engine, conn = _mock_engine()
        files = ["src/touch_index/bug_worker.py", "src/touch_index/db.py"]

        with (
            patch("touch_index.bug_worker.get_files_for_issue", return_value=files),
            patch("touch_index.bug_worker.fetch_and_extract", return_value=[]),
        ):
            ingest_bug_issue(engine, ISSUE_ID, ISSUE_IDENTIFIER, COMPLETED_AT)

        rows = conn.execute.call_args[0][1]
        assert len(rows) == 2
        for row in rows:
            assert "id" in row
            assert row["file_path"] in files
            assert row["bug_issue_id"] == ISSUE_ID
            assert row["bug_identifier"] == ISSUE_IDENTIFIER
            assert row["closed_at"] == COMPLETED_AT
            assert row["source"] == "git"
            assert "updated_at" in row

    def test_null_closed_at_accepted(self):
        engine, conn = _mock_engine()

        with (
            patch(
                "touch_index.bug_worker.get_files_for_issue", return_value=["src/x.py"]
            ),
        ):
            result = ingest_bug_issue(
                engine, ISSUE_ID, ISSUE_IDENTIFIER, completed_at=None
            )

        rows = conn.execute.call_args[0][1]
        assert rows[0]["closed_at"] is None
        assert result.files_indexed == 1

    def test_source_field_on_result(self):
        """BugIngestionResult.source is present and correct for each code path."""
        engine, _ = _mock_engine()

        # git path
        with (
            patch(
                "touch_index.bug_worker.get_files_for_issue", return_value=["src/a.py"]
            ),
            patch("touch_index.bug_worker.fetch_and_extract", return_value=[]),
        ):
            r_git = ingest_bug_issue(engine, ISSUE_ID, ISSUE_IDENTIFIER, COMPLETED_AT)
        assert hasattr(r_git, "source")
        assert r_git.source == "git"

        # comments path
        with (
            patch("touch_index.bug_worker.get_files_for_issue", return_value=[]),
            patch(
                "touch_index.bug_worker.fetch_and_extract", return_value=["src/b.py"]
            ),
        ):
            r_comments = ingest_bug_issue(
                engine, ISSUE_ID, ISSUE_IDENTIFIER, COMPLETED_AT
            )
        assert hasattr(r_comments, "source")
        assert r_comments.source == "comments"

        # description path
        with (
            patch("touch_index.bug_worker.get_files_for_issue", return_value=[]),
            patch("touch_index.bug_worker.fetch_and_extract", return_value=[]),
            patch(
                "touch_index.bug_worker.extract_files_from_text",
                return_value=["src/c.py"],
            ),
        ):
            r_desc = ingest_bug_issue(
                engine,
                ISSUE_ID,
                ISSUE_IDENTIFIER,
                COMPLETED_AT,
                description="Some desc",
            )
        assert hasattr(r_desc, "source")
        assert r_desc.source == "description"

        # none path
        with (
            patch("touch_index.bug_worker.get_files_for_issue", return_value=[]),
            patch("touch_index.bug_worker.fetch_and_extract", return_value=[]),
        ):
            r_none = ingest_bug_issue(engine, ISSUE_ID, ISSUE_IDENTIFIER, COMPLETED_AT)
        assert hasattr(r_none, "source")
        assert r_none.source == "none"

    def test_row_ids_are_unique_uuids(self):
        engine, conn = _mock_engine()

        with (
            patch(
                "touch_index.bug_worker.get_files_for_issue",
                return_value=["src/a.py", "src/b.py", "src/c.py"],
            ),
        ):
            ingest_bug_issue(engine, "id-xyz", "BTCAAAAA-700", None)

        rows = conn.execute.call_args[0][1]
        ids = [r["id"] for r in rows]
        assert len(ids) == len(set(ids)), "each row must have a unique UUID"

    def test_source_persisted_in_upsert_rows(self):
        """source column is set to 'git' or 'comments' in each upsert row."""
        engine, conn = _mock_engine()

        # git path
        with (
            patch(
                "touch_index.bug_worker.get_files_for_issue",
                return_value=["src/a.py"],
            ),
            patch("touch_index.bug_worker.fetch_and_extract", return_value=[]),
        ):
            ingest_bug_issue(engine, ISSUE_ID, ISSUE_IDENTIFIER, COMPLETED_AT)
        rows_git = conn.execute.call_args[0][1]
        for r in rows_git:
            assert r["source"] == "git"

        # comments path
        conn.reset_mock()
        with (
            patch("touch_index.bug_worker.get_files_for_issue", return_value=[]),
            patch(
                "touch_index.bug_worker.fetch_and_extract",
                return_value=["src/b.py"],
            ),
        ):
            ingest_bug_issue(engine, ISSUE_ID, ISSUE_IDENTIFIER, COMPLETED_AT)
        rows_comments = conn.execute.call_args[0][1]
        for r in rows_comments:
            assert r["source"] == "comments"

        # description path
        conn.reset_mock()
        with (
            patch("touch_index.bug_worker.get_files_for_issue", return_value=[]),
            patch("touch_index.bug_worker.fetch_and_extract", return_value=[]),
            patch(
                "touch_index.bug_worker.extract_files_from_text",
                return_value=["src/c.py"],
            ),
        ):
            ingest_bug_issue(
                engine,
                ISSUE_ID,
                ISSUE_IDENTIFIER,
                COMPLETED_AT,
                description="Some desc",
            )
        rows_desc = conn.execute.call_args[0][1]
        for r in rows_desc:
            assert r["source"] == "description"


# ---------------------------------------------------------------------------
# run_bug_worker — batch orchestration
# ---------------------------------------------------------------------------


class TestRunBugWorker:
    def _issues(self, count: int = 2) -> list[dict]:
        return [
            {
                "id": f"cccccccc-0000-0000-0000-{i:012d}",
                "identifier": f"BTCAAAAA-{1200 + i}",
                "completedAt": "2026-05-11T12:00:00Z",
            }
            for i in range(count)
        ]

    def test_returns_one_result_per_issue(self):
        engine, _ = _mock_engine()

        with (
            patch(
                "touch_index.bug_worker.get_files_for_issue", return_value=["src/a.py"]
            ),
            patch("touch_index.bug_worker.fetch_and_extract", return_value=[]),
        ):
            results = run_bug_worker(engine, self._issues(3))

        assert len(results) == 3
        assert all(isinstance(r, BugIngestionResult) for r in results)

    def test_continues_after_per_issue_error(self):
        engine, _ = _mock_engine()
        issues = self._issues(2)

        def _side_effect(identifier):
            if "1200" in identifier:
                raise RuntimeError("Simulated git error")
            return ["src/ok.py"]

        with (
            patch(
                "touch_index.bug_worker.get_files_for_issue", side_effect=_side_effect
            ),
            patch("touch_index.bug_worker.fetch_and_extract", return_value=[]),
        ):
            results = run_bug_worker(engine, issues)

        # First issue raised, so only the second produces a result
        assert len(results) == 1

    def test_skipped_count_matches_no_files_issues(self):
        engine, _ = _mock_engine()

        with (
            patch("touch_index.bug_worker.get_files_for_issue", return_value=[]),
            patch("touch_index.bug_worker.fetch_and_extract", return_value=[]),
        ):
            results = run_bug_worker(engine, self._issues(4))

        skipped = sum(1 for r in results if r.skipped_no_commits)
        assert skipped == 4

    def test_total_files_indexed(self):
        engine, _ = _mock_engine()

        with (
            patch(
                "touch_index.bug_worker.get_files_for_issue",
                return_value=["src/a.py", "src/b.py"],
            ),
            patch("touch_index.bug_worker.fetch_and_extract", return_value=[]),
        ):
            results = run_bug_worker(engine, self._issues(3))

        assert sum(r.files_indexed for r in results) == 6

    def test_null_completed_at_is_accepted(self):
        """Issues without completedAt must not crash -- closed_at is nullable."""
        engine, _ = _mock_engine()
        issues = [
            {"id": ISSUE_ID, "identifier": ISSUE_IDENTIFIER}
        ]  # no completedAt key

        with (
            patch(
                "touch_index.bug_worker.get_files_for_issue", return_value=["src/a.py"]
            ),
            patch("touch_index.bug_worker.fetch_and_extract", return_value=[]),
        ):
            results = run_bug_worker(engine, issues)

        assert len(results) == 1
        assert results[0].files_indexed == 1

    def test_empty_issue_list(self):
        engine, _ = _mock_engine()
        results = run_bug_worker(engine, [])
        assert results == []

    def test_missing_completed_at_parsed_as_none(self):
        engine, conn = _mock_engine()

        with (
            patch(
                "touch_index.bug_worker.get_files_for_issue", return_value=["src/z.py"]
            ),
        ):
            run_bug_worker(engine, [{"id": "id-x", "identifier": "BTCAAAAA-X"}])

        rows = conn.execute.call_args[0][1]
        assert rows[0]["closed_at"] is None


# ---------------------------------------------------------------------------
# process_bug_issue — single-issue webhook entry point
# ---------------------------------------------------------------------------


class TestProcessBugIssue:
    def test_fetches_and_ingests_issue(self):
        """process_bug_issue fetches issue from API and delegates to ingest_bug_issue."""
        engine, conn = _mock_engine()
        issue = {
            "id": ISSUE_ID,
            "identifier": ISSUE_IDENTIFIER,
            "status": "done",
            "completedAt": "2026-05-11T12:00:00Z",
        }
        files = ["src/touch_index/bug_worker.py"]

        with (
            patch(
                "touch_index.bug_worker.get_issue_by_id", return_value=issue
            ) as mock_get,
            patch(
                "touch_index.bug_worker.get_files_for_issue", return_value=files
            ) as mock_git,
            patch("touch_index.bug_worker.fetch_and_extract") as mock_comments,
        ):
            result = process_bug_issue(engine, ISSUE_ID)

        assert result is not None
        assert result.files_indexed == 1
        assert result.issue_identifier == ISSUE_IDENTIFIER
        mock_get.assert_called_once_with(ISSUE_ID)
        mock_comments.assert_not_called()
        conn.execute.assert_called_once()

    def test_returns_none_when_issue_not_found(self):
        """When get_issue_by_id returns None, process_bug_issue returns None."""
        engine, _ = _mock_engine()

        with patch("touch_index.bug_worker.get_issue_by_id", return_value=None):
            result = process_bug_issue(engine, "nonexistent-uuid")

        assert result is None

    def test_skips_fdr_labelled_issues(self):
        """FDR-labelled issues should be skipped (handled by FR worker)."""
        engine, _ = _mock_engine()
        issue = {
            "id": ISSUE_ID,
            "identifier": ISSUE_IDENTIFIER,
            "status": "done",
            "labelIds": ["d523cb2d-acd9-423d-b87a-bb79cee42c40"],
        }

        with (
            patch("touch_index.bug_worker.get_issue_by_id", return_value=issue),
        ):
            result = process_bug_issue(engine, ISSUE_ID)

        assert result is None

    def test_handles_missing_completed_at(self):
        """Issue without completedAt should not crash."""
        engine, conn = _mock_engine()
        issue = {
            "id": ISSUE_ID,
            "identifier": ISSUE_IDENTIFIER,
            "status": "done",
        }

        with (
            patch("touch_index.bug_worker.get_issue_by_id", return_value=issue),
            patch(
                "touch_index.bug_worker.get_files_for_issue",
                return_value=["src/foo.py"],
            ),
        ):
            result = process_bug_issue(engine, ISSUE_ID)

        assert result is not None
        assert result.files_indexed == 1
        rows = conn.execute.call_args[0][1]
        assert rows[0]["closed_at"] is None

    def test_filters_out_fdr_label_ids(self):
        """Non-FDR issues with other labels should pass through."""
        engine, conn = _mock_engine()
        issue = {
            "id": ISSUE_ID,
            "identifier": ISSUE_IDENTIFIER,
            "status": "done",
            "labelIds": ["some-other-label-uuid"],
            "completedAt": "2026-05-11T12:00:00Z",
        }

        with (
            patch("touch_index.bug_worker.get_issue_by_id", return_value=issue),
            patch(
                "touch_index.bug_worker.get_files_for_issue",
                return_value=["src/bar.py"],
            ),
        ):
            result = process_bug_issue(engine, ISSUE_ID)

        assert result is not None
        assert result.files_indexed == 1

    def test_accepts_non_done_issues(self):
        """Non-done issues are now accepted (caller handles transition)."""
        engine, conn = _mock_engine()
        issue = {
            "id": ISSUE_ID,
            "identifier": ISSUE_IDENTIFIER,
            "status": "in_progress",
        }

        with (
            patch("touch_index.bug_worker.get_issue_by_id", return_value=issue),
            patch(
                "touch_index.bug_worker.get_files_for_issue",
                return_value=["src/foo.py"],
            ),
            patch("touch_index.bug_worker.fetch_and_extract", return_value=[]),
        ):
            result = process_bug_issue(engine, ISSUE_ID)

        assert result is not None
        assert result.files_indexed == 1


class TestBugWorkerDryRun:
    def test_dry_run_skips_db_upsert(self):
        """When dry_run=True, the DB upsert is not called but files are reported."""
        engine, conn = _mock_engine()
        files = ["src/touch_index/bug_worker.py", "src/touch_index/db.py"]

        with (
            patch(
                "touch_index.bug_worker.get_files_for_issue", return_value=files
            ) as mock_git,
        ):
            result = ingest_bug_issue(
                engine, ISSUE_ID, ISSUE_IDENTIFIER, COMPLETED_AT, dry_run=True
            )

        assert result.source == "git"
        assert result.files_indexed == 2
        assert result.skipped_no_commits is False
        conn.execute.assert_not_called()
        mock_git.assert_called_once()

    def test_dry_run_with_comments_fallback(self):
        """Dry-run with comments fallback should still extract but not upsert."""
        engine, conn = _mock_engine()
        comment_files = ["src/touch_index/bug_worker.py"]

        with (
            patch("touch_index.bug_worker.get_files_for_issue", return_value=[]),
            patch(
                "touch_index.bug_worker.fetch_and_extract", return_value=comment_files
            ),
        ):
            result = ingest_bug_issue(
                engine, ISSUE_ID, ISSUE_IDENTIFIER, COMPLETED_AT, dry_run=True
            )

        assert result.source == "comments"
        assert result.files_indexed == 1
        assert result.skipped_no_commits is False
        conn.execute.assert_not_called()

    def test_dry_run_suppresses_db_upserts_in_batch(self):
        """When dry_run=True on batch, DB upsert is skipped for all issues."""
        engine, conn = _mock_engine()

        with (
            patch(
                "touch_index.bug_worker.get_files_for_issue",
                return_value=["src/a.py", "src/b.py"],
            ),
        ):
            results = run_bug_worker(engine, _issues(2), dry_run=True)

        assert len(results) == 2
        assert all(not r.skipped_no_commits for r in results)
        assert sum(r.files_indexed for r in results) == 4
        conn.execute.assert_not_called()

    def test_dry_run_passed_through_process_bug_issue(self):
        """dry_run=True on process_bug_issue is passed through to ingest_bug_issue."""
        engine, conn = _mock_engine()
        issue = {
            "id": ISSUE_ID,
            "identifier": ISSUE_IDENTIFIER,
            "status": "done",
            "completedAt": "2026-05-11T12:00:00Z",
        }

        with (
            patch("touch_index.bug_worker.get_issue_by_id", return_value=issue),
            patch(
                "touch_index.bug_worker.get_files_for_issue",
                return_value=["src/foo.py"],
            ),
        ):
            result = process_bug_issue(engine, ISSUE_ID, dry_run=True)

        assert result is not None
        assert result.files_indexed == 1
        conn.execute.assert_not_called()


def _issues(count: int = 2) -> list[dict]:
    return [
        {
            "id": f"cccccccc-0000-0000-0000-{i:012d}",
            "identifier": f"BTCAAAAA-{1200 + i}",
            "completedAt": "2026-05-11T12:00:00Z",
        }
        for i in range(count)
    ]


# ---------------------------------------------------------------------------
# main() — CLI entry point
# ---------------------------------------------------------------------------


class TestMain:
    """Tests for _run_bug_cli() CLI entry point (formerly bug_worker.main())."""

    def test_main_issue_id_calls_process_bug_issue(self, monkeypatch):
        """When --issue-id is provided, process_bug_issue is called."""
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()
        result = BugIngestionResult(
            issue_id=ISSUE_ID,
            issue_identifier="BTCAAAAA-100",
            files_indexed=2,
            source="git",
            skipped_no_commits=False,
            issue_status="done",
        )

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.bug_worker.process_bug_issue", return_value=result
            ) as mock_process,
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues"
            ) as mock_fetch,
            patch(
                "touch_index.paperclip_client.transition_issue_status_board"
            ) as mock_transition,
        ):
            monkeypatch.setattr(
                "sys.argv",
                ["touch_index", "--issue-id", "uuid-1"],
            )
            main()

        mock_process.assert_called_once_with(engine, "uuid-1", dry_run=False)
        mock_fetch.assert_not_called()
        mock_transition.assert_called_once_with(ISSUE_ID, "done")

    def test_main_issue_id_non_done_skips_transition(self, monkeypatch, caplog):
        """When --issue-id resolves to a non-done issue, transition is skipped."""
        import logging
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()
        result = BugIngestionResult(
            issue_id=ISSUE_ID,
            issue_identifier="BTCAAAAA-100",
            files_indexed=2,
            source="git",
            skipped_no_commits=False,
            issue_status="in_progress",
        )

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.bug_worker.process_bug_issue", return_value=result
            ) as mock_process,
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues"
            ) as mock_fetch,
            patch(
                "touch_index.paperclip_client.transition_issue_status_board"
            ) as mock_transition,
            caplog.at_level(logging.INFO),
        ):
            monkeypatch.setattr(
                "sys.argv",
                ["touch_index", "--issue-id", "uuid-1"],
            )
            main()

        mock_process.assert_called_once_with(engine, "uuid-1", dry_run=False)
        mock_fetch.assert_not_called()
        mock_transition.assert_not_called()
        assert any("skipping transition to done" in r.message for r in caplog.records)

    def test_main_issue_id_not_found_logs(self, monkeypatch, caplog):
        """When process_bug_issue returns None, a message is logged."""
        import logging
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch("touch_index.bug_worker.process_bug_issue", return_value=None),
            patch("touch_index.paperclip_client.get_closed_non_fdr_issues"),
            caplog.at_level(logging.INFO),
        ):
            monkeypatch.setattr(
                "sys.argv",
                ["touch_index", "--issue-id", "missing-uuid"],
            )
            main()

        assert any("No bug issue found" in r.message for r in caplog.records)

    def test_main_issue_id_dry_run(self, monkeypatch):
        """--dry-run is passed through to process_bug_issue."""
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()
        result = BugIngestionResult(
            issue_id=ISSUE_ID,
            issue_identifier="BTCAAAAA-100",
            files_indexed=2,
            source="git",
            skipped_no_commits=False,
            issue_status="done",
        )

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.bug_worker.process_bug_issue", return_value=result
            ) as mock_process,
            patch("touch_index.paperclip_client.get_closed_non_fdr_issues"),
        ):
            monkeypatch.setattr(
                "sys.argv",
                ["touch_index", "--issue-id", "uuid-1", "--dry-run"],
            )
            main()

        mock_process.assert_called_once_with(engine, "uuid-1", dry_run=True)

    def test_main_polling_calls_run_bug_worker(self, monkeypatch):
        """When no --issue-id, run_bug_worker is called with non-FDR issues."""
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()
        issues = [
            {
                "id": "id-1",
                "identifier": "BTCAAAAA-100",
                "completedAt": "2026-05-11T10:00:00Z",
            },
        ]

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues",
                return_value=issues,
            ),
            patch(
                "touch_index.bug_worker.run_bug_worker",
                return_value=[
                    BugIngestionResult(
                        issue_id="id-1",
                        issue_identifier="BTCAAAAA-100",
                        files_indexed=2,
                        source="git",
                        skipped_no_commits=False,
                        issue_status="done",
                    )
                ],
            ) as mock_worker,
            patch(
                "touch_index.paperclip_client.transition_issue_status_board",
            ) as mock_transition,
            patch(
                "touch_index.bug_worker.catch_up_eligible_bug_issues",
                return_value=[],
            ),
        ):
            monkeypatch.setattr(
                "sys.argv",
                ["touch_index"],
            )
            main()

        mock_worker.assert_called_once()
        args, kwargs = mock_worker.call_args
        assert args[0] is engine
        assert args[1] == issues
        assert kwargs.get("dry_run") is False
        mock_transition.assert_called_once_with("id-1", "done")

    def test_main_polling_dry_run(self, monkeypatch):
        """--dry-run is passed through to run_bug_worker."""
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()
        issues = [
            {
                "id": "id-1",
                "identifier": "BTCAAAAA-100",
                "completedAt": "2026-05-11T10:00:00Z",
            }
        ]

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues",
                return_value=issues,
            ),
            patch(
                "touch_index.bug_worker.run_bug_worker",
                return_value=[],
            ) as mock_worker,
            patch(
                "touch_index.paperclip_client.transition_issue_status_board",
            ) as mock_transition,
            patch(
                "touch_index.bug_worker.catch_up_eligible_bug_issues",
                return_value=[],
            ),
        ):
            monkeypatch.setattr(
                "sys.argv",
                ["touch_index", "--dry-run"],
            )
            main()

        mock_worker.assert_called_once()
        _, kwargs = mock_worker.call_args
        assert kwargs.get("dry_run") is True
        mock_transition.assert_not_called()

    def test_main_health_check_failure_exits(self, monkeypatch):
        """When health_check returns False, SystemExit is raised."""
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=False),
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues"
            ) as mock_fetch,
        ):
            monkeypatch.setattr(
                "sys.argv",
                ["touch_index"],
            )
            with pytest.raises(SystemExit) as exc_info:
                main()

        assert exc_info.value.code == 1
        mock_fetch.assert_not_called()

    def test_main_health_check_failure_emits_json_summary(self, monkeypatch, capsys):
        """--json-summary with health check failure emits JSON before SystemExit."""
        import json
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=False),
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues"
            ) as mock_fetch,
        ):
            monkeypatch.setattr(
                "sys.argv",
                ["touch_index", "--json-summary"],
            )
            with pytest.raises(SystemExit) as exc_info:
                main()

        assert exc_info.value.code == 1
        mock_fetch.assert_not_called()
        captured = capsys.readouterr()
        data = json.loads(captured.out.strip())
        assert data["worker"] == "bug"
        assert data["mode"] == "polling"

    def test_main_credential_check_failure_exits(self, monkeypatch):
        """When check_paperclip_credentials returns an error, SystemExit(1) is raised."""
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.paperclip_client.check_paperclip_credentials",
                return_value="Missing PAPERCLIP_API_KEY",
            ),
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues"
            ) as mock_fetch,
        ):
            monkeypatch.setattr("sys.argv", ["touch_index"])
            with pytest.raises(SystemExit) as exc_info:
                main()

        assert exc_info.value.code == 1
        mock_fetch.assert_not_called()

    def test_main_credential_check_failure_emits_json_summary(
        self, monkeypatch, capsys
    ):
        """--json-summary with credential check failure emits JSON before SystemExit."""
        import json
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.paperclip_client.check_paperclip_credentials",
                return_value="Missing PAPERCLIP_API_KEY",
            ),
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues"
            ) as mock_fetch,
        ):
            monkeypatch.setattr("sys.argv", ["touch_index", "--json-summary"])
            with pytest.raises(SystemExit) as exc_info:
                main()

        assert exc_info.value.code == 1
        mock_fetch.assert_not_called()
        captured = capsys.readouterr()
        data = json.loads(captured.out.strip())
        assert data["worker"] == "bug"
        assert data["mode"] == "polling"

    def test_main_no_issues_returns_early(self, monkeypatch, caplog):
        """When no closed non-FDR issues found, run_bug_worker is never called."""
        import logging
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues",
                return_value=[],
            ),
            patch("touch_index.bug_worker.run_bug_worker") as mock_worker,
            patch(
                "touch_index.bug_worker.catch_up_eligible_bug_issues",
                return_value=[],
            ) as mock_catchup,
            caplog.at_level(logging.INFO),
        ):
            monkeypatch.setattr(
                "sys.argv",
                ["touch_index"],
            )
            main()

        mock_worker.assert_not_called()
        mock_catchup.assert_called_once()
        assert any("Nothing to do" in r.message for r in caplog.records)

    def test_main_no_issues_calls_catch_up(self, monkeypatch, caplog):
        """When no issues, catch_up_eligible_bug_issues is called."""
        import logging
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()
        catchup_result = BugIngestionResult(
            issue_id="catchup-id",
            issue_identifier="BTCAAAAA-300",
            files_indexed=2,
            source="git",
            skipped_no_commits=False,
            issue_status="done",
        )

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues",
                return_value=[],
            ),
            patch("touch_index.bug_worker.run_bug_worker") as mock_worker,
            patch(
                "touch_index.bug_worker.catch_up_eligible_bug_issues",
                return_value=[catchup_result],
            ) as mock_catchup,
            caplog.at_level(logging.INFO),
        ):
            monkeypatch.setattr("sys.argv", ["touch_index"])
            main()

        mock_worker.assert_not_called()
        mock_catchup.assert_called_once()
        assert any("Catch-up indexed" in r.message for r in caplog.records)

    def test_main_polling_calls_catch_up_after_worker(self, monkeypatch):
        """When issues exist, catch-up is called after run_bug_worker."""
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()
        issues = [
            {
                "id": "id-1",
                "identifier": "BTCAAAAA-101",
                "completedAt": "2026-05-11T10:00:00Z",
            },
        ]

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues",
                return_value=issues,
            ),
            patch(
                "touch_index.bug_worker.run_bug_worker",
                return_value=[
                    BugIngestionResult(
                        issue_id="id-1",
                        issue_identifier="BTCAAAAA-101",
                        files_indexed=2,
                        source="git",
                        skipped_no_commits=False,
                        issue_status="done",
                    )
                ],
            ) as mock_worker,
            patch(
                "touch_index.bug_worker.catch_up_eligible_bug_issues",
                return_value=[],
            ) as mock_catchup,
            patch(
                "touch_index.paperclip_client.transition_issue_status_board",
            ) as mock_transition,
        ):
            monkeypatch.setattr("sys.argv", ["touch_index"])
            main()

        mock_worker.assert_called_once()
        mock_catchup.assert_called_once()
        mock_transition.assert_called_once_with("id-1", "done")

    def test_main_catch_up_results_extended(self, monkeypatch, caplog):
        """Catch-up results are included in total files and skipped counts."""
        import logging
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()
        results = [
            BugIngestionResult(
                issue_id="id-1",
                issue_identifier="BTCAAAAA-101",
                files_indexed=3,
                source="git",
                skipped_no_commits=False,
                issue_status="done",
            ),
        ]
        catchup_results = [
            BugIngestionResult(
                issue_id="id-cu",
                issue_identifier="BTCAAAAA-201",
                files_indexed=1,
                source="git",
                skipped_no_commits=False,
                issue_status="done",
            ),
            BugIngestionResult(
                issue_id="id-cu2",
                issue_identifier="BTCAAAAA-202",
                files_indexed=0,
                source="none",
                skipped_no_commits=True,
                issue_status="done",
            ),
        ]

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues",
                return_value=[
                    {
                        "id": "id-1",
                        "identifier": "BTCAAAAA-101",
                        "completedAt": "2026-05-11T10:00:00Z",
                    },
                ],
            ),
            patch("touch_index.bug_worker.run_bug_worker", return_value=results),
            patch(
                "touch_index.bug_worker.catch_up_eligible_bug_issues",
                return_value=catchup_results,
            ),
            patch("touch_index.paperclip_client.transition_issue_status_board"),
            caplog.at_level(logging.INFO),
        ):
            monkeypatch.setattr("sys.argv", ["touch_index"])
            main()

        # 3 from worker + 1 from catch-up = 4 total files (the 0-file catch-up doesn't add)
        # 3 results total: 1 worker + 2 catch-up
        summary_logs = [r for r in caplog.records if "issues processed" in r.message]
        assert len(summary_logs) == 1
        msg = summary_logs[0].message
        assert "3 issues" in msg
        assert "4 files" in msg
        assert "1 skipped" in msg

    def test_main_catch_up_results_not_transitioned(self, monkeypatch):
        """Catch-up results must not be transitioned to done (already done issues)."""
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()
        issues = [
            {
                "id": "id-1",
                "identifier": "BTCAAAAA-101",
                "completedAt": "2026-05-11T10:00:00Z",
            },
        ]
        results = [
            BugIngestionResult(
                issue_id="id-1",
                issue_identifier="BTCAAAAA-101",
                files_indexed=2,
                source="git",
                skipped_no_commits=False,
                issue_status="done",
            ),
        ]
        catchup_results = [
            BugIngestionResult(
                issue_id="catchup-uuid",
                issue_identifier="BTCAAAAA-201",
                files_indexed=1,
                source="git",
                skipped_no_commits=False,
                issue_status="done",
            ),
        ]

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues",
                return_value=issues,
            ),
            patch("touch_index.bug_worker.run_bug_worker", return_value=results),
            patch(
                "touch_index.bug_worker.catch_up_eligible_bug_issues",
                return_value=catchup_results,
            ),
            patch(
                "touch_index.paperclip_client.transition_issue_status_board",
            ) as mock_transition,
        ):
            monkeypatch.setattr("sys.argv", ["touch_index"])
            main()

        # Only the worker result should be transitioned, not the catch-up result
        mock_transition.assert_called_once_with("id-1", "done")

    def test_main_no_issues_catch_up_error_logged(self, monkeypatch, caplog):
        """When catch_up_eligible_bug_issues raises, error is logged and worker continues."""
        import logging
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues",
                return_value=[],
            ),
            patch("touch_index.bug_worker.run_bug_worker") as mock_worker,
            patch(
                "touch_index.bug_worker.catch_up_eligible_bug_issues",
                side_effect=RuntimeError("API timeout"),
            ),
            caplog.at_level(logging.ERROR),
        ):
            monkeypatch.setattr("sys.argv", ["touch_index"])
            main()

        mock_worker.assert_not_called()
        assert any(
            "Catch-up eligible bug issues failed" in r.message for r in caplog.records
        )

    def test_main_polling_catch_up_error_logged(self, monkeypatch, caplog):
        """Polling path: catch_up_eligible_bug_issues raises, error logged, worker continues."""
        import logging
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()
        issues = [
            {
                "id": "id-1",
                "identifier": "BTCAAAAA-101",
                "completedAt": "2026-05-11T10:00:00Z",
            },
        ]
        worker_results = [
            BugIngestionResult(
                issue_id="id-1",
                issue_identifier="BTCAAAAA-101",
                files_indexed=2,
                source="git",
                skipped_no_commits=False,
                issue_status="done",
            ),
        ]

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues",
                return_value=issues,
            ),
            patch(
                "touch_index.bug_worker.run_bug_worker",
                return_value=worker_results,
            ),
            patch(
                "touch_index.bug_worker.catch_up_eligible_bug_issues",
                side_effect=RuntimeError("API timeout"),
            ),
            patch(
                "touch_index.paperclip_client.transition_issue_status_board",
            ) as mock_transition,
            caplog.at_level(logging.ERROR),
        ):
            monkeypatch.setattr("sys.argv", ["touch_index"])
            main()

        assert any(
            "Catch-up eligible bug issues failed" in r.message for r in caplog.records
        )
        mock_transition.assert_called_once_with("id-1", "done")

    def test_main_catch_up_dry_run(self, monkeypatch):
        """--dry-run is passed through to catch_up_eligible_bug_issues."""
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues",
                return_value=[],
            ),
            patch("touch_index.bug_worker.run_bug_worker") as mock_worker,
            patch(
                "touch_index.bug_worker.catch_up_eligible_bug_issues",
                return_value=[],
            ) as mock_catchup,
        ):
            monkeypatch.setattr("sys.argv", ["touch_index", "--dry-run"])
            main()

        mock_worker.assert_not_called()
        mock_catchup.assert_called_once()
        _, kwargs = mock_catchup.call_args
        assert kwargs.get("dry_run") is True

    def test_main_catch_up_no_issues_with_validate_passed(self, monkeypatch, caplog):
        """--validate with no issues runs quality checks after catch-up."""
        import logging
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues",
                return_value=[],
            ),
            patch("touch_index.bug_worker.run_bug_worker") as mock_worker,
            patch(
                "touch_index.bug_worker.catch_up_eligible_bug_issues",
                return_value=[],
            ) as mock_catchup,
            patch("touch_index.quality.run_bug_quality_checks") as mock_quality,
            caplog.at_level(logging.INFO),
        ):
            mock_quality.return_value.passed = True
            monkeypatch.setattr("sys.argv", ["touch_index", "--validate"])
            main()

        mock_worker.assert_not_called()
        mock_catchup.assert_called_once()
        mock_quality.assert_called_once()
        assert any("VALIDATION PASSED" in r.message for r in caplog.records)

    def test_main_summary_counts_files_and_skipped(self, monkeypatch, caplog):
        """Log summary reflects total files indexed and skipped count."""
        import logging
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()
        issues = [
            {
                "id": "id-1",
                "identifier": "BTCAAAAA-101",
                "completedAt": "2026-05-11T10:00:00Z",
            },
            {
                "id": "id-2",
                "identifier": "BTCAAAAA-102",
                "completedAt": "2026-05-11T10:00:00Z",
            },
        ]
        results = [
            BugIngestionResult(
                issue_id="id-1",
                issue_identifier="BTCAAAAA-101",
                files_indexed=3,
                source="git",
                skipped_no_commits=False,
                issue_status="done",
            ),
            BugIngestionResult(
                issue_id="id-2",
                issue_identifier="BTCAAAAA-102",
                files_indexed=0,
                source="none",
                skipped_no_commits=True,
                issue_status="done",
            ),
        ]

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues",
                return_value=issues,
            ),
            patch("touch_index.bug_worker.run_bug_worker", return_value=results),
            patch(
                "touch_index.paperclip_client.transition_issue_status_board",
            ) as mock_transition,
            patch(
                "touch_index.bug_worker.catch_up_eligible_bug_issues",
                return_value=[],
            ),
            caplog.at_level(logging.INFO),
        ):
            monkeypatch.setattr(
                "sys.argv",
                ["touch_index"],
            )
            main()

        assert mock_transition.call_count == 2
        mock_transition.assert_has_calls(
            [
                call("id-1", "done"),
                call("id-2", "done"),
            ]
        )
        summary_logs = [r for r in caplog.records if "issues processed" in r.message]
        assert len(summary_logs) == 1
        msg = summary_logs[0].message
        assert "2 issues" in msg
        assert "3 files" in msg
        assert "1 skipped" in msg

    # -------------------------------------------------------------------
    # --validate flag (polling mode)
    # -------------------------------------------------------------------

    def test_main_validate_polling_passed(self, monkeypatch, caplog):
        """--validate with issues: validation runs and passes."""
        import logging
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()
        issues = [
            {
                "id": "id-1",
                "identifier": "BTCAAAAA-101",
                "completedAt": "2026-05-11T10:00:00Z",
            },
        ]

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues",
                return_value=issues,
            ),
            patch(
                "touch_index.bug_worker.run_bug_worker",
                return_value=[
                    BugIngestionResult(
                        issue_id="id-1",
                        issue_identifier="BTCAAAAA-101",
                        files_indexed=2,
                        source="git",
                        skipped_no_commits=False,
                        issue_status="done",
                    )
                ],
            ),
            patch("touch_index.quality.run_bug_quality_checks") as mock_quality,
            patch(
                "touch_index.paperclip_client.transition_issue_status_board",
            ) as mock_transition,
            patch(
                "touch_index.bug_worker.catch_up_eligible_bug_issues",
                return_value=[],
            ),
            caplog.at_level(logging.INFO),
        ):
            mock_quality.return_value.passed = True
            monkeypatch.setattr("sys.argv", ["touch_index", "--validate"])
            main()

        mock_quality.assert_called_once()
        mock_transition.assert_called_once_with("id-1", "done")
        assert any("VALIDATION PASSED" in r.message for r in caplog.records)

    def test_main_validate_polling_failed(self, monkeypatch):
        """--validate with issues: validation failure exits non-zero."""
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()
        issues = [
            {
                "id": "id-1",
                "identifier": "BTCAAAAA-101",
                "completedAt": "2026-05-11T10:00:00Z",
            },
        ]

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues",
                return_value=issues,
            ),
            patch(
                "touch_index.bug_worker.run_bug_worker",
                return_value=[
                    BugIngestionResult(
                        issue_id="id-1",
                        issue_identifier="BTCAAAAA-101",
                        files_indexed=2,
                        source="git",
                        skipped_no_commits=False,
                        issue_status="done",
                    )
                ],
            ),
            patch("touch_index.quality.run_bug_quality_checks") as mock_quality,
            patch(
                "touch_index.paperclip_client.transition_issue_status_board",
            ) as mock_transition,
            patch(
                "touch_index.bug_worker.catch_up_eligible_bug_issues",
                return_value=[],
            ),
        ):
            mock_quality.return_value.passed = False
            monkeypatch.setattr("sys.argv", ["touch_index", "--validate"])
            with pytest.raises(SystemExit) as exc_info:
                main()

        assert exc_info.value.code == 1
        mock_transition.assert_called_once_with("id-1", "done")

    def test_main_validate_no_issues_passed(self, monkeypatch, caplog):
        """--validate with no issues: validation runs on existing data."""
        import logging
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues",
                return_value=[],
            ),
            patch("touch_index.bug_worker.run_bug_worker") as mock_worker,
            patch("touch_index.quality.run_bug_quality_checks") as mock_quality,
            patch(
                "touch_index.bug_worker.catch_up_eligible_bug_issues",
                return_value=[],
            ),
            caplog.at_level(logging.INFO),
        ):
            mock_quality.return_value.passed = True
            monkeypatch.setattr("sys.argv", ["touch_index", "--validate"])
            main()

        mock_worker.assert_not_called()
        mock_quality.assert_called_once()
        assert any("VALIDATION PASSED" in r.message for r in caplog.records)

    def test_main_validate_no_issues_failed(self, monkeypatch):
        """--validate with no issues: validation failure exits non-zero."""
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues",
                return_value=[],
            ),
            patch("touch_index.bug_worker.run_bug_worker") as mock_worker,
            patch("touch_index.quality.run_bug_quality_checks") as mock_quality,
            patch(
                "touch_index.bug_worker.catch_up_eligible_bug_issues",
                return_value=[],
            ),
        ):
            mock_quality.return_value.passed = False
            monkeypatch.setattr("sys.argv", ["touch_index", "--validate"])
            with pytest.raises(SystemExit) as exc_info:
                main()

        assert exc_info.value.code == 1
        mock_worker.assert_not_called()

    def test_main_polling_api_error_exits_nonzero(self, monkeypatch):
        """Polling mode: get_closed_non_fdr_issues error raises SystemExit(1)."""
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues",
                side_effect=RuntimeError("API timeout"),
            ),
            patch("touch_index.bug_worker.run_bug_worker") as mock_worker,
            patch(
                "touch_index.paperclip_client.transition_issue_status_board"
            ) as mock_transition,
        ):
            monkeypatch.setattr("sys.argv", ["touch_index"])
            with pytest.raises(SystemExit) as exc_info:
                main()

        assert exc_info.value.code == 1
        mock_worker.assert_not_called()
        mock_transition.assert_not_called()

    def test_main_polling_api_error_emits_json_summary(self, monkeypatch, capsys):
        """Polling mode: API error with --json-summary emits JSON before exit."""
        import json
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues",
                side_effect=RuntimeError("API timeout"),
            ),
            patch("touch_index.bug_worker.run_bug_worker") as mock_worker,
            patch(
                "touch_index.paperclip_client.transition_issue_status_board"
            ) as mock_transition,
        ):
            monkeypatch.setattr("sys.argv", ["touch_index", "--json-summary"])
            with pytest.raises(SystemExit) as exc_info:
                main()

        assert exc_info.value.code == 1
        mock_worker.assert_not_called()
        mock_transition.assert_not_called()
        captured = capsys.readouterr()
        data = json.loads(captured.out.strip())
        assert data["worker"] == "bug"
        assert data["mode"] == "polling"

    def test_main_validate_no_issues_failed_with_json_summary(
        self, monkeypatch, capsys
    ):
        """--json-summary --validate with no issues: emits JSON summary before exit."""
        import json
        from touch_index.__main__ import _run_bug_cli as main
        from touch_index.quality import BugQualityReport

        engine = MagicMock()
        report = BugQualityReport(
            coverage=None,
            freshness=None,
            consistency=None,
            passed=False,
        )

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues",
                return_value=[],
            ),
            patch("touch_index.bug_worker.run_bug_worker") as mock_worker,
            patch("touch_index.quality.run_bug_quality_checks", return_value=report),
            patch(
                "touch_index.bug_worker.catch_up_eligible_bug_issues",
                return_value=[],
            ),
        ):
            monkeypatch.setattr(
                "sys.argv", ["touch_index", "--validate", "--json-summary"]
            )
            with pytest.raises(SystemExit) as exc_info:
                main()

        assert exc_info.value.code == 1
        mock_worker.assert_not_called()
        captured = capsys.readouterr()
        data = json.loads(captured.out.strip())
        assert data["worker"] == "bug"
        assert data["mode"] == "polling"
        assert data["dry_run"] is False
        assert data["quality"] == {"passed": False}

    def test_main_validate_stale_days_polling(self, monkeypatch):
        """--stale-days is passed through to run_bug_quality_checks in polling mode."""
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()
        issues = [
            {
                "id": "id-1",
                "identifier": "BTCAAAAA-101",
                "completedAt": "2026-05-11T10:00:00Z",
            },
        ]
        results = [
            BugIngestionResult(
                issue_identifier="BTCAAAAA-101",
                issue_id="id-1",
                files_indexed=2,
                source="git",
                skipped_no_commits=False,
                issue_status="done",
            ),
        ]

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues",
                return_value=issues,
            ),
            patch("touch_index.bug_worker.run_bug_worker", return_value=results),
            patch("touch_index.quality.run_bug_quality_checks") as mock_quality,
            patch("touch_index.paperclip_client.transition_issue_status_board"),
            patch(
                "touch_index.bug_worker.catch_up_eligible_bug_issues",
                return_value=[],
            ),
        ):
            mock_quality.return_value.passed = True
            monkeypatch.setattr(
                "sys.argv", ["touch_index", "--validate", "--stale-days", "60"]
            )
            main()

        mock_quality.assert_called_once_with(engine, stale_threshold_days=60)

    def test_main_validate_stale_days_no_issues(self, monkeypatch):
        """--stale-days with no issues still passes argument to quality checks."""
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues",
                return_value=[],
            ),
            patch("touch_index.bug_worker.run_bug_worker") as mock_worker,
            patch("touch_index.quality.run_bug_quality_checks") as mock_quality,
            patch(
                "touch_index.bug_worker.catch_up_eligible_bug_issues",
                return_value=[],
            ),
        ):
            mock_quality.return_value.passed = True
            monkeypatch.setattr(
                "sys.argv", ["touch_index", "--validate", "--stale-days", "90"]
            )
            main()

        mock_worker.assert_not_called()
        mock_quality.assert_called_once_with(engine, stale_threshold_days=90)

    def test_main_validate_stale_days_issue_id(self, monkeypatch):
        """--stale-days with --issue-id passes argument to quality checks."""
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()
        result = BugIngestionResult(
            issue_identifier="BTCAAAAA-100",
            issue_id="uuid-1",
            files_indexed=2,
            source="git",
            skipped_no_commits=False,
            issue_status="done",
        )

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch("touch_index.bug_worker.process_bug_issue", return_value=result),
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues"
            ) as mock_fetch,
            patch("touch_index.quality.run_bug_quality_checks") as mock_quality,
            patch("touch_index.paperclip_client.transition_issue_status_board"),
        ):
            mock_quality.return_value.passed = True
            monkeypatch.setattr(
                "sys.argv",
                [
                    "touch_index",
                    "--issue-id",
                    "uuid-1",
                    "--validate",
                    "--stale-days",
                    "120",
                ],
            )
            main()

        mock_fetch.assert_not_called()
        mock_quality.assert_called_once_with(engine, stale_threshold_days=120)

    # -------------------------------------------------------------------
    # --validate with --issue-id (single-issue mode)
    # -------------------------------------------------------------------

    def test_main_validate_issue_id_passed(self, monkeypatch, caplog):
        """--validate --issue-id: validation runs after single-issue processing."""
        import logging
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()
        result = BugIngestionResult(
            issue_id=ISSUE_ID,
            issue_identifier="BTCAAAAA-100",
            files_indexed=2,
            source="git",
            skipped_no_commits=False,
            issue_status="done",
        )

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch("touch_index.bug_worker.process_bug_issue", return_value=result),
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues"
            ) as mock_fetch,
            patch("touch_index.quality.run_bug_quality_checks") as mock_quality,
            patch(
                "touch_index.paperclip_client.transition_issue_status_board"
            ) as mock_transition,
            caplog.at_level(logging.INFO),
        ):
            mock_quality.return_value.passed = True
            monkeypatch.setattr(
                "sys.argv", ["touch_index", "--issue-id", "uuid-1", "--validate"]
            )
            main()

        mock_fetch.assert_not_called()
        mock_quality.assert_called_once()
        mock_transition.assert_called_once_with(ISSUE_ID, "done")
        assert any("VALIDATION PASSED" in r.message for r in caplog.records)

    def test_main_validate_issue_id_failed(self, monkeypatch):
        """--validate --issue-id: validation failure exits non-zero."""
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()
        result = BugIngestionResult(
            issue_id=ISSUE_ID,
            issue_identifier="BTCAAAAA-100",
            files_indexed=2,
            source="git",
            skipped_no_commits=False,
            issue_status="done",
        )

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch("touch_index.bug_worker.process_bug_issue", return_value=result),
            patch("touch_index.paperclip_client.get_closed_non_fdr_issues"),
            patch("touch_index.quality.run_bug_quality_checks") as mock_quality,
            patch(
                "touch_index.paperclip_client.transition_issue_status_board"
            ) as mock_transition,
        ):
            mock_quality.return_value.passed = False
            monkeypatch.setattr(
                "sys.argv", ["touch_index", "--issue-id", "uuid-1", "--validate"]
            )
            with pytest.raises(SystemExit) as exc_info:
                main()

        assert exc_info.value.code == 1
        mock_transition.assert_called_once_with(ISSUE_ID, "done")

    def test_main_validate_issue_id_not_found_skips_validation(
        self, monkeypatch, caplog
    ):
        """--validate --issue-id when issue not found: validation is skipped."""
        import logging
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch("touch_index.bug_worker.process_bug_issue", return_value=None),
            patch("touch_index.paperclip_client.get_closed_non_fdr_issues"),
            patch("touch_index.quality.run_bug_quality_checks") as mock_quality,
            caplog.at_level(logging.INFO),
        ):
            mock_quality.return_value.passed = True
            monkeypatch.setattr(
                "sys.argv", ["touch_index", "--issue-id", "missing", "--validate"]
            )
            main()

        mock_quality.assert_not_called()

    def test_main_validate_not_called_without_flag(self, monkeypatch):
        """Without --validate, quality checks are not called."""
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()
        issues = [
            {
                "id": "id-1",
                "identifier": "BTCAAAAA-101",
                "completedAt": "2026-05-11T10:00:00Z",
            },
        ]

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues",
                return_value=issues,
            ),
            patch(
                "touch_index.bug_worker.run_bug_worker",
                return_value=[
                    BugIngestionResult(
                        issue_id="id-1",
                        issue_identifier="BTCAAAAA-101",
                        files_indexed=2,
                        source="git",
                        skipped_no_commits=False,
                        issue_status="done",
                    )
                ],
            ),
            patch("touch_index.quality.run_bug_quality_checks") as mock_quality,
            patch(
                "touch_index.paperclip_client.transition_issue_status_board",
            ) as mock_transition,
            patch(
                "touch_index.bug_worker.catch_up_eligible_bug_issues",
                return_value=[],
            ),
        ):
            monkeypatch.setattr("sys.argv", ["touch_index"])
            main()

        mock_quality.assert_not_called()
        mock_transition.assert_called_once_with("id-1", "done")

    def test_main_transitions_done_issues(self, monkeypatch, caplog):
        """Polling path: only done issues are transitioned; non-done issues are skipped."""
        from touch_index.__main__ import _run_bug_cli as main
        import logging

        engine = MagicMock()
        issues = [
            {
                "id": "id-1",
                "identifier": "BTCAAAAA-101",
                "status": "done",
                "completedAt": "2026-05-11T10:00:00Z",
            },
            {
                "id": "id-2",
                "identifier": "BTCAAAAA-102",
                "status": "in_progress",
                "completedAt": "2026-05-11T10:00:00Z",
            },
        ]
        results = [
            BugIngestionResult(
                issue_id="id-1",
                issue_identifier="BTCAAAAA-101",
                files_indexed=2,
                source="git",
                skipped_no_commits=False,
                issue_status="done",
            ),
            BugIngestionResult(
                issue_id="id-2",
                issue_identifier="BTCAAAAA-102",
                files_indexed=1,
                source="git",
                skipped_no_commits=False,
                issue_status="in_progress",
            ),
        ]

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues",
                return_value=issues,
            ),
            patch("touch_index.bug_worker.run_bug_worker", return_value=results),
            patch(
                "touch_index.paperclip_client.transition_issue_status_board"
            ) as mock_transition,
            patch(
                "touch_index.bug_worker.catch_up_eligible_bug_issues",
                return_value=[],
            ),
            caplog.at_level(logging.INFO),
        ):
            monkeypatch.setattr("sys.argv", ["touch_index"])
            main()

        # Only the done issue should be transitioned
        mock_transition.assert_called_once_with("id-1", "done")
        assert any("skipping transition to done" in r.message for r in caplog.records)

    def test_main_transition_error_logged_does_not_crash(self, monkeypatch, caplog):
        """A failed transition is logged but does not halt the worker."""
        from touch_index.__main__ import _run_bug_cli as main
        import logging

        engine = MagicMock()
        issues = [
            {
                "id": "id-1",
                "identifier": "BTCAAAAA-101",
                "completedAt": "2026-05-11T10:00:00Z",
            },
        ]
        results = [
            BugIngestionResult(
                issue_id="id-1",
                issue_identifier="BTCAAAAA-101",
                files_indexed=2,
                source="git",
                skipped_no_commits=False,
                issue_status="done",
            ),
        ]

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues",
                return_value=issues,
            ),
            patch("touch_index.bug_worker.run_bug_worker", return_value=results),
            patch(
                "touch_index.paperclip_client.transition_issue_status_board",
                side_effect=RuntimeError("API timeout"),
            ) as mock_transition,
            patch(
                "touch_index.bug_worker.catch_up_eligible_bug_issues",
                return_value=[],
            ),
            caplog.at_level(logging.ERROR),
        ):
            monkeypatch.setattr("sys.argv", ["touch_index"])
            main()

        mock_transition.assert_called_once_with("id-1", "done")
        assert any("Failed to mark" in r.message for r in caplog.records)

    def test_main_issue_id_transition_error_logged_does_not_crash(
        self, monkeypatch, caplog
    ):
        """Single-issue mode: transition failure is logged but does not crash."""
        from touch_index.__main__ import _run_bug_cli as main
        import logging

        engine = MagicMock()
        result = BugIngestionResult(
            issue_id="uuid-1",
            issue_identifier="BTCAAAAA-100",
            files_indexed=2,
            source="git",
            skipped_no_commits=False,
            issue_status="done",
        )

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch("touch_index.bug_worker.process_bug_issue", return_value=result),
            patch("touch_index.paperclip_client.get_closed_non_fdr_issues"),
            patch(
                "touch_index.paperclip_client.transition_issue_status_board",
                side_effect=RuntimeError("API timeout"),
            ) as mock_transition,
            caplog.at_level(logging.ERROR),
        ):
            monkeypatch.setattr(
                "sys.argv",
                ["touch_index", "--issue-id", "uuid-1"],
            )
            main()

        mock_transition.assert_called_once_with("uuid-1", "done")
        assert any("Failed to mark" in r.message for r in caplog.records)


class TestMainProcessBugIssueError:
    """Tests for process_bug_issue exception handling in single-issue CLI path."""

    def test_process_error_raises_system_exit(self, monkeypatch):
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.bug_worker.process_bug_issue",
                side_effect=RuntimeError("API timeout"),
            ),
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues"
            ) as mock_fetch,
            patch(
                "touch_index.paperclip_client.transition_issue_status_board"
            ) as mock_transition,
        ):
            monkeypatch.setattr(
                "sys.argv",
                ["touch_index", "--issue-id", "uuid-1"],
            )
            with pytest.raises(SystemExit) as exc_info:
                main()

        assert exc_info.value.code == 1
        mock_fetch.assert_not_called()
        mock_transition.assert_not_called()

    def test_process_error_with_validate_exits_nonzero(self, monkeypatch):
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.bug_worker.process_bug_issue",
                side_effect=RuntimeError("API timeout"),
            ),
            patch("touch_index.quality.run_bug_quality_checks") as mock_quality,
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues"
            ) as mock_fetch,
        ):
            monkeypatch.setattr(
                "sys.argv",
                ["touch_index", "--issue-id", "uuid-1", "--validate"],
            )
            with pytest.raises(SystemExit) as exc_info:
                main()

        assert exc_info.value.code == 1
        mock_fetch.assert_not_called()
        mock_quality.assert_not_called()

    def test_process_error_emits_json_summary(self, monkeypatch, capsys):
        """process_bug_issue error with --json-summary emits JSON before SystemExit."""
        import json
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.bug_worker.process_bug_issue",
                side_effect=RuntimeError("API timeout"),
            ),
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues"
            ) as mock_fetch,
            patch(
                "touch_index.paperclip_client.transition_issue_status_board"
            ) as mock_transition,
        ):
            monkeypatch.setattr(
                "sys.argv",
                ["touch_index", "--issue-id", "uuid-1", "--json-summary"],
            )
            with pytest.raises(SystemExit) as exc_info:
                main()

        assert exc_info.value.code == 1
        mock_fetch.assert_not_called()
        mock_transition.assert_not_called()
        captured = capsys.readouterr()
        data = json.loads(captured.out.strip())
        assert data["worker"] == "bug"
        assert data["mode"] == "single-issue"
        assert data["dry_run"] is False

    def test_json_summary_issue_id_not_found(self, monkeypatch, capsys):
        """--json-summary --issue-id with no match outputs JSON without result field."""
        import json
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch("touch_index.bug_worker.process_bug_issue", return_value=None),
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues"
            ) as mock_fetch,
            patch(
                "touch_index.paperclip_client.transition_issue_status_board"
            ) as mock_transition,
        ):
            monkeypatch.setattr(
                "sys.argv", ["touch_index", "--issue-id", "missing", "--json-summary"]
            )
            main()

        mock_fetch.assert_not_called()
        mock_transition.assert_not_called()
        captured = capsys.readouterr()
        data = json.loads(captured.out.strip())
        assert data["worker"] == "bug"
        assert data["mode"] == "single-issue"
        assert "result" not in data


class TestBugWorkerMain:
    """Tests for bug_worker.main() delegation function."""

    def test_delegates_to_run_bug_cli(self, monkeypatch):
        """bug_worker.main() calls _run_bug_cli() from __main__."""
        from touch_index.bug_worker import main

        with (
            patch("touch_index.__main__._run_bug_cli") as mock_cli,
        ):
            monkeypatch.setattr("sys.argv", ["touch_index"])
            main()

        mock_cli.assert_called_once()


# -------------------------------------------------------------------
# --json-summary flag (single-issue + polling)
# -------------------------------------------------------------------


class TestBugJsonSummary:
    """Tests for --json-summary in the bug worker CLI."""

    def test_json_summary_single_issue(self, monkeypatch, capsys):
        """--json-summary with --issue-id outputs JSON to stdout."""
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()
        result = BugIngestionResult(
            issue_identifier="BTCAAAAA-100",
            issue_id="uuid-1",
            files_indexed=2,
            source="git",
            skipped_no_commits=False,
            issue_status="done",
        )

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.bug_worker.process_bug_issue", return_value=result
            ) as mock_process,
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues"
            ) as mock_fetch,
            patch(
                "touch_index.paperclip_client.transition_issue_status_board"
            ) as mock_transition,
        ):
            monkeypatch.setattr(
                "sys.argv",
                ["touch_index", "--issue-id", "uuid-1", "--json-summary"],
            )
            main()

        mock_process.assert_called_once()
        captured = capsys.readouterr()
        import json

        data = json.loads(captured.out.strip())
        assert data["worker"] == "bug"
        assert data["mode"] == "single-issue"
        assert data["result"]["issue_identifier"] == "BTCAAAAA-100"
        assert data["result"]["files_indexed"] == 2

    def test_json_summary_polling(self, monkeypatch, capsys):
        """--json-summary in polling mode outputs JSON to stdout."""
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()
        issues = [
            {
                "id": "id-1",
                "identifier": "BTCAAAAA-101",
                "completedAt": "2026-05-11T10:00:00Z",
            },
        ]
        results = [
            BugIngestionResult(
                issue_identifier="BTCAAAAA-101",
                issue_id="id-1",
                files_indexed=3,
                source="git",
                skipped_no_commits=False,
                issue_status="done",
            ),
        ]

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues",
                return_value=issues,
            ),
            patch("touch_index.bug_worker.run_bug_worker", return_value=results),
            patch(
                "touch_index.paperclip_client.transition_issue_status_board",
            ) as mock_transition,
            patch(
                "touch_index.bug_worker.catch_up_eligible_bug_issues",
                return_value=[],
            ),
        ):
            monkeypatch.setattr(
                "sys.argv",
                ["touch_index", "--json-summary"],
            )
            main()

        captured = capsys.readouterr()
        import json

        data = json.loads(captured.out.strip())
        assert data["worker"] == "bug"
        assert data["mode"] == "polling"
        assert data["issues_processed"] == 1
        assert data["total_files_indexed"] == 3

    def test_json_summary_polling_with_errors(self, monkeypatch, capsys):
        """--json-summary includes error count when issues fail during polling mode."""
        import json
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()
        issues = [
            {
                "id": "id-1",
                "identifier": "BTCAAAAA-101",
                "completedAt": "2026-05-11T10:00:00Z",
            },
            {
                "id": "id-2",
                "identifier": "BTCAAAAA-102",
                "completedAt": "2026-05-11T10:00:00Z",
            },
            {
                "id": "id-3",
                "identifier": "BTCAAAAA-103",
                "completedAt": "2026-05-11T10:00:00Z",
            },
        ]
        # run_bug_worker returns 2 results for 3 issues (1 failed)
        results = [
            BugIngestionResult(
                issue_identifier="BTCAAAAA-101",
                issue_id="id-1",
                files_indexed=3,
                source="git",
                skipped_no_commits=False,
                issue_status="done",
            ),
            BugIngestionResult(
                issue_identifier="BTCAAAAA-103",
                issue_id="id-3",
                files_indexed=0,
                source="none",
                skipped_no_commits=True,
                issue_status="done",
            ),
        ]

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues",
                return_value=issues,
            ),
            patch("touch_index.bug_worker.run_bug_worker", return_value=results),
            patch(
                "touch_index.paperclip_client.transition_issue_status_board",
            ) as mock_transition,
            patch(
                "touch_index.bug_worker.catch_up_eligible_bug_issues",
                return_value=[],
            ),
        ):
            monkeypatch.setattr(
                "sys.argv",
                ["touch_index", "--json-summary"],
            )
            main()

        captured = capsys.readouterr()
        data = json.loads(captured.out.strip())
        assert data["issues_processed"] == 2
        assert data["issues_with_errors"] == 1
        assert data["total_files_indexed"] == 3
        assert data["issues_skipped"] == 1
        # Only the 2 successful issues are transitioned
        assert mock_transition.call_count == 2

    def test_json_summary_dry_run(self, monkeypatch, capsys):
        """--json-summary with --dry-run sets dry_run field."""
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()
        issues = [
            {
                "id": "id-1",
                "identifier": "BTCAAAAA-101",
                "completedAt": "2026-05-11T10:00:00Z",
            },
        ]
        results = [
            BugIngestionResult(
                issue_identifier="BTCAAAAA-101",
                issue_id="id-1",
                files_indexed=3,
                source="git",
                skipped_no_commits=False,
                issue_status="done",
            ),
        ]

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues",
                return_value=issues,
            ),
            patch("touch_index.bug_worker.run_bug_worker", return_value=results),
            patch(
                "touch_index.paperclip_client.transition_issue_status_board",
            ),
            patch(
                "touch_index.bug_worker.catch_up_eligible_bug_issues",
                return_value=[],
            ),
        ):
            monkeypatch.setattr(
                "sys.argv",
                ["touch_index", "--json-summary", "--dry-run"],
            )
            main()

        captured = capsys.readouterr()
        import json

        data = json.loads(captured.out.strip())
        assert data["dry_run"] is True
        assert "quality" not in data

    def test_json_summary_no_issues(self, monkeypatch, capsys):
        """--json-summary with no issues outputs JSON with empty results."""
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues",
                return_value=[],
            ),
            patch("touch_index.bug_worker.run_bug_worker") as mock_worker,
            patch(
                "touch_index.bug_worker.catch_up_eligible_bug_issues",
                return_value=[],
            ),
        ):
            monkeypatch.setattr(
                "sys.argv",
                ["touch_index", "--json-summary"],
            )
            main()

        mock_worker.assert_not_called()
        captured = capsys.readouterr()
        import json

        data = json.loads(captured.out.strip())
        assert data["worker"] == "bug"
        assert data["mode"] == "polling"
        assert data["issues_processed"] == 0
        assert data["total_files_indexed"] == 0

    def test_json_summary_with_validate_polling(self, monkeypatch, capsys):
        """--json-summary --validate in polling mode includes quality report."""
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()
        issues = [
            {
                "id": "id-1",
                "identifier": "BTCAAAAA-101",
                "completedAt": "2026-05-11T10:00:00Z",
            },
        ]
        results = [
            BugIngestionResult(
                issue_identifier="BTCAAAAA-101",
                issue_id="id-1",
                files_indexed=2,
                source="git",
                skipped_no_commits=False,
                issue_status="done",
            ),
        ]

        qc = MagicMock()
        qc.passed = True
        qc.to_dict.return_value = {"passed": True}

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues",
                return_value=issues,
            ),
            patch("touch_index.bug_worker.run_bug_worker", return_value=results),
            patch("touch_index.quality.run_bug_quality_checks", return_value=qc),
            patch("touch_index.paperclip_client.transition_issue_status_board"),
            patch(
                "touch_index.bug_worker.catch_up_eligible_bug_issues",
                return_value=[],
            ),
        ):
            monkeypatch.setattr(
                "sys.argv",
                ["touch_index", "--json-summary", "--validate"],
            )
            main()

        captured = capsys.readouterr()
        import json

        data = json.loads(captured.out.strip())
        assert data["worker"] == "bug"
        assert data["mode"] == "polling"
        assert data["quality"]["passed"] is True
        assert data["issues_processed"] == 1
        assert data["total_files_indexed"] == 2

    def test_json_summary_with_validate_no_issues(self, monkeypatch, capsys):
        """--json-summary --validate with no issues includes quality report."""
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()
        qc = MagicMock()
        qc.passed = True
        qc.to_dict.return_value = {"passed": True}

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues",
                return_value=[],
            ),
            patch("touch_index.bug_worker.run_bug_worker") as mock_worker,
            patch("touch_index.quality.run_bug_quality_checks", return_value=qc),
            patch(
                "touch_index.bug_worker.catch_up_eligible_bug_issues",
                return_value=[],
            ),
        ):
            monkeypatch.setattr(
                "sys.argv",
                ["touch_index", "--json-summary", "--validate"],
            )
            main()

        mock_worker.assert_not_called()
        captured = capsys.readouterr()
        import json

        data = json.loads(captured.out.strip())
        assert data["worker"] == "bug"
        assert data["mode"] == "polling"
        assert data["quality"]["passed"] is True
        assert data["issues_processed"] == 0

    def test_json_summary_with_validate_polling_failed(self, monkeypatch, capsys):
        """--json-summary --validate in polling mode emits JSON even on failure."""
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()
        issues = [
            {
                "id": "id-1",
                "identifier": "BTCAAAAA-101",
                "completedAt": "2026-05-11T10:00:00Z",
            },
        ]
        results = [
            BugIngestionResult(
                issue_identifier="BTCAAAAA-101",
                issue_id="id-1",
                files_indexed=2,
                source="git",
                skipped_no_commits=False,
                issue_status="done",
            ),
        ]

        qc = MagicMock()
        qc.passed = False
        qc.to_dict.return_value = {"passed": False}

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues",
                return_value=issues,
            ),
            patch("touch_index.bug_worker.run_bug_worker", return_value=results),
            patch("touch_index.quality.run_bug_quality_checks", return_value=qc),
            patch("touch_index.paperclip_client.transition_issue_status_board"),
            patch(
                "touch_index.bug_worker.catch_up_eligible_bug_issues",
                return_value=[],
            ),
        ):
            monkeypatch.setattr(
                "sys.argv",
                ["touch_index", "--json-summary", "--validate"],
            )
            with pytest.raises(SystemExit) as exc_info:
                main()

        assert exc_info.value.code == 1
        captured = capsys.readouterr()
        import json

        data = json.loads(captured.out.strip())
        assert data["worker"] == "bug"
        assert data["mode"] == "polling"
        assert data["quality"]["passed"] is False
        assert data["issues_processed"] == 1
        assert data["total_files_indexed"] == 2

    def test_json_summary_with_validate_issue_id_passed(self, monkeypatch, capsys):
        """--json-summary --issue-id --validate includes quality in JSON."""
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()
        result = BugIngestionResult(
            issue_identifier="BTCAAAAA-100",
            issue_id="uuid-1",
            files_indexed=2,
            source="git",
            skipped_no_commits=False,
            issue_status="done",
        )

        qc = MagicMock()
        qc.passed = True
        qc.to_dict.return_value = {"passed": True}

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.bug_worker.process_bug_issue", return_value=result
            ) as mock_process,
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues"
            ) as mock_fetch,
            patch("touch_index.quality.run_bug_quality_checks", return_value=qc),
            patch(
                "touch_index.paperclip_client.transition_issue_status_board"
            ) as mock_transition,
        ):
            monkeypatch.setattr(
                "sys.argv",
                ["touch_index", "--issue-id", "uuid-1", "--validate", "--json-summary"],
            )
            main()

        mock_fetch.assert_not_called()
        mock_transition.assert_called_once_with("uuid-1", "done")
        captured = capsys.readouterr()
        import json

        data = json.loads(captured.out.strip())
        assert data["worker"] == "bug"
        assert data["mode"] == "single-issue"
        assert data["quality"]["passed"] is True
        assert data["result"]["files_indexed"] == 2

    def test_json_summary_with_validate_issue_id_failed(self, monkeypatch, capsys):
        """--json-summary --issue-id --validate emits JSON even on failure."""
        from touch_index.__main__ import _run_bug_cli as main

        engine = MagicMock()
        result = BugIngestionResult(
            issue_identifier="BTCAAAAA-100",
            issue_id="uuid-1",
            files_indexed=2,
            source="git",
            skipped_no_commits=False,
            issue_status="done",
        )

        qc = MagicMock()
        qc.passed = False
        qc.to_dict.return_value = {"passed": False}

        with (
            patch("touch_index.db.get_engine", return_value=engine),
            patch("touch_index.db.health_check", return_value=True),
            patch(
                "touch_index.bug_worker.process_bug_issue", return_value=result
            ) as mock_process,
            patch(
                "touch_index.paperclip_client.get_closed_non_fdr_issues"
            ) as mock_fetch,
            patch("touch_index.quality.run_bug_quality_checks", return_value=qc),
            patch(
                "touch_index.paperclip_client.transition_issue_status_board"
            ) as mock_transition,
        ):
            monkeypatch.setattr(
                "sys.argv",
                ["touch_index", "--issue-id", "uuid-1", "--json-summary", "--validate"],
            )
            with pytest.raises(SystemExit) as exc_info:
                main()

        assert exc_info.value.code == 1
        mock_fetch.assert_not_called()
        mock_transition.assert_called_once_with("uuid-1", "done")
        captured = capsys.readouterr()
        import json

        data = json.loads(captured.out.strip())
        assert data["worker"] == "bug"
        assert data["mode"] == "single-issue"
        assert data["quality"]["passed"] is False
        assert data["result"]["files_indexed"] == 2


# ---------------------------------------------------------------------------
# _emit_json_summary — required worker param (regression for BTCAAAAA-4892)
# ---------------------------------------------------------------------------


class TestEmitJsonSummaryRequiresWorker:
    """_emit_json_summary must reject calls without the worker argument."""

    def test_missing_worker_raises_type_error(self):
        """Calling _emit_json_summary(args) without worker= raises TypeError."""
        import argparse
        from touch_index.__main__ import _emit_json_summary

        args = argparse.Namespace(issue_id=None, dry_run=False)
        with pytest.raises(TypeError):
            _emit_json_summary(args)

    def test_worker_bug_succeeds(self, capsys):
        """Calling _emit_json_summary(args, worker='bug') succeeds."""
        import argparse
        from touch_index.__main__ import _emit_json_summary

        args = argparse.Namespace(issue_id=None, dry_run=False)
        _emit_json_summary(args, worker="bug")
        captured = capsys.readouterr()
        import json

        data = json.loads(captured.out.strip())
        assert data["worker"] == "bug"

    def test_worker_fr_succeeds(self, capsys):
        """Calling _emit_json_summary(args, worker='fr') succeeds."""
        import argparse
        from touch_index.__main__ import _emit_json_summary

        args = argparse.Namespace(issue_id=None, dry_run=False)
        _emit_json_summary(args, worker="fr")
        captured = capsys.readouterr()
        import json

        data = json.loads(captured.out.strip())
        assert data["worker"] == "fr"

    def test_polls_issue_description_when_missing_from_list(self):
        """When git/comments fail and list issue lacks description, full issue is fetched."""
        engine, conn = _mock_engine()
        desc = "Fixed bug in `src/touch_index/bug_worker.py`"
        full_issue = {
            "id": "id-1",
            "identifier": "BTCAAAAA-200",
            "description": desc,
            "completedAt": "2026-05-11T12:00:00Z",
        }

        with (
            patch("touch_index.bug_worker.get_files_for_issue", return_value=[]),
            patch("touch_index.bug_worker.fetch_and_extract", return_value=[]),
            patch(
                "touch_index.bug_worker.get_issue_by_id", return_value=full_issue
            ) as mock_get,
            patch(
                "touch_index.bug_worker.extract_files_from_text",
                return_value=["src/touch_index/bug_worker.py"],
            ),
        ):
            results = run_bug_worker(
                engine,
                [
                    {
                        "id": "id-1",
                        "identifier": "BTCAAAAA-200",
                        "completedAt": "2026-05-11T12:00:00Z",
                    }
                ],
            )

        assert len(results) == 1
        assert results[0].source == "description"
        assert results[0].files_indexed == 1
        assert results[0].skipped_no_commits is False
        mock_get.assert_called_once_with("id-1")
        conn.execute.assert_called_once()

    def test_description_fallback_not_called_when_git_succeeds(self):
        """When git has files, no API call for description is made."""
        engine, _ = _mock_engine()

        with (
            patch(
                "touch_index.bug_worker.get_files_for_issue",
                return_value=["src/ok.py"],
            ),
            patch("touch_index.bug_worker.fetch_and_extract"),
            patch("touch_index.bug_worker.get_issue_by_id") as mock_get,
        ):
            results = run_bug_worker(
                engine,
                [{"id": "id-1", "identifier": "BTCAAAAA-200"}],
            )

        assert len(results) == 1
        assert results[0].source == "git"
        mock_get.assert_not_called()

    def test_description_fallback_not_called_when_comments_succeed(self):
        """When comments have files, no API call for description is made."""
        engine, _ = _mock_engine()

        with (
            patch("touch_index.bug_worker.get_files_for_issue", return_value=[]),
            patch(
                "touch_index.bug_worker.fetch_and_extract",
                return_value=["src/comment.py"],
            ),
            patch("touch_index.bug_worker.get_issue_by_id") as mock_get,
        ):
            results = run_bug_worker(
                engine,
                [{"id": "id-1", "identifier": "BTCAAAAA-200"}],
            )

        assert len(results) == 1
        assert results[0].source == "comments"
        mock_get.assert_not_called()

    def test_no_fallback_when_list_has_description(self):
        """When list endpoint already has description, no extra API call."""
        engine, conn = _mock_engine()
        desc = "Fix in `src/foo.py`"

        with (
            patch("touch_index.bug_worker.get_files_for_issue", return_value=[]),
            patch("touch_index.bug_worker.fetch_and_extract", return_value=[]),
            patch("touch_index.bug_worker.get_issue_by_id") as mock_get,
            patch(
                "touch_index.bug_worker.extract_files_from_text",
                return_value=["src/foo.py"],
            ),
        ):
            results = run_bug_worker(
                engine,
                [{"id": "id-1", "identifier": "BTCAAAAA-200", "description": desc}],
            )

        assert len(results) == 1
        assert results[0].source == "description"
        assert results[0].files_indexed == 1
        mock_get.assert_not_called()
        conn.execute.assert_called_once()

    def test_no_fallback_when_full_issue_lacks_description(self):
        """When full issue has no description either, result stays 'none'."""
        engine, _ = _mock_engine()
        full_issue = {
            "id": "id-1",
            "identifier": "BTCAAAAA-200",
            "completedAt": "2026-05-11T12:00:00Z",
        }

        with (
            patch("touch_index.bug_worker.get_files_for_issue", return_value=[]),
            patch("touch_index.bug_worker.fetch_and_extract", return_value=[]),
            patch(
                "touch_index.bug_worker.get_issue_by_id", return_value=full_issue
            ) as mock_get,
        ):
            results = run_bug_worker(
                engine,
                [{"id": "id-1", "identifier": "BTCAAAAA-200"}],
            )

        assert len(results) == 1
        assert results[0].source == "none"
        assert results[0].skipped_no_commits is True
        mock_get.assert_called_once()

    def test_fallback_not_called_when_full_issue_not_found(self):
        """When get_issue_by_id returns None, result stays 'none'."""
        engine, _ = _mock_engine()

        with (
            patch("touch_index.bug_worker.get_files_for_issue", return_value=[]),
            patch("touch_index.bug_worker.fetch_and_extract", return_value=[]),
            patch(
                "touch_index.bug_worker.get_issue_by_id", return_value=None
            ) as mock_get,
        ):
            results = run_bug_worker(
                engine,
                [{"id": "id-1", "identifier": "BTCAAAAA-200"}],
            )

        assert len(results) == 1
        assert results[0].source == "none"
        assert results[0].skipped_no_commits is True
        mock_get.assert_called_once()

    def test_mixed_fallback_and_git(self):
        """Mixed batch: one issue with git files, one requiring description fallback."""
        engine, conn = _mock_engine()
        full_issue = {
            "id": "id-2",
            "identifier": "BTCAAAAA-201",
            "description": "Fixed in `src/bar.py`",
            "completedAt": "2026-05-11T12:00:00Z",
        }

        def git_side_effect(identifier):
            if identifier == "BTCAAAAA-200":
                return ["src/foo.py"]
            return []

        with (
            patch(
                "touch_index.bug_worker.get_files_for_issue",
                side_effect=git_side_effect,
            ),
            patch("touch_index.bug_worker.fetch_and_extract", return_value=[]),
            patch(
                "touch_index.bug_worker.get_issue_by_id", return_value=full_issue
            ) as mock_get,
            patch(
                "touch_index.bug_worker.extract_files_from_text",
                return_value=["src/bar.py"],
            ),
        ):
            results = run_bug_worker(
                engine,
                [
                    {"id": "id-1", "identifier": "BTCAAAAA-200"},
                    {"id": "id-2", "identifier": "BTCAAAAA-201"},
                ],
            )

        assert len(results) == 2
        assert results[0].source == "git"
        assert results[0].files_indexed == 1
        assert results[1].source == "description"
        assert results[1].files_indexed == 1
        mock_get.assert_called_once_with("id-2")


# ---------------------------------------------------------------------------
# catch_up_eligible_bug_issues — catch-up for eligible issues not yet indexed
# ---------------------------------------------------------------------------


class TestCatchUpEligibleBugIssues:
    """Tests for catch_up_eligible_bug_issues()."""

    def setup_method(self) -> None:
        """Create an empty unindexable tracker file to isolate from test artifacts on disk."""
        self._tmp_unindexable = tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        )
        self._tmp_unindexable.write("[]\n")
        self._tmp_unindexable.close()
        _set_catchup_tracker_path(Path(self._tmp_unindexable.name))

    def teardown_method(self) -> None:
        Path(self._tmp_unindexable.name).unlink(missing_ok=True)

    def test_catch_up_indexes_missing_eligible_issues(self):
        """Issues referenced in git but not in DB are indexed."""
        engine, conn = _mock_engine()
        done_issue = {
            "id": ISSUE_ID,
            "identifier": ISSUE_IDENTIFIER,
            "status": "done",
            "completedAt": "2026-05-11T12:00:00Z",
        }

        with (
            patch(
                "touch_index.bug_worker.get_all_referenced_issue_ids",
                return_value={ISSUE_IDENTIFIER},
            ),
            patch(
                "touch_index.bug_worker.get_issue_by_identifier",
                return_value=done_issue,
            ),
            patch(
                "touch_index.bug_worker.get_files_for_issue",
                return_value=["src/touch_index/bug_worker.py"],
            ),
            patch("touch_index.bug_worker.fetch_and_extract", return_value=[]),
            patch(
                "touch_index.bug_worker.text",
            ) as mock_text,
        ):
            mock_text.return_value = MagicMock()
            rows = conn.execute.return_value.fetchall.return_value
            rows.__iter__.return_value = []
            results = catch_up_eligible_bug_issues(engine)

        assert len(results) == 1
        assert results[0].issue_identifier == ISSUE_IDENTIFIER
        assert results[0].files_indexed == 1

    def test_catch_up_skips_already_indexed(self):
        """Issues already in the DB are skipped."""
        engine, conn = _mock_engine()
        done_issue = {
            "id": ISSUE_ID,
            "identifier": ISSUE_IDENTIFIER,
            "status": "done",
        }

        with (
            patch(
                "touch_index.bug_worker.get_all_referenced_issue_ids",
                return_value={ISSUE_IDENTIFIER},
            ),
            patch(
                "touch_index.bug_worker.get_issue_by_identifier",
                return_value=done_issue,
            ) as mock_get,
            patch(
                "touch_index.bug_worker.get_files_for_issue",
                return_value=["src/x.py"],
            ) as mock_git,
        ):
            rows = conn.execute.return_value.fetchall.return_value
            rows.__iter__.return_value = [(ISSUE_IDENTIFIER,)]
            results = catch_up_eligible_bug_issues(engine)

        assert len(results) == 0
        mock_get.assert_not_called()
        mock_git.assert_not_called()

    def test_catch_up_skips_non_done_issues(self):
        """Issues with status other than 'done' are skipped."""
        engine, conn = _mock_engine()
        in_progress_issue = {
            "id": ISSUE_ID,
            "identifier": ISSUE_IDENTIFIER,
            "status": "in_progress",
        }

        with (
            patch(
                "touch_index.bug_worker.get_all_referenced_issue_ids",
                return_value={ISSUE_IDENTIFIER},
            ),
            patch(
                "touch_index.bug_worker.get_issue_by_identifier",
                return_value=in_progress_issue,
            ),
            patch(
                "touch_index.bug_worker.get_files_for_issue",
            ) as mock_git,
        ):
            rows = conn.execute.return_value.fetchall.return_value
            rows.__iter__.return_value = []
            results = catch_up_eligible_bug_issues(engine)

        assert len(results) == 0
        mock_git.assert_not_called()

    def test_catch_up_skips_fdr_labelled(self):
        """FDR-labelled issues are skipped (handled by FR worker)."""
        engine, conn = _mock_engine()
        fdr_issue = {
            "id": ISSUE_ID,
            "identifier": ISSUE_IDENTIFIER,
            "status": "done",
            "labelIds": ["d523cb2d-acd9-423d-b87a-bb79cee42c40"],
        }

        with (
            patch(
                "touch_index.bug_worker.get_all_referenced_issue_ids",
                return_value={ISSUE_IDENTIFIER},
            ),
            patch(
                "touch_index.bug_worker.get_issue_by_identifier",
                return_value=fdr_issue,
            ),
            patch(
                "touch_index.bug_worker.get_files_for_issue",
            ) as mock_git,
        ):
            rows = conn.execute.return_value.fetchall.return_value
            rows.__iter__.return_value = []
            results = catch_up_eligible_bug_issues(engine)

        assert len(results) == 0
        mock_git.assert_not_called()

    def test_catch_up_skips_missing_issues(self):
        """Issues not found in Paperclip are skipped."""
        engine, conn = _mock_engine()

        with (
            patch(
                "touch_index.bug_worker.get_all_referenced_issue_ids",
                return_value={ISSUE_IDENTIFIER},
            ),
            patch(
                "touch_index.bug_worker.get_issue_by_identifier",
                return_value=None,
            ),
        ):
            rows = conn.execute.return_value.fetchall.return_value
            rows.__iter__.return_value = []
            results = catch_up_eligible_bug_issues(engine)

        assert len(results) == 0

    def test_catch_up_returns_empty_when_no_git_ids(self):
        """When no git issue IDs found, returns empty list."""
        engine, _ = _mock_engine()

        with patch(
            "touch_index.bug_worker.get_all_referenced_issue_ids",
            return_value=set(),
        ):
            results = catch_up_eligible_bug_issues(engine)

        assert results == []

    def test_catch_up_continues_after_error(self):
        """An error indexing one issue does not halt the catch-up."""
        engine, conn = _mock_engine()
        done_issue = {
            "id": ISSUE_ID,
            "identifier": ISSUE_IDENTIFIER,
            "status": "done",
        }
        other_id = "BTCAAAAA-999"
        other_issue = {
            "id": "cccccccc-0000-0000-0000-999999999999",
            "identifier": other_id,
            "status": "done",
            "completedAt": "2026-05-11T12:00:00Z",
        }

        with (
            patch(
                "touch_index.bug_worker.get_all_referenced_issue_ids",
                return_value={ISSUE_IDENTIFIER, other_id},
            ),
            patch(
                "touch_index.bug_worker.get_issue_by_identifier",
                side_effect=lambda i: (
                    done_issue if i == ISSUE_IDENTIFIER else other_issue
                ),
            ),
            patch(
                "touch_index.bug_worker.get_files_for_issue",
                side_effect=lambda i: (
                    ["src/ok.py"]
                    if i == other_id
                    else (_ for _ in ()).throw(RuntimeError("git error"))
                ),
            ),
            patch("touch_index.bug_worker.fetch_and_extract", return_value=[]),
        ):
            rows = conn.execute.return_value.fetchall.return_value
            rows.__iter__.return_value = []
            results = catch_up_eligible_bug_issues(engine)

        assert len(results) == 1
        assert results[0].issue_identifier == other_id
        assert results[0].files_indexed == 1

    def test_catch_up_skips_on_api_error_fetching_issue(self):
        """When get_issue_by_identifier raises, the error is logged and issue is skipped."""
        engine, conn = _mock_engine()
        other_id = "BTCAAAAA-999"
        other_issue = {
            "id": "cccccccc-0000-0000-0000-999999999999",
            "identifier": other_id,
            "status": "done",
        }

        with (
            patch(
                "touch_index.bug_worker.get_all_referenced_issue_ids",
                return_value={ISSUE_IDENTIFIER, other_id},
            ),
            patch(
                "touch_index.bug_worker.get_issue_by_identifier",
                side_effect=lambda i: (
                    other_issue
                    if i == other_id
                    else (_ for _ in ()).throw(RuntimeError("API timeout"))
                ),
            ),
            patch(
                "touch_index.bug_worker.get_files_for_issue",
                return_value=["src/ok.py"],
            ),
            patch("touch_index.bug_worker.fetch_and_extract", return_value=[]),
        ):
            rows = conn.execute.return_value.fetchall.return_value
            rows.__iter__.return_value = []
            results = catch_up_eligible_bug_issues(engine)

        assert len(results) == 1
        assert results[0].issue_identifier == other_id

    def test_catch_up_fetches_description_when_list_endpoint_omits_it(self):
        """When list endpoint omits description, catch-up fetches full issue and retries."""
        engine, conn = _mock_engine()
        done_issue = {
            "id": ISSUE_ID,
            "identifier": ISSUE_IDENTIFIER,
            "status": "done",
            "completedAt": "2026-05-11T12:00:00Z",
        }
        full_issue = {
            "id": ISSUE_ID,
            "identifier": ISSUE_IDENTIFIER,
            "status": "done",
            "completedAt": "2026-05-11T12:00:00Z",
            "description": "Fixed bug in `src/touch_index/bug_worker.py`",
        }

        with (
            patch(
                "touch_index.bug_worker.get_all_referenced_issue_ids",
                return_value={ISSUE_IDENTIFIER},
            ),
            patch(
                "touch_index.bug_worker.get_issue_by_identifier",
                return_value=done_issue,
            ),
            patch("touch_index.bug_worker.get_files_for_issue", return_value=[]),
            patch("touch_index.bug_worker.fetch_and_extract", return_value=[]),
            patch("touch_index.bug_worker.get_issue_by_id", return_value=full_issue),
            patch(
                "touch_index.bug_worker.extract_files_from_text",
                return_value=["src/touch_index/bug_worker.py"],
            ),
        ):
            rows = conn.execute.return_value.fetchall.return_value
            rows.__iter__.return_value = []
            results = catch_up_eligible_bug_issues(engine)

        assert len(results) == 1
        r = results[0]
        assert r.source == "description"
        assert r.files_indexed == 1
        assert r.skipped_no_commits is False
        assert r.issue_identifier == ISSUE_IDENTIFIER

    def test_catch_up_skips_description_retry_when_git_found_files(self):
        """When git already found files, the description retry is skipped."""
        engine, conn = _mock_engine()
        done_issue = {
            "id": ISSUE_ID,
            "identifier": ISSUE_IDENTIFIER,
            "status": "done",
        }

        with (
            patch(
                "touch_index.bug_worker.get_all_referenced_issue_ids",
                return_value={ISSUE_IDENTIFIER},
            ),
            patch(
                "touch_index.bug_worker.get_issue_by_identifier",
                return_value=done_issue,
            ),
            patch(
                "touch_index.bug_worker.get_files_for_issue",
                return_value=["src/git_found.py"],
            ),
            patch("touch_index.bug_worker.fetch_and_extract", return_value=[]),
            patch("touch_index.bug_worker.get_issue_by_id") as mock_fetch,
        ):
            rows = conn.execute.return_value.fetchall.return_value
            rows.__iter__.return_value = []
            results = catch_up_eligible_bug_issues(engine)

        assert len(results) == 1
        assert results[0].source == "git"
        mock_fetch.assert_not_called()

    def test_catch_up_skips_description_retry_when_full_issue_still_no_description(
        self,
    ):
        """When full issue also lacks description, original 'none' result is preserved."""
        engine, conn = _mock_engine()
        done_issue = {
            "id": ISSUE_ID,
            "identifier": ISSUE_IDENTIFIER,
            "status": "done",
        }

        with (
            patch(
                "touch_index.bug_worker.get_all_referenced_issue_ids",
                return_value={ISSUE_IDENTIFIER},
            ),
            patch(
                "touch_index.bug_worker.get_issue_by_identifier",
                return_value=done_issue,
            ),
            patch("touch_index.bug_worker.get_files_for_issue", return_value=[]),
            patch("touch_index.bug_worker.fetch_and_extract", return_value=[]),
            patch(
                "touch_index.bug_worker.get_issue_by_id",
                return_value={"id": ISSUE_ID, "identifier": ISSUE_IDENTIFIER},
            ),
        ):
            rows = conn.execute.return_value.fetchall.return_value
            rows.__iter__.return_value = []
            results = catch_up_eligible_bug_issues(engine)

        assert len(results) == 1
        assert results[0].source == "none"
        assert results[0].skipped_no_commits is True


# ---------------------------------------------------------------------------
# _load_unindexable_ids / _save_unindexable_ids — tracker file I/O
# ---------------------------------------------------------------------------


class TestUnindexableTrackerIO:
    def test_save_and_load_roundtrip(self):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            tmp = Path(f.name)
        try:
            _set_catchup_tracker_path(tmp)
            _save_unindexable_ids({"BTCAAAAA-1", "BTCAAAAA-2"})
            loaded = _load_unindexable_ids()
            assert loaded == {"BTCAAAAA-1", "BTCAAAAA-2"}
        finally:
            tmp.unlink(missing_ok=True)

    def test_load_empty_set_from_empty_file(self):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            f.write("[]\n")
            tmp = Path(f.name)
        try:
            _set_catchup_tracker_path(tmp)
            loaded = _load_unindexable_ids()
            assert loaded == set()
        finally:
            tmp.unlink(missing_ok=True)

    def test_load_returns_empty_for_nonexistent_file(self):
        tmp = Path("/tmp/nonexistent_unindexable_test.json")
        tmp.unlink(missing_ok=True)
        _set_catchup_tracker_path(tmp)
        loaded = _load_unindexable_ids()
        assert loaded == set()

    def test_load_returns_empty_for_empty_file(self):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            tmp = Path(f.name)
        try:
            _set_catchup_tracker_path(tmp)
            loaded = _load_unindexable_ids()
            assert loaded == set()
        finally:
            tmp.unlink(missing_ok=True)

    def test_load_handles_corrupt_json_gracefully(self):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            f.write("{not-json")
            tmp = Path(f.name)
        try:
            _set_catchup_tracker_path(tmp)
            loaded = _load_unindexable_ids()
            assert loaded == set()
        finally:
            tmp.unlink(missing_ok=True)

    def test_save_empty_set_writes_empty_list(self):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            tmp = Path(f.name)
        try:
            _set_catchup_tracker_path(tmp)
            _save_unindexable_ids(set())
            raw = tmp.read_text().strip()
            assert raw == "[]"
        finally:
            tmp.unlink(missing_ok=True)

    def test_save_replaces_previous_content(self):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            f.write('["old-id"]\n')
            tmp = Path(f.name)
        try:
            _set_catchup_tracker_path(tmp)
            _save_unindexable_ids({"BTCAAAAA-99"})
            loaded = _load_unindexable_ids()
            assert loaded == {"BTCAAAAA-99"}
        finally:
            tmp.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# catch_up_eligible_bug_issues — unindexable tracking
# ---------------------------------------------------------------------------


class TestCatchUpUnindexableTracking:
    def setup_method(self) -> None:
        self._tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False)
        self._tmp.write("[]\n")
        self._tmp.close()
        _set_catchup_tracker_path(Path(self._tmp.name))

    def teardown_method(self) -> None:
        Path(self._tmp.name).unlink(missing_ok=True)

    def test_skips_previously_unindexable_issues(self):
        engine, conn = _mock_engine()
        done_issue = {
            "id": ISSUE_ID,
            "identifier": ISSUE_IDENTIFIER,
            "status": "done",
        }
        _save_unindexable_ids({ISSUE_IDENTIFIER})

        with (
            patch(
                "touch_index.bug_worker.get_all_referenced_issue_ids",
                return_value={ISSUE_IDENTIFIER},
            ),
            patch(
                "touch_index.bug_worker.get_issue_by_identifier",
                return_value=done_issue,
            ) as mock_get,
            patch("touch_index.bug_worker.get_files_for_issue") as mock_git,
        ):
            rows = conn.execute.return_value.fetchall.return_value
            rows.__iter__.return_value = []
            results = catch_up_eligible_bug_issues(engine)

        assert len(results) == 0
        mock_get.assert_not_called()
        mock_git.assert_not_called()

    def test_records_newly_unindexable_issues(self):
        engine, conn = _mock_engine()
        done_issue = {
            "id": ISSUE_ID,
            "identifier": ISSUE_IDENTIFIER,
            "status": "done",
        }

        with (
            patch(
                "touch_index.bug_worker.get_all_referenced_issue_ids",
                return_value={ISSUE_IDENTIFIER},
            ),
            patch(
                "touch_index.bug_worker.get_issue_by_identifier",
                return_value=done_issue,
            ),
            patch("touch_index.bug_worker.get_files_for_issue", return_value=[]),
            patch("touch_index.bug_worker.fetch_and_extract", return_value=[]),
        ):
            rows = conn.execute.return_value.fetchall.return_value
            rows.__iter__.return_value = []
            results = catch_up_eligible_bug_issues(engine)

        assert len(results) == 1
        assert results[0].source == "none"
        assert results[0].skipped_no_commits is True
        loaded = _load_unindexable_ids()
        assert ISSUE_IDENTIFIER in loaded

    def test_does_not_record_indexable_as_unindexable(self):
        engine, conn = _mock_engine()
        done_issue = {
            "id": ISSUE_ID,
            "identifier": ISSUE_IDENTIFIER,
            "status": "done",
            "completedAt": "2026-05-11T12:00:00Z",
        }

        with (
            patch(
                "touch_index.bug_worker.get_all_referenced_issue_ids",
                return_value={ISSUE_IDENTIFIER},
            ),
            patch(
                "touch_index.bug_worker.get_issue_by_identifier",
                return_value=done_issue,
            ),
            patch(
                "touch_index.bug_worker.get_files_for_issue",
                return_value=["src/ok.py"],
            ),
            patch("touch_index.bug_worker.fetch_and_extract", return_value=[]),
        ):
            rows = conn.execute.return_value.fetchall.return_value
            rows.__iter__.return_value = []
            results = catch_up_eligible_bug_issues(engine)

        assert len(results) == 1
        assert results[0].source == "git"
        loaded = _load_unindexable_ids()
        assert ISSUE_IDENTIFIER not in loaded

    def test_accumulates_over_multiple_catch_up_runs(self):
        engine, conn = _mock_engine()
        other_id = "BTCAAAAA-999"
        other_issue = {
            "id": "cccccccc-0000-0000-0000-999999999999",
            "identifier": other_id,
            "status": "done",
        }

        with (
            patch(
                "touch_index.bug_worker.get_all_referenced_issue_ids",
                return_value={ISSUE_IDENTIFIER, other_id},
            ),
            patch(
                "touch_index.bug_worker.get_issue_by_identifier",
                side_effect=lambda i: (
                    {"id": ISSUE_ID, "identifier": ISSUE_IDENTIFIER, "status": "done"}
                    if i == ISSUE_IDENTIFIER
                    else other_issue
                ),
            ),
            patch("touch_index.bug_worker.get_files_for_issue", return_value=[]),
            patch("touch_index.bug_worker.fetch_and_extract", return_value=[]),
        ):
            rows = conn.execute.return_value.fetchall.return_value
            rows.__iter__.return_value = []
            results = catch_up_eligible_bug_issues(engine)

        assert len(results) == 2
        loaded = _load_unindexable_ids()
        assert ISSUE_IDENTIFIER in loaded
        assert other_id in loaded

        # Second run: both are now in tracker, so nothing to process
        with (
            patch(
                "touch_index.bug_worker.get_all_referenced_issue_ids",
                return_value={ISSUE_IDENTIFIER, other_id},
            ),
            patch(
                "touch_index.bug_worker.get_issue_by_identifier",
            ) as mock_get,
            patch("touch_index.bug_worker.get_files_for_issue") as mock_git,
        ):
            rows = conn.execute.return_value.fetchall.return_value
            rows.__iter__.return_value = []
            results2 = catch_up_eligible_bug_issues(engine)

        assert len(results2) == 0
        mock_get.assert_not_called()
        mock_git.assert_not_called()
