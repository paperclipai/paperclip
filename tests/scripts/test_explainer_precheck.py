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

    def test_fails_when_term_is_not_explained(self):
        result = self.run_script({"markdown": "what changed why it matters who should care\n\nMCP is now widely discussed."})
        self.assertFalse(result["ok"])
        self.assertIn("term_explanation_missing", result["reasons"])

    def test_fails_when_concrete_example_is_missing(self):
        result = self.run_script({"markdown": "what changed why it matters who should care\n\n쉽게 말하면 연결 규격이다."})
        self.assertFalse(result["ok"])
        self.assertIn("concrete_example_missing", result["reasons"])

    def test_passes_when_opening_is_clear(self):
        result = self.run_script({"markdown": "what changed why it matters who should care\n\nPut simply, MCP is a common connection rule for AI tools.\n\nFor example, an AI assistant could connect documents and calendars more naturally."})
        self.assertTrue(result["ok"])


if __name__ == "__main__":
    unittest.main()
