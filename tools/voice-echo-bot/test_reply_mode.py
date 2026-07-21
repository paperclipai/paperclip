import os
import tempfile
import unittest

import reply_mode


class TestReplyMode(unittest.TestCase):
    def _path(self):
        fd, p = tempfile.mkstemp(suffix=".json")
        os.close(fd)
        os.unlink(p)
        self.addCleanup(lambda: os.path.exists(p) and os.unlink(p))
        return p

    def test_default_is_text_when_file_missing(self):
        self.assertEqual(reply_mode.get_mode("/nonexistent/rm.json", 42), "text")

    def test_default_is_text_for_unknown_chat(self):
        p = self._path()
        reply_mode.set_mode(p, 1, "voice")
        self.assertEqual(reply_mode.get_mode(p, 999), "text")

    def test_set_and_get_roundtrip_per_chat(self):
        p = self._path()
        reply_mode.set_mode(p, 1, "voice")
        reply_mode.set_mode(p, 2, "text")
        self.assertEqual(reply_mode.get_mode(p, 1), "voice")
        self.assertEqual(reply_mode.get_mode(p, 2), "text")

    def test_set_overwrites_previous(self):
        p = self._path()
        reply_mode.set_mode(p, 1, "voice")
        reply_mode.set_mode(p, 1, "text")
        self.assertEqual(reply_mode.get_mode(p, 1), "text")

    def test_chat_id_type_insensitive(self):
        p = self._path()
        reply_mode.set_mode(p, 7, "voice")
        self.assertEqual(reply_mode.get_mode(p, "7"), "voice")

    def test_persists_across_reload(self):
        p = self._path()
        reply_mode.set_mode(p, 5, "voice")
        # Frischer Read von der Platte (kein In-Memory-State)
        self.assertEqual(reply_mode.get_mode(p, 5), "voice")

    def test_corrupt_file_yields_default_no_crash(self):
        p = self._path()
        with open(p, "w", encoding="utf-8") as fh:
            fh.write("{not json")
        self.assertEqual(reply_mode.get_mode(p, 1), "text")
        # set_mode auf korrupter Datei überschreibt sauber
        reply_mode.set_mode(p, 1, "voice")
        self.assertEqual(reply_mode.get_mode(p, 1), "voice")

    def test_invalid_stored_value_falls_back_to_default(self):
        p = self._path()
        with open(p, "w", encoding="utf-8") as fh:
            fh.write('{"1": "singing"}')
        self.assertEqual(reply_mode.get_mode(p, 1), "text")

    def test_set_rejects_invalid_mode(self):
        p = self._path()
        with self.assertRaises(ValueError):
            reply_mode.set_mode(p, 1, "shout")


if __name__ == "__main__":
    unittest.main()
