import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path("/Users/daehan/Documents/persona/paperclip/scripts/reader_experience_precheck.py")


class ReaderExperiencePrecheckTests(unittest.TestCase):
    def run_script(self, payload: dict) -> dict:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "draft.json"
            path.write_text(json.dumps(payload))
            raw = subprocess.check_output([sys.executable, str(SCRIPT), "--draft", str(path)], text=True)
            return json.loads(raw)

    def test_fails_when_ending_payoff_missing(self):
        result = self.run_script({"markdown": "## 목차\n\n이번 글에서 볼 3가지\n\nbody only"})
        self.assertFalse(result["ok"])
        self.assertIn("ending_payoff_missing", result["reasons"])

    def test_fails_when_scan_path_missing(self):
        result = self.run_script({"markdown": "이 글은 길지만 구조 힌트가 없다. " * 80})
        self.assertFalse(result["ok"])
        self.assertIn("scan_path_missing", result["reasons"])

    def test_passes_with_hook_and_ending(self):
        result = self.run_script({"markdown": "## 목차\n\n이번 글에서 볼 3가지\n\nbody\n\n지금 써볼 사람과 기다릴 사람을 판단한다."})
        self.assertTrue(result["ok"])


if __name__ == "__main__":
    unittest.main()
