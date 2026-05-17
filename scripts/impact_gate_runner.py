#!/usr/bin/env python3
"""
Impact Gate Test Runner

Runs FR acceptance tests and/or bug regression tests by ID and emits a
machine-readable JSON result.  Designed for the Phase 3 Impact Gate check.

Usage
-----
  python scripts/impact_gate_runner.py --frs FDR-850,FDR-851 --bugs BTCAAAAA-736
  python scripts/impact_gate_runner.py --frs FDR-850
  python scripts/impact_gate_runner.py --bugs BTCAAAAA-736,BTCAAAAA-638

Output schema
-------------
{
  "timestamp": "<ISO-8601>",
  "status": "PASS" | "FAIL" | "ERROR",
  "summary": {
    "total": <int>,
    "passed": <int>,
    "failed": <int>,
    "errors": <int>,
    "missing_test_files": <int>
  },
  "fr_results": {
    "FDR-850": {
      "status": "PASS" | "FAIL" | "ERROR" | "MISSING",
      "test_file": "tests/fr_acceptance/test_fdr_850.py",
      "tests": [{"nodeid": "...", "outcome": "passed|failed|error", "message": "..."}]
    }
  },
  "bug_results": {
    "BTCAAAAA-736": {
      "status": "PASS" | "FAIL" | "ERROR" | "MISSING",
      "test_file": "tests/bug_regression/test_btcaaaaa_736_regression.py",
      "tests": [...]
    }
  }
}

Exit codes
----------
  0 — all collected tests passed
  1 — one or more tests failed or errored
  2 — argument / usage error
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = REPO_ROOT / "src"
FR_ACCEPTANCE_DIR = REPO_ROOT / "tests" / "fr_acceptance"
BUG_REGRESSION_DIR = REPO_ROOT / "tests" / "bug_regression"

# PYTHONPATH for subprocess — ensures src/ is resolvable in any environment
_DEFAULT_PYTHONPATH = str(SRC_DIR)


# ---------------------------------------------------------------------------
# ID → file path resolution
# ---------------------------------------------------------------------------


def _fr_test_path(fr_id: str) -> Path | None:
    """Map 'FDR-850' → tests/fr_acceptance/test_fdr_850.py

    Also accepts BTCAAAAA-NNN format and tries both naming conventions.
    Returns None when the FR ID format is not recognized.
    """
    m = re.fullmatch(r"(?:FDR|BTCAAAAA)-(\d+)", fr_id, re.IGNORECASE)
    if not m:
        return None
    num = m.group(1)
    path = FR_ACCEPTANCE_DIR / f"test_fdr_{num}.py"
    if path.exists():
        return path
    return FR_ACCEPTANCE_DIR / f"test_btcaaaaa_{num}.py"


def _bug_test_path(bug_id: str) -> Path | None:
    """Map 'BTCAAAAA-736' → tests/bug_regression/test_btcaaaaa_736_regression.py"""
    m = re.fullmatch(r"BTCAAAAA-(\d+)", bug_id, re.IGNORECASE)
    if not m:
        return None
    return BUG_REGRESSION_DIR / f"test_btcaaaaa_{m.group(1)}_regression.py"


# ---------------------------------------------------------------------------
# JUnit XML parsing  (uses pytest --junitxml — no extra packages required)
# ---------------------------------------------------------------------------


def _parse_junit(xml_path: str, file_paths: list[Path]) -> dict[str, list[dict]]:
    """
    Parse a JUnit XML file and return {relative_test_file: [test_result, ...]} mapping.
    """
    tree = ET.parse(xml_path)
    root = tree.getroot()

    results: dict[str, list[dict]] = {}
    for tc in root.iter("testcase"):
        classname = tc.get("classname", "")
        name = tc.get("name", "")
        # JUnit nodeid is encoded as classname::name but the file part is classname
        # pytest encodes the file path in classname as dotted module path.
        # We reconstruct the file-relative path.
        file_part = classname.replace(".", "/")
        if "::" in file_part:
            file_part = file_part.split("::")[0]

        # Find which of our target files this test belongs to
        matched_file = None
        for p in file_paths:
            rel = str(p.relative_to(REPO_ROOT)).replace("/", ".").removesuffix(".py")
            if classname.startswith(rel) or file_part.startswith(
                str(p.relative_to(REPO_ROOT)).removesuffix(".py").replace("/", ".")
            ):
                matched_file = str(p.relative_to(REPO_ROOT))
                break

        if matched_file is None:
            # Fallback: use the file attribute on the testcase if present
            file_attr = tc.get("file", "")
            if file_attr:
                matched_file = file_attr

        if matched_file is None:
            continue

        # Determine outcome
        failure = tc.find("failure")
        error = tc.find("error")
        skipped = tc.find("skipped")
        if failure is not None:
            outcome = "failed"
            message = (failure.get("message") or failure.text or "")[:500]
        elif error is not None:
            outcome = "error"
            message = (error.get("message") or error.text or "")[:500]
        elif skipped is not None:
            outcome = "skipped"
            message = skipped.get("message", "")
        else:
            outcome = "passed"
            message = ""

        nodeid = f"{matched_file}::{classname.split('.')[-1]}::{name}"

        results.setdefault(matched_file, []).append(
            {
                "nodeid": nodeid,
                "outcome": outcome,
                "message": message,
            }
        )

    return results


# ---------------------------------------------------------------------------
# Main runner
# ---------------------------------------------------------------------------


def run(fr_ids: list[str], bug_ids: list[str]) -> dict:
    timestamp = datetime.now(timezone.utc).isoformat()

    # Resolve paths and flag missing files up-front
    fr_paths: dict[str, Path] = {}
    bug_paths: dict[str, Path] = {}
    missing: list[str] = []

    for fid in fr_ids:
        path = _fr_test_path(fid)
        fr_paths[fid] = path
        if path is None:
            missing.append(f"unrecognized_fr_id:{fid}")
        elif not path.exists():
            missing.append(str(path.relative_to(REPO_ROOT)))

    for bid in bug_ids:
        path = _bug_test_path(bid)
        bug_paths[bid] = path
        if path is None:
            missing.append(f"unrecognized_bug_id:{bid}")
        elif not path.exists():
            missing.append(str(path.relative_to(REPO_ROOT)))

    # Pre-populate results for every requested ID.
    #
    # Start every entry as "PENDING" — the populate step below overwrites
    # entries that were actually tested with PASS / FAIL / ERROR from the
    # JUnit output.  Entries whose test file genuinely does not exist are
    # promoted to MISSING so that the worker can create a blocking issue
    # for missing coverage.  When the runner itself errors (timeout, parse
    # failure) the entries for existing test files stay as PENDING and the
    # worker will *not* create false-positive blocking issues — the top-level
    # ERROR status is sufficient to escalate the infrastructure failure.
    def _result_entry(pid: str, rel: str | None) -> dict:
        return {"status": "PENDING", "test_file": rel or f"unresolved:{pid}", "tests": []}

    fr_results: dict[str, dict] = {
        fid: _result_entry(fid, str(fr_paths[fid].relative_to(REPO_ROOT)) if fr_paths[fid] else None)
        for fid in fr_ids
    }
    bug_results: dict[str, dict] = {
        bid: _result_entry(bid, str(bug_paths[bid].relative_to(REPO_ROOT)) if bug_paths[bid] else None)
        for bid in bug_ids
    }

    # Elevate genuinely missing test files to MISSING for worker action.
    for fid, path in fr_paths.items():
        if path is None or not path.exists():
            fr_results[fid]["status"] = "MISSING"
    for bid, path in bug_paths.items():
        if path is None or not path.exists():
            bug_results[bid]["status"] = "MISSING"

    existing_paths = [
        p for p in list(fr_paths.values()) + list(bug_paths.values()) if p is not None and p.exists()
    ]

    if not existing_paths:
        return {
            "timestamp": timestamp,
            "status": "ERROR",
            "summary": {
                "total": 0,
                "passed": 0,
                "failed": 0,
                "errors": 0,
                "missing_test_files": len(missing),
            },
            "fr_results": fr_results,
            "bug_results": bug_results,
            "missing_test_files": missing,
        }

    with tempfile.NamedTemporaryFile(suffix=".xml", delete=False) as tmp:
        junit_path = tmp.name

    proc = None
    try:
        cmd = [
            sys.executable,
            "-m",
            "pytest",
            f"--junitxml={junit_path}",
            "-q",
            "--tb=short",
            "--no-header",
            "-p",
            "no:cacheprovider",
            "--no-cov",  # skip coverage for speed; the gate only cares about pass/fail
        ] + [str(p) for p in existing_paths]

        proc = subprocess.run(
            cmd,
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            timeout=120,
            env={
                **os.environ,
                "PYTHONPATH": _DEFAULT_PYTHONPATH,
            },
        )

        file_results = _parse_junit(junit_path, existing_paths)

    except subprocess.TimeoutExpired:
        return {
            "timestamp": timestamp,
            "status": "ERROR",
            "summary": {
                "total": 0,
                "passed": 0,
                "failed": 0,
                "errors": 1,
                "missing_test_files": len(missing),
            },
            "fr_results": fr_results,
            "bug_results": bug_results,
            "error": "pytest timed out after 120s",
            "pytest_stderr": proc.stderr[-2000:] if proc and proc.stderr else "",
        }
    except ET.ParseError as exc:
        _stderr_snip = proc.stderr[-2000:] if proc and proc.stderr else ""
        _stdout_snip = proc.stdout[-1000:] if proc and proc.stdout else ""
        return {
            "timestamp": timestamp,
            "status": "ERROR",
            "summary": {
                "total": 0,
                "passed": 0,
                "failed": 0,
                "errors": 1,
                "missing_test_files": len(missing),
            },
            "fr_results": fr_results,
            "bug_results": bug_results,
            "error": f"Failed to parse JUnit XML: {exc}",
            "pytest_returncode": proc.returncode if proc else None,
            "pytest_stderr": _stderr_snip,
            "pytest_stdout": _stdout_snip,
        }
    finally:
        try:
            os.unlink(junit_path)
        except OSError:
            pass

    total = passed_total = failed_total = error_total = zero_test_files = 0

    def _populate(id_path_map: dict[str, Path | None], results_dict: dict[str, dict]) -> None:
        nonlocal total, passed_total, failed_total, error_total, zero_test_files
        for tid, path in id_path_map.items():
            if path is None or not path.exists():
                continue
            rel = str(path.relative_to(REPO_ROOT))
            file_tests = file_results.get(rel, [])
            passed = sum(1 for t in file_tests if t["outcome"] == "passed")
            failed = sum(1 for t in file_tests if t["outcome"] == "failed")
            errors = sum(1 for t in file_tests if t["outcome"] == "error")

            if not file_tests:
                zero_test_files += 1
                results_dict[tid] = {
                    "status": "ERROR",
                    "test_file": rel,
                    "tests": [],
                    "passed": 0,
                    "failed": 0,
                    "error": "No tests collected — file has no test functions or all tests are excluded by markers",
                }
                continue

            total += len(file_tests)
            passed_total += passed
            failed_total += failed
            error_total += errors
            results_dict[tid] = {
                "status": "PASS" if (failed + errors) == 0 else "FAIL",
                "test_file": rel,
                "tests": file_tests,
                "passed": passed,
                "failed": failed + errors,
            }

    _populate(fr_paths, fr_results)
    _populate(bug_paths, bug_results)

    overall_failed = failed_total + error_total
    if zero_test_files > 0:
        overall = "ERROR"
    else:
        overall = "PASS" if overall_failed == 0 else "FAIL"

    return {
        "timestamp": timestamp,
        "status": overall,
        "summary": {
            "total": total,
            "passed": passed_total,
            "failed": failed_total,
            "errors": error_total,
            "zero_test_files": zero_test_files,
            "missing_test_files": len(missing),
        },
        "fr_results": fr_results,
        "bug_results": bug_results,
        **({"missing_test_files": missing} if missing else {}),
    }


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def _parse_ids(raw: str) -> list[str]:
    return [x.strip() for x in raw.split(",") if x.strip()]


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Impact Gate: run FR acceptance + bug regression tests by ID.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--frs",
        metavar="FDR-NNN[,...]",
        default="",
        help="Comma-separated FR IDs (e.g. FDR-850,FDR-851)",
    )
    parser.add_argument(
        "--bugs",
        metavar="BTCAAAAA-NNN[,...]",
        default="",
        help="Comma-separated bug IDs (e.g. BTCAAAAA-736,BTCAAAAA-638)",
    )
    parser.add_argument(
        "--output",
        choices=["json", "pretty"],
        default="json",
        help="Output format (default: json)",
    )
    args = parser.parse_args()

    fr_ids = _parse_ids(args.frs)
    bug_ids = _parse_ids(args.bugs)

    if not fr_ids and not bug_ids:
        parser.error("Provide at least one --frs or --bugs argument.")

    try:
        result = run(fr_ids, bug_ids)
    except ValueError as exc:
        print(json.dumps({"status": "ERROR", "error": str(exc)}), file=sys.stderr)  # noqa: T201
        return 2

    if args.output == "pretty":
        print(json.dumps(result, indent=2))  # noqa: T201
    else:
        print(json.dumps(result))  # noqa: T201

    return 0 if result["status"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
