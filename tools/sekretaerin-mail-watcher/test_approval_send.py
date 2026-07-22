import unittest, json
import approval_send as s


class FakeResp:
    def __init__(self, code, body=b"ok"):
        self.status = code; self._b = body
    def read(self): return self._b
    def __enter__(self): return self
    def __exit__(self, *a): return False


class SendTest(unittest.TestCase):
    def test_build_payload_has_approval_and_replyto(self):
        entry = {"to": "k@example.de", "subject": "AW: x", "body_md": "Hallo",
                 "rendered_html": "<p>Hallo</p>", "in_reply_to": "<id@x>"}
        p = s.build_payload(entry, "SECRET")
        self.assertEqual(p["from"], "office@whitestag.ai")
        self.assertEqual(p["to"], "k@example.de")
        self.assertEqual(p["replyTo"], "ws@whitestag.ai")
        self.assertEqual(p["approval"], "SECRET")
        self.assertEqual(p["inReplyTo"], "<id@x>")
        self.assertEqual(p["html"], "<p>Hallo</p>")

    def test_send_approved_posts_and_returns_code(self):
        captured = {}
        def fake_urlopen(req, timeout=0):
            captured["url"] = req.full_url
            captured["data"] = json.loads(req.data.decode())
            return FakeResp(200)
        entry = {"to": "k@example.de", "subject": "s", "body_md": "b",
                 "rendered_html": "h", "in_reply_to": ""}
        s._secret_cache = "SECRET"  # Secret-Lesen umgehen
        code, _ = s.send_approved(entry, urlopen=fake_urlopen)
        self.assertEqual(code, 200)
        self.assertIn("/webhook/mailhub/send", captured["url"])
        self.assertEqual(captured["data"]["approval"], "SECRET")


if __name__ == "__main__":
    unittest.main()
