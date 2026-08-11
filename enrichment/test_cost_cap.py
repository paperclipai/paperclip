"""
Unit tests for cost_cap.py — rolling weekly Opus reviewer cap logic.

Run:  python -m pytest enrichment/test_cost_cap.py -v
  or  python enrichment/test_cost_cap.py
"""
import json
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(__file__))
from cost_cap import CostCapTracker, WEEKLY_CAP_USD, WINDOW_SECONDS


class TestWeeklySpend(unittest.TestCase):
    def setUp(self):
        import tempfile
        self._tmp = tempfile.mkdtemp()
        self._path = os.path.join(self._tmp, "ledger.json")

    def _tracker(self):
        return CostCapTracker(self._path)

    # ---- basic accumulation ----

    def test_empty_ledger_zero_spend(self):
        self.assertEqual(self._tracker().weekly_spend(), 0.0)

    def test_single_record(self):
        t = self._tracker()
        t.record(10.00)
        self.assertAlmostEqual(t.weekly_spend(), 10.00)

    def test_multiple_records_sum(self):
        t = self._tracker()
        t.record(10.00)
        t.record(15.00)
        t.record(5.50)
        self.assertAlmostEqual(t.weekly_spend(), 30.50)

    # ---- window pruning ----

    def test_old_entry_pruned(self):
        old_ts = time.time() - (8 * 24 * 3600)  # 8 days ago
        with open(self._path, "w") as f:
            json.dump({"entries": [{"ts": old_ts, "cost_usd": 99.00}]}, f)
        self.assertAlmostEqual(self._tracker().weekly_spend(), 0.0)

    def test_entry_within_window_kept(self):
        recent_ts = time.time() - (6 * 24 * 3600)  # 6 days ago
        with open(self._path, "w") as f:
            json.dump({"entries": [{"ts": recent_ts, "cost_usd": 20.00}]}, f)
        self.assertAlmostEqual(self._tracker().weekly_spend(), 20.00)

    def test_mixed_ages_only_recent_counted(self):
        now = time.time()
        entries = [
            {"ts": now - (8 * 24 * 3600), "cost_usd": 40.00},  # pruned
            {"ts": now - (3 * 24 * 3600), "cost_usd": 12.00},  # kept
        ]
        with open(self._path, "w") as f:
            json.dump({"entries": entries}, f)
        self.assertAlmostEqual(self._tracker().weekly_spend(), 12.00)


class TestWouldBreach(unittest.TestCase):
    def setUp(self):
        import tempfile
        self._tmp = tempfile.mkdtemp()
        self._path = os.path.join(self._tmp, "ledger.json")

    def _seed(self, spend: float):
        recent_ts = time.time() - 3600  # 1 hour ago
        with open(self._path, "w") as f:
            json.dump({"entries": [{"ts": recent_ts, "cost_usd": spend}]}, f)

    # ---- boundary assertions from reference spec ----

    def test_no_breach_at_49_99(self):
        """$49.99 weekly spend → no breach."""
        self._seed(49.99)
        self.assertFalse(CostCapTracker(self._path).would_breach(0.0))

    def test_breach_at_50_01(self):
        """$50.01 weekly spend → breach."""
        self._seed(50.01)
        self.assertTrue(CostCapTracker(self._path).would_breach(0.0))

    def test_exactly_at_cap_not_breach(self):
        """Exactly $50.00 is NOT a breach (condition is >, not >=)."""
        self._seed(50.00)
        self.assertFalse(CostCapTracker(self._path).would_breach(0.0))

    def test_additional_tips_into_breach(self):
        """$49.99 + $0.02 additional = $50.01 → breach."""
        self._seed(49.99)
        self.assertTrue(CostCapTracker(self._path).would_breach(0.02))

    def test_additional_below_cap(self):
        """$49.99 + $0.005 = $49.995 → no breach."""
        self._seed(49.99)
        self.assertFalse(CostCapTracker(self._path).would_breach(0.005))

    def test_zero_spend_no_breach(self):
        self.assertFalse(CostCapTracker(self._path).would_breach(0.0))

    def test_zero_spend_large_additional_breach(self):
        """Additional alone can trigger breach."""
        self.assertTrue(CostCapTracker(self._path).would_breach(51.00))


class TestPersistence(unittest.TestCase):
    def setUp(self):
        import tempfile
        self._tmp = tempfile.mkdtemp()
        self._path = os.path.join(self._tmp, "ledger.json")

    # ---- durability across process restart ----

    def test_spend_survives_restart(self):
        """Recorded spend is visible to a new CostCapTracker on the same file."""
        t1 = CostCapTracker(self._path)
        t1.record(30.00)
        t1.record(10.00)
        t2 = CostCapTracker(self._path)  # simulates process restart
        self.assertAlmostEqual(t2.weekly_spend(), 40.00)

    def test_breach_survives_restart(self):
        """Breach state is durable — new instance still reads > $50 spend."""
        CostCapTracker(self._path).record(55.00)
        self.assertTrue(CostCapTracker(self._path).would_breach(0.0))

    def test_no_breach_survives_restart(self):
        """Clean state is also durable."""
        CostCapTracker(self._path).record(20.00)
        self.assertFalse(CostCapTracker(self._path).would_breach(0.0))

    def test_accumulation_across_instances(self):
        """Multiple separate instances on the same file accumulate correctly."""
        CostCapTracker(self._path).record(20.00)
        CostCapTracker(self._path).record(25.00)
        CostCapTracker(self._path).record(5.50)
        self.assertAlmostEqual(CostCapTracker(self._path).weekly_spend(), 50.50)
        self.assertTrue(CostCapTracker(self._path).would_breach(0.0))


if __name__ == "__main__":
    unittest.main(verbosity=2)
