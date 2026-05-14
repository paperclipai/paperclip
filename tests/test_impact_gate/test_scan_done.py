"""Unit tests for scripts/scan_fix_issues_done.py."""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[2] / "scripts"))
sys.path.insert(0, str(Path(__file__).parents[2] / "src"))

import importlib
import impact_gate.worker as _ig_worker

_scan_path = Path(__file__).parents[2] / "scripts" / "scan_fix_issues_done.py"
_spec = importlib.util.spec_from_file_location("scan_fix_issues_done", _scan_path)
_scan = importlib.util.module_from_spec(_spec)
sys.modules["scan_fix_issues_done"] = _scan
_spec.loader.exec_module(_scan)

_is_fix = _scan._is_fix_issue
_check_gate = _scan._check_gate_status
_GATE_HEADER_RE = _scan._GATE_HEADER_RE


class TestIsFixIssue:
    def test_detects_fix_label(self):
        assert _is_fix({"labels": [{"name": "fix"}], "title": "Something"}) is True

    def test_detects_bug_label(self):
        assert _is_fix({"labels": [{"name": "bug"}], "title": "Something"}) is True

    def test_detects_hotfix_label(self):
        assert _is_fix({"labels": [{"name": "hotfix"}], "title": "Something"}) is True

    def test_detects_title_keyword(self):
        assert _is_fix({"labels": [], "title": "Bug: crash on startup"}) is True

    def test_rejects_non_fix(self):
        assert (
            _is_fix({"labels": [{"name": "feature"}], "title": "New feature"}) is False
        )

    def test_case_insensitive_labels(self):
        assert _is_fix({"labels": [{"name": "FIX"}], "title": ""}) is True

    def test_case_insensitive_title(self):
        assert _is_fix({"labels": [], "title": "REGRESSION in optimizer"}) is True

    def test_no_labels_or_keywords(self):
        assert _is_fix({"labels": [], "title": "Refactor logging"}) is False

    def test_substring_fix_in_title_is_not_false_positive(self):
        assert (
            _is_fix(
                {"labels": [], "title": "Impact Gate: scan for fix issues done"}
            )
            is False
        )
        assert (
            _is_fix({"labels": [], "title": "Prefix bug in the title"})
            is False
        )


class TestGateHeaderRegex:
    def test_matches_pass(self):
        m = _GATE_HEADER_RE.search("## Impact Gate: PASS")
        assert m is not None and m.group(1) == "PASS"

    def test_matches_fail(self):
        m = _GATE_HEADER_RE.search("## Impact Gate: FAIL")
        assert m is not None and m.group(1) == "FAIL"

    def test_matches_bypass(self):
        m = _GATE_HEADER_RE.search("## Impact Gate: BYPASSED")
        assert m is not None and m.group(1) == "BYPASSED"

    def test_matches_error(self):
        m = _GATE_HEADER_RE.search("## Impact Gate: ERROR")
        assert m is not None and m.group(1) == "ERROR"

    def test_matches_skipped(self):
        m = _GATE_HEADER_RE.search("## Impact Gate: SKIPPED")
        assert m is not None and m.group(1) == "SKIPPED"

    def test_no_match_for_non_gate_header(self):
        m = _GATE_HEADER_RE.search("## Some other header")
        assert m is None

    def test_no_match_for_inline_text(self):
        m = _GATE_HEADER_RE.search("not a header ## Impact Gate: PASS")
        assert m is None

    def test_matches_in_middle_of_comment(self):
        body = "Some comment text\n\n## Impact Gate: PASS\n\nMore text"
        m = _GATE_HEADER_RE.search(body)
        assert m is not None and m.group(1) == "PASS"

    def test_matches_fail_with_details(self):
        body = """## Impact Gate: FAIL

Issue: **BTCAAAAA-100**

One or more tests failed."""
        m = _GATE_HEADER_RE.search(body)
        assert m is not None and m.group(1) == "FAIL"


