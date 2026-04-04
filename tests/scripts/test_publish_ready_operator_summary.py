import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path("/Users/daehan/Documents/persona/paperclip/scripts/publish_ready_operator_summary.py")


class PublishReadyOperatorSummaryTests(unittest.TestCase):
    def test_renders_failed_gates_and_reasons(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            merged = root / "preflight.publish_ready.json"
            visual = root / "preflight.visual_quality.json"
            merged.write_text(json.dumps({
                "ok": False,
                "gate": "publish_ready",
                "status": "fail",
                "failed_gates": ["visual_quality"],
                "gate_reason_summary": {"visual_quality": ["duplicate_assets", "quick_scan_missing"]},
                "owner_routing": ["Visual Editor"],
                "next_action_hint": "Resolve failed gates before publish-ready review: visual_quality (duplicate_assets, quick_scan_missing)",
                "summary": "failed gates: visual_quality (duplicate_assets, quick_scan_missing)",
            }))
            visual.write_text(json.dumps({
                "ok": False,
                "gate": "visual_quality",
                "status": "fail",
                "reasons": ["duplicate_assets", "quick_scan_missing"],
                "summary": "visual preflight failed: duplicate_assets, quick_scan_missing",
            }))

            raw = subprocess.check_output([sys.executable, str(SCRIPT), "--publish-ready", str(merged)], text=True)
            self.assertIn("## Publish-Ready Operator Summary", raw)
            self.assertIn("`visual_quality`", raw)
            self.assertIn("duplicate_assets, quick_scan_missing", raw)
            self.assertIn("Visual Editor", raw)

    def test_renders_pass_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            merged = root / "preflight.publish_ready.json"
            merged.write_text(json.dumps({
                "ok": True,
                "gate": "publish_ready",
                "status": "pass",
                "failed_gates": [],
                "owner_routing": [],
                "summary": "all publish-ready gates passed",
                "next_action_hint": None,
            }))
            raw = subprocess.check_output([sys.executable, str(SCRIPT), "--publish-ready", str(merged)], text=True)
            self.assertIn("All publish-ready gates passed.", raw)


if __name__ == "__main__":
    unittest.main()
