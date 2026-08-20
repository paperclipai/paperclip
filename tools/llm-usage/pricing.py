#!/usr/bin/env python3
"""Preistabelle für die LLM-Kostenrechnung.

Warum es das gibt: Paperclip füllt `cost_events.cost_cents` für Anthropic-
Modelle NICHT — die Spalte steht bei allen Agenten auf 0, auch bei denen, die
längst auf `claude-sonnet-4-6` oder `claude-opus-5` laufen. Der Nutzungs-Report
zeigte für Cloud-Agenten deshalb 0 €, obwohl echte API-Kosten anfielen. Die
Token-Zahlen sind dagegen korrekt befüllt, also wird hier aus ihnen gerechnet.

Grundregel gegen genau diesen Fehler: **lokale Modelle kosten 0, unbekannte
`claude-*`-Modelle kosten `None`** — nicht 0. Ein neues Anthropic-Modell, das
hier fehlt, taucht im Report als „Preis unbekannt" auf, statt still mit 0 €
durchzurutschen.
"""
from datetime import date
from typing import Optional

# Umrechnung für die Anzeige. Grob und bewusst konservativ — die Rechnung ist
# ohnehin eine Schätzung (siehe Cache-Vorbehalt unten).
USD_EUR = 0.92

# $ pro 1 Mio. Token, (Input, Output).
# Quelle: platform.claude.com/docs/en/pricing (Stand 2026-06-24).
PREISE = {
    "claude-fable-5":    (10.00, 50.00),
    "claude-mythos-5":   (10.00, 50.00),
    "claude-opus-5":     (5.00, 25.00),
    "claude-opus-4-8":   (5.00, 25.00),
    "claude-opus-4-7":   (5.00, 25.00),
    "claude-opus-4-6":   (5.00, 25.00),
    "claude-opus-4-5":   (5.00, 25.00),
    "claude-opus-4-1":   (15.00, 75.00),
    "claude-sonnet-5":   (3.00, 15.00),
    "claude-sonnet-4-6": (3.00, 15.00),
    "claude-sonnet-4-5": (3.00, 15.00),
    "claude-sonnet-4-0": (3.00, 15.00),
    "claude-haiku-4-5":  (1.00, 5.00),
}

# Einführungspreise MIT Ablaufdatum: bis einschliesslich `bis` gilt der
# Sonderpreis, danach automatisch der Listenpreis aus PREISE. Ohne dieses
# Ablaufdatum würde der Report ab dem 01.09.2026 still 50 % zu wenig ausweisen.
INTRO = {
    "claude-sonnet-5": (date(2026, 8, 31), (2.00, 10.00)),
}

# Aus dem Cache gelesene Token kosten 0,1 × Input-Preis.
CACHE_READ_FAKTOR = 0.1


def normalisiere(model: str) -> str:
    """Modell-ID auf den Tabellen-Schlüssel bringen.

    `claude-opus-4-7[1m]` ist dasselbe Modell mit 1M-Kontext-Variante und wird
    gleich bepreist; das Suffix taucht so in `cost_events` auf.
    """
    m = (model or "").strip()
    if m.endswith("[1m]"):
        m = m[:-4]
    return m


def ist_lokal(model: str) -> bool:
    """Läuft das Modell auf eigener Hardware (LM Studio) und kostet damit nichts?

    Bewusst als Negativ-Test auf `claude-`: alles andere — `qwen…`,
    `google/gemma…`, `openai/gpt-oss…`, `mistral…`, `text-embedding-…` — läuft
    hier lokal. So kann ein unbekanntes ANTHROPIC-Modell nie versehentlich als
    kostenlos gelten.
    """
    return not normalisiere(model).startswith("claude-")


def preis(model: str, tag: Optional[date] = None):
    """($/MTok Input, $/MTok Output), (0.0, 0.0) für lokal, None wenn unbekannt."""
    m = normalisiere(model)
    if ist_lokal(m):
        return (0.0, 0.0)
    intro = INTRO.get(m)
    if intro is not None:
        bis, tarif = intro
        if tag is not None and tag <= bis:
            return tarif
    return PREISE.get(m)


def kosten_eur(model, in_tok, cached_tok, out_tok, tag: Optional[date] = None):
    """Kosten in EUR — oder None, wenn der Preis unbekannt ist.

    `cached_tok` sind aus dem Cache gelesene Input-Token (0,1 × Input-Preis).

    VORBEHALT: `cost_events` kennt nur eine Cache-Spalte. Cache-*Writes*
    (1,25 × Input beim 5-Minuten-TTL) sind darin offenbar nicht getrennt
    erfasst, die echten Kosten liegen also eher etwas höher als hier gezeigt.
    """
    p = preis(model, tag)
    if p is None:
        return None
    pin, pout = p
    usd = (
        (in_tok or 0) * pin
        + (cached_tok or 0) * pin * CACHE_READ_FAKTOR
        + (out_tok or 0) * pout
    ) / 1_000_000
    return usd * USD_EUR


def unbekannte(modelle) -> list:
    """Die `claude-*`-Modelle aus `modelle`, für die kein Preis hinterlegt ist."""
    return sorted({m for m in modelle if preis(m) is None})


def fmt_eur(betrag) -> str:
    """Für die Anzeige: '12,34 €', bei unbekanntem Preis '?'."""
    if betrag is None:
        return "?"
    return f"{betrag:,.2f} €".replace(",", "␟").replace(".", ",").replace("␟", ".")