class TestCheckGateStatus:
    def test_detects_pass(self, monkeypatch):
        monkeypatch.setattr(_scan, "_load_muted_state", lambda: {})
        monkeypatch.setattr(
            _scan,
            "fetch_issue_comments",
            lambda iid: [
                {"body": "## Impact Gate: PASS\n\nAll tests passed."},
            ],
        )
        assert _check_gate("any-id") == "PASS"

    def test_detects_fail(self, monkeypatch):
        monkeypatch.setattr(_scan, "_load_muted_state", lambda: {})
        monkeypatch.setattr(
            _scan,
            "fetch_issue_comments",
            lambda iid: [
                {"body": "## Impact Gate: FAIL\n\nTests failed."},
            ],
        )
        assert _check_gate("any-id") == "FAIL"

    def test_detects_bypassed(self, monkeypatch):
        monkeypatch.setattr(_scan, "_load_muted_state", lambda: {})
        monkeypatch.setattr(
            _scan,
            "fetch_issue_comments",
            lambda iid: [
                {"body": "## Impact Gate: BYPASSED\n\nCEO bypass."},
            ],
        )
        assert _check_gate("any-id") == "BYPASSED"

    def test_returns_none_when_no_gate_comment(self, monkeypatch):
        monkeypatch.setattr(_scan, "_load_muted_state", lambda: {})
        monkeypatch.setattr(
            _scan,
            "fetch_issue_comments",
            lambda iid: [
                {"body": "Some other comment"},
                {"body": "Fixed the bug"},
            ],
        )
        assert _check_gate("any-id") is None

    def test_returns_none_on_empty_comments(self, monkeypatch):
        monkeypatch.setattr(_scan, "_load_muted_state", lambda: {})
        monkeypatch.setattr(_scan, "fetch_issue_comments", lambda iid: [])
        assert _check_gate("any-id") is None
    def test_returns_most_recent_gate_result(self, monkeypatch):
        """When an issue has multiple gate comments (re-run), return the newest."""
        monkeypatch.setattr(_scan, "_load_muted_state", lambda: {})
        monkeypatch.setattr(
            _scan,
            "fetch_issue_comments",
            lambda iid: [
                {"body": "## Impact Gate: FAIL\n\nTests failed."},
                {"body": "## Impact Gate: PASS \u2705\n\nAll tests passed after fix."},
            ],
        )
        assert _check_gate("any-id") == "PASS"


    def test_detects_skipped(self, monkeypatch):
        monkeypatch.setattr(_scan, "_load_muted_state", lambda: {})
        monkeypatch.setattr(
            _scan,
            "fetch_issue_comments",
            lambda iid: [
                {"body": "## Impact Gate: SKIPPED\n\nNo touched files found."},
            ],
        )
        assert _check_gate("any-id") == "SKIPPED"

    def test_handles_api_failure_gracefully(self, monkeypatch):
        monkeypatch.setattr(_scan, "_load_muted_state", lambda: {})
        monkeypatch.setattr(
            _scan,
            "fetch_issue_comments",
            lambda iid: (_ for _ in ()).throw(RuntimeError("API down")),
        )
        assert _check_gate("any-id") is None


