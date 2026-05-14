"""Unit tests for scripts/scan_done_alert.py."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).parents[2] / "scripts"))
sys.path.insert(0, str(Path(__file__).parents[2] / "src"))

import importlib

_alert_path = Path(__file__).parents[2] / "scripts" / "scan_done_alert.py"
_spec = importlib.util.spec_from_file_location("scan_done_alert", _alert_path)
_alert = importlib.util.module_from_spec(_spec)
sys.modules["scan_done_alert"] = _alert
_spec.loader.exec_module(_alert)

create_alert = _alert.create_alert
_find_todays_alert = _alert._find_todays_alert
main = _alert.main
ALERT_LABEL = _alert.ALERT_LABEL


class TestFindTodaysAlert:
    def test_returns_alert_when_found(self, monkeypatch):
        import touch_index.paperclip_client as pc
        candidates = [
            {"title": "Other issue", "labels": [], "identifier": "BTCAAAAA-1"},
            {
                "title": "Impact Gate Scan-Done Alert -- 2026-05-13 (5 ungated)",
                "labels": [{"name": ALERT_LABEL}],
                "identifier": "BTCAAAAA-2",
            },
        ]
        monkeypatch.setattr(
            pc, "_paginate", lambda path, params, page_size=50: candidates
        )
        result = _find_todays_alert("http://base", "comp", None, "2026-05-13")
        assert result is not None
        assert result["identifier"] == "BTCAAAAA-2"

    def test_returns_none_when_no_match(self, monkeypatch):
        import touch_index.paperclip_client as pc
        monkeypatch.setattr(
            pc, "_paginate", lambda path, params, page_size=50: []
        )
        result = _find_todays_alert("http://base", "comp", None, "2026-05-13")
        assert result is None

    def test_returns_none_when_date_mismatch(self, monkeypatch):
        import touch_index.paperclip_client as pc
        candidates = [
            {
                "title": "Impact Gate Scan-Done Alert -- 2026-05-12 (3 ungated)",
                "labels": [{"name": ALERT_LABEL}],
                "identifier": "BTCAAAAA-2",
            },
        ]
        monkeypatch.setattr(
            pc, "_paginate", lambda path, params, page_size=50: candidates
        )
        result = _find_todays_alert("http://base", "comp", None, "2026-05-13")
        assert result is None

    def test_returns_none_when_label_mismatch(self, monkeypatch):
        import touch_index.paperclip_client as pc
        candidates = [
            {
                "title": "Impact Gate Scan-Done Alert -- 2026-05-13 (5 ungated)",
                "labels": [{"name": "other-label"}],
                "identifier": "BTCAAAAA-2",
            },
        ]
        monkeypatch.setattr(
            pc, "_paginate", lambda path, params, page_size=50: candidates
        )
        result = _find_todays_alert("http://base", "comp", None, "2026-05-13")
        assert result is None

    def test_handles_api_error_gracefully(self, monkeypatch):
        import touch_index.paperclip_client as pc
        def raise_error(*a, **kw):
            raise RuntimeError("API error")

        monkeypatch.setattr(pc, "_paginate", raise_error)
        result = _find_todays_alert("http://base", "comp", None, "2026-05-13")
        assert result is None


class TestCreateAlert:
    def test_noop_when_no_ungated(self):
        sess = MagicMock()
        ok = create_alert(
            "http://base",
            "comp",
            sess,
            {"ungated_count": 0, "ungated_issues": []},
            dry_run=False,
        )
        assert ok is True
        sess.post.assert_not_called()

    def test_dry_run_prints_and_returns(self, capsys):
        sess = MagicMock()
        scan_data = {
            "ungated_count": 2,
            "ungated_issues": [
                {"identifier": "BTCAAAAA-100", "title": "Fix A"},
                {"identifier": "BTCAAAAA-101", "title": "Fix B"},
            ],
        }
        ok = create_alert("http://base", "comp", sess, scan_data, dry_run=True)
        assert ok is True
        sess.post.assert_not_called()
        captured = capsys.readouterr()
        assert "BTCAAAAA-100" in captured.out
        assert "BTCAAAAA-101" in captured.out

    def test_posts_alert_with_ungated(self):
        sess = MagicMock()
        sess.post.return_value.json.return_value = {
            "id": "alert-uuid",
            "identifier": "BTCAAAAA-200",
        }
        scan_data = {
            "ungated_count": 1,
            "ungated_issues": [
                {"identifier": "BTCAAAAA-100", "title": "Fix ungate"},
            ],
        }
        ok = create_alert("http://base", "comp-id", sess, scan_data, dry_run=False)
        assert ok is True
        sess.post.assert_called_once()
        args, kw = sess.post.call_args
        assert "comp-id" in args[0]
        payload = kw["json"]
        assert payload["priority"] == "medium"
        assert payload["labels"] == ["impact-gate-alert"]
        assert "BTCAAAAA-100" in payload["description"]

    def test_api_error_returns_false(self):
        sess = MagicMock()
        sess.post.side_effect = RuntimeError("API timeout")
        scan_data = {
            "ungated_count": 1,
            "ungated_issues": [{"identifier": "BTCAAAAA-100", "title": "Fix"}],
        }
        ok = create_alert("http://base", "comp", sess, scan_data, dry_run=False)
        assert ok is False

    def test_table_includes_identifiers(self):
        sess = MagicMock()
        sess.post.return_value.json.return_value = {"id": "u"}
        scan_data = {
            "ungated_count": 2,
            "ungated_issues": [
                {"identifier": "BTCAAAAA-100", "title": "Fix A"},
                {"identifier": "BTCAAAAA-101", "title": "Fix B"},
            ],
        }
        create_alert("http://base", "comp", sess, scan_data, dry_run=False)
        _, kw = sess.post.call_args
        body = kw["json"]["description"]
        assert "| BTCAAAAA-100 | Fix A |" in body
        assert "| BTCAAAAA-101 | Fix B |" in body

    def test_skips_duplicate_when_alert_exists(self, monkeypatch):
        monkeypatch.setattr(
            _alert,
            "_find_todays_alert",
            lambda *a, **kw: {
                "identifier": "BTCAAAAA-200",
                "title": "Impact Gate Scan-Done Alert -- 2026-05-13 (5 ungated)",
            },
        )
        sess = MagicMock()
        scan_data = {
            "ungated_count": 5,
            "ungated_issues": [
                {"identifier": "BTCAAAAA-100", "title": "Fix"},
            ],
        }
        ok = create_alert("http://base", "comp", sess, scan_data, dry_run=False)
        assert ok is True
        sess.post.assert_not_called()


class TestMain:
    def test_exits_on_missing_file(self):
        test_args = [
            "scan_done_alert.py",
            "--scan-output",
            "/tmp/nonexistent_scan_output.json",
        ]
        old_argv, sys.argv = sys.argv, test_args
        try:
            try:
                main()
            except SystemExit as e:
                assert e.code == 1
        finally:
            sys.argv = old_argv

    def test_calls_create_alert_with_parsed_data(self, monkeypatch, tmp_path):
        out = tmp_path / "scan-out.json"
        out.write_text(json.dumps({"ungated_count": 0, "ungated_issues": []}))
        monkeypatch.setattr(
            sys, "argv", ["scan_done_alert.py", "--scan-output", str(out)]
        )
        called = []
        monkeypatch.setattr(
            _alert, "create_alert", lambda *a, **kw: called.append(True) or True
        )
        monkeypatch.setattr(
            _alert, "_setup_session", lambda: (MagicMock(), "http://base", "comp")
        )
        main()
        assert len(called) == 1

    def test_dry_run_flag_passed(self, monkeypatch, tmp_path):
        out = tmp_path / "scan-out.json"
        out.write_text(
            json.dumps(
                {
                    "ungated_count": 1,
                    "ungated_issues": [{"identifier": "X", "title": "Y"}],
                }
            )
        )
        monkeypatch.setattr(
            sys, "argv", ["scan_done_alert.py", "--scan-output", str(out), "--dry-run"]
        )
        kwargs_store = {}

        def track(base_url, company_id, sess, scan_data, dry_run):
            kwargs_store["dry_run"] = dry_run
            return True

        monkeypatch.setattr(_alert, "create_alert", track)
        monkeypatch.setattr(
            _alert, "_setup_session", lambda: (MagicMock(), "http://base", "comp")
        )
        main()
        assert kwargs_store.get("dry_run") is True

    def test_auto_detects_dry_run_from_scan_json(self, monkeypatch, tmp_path):
        """main() should respect dry_run=true in scan JSON when --dry-run is not set."""
        out = tmp_path / "scan-out.json"
        out.write_text(
            json.dumps(
                {
                    "dry_run": True,
                    "ungated_count": 1,
                    "ungated_issues": [{"identifier": "X", "title": "Y"}],
                }
            )
        )
        monkeypatch.setattr(
            sys, "argv", ["scan_done_alert.py", "--scan-output", str(out)]
        )
        kwargs_store = {}

        def track(base_url, company_id, sess, scan_data, dry_run):
            kwargs_store["dry_run"] = dry_run
            return True

        monkeypatch.setattr(_alert, "create_alert", track)
        monkeypatch.setattr(
            _alert, "_setup_session", lambda: (MagicMock(), "http://base", "comp")
        )
        main()
        assert kwargs_store.get("dry_run") is True, (
            f"Expected dry_run=True from scan JSON, got {kwargs_store.get('dry_run')}"
        )

    def test_dry_run_false_by_default(self, monkeypatch, tmp_path):
        """main() should default dry_run to False when neither CLI flag nor scan JSON specifies it."""
        out = tmp_path / "scan-out.json"
        out.write_text(
            json.dumps(
                {
                    "ungated_count": 1,
                    "ungated_issues": [{"identifier": "X", "title": "Y"}],
                }
            )
        )
        monkeypatch.setattr(
            sys, "argv", ["scan_done_alert.py", "--scan-output", str(out)]
        )
        kwargs_store = {}

        def track(base_url, company_id, sess, scan_data, dry_run):
            kwargs_store["dry_run"] = dry_run
            return True

        monkeypatch.setattr(_alert, "create_alert", track)
        monkeypatch.setattr(
            _alert, "_setup_session", lambda: (MagicMock(), "http://base", "comp")
        )
        main()
        assert kwargs_store.get("dry_run") is False
