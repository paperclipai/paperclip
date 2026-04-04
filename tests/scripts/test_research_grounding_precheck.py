import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path("/Users/daehan/Documents/persona/paperclip/scripts/research_grounding_precheck.py")


class ResearchGroundingPrecheckTests(unittest.TestCase):
    def run_script(self, payload: dict) -> dict:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "research.json"
            path.write_text(json.dumps(payload))
            raw = subprocess.check_output([sys.executable, str(SCRIPT), "--research", str(path)], text=True)
            return json.loads(raw)

    def test_fails_when_notebook_reference_missing(self):
        result = self.run_script({
            "fact_pack": {"items": [1]},
            "source_registry": [{"url": "https://example.com"}],
            "uncertainty_ledger": [{"claim": "x"}],
        })
        self.assertFalse(result["ok"])
        self.assertIn("notebook_reference", result["missing_artifacts"])

    def test_fails_when_uncertainty_ledger_missing(self):
        result = self.run_script({
            "notebook_reference": "Fluxaivory AI-Tech Research",
            "fact_pack": {"items": [1]},
            "source_registry": [{"url": "https://example.com"}],
        })
        self.assertFalse(result["ok"])
        self.assertIn("uncertainty_ledger", result["missing_artifacts"])

    def test_passes_when_complete(self):
        result = self.run_script({
            "notebook_reference": "Fluxaivory AI-Tech Research",
            "fact_pack": {"items": [1]},
            "source_registry": [{"url": "https://example.com"}],
            "uncertainty_ledger": [{"claim": "x"}],
        })
        self.assertTrue(result["ok"])
        self.assertEqual(result["missing_artifacts"], [])


if __name__ == "__main__":
    unittest.main()