class TestScanFunction:
    def test_scan_with_no_issues(self, monkeypatch):
        monkeypatch.setattr(_scan, "_paginate", lambda path, params, page_size=100: [])
        monkeypatch.setattr(_scan, "_company", lambda: "comp-uuid")
        result = _scan.scan()
        assert result["total_done_fix_issues"] == 0
        assert result["ungated_count"] == 0
        assert result["gated"] == {
            "pass": 0,
            "fail": 0,
            "bypassed": 0,
            "error": 0,
            "skipped": 0,
        }

    def test_scan_filters_fix_issues(self, monkeypatch):
        monkeypatch.setattr(_scan, "_load_muted_state", lambda: {})
        monkeypatch.setattr(
            _scan,
            "_paginate",
            lambda path, params, page_size=100: [
                {
                    "id": "u1",
                    "identifier": "BTCAAAAA-100",
                    "title": "Fix crash",
                    "labels": [{"name": "fix"}],
                    "status": "done",
                },
                {
                    "id": "u2",
                    "identifier": "BTCAAAAA-101",
                    "title": "New feature",
                    "labels": [{"name": "feature"}],
                    "status": "done",
                },
            ],
        )
        monkeypatch.setattr(_scan, "_company", lambda: "comp-uuid")
        monkeypatch.setattr(
            _scan,
            "fetch_issue_comments",
            lambda iid: [{"body": "## Impact Gate: PASS"}],
        )
        result = _scan.scan()
        assert result["total_done_fix_issues"] == 1

    def test_scan_counts_gated_vs_ungated(self, monkeypatch):
        monkeypatch.setattr(_scan, "_load_muted_state", lambda: {})
        monkeypatch.setattr(
            _scan,
            "_paginate",
            lambda path, params, page_size=100: [
                {
                    "id": "u1",
                    "identifier": "BTCAAAAA-100",
                    "title": "Fix A",
                    "labels": [{"name": "fix"}],
                    "status": "done",
                },
                {
                    "id": "u2",
                    "identifier": "BTCAAAAA-101",
                    "title": "Fix B",
                    "labels": [{"name": "fix"}],
                    "status": "done",
                },
            ],
        )
        monkeypatch.setattr(_scan, "_company", lambda: "comp-uuid")

        call_count = 0

        def mock_comments(iid):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return [{"body": "## Impact Gate: PASS"}]
            return [{"body": "Some other comment"}]

        monkeypatch.setattr(_scan, "fetch_issue_comments", mock_comments)
        result = _scan.scan()
        assert result["total_done_fix_issues"] == 2
        assert result["gated"]["pass"] == 1
        assert result["ungated_count"] == 1

    def test_scan_respects_days_back(self, monkeypatch):
        from datetime import datetime, timezone, timedelta

        recent = (
            (datetime.now(timezone.utc) - timedelta(hours=1))
            .isoformat()
            .replace("+00:00", "Z")
        )
        old = (
            (datetime.now(timezone.utc) - timedelta(days=30))
            .isoformat()
            .replace("+00:00", "Z")
        )

        monkeypatch.setattr(
            _scan,
            "_paginate",
            lambda path, params, page_size=100: [
                {
                    "id": "u1",
                    "identifier": "BTCAAAAA-100",
                    "title": "Fix recent",
                    "labels": [{"name": "fix"}],
                    "status": "done",
                    "completedAt": recent,
                },
                {
                    "id": "u2",
                    "identifier": "BTCAAAAA-101",
                    "title": "Fix old",
                    "labels": [{"name": "fix"}],
                    "status": "done",
                    "completedAt": old,
                },
            ],
        )
        monkeypatch.setattr(_scan, "_company", lambda: "comp-uuid")
        monkeypatch.setattr(
            _scan,
            "fetch_issue_comments",
            lambda iid: [{"body": "## Impact Gate: PASS"}],
        )
        result = _scan.scan(days_back=7)
        assert result["total_done_fix_issues"] == 1
        assert result["gated"]["pass"] == 1

    def test_dry_run_does_not_run_retroactive(self, monkeypatch):
        monkeypatch.setattr(_scan, "_load_muted_state", lambda: {})
        monkeypatch.setattr(
            _scan,
            "_paginate",
            lambda path, params, page_size=100: [
                {
                    "id": "u1",
                    "identifier": "BTCAAAAA-100",
                    "title": "Fix",
                    "labels": [{"name": "fix"}],
                    "status": "done",
                },
            ],
        )
        monkeypatch.setattr(_scan, "_company", lambda: "comp-uuid")
        monkeypatch.setattr(
            _scan, "fetch_issue_comments", lambda iid: [{"body": "Other comment"}]
        )
        process_called = []
        monkeypatch.setattr(
            _scan,
            "process_issue",
            lambda iid, dry_run=False, **kwargs: (
                process_called.append(iid) or {"gate_status": "PASS"}
            ),
        )
        _scan.scan(dry_run=True, retroactive=True)
        assert len(process_called) == 0

    def test_retroactive_runs_process_on_ungated(self, monkeypatch):
        monkeypatch.setattr(_scan, "_load_muted_state", lambda: {})
        monkeypatch.setattr(
            _scan,
            "_paginate",
            lambda path, params, page_size=100: [
                {
                    "id": "u1",
                    "identifier": "BTCAAAAA-100",
                    "title": "Fix",
                    "labels": [{"name": "fix"}],
                    "status": "done",
                },
            ],
        )
        monkeypatch.setattr(_scan, "_company", lambda: "comp-uuid")
        monkeypatch.setattr(
            _scan, "fetch_issue_comments", lambda iid: [{"body": "Other comment"}]
        )
        calls = []
        monkeypatch.setattr(
            _scan,
            "process_issue",
            lambda iid, dry_run=False, **kwargs: (
                calls.append({"iid": iid, "kwargs": kwargs}) or {"gate_status": "PASS"}
            ),
        )
        result = _scan.scan(dry_run=False, retroactive=True)
        assert len(calls) == 1
        assert calls[0]["iid"] == "u1"
        assert calls[0]["kwargs"].get("force") is True
        assert "retroactive_results" in result
        assert result["retroactive_results"][0]["gate_status"] == "PASS"

    def test_retroactive_handles_process_error(self, monkeypatch):
        monkeypatch.setattr(_scan, "_load_muted_state", lambda: {})
        monkeypatch.setattr(
            _scan,
            "_paginate",
            lambda path, params, page_size=100: [
                {
                    "id": "u1",
                    "identifier": "BTCAAAAA-100",
                    "title": "Fix",
                    "labels": [{"name": "fix"}],
                    "status": "done",
                },
            ],
        )
        monkeypatch.setattr(_scan, "_company", lambda: "comp-uuid")
        monkeypatch.setattr(
            _scan, "fetch_issue_comments", lambda iid: [{"body": "Other comment"}]
        )
        monkeypatch.setattr(
            _scan,
            "process_issue",
            lambda iid, dry_run=False, **kwargs: (_ for _ in ()).throw(
                RuntimeError("runner crashed")
            ),
        )
        result = _scan.scan(dry_run=False, retroactive=True)
        assert "retroactive_results" in result
        assert "error" in result["retroactive_results"][0]
        assert "runner crashed" in result["retroactive_results"][0]["error"]

    def test_scan_counts_all_gate_statuses(self, monkeypatch):
        monkeypatch.setattr(_scan, "_load_muted_state", lambda: {})
        monkeypatch.setattr(
            _scan,
            "_paginate",
            lambda path, params, page_size=100: [
                {
                    "id": "u1",
                    "identifier": "BTCAAAAA-100",
                    "title": "Fix A",
                    "labels": [{"name": "fix"}],
                    "status": "done",
                },
                {
                    "id": "u2",
                    "identifier": "BTCAAAAA-101",
                    "title": "Fix B",
                    "labels": [{"name": "bug"}],
                    "status": "done",
                },
                {
                    "id": "u3",
                    "identifier": "BTCAAAAA-102",
                    "title": "Fix C",
                    "labels": [{"name": "fix"}],
                    "status": "done",
                },
                {
                    "id": "u4",
                    "identifier": "BTCAAAAA-103",
                    "title": "Fix D",
                    "labels": [{"name": "fix"}],
                    "status": "done",
                },
                {
                    "id": "u5",
                    "identifier": "BTCAAAAA-104",
                    "title": "Fix E",
                    "labels": [{"name": "fix"}],
                    "status": "done",
                },
            ],
        )
        monkeypatch.setattr(_scan, "_company", lambda: "comp-uuid")

        def mock_comments(iid):
            mapping = {
                "u1": "PASS",
                "u2": "FAIL",
                "u3": "BYPASSED",
                "u4": "ERROR",
                "u5": "SKIPPED",
            }
            status = mapping.get(iid, "PASS")
            return [{"body": f"## Impact Gate: {status}"}]

        monkeypatch.setattr(_scan, "fetch_issue_comments", mock_comments)
        result = _scan.scan()
        assert result["total_done_fix_issues"] == 5
        assert result["gated"]["pass"] == 1
        assert result["gated"]["fail"] == 1
        assert result["gated"]["bypassed"] == 1
        assert result["gated"]["error"] == 1
        assert result["gated"]["skipped"] == 1
        assert result["ungated_count"] == 0

    def test_last_24h_aggregates_recent_issues(self, monkeypatch):
        from datetime import datetime, timezone, timedelta
        recent = (
            (datetime.now(timezone.utc) - timedelta(hours=1))
            .isoformat()
            .replace("+00:00", "Z")
        )
        old = (
            (datetime.now(timezone.utc) - timedelta(hours=48))
            .isoformat()
            .replace("+00:00", "Z")
        )
        monkeypatch.setattr(
            _scan,
            "_paginate",
            lambda path, params, page_size=100: [
                {
                    "id": "u1",
                    "identifier": "BTCAAAAA-100",
                    "title": "Fix recent gated",
                    "labels": [{"name": "fix"}],
                    "status": "done",
                    "completedAt": recent,
                },
                {
                    "id": "u2",
                    "identifier": "BTCAAAAA-101",
                    "title": "Fix recent ungated",
                    "labels": [{"name": "fix"}],
                    "status": "done",
                    "completedAt": recent,
                },
                {
                    "id": "u3",
                    "identifier": "BTCAAAAA-102",
                    "title": "Fix old gated",
                    "labels": [{"name": "fix"}],
                    "status": "done",
                    "completedAt": old,
                },
            ],
        )
        monkeypatch.setattr(_scan, "_company", lambda: "comp-uuid")
        call_count = 0
        def mock_comments(iid):
            nonlocal call_count
            call_count += 1
            if iid in ("u1", "u3"):
                return [{"body": "## Impact Gate: PASS"}]
            return [{"body": "Other comment"}]
        monkeypatch.setattr(_scan, "fetch_issue_comments", mock_comments)
        result = _scan.scan()
        l24 = result.get("last_24h", {})
        assert l24["total_done_fix_issues"] == 2, (
            f"Expected 2 recent issues, got {l24['total_done_fix_issues']}"
        )
        assert l24["gated"]["pass"] == 1
        assert l24["ungated_count"] == 1
        assert result["total_done_fix_issues"] == 3

    def test_scan_no_completed_at_falls_back_to_updated_at(self, monkeypatch):
        from datetime import datetime, timezone, timedelta

        recent = (
            (datetime.now(timezone.utc) - timedelta(hours=1))
            .isoformat()
            .replace("+00:00", "Z")
        )
        monkeypatch.setattr(
            _scan,
            "_paginate",
            lambda path, params, page_size=100: [
                {
                    "id": "u1",
                    "identifier": "BTCAAAAA-100",
                    "title": "Fix",
                    "labels": [{"name": "fix"}],
                    "status": "done",
                    "updatedAt": recent,
                },
            ],
        )
        monkeypatch.setattr(_scan, "_company", lambda: "comp-uuid")
        monkeypatch.setattr(
            _scan,
            "fetch_issue_comments",
            lambda iid: [{"body": "## Impact Gate: PASS"}],
        )
        result = _scan.scan(days_back=7)
        assert result["total_done_fix_issues"] == 1

    def test_scan_invalid_date_falls_through(self, monkeypatch):
        monkeypatch.setattr(_scan, "_load_muted_state", lambda: {})
        monkeypatch.setattr(
            _scan,
            "_paginate",
            lambda path, params, page_size=100: [
                {
                    "id": "u1",
                    "identifier": "BTCAAAAA-100",
                    "title": "Fix",
                    "labels": [{"name": "fix"}],
                    "status": "done",
                    "completedAt": "not-a-date",
                },
            ],
        )
        monkeypatch.setattr(_scan, "_company", lambda: "comp-uuid")
        monkeypatch.setattr(
            _scan,
            "fetch_issue_comments",
            lambda iid: [{"body": "## Impact Gate: PASS"}],
        )
        result = _scan.scan(days_back=7)
        assert result["total_done_fix_issues"] == 0


