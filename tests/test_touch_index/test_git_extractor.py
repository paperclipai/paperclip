"""Unit tests for touch_index.git_extractor — git history file extraction.

All subprocess calls are mocked so these tests run offline.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import logging

import pytest

from touch_index.git_extractor import (
    _is_source_file,
    get_all_referenced_issue_ids,
    get_commit_hashes,
    get_files_for_commit,
    get_files_for_issue,
)


# ---------------------------------------------------------------------------
# _is_source_file  (pure function, no I/O)
# ---------------------------------------------------------------------------


class TestIsSourceFile:
    def test_source_py(self):
        assert _is_source_file("src/foo/bar.py") is True

    def test_source_js(self):
        assert _is_source_file("src/utils/index.js") is True

    def test_source_ts(self):
        assert _is_source_file("src/utils/index.ts") is True

    def test_source_sql(self):
        assert _is_source_file("src/utils/query.sql") is False

    def test_skips_alembic_prefix(self):
        assert _is_source_file("alembic/versions/abc123.py") is False

    def test_skips_lake_api_prefix(self):
        assert _is_source_file("scripts/LakeAPI/loader.py") is False

    def test_skips_dot_github(self):
        assert _is_source_file(".github/workflows/ci.yml") is False

    def test_skips_docs(self):
        assert _is_source_file("docs/guide.md") is False

    def test_skips_json(self):
        assert _is_source_file("config/settings.json") is False

    def test_skips_yaml(self):
        assert _is_source_file("config/deploy.yaml") is False

    def test_skips_toml(self):
        assert _is_source_file("pyproject.toml") is False

    def test_skips_markdown(self):
        assert _is_source_file("README.md") is False

    def test_skips_csv(self):
        assert _is_source_file("data/export.csv") is False

    def test_skips_shell_script(self):
        assert _is_source_file("scripts/deploy.sh") is False

    def test_skips_lock_file(self):
        assert _is_source_file("requirements.lock") is False

    def test_skips_txt(self):
        assert _is_source_file("requirements.txt") is False

    def test_skips_ini(self):
        assert _is_source_file("setup.cfg") is False

    def test_skips_coveragerc(self):
        assert _is_source_file(".coveragerc") is False

    def test_skips_env_example(self):
        assert _is_source_file(".env.example") is False

    def test_skips_archived_prefix(self):
        assert _is_source_file("scripts/archived/foo.py") is False

    def test_skips_root_archived(self):
        assert _is_source_file("archived/utils_strategy_builder_legacy/foo.py") is False

    def test_skips_rst(self):
        assert _is_source_file("docs/readme.rst") is False

    def test_skips_png(self):
        assert _is_source_file("assets/icon.png") is False

    def test_skips_jpg(self):
        assert _is_source_file("assets/photo.jpg") is False

    def test_skips_jpeg(self):
        assert _is_source_file("assets/photo.jpeg") is False

    def test_skips_gif(self):
        assert _is_source_file("assets/animation.gif") is False

    def test_skips_svg(self):
        assert _is_source_file("assets/diagram.svg") is False

    def test_skips_ico(self):
        assert _is_source_file("favicon.ico") is False

    def test_skips_pdf(self):
        assert _is_source_file("docs/report.pdf") is False

    def test_skips_pyc(self):
        assert _is_source_file("src/module.pyc") is False

    def test_skips_so(self):
        assert _is_source_file("src/lib.so") is False

    def test_skips_o(self):
        assert _is_source_file("src/object.o") is False

    def test_skips_parquet(self):
        assert _is_source_file("data/prices.parquet") is False

    def test_skips_pkl(self):
        assert _is_source_file("data/model.pkl") is False

    def test_bare_root_level_py(self):
        assert _is_source_file("setup.py") is True

    def test_root_level_py_in_tests(self):
        assert _is_source_file("tests/conftest.py") is True


# ---------------------------------------------------------------------------
# get_commit_hashes
# ---------------------------------------------------------------------------


class TestGetCommitHashes:
    def test_returns_hashes(self):
        with patch("touch_index.git_extractor._run", return_value="abc123\ndef456"):
            hashes = get_commit_hashes("BTCAAAAA-100")
        assert hashes == ["abc123", "def456"]

    def test_empty_when_no_matches(self):
        with patch("touch_index.git_extractor._run", return_value=""):
            hashes = get_commit_hashes("BTCAAAAA-NONEXISTENT")
        assert hashes == []

    def test_whitespace_lines_are_skipped(self):
        with patch(
            "touch_index.git_extractor._run", return_value="  \nabc123\n  \ndef456\n  "
        ):
            hashes = get_commit_hashes("BTCAAAAA-100")
        assert hashes == ["abc123", "def456"]


# ---------------------------------------------------------------------------
# get_files_for_commit
# ---------------------------------------------------------------------------


class TestGetFilesForCommit:
    def test_returns_source_files(self):
        with (
            patch("touch_index.git_extractor._run", return_value="src/a.py\nsrc/b.py"),
            patch("touch_index.git_extractor._is_source_file", return_value=True),
        ):
            files = get_files_for_commit("abc123")
        assert files == ["src/a.py", "src/b.py"]

    def test_filters_non_source_files(self):
        with (
            patch(
                "touch_index.git_extractor._run",
                return_value="src/a.py\nREADME.md\nalembic/x.py",
            ),
            patch(
                "touch_index.git_extractor._is_source_file",
                side_effect=lambda f: f == "src/a.py",
            ),
        ):
            files = get_files_for_commit("abc123")
        assert files == ["src/a.py"]

    def test_blank_lines_skipped(self):
        with (
            patch(
                "touch_index.git_extractor._run", return_value="src/a.py\n\nsrc/b.py"
            ),
            patch("touch_index.git_extractor._is_source_file", return_value=True),
        ):
            files = get_files_for_commit("abc123")
        assert files == ["src/a.py", "src/b.py"]

    def test_rename_arrow_lines_skipped(self):
        with (
            patch(
                "touch_index.git_extractor._run",
                return_value="=> src/renamed.py\nsrc/a.py",
            ),
            patch("touch_index.git_extractor._is_source_file", return_value=True),
        ):
            files = get_files_for_commit("abc123")
        assert files == ["src/a.py"]


# ---------------------------------------------------------------------------
# get_files_for_issue  (integration of above)
# ---------------------------------------------------------------------------


class TestGetFilesForIssue:
    def test_deduplicates_across_commits(self):
        with (
            patch(
                "touch_index.git_extractor.get_commit_hashes",
                return_value=["abc", "def"],
            ),
            patch(
                "touch_index.git_extractor.get_files_for_commit",
                side_effect=[["src/a.py", "src/b.py"], ["src/a.py", "src/c.py"]],
            ),
        ):
            files = get_files_for_issue("BTCAAAAA-100")
        assert files == ["src/a.py", "src/b.py", "src/c.py"]

    def test_empty_commits_returns_empty(self):
        with patch("touch_index.git_extractor.get_commit_hashes", return_value=[]):
            files = get_files_for_issue("BTCAAAAA-NONEXISTENT")
        assert files == []

    def test_respects_max_commits(self):
        with (
            patch(
                "touch_index.git_extractor.get_commit_hashes",
                return_value=["a", "b", "c"],
            ),
            patch(
                "touch_index.git_extractor.get_files_for_commit",
                side_effect=[["src/x.py"], ["src/y.py"]],
            ),
        ):
            files = get_files_for_issue("BTCAAAAA-100", max_commits=2)
        assert len(files) == 2  # 2 commits × 1 file each


# ---------------------------------------------------------------------------
# get_all_referenced_issue_ids
# ---------------------------------------------------------------------------


class TestGetAllReferencedIssueIds:
    def test_returns_set_of_issue_ids(self):
        """Parses BTCAAAAA-NNN from commit full bodies (--format=%B)."""
        with patch(
            "touch_index.git_extractor._run",
            return_value="fix(BTCAAAAA-100): fix foo\nfeat(BTCAAAAA-101): add bar\nfix(BTCAAAAA-100): second fix for 100",
        ):
            ids = get_all_referenced_issue_ids()
        assert ids == {"BTCAAAAA-100", "BTCAAAAA-101"}

    def test_extracts_ids_from_commit_body(self):
        """Issue IDs in the body (not just subject) are found with --format=%B."""
        with patch(
            "touch_index.git_extractor._run",
            return_value=(
                "feat: implement feature\n\n"
                "This commit addresses BTCAAAAA-300 which reported the bug\n"
                "and is related to BTCAAAAA-301 for the follow-up.\n"
            ),
        ):
            ids = get_all_referenced_issue_ids()
        assert "BTCAAAAA-300" in ids
        assert "BTCAAAAA-301" in ids

    def test_empty_when_no_refs(self):
        with patch(
            "touch_index.git_extractor._run",
            return_value="chore: cleanup\ndocs: update readme",
        ):
            ids = get_all_referenced_issue_ids()
        assert ids == set()

    def test_empty_when_no_commits(self):
        with patch("touch_index.git_extractor._run", return_value=""):
            ids = get_all_referenced_issue_ids()
        assert ids == set()

    def test_extracts_multiple_ids_from_single_message(self):
        """A commit subject referencing multiple issues extracts all."""
        with patch(
            "touch_index.git_extractor._run",
            return_value="fix(BTCAAAAA-100,BTCAAAAA-101): fix two issues",
        ):
            ids = get_all_referenced_issue_ids()
        assert "BTCAAAAA-100" in ids
        assert "BTCAAAAA-101" in ids

    def test_handles_git_error_returns_empty(self):
        """When _run returns empty (error), the result is an empty set."""
        with patch("touch_index.git_extractor._run", return_value=""):
            ids = get_all_referenced_issue_ids()
        assert ids == set()


# ---------------------------------------------------------------------------
# _run() — error handling (uncovered error paths in subprocess wrapper)
# ---------------------------------------------------------------------------


class TestRunErrorHandling:
    """Tests for _run() error handling paths that are normally mocked."""

    def test_handles_file_not_found_error(self, caplog):
        """When git executable is not found, returns empty string and logs error."""
        import subprocess
        from unittest.mock import patch
        from touch_index.git_extractor import _run

        with (
            patch.object(
                subprocess, "run", side_effect=FileNotFoundError("git not found")
            ),
            caplog.at_level(logging.ERROR),
        ):
            result = _run(["git", "log"], __import__("pathlib").Path("/tmp"))

        assert result == ""
        assert any("git executable not found" in r.message for r in caplog.records)

    def test_handles_os_error(self, caplog):
        """When subprocess raises OSError, returns empty string and logs error."""
        import subprocess
        from unittest.mock import patch
        from touch_index.git_extractor import _run

        with (
            patch.object(subprocess, "run", side_effect=OSError("Permission denied")),
            caplog.at_level(logging.ERROR),
        ):
            result = _run(["git", "log"], __import__("pathlib").Path("/tmp"))

        assert result == ""
        assert any("Permission denied" in r.message for r in caplog.records)

    def test_nonzero_returncode_logs_warning(self, caplog):
        """When git exits non-zero, returns stdout and logs warning."""
        import subprocess
        from unittest.mock import patch, MagicMock
        from touch_index.git_extractor import _run

        mock_result = MagicMock()
        mock_result.returncode = 128
        mock_result.stdout = ""
        mock_result.stderr = "fatal: not a git repository"

        with (
            patch.object(subprocess, "run", return_value=mock_result),
            caplog.at_level(logging.WARNING),
        ):
            result = _run(["git", "status"], __import__("pathlib").Path("/tmp"))

        assert result == ""
        assert any("git command failed" in r.message for r in caplog.records)
        assert any("exit 128" in r.message for r in caplog.records)
        assert any("fatal" in r.message for r in caplog.records)

    def test_handles_timeout_expired(self, caplog):
        """When git subprocess times out, returns empty string and logs error."""
        import subprocess
        from unittest.mock import patch
        from touch_index.git_extractor import _run

        with (
            patch.object(
                subprocess,
                "run",
                side_effect=subprocess.TimeoutExpired(cmd="git log", timeout=30),
            ),
            caplog.at_level(logging.ERROR),
        ):
            result = _run(["git", "log"], __import__("pathlib").Path("/tmp"))

        assert result == ""
        assert any("timed out" in r.message for r in caplog.records)
