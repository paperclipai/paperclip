import json
import os
import tempfile
import unittest
from unittest import mock

import telegram_api


def _fake_response(payload):
    m = mock.MagicMock()
    m.read.return_value = json.dumps(payload).encode("utf-8")
    m.__enter__.return_value = m
    m.__exit__.return_value = False
    return m


class TestTelegram(unittest.TestCase):
    def setUp(self):
        self.tg = telegram_api.Telegram("123:ABC")

    def test_send_message_returns_result_and_posts_json(self):
        with mock.patch("telegram_api.urllib.request.urlopen",
                        return_value=_fake_response({"ok": True, "result": {"message_id": 10}})) as uo:
            res = self.tg.send_message(555, "hi", reply_markup={"inline_keyboard": []})
        self.assertEqual(res["message_id"], 10)
        req = uo.call_args[0][0]
        self.assertIn("/bot123:ABC/sendMessage", req.full_url)
        body = json.loads(req.data.decode("utf-8"))
        self.assertEqual(body["chat_id"], 555)
        self.assertEqual(body["text"], "hi")
        self.assertEqual(body["reply_markup"], {"inline_keyboard": []})

    def test_get_updates_returns_result_list(self):
        with mock.patch("telegram_api.urllib.request.urlopen",
                        return_value=_fake_response({"ok": True, "result": [{"update_id": 1}]})):
            updates = self.tg.get_updates(offset=7, timeout=0)
        self.assertEqual(updates, [{"update_id": 1}])

    def test_send_voice_posts_multipart_with_audio(self):
        fd, p = tempfile.mkstemp(suffix=".ogg")
        os.write(fd, b"OggS-opus-bytes")
        os.close(fd)
        self.addCleanup(os.unlink, p)
        with mock.patch("telegram_api.urllib.request.urlopen",
                        return_value=_fake_response({"ok": True, "result": {"message_id": 42}})) as uo:
            res = self.tg.send_voice(555, p, reply_to_message_id=7)
        self.assertEqual(res["message_id"], 42)
        req = uo.call_args[0][0]
        self.assertIn("/bot123:ABC/sendVoice", req.full_url)
        ctype = req.headers["Content-type"]
        self.assertTrue(ctype.startswith("multipart/form-data; boundary="))
        boundary = ctype.split("boundary=")[1]
        raw = req.data
        self.assertIn(boundary.encode("utf-8"), raw)
        self.assertIn(b'name="chat_id"', raw)
        self.assertIn(b"555", raw)
        self.assertIn(b'name="reply_to_message_id"', raw)
        self.assertIn(b'name="voice"; filename=', raw)
        self.assertIn(b"OggS-opus-bytes", raw)

    def test_send_voice_without_reply_to(self):
        fd, p = tempfile.mkstemp(suffix=".ogg")
        os.write(fd, b"x")
        os.close(fd)
        self.addCleanup(os.unlink, p)
        with mock.patch("telegram_api.urllib.request.urlopen",
                        return_value=_fake_response({"ok": True, "result": {"message_id": 1}})) as uo:
            self.tg.send_voice(9, p)
        self.assertNotIn(b"reply_to_message_id", uo.call_args[0][0].data)

    def test_get_file_path_extracts_file_path(self):
        with mock.patch("telegram_api.urllib.request.urlopen",
                        return_value=_fake_response({"ok": True, "result": {"file_path": "voice/file_1.oga"}})):
            self.assertEqual(self.tg.get_file_path("fid"), "voice/file_1.oga")


if __name__ == "__main__":
    unittest.main()
