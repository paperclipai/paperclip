import os
import tempfile
import unittest
import state


class TestState(unittest.TestCase):
    def test_missing_file_is_empty_set(self):
        self.assertEqual(state.load_state("/nonexistent/x.json"), set())

    def test_roundtrip(self):
        fd, p = tempfile.mkstemp(suffix=".json")
        os.close(fd)
        os.unlink(p)
        self.addCleanup(lambda: os.path.exists(p) and os.unlink(p))
        state.save_state(p, {"a:done", "b:decision"})
        self.assertEqual(state.load_state(p), {"a:done", "b:decision"})

    def test_corrupt_file_is_empty_set(self):
        fd, p = tempfile.mkstemp(suffix=".json")
        os.close(fd)
        open(p, "w").write("{not json")
        self.addCleanup(os.unlink, p)
        self.assertEqual(state.load_state(p), set())


if __name__ == "__main__":
    unittest.main()
