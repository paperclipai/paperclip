#!/usr/bin/env python3
"""Tests des Modell-Steckbriefs (Quantisierung, Kontextfenster, Thinking).

Aufruf: python3 -m pytest test_steckbrief.py -q
"""
import json

import steckbrief

# Auszug aus einer echten Antwort von GET :1234/api/v0/models
KATALOG = {"data": [
    {"id": "gemma4-31b-it", "quantization": "Q8_0", "state": "loaded",
     "max_context_length": 262144, "loaded_context_length": 98304,
     "compatibility_type": "gguf"},
    {"id": "gemma-4-31b-it-mlx", "quantization": "8bit", "state": "loaded",
     "max_context_length": 262144, "loaded_context_length": 262144,
     "compatibility_type": "mlx"},
    {"id": "abiray/qwen3.6-35b-a3b", "quantization": "Q6_K", "state": "loaded",
     "max_context_length": 262144, "loaded_context_length": 98304,
     "compatibility_type": "gguf"},
    # nicht geladen: Quantisierung bekannt, Kontextfenster nicht
    {"id": "ornith-1.0-9b", "quantization": "4bit", "state": "not-loaded",
     "max_context_length": 262144, "loaded_context_length": None,
     "compatibility_type": "mlx"},
]}


# --------------------------------------------------------------------------- #
# Katalog
# --------------------------------------------------------------------------- #
def test_katalog_liefert_quantisierung_und_geladenes_fenster():
    k = steckbrief.parse_katalog(KATALOG)
    assert k["gemma4-31b-it"] == {"quant": "Q8_0", "ctx": 98304}
    assert k["gemma-4-31b-it-mlx"] == {"quant": "8bit", "ctx": 262144}


def test_nicht_geladenes_modell_behaelt_die_quantisierung():
    """`quantization` steht auch bei `state: not-loaded` — das Fenster nicht,
    denn ungeladen ist keins gesetzt."""
    k = steckbrief.parse_katalog(KATALOG)
    assert k["ornith-1.0-9b"] == {"quant": "4bit", "ctx": None}


def test_kaputter_katalog_liefert_nichts_statt_muell():
    assert steckbrief.parse_katalog({}) == {}
    assert steckbrief.parse_katalog({"data": "nope"}) == {}


# --------------------------------------------------------------------------- #
# Thinking aus den LM-Studio-Logs
# --------------------------------------------------------------------------- #
def _log(modell, reasoning_tokens):
    block = json.dumps({"usage": {"completion_tokens_details":
                                  {"reasoning_tokens": reasoning_tokens}}})
    return f"[2026-08-22 09:00:00][INFO][{modell}] Generated prediction: {block}\n"


def test_denkquote_zaehlt_vorhersagen_mit_reasoning_tokens():
    text = (_log("qwen3.6-35b-a3b-mlx", 120) + _log("qwen3.6-35b-a3b-mlx", 90)
            + _log("qwen3.6-35b-a3b-mlx", 0) + _log("gemma-4-31b-it-mlx", 0))
    assert steckbrief.parse_denk_log(text) == {
        "qwen3.6-35b-a3b-mlx": [3, 2],
        "gemma-4-31b-it-mlx": [1, 0],
    }


def test_denkquote_ignoriert_fremde_logzeilen():
    """Die Logs stecken voller Stacktraces und Fehlerbloecke."""
    text = ("[2026-08-22 09:00:00][ERROR][gemma4-31b-it] Error: Channel Error\n"
            "    at async run (index.js:322)\n" + _log("gemma4-31b-it", 0))
    assert steckbrief.parse_denk_log(text) == {"gemma4-31b-it": [1, 0]}


def test_abgeschnittener_logblock_kippt_den_lauf_nicht():
    """Die Datei der laufenden Stunde endet mitten im Block."""
    text = _log("gemma4-31b-it", 5) + '[2026-08-22 09:01:00][INFO][x] Generated prediction: {"usa'
    assert steckbrief.parse_denk_log(text) == {"gemma4-31b-it": [1, 1]}


# --------------------------------------------------------------------------- #
# Darstellung
# --------------------------------------------------------------------------- #
def test_kontextfenster_wird_als_zweierpotenz_beschriftet():
    assert steckbrief.fmt_ctx(262144) == "256K"
    assert steckbrief.fmt_ctx(131072) == "128K"
    assert steckbrief.fmt_ctx(98304) == "96K"
    assert steckbrief.fmt_ctx(65536) == "64K"
    assert steckbrief.fmt_ctx(8192) == "8K"


