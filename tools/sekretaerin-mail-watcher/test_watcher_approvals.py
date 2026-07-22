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

# Echtes „E-Mails v9"-Renderformat: Frontmatter + # Betreff + **Von:**-Block +
# '---'-Trenner + eigentlicher Antworttext + zitiertes Original. (Regression:
# der E2E deckte auf, dass der Renderblock 'Okay' als correction fehlklassifiziert.)
MAIL_OKAY_RENDERED = """---
type: email
betreff: "AW: [Freigabe #A7X3] AW: Textkorrektur → an k@x.de"
von: "WHITESTAG - Walter Schönenbröcher <w.schonenbrocher@oubifb.hostedoffice.ag>"
an: "office@whitestag.ai"
ordner: "Gesendete Elemente"
---

# AW: [Freigabe #A7X3] AW: Textkorrektur → an k@x.de

**Von:** WHITESTAG - Walter Schönenbröcher <w.schonenbrocher@oubifb.hostedoffice.ag>
**An:** office@whitestag.ai
**Datum:** 22.7.2026, 15:29:13
**Ordner:** Gesendete Elemente

---

Okay

> **Von:** office@whitestag.ai
> [Freigabe #A7X3] Entwurf …
> Sehr geehrte Damen und Herren …
"""


MAIL_IGNORE = """---
von: w.schonenbrocher@whitestag.ai
subject: AW: [Freigabe #A7X3] AW: Textkorrektur → an k@x.de
---
Ignorieren
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

    def test_send_error_keeps_pending(self):
        self._write("2026-07-22-okay-err-w.schonenbrocher.md", MAIL_OKAY)
        res = w.process_approvals(["2026-07-22-okay-err-w.schonenbrocher.md"],
                                  dry_run=False,
                                  send=lambda entry, **kw: (500, "boom"),
                                  make_issue=lambda *a, **k: None)
        # Kein Versand-Erfolg -> Eintrag bleibt pending, wird spaeter erneut versucht.
        self.assertEqual(q.load("A7X3")["status"], "pending")
        self.assertTrue(any(r["action"] == "send-error" for r in res))

    def test_scan_separates_approval_replies(self):
        self._write("2026-07-22-okay-split-w.schonenbrocher.md", MAIL_OKAY)
        # scan() (Kundenmail-/Entwurfspfad) darf die Freigabe-Antwort NICHT enthalten:
        self.assertNotIn("2026-07-22-okay-split-w.schonenbrocher.md", w.scan(3))
        # scan_approval_replies() MUSS sie enthalten (noch nicht in seen):
        self.assertIn("2026-07-22-okay-split-w.schonenbrocher.md",
                      w.scan_approval_replies(3, set()))

    def test_result_carries_file_and_action(self):
        self._write("2026-07-22-file-w.schonenbrocher.md", MAIL_OKAY)
        r = w.process_approvals(["2026-07-22-file-w.schonenbrocher.md"],
                                dry_run=False, send=lambda e, **k: (200, "ok"),
                                make_issue=lambda *a, **k: None)
        self.assertEqual(r[0]["file"], "2026-07-22-file-w.schonenbrocher.md")
        self.assertEqual(r[0]["action"], "sent")

    def test_send_success_saves_sent_copy(self):
        self._write("2026-07-22-copy-w.schonenbrocher.md", MAIL_OKAY)
        saved = []
        w.process_approvals(["2026-07-22-copy-w.schonenbrocher.md"], dry_run=False,
                            send=lambda e, **k: (200, "ok"), make_issue=lambda *a, **k: None,
                            save_sent=lambda **kw: (saved.append(kw), (True, ""))[1])
        self.assertEqual(len(saved), 1)
        self.assertEqual(saved[0]["to"], "k@x.de")
        self.assertEqual(saved[0]["subject"], "AW: Textkorrektur")
        self.assertEqual(q.load("A7X3")["status"], "sent")

    def test_sent_copy_failure_is_non_fatal(self):
        # Scheitert die Sent-Kopie, bleibt der Versand trotzdem 'sent'.
        self._write("2026-07-22-copyfail-w.schonenbrocher.md", MAIL_OKAY)
        r = w.process_approvals(["2026-07-22-copyfail-w.schonenbrocher.md"], dry_run=False,
                                send=lambda e, **k: (200, "ok"), make_issue=lambda *a, **k: None,
                                save_sent=lambda **kw: (_ for _ in ()).throw(RuntimeError("EWS down")))
        self.assertEqual(r[0]["action"], "sent")
        self.assertEqual(q.load("A7X3")["status"], "sent")

    def test_no_save_sent_when_not_provided(self):
        # Ohne save_sent (z.B. dry-run-frei getestet) wird EWS NICHT berührt.
        self._write("2026-07-22-nocopy-w.schonenbrocher.md", MAIL_OKAY)
        r = w.process_approvals(["2026-07-22-nocopy-w.schonenbrocher.md"], dry_run=False,
                                send=lambda e, **k: (200, "ok"), make_issue=lambda *a, **k: None)
        self.assertEqual(r[0]["action"], "sent")  # kein Fehler trotz save_sent=None

    def test_send_error_stays_retryable_then_succeeds(self):
        # I1-Fix: nach Relay-Fehler bleibt der Eintrag pending UND wird beim
        # nächsten Lauf erneut versucht (Datei wird vom Aufrufer nicht als seen
        # markiert, da 'send-error' nicht terminal ist).
        self._write("2026-07-22-retry-w.schonenbrocher.md", MAIL_OKAY)
        calls = {"n": 0}
        def flaky(entry, **kw):
            calls["n"] += 1
            return (500, "boom") if calls["n"] == 1 else (200, "ok")
        r1 = w.process_approvals(["2026-07-22-retry-w.schonenbrocher.md"],
                                 dry_run=False, send=flaky, make_issue=lambda *a, **k: None)
        self.assertEqual(r1[0]["action"], "send-error")
        self.assertEqual(q.load("A7X3")["status"], "pending")
        # 2. Lauf = Retry: Erfolg → sent, genau ein weiterer Sendeversuch
        r2 = w.process_approvals(["2026-07-22-retry-w.schonenbrocher.md"],
                                 dry_run=False, send=flaky, make_issue=lambda *a, **k: None)
        self.assertEqual(r2[0]["action"], "sent")
        self.assertEqual(q.load("A7X3")["status"], "sent")
        self.assertEqual(calls["n"], 2)

    def test_already_sent_is_skip_no_double_send(self):
        q.mark("A7X3", "sent")
        self._write("2026-07-22-again-w.schonenbrocher.md", MAIL_OKAY)
        r = w.process_approvals(
            ["2026-07-22-again-w.schonenbrocher.md"], dry_run=False,
            send=lambda *a, **k: (_ for _ in ()).throw(AssertionError("kein Doppelversand")),
            make_issue=lambda *a, **k: None)
        self.assertEqual(r[0]["action"], "skip")

    def test_read_body_strips_rendered_header(self):
        # read_body muss den v9-Renderblock entfernen, sodass 'Okay' oben steht.
        self._write("2026-07-22-rendered-w.schonenbrocher.md", MAIL_OKAY_RENDERED)
        body = w.read_body(w.MAILDIR / "2026-07-22-rendered-w.schonenbrocher.md")
        self.assertTrue(body.lstrip().startswith("Okay"), body[:40])
        self.assertNotIn("**Von:**", body.split("\n")[0])

    def test_rendered_okay_triggers_send(self):
        # Voller Pfad mit echtem Vault-Renderformat: 'Okay' → send (nicht correction).
        self._write("2026-07-22-rok-w.schonenbrocher.md", MAIL_OKAY_RENDERED)
        sent = []
        w.process_approvals(["2026-07-22-rok-w.schonenbrocher.md"], dry_run=False,
                            send=lambda e, **k: (sent.append(e["token"]), (200, "ok"))[1],
                            make_issue=lambda *a, **k: None)
        self.assertEqual(sent, ["A7X3"])
        self.assertEqual(q.load("A7X3")["status"], "sent")

    def test_send_raising_is_caught_not_crash(self):
        # I2-Fix: eine Exception im Sendepfad killt den Tick nicht; Eintrag bleibt pending.
        self._write("2026-07-22-boom-w.schonenbrocher.md", MAIL_OKAY)
        def boom(entry, **kw):
            raise RuntimeError("URLError o. ä.")
        r = w.process_approvals(["2026-07-22-boom-w.schonenbrocher.md"],
                                dry_run=False, send=boom, make_issue=lambda *a, **k: None)
        self.assertEqual(r[0]["action"], "error")
        self.assertEqual(q.load("A7X3")["status"], "pending")

    def test_ignore_blocks_recipient_no_send_no_issue(self):
        import blocklist as bl
        bl.STATE = self.dir / "luna-blocklist.json"
        self._write("2026-07-22-ign-w.schonenbrocher.md", MAIL_IGNORE)
        r = w.process_approvals(
            ["2026-07-22-ign-w.schonenbrocher.md"], dry_run=False,
            send=lambda *a, **k: (_ for _ in ()).throw(AssertionError("darf nicht senden")),
            make_issue=lambda *a, **k: (_ for _ in ()).throw(AssertionError("kein Issue")))
        self.assertEqual(r[0]["action"], "ignored")
        self.assertEqual(q.load("A7X3")["status"], "ignored")
        self.assertTrue(bl.is_blocked("k@x.de"))

    def test_ignore_dry_run_would_ignore_no_write(self):
        import blocklist as bl
        bl.STATE = self.dir / "luna-blocklist.json"
        self._write("2026-07-22-igndry-w.schonenbrocher.md", MAIL_IGNORE)
        r = w.process_approvals(["2026-07-22-igndry-w.schonenbrocher.md"], dry_run=True,
                                send=lambda *a, **k: (200, "ok"), make_issue=lambda *a, **k: None)
        self.assertEqual(r[0]["action"], "would-ignore")
        self.assertEqual(q.load("A7X3")["status"], "pending")  # nichts verändert
        self.assertFalse(bl.is_blocked("k@x.de"))

    def test_scan_skips_blocked_sender(self):
        import blocklist as bl
        bl.STATE = self.dir / "luna-blocklist.json"
        bl.add("spam@x.de")
        mail = ("---\nvon: Spam Meier <spam@x.de>\n"
                "subject: Angebot\n---\n\nKaufen Sie jetzt!\n")
        self._write("2026-07-22-spam-eingang.md", mail)
        self.assertNotIn("2026-07-22-spam-eingang.md", w.scan(3))

    def test_scan_keeps_unblocked_sender(self):
        import blocklist as bl
        bl.STATE = self.dir / "luna-blocklist.json"  # leere Blocklist
        mail = ("---\nvon: Echt Kunde <kunde@x.de>\n"
                "subject: Anfrage\n---\n\nHallo Luna\n")
        self._write("2026-07-22-echt-eingang.md", mail)
        self.assertIn("2026-07-22-echt-eingang.md", w.scan(3))

    def test_process_unblock_removes_from_blocklist(self):
        import blocklist as bl
        import office_inbox as oi
        bl.STATE = self.dir / "luna-blocklist.json"
        bl.add("weg@x.de")
        saved = {}
        oi.fetch_unblock_commands = lambda processed, **kw: [{"uid": "20", "addr": "weg@x.de"}]
        oi.load_processed_unblock = lambda: set()
        oi.save_processed_unblock = lambda uids: saved.update({"uids": set(uids)})
        r = w.process_unblock_commands(dry_run=False)
        self.assertEqual(r[0]["action"], "unblocked")
        self.assertEqual(r[0]["addr"], "weg@x.de")
        self.assertFalse(bl.is_blocked("weg@x.de"))
        self.assertIn("20", saved["uids"])

    def test_process_unblock_dry_run_keeps_block(self):
        import blocklist as bl
        import office_inbox as oi
        bl.STATE = self.dir / "luna-blocklist.json"
        bl.add("weg@x.de")
        oi.fetch_unblock_commands = lambda processed, **kw: [{"uid": "20", "addr": "weg@x.de"}]
        oi.load_processed_unblock = lambda: set()
        oi.save_processed_unblock = lambda uids: None
        r = w.process_unblock_commands(dry_run=True)
        self.assertEqual(r[0]["action"], "would-unblock")
        self.assertTrue(bl.is_blocked("weg@x.de"))  # unverändert


if __name__ == "__main__":
    unittest.main()
