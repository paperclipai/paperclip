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
            tail = [l for l in lines[i + 1:] if l.strip()]
            if len(tail) <= 2:
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
        out.append(f'<p style="margin:0 0 12px 0;font-size:14px;line-height:1.5;color:#222;">{safe}</p>')
    return "\n".join(out)


def load_sig(area: str) -> str:
    p = SIGDIR / f"signatur-{AREAS[area]}.html"
    if not p.exists():
        raise FileNotFoundError(f"Signatur fehlt: {p}")
    return p.read_text(encoding="utf-8")


def render_customer_html(area: str, body_md: str) -> str:
    answer = md_to_html(strip_self_signoff(body_md))
    sig = load_sig(area)
    return (
        '<!DOCTYPE html><html><head><meta charset="utf-8"></head>'
        '<body style="font-family:Arial,Helvetica,sans-serif;max-width:720px;margin:0 auto;padding:20px;">'
        f'<div style="margin:0 0 24px 0;">{answer}</div>{sig}</body></html>'
    )
