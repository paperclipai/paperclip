"""Unit tests for touch_index.__main__ dispatch logic.

All external I/O is mocked so tests run offline.
"""

from __future__ import annotations

import sys
from unittest.mock import patch

import pytest


@pytest.fixture(autouse=True)
def _preserve_argv():
    orig = sys.argv.copy()
    yield
    sys.argv = orig


class TestMainDispatch:
    def test_default_worker_is_fr(self):
        """When no args are given, _run_fr_cli() is called."""
        from touch_index.__main__ import main

        with (
            patch.object(sys, "argv", ["touch_index"]),
            patch("touch_index.__main__._print_help") as mock_help,
            patch("touch_index.__main__._run_fr_cli") as mock_fr,
            patch("touch_index.__main__._run_bug_cli") as mock_bug,
        ):
            main()
        mock_fr.assert_called_once()
        mock_bug.assert_not_called()
        mock_help.assert_not_called()

    def test_bug_dispatches_to_bug_worker(self):
        """When first arg is 'bug', _run_bug_cli() is called."""
        from touch_index.__main__ import main

        with (
            patch.object(sys, "argv", ["touch_index", "bug"]),
            patch("touch_index.__main__._print_help") as mock_help,
            patch("touch_index.__main__._run_fr_cli") as mock_fr,
            patch("touch_index.__main__._run_bug_cli") as mock_bug,
        ):
            main()
        mock_bug.assert_called_once()
        mock_fr.assert_not_called()
        mock_help.assert_not_called()

    def test_fr_dispatches_to_fr_worker(self):
        """When first arg is 'fr', _run_fr_cli() is called."""
        from touch_index.__main__ import main

        with (
            patch.object(sys, "argv", ["touch_index", "fr"]),
            patch("touch_index.__main__._print_help") as mock_help,
            patch("touch_index.__main__._run_fr_cli") as mock_fr,
            patch("touch_index.__main__._run_bug_cli") as mock_bug,
        ):
            main()
        mock_fr.assert_called_once()
        mock_bug.assert_not_called()
        mock_help.assert_not_called()

    def test_bug_with_options_passes_remaining_args(self):
        """When 'bug' is popped from argv, remaining args are passed to bug_worker."""
        from touch_index.__main__ import main

        with (
            patch.object(
                sys,
                "argv",
                ["touch_index", "bug", "--issue-id", "uuid-1", "--dry-run"],
            ),
            patch("touch_index.__main__._print_help") as mock_help,
            patch("touch_index.__main__._run_fr_cli") as mock_fr,
            patch("touch_index.__main__._run_bug_cli") as mock_bug,
        ):
            main()
        mock_bug.assert_called_once()
        mock_fr.assert_not_called()
        mock_help.assert_not_called()

    def test_unknown_worker_falls_back_to_fr(self):
        """When first arg is not 'fr' or 'bug', default to FR worker and warn."""
        from touch_index.__main__ import main

        with (
            patch.object(
                sys,
                "argv",
                ["touch_index", "unknown", "--issue-id", "uuid-1"],
            ),
            patch("touch_index.__main__._print_help") as mock_help,
            patch("touch_index.__main__._run_fr_cli") as mock_fr,
            patch("touch_index.__main__._run_bug_cli") as mock_bug,
            patch("touch_index.__main__.logger") as mock_logger,
        ):
            main()
        mock_fr.assert_called_once()
        mock_bug.assert_not_called()
        mock_help.assert_not_called()
        mock_logger.warning.assert_called_once_with(
            "Unknown worker '%s' — defaulting to 'fr'", "unknown"
        )


class TestHelp:
    def test_dash_dash_help_prints_docstring(self, capsys):
        """--help at top level prints the module docstring and returns."""
        from touch_index.__main__ import main

        with (
            patch.object(sys, "argv", ["touch_index", "--help"]),
            patch("touch_index.__main__._run_fr_cli") as mock_fr,
            patch("touch_index.__main__._run_bug_cli") as mock_bug,
        ):
            main()
        captured = capsys.readouterr()
        assert "Touch Index ingestion worker CLI" in captured.out
        assert "FR ingestion worker" in captured.out
        assert "Bug-close ingestion worker" in captured.out
        mock_fr.assert_not_called()
        mock_bug.assert_not_called()

    def test_dash_h_prints_docstring(self, capsys):
        """-h at top level prints the module docstring and returns."""
        from touch_index.__main__ import main

        with (
            patch.object(sys, "argv", ["touch_index", "-h"]),
            patch("touch_index.__main__._run_fr_cli") as mock_fr,
            patch("touch_index.__main__._run_bug_cli") as mock_bug,
        ):
            main()
        captured = capsys.readouterr()
        assert "Touch Index ingestion worker CLI" in captured.out
        mock_fr.assert_not_called()
        mock_bug.assert_not_called()

    def test_bug_help_passes_through_to_bug_worker(self):
        """When 'bug --help' is used, --help is passed to _run_bug_cli() directly."""
        from touch_index.__main__ import main

        with (
            patch.object(sys, "argv", ["touch_index", "bug", "--help"]),
            patch("touch_index.__main__._print_help") as mock_help,
            patch("touch_index.__main__._run_bug_cli") as mock_bug,
        ):
            main()
        mock_bug.assert_called_once()
        mock_help.assert_not_called()

    def test_bug_dash_h_passes_through(self):
        """When 'bug -h' is used, -h is passed to _run_bug_cli() directly."""
        from touch_index.__main__ import main

        with (
            patch.object(sys, "argv", ["touch_index", "bug", "-h"]),
            patch("touch_index.__main__._print_help") as mock_help,
            patch("touch_index.__main__._run_bug_cli") as mock_bug,
        ):
            main()
        mock_bug.assert_called_once()
        mock_help.assert_not_called()