class TestMain:
    def test_exit_zero_when_all_gated(self, monkeypatch):
        monkeypatch.setattr(
            _scan,
            "scan",
            lambda **kw: {
                "timestamp": "2026-01-01T00:00:00",
                "total_done_fix_issues": 1,
                "gated": {"pass": 1, "fail": 0, "bypassed": 0, "error": 0},
                "ungated_count": 0,
                "ungated_issues": [],
                "gated_issues": [],
            },
        )
        monkeypatch.setattr(sys, "argv", ["scan_fix_issues_done.py"])
        try:
            _scan.main()
        except SystemExit as e:
            assert e.code == 0

    def test_exit_zero_when_ungated_exists(self, monkeypatch):
        monkeypatch.setattr(
            _scan,
            "scan",
            lambda **kw: {
                "timestamp": "2026-01-01T00:00:00",
                "total_done_fix_issues": 1,
                "gated": {"pass": 0, "fail": 0, "bypassed": 0, "error": 0},
                "ungated_count": 1,
                "ungated_issues": [
                    {"id": "u1", "identifier": "BTCAAAAA-100", "title": "Fix"}
                ],
                "gated_issues": [],
            },
        )
        monkeypatch.setattr(sys, "argv", ["scan_fix_issues_done.py"])
        try:
            _scan.main()
        except SystemExit as e:
            assert e.code == 0

    def test_dry_run_flag_passed_to_scan(self, monkeypatch):
        kwargs_store = {}
        monkeypatch.setattr(
            _scan,
            "scan",
            lambda **kw: (
                kwargs_store.update(kw)
                or {
                    "timestamp": "",
                    "total_done_fix_issues": 0,
                    "gated": {"pass": 0, "fail": 0, "bypassed": 0, "error": 0},
                    "ungated_count": 0,
                    "ungated_issues": [],
                    "gated_issues": [],
                }
            ),
        )
        monkeypatch.setattr(sys, "argv", ["scan_fix_issues_done.py", "--dry-run"])
        try:
            _scan.main()
        except SystemExit:
            pass
        assert kwargs_store.get("dry_run") is True

    def test_retroactive_flag_passed_to_scan(self, monkeypatch):
        kwargs_store = {}
        monkeypatch.setattr(
            _scan,
            "scan",
            lambda **kw: (
                kwargs_store.update(kw)
                or {
                    "timestamp": "",
                    "total_done_fix_issues": 0,
                    "gated": {"pass": 0, "fail": 0, "bypassed": 0, "error": 0},
                    "ungated_count": 0,
                    "ungated_issues": [],
                    "gated_issues": [],
                }
            ),
        )
        monkeypatch.setattr(sys, "argv", ["scan_fix_issues_done.py", "--retroactive"])
        try:
            _scan.main()
        except SystemExit:
            pass
        assert kwargs_store.get("retroactive") is True

    def test_days_back_flag_passed_to_scan(self, monkeypatch):
        kwargs_store = {}
        monkeypatch.setattr(
            _scan,
            "scan",
            lambda **kw: (
                kwargs_store.update(kw)
                or {
                    "timestamp": "",
                    "total_done_fix_issues": 0,
                    "gated": {"pass": 0, "fail": 0, "bypassed": 0, "error": 0},
                    "ungated_count": 0,
                    "ungated_issues": [],
                    "gated_issues": [],
                }
            ),
        )
        monkeypatch.setattr(
            sys, "argv", ["scan_fix_issues_done.py", "--days-back", "7"]
        )
        try:
            _scan.main()
        except SystemExit:
            pass
        assert kwargs_store.get("days_back") == 7

    def test_json_summary_output_format(self, monkeypatch, capsys):
        monkeypatch.setattr(
            _scan,
            "scan",
            lambda **kw: {
                "timestamp": "2026-05-12T00:00:00",
                "total_done_fix_issues": 0,
                "gated": {"pass": 0, "fail": 0, "bypassed": 0, "error": 0},
                "ungated_count": 0,
                "ungated_issues": [],
                "gated_issues": [],
            },
        )
        monkeypatch.setattr(sys, "argv", ["scan_fix_issues_done.py", "--json-summary"])
        try:
            _scan.main()
        except SystemExit:
            pass
        captured = capsys.readouterr()
        import json

        data = json.loads(captured.out)
        assert data["worker"] == "impact-gate-scan-done"
        assert data["dry_run"] is False
        assert data["total_done_fix_issues"] == 0

    def test_json_summary_includes_retroactive_results(self, monkeypatch, capsys):
        monkeypatch.setattr(
            _scan,
            "scan",
            lambda **kw: {
                "timestamp": "2026-05-12T00:00:00",
                "total_done_fix_issues": 1,
                "gated": {"pass": 0, "fail": 0, "bypassed": 0, "error": 0},
                "ungated_count": 1,
                "ungated_issues": [
                    {"id": "u1", "identifier": "BTCAAAAA-100", "title": "Fix"}
                ],
                "gated_issues": [],
                "retroactive_results": [
                    {"issue": "BTCAAAAA-100", "gate_status": "PASS"}
                ],
            },
        )
        monkeypatch.setattr(sys, "argv", ["scan_fix_issues_done.py", "--json-summary"])
        try:
            _scan.main()
        except SystemExit:
            pass
        captured = capsys.readouterr()
        import json

        data = json.loads(captured.out)
        assert "retroactive_results" in data
        assert data["retroactive_results"][0]["gate_status"] == "PASS"

    def test_output_json_flag(self, monkeypatch, capsys):
        monkeypatch.setattr(
            _scan,
            "scan",
            lambda **kw: {
                "timestamp": "2026-05-12T00:00:00",
                "total_done_fix_issues": 1,
                "gated": {"pass": 1, "fail": 0, "bypassed": 0, "error": 0},
                "ungated_count": 0,
                "ungated_issues": [],
                "gated_issues": [],
            },
        )
        monkeypatch.setattr(
            sys, "argv", ["scan_fix_issues_done.py", "--output", "json"]
        )
        try:
            _scan.main()
        except SystemExit:
            pass
        captured = capsys.readouterr()
        assert '"total_done_fix_issues": 1' in captured.out
        assert captured.out.count("\n") == 1

    def test_output_pretty_flag(self, monkeypatch, capsys):
        monkeypatch.setattr(
            _scan,
            "scan",
            lambda **kw: {
                "timestamp": "2026-05-12T00:00:00",
                "total_done_fix_issues": 1,
                "gated": {"pass": 1, "fail": 0, "bypassed": 0, "error": 0},
                "ungated_count": 0,
                "ungated_issues": [],
                "gated_issues": [],
            },
        )
        monkeypatch.setattr(
            sys, "argv", ["scan_fix_issues_done.py", "--output", "pretty"]
        )
        try:
            _scan.main()
        except SystemExit:
            pass
        captured = capsys.readouterr()
        assert '"total_done_fix_issues": 1' in captured.out
        assert captured.out.count("\n") > 1

    def test_json_summary_takes_precedence_over_output(self, monkeypatch, capsys):
        monkeypatch.setattr(
            _scan,
            "scan",
            lambda **kw: {
                "timestamp": "2026-05-12T00:00:00",
                "total_done_fix_issues": 1,
                "gated": {"pass": 1, "fail": 0, "bypassed": 0, "error": 0},
                "ungated_count": 0,
                "ungated_issues": [],
                "gated_issues": [],
            },
        )
        monkeypatch.setattr(
            sys,
            "argv",
            [
                "scan_fix_issues_done.py",
                "--json-summary",
                "--output",
                "pretty",
            ],
        )
        try:
            _scan.main()
        except SystemExit:
            pass
        captured = capsys.readouterr()
        import json

        data = json.loads(captured.out)
        assert data["worker"] == "impact-gate-scan-done"
        assert data["total_done_fix_issues"] == 1


