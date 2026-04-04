import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path("/Users/daehan/Documents/persona/paperclip/scripts/explainer_precheck.py")


class ExplainerPrecheckTests(unittest.TestCase):
    def run_script(self, payload: dict) -> dict:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "draft.json"
            path.write_text(json.dumps(payload))
            raw = subprocess.check_output([sys.executable, str(SCRIPT), "--draft", str(path)], text=True)
            return json.loads(raw)

    def test_fails_when_opening_is_incomplete(self):
        result = self.run_script({"markdown": "이 글은 복잡한 MCP orchestrator latency를 설명한다."})
        self.assertFalse(result["ok"])
        self.assertIn("opening_incomplete", result["reasons"])

    def test_fails_when_jargon_is_dense(self):
        result = self.run_script({"markdown": "what changed why it matters who should care mcp token latency inference orchestrator"})
        self.assertFalse(result["ok"])
        self.assertIn("jargon_too_dense", result["reasons"])

    def test_passes_when_opening_is_clear(self):
        result = self.run_script({"markdown": "what changed why it matters who should care\n\nThis article explains the change in plain terms."})
        self.assertTrue(result["ok"])


if __name__ == "__main__":
    unittest.main()
