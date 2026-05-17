"""Unit tests for scripts/impact_gate_scan_health.py."""

from __future__ import annotations

import importlib.util
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

_HEALTH_PATH = Path(__file__).parents[2] / "scripts" / "impact_gate_scan_health.py"
_spec = importlib.util.spec_from_file_location("impact_gate_scan_health", _HEALTH_PATH)
_health = importlib.util.module_from_spec(_spec)
sys.modules["impact_gate_scan_health"] = _health
_spec.loader.exec_module(_health)


def _stale_iso(minutes_ago):
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).isoformat()


def _recent_iso():
    return datetime.now(timezone.utc).isoformat()


def _write_snapshot(tmp_path, data):
    snap = tmp_path / "data_quality_impact_gate_20260514.json"
    snap.write_text(json.dumps(data))
    return snap


class TestFindLatestSnapshot:
    def test_none_when_no_snapshots(self, monkeypatch, tmp_path):
        monkeypatch.setattr(_health, "REPO_ROOT", tmp_path)
        assert _health._find_latest_snapshot() is None

    def test_returns_newest(self, monkeypatch, tmp_path):
        older = tmp_path / "data_quality_impact_gate_20260513.json"
        newer = tmp_path / "data_quality_impact_gate_20260514.json"
        older.write_text("{}")
        newer.write_text("{}")
        monkeypatch.setattr(_health, "REPO_ROOT", tmp_path)
        assert _health._find_latest_snapshot() == newer


class TestParseIsoDatetime:
    def test_none(self):
        assert _health._parse_iso_datetime(None) is None

    def test_valid(self):
        ts = _health._parse_iso_datetime("2026-05-14T12:00:00+00:00")
        assert ts is not None
        assert ts.year == 2026

    def test_z_suffix(self):
        ts = _health._parse_iso_datetime("2026-05-14T12:00:00Z")
        assert ts is not None

    def test_invalid(self):
        assert _health._parse_iso_datetime("not-a-date") is None


class TestCheckHealthNoSnapshot:
    def test_returns_unhealthy(self, monkeypatch, tmp_path):
        monkeypatch.setattr(_health, "REPO_ROOT", tmp_path)
        result = _health.check_health()
        assert result["healthy"] is False
        assert result["status"] == "UNHEALTHY"
        assert "No data quality snapshot" in result["reason"]
        assert result["snapshot_path"] is None

    def test_returns_unhealthy_bad_json(self, monkeypatch, tmp_path):
        snap = tmp_path / "data_quality_impact_gate_20260514.json"
        snap.write_text("not json")
        monkeypatch.setattr(_health, "REPO_ROOT", tmp_path)
        result = _health.check_health()
        assert result["healthy"] is False
        assert "Failed to parse" in result["reason"]


class TestCheckHealthHealthy:
    def test_all_metrics_ok(self, monkeypatch, tmp_path):
        snap = _write_snapshot(
            tmp_path,
            {
                "timestamp": _recent_iso(),
                "impact_gate_scan": {
                    "total_done_fix_issues": 100,
                    "gated": {"pass": 80, "fail": 5, "error": 5, "bypassed": 5, "skipped": 5},
                    "ungated_count": 0,
                    "coverage_pct": 100.0,
                },
            },
        )
        monkeypatch.setattr(_health, "REPO_ROOT", tmp_path)
        result = _health.check_health()
        assert result["healthy"] is True
        assert result["status"] == "HEALTHY"
        assert result["coverage_pct"] == 100.0
        assert result["error_rate_pct"] == 5.0
        assert result["fail_rate_pct"] == 5.0

    def test_coverage_at_threshold_exactly(self, monkeypatch, tmp_path):
        snap = _write_snapshot(
            tmp_path,
            {
                "timestamp": _recent_iso(),
                "impact_gate_scan": {
                    "total_done_fix_issues": 100,
                    "gated": {"pass": 90, "fail": 3, "error": 3, "bypassed": 2, "skipped": 2},
                    "ungated_count": 0,
                    "coverage_pct": 90.0,
                },
            },
        )
        monkeypatch.setattr(_health, "REPO_ROOT", tmp_path)
        result = _health.check_health()
        assert result["healthy"] is True

    def test_zero_total_issues(self, monkeypatch, tmp_path):
        snap = _write_snapshot(
            tmp_path,
            {
                "timestamp": _recent_iso(),
                "impact_gate_scan": {
                    "total_done_fix_issues": 0,
                    "gated": {"pass": 0, "fail": 0, "error": 0, "bypassed": 0, "skipped": 0},
                    "ungated_count": 0,
                    "coverage_pct": 0.0,
                },
            },
        )
        monkeypatch.setattr(_health, "REPO_ROOT", tmp_path)
        result = _health.check_health(coverage_threshold_pct=0)
        assert result["healthy"] is True
        assert result["error_rate_pct"] == 0.0


