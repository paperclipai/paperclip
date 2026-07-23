# test_triage_reconcile.py
import unittest
import triage_reconcile as tr


GUARD_COMMENT = {"body": (
    "**Adapter post-run guard triggered:**\n"
    "The LLM finished its heartbeat without calling `paperclip_update_issue` with a "
    "terminal status.\nThis adapter has auto-closed the issue as `blocked` ...\n"
    "**LLM final message:** Task WHI-3021 marked as in_review. Antwort-Entwürfe erstellt.")}
WORK_COMMENT = {"body": "## Triage\n**Klassifikation:** actionable\n**Entwurf versendet:** …"}
ERROR_COMMENT = {"body": "llm_unreachable: connection refused to http://localhost:1234"}

TRIAGE = {"id": "i1", "title": "Neue Mails: 2 — Antwort-Entwürfe — 2026-07-23 08:26"}
OTHER = {"id": "i2", "title": "Korrektur Entwurf #ABCD — AW: Irgendwas"}


class GuardDetectionTest(unittest.TestCase):
    def test_guard_comment_detected(self):
        self.assertTrue(tr.is_guard_blocked([WORK_COMMENT, GUARD_COMMENT]))

    def test_real_error_is_not_guard(self):
        # Echter Fehler (kein Guard) darf NICHT als 'fertig' gelten.
        self.assertFalse(tr.is_guard_blocked([ERROR_COMMENT]))

    def test_no_comments_is_not_guard(self):
        self.assertFalse(tr.is_guard_blocked([]))
        self.assertFalse(tr.is_guard_blocked(None))


class TriageIssueTest(unittest.TestCase):
    def test_only_watcher_triage_issues(self):
        self.assertTrue(tr.is_triage_issue(TRIAGE))
        self.assertFalse(tr.is_triage_issue(OTHER))


class ReconcileTest(unittest.TestCase):
    def _run(self, issues, comments, dry_run=False):
        closed = []
        res = tr.reconcile(
            list_blocked=lambda: issues,
            get_comments=lambda i: comments.get(i, []),
            close_issue=lambda i: closed.append(i),
            dry_run=dry_run)
        return res, closed

    def test_closes_guard_blocked_triage(self):
        res, closed = self._run([TRIAGE], {"i1": [WORK_COMMENT, GUARD_COMMENT]})
        self.assertEqual(closed, ["i1"])
        self.assertEqual(res[0]["action"], "closed")

    def test_leaves_real_errors_alone(self):
        res, closed = self._run([TRIAGE], {"i1": [ERROR_COMMENT]})
        self.assertEqual(closed, [])
        self.assertEqual(res, [])

    def test_leaves_non_triage_issues_alone(self):
        res, closed = self._run([OTHER], {"i2": [GUARD_COMMENT]})
        self.assertEqual(closed, [])
        self.assertEqual(res, [])

    def test_dry_run_writes_nothing(self):
        res, closed = self._run([TRIAGE], {"i1": [GUARD_COMMENT]}, dry_run=True)
        self.assertEqual(closed, [])
        self.assertEqual(res[0]["action"], "would-close")

    def test_one_broken_entry_does_not_kill_the_run(self):
        def boom(_i):
            raise RuntimeError("API weg")
        res = tr.reconcile(list_blocked=lambda: [TRIAGE, {"id": "i3", "title": "Neue Mails: 1 — x"}],
                           get_comments=lambda i: (_ for _ in ()).throw(RuntimeError("API weg"))
                           if i == "i1" else [GUARD_COMMENT],
                           close_issue=lambda i: None, dry_run=False)
        actions = {r["id"]: r["action"] for r in res}
        self.assertEqual(actions["i1"], "error")     # kaputter Eintrag isoliert
        self.assertEqual(actions["i3"], "closed")    # der andere läuft trotzdem


if __name__ == "__main__":
    unittest.main()
