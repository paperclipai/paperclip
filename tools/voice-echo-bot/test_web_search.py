# tools/voice-echo-bot/test_web_search.py
import io
import json
import unittest
import urllib.error
from unittest import mock

import web_search


class _Resp:
    def __init__(self, payload):
        self._data = json.dumps(payload).encode("utf-8")
    def read(self):
        return self._data
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False


TAVILY_PAYLOAD = {
    "query": "Wetter Cottbus morgen",
    "answer": "Morgen wird es in Cottbus 24 Grad und sonnig.",
    "results": [
        {"title": "Wetter Cottbus", "url": "https://example.com/a",
         "content": "24 Grad, sonnig", "score": 0.9},
        {"title": "Vorhersage", "url": "https://example.com/b",
         "content": "kaum Wolken", "score": 0.8},
    ],
}


class TestSearch(unittest.TestCase):
    def test_returns_normalised_result(self):
        with mock.patch.object(web_search.urllib.request, "urlopen",
                               return_value=_Resp(TAVILY_PAYLOAD)):
            out = web_search.search("Wetter Cottbus morgen", "tvly-k")
        self.assertEqual(out["query"], "Wetter Cottbus morgen")
        self.assertEqual(out["antwort"], "Morgen wird es in Cottbus 24 Grad und sonnig.")
        self.assertEqual(out["treffer"],
                         [{"titel": "Wetter Cottbus", "inhalt": "24 Grad, sonnig"},
                          {"titel": "Vorhersage", "inhalt": "kaum Wolken"}])

    def test_drops_urls_from_result(self):
        # URLs sind für die Sprachausgabe wertlos und kosten nur Kontext.
        with mock.patch.object(web_search.urllib.request, "urlopen",
                               return_value=_Resp(TAVILY_PAYLOAD)):
            out = web_search.search("x", "tvly-k")
        self.assertNotIn("example.com", json.dumps(out))

    def test_sends_bearer_key_and_query(self):
        captured = {}
        def fake_urlopen(req, timeout=None):
            captured["body"] = json.loads(req.data.decode("utf-8"))
            captured["auth"] = req.get_header("Authorization")
            captured["url"] = req.full_url
            return _Resp(TAVILY_PAYLOAD)
        with mock.patch.object(web_search.urllib.request, "urlopen",
                               side_effect=fake_urlopen):
            web_search.search("Wetter", "tvly-geheim", max_results=5)
        self.assertEqual(captured["auth"], "Bearer tvly-geheim")
        self.assertEqual(captured["body"]["query"], "Wetter")
        self.assertEqual(captured["body"]["max_results"], 5)
        self.assertTrue(captured["body"]["include_answer"])
        self.assertIn("api.tavily.com", captured["url"])

    def test_missing_answer_field_is_empty_string(self):
        with mock.patch.object(web_search.urllib.request, "urlopen",
                               return_value=_Resp({"results": []})):
            out = web_search.search("x", "tvly-k")
        self.assertEqual(out["antwort"], "")
        self.assertEqual(out["treffer"], [])

    def test_http_error_raises_websearcherror(self):
        err = urllib.error.HTTPError("u", 401, "unauthorized", {}, io.BytesIO(b""))
        with mock.patch.object(web_search.urllib.request, "urlopen", side_effect=err):
            with self.assertRaises(web_search.WebSearchError):
                web_search.search("x", "tvly-k")

    def test_urlerror_raises_websearcherror(self):
        with mock.patch.object(web_search.urllib.request, "urlopen",
                               side_effect=urllib.error.URLError("offline")):
            with self.assertRaises(web_search.WebSearchError):
                web_search.search("x", "tvly-k")

    def test_broken_json_raises_websearcherror(self):
        class _Bad:
            def read(self):
                return b"kein json"
            def __enter__(self):
                return self
            def __exit__(self, *a):
                return False
        with mock.patch.object(web_search.urllib.request, "urlopen", return_value=_Bad()):
            with self.assertRaises(web_search.WebSearchError):
                web_search.search("x", "tvly-k")

    def test_timeout_raises_websearcherror(self):
        with mock.patch.object(web_search.urllib.request, "urlopen",
                               side_effect=TimeoutError("zu langsam")):
            with self.assertRaises(web_search.WebSearchError):
                web_search.search("x", "tvly-k")

    def test_empty_key_raises_websearcherror(self):
        with self.assertRaises(web_search.WebSearchError):
            web_search.search("x", "")


if __name__ == "__main__":
    unittest.main()
