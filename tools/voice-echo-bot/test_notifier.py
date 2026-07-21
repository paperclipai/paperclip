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

if __name__ == "__main__": unittest.main()
