#!/usr/bin/env python3
"""Laufzeit-Bibliothek fuer die Mail-Signaturen.

Setzt den absenderspezifischen i.A.-Block in einen Bereichsbaustein ein und
wandelt das eingebettete base64-Logo in eine Inline-CID-Referenz um.

Outlook/Exchange entfernt data:-URIs, darum die CID-Variante: der Relay-Node
"Build Binary Attachments" legt Anhaenge unter dem Binaer-Property-Namen
`attachment_<index>` ab, und nodemailer nutzt GENAU DIESEN NAMEN als
Content-ID. Ein abweichendes cid-Feld wird ignoriert. Der Index muss deshalb
zur endgueltigen Position im attachments-Array passen — dafuer `ab_index`.
"""
from __future__ import annotations

import html as htmllib
import os
import re

HIER = os.path.dirname(os.path.abspath(__file__))

BEREICHE = ["ai", "film", "tv", "academy", "app", "de"]
VORGABE_BEREICH = "ai"

PLATZHALTER = "{{ABSENDERBLOCK}}"

_IMG_DATA_RE = re.compile(
    r'<img([^>]*?)(?<=[\s"\'])src="data:(image/[a-zA-Z0-9.+-]+);base64,([^"]+)"([^>]*)>'
)


def absenderblock(name: str, rolle: str, hinweis: str) -> str:
    """Die Zeilen, die den Absender kennzeichnen."""
    return (
        '   <div style="font-size:13px;color:#222;">'
        '<strong>i.A. %s</strong> – %s</div>\n'
        '   <div style="font-size:11px;color:#888;line-height:1.4;'
        'margin-top:4px;max-width:780px;">%s</div>'
    ) % (
        htmllib.escape(name),
        htmllib.escape(rolle),
        htmllib.escape(hinweis),
    )


def komponiere(bereich: str, block: str) -> str:
    """Bereichsbaustein laden und den Absenderblock einsetzen."""
    if bereich not in BEREICHE:
        raise ValueError("Unbekannter Bereich: %s" % bereich)
    pfad = os.path.join(HIER, "bereich-%s.html" % bereich)
    with open(pfad, encoding="utf-8") as fh:
        return fh.read().replace(PLATZHALTER, block)


def zu_cid(sig_html: str, ab_index: int = 0):
    """Ersetzt base64-<img> durch cid:-Referenzen.

    Liefert (html, anhaenge). `ab_index` ist die Position, an der die
    erzeugten Anhaenge im endgueltigen attachments-Array stehen werden.
    """
    anhaenge = []

    def repl(m):
        idx = ab_index + len(anhaenge)
        mime = m.group(2)
        endung = mime.split("/")[-1]
        anhaenge.append({
            "filename": "logo-%d.%s" % (idx, endung),
            "content": m.group(3),
            "mimeType": mime,
            "cid": "attachment_%d" % idx,
        })
        return '<img%ssrc="cid:attachment_%d"%s>' % (m.group(1), idx, m.group(4))

    return _IMG_DATA_RE.sub(repl, sig_html), anhaenge