class TestMutedState:
    def test_muted_state_path_is_repo_root_not_data(self):
        path = str(_scan._MUTED_STATE_PATH)
        assert "/data/" not in path, (
            f"_MUTED_STATE_PATH should be in repo root, got {path}"
        )
        assert ".impact_gate_muted_state.json" in path

    def test_load_muted_state_empty_when_file_missing(self, tmp_path, monkeypatch):
        monkeypatch.setattr(_ig_worker, "_MUTED_STATE_PATH", tmp_path / "nonexistent.json")
        result = _scan._load_muted_state()
        assert result == {}

    def test_load_muted_state_reads_json(self, tmp_path, monkeypatch):
        p = tmp_path / "muted.json"
        p.write_text('{"abc": "PASS", "def": "FAIL"}')
        monkeypatch.setattr(_ig_worker, "_MUTED_STATE_PATH", p)
        result = _scan._load_muted_state()
        assert result == {"abc": "PASS", "def": "FAIL"}

    def test_load_muted_state_handles_corrupt_json(self, tmp_path, monkeypatch):
        p = tmp_path / "muted.json"
        p.write_text("{not valid json")
        monkeypatch.setattr(_ig_worker, "_MUTED_STATE_PATH", p)
        result = _scan._load_muted_state()
        assert result == {}

    def test_save_muted_gate_result_persists_entry(self, tmp_path, monkeypatch):
        p = tmp_path / "muted.json"
        monkeypatch.setattr(_ig_worker, "_MUTED_STATE_PATH", p)
        _scan.save_muted_gate_result("issue-1", "PASS")
        data = json.loads(p.read_text())
        assert data == {"issue-1": "PASS"}

    def test_save_muted_gate_result_appends_to_existing(self, tmp_path, monkeypatch):
        p = tmp_path / "muted.json"
        p.write_text('{"existing": "FAIL"}')
        monkeypatch.setattr(_ig_worker, "_MUTED_STATE_PATH", p)
        _scan.save_muted_gate_result("new", "BYPASSED")
        data = json.loads(p.read_text())
        assert data == {"existing": "FAIL", "new": "BYPASSED"}

    def test_save_muted_gate_result_overwrites_existing(self, tmp_path, monkeypatch):
        p = tmp_path / "muted.json"
        p.write_text('{"issue-1": "FAIL"}')
        monkeypatch.setattr(_ig_worker, "_MUTED_STATE_PATH", p)
        _scan.save_muted_gate_result("issue-1", "PASS")
        data = json.loads(p.read_text())
        assert data == {"issue-1": "PASS"}

    def test_check_gate_status_uses_muted_state_first(self, monkeypatch):
        monkeypatch.setattr(
            _scan,
            "_load_muted_state",
            lambda: {"cached-id": "BYPASSED"},
        )
        from touch_index import paperclip_client as pc
        original = getattr(pc, "fetch_issue_comments", None)
        monkeypatch.setattr(
            pc,
            "fetch_issue_comments",
            lambda iid: (_ for _ in ()).throw(RuntimeError("should not call API")),
        )
        try:
            result = _scan._check_gate_status("cached-id")
            assert result == "BYPASSED", (
                f"Expected BYPASSED from muted state, got {result}"
            )
        finally:
            if original is not None:
                monkeypatch.setattr(pc, "fetch_issue_comments", original)
            else:
                monkeypatch.delattr(pc, "fetch_issue_comments", raising=False)


