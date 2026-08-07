# luna_mail_render.py
"""Geteiltes Rendering: Antwort-Markdown -> Kunden-HTML inkl. Bereichs-Signatur.

Die Signaturbausteine liegen seit 08/2026 im Geschwisterordner `signatur/`
und werden mit den Agentenmails geteilt. Luna rendert weiterhin
client-seitig, weil die fertige Fassung schon fuer die Telegram-Vorschau
gebraucht wird — der Relay bekommt deshalb `signatur: "none"`.

SORBART wurde am 04.08.2026 stillgelegt.
"""
from __future__ import annotations
import html as htmllib
import os
import re
import sys

# Geschwisterordner — trifft Repo (tools/signatur) und Live
# (~/.paperclip/scripts/signatur) gleichermassen, ohne Sonderfall.
sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "signatur"))
import signatur  # noqa: E402

AREAS = {"AI": "ai", "FILM": "film"}

LUNA_NAME = "Luna"
LUNA_ROLLE = "KI-Assistentin"
LUNA_HINWEIS = (
    "Diese Nachricht wurde von Luna, unserer KI-Assistentin, vorbereitet "
    "und von Walter Schönenbröcher persönlich geprüft und freigegeben."
)

_GREETING_RE = re.compile(
    r"^\s*(mit freundlichen gr[üue]+ßen|mit besten gr[üue]+ßen|"
    r"beste gr[üue]+ße|freundliche gr[üue]+ße|viele gr[üue]+ße|"
    r"herzliche gr[üue]+ße|liebe gr[üue]+ße)\b", re.IGNORECASE)


def strip_self_signoff(md: str) -> str:
    lines = md.rstrip().split("\n")
    cut = None
    for i, line in enumerate(lines):
        if _GREETING_RE.match(line):
            # Alles ab der Grußformel abschneiden — die kanonische Signatur (inkl.
            # Grußformel + „i.A. Luna") hängt das Skript ohnehin an. So bleibt auch
            # ein langer, selbst geschriebener Signoff samt (ggf. halluziniertem)
            # Disclaimer weg, statt eine doppelte Signatur zu erzeugen.
            cut = i
            break
    if cut is None:
        return md
    return "\n".join(lines[:cut]).rstrip() + "\n"


def md_to_html(md: str) -> str:
    md = md.strip()
    blocks = [b.strip() for b in md.split("\n\n") if b.strip()]
    out = []
    for b in blocks:
        safe = htmllib.escape(b).replace("\n", "<br>")
        out.append(f'<p style="margin:0 0 12px 0;font-size:14px;line-height:1.5;color:#222;text-align:left;">{safe}</p>')
    return "\n".join(out)


def load_sig(area: str) -> str:
    """Bereichssignatur mit Lunas Absenderblock."""
    bereich = AREAS[area]  # KeyError bei unbekanntem Area — gewollt
    block = signatur.absenderblock(LUNA_NAME, LUNA_ROLLE, LUNA_HINWEIS)
    return signatur.komponiere(bereich, block)


def render_customer_html(area: str, body_md: str) -> tuple[str, list[dict]]:
    """Gibt (finales Kunden-HTML, Inline-Anhänge für Logos) zurück.

    Logo-Strategie: Inline-CID. Das base64-Logo der Signatur wird zu
    `<img src="cid:attachment_N">` + Inline-Anhang (siehe `signatur.zu_cid`).
    Rendert überall inkl. Outlook/Exchange und bei Kunden, ohne „Bilder
    herunterladen" — anders als base64 (Outlook blockt) oder externe URLs
    (von vielen Clients standardmäßig blockiert)."""
    answer = md_to_html(strip_self_signoff(body_md))
    sig, attachments = signatur.zu_cid(load_sig(area))
    html = (
        '<!DOCTYPE html><html><head><meta charset="utf-8"></head>'
        '<body style="font-family:Arial,Helvetica,sans-serif;max-width:720px;margin:0;padding:20px;text-align:left;">'
        f'<div style="margin:0 0 24px 0;text-align:left;">{answer}</div>{sig}</body></html>'
    )
    return html, attachments