class TestCheckHealthStale:
    def test_snapshot_too_old(self, monkeypatch, tmp_path):
        snap = _write_snapshot(
            tmp_path,
            {
                "timestamp": _stale_iso(20),
                "impact_gate_scan": {
                    "total_done_fix_issues": 100,
                    "gated": {"pass": 80, "fail": 5, "error": 5, "bypassed": 5, "skipped": 5},
                    "ungated_count": 0,
                    "coverage_pct": 100.0,
                },
            },
        )
        monkeypatch.setattr(_health, "REPO_ROOT", tmp_path)
        result = _health.check_health(stale_threshold_min=10)
        assert result["healthy"] is False
        assert "Stale" in result["reason"] or "stale" in result["reason"]

    def test_snapshot_missing_timestamp(self, monkeypatch, tmp_path):
        snap = _write_snapshot(
            tmp_path,
            {
                "impact_gate_scan": {
                    "total_done_fix_issues": 100,
                    "gated": {"pass": 80, "fail": 5, "error": 5, "bypassed": 5, "skipped": 5},
                    "ungated_count": 0,
                    "coverage_pct": 100.0,
                },
            },
        )
        monkeypatch.setattr(_health, "REPO_ROOT", tmp_path)
        result = _health.check_health(stale_threshold_min=10)
        assert result["healthy"] is False
        assert "timestamp missing" in result["reason"].lower()

    def test_custom_stale_threshold(self, monkeypatch, tmp_path):
        snap = _write_snapshot(
            tmp_path,
            {
                "timestamp": _stale_iso(12),
                "impact_gate_scan": {
                    "total_done_fix_issues": 100,
                    "gated": {"pass": 80, "fail": 5, "error": 5, "bypassed": 5, "skipped": 5},
                    "ungated_count": 0,
                    "coverage_pct": 100.0,
                },
            },
        )
        monkeypatch.setattr(_health, "REPO_ROOT", tmp_path)
        strict = _health.check_health(stale_threshold_min=10)
        assert strict["healthy"] is False
        relaxed = _health.check_health(stale_threshold_min=15)
        assert relaxed["healthy"] is True


class TestCheckHealthLowCoverage:
    def test_coverage_below_threshold(self, monkeypatch, tmp_path):
        snap = _write_snapshot(
            tmp_path,
            {
                "timestamp": _recent_iso(),
                "impact_gate_scan": {
                    "total_done_fix_issues": 100,
                    "gated": {"pass": 50, "fail": 20, "error": 5, "bypassed": 10, "skipped": 5},
                    "ungated_count": 10,
                    "coverage_pct": 80.0,
                },
            },
        )
        monkeypatch.setattr(_health, "REPO_ROOT", tmp_path)
        result = _health.check_health(coverage_threshold_pct=90)
        assert result["healthy"] is False
        assert "Coverage" in result["reason"]


class TestCheckHealthHighErrorRate:
    def test_error_rate_above_threshold(self, monkeypatch, tmp_path):
        snap = _write_snapshot(
            tmp_path,
            {
                "timestamp": _recent_iso(),
                "impact_gate_scan": {
                    "total_done_fix_issues": 100,
                    "gated": {"pass": 40, "fail": 10, "error": 40, "bypassed": 5, "skipped": 5},
                    "ungated_count": 0,
                    "coverage_pct": 100.0,
                },
            },
        )
        monkeypatch.setattr(_health, "REPO_ROOT", tmp_path)
        result = _health.check_health(error_rate_threshold_pct=30)
        assert result["healthy"] is False
        assert "Error rate" in result["reason"]

    def test_error_rate_below_threshold(self, monkeypatch, tmp_path):
        snap = _write_snapshot(
            tmp_path,
            {
                "timestamp": _recent_iso(),
                "impact_gate_scan": {
                    "total_done_fix_issues": 100,
                    "gated": {"pass": 60, "fail": 10, "error": 25, "bypassed": 0, "skipped": 5},
                    "ungated_count": 0,
                    "coverage_pct": 100.0,
                },
            },
        )
        monkeypatch.setattr(_health, "REPO_ROOT", tmp_path)
        result = _health.check_health(error_rate_threshold_pct=30)
        assert result["healthy"] is True


