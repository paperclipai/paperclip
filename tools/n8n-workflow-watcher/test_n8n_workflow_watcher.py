import json
import os
import sqlite3
import unittest
from unittest import mock
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


import tempfile


class StateRoundTrip(unittest.TestCase):
    def test_missing_file_returns_empty(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(w.load_state(os.path.join(d, "nope.json")), {})

    def test_save_then_load(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "sub", "state.json")
            w.save_state({"last_heartbeat_date": "2026-06-15"}, path)
            self.assertEqual(w.load_state(path), {"last_heartbeat_date": "2026-06-15"})

    def test_corrupt_file_returns_empty(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "broken.json")
            with open(path, "w") as fh:
                fh.write("{not json")
            self.assertEqual(w.load_state(path), {})


class DbQuery(unittest.TestCase):
    def _make_db(self):
        conn = sqlite3.connect(":memory:")
        conn.executescript(
            """
            CREATE TABLE workflow_entity (id TEXT PRIMARY KEY, name TEXT, active INTEGER);
            CREATE TABLE execution_entity (
                id INTEGER PRIMARY KEY, workflowId TEXT, status TEXT, mode TEXT,
                startedAt TEXT, stoppedAt TEXT, deletedAt TEXT
            );
            """
        )
        conn.execute("INSERT INTO workflow_entity VALUES ('wf1','Digest',1)")
        conn.execute("INSERT INTO workflow_entity VALUES ('wf2','Clara',1)")
        conn.execute("INSERT INTO workflow_entity VALUES ('wf3','Inactive',0)")
        # wf1: latest is error
        conn.execute("INSERT INTO execution_entity VALUES "
                     "(10,'wf1','success','trigger',datetime('now','-3 hours'),"
                     "datetime('now','-3 hours'),NULL)")
        conn.execute("INSERT INTO execution_entity VALUES "
                     "(11,'wf1','error','trigger',datetime('now','-1 hours'),"
                     "datetime('now','-1 hours'),NULL)")
        # wf2: many old errors, latest success
        conn.execute("INSERT INTO execution_entity VALUES "
                     "(20,'wf2','error','trigger',datetime('now','-5 hours'),"
                     "datetime('now','-5 hours'),NULL)")
        conn.execute("INSERT INTO execution_entity VALUES "
                     "(21,'wf2','success','trigger',datetime('now','-2 hours'),"
                     "datetime('now','-2 hours'),NULL)")
        # wf3 inactive: should never appear
        conn.execute("INSERT INTO execution_entity VALUES "
                     "(30,'wf3','error','trigger',datetime('now','-1 hours'),"
                     "datetime('now','-1 hours'),NULL)")
        # out-of-window error for wf1 must not override
        conn.execute("INSERT INTO execution_entity VALUES "
                     "(40,'wf1','crashed','trigger',datetime('now','-30 days'),"
                     "datetime('now','-30 days'),NULL)")
        conn.commit()
        return conn

    def test_returns_latest_per_active_workflow(self):
        conn = self._make_db()
        rows = w._dedup_latest(w.fetch_active_workflow_latest(conn))
        by_id = {r[0]: r for r in rows}
        self.assertEqual(set(by_id), {"wf1", "wf2"})           # wf3 inactive excluded
        self.assertEqual(by_id["wf1"][3], "error")             # latest in-window status
        self.assertEqual(by_id["wf1"][4], 11)                  # exec_id 11, not the 30d-old 40
        self.assertEqual(by_id["wf2"][3], "success")

    def test_count_active(self):
        conn = self._make_db()
        self.assertEqual(w.count_active(conn), 2)

    def test_end_to_end_detection(self):
        conn = self._make_db()
        rows = w._dedup_latest(w.fetch_active_workflow_latest(conn))
        findings = w.find_failed_workflows(rows)
        self.assertEqual([f["id"] for f in findings], ["wf1"])

    def test_running_newer_execution_suppresses_stale_error(self):
        conn = self._make_db()
        # wf4: latest FINISHED run errored, but a NEWER run is currently running
        conn.execute("INSERT INTO workflow_entity VALUES ('wf4','InProgress',1)")
        conn.execute("INSERT INTO execution_entity VALUES "
                     "(50,'wf4','error','trigger',datetime('now','-2 hours'),"
                     "datetime('now','-2 hours'),NULL)")
        conn.execute("INSERT INTO execution_entity VALUES "
                     "(51,'wf4','running','trigger',datetime('now','-10 minutes'),"
                     "NULL,NULL)")  # in-progress: stoppedAt NULL, started after the error
        conn.commit()
        rows = w._dedup_latest(w.fetch_active_workflow_latest(conn))
        by_id = {r[0]: r for r in rows}
        # wf4's latest is the running execution (51), NOT the stale error (50)
        self.assertEqual(by_id["wf4"][4], 51)
        self.assertEqual(by_id["wf4"][3], "running")
        # therefore wf4 is NOT flagged
        findings = w.find_failed_workflows(rows)
        self.assertNotIn("wf4", [f["id"] for f in findings])


class SendMail(unittest.TestCase):
    def test_posts_payload_and_returns_status(self):
        fake_resp = mock.MagicMock()
        fake_resp.status = 200
        fake_resp.__enter__.return_value = fake_resp
        with mock.patch.object(w.urllib.request, "urlopen", return_value=fake_resp) as uo:
            status = w.send_mail("Subj", "text body", "<p>html</p>", [])
        self.assertEqual(status, 200)
        req = uo.call_args.args[0]
        self.assertEqual(req.full_url, w.WEBHOOK_URL)
        self.assertEqual(req.get_header("X-mailhub-secret"), w.MAILHUB_SECRET)
        payload = json.loads(req.data.decode("utf-8"))
        self.assertEqual(payload["to"], w.TO_ADDR)
        self.assertEqual(payload["from"], w.FROM_ADDR)
        self.assertEqual(payload["subject"], "Subj")
        self.assertEqual(payload["html"], "<p>html</p>")

    def test_http_error_returns_code(self):
        err = w.urllib.error.HTTPError(w.WEBHOOK_URL, 500, "boom", {}, None)
        with mock.patch.object(w.urllib.request, "urlopen", side_effect=err):
            self.assertEqual(w.send_mail("s", "t", "", []), 500)


class MainOrchestration(unittest.TestCase):
    def test_findings_send_mail_and_persist(self):
        rows = [("wf1", "Digest", "trigger", "error", 11, "2026-06-12 03:00:00")]
        with tempfile.TemporaryDirectory() as d:
            statep = os.path.join(d, "state.json")
            with mock.patch.object(w, "STATE_PATH", statep), \
                 mock.patch.object(w, "open_db_ro", return_value=mock.MagicMock()), \
                 mock.patch.object(w, "fetch_active_workflow_latest", return_value=rows), \
                 mock.patch.object(w, "count_active", return_value=23), \
                 mock.patch.object(w, "send_mail", return_value=200) as sm:
                rc = w.main(["--once"])
            self.assertEqual(rc, 0)
            sm.assert_called_once()
            self.assertIn("1 Workflow", sm.call_args.args[0])     # subject
            state = w.load_state(statep)
            self.assertEqual(state["last_reported_ids"], ["wf1"])

    def test_findings_dry_run_does_not_send(self):
        rows = [("wf1", "Digest", "trigger", "error", 11, "2026-06-12 03:00:00")]
        with tempfile.TemporaryDirectory() as d:
            statep = os.path.join(d, "state.json")
            with mock.patch.object(w, "STATE_PATH", statep), \
                 mock.patch.object(w, "open_db_ro", return_value=mock.MagicMock()), \
                 mock.patch.object(w, "fetch_active_workflow_latest", return_value=rows), \
                 mock.patch.object(w, "count_active", return_value=23), \
                 mock.patch.object(w, "send_mail", return_value=200) as sm:
                rc = w.main(["--dry-run"])
        self.assertEqual(rc, 0)
        sm.assert_not_called()

    def test_no_findings_non_monday_silent(self):
        with tempfile.TemporaryDirectory() as d:
            statep = os.path.join(d, "state.json")
            with mock.patch.object(w, "STATE_PATH", statep), \
                 mock.patch.object(w, "open_db_ro", return_value=mock.MagicMock()), \
                 mock.patch.object(w, "fetch_active_workflow_latest", return_value=[]), \
                 mock.patch.object(w, "count_active", return_value=23), \
                 mock.patch.object(w, "should_send_heartbeat", return_value=False), \
                 mock.patch.object(w, "send_mail", return_value=200) as sm:
                rc = w.main(["--once"])
        self.assertEqual(rc, 0)
        sm.assert_not_called()

    def test_no_findings_heartbeat_due_sends(self):
        with tempfile.TemporaryDirectory() as d:
            statep = os.path.join(d, "state.json")
            with mock.patch.object(w, "STATE_PATH", statep), \
                 mock.patch.object(w, "open_db_ro", return_value=mock.MagicMock()), \
                 mock.patch.object(w, "fetch_active_workflow_latest", return_value=[]), \
                 mock.patch.object(w, "count_active", return_value=23), \
                 mock.patch.object(w, "should_send_heartbeat", return_value=True), \
                 mock.patch.object(w, "send_mail", return_value=200) as sm:
                rc = w.main(["--once"])
            self.assertEqual(rc, 0)
            sm.assert_called_once()
            self.assertIn("grün", sm.call_args.args[0])
            self.assertIn("last_heartbeat_date", w.load_state(statep))


if __name__ == "__main__":
    unittest.main()