def test_anthropic_fenster_sind_dezimal_nicht_binaer():
    """200.000 / 1024 waere '195K' — falsch. Anthropic zaehlt dezimal."""
    assert steckbrief.fmt_ctx(200_000) == "200K"
    assert steckbrief.fmt_ctx(1_000_000) == "1M"


def test_krummes_fenster_wird_gerundet_nicht_verschwiegen():
    """65024 ist ein real vorgekommener Wert (LM Studio rundet selbst)."""
    assert steckbrief.fmt_ctx(65024) == "64K"
    assert steckbrief.fmt_ctx(None) == "?"


def test_thinking_zeigt_zustand_und_quote():
    """`off` ohne Quote wuerde verschweigen, dass gemma4-31b-it trotz Patch
    noch bei 1,2 % denkt."""
    assert steckbrief.fmt_thinking(0.970) == "on (97 %)"
    assert steckbrief.fmt_thinking(0.181) == "on (18 %)"
    assert steckbrief.fmt_thinking(0.012) == "off (1 %)"
    assert steckbrief.fmt_thinking(0.0) == "off (0 %)"


def test_sehr_kleine_quote_wird_nicht_zu_null_gerundet():
    """0,1 % sind nicht 0 — der PII-Classifier lag genau dort."""
    assert steckbrief.fmt_thinking(0.001) == "off (0,1 %)"


def test_ohne_messung_wird_nichts_behauptet():
    assert steckbrief.fmt_thinking(None) == "?"


# --------------------------------------------------------------------------- #
# Zugriff je Modell
# --------------------------------------------------------------------------- #
SB = {
    "katalog": {"gemma4-31b-it": {"quant": "Q8_0", "ctx": 98304}},
    "denken": {"gemma4-31b-it": [1000, 12]},
}


def test_lokales_modell_aus_dem_katalog():
    assert steckbrief.quant("gemma4-31b-it", SB) == "Q8_0"
    assert steckbrief.ctx("gemma4-31b-it", SB) == "96K"
    assert steckbrief.thinking("gemma4-31b-it", SB) == "off (1 %)"


def test_anthropic_hat_keine_quantisierung_aber_ein_bekanntes_fenster():
    assert steckbrief.quant("claude-sonnet-4-6", SB) == "–"
    assert steckbrief.ctx("claude-sonnet-4-6", SB) == "200K"


def test_die_1m_variante_bekommt_ihr_grosses_fenster():
    """`claude-opus-4-7[1m]` taucht so in cost_events auf."""
    assert steckbrief.ctx("claude-opus-4-7[1m]", SB) == "1M"
    assert steckbrief.ctx("claude-opus-4-7", SB) == "200K"


def test_thinking_bei_anthropic_wird_nicht_behauptet():
    """cost_events fuehrt keine Reasoning-Token, und die claude_local-Agenten
    haben kein Thinking-Feld in der adapter_config. '?' ist die einzige
    ehrliche Antwort — 'off' waere geraten."""
    assert steckbrief.thinking("claude-sonnet-4-6", SB) == "?"


def test_unbekanntes_lokales_modell_bleibt_fragezeichen():
    assert steckbrief.quant("irgendwas/neu", SB) == "?"
    assert steckbrief.ctx("irgendwas/neu", SB) == "?"
    assert steckbrief.thinking("irgendwas/neu", SB) == "?"


def test_stillgelegtes_modell_kommt_aus_der_ersatztabelle():
    """`qwen3.6-35b-a3b-mlx` hatte gestern 26 Aufrufe, steht aber nicht mehr im
    Katalog. Ohne Ersatzeintrag stuende dort dauerhaft '?'."""
    leer = {"katalog": {}, "denken": {}}
    assert steckbrief.quant("qwen3.6-35b-a3b-mlx", leer) == "8bit"
    assert steckbrief.ctx("qwen3.6-35b-a3b-mlx", leer) == "256K"


