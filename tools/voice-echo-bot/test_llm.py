# tools/voice-echo-bot/test_llm.py
import io
import json
import unittest
import urllib.error
from unittest import mock

import llm


class _Resp:
    def __init__(self, payload):
        self._data = json.dumps(payload).encode("utf-8")
    def read(self):
        return self._data
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False


class TestChat(unittest.TestCase):
    def test_returns_stripped_content(self):
        payload = {"choices": [{"message": {"content": "  Hallo Walter  "}}]}
        with mock.patch.object(llm.urllib.request, "urlopen", return_value=_Resp(payload)):
            self.assertEqual(llm.chat([{"role": "user", "content": "hi"}]), "Hallo Walter")

    def test_sends_model_and_messages(self):
        captured = {}
        def fake_urlopen(req, timeout=None):
            captured["body"] = json.loads(req.data.decode("utf-8"))
            return _Resp({"choices": [{"message": {"content": "ok"}}]})
        with mock.patch.object(llm.urllib.request, "urlopen", side_effect=fake_urlopen):
            llm.chat([{"role": "user", "content": "hi"}], model="gemma-x", temperature=0.7)
        self.assertEqual(captured["body"]["model"], "gemma-x")
        self.assertEqual(captured["body"]["temperature"], 0.7)
        self.assertEqual(captured["body"]["messages"][0]["content"], "hi")

    def test_http_error_raises_llmerror(self):
        err = urllib.error.HTTPError("u", 500, "boom", {}, io.BytesIO(b""))
        with mock.patch.object(llm.urllib.request, "urlopen", side_effect=err):
            with self.assertRaises(llm.LlmError):
                llm.chat([{"role": "user", "content": "hi"}])

    def test_urlerror_raises_llmerror(self):
        with mock.patch.object(llm.urllib.request, "urlopen",
                               side_effect=urllib.error.URLError("refused")):
            with self.assertRaises(llm.LlmError):
                llm.chat([{"role": "user", "content": "hi"}])

    def test_empty_content_raises(self):
        with mock.patch.object(llm.urllib.request, "urlopen",
                               return_value=_Resp({"choices": [{"message": {"content": "   "}}]})):
            with self.assertRaises(llm.LlmError):
                llm.chat([{"role": "user", "content": "hi"}])

    def test_malformed_payload_raises(self):
        with mock.patch.object(llm.urllib.request, "urlopen",
                               return_value=_Resp({"nope": True})):
            with self.assertRaises(llm.LlmError):
                llm.chat([{"role": "user", "content": "hi"}])


if __name__ == "__main__":
    unittest.main()
