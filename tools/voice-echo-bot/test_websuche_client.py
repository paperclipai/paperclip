# tools/voice-echo-bot/test_websuche_client.py
import io
import json
import unittest
import urllib.error
from unittest import mock

import websuche_client


class _Resp:
    def __init__(self, payload):
        self._data = json.dumps(payload).encode("utf-8")
    def read(self):
        return self._data
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False


DIENST_PAYLOAD = {
    "frage": "Wetter Cottbus morgen",
    "abgerufen_am": "2026-08-17",
    "quellen": [
        {"url": "https://wetter.example/cottbus", "titel": "Wetter Cottbus",
         "domain": "wetter.example", "abgerufen_am": "2026-08-17",
         "text": "24 Grad, sonnig"},
        {"url": "https://vorhersage.example/x", "titel": "Vorhersage",
         "domain": "vorhersage.example", "abgerufen_am": "2026-08-17",
         "text": "kaum Wolken"},
    ],
}


class TestSuche(unittest.TestCase):
    def test_returns_normalised_result(self):
        with mock.patch.object(websuche_client.urllib.request, "urlopen",
                               return_value=_Resp(DIENST_PAYLOAD)):
            out = websuche_client.suche("Wetter Cottbus morgen")
        self.assertEqual(out["query"], "Wetter Cottbus morgen")
        self.assertEqual(out["quellen"], [
            {"domain": "wetter.example", "titel": "Wetter Cottbus",
             "text": "24 Grad, sonnig", "abgerufen_am": "2026-08-17"},
            {"domain": "vorhersage.example", "titel": "Vorhersage",
             "text": "kaum Wolken", "abgerufen_am": "2026-08-17"},
        ])

    def test_drops_urls_from_result(self):
        # Wie bei Tavily: vorgelesene URLs sind wertlos und kosten nur Kontext.
        # Die Domain bleibt, weil sie sprechbar ist ("laut wetter.example").
        with mock.patch.object(websuche_client.urllib.request, "urlopen",
                               return_value=_Resp(DIENST_PAYLOAD)):
            out = websuche_client.suche("x")
        self.assertNotIn("https://", json.dumps(out))

    def test_urls_inside_page_text_are_stripped(self):
        # Gegen den echten Dienst gefunden: die Textextraktion laesst URLs im
        # Fliesstext stehen ("WetterOnline ( https://www.wetteronline.de )").
        # Im Sprachpfad wuerde das Modell sie womoeglich vorlesen -- die
        # Anweisung "Nenne keine URLs" steht sonst gegen einen Kontext voller
        # URLs. Die Domain als Quellenangabe bleibt davon unberuehrt, die
        # steht in einem eigenen Feld.
        payload = {"frage": "x", "quellen": [
            {"domain": "wetteronline.de", "titel": "Wetter",
             "abgerufen_am": "2026-08-17",
             "text": "WetterOnline ( https://www.wetteronline.de ) meldet "
                     "24 Grad. Mehr unter www.wetteronline.de/cottbus heute."}]}
        with mock.patch.object(websuche_client.urllib.request, "urlopen",
                               return_value=_Resp(payload)):
            out = websuche_client.suche("x")
        text = out["quellen"][0]["text"]
        self.assertNotIn("https://", text)
        self.assertNotIn("www.", text)
        # Der Rest des Satzes muss erhalten bleiben, sonst geht Inhalt verloren.
        self.assertIn("24 Grad", text)
        self.assertIn("WetterOnline", text)
        self.assertIn("heute", text)

    def test_source_that_is_only_a_url_is_skipped(self):
        # Bleibt nach dem Entfernen der URLs kein Text uebrig, traegt die
        # Quelle nichts bei und faellt wie eine leere Quelle weg.
        payload = {"frage": "x", "quellen": [
            {"domain": "leer.example", "titel": "leer", "abgerufen_am": "2026-08-17",
             "text": "https://leer.example/a https://leer.example/b"},
            {"domain": "ok.example", "titel": "ok", "abgerufen_am": "2026-08-17",
             "text": "echter Text"}]}
        with mock.patch.object(websuche_client.urllib.request, "urlopen",
                               return_value=_Resp(payload)):
            out = websuche_client.suche("x")
        self.assertEqual([q["domain"] for q in out["quellen"]], ["ok.example"])

    def test_sends_query_and_budget_to_local_service(self):
        captured = {}
        def fake_urlopen(req, timeout=None):
            captured["body"] = json.loads(req.data.decode("utf-8"))
            captured["url"] = req.full_url
            captured["timeout"] = timeout
            return _Resp(DIENST_PAYLOAD)
        with mock.patch.object(websuche_client.urllib.request, "urlopen",
                               side_effect=fake_urlopen):
            websuche_client.suche("Wetter", quellen=2, zeichen=1500,
                                  deadline=7.0, timeout=8)
        self.assertEqual(captured["body"]["frage"], "Wetter")
        self.assertEqual(captured["body"]["quellen"], 2)
        self.assertEqual(captured["body"]["zeichen"], 1500)
        self.assertEqual(captured["body"]["deadline"], 7.0)
        self.assertEqual(captured["timeout"], 8)
        self.assertIn("127.0.0.1:7789", captured["url"])

    def test_deadline_stays_below_client_timeout(self):
        # Der Dienst soll selbst rechtzeitig aufgeben, statt dass der Client
        # ihn nach Ablauf seines Timeouts im Regen stehen laesst.
        self.assertLess(websuche_client.DEFAULT_DEADLINE,
                        websuche_client.DEFAULT_TIMEOUT)

    def test_service_error_503_raises_websucheerror(self):
        # 503 = alle Engines blockiert. Das ist ein Fehler, kein "nichts
        # gefunden" — nur so kann der Aufrufer auf Tavily zurueckfallen.
        err = urllib.error.HTTPError("u", 503, "unavailable", {}, io.BytesIO(b""))
        with mock.patch.object(websuche_client.urllib.request, "urlopen", side_effect=err):
            with self.assertRaises(websuche_client.WebsucheError):
                websuche_client.suche("x")

    def test_service_down_raises_websucheerror(self):
        with mock.patch.object(websuche_client.urllib.request, "urlopen",
                               side_effect=urllib.error.URLError("connection refused")):
            with self.assertRaises(websuche_client.WebsucheError):
                websuche_client.suche("x")

    def test_timeout_raises_websucheerror(self):
        with mock.patch.object(websuche_client.urllib.request, "urlopen",
                               side_effect=TimeoutError("zu langsam")):
            with self.assertRaises(websuche_client.WebsucheError):
                websuche_client.suche("x")

    def test_broken_json_raises_websucheerror(self):
        class _Bad:
            def read(self):
                return b"kein json"
            def __enter__(self):
                return self
            def __exit__(self, *a):
                return False
        with mock.patch.object(websuche_client.urllib.request, "urlopen", return_value=_Bad()):
            with self.assertRaises(websuche_client.WebsucheError):
                websuche_client.suche("x")

    def test_top_level_list_instead_of_object_raises_websucheerror(self):
        with mock.patch.object(websuche_client.urllib.request, "urlopen",
                               return_value=_Resp([1, 2, 3])):
            with self.assertRaises(websuche_client.WebsucheError):
                websuche_client.suche("x")

    def test_empty_quellen_raises_websucheerror(self):
        # Der Dienst antwortete zwar, hat aber nichts gelesen. Als Erfolg
        # durchgereicht wuerde das den Tavily-Fallback verhindern und JARVIS
        # eine leere Antwort erfinden lassen.
        with mock.patch.object(websuche_client.urllib.request, "urlopen",
                               return_value=_Resp({"frage": "x", "quellen": []})):
            with self.assertRaises(websuche_client.WebsucheError):
                websuche_client.suche("x")

    def test_non_object_quellen_entries_are_skipped(self):
        payload = {"frage": "x", "quellen": [None, "kaputt",
                   {"domain": "ok.example", "titel": "ok", "text": "text",
                    "abgerufen_am": "2026-08-17"}]}
        with mock.patch.object(websuche_client.urllib.request, "urlopen",
                               return_value=_Resp(payload)):
            out = websuche_client.suche("x")
        self.assertEqual(out["quellen"], [{"domain": "ok.example", "titel": "ok",
                                           "text": "text",
                                           "abgerufen_am": "2026-08-17"}])

    def test_source_without_text_is_skipped(self):
        # Eine Quelle ohne Fliesstext (robots.txt verbietet, Binaerinhalt)
        # traegt nichts zur Antwort bei und wuerde nur Kontext kosten.
        payload = {"frage": "x", "quellen": [
            {"domain": "leer.example", "titel": "leer", "text": "",
             "abgerufen_am": "2026-08-17"},
            {"domain": "ok.example", "titel": "ok", "text": "text",
             "abgerufen_am": "2026-08-17"}]}
        with mock.patch.object(websuche_client.urllib.request, "urlopen",
                               return_value=_Resp(payload)):
            out = websuche_client.suche("x")
        self.assertEqual([q["domain"] for q in out["quellen"]], ["ok.example"])


if __name__ == "__main__":
    unittest.main()