class TestPurgeMutedEntries:
    def test_purges_matching_statuses(self, tmp_path, monkeypatch):
        p = tmp_path / "muted.json"
        p.write_text('{"a": "ERROR", "b": "PASS", "c": "error", "d": "FAIL", "e": "SKIPPED"}')
        monkeypatch.setattr(_ig_worker, "_MUTED_STATE_PATH", p)
        removed = _scan.purge_muted_entries({"ERROR"})
        assert removed == 2
        data = json.loads(p.read_text())
        assert "a" not in data
        assert "c" not in data
        assert data["b"] == "PASS"
        assert data["d"] == "FAIL"
        assert data["e"] == "SKIPPED"

    def test_purges_multiple_statuses(self, tmp_path, monkeypatch):
        p = tmp_path / "muted.json"
        p.write_text('{"a": "ERROR", "b": "FAIL", "c": "PASS"}')
        monkeypatch.setattr(_ig_worker, "_MUTED_STATE_PATH", p)
        removed = _scan.purge_muted_entries({"ERROR", "FAIL"})
        assert removed == 2
        data = json.loads(p.read_text())
        assert list(data.keys()) == ["c"]

    def test_returns_zero_when_no_matches(self, tmp_path, monkeypatch):
        p = tmp_path / "muted.json"
        p.write_text('{"a": "PASS", "b": "SKIPPED", "c": "BYPASSED"}')
        monkeypatch.setattr(_ig_worker, "_MUTED_STATE_PATH", p)
        removed = _scan.purge_muted_entries({"ERROR"})
        assert removed == 0
        data = json.loads(p.read_text())
        assert len(data) == 3

    def test_returns_zero_when_file_missing(self, tmp_path, monkeypatch):
        monkeypatch.setattr(_ig_worker, "_MUTED_STATE_PATH", tmp_path / "nonexistent.json")
        removed = _scan.purge_muted_entries({"ERROR"})
        assert removed == 0

    def test_case_insensitive_purge(self, tmp_path, monkeypatch):
        p = tmp_path / "muted.json"
        p.write_text('{"a": "Error", "b": "error", "c": "ERROR"}')
        monkeypatch.setattr(_ig_worker, "_MUTED_STATE_PATH", p)
        removed = _scan.purge_muted_entries({"error"})
        assert removed == 3

    def test_handles_empty_json(self, tmp_path, monkeypatch):
        p = tmp_path / "muted.json"
        p.write_text("{}")
        monkeypatch.setattr(_ig_worker, "_MUTED_STATE_PATH", p)
        removed = _scan.purge_muted_entries({"ERROR"})
        assert removed == 0

    def test_handles_corrupt_json(self, tmp_path, monkeypatch):
        p = tmp_path / "muted.json"
        p.write_text("not json")
        monkeypatch.setattr(_ig_worker, "_MUTED_STATE_PATH", p)
        removed = _scan.purge_muted_entries({"ERROR"})
        assert removed == 0

    def test_writes_empty_json_when_all_purged(self, tmp_path, monkeypatch):
        p = tmp_path / "muted.json"
        p.write_text('{"a": "ERROR"}')
        monkeypatch.setattr(_ig_worker, "_MUTED_STATE_PATH", p)
        _scan.purge_muted_entries({"ERROR"})
        assert json.loads(p.read_text()) == {}


