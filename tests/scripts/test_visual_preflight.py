import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path("/Users/daehan/Documents/persona/paperclip/scripts/visual_preflight.py")


class VisualPreflightTests(unittest.TestCase):
    def run_script(self, image_payload: dict, draft_payload: dict) -> dict:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            image_path = root / "image.json"
            draft_path = root / "draft.json"
            image_path.write_text(json.dumps(image_payload))
            draft_path.write_text(json.dumps(draft_payload))
            raw = subprocess.check_output(
                [sys.executable, str(SCRIPT), "--image", str(image_path), "--draft", str(draft_path)],
                text=True,
            )
            return json.loads(raw)

    def test_fails_on_duplicate_support_images(self):
        result = self.run_script(
            {
                "featured": {"sha256": "a"},
                "support-1": {"sha256": "a", "role": "comparison"},
                "support-2": {"sha256": "b", "role": "workflow"},
            },
            {"markdown": "## 목차\n\nquick-scan\n\n" + ("word " * 700)},
        )
        self.assertFalse(result["ok"])
        self.assertIn("support-1", result["duplicate_assets"])

    def test_fails_when_dense_article_lacks_quick_scan(self):
        result = self.run_script(
            {
                "featured": {"sha256": "a"},
                "support-1": {"sha256": "b", "role": "comparison"},
                "support-2": {"sha256": "c", "role": "workflow"},
            },
            {"markdown": "## section\n\n" + ("word " * 700)},
        )
        self.assertFalse(result["ok"])
        self.assertIn("quick_scan_missing", result["reasons"])

    def test_passes_when_roles_and_scan_path_exist(self):
        result = self.run_script(
            {
                "featured": {"sha256": "a"},
                "support-1": {"sha256": "b", "role": "comparison"},
                "support-2": {"sha256": "c", "role": "workflow"},
            },
            {"markdown": "## 목차\n\nquick-scan\n\n" + ("word " * 700)},
        )
        self.assertTrue(result["ok"])


if __name__ == "__main__":
    unittest.main()
