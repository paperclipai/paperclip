# tools/voice-echo-bot/test_vault_client.py
import io
import json
import unittest
import urllib.error
from unittest import mock

import vault_client


class _Resp:
    def __init__(self, payload):
        self._data = json.dumps(payload).encode("utf-8")
    def read(self):
        return self._data
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False


class TestLookup(unittest.TestCase):
    def test_returns_parsed_json(self):
        payload = {"mode": "kontakt", "query": "Jana", "treffer": [{"inhalt": "Tel: 1"}]}
        with mock.patch.object(vault_client.urllib.request, "urlopen", return_value=_Resp(payload)):
            self.assertEqual(vault_client.lookup("kontakt", "Jana"), payload)

    def test_posts_mode_and_query(self):
        captured = {}
        def fake_urlopen(req, timeout=None):
            captured["body"] = json.loads(req.data.decode("utf-8"))
            captured["url"] = req.full_url
            return _Resp({"mode": "termin", "query": "heute", "treffer": []})
        with mock.patch.object(vault_client.urllib.request, "urlopen", side_effect=fake_urlopen):
            vault_client.lookup("termin", "heute")
        self.assertEqual(captured["body"], {"mode": "termin", "query": "heute"})
        self.assertIn("7788", captured["url"])

    def test_http_error_raises_vaulterror(self):
        err = urllib.error.HTTPError("u", 400, "bad", {}, io.BytesIO(b""))
        with mock.patch.object(vault_client.urllib.request, "urlopen", side_effect=err):
            with self.assertRaises(vault_client.VaultError):
                vault_client.lookup("kontakt", "x")

    def test_urlerror_raises_vaulterror(self):
        with mock.patch.object(vault_client.urllib.request, "urlopen",
                               side_effect=urllib.error.URLError("refused")):
            with self.assertRaises(vault_client.VaultError):
                vault_client.lookup("kontakt", "x")

    def test_bad_json_raises_vaulterror(self):
        class BadResp(_Resp):
            def read(self):
                return b"not json"
        with mock.patch.object(vault_client.urllib.request, "urlopen",
                               return_value=BadResp({})):
            with self.assertRaises(vault_client.VaultError):
                vault_client.lookup("kontakt", "x")

    def test_vault_added_to_body_when_set(self):
        captured = {}
        def fake_urlopen(req, timeout=None):
            captured["body"] = json.loads(req.data.decode("utf-8"))
            return _Resp({"mode": "kontakt", "query": "x", "treffer": []})
        with mock.patch.object(vault_client.urllib.request, "urlopen", side_effect=fake_urlopen):
            vault_client.lookup("kontakt", "x", vault="clara")
        self.assertEqual(captured["body"], {"mode": "kontakt", "query": "x", "vault": "clara"})

    def test_vault_omitted_when_none(self):
        captured = {}
        def fake_urlopen(req, timeout=None):
            captured["body"] = json.loads(req.data.decode("utf-8"))
            return _Resp({"mode": "kontakt", "query": "x", "treffer": []})
        with mock.patch.object(vault_client.urllib.request, "urlopen", side_effect=fake_urlopen):
            vault_client.lookup("kontakt", "x")
        self.assertNotIn("vault", captured["body"])

    def test_dokument_is_valid_mode(self):
        self.assertIn("dokument", vault_client.VALID_MODES)


if __name__ == "__main__":
    unittest.main()
