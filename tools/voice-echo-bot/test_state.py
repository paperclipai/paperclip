import os
import tempfile
import unittest
import state


class TestState(unittest.TestCase):
    def test_missing_file_is_none(self):
        self.assertIsNone(state.load_state("/nonexistent/x.json"))

    def test_roundtrip(self):
        fd, p = tempfile.mkstemp(suffix=".json")
        os.close(fd)
        os.unlink(p)
        self.addCleanup(lambda: os.path.exists(p) and os.unlink(p))
        state.save_state(p, {"a:done", "b:decision"})
        self.assertEqual(state.load_state(p), {"a:done", "b:decision"})

    def test_corrupt_file_is_none(self):
        fd, p = tempfile.mkstemp(suffix=".json")
        os.close(fd)
        with open(p, "w", encoding="utf-8") as fh:
            fh.write("{not json")
        self.addCleanup(os.unlink, p)
        self.assertIsNone(state.load_state(p))


if __name__ == "__main__":
    unittest.main()
