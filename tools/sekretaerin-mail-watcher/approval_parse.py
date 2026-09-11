"""Erkennt Walters Freigabe-Antworten: Token aus Betreff + exakte Kommando-Prüfung.

Sicherheitsregel: nur ein isoliertes, alleinstehendes Kommando löst Versand aus.
Im Zweifel -> 'correction' (nie senden).

Sendebefehle: 'freigabe' (Walters Wort, seit 2026-08-31) und 'okay' (der alte
Befehl, bleibt gueltig). Vorher galt NUR 'okay' — Walter hat am 2026-08-30 und
2026-08-31 insgesamt siebenmal 'Freigabe' geantwortet, jedes Mal wurde daraus
eine 'correction' und damit ein neuer Entwurf statt eines Versands."""
from __future__ import annotations
import re

TOKEN_RE = re.compile(r"\[Freigabe #([A-Z2-7]{4})\]")

_QUOTE_PHRASE_RE = re.compile(r"^\s*Am .+ schrieb .+:", re.IGNORECASE)

# Handy-Signaturen. Ohne sie klebt "Gesendet von Outlook fuer iOS" am Kommando
# und der Block ist nicht mehr "alleinstehend" -> jede Freigabe vom Telefon
# waere eine Korrektur. Genau das ist am 2026-08-30 passiert.
_MOBILE_SIG_RE = re.compile(
    r"^\s*(Gesendet von|Gesendet mit|Von meinem|Sent from|Get Outlook)\b",
    re.IGNORECASE)

SENDEBEFEHLE = {"freigabe", "okay"}


def extract_token(subject: str) -> str | None:
    m = TOKEN_RE.search(subject or "")
    return m.group(1) if m else None


def isolate_reply(body: str) -> str:
    """Oberster Antwortblock vor Zitat/Signatur."""
    lines = (body or "").replace("\r\n", "\n").split("\n")
    kept = []
    for line in lines:
        stripped = line.strip()
        if _QUOTE_PHRASE_RE.match(line) or _MOBILE_SIG_RE.match(line):
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
    if norm in SENDEBEFEHLE:
        return "send"
    if norm == "ignorieren":
        return "ignore"
    return "correction"
