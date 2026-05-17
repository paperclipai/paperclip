"""Unit tests for scripts/validate_touch_index_fr.py validation checks.

All I/O is mocked so tests run offline.
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).parents[2] / "scripts"))
sys.path.insert(0, str(Path(__file__).parents[2] / "src"))

import importlib.util

runner_path = Path(__file__).parents[2] / "scripts" / "validate_touch_index_fr.py"
_spec = importlib.util.spec_from_file_location("validate_touch_index_fr", runner_path)
_runner = importlib.util.module_from_spec(_spec)
sys.modules["validate_touch_index_fr"] = _runner
_spec.loader.exec_module(_runner)
_run_checks = _runner._run_checks


def _make_quality_report(passed: bool = True):
    """Return a mock QualityReport with the given passed status."""
    report = MagicMock()
    report.passed = passed
    return report


class TestValidateFR:
    def test_returns_zero_on_clean(self, monkeypatch):
        engine = MagicMock()
        mock_engine_get = MagicMock(return_value=engine)
        monkeypatch.setattr(_runner, "get_engine", mock_engine_get)
        mock_health = MagicMock(return_value=True)
        monkeypatch.setattr(_runner, "health_check", mock_health)
        mock_quality = MagicMock(return_value=_make_quality_report(passed=True))
        monkeypatch.setattr(_runner, "run_quality_checks", mock_quality)
        result = _run_checks(stale_hours=168)

        assert result == 0
        mock_quality.assert_called_once_with(engine, stale_threshold_hours=168)

    def test_returns_nonzero_on_failure(self, monkeypatch):
        engine = MagicMock()
        monkeypatch.setattr(_runner, "get_engine", MagicMock(return_value=engine))
        monkeypatch.setattr(_runner, "health_check", MagicMock(return_value=True))
        mock_quality = MagicMock(return_value=_make_quality_report(passed=False))
        monkeypatch.setattr(_runner, "run_quality_checks", mock_quality)
        result = _run_checks(stale_hours=168)

        assert result == 1
        mock_quality.assert_called_once()

    def test_stale_hours_passed_to_quality(self, monkeypatch):
        engine = MagicMock()
        monkeypatch.setattr(_runner, "get_engine", MagicMock(return_value=engine))
        monkeypatch.setattr(_runner, "health_check", MagicMock(return_value=True))
        mock_quality = MagicMock(return_value=_make_quality_report(passed=True))
        monkeypatch.setattr(_runner, "run_quality_checks", mock_quality)
        _run_checks(stale_hours=48)

        mock_quality.assert_called_once_with(engine, stale_threshold_hours=48)

    def test_health_check_failure_exits(self, monkeypatch):
        monkeypatch.setattr(_runner, "get_engine", MagicMock())
        monkeypatch.setattr(_runner, "health_check", MagicMock(return_value=False))
        with pytest.raises(SystemExit) as exc:
            _run_checks(stale_hours=168)
        assert exc.value.code == 1

    def test_main_exits_nonzero_on_failures(self, monkeypatch):
        monkeypatch.setattr(sys, "argv", ["validate_touch_index_fr.py"])
        engine = MagicMock()
        monkeypatch.setattr(_runner, "get_engine", MagicMock(return_value=engine))
        monkeypatch.setattr(_runner, "health_check", MagicMock(return_value=True))
        mock_quality = MagicMock(return_value=_make_quality_report(passed=False))
        monkeypatch.setattr(_runner, "run_quality_checks", mock_quality)
        with pytest.raises(SystemExit) as exc:
            _runner.main()
        assert exc.value.code == 1

    def test_main_exits_zero_on_clean(self, monkeypatch):
        monkeypatch.setattr(sys, "argv", ["validate_touch_index_fr.py"])
        engine = MagicMock()
        monkeypatch.setattr(_runner, "get_engine", MagicMock(return_value=engine))
        monkeypatch.setattr(_runner, "health_check", MagicMock(return_value=True))
        mock_quality = MagicMock(return_value=_make_quality_report(passed=True))
        monkeypatch.setattr(_runner, "run_quality_checks", mock_quality)
        _runner.main()

    def test_accepts_pre_configured_engine(self, monkeypatch):
        """When an engine is passed directly, it is used instead of creating a new one."""
        engine = MagicMock()
        mock_engine_get = MagicMock()
        monkeypatch.setattr(_runner, "get_engine", mock_engine_get)
        mock_health = MagicMock()
        monkeypatch.setattr(_runner, "health_check", mock_health)
        mock_quality = MagicMock(return_value=_make_quality_report(passed=True))
        monkeypatch.setattr(_runner, "run_quality_checks", mock_quality)
        result = _run_checks(stale_hours=168, engine=engine)

        assert result == 0
        # get_engine and health_check should NOT be called when engine is provided
        mock_engine_get.assert_not_called()
        mock_health.assert_not_called()
        mock_quality.assert_called_once_with(engine, stale_threshold_hours=168)
