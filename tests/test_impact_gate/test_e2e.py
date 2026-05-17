"""End-to-end tests for impact_gate_runner — exercises the real runner with live test files.

Tests the full pipeline:
  1. FR/bug ID → file path resolution
  2. pytest invocation on resolved test files
  3. JUnit XML parsing
  4. Result aggregation into the expected schema

This test does NOT mock the runner or pytest. It runs real tests against the
FR acceptance and bug regression suites. The test files are expected to be
self-contained (no live network, no real DB).
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from impact_gate_runner import run as run_impact_gate_runner

_HERE = Path(__file__).resolve().parent
_REPO_ROOT = _HERE.parents[1]


class TestImpactGateRunnerE2E:
    """End-to-end tests that exercise the real impact_gate_runner.run() function."""

    def test_runner_with_existing_fr_id(self):
        """Runner correctly resolves an existing FR ID, runs tests, and returns PASS."""
        result = run_impact_gate_runner(["FDR-850"], [])
        assert result["status"] == "PASS", (
            f"Expected PASS, got {result['status']}: {result}"
        )
        assert "FDR-850" in result["fr_results"]
        fr_entry = result["fr_results"]["FDR-850"]
        assert fr_entry["status"] == "PASS"
        assert fr_entry["test_file"] == "tests/fr_acceptance/test_fdr_850.py"
        assert fr_entry["passed"] >= 3  # 3 test functions in test_fdr_850
        assert fr_entry["failed"] == 0
        assert result["summary"]["total"] >= 3
        assert result["summary"]["failed"] == 0

    def test_runner_with_existing_bug_id(self):
        """Runner correctly resolves an existing bug ID, runs tests, and returns PASS."""
        result = run_impact_gate_runner([], ["BTCAAAAA-736"])
        assert result["status"] == "PASS", (
            f"Expected PASS, got {result['status']}: {result}"
        )
        assert "BTCAAAAA-736" in result["bug_results"]
        bug_entry = result["bug_results"]["BTCAAAAA-736"]
        assert bug_entry["status"] == "PASS"
        assert (
            bug_entry["test_file"]
            == "tests/bug_regression/test_btcaaaaa_736_regression.py"
        )

    def test_runner_with_both_fr_and_bug(self):
        """Runner handles both FR and bug IDs in a single invocation."""
        result = run_impact_gate_runner(["FDR-850"], ["BTCAAAAA-736"])
        assert result["status"] == "PASS"
        assert "FDR-850" in result["fr_results"]
        assert "BTCAAAAA-736" in result["bug_results"]
        fr_entry = result["fr_results"]["FDR-850"]
        bug_entry = result["bug_results"]["BTCAAAAA-736"]
        assert fr_entry["status"] == "PASS"
        assert bug_entry["status"] == "PASS"
        # Summary should reflect combined test counts
        total = result["summary"]["total"]
        assert total >= 3 + 3, f"Expected at least 6 tests, got {total}"

    def test_runner_with_missing_fr_id(self):
        """Runner reports MISSING status for a non-existent FR ID."""
        result = run_impact_gate_runner(["FDR-99999"], [])
        assert "FDR-99999" in result["fr_results"]
        fr_entry = result["fr_results"]["FDR-99999"]
        assert fr_entry["status"] == "MISSING"
        assert "test_fdr_99999.py" in fr_entry["test_file"] or "test_btcaaaaa_99999.py" in fr_entry["test_file"]

    def test_runner_with_missing_bug_id(self):
        """Runner reports MISSING status for a non-existent bug ID."""
        result = run_impact_gate_runner([], ["BTCAAAAA-99999"])
        assert "BTCAAAAA-99999" in result["bug_results"]
        bug_entry = result["bug_results"]["BTCAAAAA-99999"]
        assert bug_entry["status"] == "MISSING"
        assert "test_btcaaaaa_99999_regression.py" in bug_entry["test_file"]

    def test_runner_with_no_ids_returns_error(self):
        """Runner returns ERROR when no test files exist (all IDs missing)."""
        result = run_impact_gate_runner(["FDR-99998"], ["BTCAAAAA-99998"])
        assert result["status"] == "ERROR"
        assert result["summary"]["missing_test_files"] == 2

    def test_runner_output_has_correct_schema(self):
        """Runner output matches the expected JSON schema."""
        result = run_impact_gate_runner(["FDR-850"], ["BTCAAAAA-736"])
        # Top-level keys
        assert "timestamp" in result
        assert "status" in result
        assert "summary" in result
        assert "fr_results" in result
        assert "bug_results" in result
        # Summary keys
        summary = result["summary"]
        assert "total" in summary
        assert "passed" in summary
        assert "failed" in summary
        assert "errors" in summary
        assert "zero_test_files" in summary
        assert "missing_test_files" in summary
        # Result entry keys
        for entry in list(result["fr_results"].values()) + list(
            result["bug_results"].values()
        ):
            assert "status" in entry
            assert "test_file" in entry
            assert "tests" in entry

    def test_runner_junit_parsing_structure(self):
        """JUnit XML is correctly parsed into the expected test structure."""
        result = run_impact_gate_runner(["FDR-850"], [])
        fr_entry = result["fr_results"]["FDR-850"]
        tests = fr_entry["tests"]
        assert len(tests) >= 3
        for t in tests:
            assert "nodeid" in t
            assert "outcome" in t
            assert t["outcome"] in ("passed", "failed", "error", "skipped")
            assert "test_fdr_850" in t["nodeid"]

    def test_runner_with_zero_tests_returns_error(self):
        """Runner returns ERROR when a test file exists but collects zero tests."""
        temp_file = _REPO_ROOT / "tests" / "fr_acceptance" / "test_fdr_99997.py"
        try:
            temp_file.write_text(
                "import pytest\n\n# No test functions - zero tests collected\n"
            )
            result = run_impact_gate_runner(["FDR-99997"], [])
            assert result["status"] == "ERROR", (
                f"Expected ERROR, got {result['status']}"
            )
            assert "FDR-99997" in result["fr_results"]
            fr_entry = result["fr_results"]["FDR-99997"]
            assert fr_entry["status"] == "ERROR"
            assert fr_entry["test_file"] == "tests/fr_acceptance/test_fdr_99997.py"
            assert result["summary"]["zero_test_files"] == 1
        finally:
            if temp_file.exists():
                temp_file.unlink()


class TestImpactGateRunnerCLI:
    """E2E tests that exercise the CLI entry point via subprocess."""

    _runner_script = _REPO_ROOT / "scripts" / "impact_gate_runner.py"

    def test_cli_with_frs(self):
        """CLI --frs flag works and outputs valid JSON."""
        proc = subprocess.run(
            [
                sys.executable,
                str(self._runner_script),
                "--frs",
                "FDR-850",
                "--output",
                "json",
            ],
            capture_output=True,
            text=True,
            cwd=str(_REPO_ROOT),
            timeout=60,
        )
        assert proc.returncode == 0, f"CLI exited {proc.returncode}: {proc.stderr}"
        result = json.loads(proc.stdout)
        assert result["status"] == "PASS"
        assert "FDR-850" in result["fr_results"]

    def test_cli_with_bugs(self):
        """CLI --bugs flag works and outputs valid JSON."""
        proc = subprocess.run(
            [
                sys.executable,
                str(self._runner_script),
                "--bugs",
                "BTCAAAAA-736",
                "--output",
                "json",
            ],
            capture_output=True,
            text=True,
            cwd=str(_REPO_ROOT),
            timeout=60,
        )
        assert proc.returncode == 0
        result = json.loads(proc.stdout)
        assert result["status"] == "PASS"

    def test_cli_with_missing_ids_returns_nonzero(self):
        """CLI exits non-zero when all test files are missing."""
        proc = subprocess.run(
            [
                sys.executable,
                str(self._runner_script),
                "--frs",
                "FDR-99999",
                "--output",
                "json",
            ],
            capture_output=True,
            text=True,
            cwd=str(_REPO_ROOT),
            timeout=60,
        )
        assert proc.returncode == 1

    def test_cli_pretty_output(self):
        """CLI --output pretty produces indented JSON."""
        proc = subprocess.run(
            [
                sys.executable,
                str(self._runner_script),
                "--frs",
                "FDR-850",
                "--output",
                "pretty",
            ],
            capture_output=True,
            text=True,
            cwd=str(_REPO_ROOT),
            timeout=60,
        )
        assert proc.returncode == 0
        result = json.loads(proc.stdout)
        assert result["status"] == "PASS"
