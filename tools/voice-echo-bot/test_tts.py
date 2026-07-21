import io
import os
import tempfile
import unittest
import urllib.error
from unittest import mock

import config
import tts


def _fake_response(data):
    m = mock.MagicMock()
    m.read.return_value = data
    m.__enter__.return_value = m
    m.__exit__.return_value = False
    return m


class TestSynthesize(unittest.TestCase):
    def _dest(self):
        fd, p = tempfile.mkstemp(suffix=".ogg")
        os.close(fd)
        self.addCleanup(lambda: os.path.exists(p) and os.unlink(p))
        return p

    def test_writes_audio_and_posts_correct_request(self):
        dest = self._dest()
        with mock.patch("tts.urllib.request.urlopen",
                        return_value=_fake_response(b"OggS-fake-opus")) as uo:
            out = tts.synthesize("Hallo Welt", "xi-secret", dest)
        self.assertEqual(out, dest)
        with open(dest, "rb") as fh:
            self.assertEqual(fh.read(), b"OggS-fake-opus")
        req = uo.call_args[0][0]
        self.assertEqual(req.full_url, config.ELEVEN_TTS_URL)
        self.assertEqual(req.headers.get("Xi-api-key"), "xi-secret")
        import json
        body = json.loads(req.data.decode("utf-8"))
        self.assertEqual(body["text"], "Hallo Welt")
        self.assertEqual(body["model_id"], config.ELEVEN_MODEL)

    def test_empty_text_raises(self):
        with self.assertRaises(tts.TtsError):
            tts.synthesize("   ", "xi-secret", self._dest())

    def test_missing_key_raises(self):
        with self.assertRaises(tts.TtsError):
            tts.synthesize("hi", "", self._dest())

    def test_http_error_raises_tts_error(self):
        err = urllib.error.HTTPError(config.ELEVEN_TTS_URL, 401, "Unauthorized", {}, io.BytesIO(b""))
        with mock.patch("tts.urllib.request.urlopen", side_effect=err):
            with self.assertRaises(tts.TtsError) as ctx:
                tts.synthesize("hi", "xi-secret", self._dest())
        self.assertIn("401", str(ctx.exception))

    def test_url_error_raises_tts_error(self):
        with mock.patch("tts.urllib.request.urlopen",
                        side_effect=urllib.error.URLError("no net")):
            with self.assertRaises(tts.TtsError):
                tts.synthesize("hi", "xi-secret", self._dest())

    def test_empty_audio_raises(self):
        with mock.patch("tts.urllib.request.urlopen", return_value=_fake_response(b"")):
            with self.assertRaises(tts.TtsError):
                tts.synthesize("hi", "xi-secret", self._dest())


if __name__ == "__main__":
    unittest.main()
