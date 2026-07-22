# test_watcher_approvals.py
import unittest, tempfile
from pathlib import Path
import approval_queue as q
import watcher as w


MAIL_OKAY = """---
von: w.schonenbrocher@whitestag.ai
subject: AW: [Freigabe #A7X3] AW: Textkorrektur → an k@x.de
---
Okay

> Am 22.07. schrieb office@whitestag.ai:
> Sehr geehrte …
"""

MAIL_CORRECTION = """---
von: w.schonenbrocher@whitestag.ai
subject: AW: [Freigabe #A7X3] AW: Textkorrektur → an k@x.de
---
Bitte etwas förmlicher formulieren.
"""


class ApprovalScanTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        q.QUEUE_DIR = self.dir / "queue"
        w.MAILDIR = self.dir / "mail"
        w.MAILDIR.mkdir()
        q.save({"token": "A7X3", "status": "pending", "to": "k@x.de", "area": "FILM",
                "subject": "AW: Textkorrektur", "body_md": "b", "rendered_html": "<p>b</p>",
                "in_reply_to": "", "original_mail_file": "orig.md",
                "approval_subject": "[Freigabe #A7X3] AW: Textkorrektur → an k@x.de",
                "created": "2026-07-22T10:00:00", "sent": None})

    def tearDown(self):
        self.tmp.cleanup()

    def _write(self, name, content):
        (w.MAILDIR / name).write_text(content, encoding="utf-8")

    def test_is_approval_reply_detects_token(self):
        self._write("2026-07-22-AW-Freigabe-w.schonenbrocher.md", MAIL_OKAY)
        tok = w.is_approval_reply(w.MAILDIR / "2026-07-22-AW-Freigabe-w.schonenbrocher.md")
        self.assertEqual(tok, "A7X3")

    def test_okay_triggers_send_and_marks_sent(self):
        self._write("2026-07-22-okay-w.schonenbrocher.md", MAIL_OKAY)
        sent_calls = []
        def fake_send(entry, **kw):
            sent_calls.append(entry["token"]); return (200, "ok")
        res = w.process_approvals(["2026-07-22-okay-w.schonenbrocher.md"],
                                  dry_run=False, send=fake_send, make_issue=lambda *a, **k: None)
        self.assertEqual(sent_calls, ["A7X3"])
        self.assertEqual(q.load("A7X3")["status"], "sent")

    def test_correction_makes_issue_no_send(self):
        self._write("2026-07-22-korr-w.schonenbrocher.md", MAIL_CORRECTION)
        issues = []
        res = w.process_approvals(["2026-07-22-korr-w.schonenbrocher.md"],
                                  dry_run=False,
                                  send=lambda *a, **k: (_ for _ in ()).throw(AssertionError("darf nicht senden")),
                                  make_issue=lambda tok, note, entry: issues.append((tok, note)))
        self.assertEqual(len(issues), 1)
        self.assertEqual(issues[0][0], "A7X3")
        self.assertEqual(q.load("A7X3")["status"], "pending")  # kein Versand


if __name__ == "__main__":
    unittest.main()
