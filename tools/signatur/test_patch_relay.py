"""Tests fuer patch_relay.py — ohne die echte n8n-Datenbank anzufassen.

patch_relay.py operiert direkt per SQLite-Chirurgie auf der Datenbank
hinter dem einzigen Mailweg (siehe Task-5-Bericht). Diese Tests arbeiten
ausschliesslich auf einem minimalen, selbstgebauten nodes/connections-Paar,
das die fuer baue()/patch_validate_request()/node_code() relevante Struktur
nachbildet — nie auf ~/.n8n/database.sqlite.
"""
import unittest

import patch_relay as p


def _validate_request_jscode() -> str:
    """Minimaler Nachbau des echten "Validate Request"-Codes: genug Kontext,
    damit patch_validate_request() seine Anker findet, ohne die volle
    Validierungslogik (Aussen-Sperre, Attachment-Parsing, Markdown->HTML)
    nachzubauen."""
    return (
        "const from = String(body.from || '').trim().toLowerCase();\n"
        "const to = String(body.to || '').trim();\n"
        "const subject = String(body.subject || '').trim();\n"
        "const text = body.text != null ? String(body.text) : '';\n"
        "let html = body.html != null ? String(body.html) : '';\n"
        "const cc = body.cc != null ? String(body.cc) : '';\n"
        "const inReplyTo = body.inReplyTo != null ? String(body.inReplyTo) : '';\n"
        "const replyTo = body.replyTo != null ? String(body.replyTo) : '';\n"
        "\n"
        "const attachments = [];\n"
        "\n"
        "return [{\n"
        "  json: {\n"
        "    __invalid: false,\n"
        "    agentKey,\n"
        "    from,\n"
        "    to,\n"
        "    subject,\n"
        "    text,\n"
        "    html,\n"
        "    cc,\n"
        "    inReplyTo,\n"
        "    replyTo,\n"
        "    attachments,\n"
        "  }\n"
        "}];\n"
    )


def _fixture_nodes():
    return [
        {"name": "Webhook", "id": "n0", "type": "n8n-nodes-base.webhook",
         "parameters": {}, "position": [0, 0]},
        {"name": "Validate Request", "id": "n1", "type": "n8n-nodes-base.code",
         "parameters": {"jsCode": _validate_request_jscode()}, "position": [200, 0]},
        {"name": "Validation Error?", "id": "n2", "type": "n8n-nodes-base.if",
         "parameters": {}, "position": [400, 0]},
        {"name": "Respond Error", "id": "n3", "type": "n8n-nodes-base.respondToWebhook",
         "parameters": {}, "position": [600, -100]},
        {"name": "Build Binary Attachments", "id": "n4", "type": "n8n-nodes-base.code",
         "parameters": {"jsCode": "// baut binary attachments"}, "position": [600, 100]},
        {"name": "Switch by Sender", "id": "n5", "type": "n8n-nodes-base.switch",
         "parameters": {}, "position": [800, 100]},
    ]


def _fixture_connections():
    return {
        "Webhook": {
            "main": [[{"node": "Validate Request", "type": "main", "index": 0}]]
        },
        "Validate Request": {
            "main": [[{"node": "Validation Error?", "type": "main", "index": 0}]]
        },
        "Validation Error?": {
            "main": [
                [{"node": "Respond Error", "type": "main", "index": 0}],
                [{"node": "Build Binary Attachments", "type": "main", "index": 0}],
            ]
        },
        "Build Binary Attachments": {
            "main": [[{"node": "Switch by Sender", "type": "main", "index": 0}]]
        },
    }