class TestCheckHealthHighFailRate:
    def test_fail_rate_above_threshold(self, monkeypatch, tmp_path):
        snap = _write_snapshot(
            tmp_path,
            {
                "timestamp": _recent_iso(),
                "impact_gate_scan": {
                    "total_done_fix_issues": 100,
                    "gated": {"pass": 40, "fail": 40, "error": 5, "bypassed": 10, "skipped": 5},
                    "ungated_count": 0,
                    "coverage_pct": 100.0,
                },
            },
        )
        monkeypatch.setattr(_health, "REPO_ROOT", tmp_path)
        result = _health.check_health(fail_rate_threshold_pct=30)
        assert result["healthy"] is False
        assert "Fail rate" in result["reason"]


class TestCheckHealthMultipleIssues:
    def test_all_issues_reported(self, monkeypatch, tmp_path):
        snap = _write_snapshot(
            tmp_path,
            {
                "timestamp": _stale_iso(20),
                "impact_gate_scan": {
                    "total_done_fix_issues": 100,
                    "gated": {"pass": 10, "fail": 50, "error": 10, "bypassed": 5, "skipped": 5},
                    "ungated_count": 20,
                    "coverage_pct": 70.0,
                },
            },
        )
        monkeypatch.setattr(_health, "REPO_ROOT", tmp_path)
        result = _health.check_health(
            stale_threshold_min=10,
            coverage_threshold_pct=90,
            error_rate_threshold_pct=30,
            fail_rate_threshold_pct=30,
        )
        assert result["healthy"] is False
        assert "Stale" in result["reason"] or "stale" in result["reason"]
        assert "Coverage" in result["reason"]
        assert "Fail rate" in result["reason"]


class TestMain:
    def test_healthy_exits_zero(self, monkeypatch, tmp_path, capsys):
        snap = _write_snapshot(
            tmp_path,
            {
                "timestamp": _recent_iso(),
                "impact_gate_scan": {
                    "total_done_fix_issues": 100,
                    "gated": {"pass": 80, "fail": 5, "error": 5, "bypassed": 5, "skipped": 5},
                    "ungated_count": 0,
                    "coverage_pct": 100.0,
                },
            },
        )
        monkeypatch.setattr(_health, "REPO_ROOT", tmp_path)
        monkeypatch.setattr(sys, "argv", ["impact_gate_scan_health.py"])
        rc = _health.main()
        assert rc == 0

    def test_unhealthy_exits_nonzero(self, monkeypatch, tmp_path, capsys):
        monkeypatch.setattr(_health, "REPO_ROOT", tmp_path)
        monkeypatch.setattr(
            sys, "argv", ["impact_gate_scan_health.py"]
        )
        rc = _health.main()
        assert rc == 1

    def test_json_summary_outputs_json(self, monkeypatch, tmp_path, capsys):
        snap = _write_snapshot(
            tmp_path,
            {
                "timestamp": _recent_iso(),
                "impact_gate_scan": {
                    "total_done_fix_issues": 100,
                    "gated": {"pass": 80, "fail": 5, "error": 5, "bypassed": 5, "skipped": 5},
                    "ungated_count": 0,
                    "coverage_pct": 100.0,
                },
            },
        )
        monkeypatch.setattr(_health, "REPO_ROOT", tmp_path)
        monkeypatch.setattr(
            sys, "argv", ["impact_gate_scan_health.py", "--json-summary"]
        )
        _health.main()
        out = capsys.readouterr().out
        assert json.loads(out)

    def test_custom_thresholds_passed(self, monkeypatch, tmp_path):
        snap = _write_snapshot(
            tmp_path,
            {
                "timestamp": _stale_iso(20),
                "impact_gate_scan": {
                    "total_done_fix_issues": 100,
                    "gated": {"pass": 80, "fail": 5, "error": 5, "bypassed": 5, "skipped": 5},
                    "ungated_count": 0,
                    "coverage_pct": 100.0,
                },
            },
        )
        monkeypatch.setattr(_health, "REPO_ROOT", tmp_path)
        monkeypatch.setattr(
            sys,
            "argv",
            [
                "impact_gate_scan_health.py",
                "--stale-threshold-min", "30",
                "--coverage-threshold-pct", "80",
            ],
        )
        rc = _health.main()
        assert rc == 0
