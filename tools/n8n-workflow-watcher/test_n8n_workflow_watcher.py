import unittest
import n8n_workflow_watcher as w


class FindFailedWorkflows(unittest.TestCase):
    # row layout: (wf_id, name, mode, status, exec_id, started_at)
    def test_latest_error_is_flagged(self):
        rows = [("wf1", "Daily Digest", "trigger", "error", 455196, "2026-06-12 03:00:00")]
        out = w.find_failed_workflows(rows)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["id"], "wf1")
        self.assertEqual(out[0]["name"], "Daily Digest")
        self.assertEqual(out[0]["mode"], "trigger")
        self.assertEqual(out[0]["exec_id"], 455196)
        self.assertEqual(out[0]["failed_at"], "2026-06-12 03:00:00")

    def test_latest_crashed_is_flagged(self):
        rows = [("wf2", "RAG", "trigger", "crashed", 1, "2026-06-12 02:00:00")]
        self.assertEqual(len(w.find_failed_workflows(rows)), 1)

    def test_latest_success_not_flagged(self):
        rows = [("wf3", "E-Mails Clara V1", "trigger", "success", 456119, "2026-06-12 04:00:00")]
        self.assertEqual(w.find_failed_workflows(rows), [])

    def test_running_and_canceled_not_flagged(self):
        rows = [
            ("wf4", "X", "trigger", "running", 2, "2026-06-12 04:00:00"),
            ("wf5", "Y", "trigger", "canceled", 3, "2026-06-12 04:00:00"),
        ]
        self.assertEqual(w.find_failed_workflows(rows), [])

    def test_empty_rows(self):
        self.assertEqual(w.find_failed_workflows([]), [])


from datetime import date


class ShouldSendHeartbeat(unittest.TestCase):
    MONDAY = date(2026, 6, 15)      # Montag
    TUESDAY = date(2026, 6, 16)     # Dienstag

    def test_monday_no_findings_overdue_true(self):
        self.assertTrue(w.should_send_heartbeat(self.MONDAY, "2026-06-08", has_findings=False))

    def test_monday_already_sent_today_false(self):
        self.assertFalse(w.should_send_heartbeat(self.MONDAY, "2026-06-15", has_findings=False))

    def test_monday_with_findings_false(self):
        self.assertFalse(w.should_send_heartbeat(self.MONDAY, "2026-06-08", has_findings=True))

    def test_non_monday_false(self):
        self.assertFalse(w.should_send_heartbeat(self.TUESDAY, "2026-06-01", has_findings=False))

    def test_monday_no_prior_heartbeat_true(self):
        self.assertTrue(w.should_send_heartbeat(self.MONDAY, None, has_findings=False))


class Rendering(unittest.TestCase):
    FINDINGS = [
        {"id": "wfA", "name": "Paperclip Daily Digest V12", "mode": "trigger",
         "exec_id": 455196, "failed_at": "2026-06-12 03:00:00"},
        {"id": "wfB", "name": "Google-Alert V9 <x>", "mode": "trigger",
         "exec_id": 455607, "failed_at": "2026-06-12 02:30:00"},
    ]

    def test_subject_counts_findings(self):
        self.assertIn("2", w.build_subject(self.FINDINGS))

    def test_execution_url(self):
        self.assertEqual(
            w.execution_url("wfA", 455196),
            "http://localhost:5678/workflow/wfA/executions/455196",
        )

    def test_text_lists_each_finding(self):
        txt = w.render_report_text(self.FINDINGS)
        self.assertIn("Paperclip Daily Digest V12", txt)
        self.assertIn("455607", txt)

    def test_html_escapes_names_and_has_links(self):
        out = w.render_report_html(self.FINDINGS)
        self.assertIn("Google-Alert V9 &lt;x&gt;", out)        # escaped
        self.assertIn("/workflow/wfA/executions/455196", out)  # link
        self.assertIn("<table", out)

    def test_heartbeat_render(self):
        subject, text, html_body = w.render_heartbeat(23)
        self.assertIn("23", subject)
        self.assertIn("23", text)
        self.assertIn("23", html_body)


if __name__ == "__main__":
    unittest.main()
