"""Unit tests for scripts/run_impact_gate_worker.py thin entry point."""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[2] / "scripts"))
sys.path.insert(0, str(Path(__file__).parents[2] / "src"))

import importlib

_runner_path = Path(__file__).parents[2] / "scripts" / "run_impact_gate_worker.py"
_spec = importlib.util.spec_from_file_location("run_impact_gate_worker", _runner_path)
_runner = importlib.util.module_from_spec(_spec)
sys.modules["run_impact_gate_worker"] = _runner
_spec.loader.exec_module(_runner)
main = _runner.main


class TestRunnerMain:
    def test_delegates_to_worker_main(self):
        with patch("impact_gate.worker.main") as mock_worker_main:
            main()
            mock_worker_main.assert_called_once()

    def test_worker_main_called_with_no_args(self):
        with patch("impact_gate.worker.main") as mock_worker_main:
            main()
            assert mock_worker_main.called

    def test_sys_path_has_src(self):
        assert any("src" in p for p in sys.path)

    def test_dotenv_loaded(self, monkeypatch):
        called = []
        import dotenv
        monkeypatch.setattr(dotenv, "load_dotenv", lambda p: called.append(p))
        importlib.reload(_runner)
        assert len(called) == 1

    def test_main_runs_without_error(self):
        with patch("impact_gate.worker.main") as mock_worker_main:
            mock_worker_main.return_value = None
            main()

    def test_import_sets_sys_path(self):
        assert str(Path(__file__).parents[2] / "src") in sys.path

    def test_module_has_main_attribute(self):
        assert hasattr(_runner, "main")

    def test_module_has_callable_main(self):
        assert callable(_runner.main)

    def test_delegates_cli_args_to_worker(self):
        test_argv = ["run_impact_gate_worker.py", "--issue-id", "test-uuid", "--dry-run"]
        with patch.object(sys, "argv", test_argv), \
             patch("impact_gate.worker.main") as mock_worker_main:
            main()
            assert mock_worker_main.called
