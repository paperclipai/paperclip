#!/usr/bin/env python3
"""Erzeugt aus Bereichsdaten, Vorlage und Logo je Bereich eine Signaturdatei.

Ausgabe: bereich-<key>.html mit dem Platzhalter {{ABSENDERBLOCK}}, den die
Laufzeit (signatur.py bzw. der n8n-Node) durch den absenderspezifischen
i.A.-Block ersetzt.

Nach jeder Aenderung an bereiche.json, vorlage.html oder logos/ erneut laufen
lassen.
"""
from __future__ import annotations

import base64
import html as htmllib
import json
import os
import sys

from PIL import Image

HIER = os.path.dirname(os.path.abspath(__file__))
KEYS = ["ai", "film", "tv", "academy", "app", "de"]

ANZEIGE_BREITE = 125


def _lade_bereiche():
    with open(os.path.join(HIER, "bereiche.json"), encoding="utf-8") as fh:
        return json.load(fh)


def _firma_zeile(daten) -> str:
    """Bereichszeile — nur dort, wo das Original eine traegt."""
    if not daten["firma"]:
        return ""
    return (
        '   <div style="font-size:13px;font-weight:bold;color:#111;">%s</div>'
        % htmllib.escape(daten["firma"])
    )


def baue(key: str) -> str:
    """Liefert das fertige Signatur-HTML eines Bereichs.

    Wirft KeyError, wenn der Bereich unbekannt ist, und FileNotFoundError,
    wenn Vorlage oder Logo fehlen.
    """
    daten = _lade_bereiche()[key]

    logo_pfad = os.path.join(HIER, "logos", key + ".png")
    with open(logo_pfad, "rb") as fh:
        logo_b64 = base64.b64encode(fh.read()).decode("ascii")
    with Image.open(logo_pfad) as im:
        hoehe = int(round(im.height * ANZEIGE_BREITE / im.width))

    with open(os.path.join(HIER, "vorlage.html"), encoding="utf-8") as fh:
        vorlage = fh.read()

    ersetzungen = {
        "{{FIRMA_ZEILE}}": _firma_zeile(daten),
        "{{LOGO_B64}}": logo_b64,
        "{{LOGO_HOEHE}}": str(hoehe),
        "{{LOGO_ALT}}": htmllib.escape(daten["logo_alt"], quote=True),
        "{{MAIL}}": htmllib.escape(daten["mail"]),
        "{{WEB}}": htmllib.escape(daten["web"]),
        "{{URL}}": htmllib.escape(daten["url"], quote=True),
    }
    for platzhalter, wert in ersetzungen.items():
        vorlage = vorlage.replace(platzhalter, wert)
    return vorlage


def main(zielverzeichnis: str = None) -> int:
    ziel_dir = zielverzeichnis or HIER
    for key in KEYS:
        ziel = os.path.join(ziel_dir, "bereich-%s.html" % key)
        with open(ziel, "w", encoding="utf-8") as fh:
            fh.write(baue(key))
        print("%-8s %6d Bytes" % (key, os.path.getsize(ziel)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
