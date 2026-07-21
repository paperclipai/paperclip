import unittest
import notifier

class TestCollectEvents(unittest.TestCase):
    def _issue(self, iid, status="in_progress", parent=None, labels=None):
        return {"id": iid, "status": status, "parentId": parent, "labelIds": labels or []}

    def test_done_toplevel_only(self):
        issues = [self._issue("a", status="done"),           # toplevel done -> event
                  self._issue("b", status="done", parent="a"),  # child done -> ignored
                  self._issue("c", status="in_progress")]
        events, keys = notifier.collect_events(issues, "L", set())
        self.assertEqual([e["key"] for e in events], ["a:done"])
        self.assertEqual(keys, ["a:done"])

    def test_decision_label(self):
        issues = [self._issue("x", labels=["L"]), self._issue("y", labels=["OTHER"])]
        events, _ = notifier.collect_events(issues, "L", set())
        self.assertEqual([(e["kind"], e["key"]) for e in events], [("decision", "x:decision")])

    def test_seen_are_suppressed(self):
        issues = [self._issue("a", status="done")]
        events, keys = notifier.collect_events(issues, "L", {"a:done"})
        self.assertEqual(events, [])
        self.assertEqual(keys, [])


class TestReconcileDecisionKeys(unittest.TestCase):
    def _issue(self, iid, labels=None):
        return {"id": iid, "status": "in_progress", "parentId": None, "labelIds": labels or []}

    def test_drops_key_when_label_removed(self):
        issues = [self._issue("x", labels=[])]
        stale = notifier.reconcile_decision_keys(issues, "L", {"x:decision"})
        self.assertEqual(stale, {"x:decision"})

    def test_keeps_key_when_still_labeled(self):
        issues = [self._issue("x", labels=["L"])]
        stale = notifier.reconcile_decision_keys(issues, "L", {"x:decision"})
        self.assertEqual(stale, set())

    def test_ignores_keys_not_in_seen(self):
        issues = [self._issue("x", labels=[])]
        stale = notifier.reconcile_decision_keys(issues, "L", set())
        self.assertEqual(stale, set())

    def test_ignores_unrelated_issue_ids(self):
        issues = [self._issue("x", labels=[])]
        stale = notifier.reconcile_decision_keys(issues, "L", {"y:decision"})
        self.assertEqual(stale, set())

    def test_re_raise_then_reappears_as_new_event(self):
        # War gelabelt+gesehen, Label entfernt (Mensch hat entschieden) ->
        # Key droppen; später erneut gelabelt -> collect_events liefert ein
        # neues Decision-Event.
        seen = {"x:decision"}
        unlabeled = [self._issue("x", labels=[])]
        stale = notifier.reconcile_decision_keys(unlabeled, "L", seen)
        seen -= stale
        events, _ = notifier.collect_events(unlabeled, "L", seen)
        self.assertEqual(events, [])  # noch nicht wieder gelabelt

        relabeled = [self._issue("x", labels=["L"])]
        events, keys = notifier.collect_events(relabeled, "L", seen)
        self.assertEqual([(e["kind"], e["key"]) for e in events], [("decision", "x:decision")])
        self.assertEqual(keys, ["x:decision"])


if __name__ == "__main__": unittest.main()
