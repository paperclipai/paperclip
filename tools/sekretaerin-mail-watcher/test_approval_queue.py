# test_approval_queue.py
import unittest, tempfile, json
from datetime import datetime, timedelta
from pathlib import Path
import approval_queue as q


class QueueTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        q.QUEUE_DIR = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_token_format_and_uniqueness(self):
        t = q.gen_token(existing={"AAAA"})
        self.assertEqual(len(t), 4)
        self.assertTrue(all(c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567" for c in t))
        self.assertNotEqual(t, "AAAA")

    def test_create_and_load_roundtrip(self):
        tok = q.create(to="k@example.de", area="FILM", subject="AW: Test",
                       body_md="Hallo", rendered_html="<p>Hallo</p>",
                       original_mail_file="2026-07-22-x.md",
                       approval_subject="[Freigabe #ABCD] AW: Test → an k@example.de")
        e = q.load(tok)
        self.assertEqual(e["status"], "pending")
        self.assertEqual(e["to"], "k@example.de")
        self.assertEqual(e["rendered_html"], "<p>Hallo</p>")
        self.assertIn("created", e)

    def test_mark_changes_status(self):
        tok = q.create(to="k@example.de", area="AI", subject="s", body_md="b",
                       rendered_html="h", original_mail_file="f", approval_subject="a")
        q.mark(tok, "sent", sent="2026-07-22T10:00:00")
        self.assertEqual(q.load(tok)["status"], "sent")

    def test_list_pending_only(self):
        t1 = q.create(to="a@x.de", area="AI", subject="s", body_md="b",
                      rendered_html="h", original_mail_file="f", approval_subject="a")
        t2 = q.create(to="b@x.de", area="AI", subject="s", body_md="b",
                      rendered_html="h", original_mail_file="f", approval_subject="a")
        q.mark(t2, "sent")
        pend = [e["token"] for e in q.list_pending()]
        self.assertIn(t1, pend)
        self.assertNotIn(t2, pend)

    def test_expire_stale(self):
        tok = q.create(to="a@x.de", area="AI", subject="s", body_md="b",
                       rendered_html="h", original_mail_file="f", approval_subject="a")
        e = q.load(tok); e["created"] = (datetime.now() - timedelta(days=8)).isoformat(); q.save(e)
        expired = q.expire_stale(ttl_days=7)
        self.assertIn(tok, expired)
        self.assertEqual(q.load(tok)["status"], "expired")


if __name__ == "__main__":
    unittest.main()
