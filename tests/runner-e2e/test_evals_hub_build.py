import pathlib
import sys
import unittest

# Add scripts/evals-hub to path to allow importing build directly
_hub_dir = pathlib.Path(__file__).resolve().parent.parent.parent / "scripts" / "evals-hub"
sys.path.insert(0, str(_hub_dir))

from build import SYSTEMS, display_date, public_report, summarize


class EvalsHubBuildTests(unittest.TestCase):
    def test_display_date_normalizations(self):
        self.assertEqual(display_date("2026-09-01T12:00:00Z"), "01 Sep 2026 · 12:00 UTC")
        self.assertEqual(display_date("2026-09-01T12:00:00z"), "01 Sep 2026 · 12:00 UTC")
        self.assertEqual(display_date(" 2026-09-01T14:00:00+02:00 "), "01 Sep 2026 · 12:00 UTC")

    def test_public_report_path_traversal_guards(self):
        prefix = "runner-protocol-evals"
        malicious = [
            f"https://d1p6rlowie26tp.cloudfront.net/{prefix}/campaigns/../../secret.json",
            f"https://d1p6rlowie26tp.cloudfront.net/{prefix}/campaigns/run-1/..",
            f"https://d1p6rlowie26tp.cloudfront.net/{prefix}/campaigns/%2e%2e/secret.json",
            f"https://d1p6rlowie26tp.cloudfront.net/{prefix}/campaigns/%2E%2E/secret.json",
            f"https://d1p6rlowie26tp.cloudfront.net/{prefix}/campaigns/..%2fsecret.json",
            f"https://d1p6rlowie26tp.cloudfront.net/{prefix}/campaigns/..\\secret.json",
            f"https://d1p6rlowie26tp.cloudfront.net/{prefix}/campaigns/%2e%2e",
        ]
        for url in malicious:
            with self.subTest(url=url), self.assertRaises(ValueError):
                public_report(url, prefix)

    def test_public_report_valid(self):
        url = "https://d1p6rlowie26tp.cloudfront.net/runner-protocol-evals/campaigns/run-1/"
        self.assertEqual(public_report(url, "runner-protocol-evals"), url)


if __name__ == "__main__":
    unittest.main()
