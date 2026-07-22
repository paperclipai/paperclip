# luna_mail_render.py
"""Geteiltes Rendering: Antwort-Markdown -> Kunden-HTML inkl. Bereichs-Signatur."""
from __future__ import annotations
import html as htmllib
import re
from pathlib import Path

SIGDIR = Path.home() / "Obsidian" / "WHITESTAG-Vault" / "Paperclip" / "Luna" / "signaturen"
AREAS = {"AI": "ai", "FILM": "film", "SORBART": "sorbart"}

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
    p = SIGDIR / f"signatur-{AREAS[area]}.html"
    if not p.exists():
        raise FileNotFoundError(f"Signatur fehlt: {p}")
    return p.read_text(encoding="utf-8")


# base64-eingebettete <img> in der Signatur. Outlook/Exchange entfernt data:-URIs,
# darum ersetzen wir sie durch cid:-Referenzen + Inline-Anhänge (der Relay setzt
# via contentId das passende Content-ID-Header, dann rendert auch Outlook das Logo).
_IMG_DATA_RE = re.compile(
    r'<img([^>]*?)src="data:(image/[a-zA-Z0-9.+-]+);base64,([^"]+)"([^>]*)>')


def _sig_with_cid(sig_html: str) -> tuple[str, list[dict]]:
    """Ersetzt base64-<img> durch cid-Referenzen; gibt (html, inline-attachments)."""
    attachments: list[dict] = []

    def repl(m: re.Match) -> str:
        idx = len(attachments)
        cid = f"sig-logo-{idx}"
        mime = m.group(2)
        ext = mime.split("/")[-1]
        attachments.append({
            "filename": f"logo-{idx}.{ext}",
            "content": m.group(3),
            "mimeType": mime,
            "cid": cid,
        })
        return f'<img{m.group(1)}src="cid:{cid}"{m.group(4)}>'

    return _IMG_DATA_RE.sub(repl, sig_html), attachments


def render_customer_html(area: str, body_md: str) -> tuple[str, list[dict]]:
    """Gibt (finales Kunden-HTML, Inline-Anhänge für Logos) zurück.

    Logo-Strategie: Standard ist das base64-Logo direkt aus der Signatur
    (rendert in Gmail/Apple Mail; Outlook zeigt es nicht — Outlook rendert
    weder base64 noch webp, und n8n überträgt kein CID). Für zuverlässiges
    Rendering in Outlook muss die Signatur auf eine gehostete PNG/JPG-URL
    umgestellt werden. `_sig_with_cid` bleibt für einen künftigen CID-fähigen
    Sendeweg erhalten, wird hier aber bewusst nicht genutzt."""
    answer = md_to_html(strip_self_signoff(body_md))
    sig, attachments = load_sig(area), []
    html = (
        '<!DOCTYPE html><html><head><meta charset="utf-8"></head>'
        '<body style="font-family:Arial,Helvetica,sans-serif;max-width:720px;margin:0;padding:20px;text-align:left;">'
        f'<div style="margin:0 0 24px 0;text-align:left;">{answer}</div>{sig}</body></html>'
    )
    return html, attachments
