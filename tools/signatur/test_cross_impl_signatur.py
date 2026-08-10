# test_cross_impl_signatur.py
"""Finding 2 des Abschluss-Reviews: signatur.py (Python, von Luna genutzt)
und relay_signatur.js (Node, als Code-Node im SMTP-Relay eingebettet)
muessen byte-identisches Signatur-HTML erzeugen. Bisher war das nur ein
manueller Vergleich -- dieser Test ruft echten Code beider Seiten auf (nicht
eine dritte, potenziell abweichende Nachbildung) und vergleicht das Ergebnis
byte-genau.

Beide Seiten lesen dabei bewusst dieselben Bausteine: die Repo-Kopie unter
tools/signatur/ (von conftest.py bei Bedarf frisch erzeugt). Ohne den
Umweg ueber equiv_probe.mjs wuerde relay_signatur.js seine hartkodierte
BAUSTEIN_VERZEICHNIS-Konstante (Live-Pfad ~/.paperclip/scripts/signatur)
treffen -- genau die Luecke aus dem Review: aendert sich bereiche.json oder
vorlage.html, koennten beide Suiten fuer VERSCHIEDENE Eingaben gruen werden
und die Divergenz erst im Kundenpostfach auffallen.

Prueft zwei Bereiche und einen Absendernamen mit Apostroph + kaufmaennischem
Und, um HTML-Escaping auf beiden Seiten wirklich zu belasten."""
from __future__ import annotations

import json
import os
import shutil
import subprocess

import pytest

import signatur

HIER = os.path.dirname(os.path.abspath(__file__))
BEREICHE = ["ai", "film"]
SENDER_NAME = "O'Brien & Söhne"
SENDER_ROLLE = "KI-Agent"
INHALT_PLATZHALTER = "__INHALT__"
PRAEFIX = INHALT_PLATZHALTER + "\n<br>\n"


def _node_verfuegbar() -> bool:
    return shutil.which("node") is not None


def _js_seite(bereich: str) -> dict:
    """Ruft die echte Produktionsfunktion signiere() ueber das Hilfsskript
    equiv_probe.mjs auf (siehe dort fuer die Umleitung auf die Repo-
    Bausteine)."""
    probe = os.path.join(HIER, "equiv_probe.mjs")
    proc = subprocess.run(
        ["node", probe, bereich, SENDER_NAME, SENDER_ROLLE, HIER],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 0, (
        f"equiv_probe.mjs ({bereich}) fehlgeschlagen "
        f"(rc={proc.returncode}): {proc.stderr}"
    )
    return json.loads(proc.stdout)


def _py_seite(bereich: str, hinweis: str) -> tuple[str, list]:
    block = signatur.absenderblock(SENDER_NAME, SENDER_ROLLE, hinweis)
    sig_html = signatur.komponiere(bereich, block)
    return signatur.zu_cid(sig_html, ab_index=0)


@pytest.fixture(scope="module")
def node_check():
    # Muss laut Aufgabenstellung LAUT ueberspringen, nie still "bestehen" —
    # ein fehlendes node darf keinen gruenen Haken vortaeuschen.
    if not _node_verfuegbar():
        pytest.skip(
            "node ist nicht installiert / nicht im PATH — "
            "Python<->JS-Abgleichstest kann nicht laufen und wird "
            "uebersprungen (nicht stillschweigend als bestanden gewertet)."
        )


@pytest.mark.parametrize("bereich", BEREICHE)
def test_signatur_html_byte_identisch(node_check, bereich):
    js = _js_seite(bereich)
    assert js["html"].startswith(PRAEFIX), (
        f"equiv_probe.mjs ({bereich}): unerwartetes Praefix, Test-Setup "
        f"kaputt: {js['html'][:80]!r}"
    )
    js_sig_html = js["html"][len(PRAEFIX):]

    py_sig_html, py_anhaenge = _py_seite(bereich, js["hinweis"])

    assert py_sig_html == js_sig_html, (
        f"Signatur-HTML weicht zwischen signatur.py und relay_signatur.js "
        f"ab (Bereich {bereich})."
    )
    assert py_anhaenge == js["attachments"], (
        f"Logo-Anhaenge weichen zwischen signatur.py und relay_signatur.js "
        f"ab (Bereich {bereich})."
    )


@pytest.mark.parametrize("bereich", BEREICHE)
def test_testfall_uebt_wirklich_escaping_aus(node_check, bereich):
    # Absicherung gegen einen Test, der zufaellig an einem harmlosen Namen
    # vorbeilaeuft, ohne dass Escaping ueberhaupt zum Tragen kommt.
    assert "'" in SENDER_NAME and "&" in SENDER_NAME
    js = _js_seite(bereich)
    assert "&#x27;" in js["html"]  # maskierter Apostroph
    assert "&amp;" in js["html"]   # maskiertes kaufmaennisches Und
