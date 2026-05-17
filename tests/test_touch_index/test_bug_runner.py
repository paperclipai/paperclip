"""Unit tests for scripts/run_touch_index_bug_worker.py main() entry point.

The script is now a thin wrapper that delegates to the unified CLI
(touch_index.bug_worker.main -> __main__._run_bug_cli).  These tests
verify the delegation works correctly.
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

# Make the scripts directory importable
sys.path.insert(0, str(Path(__file__).parents[2] / "scripts"))
sys.path.insert(0, str(Path(__file__).parents[2] / "src"))

import importlib

runner_path = Path(__file__).parents[2] / "scripts" / "run_touch_index_bug_worker.py"
_spec = importlib.util.spec_from_file_location(
    "run_touch_index_bug_worker", runner_path
)
_runner = importlib.util.module_from_spec(_spec)
sys.modules["run_touch_index_bug_worker"] = _runner
_spec.loader.exec_module(_runner)
main = _runner.main


_CLEAN_ARGV = ["run_touch_index_bug_worker.py"]


class TestBugRunnerDelegation:
    def test_delegates_to_bug_worker_main(self, monkeypatch):
        """main() calls touch_index.bug_worker.main()."""
        monkeypatch.setattr(sys, "argv", _CLEAN_ARGV)
        with patch("touch_index.bug_worker.main") as mock_main:
            main()
        mock_main.assert_called_once_with()

    def test_delegates_args_through_sys_argv(self, monkeypatch):
        """sys.argv is left intact for the delegated main() to parse."""
        monkeypatch.setattr(
            sys,
            "argv",
            ["run_touch_index_bug_worker.py", "--issue-id", "uuid-1", "--dry-run"],
        )
        with patch("touch_index.bug_worker.main") as mock_main:
            main()
        mock_main.assert_called_once_with()
        # sys.argv should still contain the original args
        assert sys.argv == [
            "run_touch_index_bug_worker.py",
            "--issue-id",
            "uuid-1",
            "--dry-run",
        ]
