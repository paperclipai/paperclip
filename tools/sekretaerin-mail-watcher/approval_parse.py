"""Erkennt Walters Freigabe-Antworten: Token aus Betreff + exakt-'okay'-Prüfung.

Sicherheitsregel: nur ein isoliertes, alleinstehendes 'okay' löst Versand aus.
Im Zweifel -> 'correction' (nie senden)."""
from __future__ import annotations
import re

TOKEN_RE = re.compile(r"\[Freigabe #([A-Z2-7]{4})\]")

_QUOTE_PHRASE_RE = re.compile(r"^\s*Am .+ schrieb .+:", re.IGNORECASE)


def extract_token(subject: str) -> str | None:
    m = TOKEN_RE.search(subject or "")
    return m.group(1) if m else None


def isolate_reply(body: str) -> str:
    """Oberster Antwortblock vor Zitat/Signatur."""
    lines = (body or "").replace("\r\n", "\n").split("\n")
    kept = []
    for line in lines:
        stripped = line.strip()
        if _QUOTE_PHRASE_RE.match(line):
            break
        if (stripped.startswith(">") or stripped.startswith("-----")
                or stripped.startswith("________")
                or stripped.startswith("Von:") or stripped.startswith("From:")
                or line.rstrip() in ("--", "-- ")):
            break
        kept.append(line)
    return "\n".join(kept).strip()


def normalize(text: str) -> str:
    return text.strip().lower().rstrip(".!").strip()


def classify(body: str) -> str:
    top = isolate_reply(body)
    if not top:
        return "correction"
    # Nur wenn der GESAMTE oberste Block (ohne Leerzeilen) exakt das Kommando ist.
    compact = " ".join(l for l in top.split("\n") if l.strip()).strip()
    norm = normalize(compact)
    if norm == "okay":
        return "send"
    if norm == "ignorieren":
        return "ignore"
    return "correction"
