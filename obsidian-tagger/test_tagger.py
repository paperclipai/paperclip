#!/usr/bin/env python3
"""Tests für den Obsidian-Tagger.

Ausführen:  .venv/bin/python -m unittest test_tagger -v
"""
import io
import json
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

import tagger

TEMPLATE = Path(__file__).resolve().parent / "templates" / "frontmatter-template.yaml"

VALID_META = {
    "title": "Testnotiz",
    "tags": ["KI", "Automatisierung"],
    "typ": "Notiz",
    "zusammenfassung": "Kurze Zusammenfassung.",
}


@contextmanager
def fake_lmstudio(message: dict):
    """Simuliert eine LM-Studio-Antwort mit dem gegebenen message-Objekt."""
    payload = {"choices": [{"finish_reason": "stop", "message": message}]}
    raw = json.dumps(payload).encode("utf-8")

    class _Resp(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            self.close()
            return False

    with mock.patch.object(tagger.urllib.request, "urlopen", return_value=_Resp(raw)):
        yield


class LLMExtractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tpl = tagger.Template.load(TEMPLATE)

    def _extract(self, message: dict) -> dict:
        with fake_lmstudio(message):
            return tagger.llm_extract("Irgendein Text", "notiz.md", self.tpl)

    def test_normales_modell_liefert_content(self):
        meta = self._extract({"content": json.dumps(VALID_META)})
        self.assertEqual(meta["title"], "Testnotiz")

    def test_reasoning_modell_mit_leerem_content(self):
        """qwen3.6 & Co. legen die Antwort in reasoning_content ab, content bleibt leer."""
        meta = self._extract({"content": "", "reasoning_content": json.dumps(VALID_META)})
        self.assertEqual(meta["title"], "Testnotiz")
        self.assertEqual(meta["typ"], "Notiz")

    def test_reasoning_mit_prosa_um_das_json(self):
        reasoning = (
            "Ich schaue mir die Notiz an. Der Typ ist wohl Notiz.\n"
            f"{json.dumps(VALID_META)}\n"
            "Das sollte passen."
        )
        meta = self._extract({"content": None, "reasoning_content": reasoning})
        self.assertEqual(meta["tags"], ["KI", "Automatisierung"])

    def test_content_hat_vorrang_vor_reasoning(self):
        meta = self._extract({
            "content": json.dumps(VALID_META),
            "reasoning_content": json.dumps({**VALID_META, "title": "Falsch"}),
        })
        self.assertEqual(meta["title"], "Testnotiz")

    def test_leere_antwort_meldet_klartext_statt_jsondecodeerror(self):
        with self.assertRaises(tagger.LLMResponseError) as ctx:
            self._extract({"content": "", "reasoning_content": ""})
        msg = str(ctx.exception)
        self.assertIn("leere Antwort", msg)
        self.assertIn(self.tpl.modell, msg)

    def test_fehlerklasse_wird_im_lauf_gefangen(self):
        """main() darf an einer einzelnen kaputten Antwort nicht sterben."""
        self.assertTrue(issubclass(tagger.LLMResponseError, tagger.LLM_ERRORS))


class ExtractJsonObjectTest(unittest.TestCase):
    def test_nimmt_das_erste_vollstaendige_objekt(self):
        text = 'Blabla {"a": 1, "b": {"c": 2}} und noch was {"x": 9}'
        self.assertEqual(json.loads(tagger.extract_json_object(text)), {"a": 1, "b": {"c": 2}})

    def test_klammern_in_strings_zaehlen_nicht(self):
        text = 'Vorspann {"a": "ein } in einem String", "b": 2} Nachspann'
        self.assertEqual(
            json.loads(tagger.extract_json_object(text)),
            {"a": "ein } in einem String", "b": 2},
        )

    def test_ohne_objekt_leerer_string(self):
        self.assertEqual(tagger.extract_json_object("kein json hier"), "")
        self.assertEqual(tagger.extract_json_object(""), "")

    def test_unvollstaendiges_objekt_leerer_string(self):
        self.assertEqual(tagger.extract_json_object('{"a": 1'), "")


if __name__ == "__main__":
    unittest.main()
