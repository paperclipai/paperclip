import runpy, sqlite3, tempfile, unittest
from pathlib import Path

MODULE = runpy.run_path(str(Path(__file__).resolve().parents[1] / "bin" / "pc-cap-velocity"))
summarize = MODULE["summarize"]
load_sqlite_records = MODULE["load_sqlite_records"]

class VelocityTests(unittest.TestCase):
    def test_empty_window(self):
        self.assertEqual(
            summarize([], "co-1", days=14, now="2026-05-20T00:00:00Z"),
            {"company_id": "co-1", "p50": None, "p75": None, "p95": None, "n_issues": 0, "window_days": 14},
        )

    def test_single_done_issue(self):
        result = summarize(
            [
                {"status": "done", "created_at": "2026-05-18T00:00:00Z", "completed_at": "2026-05-19T00:00:00Z"}
            ],
            "co-1",
            days=14,
            now="2026-05-20T00:00:00Z",
        )
        self.assertEqual(result["n_issues"], 1)
        self.assertEqual((result["p50"], result["p75"], result["p95"]), (1.0, 1.0, 1.0))

    def test_sqlite_mix_open_done_and_window(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "metrics.sqlite"
            with sqlite3.connect(db_path) as conn:
                conn.execute(
                    "CREATE TABLE issue_events (company_id TEXT, status TEXT, created_at TEXT, completed_at TEXT)"
                )
                conn.executemany(
                    "INSERT INTO issue_events VALUES (?, ?, ?, ?)",
                    [
                        ("co-1", "done", "2026-05-15T00:00:00Z", "2026-05-18T00:00:00Z"),
                        ("co-1", "done", "2026-05-18T00:00:00Z", "2026-05-20T00:00:00Z"),
                        ("co-1", "todo", "2026-05-18T00:00:00Z", None),
                        ("co-1", "done", "2026-04-01T00:00:00Z", "2026-04-02T00:00:00Z"),
                        ("co-2", "done", "2026-05-18T00:00:00Z", "2026-05-19T00:00:00Z"),
                    ],
                )
            result = summarize(load_sqlite_records(db_path, "co-1"), "co-1", days=14, now="2026-05-20T00:00:00Z")
        self.assertEqual(result["n_issues"], 2)
        self.assertEqual((result["p50"], result["p75"], result["p95"]), (1.5, 1.75, 1.95))

if __name__ == "__main__":
    unittest.main()
