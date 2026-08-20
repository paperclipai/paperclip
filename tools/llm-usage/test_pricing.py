#!/usr/bin/env python3
"""Tests der Preistabelle. Aufruf: python3 -m pytest test_pricing.py -q"""
from datetime import date

import pricing


def test_lokale_modelle_kosten_nichts():
    """Eigene Hardware — die Rechnung soll 0 zeigen, nicht 'unbekannt'."""
    for m in ("qwen3.6-35b-a3b-mlx", "google/gemma-4-12b", "openai/gpt-oss-120b",
              "qwen/qwen3-coder-next", "mistral-small-3.2-24b-instruct-2506",
              "text-embedding-bge-m3"):
        assert pricing.kosten_eur(m, 1_000_000, 1_000_000, 1_000_000) == 0.0, m


def test_unbekanntes_claude_modell_ist_None_nicht_null():
    """Der Kern des Ganzen: ein neues Anthropic-Modell darf nicht still mit
    0 EUR durchrutschen — genau so entstand die Luecke im Report."""
    assert pricing.preis("claude-supernova-9") is None
    assert pricing.kosten_eur("claude-supernova-9", 1000, 0, 1000) is None
    assert pricing.unbekannte(["claude-supernova-9", "qwen3.6-35b-a3b-mlx"]) == \
        ["claude-supernova-9"]


def test_1m_variante_wird_wie_das_basismodell_bepreist():
    """`claude-opus-4-7[1m]` taucht so in cost_events auf."""
    assert pricing.preis("claude-opus-4-7[1m]") == pricing.preis("claude-opus-4-7")


def test_sonnet5_intro_laeuft_am_31_08_2026_aus():
    """Ohne Ablaufdatum wuerde der Report ab September 50 % zu wenig ausweisen."""
    assert pricing.preis("claude-sonnet-5", date(2026, 8, 31)) == (2.00, 10.00)
    assert pricing.preis("claude-sonnet-5", date(2026, 9, 1)) == (3.00, 15.00)


def test_ohne_datum_gilt_der_listenpreis():
    """Konservativ: kein Tag angegeben -> kein Rabatt annehmen."""
    assert pricing.preis("claude-sonnet-5") == (3.00, 15.00)


def test_cache_reads_kosten_ein_zehntel_des_inputs():
    voll = pricing.kosten_eur("claude-sonnet-4-6", 1_000_000, 0, 0)
    cache = pricing.kosten_eur("claude-sonnet-4-6", 0, 1_000_000, 0)
    assert abs(cache - voll * 0.1) < 1e-9


def test_gemessenes_profil_ergibt_plausible_kosten():
    """n8n-Betriebsingenieur, 60-Tage-Schnitt je Call: 18 in / 442.515 cached /
    1.830 out. Bei Sonnet 4.6 rund 15 Cent — die Groessenordnung, gegen die
    die Hochrechnung vom 31.07. geprueft wurde."""
    eur = pricing.kosten_eur("claude-sonnet-4-6", 18, 442_515, 1_830)
    assert 0.13 < eur < 0.17, eur


def test_formatierung_deutsch():
    assert pricing.fmt_eur(1234.5) == "1.234,50 €"
    assert pricing.fmt_eur(None) == "?"
