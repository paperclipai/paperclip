import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path("/Users/daehan/Documents/persona/paperclip/scripts/publish_ready_preflight.py")


class PublishReadyPreflightTests(unittest.TestCase):
    def write_json(self, directory: Path, name: str, payload: dict) -> Path:
        path = directory / name
        path.write_text(json.dumps(payload))
        return path

    def run_script(self, *paths: Path) -> dict:
        cmd = [sys.executable, str(SCRIPT)]
        for path in paths:
            cmd.extend(["--gate-result", str(path)])
        raw = subprocess.check_output(cmd, text=True)
        return json.loads(raw)

    def test_fails_when_any_gate_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ok_path = self.write_json(root, "grounding.json", {"gate": "research_grounding", "ok": True})
            fail_path = self.write_json(root, "visual.json", {"gate": "visual_quality", "ok": False, "warnings": ["dup"], "reasons": ["duplicate_assets"]})
            result = self.run_script(ok_path, fail_path)
            self.assertFalse(result["ok"])
            self.assertEqual(result["failed_gates"], ["visual_quality"])
            self.assertEqual(result["owner_routing"], ["Visual Editor"])
            self.assertEqual(result["gate_reason_summary"]["visual_quality"], ["duplicate_assets"])
            self.assertIn("duplicate_assets", result["summary"])
            self.assertIn("duplicate_assets", result["next_action_hint"])

    def test_passes_when_all_gates_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            a = self.write_json(root, "a.json", {"gate": "research_grounding", "ok": True})
            b = self.write_json(root, "b.json", {"gate": "topic_alignment", "ok": True})
            result = self.run_script(a, b)
            self.assertTrue(result["ok"])
            self.assertEqual(result["failed_gates"], [])
            self.assertIsNone(result["next_action_hint"])


if __name__ == "__main__":
    unittest.main()