def test_katalog_schlaegt_ersatztabelle():
    """Der Live-Wert gewinnt — die Ersatztabelle ist nur das Netz."""
    sb = {"katalog": {"qwen3.6-35b-a3b-mlx": {"quant": "6bit", "ctx": 131072}},
          "denken": {}}
    assert steckbrief.quant("qwen3.6-35b-a3b-mlx", sb) == "6bit"
    assert steckbrief.ctx("qwen3.6-35b-a3b-mlx", sb) == "128K"


def test_unvollstaendige_modelle_werden_gemeldet():
    """Gleiches Muster wie bei Preis und Ort: eine Luecke soll auffallen."""
    assert steckbrief.unvollstaendig(
        ["gemma4-31b-it", "claude-sonnet-4-6", "irgendwas/neu"], SB
    ) == ["irgendwas/neu"]


# --------------------------------------------------------------------------- #
# Cache
# --------------------------------------------------------------------------- #
def test_cache_traegt_ueber_die_nacht(tmp_path):
    """Die RTX ist um 08:00 gerade erst wieder da bzw. noch aus — dann liefert
    der Katalog ihre Modelle nicht, der Report soll sie trotzdem ausweisen."""
    pfad = tmp_path / "cache.json"
    steckbrief.schreibe_cache({"gemma4-31b-it": {"quant": "Q8_0", "ctx": 98304}}, pfad)
    assert steckbrief.lies_cache(pfad) == {
        "gemma4-31b-it": {"quant": "Q8_0", "ctx": 98304}}


def test_cache_wird_vom_katalog_ueberschrieben_nicht_ersetzt(tmp_path):
    """Ein Modell, das heute fehlt, darf nicht aus dem Cache fallen."""
    pfad = tmp_path / "cache.json"
    steckbrief.schreibe_cache({"alt": {"quant": "Q4_K_M", "ctx": 8192},
                               "gemma4-31b-it": {"quant": "Q6_K", "ctx": 65536}}, pfad)
    verschmolzen = steckbrief.verschmelze(
        steckbrief.lies_cache(pfad), {"gemma4-31b-it": {"quant": "Q8_0", "ctx": 98304}})
    assert verschmolzen["alt"] == {"quant": "Q4_K_M", "ctx": 8192}
    assert verschmolzen["gemma4-31b-it"] == {"quant": "Q8_0", "ctx": 98304}


def test_fehlender_cache_ist_kein_fehler(tmp_path):
    assert steckbrief.lies_cache(tmp_path / "gibtsnicht.json") == {}


def test_kaputter_cache_kippt_den_lauf_nicht(tmp_path):
    """Ein abgebrochener Schreibvorgang darf den 08:00-Lauf nicht verhindern."""
    pfad = tmp_path / "cache.json"
    pfad.write_text("{kaputt", encoding="utf-8")
    assert steckbrief.lies_cache(pfad) == {}


# --------------------------------------------------------------------------- #
# Erhebung ueber mehrere Tage (7-Tage-Excel)
# --------------------------------------------------------------------------- #
def test_denkzaehler_summiert_ueber_mehrere_tage(tmp_path):
    """Das Excel blickt sieben Tage zurueck — die Quote muss ueber den ganzen
    Zeitraum gebildet werden, nicht ueber einen Tag."""
    ordner = tmp_path / "2026-08"
    ordner.mkdir(parents=True)
    (ordner / "2026-08-21.09.log").write_text(_log("m", 5) + _log("m", 0),
                                              encoding="utf-8")
    (ordner / "2026-08-22.09.log").write_text(_log("m", 7), encoding="utf-8")
    z = steckbrief.denk_zaehler(["2026-08-21", "2026-08-22"], log_dir=str(tmp_path))
    assert z == {"m": [3, 2]}


def test_denkzaehler_nimmt_auch_einen_einzelnen_tag(tmp_path):
    ordner = tmp_path / "2026-08"
    ordner.mkdir(parents=True)
    (ordner / "2026-08-22.09.log").write_text(_log("m", 7), encoding="utf-8")
    assert steckbrief.denk_zaehler("2026-08-22", log_dir=str(tmp_path)) == {"m": [1, 1]}


def test_fehlender_logordner_ist_kein_fehler(tmp_path):
    """Auf einem anderen Rechner oder nach dem Aufraeumen gibt es die Logs
    nicht — dann steht in der Spalte '?', der Report laeuft weiter."""
    assert steckbrief.denk_zaehler("2026-08-22", log_dir=str(tmp_path)) == {}