class TestScanRetryFlags:
    def test_retry_errors_purges_before_scan(self, monkeypatch):
        from unittest.mock import MagicMock
        purge_calls = []
        monkeypatch.setattr(_scan, "_paginate", lambda path, params, page_size=100: [])
        monkeypatch.setattr(_scan, "_company", lambda: "comp-uuid")
        monkeypatch.setattr(_scan, "purge_muted_entries", lambda statuses: purge_calls.append(statuses) or 0)
        _scan.scan(retry_errors=True)
        assert len(purge_calls) == 1
        assert "ERROR" in purge_calls[0]

    def test_retry_fails_purges_before_scan(self, monkeypatch):
        from unittest.mock import MagicMock
        purge_calls = []
        monkeypatch.setattr(_scan, "_paginate", lambda path, params, page_size=100: [])
        monkeypatch.setattr(_scan, "_company", lambda: "comp-uuid")
        monkeypatch.setattr(_scan, "purge_muted_entries", lambda statuses: purge_calls.append(statuses) or 0)
        _scan.scan(retry_fails=True)
        assert len(purge_calls) == 1
        assert "FAIL" in purge_calls[0]

    def test_retry_both_purges_both(self, monkeypatch):
        from unittest.mock import MagicMock
        purge_calls = []
        monkeypatch.setattr(_scan, "_paginate", lambda path, params, page_size=100: [])
        monkeypatch.setattr(_scan, "_company", lambda: "comp-uuid")
        monkeypatch.setattr(_scan, "purge_muted_entries", lambda statuses: purge_calls.append(statuses) or 0)
        _scan.scan(retry_errors=True, retry_fails=True)
        assert len(purge_calls) == 1
        assert purge_calls[0] == {"ERROR", "FAIL"}

    def test_no_purge_when_neither_flag_set(self, monkeypatch):
        from unittest.mock import MagicMock
        purge_calls = []
        monkeypatch.setattr(_scan, "_paginate", lambda path, params, page_size=100: [])
        monkeypatch.setattr(_scan, "_company", lambda: "comp-uuid")
        monkeypatch.setattr(_scan, "purge_muted_entries", lambda statuses: purge_calls.append(statuses) or 0)
        _scan.scan()
        assert len(purge_calls) == 0

    def test_purged_ungated_issues_get_retroactive_gate(self, monkeypatch):
        monkeypatch.setattr(_scan, "purge_muted_entries", lambda statuses: 3)
        monkeypatch.setattr(
            _scan,
            "_paginate",
            lambda path, params, page_size=100: [
                {
                    "id": "u1",
                    "identifier": "BTCAAAAA-100",
                    "title": "Fix A",
                    "labels": [{"name": "fix"}],
                    "status": "done",
                },
            ],
        )
        monkeypatch.setattr(_scan, "_company", lambda: "comp-uuid")
        monkeypatch.setattr(
            _scan, "fetch_issue_comments", lambda iid: [{"body": "Other comment"}]
        )
        calls = []
        monkeypatch.setattr(
            _scan,
            "process_issue",
            lambda iid, dry_run=False, **kwargs: (
                calls.append({"iid": iid, "force": kwargs.get("force")}) or {"issue": "BTCAAAAA-100", "gate_status": "PASS"}
            ),
        )
        result = _scan.scan(retry_errors=True, retroactive=True)
        assert len(calls) == 1
        assert calls[0]["force"] is True
        assert result["gated"]["pass"] == 1
        assert result["ungated_count"] == 0

    def test_main_passes_retry_flags(self, monkeypatch):
        kwargs_store = {}
        monkeypatch.setattr(
            _scan,
            "scan",
            lambda **kw: (
                kwargs_store.update(kw)
                or {
                    "timestamp": "",
                    "total_done_fix_issues": 0,
                    "gated": {"pass": 0, "fail": 0, "bypassed": 0, "error": 0},
                    "ungated_count": 0,
                    "ungated_issues": [],
                    "gated_issues": [],
                }
            ),
        )
        monkeypatch.setattr(
            sys, "argv", ["scan_fix_issues_done.py", "--retry-errors", "--retry-fails"]
        )
        try:
            _scan.main()
        except SystemExit:
            pass
        assert kwargs_store.get("retry_errors") is True
        assert kwargs_store.get("retry_fails") is True

    def test_json_summary_includes_retry_flags(self, monkeypatch, capsys):
        monkeypatch.setattr(
            _scan,
            "scan",
            lambda **kw: {
                "timestamp": "2026-05-12T00:00:00",
                "total_done_fix_issues": 0,
                "gated": {"pass": 0, "fail": 0, "bypassed": 0, "error": 0},
                "ungated_count": 0,
                "ungated_issues": [],
                "gated_issues": [],
            },
        )
        monkeypatch.setattr(
            sys, "argv", ["scan_fix_issues_done.py", "--json-summary", "--retry-errors"]
        )
        try:
            _scan.main()
        except SystemExit:
            pass
        data = json.loads(capsys.readouterr().out)
        assert data["retry_errors"] is True
        assert data["retry_fails"] is False
