import copy
import unittest

from build import SYSTEMS, summarize


class HistorySummaryTests(unittest.TestCase):
    def history(self, kind="runner"):
        prefix, schema = SYSTEMS[kind]
        campaign = {
            "campaignId": "run-1", "generatedAt": "2026-09-01T12:00:00Z",
            "publicUrl": f"https://d1p6rlowie26tp.cloudfront.net/{prefix}/campaigns/run-1/",
            "complete": False,
        }
        counts = {"selected": 3, "passed": 2}
        campaign.update({"totals": counts} if kind == "runner" else counts)
        return {"schema": schema, "latestCampaignId": "run-1", "campaigns": [campaign]}

    def test_both_families_keep_partial_coverage(self):
        for kind in SYSTEMS:
            with self.subTest(kind=kind):
                result = summarize(self.history(kind), kind)
                self.assertEqual(result["coverage"], "Partial campaign")
                self.assertEqual(result["counts"], "2 / 3 selected cases passed")

    def test_refresh_changes_report_but_not_measurement_date(self):
        history = self.history()
        refreshed = copy.deepcopy(history["campaigns"][0])
        refreshed.update(campaignId="run-1-refresh", generatedAt="2026-09-03T12:00:00Z")
        refreshed["publicUrl"] += "refresh/"
        refreshed["reportRevision"] = {
            "sourceCampaignId": "run-1", "sourceGeneratedAt": "2026-09-01T12:00:00Z",
            "renderedAt": "2026-09-03T12:00:00Z",
        }
        history["campaigns"].append(refreshed)
        result = summarize(history, "runner")
        self.assertEqual(result["id"], "run-1")
        self.assertIn("01 Sep 2026", result["date"])
        self.assertTrue(result["url"].endswith("/refresh/"))

    def test_missing_latest_does_not_fall_back_to_an_arbitrary_run(self):
        history = self.history()
        history["latestCampaignId"] = "absent"
        with self.assertRaises(ValueError):
            summarize(history, "runner")

    def test_refresh_without_measurement_date_is_rejected(self):
        history = self.history()
        campaign = history["campaigns"][0]
        campaign["campaignId"] = "run-1-refresh"
        campaign["reportRevision"] = {
            "sourceCampaignId": "run-1", "renderedAt": "2026-09-03T12:00:00Z",
        }
        with self.assertRaisesRegex(ValueError, "measurement date"):
            summarize(history, "runner")

    def test_unknown_schema_and_missing_coverage_are_rejected(self):
        for field in ("schema", "complete"):
            history = self.history()
            if field == "schema":
                history["schema"] = "future-schema"
            else:
                del history["campaigns"][0]["complete"]
            with self.subTest(field=field), self.assertRaises(ValueError):
                summarize(history, "runner")

    def test_bad_counts_cannot_be_published(self):
        history = self.history()
        history["campaigns"][0]["totals"]["passed"] = 4
        with self.assertRaises(ValueError):
            summarize(history, "runner")

    def test_external_report_urls_are_rejected(self):
        history = self.history()
        for url in ("javascript:alert(1)", "https://example.com/", "https://d1p6rlowie26tp.cloudfront.net/other/"):
            history["campaigns"][0]["publicUrl"] = url
            with self.subTest(url=url), self.assertRaises(ValueError):
                summarize(history, "runner")


if __name__ == "__main__":
    unittest.main()
