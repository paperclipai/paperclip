#!/usr/bin/env python3
"""Bereitet die Signaturlogos auf: 250 px breit, farbreduziert, transparent.

Einmal-Werkzeug. Erneut laufen lassen, wenn im Signatures-Ordner ein Logo
ausgetauscht wurde. Danach `signatur_build.py` aufrufen, damit die
Bereichsdateien das neue Logo aufnehmen.
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile

from PIL import Image

QUELLE = os.path.expanduser(
    "~/Library/CloudStorage/SynologyDrive-Mac/Claude Code MAC/Paperclip/Signatures"
)
ZIEL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logos")

# Bereichsschluessel -> Ordnername im Signatures-Verzeichnis.
# "WHIETSTAG FILM" ist im Original so geschrieben — kein Tippfehler hier.
ORDNER = {
    "ai": "WHITESTAG AI-Dateien",
    "film": "WHIETSTAG FILM-Dateien",
    "tv": "WHITESTAG TV-Dateien",
    "academy": "WHITESTAG ACADEMY-Dateien",
    "app": "WHITESTAG APP-Dateien",
    "de": "WHITESTAG DE-Dateien",
}

BREITE = 250


def baue(key: str, ordner: str) -> None:
    quelle = os.path.join(QUELLE, ordner, "image001.png")
    if not os.path.exists(quelle):
        raise SystemExit("Quelllogo fehlt: " + quelle)

    with Image.open(quelle) as im:
        im = im.convert("RGBA")
        hoehe = max(1, round(im.height * BREITE / im.width))
        im = im.resize((BREITE, hoehe), Image.LANCZOS)
        fd, roh = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        im.save(roh, optimize=True)

    ziel = os.path.join(ZIEL, key + ".png")
    try:
        subprocess.run(
            ["pngquant", "--quality=65-90", "--speed=1", "--force",
             "--output", ziel, roh],
            check=True,
        )
    finally:
        os.unlink(roh)

    print("%-8s %6d Bytes" % (key, os.path.getsize(ziel)))


def main() -> int:
    os.makedirs(ZIEL, exist_ok=True)
    for key, ordner in ORDNER.items():
        baue(key, ordner)
    return 0


if __name__ == "__main__":
    sys.exit(main())
