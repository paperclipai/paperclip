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

    def test_find_pending_duplicate_matches_recipient_and_file(self):
        tok = q.create(to="steve.nemitz@b-tu.de", area="FILM", subject="AW: VR Clips Haus",
                       body_md="b", rendered_html="h",
                       original_mail_file="2026-07-22-Re-VR-Clips-Haus-steve.nemitz.md",
                       approval_subject="a")
        # gleicher Empfänger (andere Groß-/Schreibweise) + gleiche Datei (mit Pfad-Präfix) → Treffer
        dup = q.find_pending_duplicate("Steve.Nemitz@b-tu.de",
                                       "E-Mails/2026-07-22-Re-VR-Clips-Haus-steve.nemitz.md")
        self.assertIsNotNone(dup)
        self.assertEqual(dup["token"], tok)

    def test_find_pending_duplicate_none_for_other(self):
        q.create(to="steve.nemitz@b-tu.de", area="FILM", subject="s", body_md="b",
                 rendered_html="h", original_mail_file="2026-07-22-a.md", approval_subject="a")
        # anderer Empfänger → kein Treffer
        self.assertIsNone(q.find_pending_duplicate("hoffmanc@b-tu.de", "2026-07-22-a.md"))
        # andere Ursprungsdatei → kein Treffer
        self.assertIsNone(q.find_pending_duplicate("steve.nemitz@b-tu.de", "2026-07-22-b.md"))

    def test_find_pending_duplicate_ignores_non_pending(self):
        tok = q.create(to="k@x.de", area="AI", subject="s", body_md="b", rendered_html="h",
                       original_mail_file="2026-07-22-x.md", approval_subject="a")
        q.mark(tok, "superseded")
        # ein verbrauchter (superseded/sent) Entwurf blockt einen neuen NICHT
        self.assertIsNone(q.find_pending_duplicate("k@x.de", "2026-07-22-x.md"))


if __name__ == "__main__":
    unittest.main()
