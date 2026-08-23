#!/usr/bin/env python3
"""Tests der Modell -> Ausfuehrungsort-Zuordnung.

Aufruf: python3 -m pytest test_hosts.py -q
"""
from datetime import date

import hosts


# --------------------------------------------------------------------------- #
# Zuordnung
# --------------------------------------------------------------------------- #
def test_anthropic_modelle_laufen_in_der_cloud():
    """Negativtest wie in pricing.ist_lokal(): alles `claude-*` ist Cloud, auch
    ein Modell, das die Tabelle noch nicht kennt. Ein neues Anthropic-Modell
    darf nie als 'unbekannt' erscheinen — sein Ort steht ohne Tabelle fest."""
    assert hosts.ort("claude-sonnet-4-6") == "Cloud"
    assert hosts.ort("claude-supernova-9") == "Cloud"


def test_1m_variante_zaehlt_wie_das_basismodell():
    """`claude-opus-4-7[1m]` taucht so in cost_events auf."""
    assert hosts.ort("claude-opus-4-7[1m]") == "Cloud"


def test_bekannte_lokale_modelle_auf_ihrem_geraet():
    """Stand 22.08.2026: Primaerpfad RTX, Netz MacBook, Studio haelt den 12b."""
    assert hosts.ort("gemma4-31b-it") == "RTX"
    assert hosts.ort("abiray/qwen3.6-35b-a3b") == "RTX"
    assert hosts.ort("gemma-4-31b-it-mlx") == "MacBook"
    assert hosts.ort("qwen3.6-35b-a3b-mlx") == "MacBook"
    assert hosts.ort("google/gemma-4-12b") == "Mac Studio"


def test_mlx_suffix_ist_kein_erkennungsmerkmal():
    """Die Falle aus project_rtx_pro_6000_node: `gemma4-31b-it` hat kein
    Suffix und laeuft trotzdem auf der RTX, `qwen/qwen3-coder-30b` ebenso
    wenig und laeuft auf der Studio. Wer nach '-mlx' raet, liegt falsch."""
    assert hosts.ort("gemma4-31b-it") != hosts.ort("gemma-4-31b-it-mlx")
    assert hosts.ort("qwen/qwen3-coder-30b") == "Mac Studio"


def test_unbekanntes_lokales_modell_wird_nicht_geraten():
    """Kernregel, analog zu pricing: lieber 'unbekannt' als eine erfundene
    Maschine. Sonst wandert eine falsche Angabe unbemerkt in den Report."""
    assert hosts.ort("irgendwas/neues-42b") == "unbekannt"
    assert hosts.unbekannte(
        ["irgendwas/neues-42b", "gemma4-31b-it", "claude-supernova-9"]
    ) == ["irgendwas/neues-42b"]


def test_leerer_modellname_ist_unbekannt():
    assert hosts.ort("") == "unbekannt"
    assert hosts.ort(None) == "unbekannt"


def test_stillgelegte_modelle_behalten_ihren_letzten_ort():
    """Die kumulative Vault-CSV reicht bis zum 16.04. zurueck. Ohne diese
    Eintraege stuenden dort 433 Zeilen auf 'unbekannt' — und zwar dauerhaft,
    denn ein deinstalliertes Modell kann nicht mehr umziehen und taucht in
    `lms ps` nie wieder auf."""
    # Vor Juli 2026 gab es nur den Mac Studio als LLM-Server.
    assert hosts.ort("qwen3.6-35b") == "Mac Studio"
    assert hosts.ort("google/gemma-4-26b-a4b") == "Mac Studio"
    assert hosts.ort("qwen2.5-32b-instruct-mlx") == "Mac Studio"
    # Danach verteilt: der Q8-Zwilling ohne Suffix lag auf der RTX.
    assert hosts.ort("qwen3.6-35b-a3b") == "RTX"
    assert hosts.ort("qwen/qwen3-coder-next") == "RTX"
    assert hosts.ort("openai/gpt-oss-120b") == "MacBook"


def test_vor_der_lastverteilung_lief_alles_lokale_auf_dem_mac_studio():
    """Bis zum 06.07.2026 war der Mac Studio der einzige LLM-Server; MacBook
    (LM Link) und RTX kamen erst mit der Lastverteilung an dem Tag dazu.
    `gemma-4-31b-it-mlx` laeuft HEUTE auf dem MacBook — im Mai lief es auf der
    Studio, und genau so gehoert es in die Historie."""
    assert hosts.ort("gemma-4-31b-it-mlx", date(2026, 5, 20)) == "Mac Studio"
    assert hosts.ort("qwen3.6-35b-a3b-mlx", date(2026, 6, 1)) == "Mac Studio"
    assert hosts.ort("gemma-4-31b-it-mlx", date(2026, 8, 22)) == "MacBook"


def test_der_stichtag_selbst_zaehlt_schon_zur_verteilten_flotte():
    """Am 06.07. wurde umverteilt — ab diesem Tag gilt die Tabelle."""
    assert hosts.ort("gemma-4-31b-it-mlx", date(2026, 7, 5)) == "Mac Studio"
    assert hosts.ort("gemma-4-31b-it-mlx", date(2026, 7, 6)) == "MacBook"


def test_cloud_modelle_kennen_keinen_stichtag():
    """Anthropic lief nie auf eigener Hardware."""
    assert hosts.ort("claude-opus-4-6[1m]", date(2026, 4, 16)) == "Cloud"


def test_ohne_datum_gilt_der_heutige_ort():
    """Die 7-Tage-Tabelle der Mail kennt keinen einzelnen Tag."""
    assert hosts.ort("gemma-4-31b-it-mlx") == "MacBook"


