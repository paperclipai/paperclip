"""Regression checks for the generated enrichment storage contract."""
from pathlib import Path
import unittest


ROOT = Path(__file__).parent


class TestGeneratedStorageContract(unittest.TestCase):
    def test_runtime_sql_uses_generated_public_table_names(self):
        for name in ("dispatcher.py", "reviewer_reservations.py", "load_wave2_queue.py"):
            source = (ROOT / name).read_text()
            self.assertNotIn("enrichment_staging.enrichment_", source, name)

    def test_loader_requires_and_writes_company_id(self):
        source = (ROOT / "load_wave2_queue.py").read_text()
        self.assertIn('os.environ.get("ENRICHMENT_COMPANY_ID")', source)
        self.assertIn("company_id, source_row_id, payload_json", source)

    def test_backfill_is_company_scoped_and_portable(self):
        source = (ROOT / "backfill_reviewer_verdicts.py").read_text()
        self.assertIn('os.environ.get("ENRICHMENT_COMPANY_ID")', source)
        self.assertIn("WHERE company_id = %s", source)
        self.assertNotIn("sag" + "3482", source.lower())


if __name__ == "__main__":
    unittest.main()
