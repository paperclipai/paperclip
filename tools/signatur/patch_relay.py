#!/usr/bin/env python3
"""Klont den SMTP-Relay auf eine neue Version und patcht sie.

Quelle/Ziel-ID/-Name sind Parameter (CLI-Argumente mit Standardwerten fuer
den jeweils naechsten Schritt) — das Werkzeug ist kein Einmal-Skript fuer
V16->V17 mehr, sondern klont die jeweils AKTIVE Version auf die naechste und
wendet dabei den aktuell noch ausstehenden Patch an. Welcher Patch das ist,
aendert sich mit jeder Version (siehe baue() unten); die V16->V17-spezifische
Signatur-Knoten-Einfuegung von damals steht als eigene Funktion
fuege_signatur_knoten_ein() weiterhin im Code, wird aber vom aktuellen
Standardlauf nicht mehr aufgerufen, weil V17 sie bereits enthaelt — sie
gegen V17 laufen zu lassen, wuerde sofort mit AssertionError abbrechen
(die Anker sind nach dem ersten Patch nicht mehr im Ausgangszustand).

Nutzung:
    python3 patch_relay.py --dry-run   # zeigt nur, was passieren wuerde
    python3 patch_relay.py --apply     # legt die neue Version an (noch nicht aktiv)

    # gegen eine andere Quelle/Ziel-Kombination, z.B. um denselben Weg noch
    # einmal fuer V19 zu gehen:
    python3 patch_relay.py --apply \
        --source-id SMTPRelayV18LogGuard --new-id SMTPRelayV19xxx \
        --new-name "SMTP Relay V19 — xxx"
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import uuid

HIER = os.path.dirname(os.path.abspath(__file__))
DB = os.path.expanduser("~/.n8n/database.sqlite")

# Standardwerte fuer den naechsten Schritt: V17 (aktiv) -> V18. Wer eine
# andere Quelle/Ziel-Kombination braucht, uebergibt --source-id/--new-id/
# --new-name explizit — siehe Docstring oben.
STANDARD_QUELL_ID = "SMTPRelayV17Signat"
STANDARD_NEUE_ID = "SMTPRelayV18LogGuard"
STANDARD_NEUER_NAME = "SMTP Relay V18 — Log & Fail-Open"

# V16-ID nur noch als Kommentar/Referenz: fuege_signatur_knoten_ein() unten
# wurde gegen diese ID gebaut (siehe Git-Historie fuer den V17-Lauf).
V16_ID = "BXHc5kdNdZQNiuMr"

NODE_NAME = "Attach Signature"
BUILD_LOG_LINE_KNOTEN = "Build Log Line"

RAHMEN = """
// --- n8n-Aufrufrahmen (angehaengt von patch_relay.py) --------------------
const fsModul = require('fs');
const leseDatei = (p) => fsModul.readFileSync(p, 'utf8');
return $input.all().map((item) => ({ json: signiere(item.json, leseDatei) }));
"""


def node_code(quelltext: str | None = None) -> str:
    """relay_signatur.js ohne CommonJS-Export, dafuer mit n8n-Aufrufrahmen.

    quelltext dient nur dem Test — im Normalbetrieb wird relay_signatur.js
    von der Platte gelesen. Wird nur noch von
    fuege_signatur_knoten_ein() gebraucht (V16->V17-Migration).
    """
    if quelltext is None:
        with open(os.path.join(HIER, "relay_signatur.js"), encoding="utf-8") as fh:
            quelltext = fh.read()
    marker = "module.exports"
    # str.partition() liefert bei fehlendem Marker STILLSCHWEIGEND den
    # ganzen Text zurueck (kopf == quelltext, rest == ''). Aendert sich der
    # Exportstil in relay_signatur.js spaeter (z.B. ESM statt CommonJS),
    # landete ohne diese Zusicherung ein "module.exports" im Code-Node —
    # "module" existiert in n8n nicht, die Ausfuehrung bricht mit
    # ReferenceError ab, und weil kein Code-Node continueOnFail gesetzt
    # hat, reisst das den kompletten Mailweg samt Waechter-Alarmen mit.
    assert marker in quelltext, (
        "relay_signatur.js hat kein module.exports mehr — der Zuschnitt fuer "
        "den n8n-Node wuerde stillschweigend den ganzen Text uebernehmen.")
    # Der Export erstreckt sich ueber zwei Zeilen — beide raus.
    kopf, _, _rest = quelltext.partition(marker)
    return kopf.rstrip() + "\n" + RAHMEN


# "Validate Request" baut sein Ausgabe-json als Allowlist neu auf und
# reicht dabei NICHT jedes Eingabefeld durch. body.signatur ("none" fuer
# Lunas eigene Vorschau, siehe approval_send.py) fehlt in dieser Liste —
# ohne Patch kommt es nie bei signiere() an, das Feld auf "none" zu setzen
# waere dann wirkungslos und Lunas Mails bekaemen eine zweite Signatur.
# Gefunden beim Testen von Schritt 10 (Lunas Weg), nicht in der Spec.
# Nur noch von fuege_signatur_knoten_ein() gebraucht (V16->V17-Migration).
VALIDATE_REQUEST_ANKER = "const replyTo = body.replyTo != null ? String(body.replyTo) : '';"
VALIDATE_REQUEST_NEUE_ZEILE = (
    VALIDATE_REQUEST_ANKER
    + "\nconst signatur = body.signatur != null ? String(body.signatur).trim() : '';"
)
VALIDATE_REQUEST_RUECKGABE_ANKER = (
    "return [{\n  json: {\n    __invalid: false,\n    agentKey,\n    from,\n"
    "    to,\n    subject,\n    text,\n    html,\n    cc,\n    inReplyTo,\n"
    "    replyTo,\n    attachments,\n  }\n}];"
)
VALIDATE_REQUEST_RUECKGABE_NEU = VALIDATE_REQUEST_RUECKGABE_ANKER.replace(
    "    replyTo,\n    attachments,\n",
    "    replyTo,\n    attachments,\n    signatur,\n",
)


def patch_validate_request(nodes):
    """Reicht body.signatur durch Validate Request hindurch (siehe oben).

    V16->V17-Migration, gegen V17 (Quelle des jetzigen V18-Baus) bereits
    angewendet — ein zweiter Lauf faellt absichtlich mit AssertionError auf.
    """
    knoten = next(n for n in nodes if n["name"] == "Validate Request")
    code = knoten["parameters"]["jsCode"]
    assert code.count(VALIDATE_REQUEST_ANKER) == 1, \
        "Validate Request: replyTo-Zeile nicht gefunden — Node hat sich geaendert"
    assert code.count(VALIDATE_REQUEST_RUECKGABE_ANKER) == 1, \
        "Validate Request: Rueckgabe-Objekt nicht wie erwartet — Node hat sich geaendert"
    code = code.replace(VALIDATE_REQUEST_ANKER, VALIDATE_REQUEST_NEUE_ZEILE, 1)
    code = code.replace(
        VALIDATE_REQUEST_RUECKGABE_ANKER, VALIDATE_REQUEST_RUECKGABE_NEU, 1
    )
    knoten["parameters"]["jsCode"] = code


def fuege_signatur_knoten_ein(nodes, connections):
    """V16->V17-Migration: haengt den Signatur-Code-Node ein.

    Historische Funktion — hat V17 aus V16 gebaut (siehe Git-Historie und
    README.md). Bleibt hier stehen, weil sie dokumentiert, wie V17 entstand,
    und weil ihre Tests die Anker-Zusicherungen ueben. Wird vom aktuellen
    Standardlauf (baue(), s.u.) NICHT mehr aufgerufen: V17 hat den Node und
    die Validate-Request-Durchreichung bereits, ein erneuter Lauf gegen V17
    wuerde in patch_validate_request() sofort mit AssertionError abbrechen.
    """
    neu = json.loads(json.dumps(nodes))
    verb = json.loads(json.dumps(connections))

    patch_validate_request(neu)

    # Position: leicht versetzt neben Build Binary Attachments.
    ziel_pos = [0, 0]
    for n in neu:
        if n["name"] == "Build Binary Attachments":
            ziel_pos = [n["position"][0] - 180, n["position"][1] - 120]

    neu.append({
        "parameters": {"jsCode": node_code()},
        "id": str(uuid.uuid4()),
        "name": NODE_NAME,
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": ziel_pos,
    })

    # Validation Error? Ausgang 1 zeigt kuenftig auf den Signatur-Node,
    # der Signatur-Node auf Build Binary Attachments.
    zweig = verb["Validation Error?"]["main"][1]
    assert any(t["node"] == "Build Binary Attachments" for t in zweig), \
        "Erwartete Verdrahtung nicht gefunden — Workflow hat sich geaendert"
    verb["Validation Error?"]["main"][1] = [
        {"node": NODE_NAME, "type": "main", "index": 0}
    ]
    verb[NODE_NAME] = {
        "main": [[{"node": "Build Binary Attachments", "type": "main", "index": 0}]]
    }
    return neu, verb


# --- V17->V18: bereich-Durchreichung — beim Testen von Finding A gefunden,
# nicht in der Spec (derselbe Fund-Modus wie bei body.signatur oben).
#
# Validate Request baut sein Ausgabeobjekt weiterhin als Allowlist. Sie
# enthaelt "signatur" (V17-Patch), aber nie "bereich" — relay_signatur.js
# liest json.bereich, das kommt aber nie an, weil Validate Request es beim
# Neuaufbau des Objekts verwirft. Folge: bereich faellt IMMER auf
# VORGABE_BEREICH="ai" zurueck, unabhaengig davon, was der Aufrufer schickt.
# Kein Aufrufer im Repo setzt heute "bereich" (gruft) — der Fehler ist damit
# folgenlos fuer den echten Betrieb, aber er verhindert genau die im
# V18-Abnahmeprotokoll geforderte gezielte, auf den bereich "de" begrenzte
# Fehlerprobe: ohne diesen Patch waere die einzige Datei, die sich ueber den
# Webhook je erreichen laesst, bereich-ai.html — die meistgenutzte, nicht
# die am wenigsten genutzte. Ohne Durchreichung liesse sich die geforderte
# Probe nur mit unverhaeltnismaessig groesserem Blastradius durchfuehren.
VALIDATE_REQUEST_SIGNATUR_ANKER = (
    "const signatur = body.signatur != null ? String(body.signatur).trim() : '';"
)
VALIDATE_REQUEST_BEREICH_NEUE_ZEILE = (
    VALIDATE_REQUEST_SIGNATUR_ANKER
    + "\nconst bereich = body.bereich != null "
    "? String(body.bereich).trim().toLowerCase() : '';"
)
VALIDATE_REQUEST_RUECKGABE_MIT_BEREICH_NEU = VALIDATE_REQUEST_RUECKGABE_NEU.replace(
    "    signatur,\n", "    signatur,\n    bereich,\n"
)


def patch_validate_request_bereich(nodes):
    """Reicht body.bereich durch Validate Request hindurch (siehe oben).

    Setzt auf dem V17-Zustand auf (nach patch_validate_request(), also mit
    bereits vorhandenem "signatur"-Durchgriff) — genau der Zustand, den
    diese Datei aus der Live-DB klont. Zweiter Aufruf faellt mit
    AssertionError auf, weil VALIDATE_REQUEST_RUECKGABE_NEU nach dem ersten
    Patch nicht mehr exakt matcht (es steht dann schon "bereich," drin).
    """
    knoten = next(n for n in nodes if n["name"] == "Validate Request")
    code = knoten["parameters"]["jsCode"]
    assert code.count(VALIDATE_REQUEST_SIGNATUR_ANKER) == 1, (
        "Validate Request: signatur-Zeile nicht gefunden — Node hat sich "
        "geaendert oder patch_validate_request() wurde noch nicht angewendet"
    )
    assert code.count(VALIDATE_REQUEST_RUECKGABE_NEU) == 1, (
        "Validate Request: Rueckgabe-Objekt (mit signatur, ohne bereich) "
        "nicht wie erwartet gefunden — Node hat sich geaendert, oder der "
        "Patch wurde schon angewendet"
    )
    code = code.replace(VALIDATE_REQUEST_SIGNATUR_ANKER, VALIDATE_REQUEST_BEREICH_NEUE_ZEILE, 1)
    code = code.replace(
        VALIDATE_REQUEST_RUECKGABE_NEU, VALIDATE_REQUEST_RUECKGABE_MIT_BEREICH_NEU, 1
    )
    knoten["parameters"]["jsCode"] = code


# --- V17->V18: Finding A — Signaturfehler war komplett unsichtbar --------
#
# relay_signatur.js setzt json.__signaturFehler bei jeder Ausnahme, aber
# "Build Log Line" liest $('Validate Request').first().json — den Zustand
# VOR dem Signatur-Node. Das Feld kann von dort aus prinzipiell nie
# ankommen. Patch: die Log-Zeile liest __signaturFehler stattdessen vom
# "Attach Signature"-Node und haengt im Fehlerfall ein klar markiertes
# Segment an dieselbe Zeile an. Bleibt das Feld leer (Normalfall), bleibt
# die Zeile byte-identisch zu heute.
BUILD_LOG_LINE_CCPART_ANKER = "const ccPart = cc ? ` (cc: \\`${cc}\\`)` : '';\n"
BUILD_LOG_LINE_SIGFEHLER_EINFUEGUNG = (
    BUILD_LOG_LINE_CCPART_ANKER
    + "const sigFehler = (() => {\n"
    "  try { return $('" + NODE_NAME + "').first().json.__signaturFehler || ''; }\n"
    "  catch (e) { return ''; }\n"
    "})();\n"
    "const sigPart = sigFehler\n"
    "  ? ` · ⚠️ SIGNATUR FEHLGESCHLAGEN: "
    "${String(sigFehler).replace(/[\\r\\n]+/g, ' ').slice(0, 200)}`\n"
    "  : '';\n"
)

BUILD_LOG_LINE_ZEILE_ANKER = (
    "const line = `- **${ts}** \\`${from}\\` → \\`${to}\\`${ccPart} · "
    "*${subject}* · msgId \\`${messageId}\\`\\n`;"
)
BUILD_LOG_LINE_ZEILE_NEU = BUILD_LOG_LINE_ZEILE_ANKER.replace(
    "${messageId}\\`\\n`;",
    "${messageId}\\`${sigPart}\\n`;",
)


def patch_build_log_line(nodes):
    """Finding A: __signaturFehler im Log sichtbar machen (siehe oben).

    Zweiter Aufruf auf bereits gepatchtem Code bricht mit AssertionError ab
    (BUILD_LOG_LINE_ZEILE_ANKER matcht nach dem ersten Patch nicht mehr,
    weil die line-Zuweisung dann schon "${sigPart}" enthaelt) — analog zum
    Muster in patch_validate_request().
    """
    knoten = next(n for n in nodes if n["name"] == BUILD_LOG_LINE_KNOTEN)
    code = knoten["parameters"]["jsCode"]
    assert code.count(BUILD_LOG_LINE_CCPART_ANKER) == 1, (
        BUILD_LOG_LINE_KNOTEN + ": ccPart-Zeile nicht gefunden — Node hat sich geaendert"
    )
    assert code.count(BUILD_LOG_LINE_ZEILE_ANKER) == 1, (
        BUILD_LOG_LINE_KNOTEN + ": line-Zuweisung nicht wie erwartet gefunden "
        "— Node hat sich geaendert, oder der Patch wurde schon angewendet"
    )
    code = code.replace(BUILD_LOG_LINE_CCPART_ANKER, BUILD_LOG_LINE_SIGFEHLER_EINFUEGUNG, 1)
    code = code.replace(BUILD_LOG_LINE_ZEILE_ANKER, BUILD_LOG_LINE_ZEILE_NEU, 1)
    knoten["parameters"]["jsCode"] = code


# --- V17->V18: Finding B — Aufrufrahmen liegt ausserhalb des Fail-Open ---
#
# signiere() selbst faengt jede Ausnahme ab, aber der n8n-Aufrufrahmen
# (RAHMEN oben, require('fs') + der .map()-Aufruf) laeuft davor/aussenrum
# und der Node hat kein onError gesetzt. Schlaegt require('fs') je fehl,
# bricht der Node — und damit der gesamte Workflow — ab. Patch:
# onError=continueRegularOutput laesst n8n bei einem Fehler im Node die
# Eingabe-Items unveraendert durchreichen statt den Workflow abzubrechen.
def patch_attach_signature_onerror(nodes):
    """Finding B: onError=continueRegularOutput auf 'Attach Signature'."""
    knoten = next(n for n in nodes if n["name"] == NODE_NAME)
    assert knoten.get("onError") != "continueRegularOutput", (
        NODE_NAME + ": onError schon gesetzt — Patch schon angewendet?"
    )
    knoten["onError"] = "continueRegularOutput"


def baue(nodes, connections):
    """Klont den Workflow und wendet den AKTUELL ausstehenden Patch an.

    Heute (V17->V18): Finding A (Build Log Line liest __signaturFehler) +
    Finding B (Attach Signature bekommt onError=continueRegularOutput) +
    bereich-Durchreichung durch Validate Request (siehe oben — noetig,
    damit die im Abnahmeprotokoll geforderte, auf "de" begrenzte
    Fehlerprobe ueberhaupt isoliert moeglich ist). Aendert keine
    Verdrahtung, darum bleibt connections unveraendert (nur tief kopiert).
    """
    neu = json.loads(json.dumps(nodes))
    verb = json.loads(json.dumps(connections))

    patch_validate_request_bereich(neu)
    patch_build_log_line(neu)
    patch_attach_signature_onerror(neu)

    return neu, verb


def build_arg_parser() -> argparse.ArgumentParser:
    """Eigene Funktion, damit Tests die Parameter-Uebergabe pruefen koennen,
    ohne main() (und damit die echte DB-Verbindung) anzufassen."""
    p = argparse.ArgumentParser()
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--apply", action="store_true")
    p.add_argument(
        "--source-id", default=STANDARD_QUELL_ID,
        help="ID des Quell-Workflows (Standard: %s)" % STANDARD_QUELL_ID,
    )
    p.add_argument(
        "--new-id", default=STANDARD_NEUE_ID,
        help="ID des neu anzulegenden Workflows (Standard: %s)" % STANDARD_NEUE_ID,
    )
    p.add_argument(
        "--new-name", default=STANDARD_NEUER_NAME,
        help="Name des neu anzulegenden Workflows (Standard: %r)" % STANDARD_NEUER_NAME,
    )
    return p


def main() -> int:
    a = build_arg_parser().parse_args()
    if not (a.dry_run or a.apply):
        print("Kein Modus. --dry-run oder --apply.", file=sys.stderr)
        return 2

    con = sqlite3.connect(DB)
    row = con.execute(
        "select nodes, connections from workflow_entity where id=?",
        (a.source_id,),
    ).fetchone()
    if not row:
        print("Quellworkflow nicht gefunden: " + a.source_id, file=sys.stderr)
        return 2

    nodes, verb = baue(json.loads(row[0]), json.loads(row[1]))
    print("Quelle: %s -> Ziel: %s (%r)" % (a.source_id, a.new_id, a.new_name))
    print("Nodes: %d -> %d (unveraendert)" % (len(json.loads(row[0])), len(nodes)))
    print("Patch: 'Validate Request' reicht body.bereich jetzt durch")
    print("Patch: '%s' liest __signaturFehler jetzt von '%s'"
          % (BUILD_LOG_LINE_KNOTEN, NODE_NAME))
    print("Patch: '%s' bekommt onError=continueRegularOutput" % NODE_NAME)

    if a.dry_run:
        print("(dry-run, nichts geschrieben)")
        return 0

    vorhanden = con.execute(
        "select 1 from workflow_entity where id=?", (a.new_id,)
    ).fetchone()
    if vorhanden:
        print(a.new_id + " existiert bereits — erst loeschen oder ID anpassen.",
              file=sys.stderr)
        return 2

    # Drei Ergaenzungen gegenueber der urspruenglichen Spec-Fassung dieses
    # Skripts, alle beim Testlauf gegen die echte n8n-2.29-DB gefunden:
    #
    # 1. versionId ist NOT NULL — fehlte im ersten Entwurf komplett.
    # 2. Jeder workflow_entity-Datensatz in dieser Instanz hat eine passende
    #    workflow_history-Zeile (workflow_history.versionId ==
    #    workflow_entity.versionId), auch inaktive Workflows ohne
    #    activeVersionId. Ohne sie fehlt dem Workflow seine erste Version.
    # 3. Der eigentliche Grund fuer ein 404 auf GET /api/v1/workflows/<id>
    #    trotz Eintrag in workflow_entity UND workflow_history: es fehlte
    #    die Zeile in shared_workflow (workflowId, projectId,
    #    role='workflow:owner'). Ohne sie gehoert der Workflow keinem
    #    Projekt — er taucht in der Liste auf, aber jeder Einzelzugriff
    #    (GET/activate/deactivate) schlaegt fehl. Verifiziert per Vergleich
    #    mit Quellworkflow und einem unabhaengigen Kontroll-Workflow, die
    #    beide so eine Zeile haben.
    neue_version_id = str(uuid.uuid4())
    con.execute(
        "insert into workflow_entity (id, name, active, nodes, connections, "
        "settings, versionId, createdAt, updatedAt) "
        "select ?, ?, 0, ?, ?, settings, ?, datetime('now'), datetime('now') "
        "from workflow_entity where id=?",
        (a.new_id, a.new_name, json.dumps(nodes), json.dumps(verb),
         neue_version_id, a.source_id),
    )
    con.execute(
        "insert into workflow_history (versionId, workflowId, authors, "
        "nodes, connections, name, autosaved, createdAt, updatedAt) "
        "values (?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))",
        (neue_version_id, a.new_id, "patch_relay.py",
         json.dumps(nodes), json.dumps(verb), a.new_name),
    )
    geteilt = con.execute(
        "select projectId, role from shared_workflow where workflowId=?",
        (a.source_id,),
    ).fetchall()
    assert geteilt, (
        "Quellworkflow hat keine shared_workflow-Zeile — Projektzuordnung "
        "unklar, breche ab statt zu raten."
    )
    for projekt_id, rolle in geteilt:
        con.execute(
            "insert into shared_workflow (workflowId, projectId, role, "
            "createdAt, updatedAt) values (?, ?, ?, datetime('now'), "
            "datetime('now'))",
            (a.new_id, projekt_id, rolle),
        )
    con.commit()
    print(a.new_id + " angelegt (inaktiv)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