def test_datum_darf_auch_als_string_kommen():
    """digest.py reicht den Vortag als 'YYYY-MM-DD' durch, psycopg2 liefert ein
    `date`. Ein Vergleich str<date wuerfe mitten im 08:00-Lauf eine TypeError."""
    assert hosts.ort("gemma-4-31b-it-mlx", "2026-05-20") == "Mac Studio"
    assert hosts.ort("gemma-4-31b-it-mlx", "2026-08-22") == "MacBook"
    assert hosts.ort("gemma-4-31b-it-mlx", "kein Datum") == "MacBook"


def test_der_q8_zwilling_wird_nicht_mit_dem_mlx_modell_verwechselt():
    """`qwen3.6-35b-a3b` (RTX, Q8) und `qwen3.6-35b-a3b-mlx` (MacBook) sind
    zwei Maschinen — laut Memory die groesste Fehlerklasse der Flotte."""
    assert hosts.ort("qwen3.6-35b-a3b") == "RTX"
    assert hosts.ort("qwen3.6-35b-a3b-mlx") == "MacBook"


# --------------------------------------------------------------------------- #
# `lms ps` — Textausgabe parsen
# --------------------------------------------------------------------------- #
LMS_PS = (
    "IDENTIFIER                                 MODEL                                      STATUS        SIZE         CONTEXT    PARALLEL    DEVICE            TTL    \n"
    "abiray/qwen3.6-35b-a3b                     abiray/qwen3.6-35b-a3b                     IDLE          30.30 GB     98304      4           RTX Pro 6000             \n"
    "gemma-4-31b-it-mlx                         gemma-4-31b-it-mlx                         GENERATING    33.80 GB     262144     4           MacbookM5Mx128    1h / 1h\n"
    "google/gemma-4-12b                         google/gemma-4-12b                         IDLE          7.56 GB      98304      4           Local                    \n"
)


def test_lms_ps_liest_die_device_spalte():
    """`lms ps --json` liefert nur einen Geraete-Hash — die Klarnamen gibt es
    ausschliesslich in der Textausgabe."""
    assert hosts.parse_lms_ps(LMS_PS) == {
        "abiray/qwen3.6-35b-a3b": "RTX",
        "gemma-4-31b-it-mlx": "MacBook",
        "google/gemma-4-12b": "Mac Studio",
    }


def test_lms_ps_geraetename_mit_leerzeichen_bleibt_heil():
    """'RTX Pro 6000' enthaelt Leerzeichen, 'MacbookM5Mx128    1h / 1h' hat eine
    gefuellte TTL-Spalte dahinter. Ein split() auf Whitespace zerlegt beides
    falsch — deshalb wird nach Spaltenposition der Kopfzeile geschnitten."""
    parsed = hosts.parse_lms_ps(LMS_PS)
    assert parsed["abiray/qwen3.6-35b-a3b"] == "RTX"
    assert parsed["gemma-4-31b-it-mlx"] == "MacBook"


def test_lms_ps_ohne_kopfzeile_liefert_nichts_statt_muell():
    """LM Studio aus -> `lms ps` gibt eine Fehlermeldung. Die darf nicht als
    Geraetezuordnung durchgehen."""
    assert hosts.parse_lms_ps("") == {}
    assert hosts.parse_lms_ps("Error: no LM Studio instance found\n") == {}


def test_lms_ps_unbekannter_geraetename_bleibt_woertlich():
    """Ein viertes Geraet soll als Abweichung auffallen, nicht verschwinden."""
    text = (
        "IDENTIFIER    MODEL         STATUS    SIZE      CONTEXT    PARALLEL    DEVICE       TTL\n"
        "neues-modell  neues-modell  IDLE      1.00 GB   4096       1           Mini M6      \n"
    )
    assert hosts.parse_lms_ps(text) == {"neues-modell": "Mini M6"}


# --------------------------------------------------------------------------- #
# Abgleich Tabelle <-> Live
# --------------------------------------------------------------------------- #
def test_abweichung_wird_gemeldet_wenn_ein_modell_umgezogen_ist():
    """Der eigentliche Zweck des Live-Abgleichs: die Tabelle soll nicht still
    veralten, wenn ein Modell die Maschine wechselt."""
    live = {"gemma4-31b-it": "MacBook"}
    assert hosts.abweichungen(["gemma4-31b-it"], live) == [
        ("gemma4-31b-it", "RTX", "MacBook")
    ]


def test_nicht_geladenes_modell_ist_keine_abweichung():
    """Die RTX ist nachts aus, und `qwen3.6-35b-a3b-mlx` war am 23.08. gar
    nicht geladen. Fehlen in `lms ps` heisst 'entladen', nicht 'umgezogen'."""
    assert hosts.abweichungen(["gemma4-31b-it", "qwen3.6-35b-a3b-mlx"], {}) == []


def test_cloud_modelle_werden_nicht_gegen_lms_ps_geprueft():
    """Anthropic laeuft nicht in LM Studio — dort zu suchen ergibt nur Rauschen."""
    assert hosts.abweichungen(["claude-sonnet-4-6"], {}) == []


def test_unbekanntes_modell_das_live_liegt_wird_als_abweichung_gemeldet():
    """So kommt ein neues lokales Modell mitsamt seinem Geraet in die Warnzeile,
    statt nur als nacktes 'unbekannt' in der Tabelle zu stehen."""
    live = {"irgendwas/neues-42b": "RTX"}
    assert hosts.abweichungen(["irgendwas/neues-42b"], live) == [
        ("irgendwas/neues-42b", "unbekannt", "RTX")
    ]
