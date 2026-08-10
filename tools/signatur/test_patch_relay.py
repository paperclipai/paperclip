"""Tests fuer patch_relay.py — ohne die echte n8n-Datenbank anzufassen.

patch_relay.py operiert direkt per SQLite-Chirurgie auf der Datenbank
hinter dem einzigen Mailweg (siehe Task-5-Bericht). Diese Tests arbeiten
ausschliesslich auf minimalen, selbstgebauten nodes/connections-Paaren,
die die fuer die jeweilige Funktion relevante Struktur nachbilden — nie
auf ~/.n8n/database.sqlite.

Drei Fixture-Generationen:
  - _fixture_nodes()/_fixture_connections(): V16-Zustand (vor der
    Signatur-Integration), fuer fuege_signatur_knoten_ein() und
    patch_validate_request() — die V16->V17-Migration.
  - _v17_fixture_nodes()/_v17_fixture_connections(): V17-Zustand (Attach
    Signature + Build Log Line bereits vorhanden), fuer
    patch_build_log_line(), patch_attach_signature_onerror(),
    patch_validate_request_bereich() — die V17->V18-Migration.
  - _v18_fixture_nodes()/_v18_fixture_connections(): V18-Zustand (bereich-
    Durchreichung, sigFehler-Logzeile, onError=continueRegularOutput bereits
    angewendet), fuer patch_attach_signature_code(),
    patch_build_log_line_status_marker() und baue() — die aktuelle
    V18->V19-Migration.
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


def _v18_fixture_nodes():
    """V18-Zustand: baut auf dem V17-Fixture auf und wendet die drei
    V17->V18-Patches an (bereich-Durchreichung, sigFehler-Logzeile,
    onError=continueRegularOutput) — der Ausgangspunkt fuer den aktuellen
    V18->V19-Bau. Die 'Attach Signature'-jsCode bleibt dabei der minimale
    Stub aus _v17_fixture_nodes() (kein Nachbau des echten
    relay_signatur.js-Textes): patch_attach_signature_code() ersetzt sie
    ohnehin komplett durch den echten, aktuellen Dateiinhalt und prueft nur,
    dass sich dadurch ueberhaupt etwas aendert — der Stub reicht dafuer."""
    nodes = _v17_fixture_nodes()
    p.patch_validate_request_bereich(nodes)
    p.patch_build_log_line(nodes)
    p.patch_attach_signature_onerror(nodes)
    return nodes


def _v18_fixture_connections():
    return _v17_fixture_connections()


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


class PatchAttachSignatureCodeTest(unittest.TestCase):
    """V18->V19: 'Attach Signature' bekommt den aktuellen relay_signatur.js-
    Stand (__signaturStatus-Marker) neu eingebettet."""

    def test_replaces_jscode_with_current_relay_signatur_js_and_keeps_onerror(self):
        nodes = _v18_fixture_nodes()
        knoten = next(n for n in nodes if n["name"] == p.NODE_NAME)
        alter_code = knoten["parameters"]["jsCode"]

        p.patch_attach_signature_code(nodes)

        knoten = next(n for n in nodes if n["name"] == p.NODE_NAME)
        self.assertNotEqual(knoten["parameters"]["jsCode"], alter_code)
        self.assertIn("__signaturStatus", knoten["parameters"]["jsCode"])
        self.assertIn("function signiere(json, leseDatei)", knoten["parameters"]["jsCode"])
        # Node-Attribute ausserhalb von parameters.jsCode bleiben unberuehrt.
        self.assertEqual(knoten["onError"], "continueRegularOutput")

    def test_second_application_on_already_current_code_raises(self):
        nodes = _v18_fixture_nodes()
        p.patch_attach_signature_code(nodes)

        with self.assertRaises(AssertionError):
            p.patch_attach_signature_code(nodes)


class PatchBuildLogLineStatusMarkerTest(unittest.TestCase):
    """V18->V19: dritter Zweig in 'Build Log Line' fuer fehlenden
    __signaturStatus (Aufrufrahmen-Abbruch)."""

    def test_inserts_sigstatus_branch_on_top_of_v18_sigfehler_branch(self):
        nodes = _v18_fixture_nodes()

        p.patch_build_log_line_status_marker(nodes)

        code = next(
            n for n in nodes if n["name"] == p.BUILD_LOG_LINE_KNOTEN
        )["parameters"]["jsCode"]
        self.assertEqual(code.count("const sigStatus ="), 1)
        self.assertEqual(code.count("const sigFehler ="), 1)
        self.assertIn("SIGNATUR-MARKER FEHLT", code)
        # Das bestehende Fehlersegment (V18) bleibt inhaltlich erhalten.
        self.assertIn("SIGNATUR FEHLGESCHLAGEN", code)
        self.assertIn("${messageId}\\`${sigPart}\\n`;", code)

    def test_normal_case_format_is_byte_identical_when_status_signiert_and_no_error(self):
        """sigStatus gesetzt (nicht undefined) und sigFehler leer -> sigPart
        bleibt ''. Das ist eine String-Konstruktions-Pruefung (kein Node-
        Interpreter involviert), analog zum V18-Test fuer patch_build_log_line."""
        nodes = _v18_fixture_nodes()
        alte_zeile_vorlage = p.BUILD_LOG_LINE_ZEILE_ANKER

        p.patch_build_log_line_status_marker(nodes)

        neue_zeile_vorlage = p.BUILD_LOG_LINE_ZEILE_NEU
        self.assertEqual(
            neue_zeile_vorlage.replace("${sigPart}", ""), alte_zeile_vorlage
        )

    def test_second_application_raises_instead_of_duplicating(self):
        nodes = _v18_fixture_nodes()
        p.patch_build_log_line_status_marker(nodes)

        with self.assertRaises(AssertionError):
            p.patch_build_log_line_status_marker(nodes)

        code = next(
            n for n in nodes if n["name"] == p.BUILD_LOG_LINE_KNOTEN
        )["parameters"]["jsCode"]
        self.assertEqual(code.count("const sigStatus ="), 1)

    def test_assertion_fires_when_v18_branch_missing(self):
        # Simuliert: der V18-Patch (patch_build_log_line) wurde nie
        # angewendet, der Anker fuer diesen Patch existiert also nicht.
        nodes = _v17_fixture_nodes()  # V17-Zustand, KEIN sigFehler-Zweig
        with self.assertRaises(AssertionError):
            p.patch_build_log_line_status_marker(nodes)


class BaueTest(unittest.TestCase):
    """Der aktuelle Standardlauf: V18 -> V19 (Attach-Signature-Code
    aktualisieren + Marker-Fehlen-Zweig in Build Log Line)."""

    def test_applies_both_patches_and_leaves_node_count_and_wiring_unchanged(self):
        nodes = _v18_fixture_nodes()
        conns = _v18_fixture_connections()
        namen_vorher = [n["name"] for n in nodes]

        neu, verb = p.baue(nodes, conns)

        self.assertEqual(len(neu), len(nodes))
        self.assertEqual([n["name"] for n in neu], namen_vorher)
        self.assertEqual(verb, conns)  # baue() aendert fuer V19 keine Verdrahtung

        sig_knoten = next(n for n in neu if n["name"] == p.NODE_NAME)
        self.assertIn("__signaturStatus", sig_knoten["parameters"]["jsCode"])
        # onError aus V18 bleibt erhalten, wird von diesem Patch nicht angefasst.
        self.assertEqual(sig_knoten["onError"], "continueRegularOutput")

        log_code = next(
            n for n in neu if n["name"] == p.BUILD_LOG_LINE_KNOTEN
        )["parameters"]["jsCode"]
        self.assertIn("const sigStatus =", log_code)
        self.assertIn("SIGNATUR-MARKER FEHLT", log_code)

    def test_does_not_mutate_input(self):
        nodes = _v18_fixture_nodes()
        conns = _v18_fixture_connections()
        vorher_code = next(
            n for n in nodes if n["name"] == p.NODE_NAME
        )["parameters"]["jsCode"]
        log_vorher_code = next(
            n for n in nodes if n["name"] == p.BUILD_LOG_LINE_KNOTEN
        )["parameters"]["jsCode"]

        p.baue(nodes, conns)

        self.assertEqual(
            next(n for n in nodes if n["name"] == p.NODE_NAME)["parameters"]["jsCode"],
            vorher_code,
        )
        self.assertEqual(
            next(
                n for n in nodes if n["name"] == p.BUILD_LOG_LINE_KNOTEN
            )["parameters"]["jsCode"],
            log_vorher_code,
        )


class ArgParserTest(unittest.TestCase):
    """Finding C: Quelle/Ziel-ID/-Name sind Parameter, keine Konstanten."""

    def test_defaults_point_at_v18_to_v19(self):
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
