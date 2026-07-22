# test_blocklist.py
import unittest, tempfile
from pathlib import Path
import blocklist as bl


class BlocklistTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        bl.STATE = Path(self.tmp.name) / "luna-blocklist.json"

    def tearDown(self):
        self.tmp.cleanup()

    def test_add_then_blocked(self):
        bl.add("Kunde@Example.com")
        self.assertTrue(bl.is_blocked("kunde@example.com"))
        self.assertTrue(bl.is_blocked("  KUNDE@EXAMPLE.COM  "))

    def test_unknown_not_blocked(self):
        self.assertFalse(bl.is_blocked("fremd@x.de"))

    def test_add_is_idempotent(self):
        bl.add("a@x.de")
        bl.add("a@x.de")
        self.assertEqual(bl.load(), {"a@x.de"})

    def test_remove(self):
        bl.add("a@x.de")
        bl.remove("A@X.DE")
        self.assertFalse(bl.is_blocked("a@x.de"))
        self.assertEqual(bl.load(), set())

    def test_remove_absent_is_noop(self):
        bl.remove("nope@x.de")  # darf nicht werfen
        self.assertEqual(bl.load(), set())

    def test_empty_address_ignored(self):
        bl.add("   ")
        self.assertEqual(bl.load(), set())

    def test_fail_open_on_corrupt_file(self):
        bl.STATE.parent.mkdir(parents=True, exist_ok=True)
        bl.STATE.write_text("{ kaputt", encoding="utf-8")
        self.assertEqual(bl.load(), set())          # kein Crash
        self.assertFalse(bl.is_blocked("a@x.de"))

    def test_missing_file_is_empty(self):
        self.assertEqual(bl.load(), set())


if __name__ == "__main__":
    unittest.main()
