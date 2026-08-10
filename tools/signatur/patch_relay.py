#!/usr/bin/env python3
"""Klont den SMTP-Relay auf eine neue Version und haengt den Signatur-Node ein.

Der Node-Code stammt aus relay_signatur.js — module.exports wird entfernt und
ein n8n-Aufrufrahmen angehaengt, damit es genau eine Quelle gibt.

Nutzung:
    python3 patch_relay.py --dry-run   # zeigt nur, was passieren wuerde
    python3 patch_relay.py --apply     # legt V17 an (noch nicht aktiv)
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
QUELL_ID = "BXHc5kdNdZQNiuMr"
NEUE_ID = "SMTPRelayV17Signat"
NEUER_NAME = "SMTP Relay V17 — Signatur"
NODE_NAME = "Attach Signature"

RAHMEN = """
// --- n8n-Aufrufrahmen (angehaengt von patch_relay.py) --------------------
const fsModul = require('fs');
const leseDatei = (p) => fsModul.readFileSync(p, 'utf8');
return $input.all().map((item) => ({ json: signiere(item.json, leseDatei) }));
"""


def node_code(quelltext: str | None = None) -> str:
    """relay_signatur.js ohne CommonJS-Export, dafuer mit n8n-Aufrufrahmen.

    quelltext dient nur dem Test — im Normalbetrieb wird relay_signatur.js
    von der Platte gelesen.
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
    """Reicht body.signatur durch Validate Request hindurch (siehe oben)."""
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


def baue(nodes, connections):
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


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--apply", action="store_true")
    a = p.parse_args()
    if not (a.dry_run or a.apply):
        print("Kein Modus. --dry-run oder --apply.", file=sys.stderr)
        return 2

    con = sqlite3.connect(DB)
    row = con.execute(
        "select nodes, connections from workflow_entity where id=?",
        (QUELL_ID,),
    ).fetchone()
    if not row:
        print("Quellworkflow nicht gefunden: " + QUELL_ID, file=sys.stderr)
        return 2

    nodes, verb = baue(json.loads(row[0]), json.loads(row[1]))
    print("Nodes: %d -> %d" % (len(json.loads(row[0])), len(nodes)))
    print("Neuer Node: %s" % NODE_NAME)
    print("Validation Error?[1] -> %s -> Build Binary Attachments" % NODE_NAME)

    if a.dry_run:
        print("(dry-run, nichts geschrieben)")
        return 0

    vorhanden = con.execute(
        "select 1 from workflow_entity where id=?", (NEUE_ID,)
    ).fetchone()
    if vorhanden:
        print("V17 existiert bereits — erst loeschen oder ID anpassen.",
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
        (NEUE_ID, NEUER_NAME, json.dumps(nodes), json.dumps(verb),
         neue_version_id, QUELL_ID),
    )
    con.execute(
        "insert into workflow_history (versionId, workflowId, authors, "
        "nodes, connections, name, autosaved, createdAt, updatedAt) "
        "values (?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))",
        (neue_version_id, NEUE_ID, "patch_relay.py",
         json.dumps(nodes), json.dumps(verb), NEUER_NAME),
    )
    geteilt = con.execute(
        "select projectId, role from shared_workflow where workflowId=?",
        (QUELL_ID,),
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
            (NEUE_ID, projekt_id, rolle),
        )
    con.commit()
    print("V17 angelegt (inaktiv): " + NEUE_ID)
    return 0


if __name__ == "__main__":
    sys.exit(main())
