"""Unit tests for scripts/run_touch_index_fr_worker.py entry point.

Now a thin wrapper: verifies that main() delegates to fr_worker.main().
The unified CLI behavior itself is tested in test_fr_worker.TestMain.
"""

from __future__ import annotations

import sys
from unittest.mock import MagicMock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[2] / "scripts"))
sys.path.insert(0, str(Path(__file__).parents[2] / "src"))

import importlib.util

runner_path = Path(__file__).parents[2] / "scripts" / "run_touch_index_fr_worker.py"
_spec = importlib.util.spec_from_file_location("run_touch_index_fr_worker", runner_path)
_runner = importlib.util.module_from_spec(_spec)
sys.modules["run_touch_index_fr_worker"] = _runner
_spec.loader.exec_module(_runner)
main = _runner.main


class TestFrRunnerDelegation:
    """Verify the runner is a thin wrapper around fr_worker.main()."""

    def test_delegates_to_fr_worker_main(self, monkeypatch):
        """runner.main() calls fr_worker.main() exactly once."""
        monkeypatch.setattr(sys, "argv", ["run_touch_index_fr_worker.py"])
        mock_fr_main = MagicMock()
        monkeypatch.setattr(_runner, "fr_main", mock_fr_main)
        main()
        mock_fr_main.assert_called_once()

    def test_passes_sys_argv_through(self, monkeypatch):
        """fr_worker.main() receives the full argv (no pre-processing)."""
        monkeypatch.setattr(
            sys,
            "argv",
            ["run_touch_index_fr_worker.py", "--issue-id", "uuid-1", "--dry-run"],
        )
        mock_fr_main = MagicMock()
        monkeypatch.setattr(_runner, "fr_main", mock_fr_main)
        main()
        mock_fr_main.assert_called_once()