class BaueTest(unittest.TestCase):
    def test_appends_exactly_one_attach_signature_node_and_leaves_others_untouched(self):
        nodes = _fixture_nodes()
        conns = _fixture_connections()
        namen_vorher = [n["name"] for n in nodes]

        neu, _ = p.baue(nodes, conns)

        angehaengt = [n for n in neu if n["name"] == p.NODE_NAME]
        self.assertEqual(len(angehaengt), 1)
        self.assertEqual(len(neu), len(nodes) + 1)
        for name in namen_vorher:
            self.assertIn(name, [n["name"] for n in neu])
        # baue() darf die uebergebene Eingabe nicht mutieren — es kopiert
        # bewusst tief (json.loads(json.dumps(...))), damit ein
        # fehlgeschlagener Bau nie den lebenden Zustand des Aufrufers anfasst.
        self.assertEqual([n["name"] for n in nodes], namen_vorher)

    def test_wiring_validation_error_out1_to_attach_signature_to_build_binary(self):
        nodes = _fixture_nodes()
        conns = _fixture_connections()

        _, verb = p.baue(nodes, conns)

        ausgang0 = verb["Validation Error?"]["main"][0]
        ausgang1 = verb["Validation Error?"]["main"][1]
        self.assertEqual([t["node"] for t in ausgang0], ["Respond Error"])
        self.assertEqual([t["node"] for t in ausgang1], [p.NODE_NAME])
        self.assertEqual(
            [t["node"] for t in verb[p.NODE_NAME]["main"][0]],
            ["Build Binary Attachments"],
        )

    def test_assertion_fires_when_expected_wiring_missing(self):
        nodes = _fixture_nodes()
        conns = _fixture_connections()
        # Simuliert genau den Fall, vor dem die Zusicherung schuetzen soll:
        # der Workflow hat sich unter uns veraendert, Ausgang 1 von
        # "Validation Error?" zeigt schon woanders hin.
        conns["Validation Error?"]["main"][1] = [
            {"node": "Irgendein Anderer Node", "type": "main", "index": 0}
        ]
        with self.assertRaises(AssertionError):
            p.baue(nodes, conns)


class PatchValidateRequestTest(unittest.TestCase):
    def test_adds_signatur_passthrough(self):
        nodes = _fixture_nodes()

        p.patch_validate_request(nodes)

        code = next(
            n for n in nodes if n["name"] == "Validate Request"
        )["parameters"]["jsCode"]
        self.assertEqual(
            code.count(
                "const signatur = body.signatur != null "
                "? String(body.signatur).trim() : '';"
            ),
            1,
        )
        self.assertEqual(code.count("    signatur,\n"), 1)

    def test_second_call_on_patched_result_does_not_silently_duplicate(self):
        nodes = _fixture_nodes()
        p.patch_validate_request(nodes)

        # Ein zweiter Aufruf auf dem bereits gepatchten Code darf die
        # Durchreichung nicht ein zweites Mal einfuegen — das waere ein
        # doppeltes "const signatur" (SyntaxError in n8n: "Identifier
        # 'signatur' has already been declared"). Nach dem ersten Patch
        # matcht der Rueckgabe-Anker nicht mehr exakt (er enthaelt jetzt
        # zusaetzlich "signatur,"), darum bricht der zweite Aufruf mit
        # AssertionError ab statt still zu duplizieren.
        with self.assertRaises(AssertionError):
            p.patch_validate_request(nodes)

        code = next(
            n for n in nodes if n["name"] == "Validate Request"
        )["parameters"]["jsCode"]
        self.assertEqual(code.count("const signatur ="), 1)


class NodeCodeTest(unittest.TestCase):
    def test_strips_module_exports_and_appends_call_frame(self):
        quelltext = (
            "function signiere(json, leseDatei) { return json; }\n"
            "module.exports = { signiere };\n"
        )

        code = p.node_code(quelltext)

        self.assertNotIn("module.exports", code)
        self.assertIn("function signiere(json, leseDatei)", code)
        self.assertTrue(
            code.rstrip().endswith(
                "return $input.all().map((item) => "
                "({ json: signiere(item.json, leseDatei) }));"
            )
        )

    def test_missing_module_exports_marker_raises(self):
        # Der Fall, den Finding 2 beschreibt: aendert relay_signatur.js
        # seinen Exportstil (z.B. ESM statt CommonJS), darf der Zuschnitt
        # nicht stillschweigend den kompletten Text uebernehmen.
        quelltext = "function signiere(json, leseDatei) { return json; }\n"
        with self.assertRaises(AssertionError):
            p.node_code(quelltext)


if __name__ == "__main__":
    unittest.main()
