"""Tests fuer patch_relay.py — ohne die echte n8n-Datenbank anzufassen.

patch_relay.py operiert direkt per SQLite-Chirurgie auf der Datenbank
hinter dem einzigen Mailweg (siehe Task-5-Bericht). Diese Tests arbeiten
ausschliesslich auf minimalen, selbstgebauten nodes/connections-Paaren,
die die fuer die jeweilige Funktion relevante Struktur nachbilden — nie
auf ~/.n8n/database.sqlite.

Zwei Fixture-Generationen:
  - _fixture_nodes()/_fixture_connections(): V16-Zustand (vor der
    Signatur-Integration), fuer fuege_signatur_knoten_ein() und
    patch_validate_request() — die V16->V17-Migration.
  - _v17_fixture_nodes()/_v17_fixture_connections(): V17-Zustand (Attach
    Signature + Build Log Line bereits vorhanden), fuer
    patch_build_log_line(), patch_attach_signature_onerror() und baue() —
    die aktuelle V17->V18-Migration.
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


def _build_log_line_jscode() -> str:
    """Wortgetreuer Nachbau des echten "Build Log Line"-Codes (verifiziert
    gegen die Live-DB am 2026-08-10) — nur so matchen die Anker in
    patch_build_log_line() exakt wie gegen die echte Version."""
    return (
        "// Webhook-Felder aus Validate Request (vor SMTP Send, sonst "
        "überschrieben)\n"
        "const req = $('Validate Request').first().json;\n"
        "// SMTP-Response aus aktuellem Item\n"
        "const smtp = $input.first().json;\n"
        "\n"
        "const now = new Date();\n"
        "const pad = (n) => String(n).padStart(2, '0');\n"
        "const ts = `${now.getFullYear()}-${pad(now.getMonth()+1)}-"
        "${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:"
        "${pad(now.getSeconds())}`;\n"
        "\n"
        "const from = String(req.from || '?');\n"
        "const to = String(req.to || '?');\n"
        "const cc = String(req.cc || '').trim();\n"
        "const subject = String(req.subject || '(ohne Betreff)')"
        ".replace(/[\\r\\n]+/g, ' ').slice(0, 200);\n"
        "const messageId = String(smtp.messageId || "
        "(smtp.envelope && smtp.envelope.messageId) || '');\n"
        "const ccPart = cc ? ` (cc: \\`${cc}\\`)` : '';\n"
        "\n"
        "const line = `- **${ts}** \\`${from}\\` → \\`${to}\\`${ccPart} · "
        "*${subject}* · msgId \\`${messageId}\\`\\n`;\n"
        "\n"
        "return [{\n"
        "  json: { ...smtp, logLine: line },\n"
        "  binary: {\n"
        "    data: {\n"
        "      data: Buffer.from(line, 'utf8').toString('base64'),\n"
        "      mimeType: 'text/markdown; charset=utf-8',\n"
        "      fileExtension: 'md',\n"
        "      fileName: 'Mailhub-Outbound-Log.md',\n"
        "    },\n"
        "  },\n"
        "}];\n"
    )


def _v17_fixture_nodes():
    """V17-Zustand: Validate Request hat bereits die signatur-Durchreichung
    (V16->V17-Patch), und es gibt bereits Attach Signature (zwischen
    Validation Error? und Build Binary Attachments) und Build Log Line —
    der Ausgangspunkt fuer den V17->V18-Bau."""
    nodes = _fixture_nodes()
    p.patch_validate_request(nodes)
    nodes.append({
        "name": p.NODE_NAME, "id": "n6", "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "parameters": {"jsCode": "function signiere(json, leseDatei) { "
                                  "try { return json; } catch (err) { "
                                  "json.__signaturFehler = String(err); "
                                  "return json; } }\n"
                                  "return $input.all().map((item) => "
                                  "({ json: signiere(item.json, leseDatei) }));"},
        "position": [420, 220],
    })
    nodes.append({
        "name": p.BUILD_LOG_LINE_KNOTEN, "id": "n7", "type": "n8n-nodes-base.code",
        "parameters": {"jsCode": _build_log_line_jscode()}, "position": [900, 100],
    })
    return nodes


def _v17_fixture_connections():
    conns = _fixture_connections()
    conns["Validation Error?"]["main"][1] = [
        {"node": p.NODE_NAME, "type": "main", "index": 0}
    ]
    conns[p.NODE_NAME] = {
        "main": [[{"node": "Build Binary Attachments", "type": "main", "index": 0}]]
    }
    conns["Switch by Sender"] = {
        "main": [[{"node": p.BUILD_LOG_LINE_KNOTEN, "type": "main", "index": 0}]]
    }
    return conns


class FuegeSignaturKnotenEinTest(unittest.TestCase):
    """V16->V17-Migration (historisch) — dokumentiert, wie V17 entstand."""

    def test_appends_exactly_one_attach_signature_node_and_leaves_others_untouched(self):
        nodes = _fixture_nodes()
        conns = _fixture_connections()
        namen_vorher = [n["name"] for n in nodes]

        neu, _ = p.fuege_signatur_knoten_ein(nodes, conns)

        angehaengt = [n for n in neu if n["name"] == p.NODE_NAME]
        self.assertEqual(len(angehaengt), 1)
        self.assertEqual(len(neu), len(nodes) + 1)
        for name in namen_vorher:
            self.assertIn(name, [n["name"] for n in neu])
        # fuege_signatur_knoten_ein() darf die uebergebene Eingabe nicht
        # mutieren — es kopiert bewusst tief (json.loads(json.dumps(...))),
        # damit ein fehlgeschlagener Bau nie den lebenden Zustand des
        # Aufrufers anfasst.
        self.assertEqual([n["name"] for n in nodes], namen_vorher)

    def test_wiring_validation_error_out1_to_attach_signature_to_build_binary(self):
        nodes = _fixture_nodes()
        conns = _fixture_connections()

        _, verb = p.fuege_signatur_knoten_ein(nodes, conns)

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
            p.fuege_signatur_knoten_ein(nodes, conns)


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


class PatchBuildLogLineTest(unittest.TestCase):
    """Finding A: __signaturFehler muss im Log sichtbar werden."""

    def test_inserts_sigfehler_handling_and_reads_from_attach_signature_node(self):
        nodes = _v17_fixture_nodes()

        p.patch_build_log_line(nodes)

        code = next(
            n for n in nodes if n["name"] == p.BUILD_LOG_LINE_KNOTEN
        )["parameters"]["jsCode"]
        self.assertEqual(code.count("const sigFehler ="), 1)
        self.assertEqual(code.count("const sigPart ="), 1)
        # Liest vom Attach-Signature-Node, nicht von Validate Request.
        self.assertIn("$('%s').first().json.__signaturFehler" % p.NODE_NAME, code)
        # Die Logzeile haengt ${sigPart} an — bleibt bei leerem Fehler leer.
        self.assertIn("${messageId}\\`${sigPart}\\n`;", code)

    def test_normal_case_format_is_byte_identical_when_no_error(self):
        """Wenn __signaturFehler fehlt, muss die resultierende Zeile exakt
        wie heute aussehen — sigPart wird dann zu ''. Das ist eine
        String-Konstruktions-Pruefung des gepatchten JS-Codes (kein Node-
        Interpreter involviert): wir simulieren die Template-Auswertung mit
        leerem sigPart und vergleichen gegen die alte, ungepatchte Zeile."""
        nodes = _v17_fixture_nodes()
        alte_zeile_vorlage = p.BUILD_LOG_LINE_ZEILE_ANKER

        p.patch_build_log_line(nodes)

        code = next(
            n for n in nodes if n["name"] == p.BUILD_LOG_LINE_KNOTEN
        )["parameters"]["jsCode"]
        neue_zeile_vorlage = p.BUILD_LOG_LINE_ZEILE_NEU
        # Mit sigPart == '' (Normalfall) ist die neue Vorlage byte-identisch
        # zur alten, wenn man "${sigPart}" durch '' ersetzt.
        self.assertEqual(
            neue_zeile_vorlage.replace("${sigPart}", ""), alte_zeile_vorlage
        )
        self.assertIn(neue_zeile_vorlage, code)

    def test_second_application_raises_instead_of_duplicating(self):
        nodes = _v17_fixture_nodes()
        p.patch_build_log_line(nodes)

        with self.assertRaises(AssertionError):
            p.patch_build_log_line(nodes)

        code = next(
            n for n in nodes if n["name"] == p.BUILD_LOG_LINE_KNOTEN
        )["parameters"]["jsCode"]
        self.assertEqual(code.count("const sigFehler ="), 1)

    def test_assertion_fires_when_anchor_missing(self):
        nodes = _v17_fixture_nodes()
        knoten = next(n for n in nodes if n["name"] == p.BUILD_LOG_LINE_KNOTEN)
        # Simuliert: der Node hat sich unter uns geaendert, die
        # line-Zuweisung sieht nicht mehr so aus wie erwartet.
        knoten["parameters"]["jsCode"] = knoten["parameters"]["jsCode"].replace(
            "msgId \\`${messageId}\\`\\n`;", "msgId \\`${messageId}\\`!\\n`;"
        )
        with self.assertRaises(AssertionError):
            p.patch_build_log_line(nodes)


class PatchAttachSignatureOnErrorTest(unittest.TestCase):
    """Finding B: der n8n-Aufrufrahmen muss fail-open sein."""

    def test_sets_continue_regular_output(self):
        nodes = _v17_fixture_nodes()
        knoten = next(n for n in nodes if n["name"] == p.NODE_NAME)
        self.assertNotIn("onError", knoten)

        p.patch_attach_signature_onerror(nodes)

        knoten = next(n for n in nodes if n["name"] == p.NODE_NAME)
        self.assertEqual(knoten["onError"], "continueRegularOutput")

    def test_second_application_raises(self):
        nodes = _v17_fixture_nodes()
        p.patch_attach_signature_onerror(nodes)
        with self.assertRaises(AssertionError):
            p.patch_attach_signature_onerror(nodes)


class PatchValidateRequestBereichTest(unittest.TestCase):
    """Beim Testen von Finding A gefunden: bereich kam nie bei signiere()
    an, weil Validate Request es verwarf — dadurch war die im
    Abnahmeprotokoll geforderte, auf "de" begrenzte Fehlerprobe nicht
    isoliert moeglich (bereich fiel immer auf "ai" zurueck)."""

    def test_adds_bereich_passthrough(self):
        nodes = _v17_fixture_nodes()

        p.patch_validate_request_bereich(nodes)

        code = next(
            n for n in nodes if n["name"] == "Validate Request"
        )["parameters"]["jsCode"]
        self.assertEqual(
            code.count(
                "const bereich = body.bereich != null "
                "? String(body.bereich).trim().toLowerCase() : '';"
            ),
            1,
        )
        self.assertEqual(code.count("    bereich,\n"), 1)
        # signatur-Durchreichung bleibt erhalten, nicht verdraengt.
        self.assertEqual(code.count("const signatur ="), 1)
        self.assertEqual(code.count("    signatur,\n"), 1)

    def test_requires_signatur_passthrough_already_applied(self):
        # Baue-Reihenfolge: patch_validate_request_bereich() setzt auf dem
        # V16->V17-signatur-Patch auf. Auf einem Node ohne diesen Patch
        # fehlt der Anker, der Aufruf bricht mit AssertionError ab statt
        # etwas Falsches einzufuegen.
        nodes = _fixture_nodes()  # V16-Zustand, KEIN signatur-Patch
        with self.assertRaises(AssertionError):
            p.patch_validate_request_bereich(nodes)

    def test_second_application_raises_instead_of_duplicating(self):
        nodes = _v17_fixture_nodes()
        p.patch_validate_request_bereich(nodes)

        with self.assertRaises(AssertionError):
            p.patch_validate_request_bereich(nodes)

        code = next(
            n for n in nodes if n["name"] == "Validate Request"
        )["parameters"]["jsCode"]
        self.assertEqual(code.count("const bereich ="), 1)


class BaueTest(unittest.TestCase):
    """Der aktuelle Standardlauf: V17 -> V18 (Finding A + Finding B +
    bereich-Durchreichung)."""

    def test_applies_both_findings_and_leaves_node_count_and_wiring_unchanged(self):
        nodes = _v17_fixture_nodes()
        conns = _v17_fixture_connections()
        namen_vorher = [n["name"] for n in nodes]

        neu, verb = p.baue(nodes, conns)

        self.assertEqual(len(neu), len(nodes))
        self.assertEqual([n["name"] for n in neu], namen_vorher)
        self.assertEqual(verb, conns)  # baue() aendert fuer V18 keine Verdrahtung

        log_code = next(
            n for n in neu if n["name"] == p.BUILD_LOG_LINE_KNOTEN
        )["parameters"]["jsCode"]
        self.assertIn("const sigFehler =", log_code)

        sig_knoten = next(n for n in neu if n["name"] == p.NODE_NAME)
        self.assertEqual(sig_knoten["onError"], "continueRegularOutput")

        vr_code = next(
            n for n in neu if n["name"] == "Validate Request"
        )["parameters"]["jsCode"]
        self.assertIn("const bereich =", vr_code)
        self.assertIn("    bereich,\n", vr_code)

    def test_does_not_mutate_input(self):
        nodes = _v17_fixture_nodes()
        conns = _v17_fixture_connections()
        nodes_vorher = [dict(n) for n in nodes]

        p.baue(nodes, conns)

        self.assertNotIn("onError", next(n for n in nodes if n["name"] == p.NODE_NAME))
        self.assertEqual(len(nodes), len(nodes_vorher))


class ArgParserTest(unittest.TestCase):
    """Finding C: Quelle/Ziel-ID/-Name sind Parameter, keine Konstanten."""

    def test_defaults_point_at_v17_to_v18(self):
        args = p.build_arg_parser().parse_args(["--dry-run"])
        self.assertEqual(args.source_id, p.STANDARD_QUELL_ID)
        self.assertEqual(args.new_id, p.STANDARD_NEUE_ID)
        self.assertEqual(args.new_name, p.STANDARD_NEUER_NAME)

    def test_explicit_arguments_override_defaults(self):
        args = p.build_arg_parser().parse_args([
            "--apply",
            "--source-id", "irgendeineId",
            "--new-id", "nochEineId",
            "--new-name", "Irgendein Name",
        ])
        self.assertEqual(args.source_id, "irgendeineId")
        self.assertEqual(args.new_id, "nochEineId")
        self.assertEqual(args.new_name, "Irgendein Name")
        self.assertTrue(args.apply)
        self.assertFalse(args.dry_run)


if __name__ == "__main__":
    unittest.main()
