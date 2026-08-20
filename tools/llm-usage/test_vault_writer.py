#!/usr/bin/env python3
"""Tests des Vault-Schreibers. Aufruf: python3 -m pytest test_vault_writer.py -q

Schreibt ausschliesslich in tmp_path — der echte Vault wird nie angefasst.
"""
from datetime import date

import vault_writer

MODELL_ROWS = [
    ("qwen3.6-35b-a3b-mlx", 200, 1_000_000, 3600, 0.0),
    ("claude-sonnet-4-6", 100, 500_000, 1800, 1.73),
]
AGENT_MODELL_ROWS = [
    ("CTO", "qwen3.6-35b-a3b-mlx", 120, 600_000, 0, 60_000),
    ("CEO", "claude-sonnet-4-6", 40, 200_000, 50_000, 20_000),
]
TAG = date(2026, 8, 19)


def test_notiz_landet_unter_erwartetem_namen(tmp_path):
    pfad = vault_writer.schreibe_notiz(TAG, MODELL_ROWS, AGENT_MODELL_ROWS, tmp_path)
    assert pfad.name == "LLM-Nutzung 2026-08-19.md"
    assert "# LLM-Nutzung 2026-08-19" in pfad.read_text(encoding="utf-8")


def test_tag_ohne_daten_legt_keine_datei_an(tmp_path):
    assert vault_writer.schreibe_notiz(TAG, [], [], tmp_path) is None
    assert list(tmp_path.glob("*.md")) == []


def test_wiederholter_lauf_ueberschreibt_statt_zu_doppeln(tmp_path):
    vault_writer.schreibe_notiz(TAG, MODELL_ROWS, AGENT_MODELL_ROWS, tmp_path)
    vault_writer.schreibe_notiz(TAG, MODELL_ROWS, AGENT_MODELL_ROWS, tmp_path)
    assert len(list(tmp_path.glob("*.md"))) == 1


def test_csv_liegt_im_datenunterordner(tmp_path):
    """Getrennt von den Notizen: sonst steht im Obsidian-Explorer eine CSV
    zwischen 122 Tagesnotizen, die dort niemand sucht."""
    pfad = vault_writer.aktualisiere_csv(TAG, AGENT_MODELL_ROWS, tmp_path)
    assert pfad == tmp_path / "_daten" / "llm-nutzung.csv"
    assert list(tmp_path.glob("*.csv")) == []


def test_csv_bekommt_kopfzeile_und_datenzeilen(tmp_path):
    pfad = vault_writer.aktualisiere_csv(TAG, AGENT_MODELL_ROWS, tmp_path)
    zeilen = pfad.read_text(encoding="utf-8").strip().splitlines()
    assert zeilen[0] == "tag,agent,modell,aufrufe,token,kosten_eur"
    assert len(zeilen) == 3


def test_csv_aktualisierung_ist_idempotent(tmp_path):
    """Ein zweiter Lauf fuer denselben Tag darf die Zeilen nicht verdoppeln —
    sonst zaehlt jede Wiederholung des launchd-Jobs den Tag erneut mit."""
    vault_writer.aktualisiere_csv(TAG, AGENT_MODELL_ROWS, tmp_path)
    pfad = vault_writer.aktualisiere_csv(TAG, AGENT_MODELL_ROWS, tmp_path)
    zeilen = pfad.read_text(encoding="utf-8").strip().splitlines()
    assert len(zeilen) == 3


def test_csv_behaelt_die_uebrigen_tage(tmp_path):
    vault_writer.aktualisiere_csv(date(2026, 8, 18), AGENT_MODELL_ROWS, tmp_path)
    pfad = vault_writer.aktualisiere_csv(TAG, AGENT_MODELL_ROWS, tmp_path)
    inhalt = pfad.read_text(encoding="utf-8")
    assert "2026-08-18" in inhalt
    assert "2026-08-19" in inhalt
    assert len(inhalt.strip().splitlines()) == 5


def test_csv_ist_nach_tag_sortiert(tmp_path):
    vault_writer.aktualisiere_csv(TAG, AGENT_MODELL_ROWS, tmp_path)
    pfad = vault_writer.aktualisiere_csv(date(2026, 8, 18), AGENT_MODELL_ROWS, tmp_path)
    tage = [z.split(",")[0] for z in
            pfad.read_text(encoding="utf-8").strip().splitlines()[1:]]
    assert tage == sorted(tage)


def test_komma_im_agentennamen_zerlegt_die_csv_nicht(tmp_path):
    rows = [("Meier, Otto", "qwen3.6-35b-a3b-mlx", 5, 100, 0, 10)]
    pfad = vault_writer.aktualisiere_csv(TAG, rows, tmp_path)
    import csv
    with open(pfad, encoding="utf-8", newline="") as fh:
        zeilen = list(csv.reader(fh))
    assert zeilen[1][1] == "Meier, Otto"
    assert len(zeilen[1]) == 6


def test_schreibe_tag_erzeugt_notiz_und_csv(tmp_path):
    """Die gemeinsame Klammer fuer Digest und Backfill."""
    notiz, csv_pfad = vault_writer.schreibe_tag(
        TAG, MODELL_ROWS, AGENT_MODELL_ROWS, tmp_path)
    assert notiz.exists() and csv_pfad.exists()


def test_schreibe_tag_ohne_daten_laesst_den_vault_unberuehrt(tmp_path):
    """Ein leerer Tag darf weder Notiz noch CSV-Zeile hinterlassen."""
    notiz, csv_pfad = vault_writer.schreibe_tag(TAG, [], [], tmp_path)
    assert notiz is None and csv_pfad is None
    assert list(tmp_path.iterdir()) == []


def test_zielordner_wird_bei_bedarf_angelegt(tmp_path):
    ziel = tmp_path / "Analysen" / "LLM-Nutzung"
    pfad = vault_writer.schreibe_notiz(TAG, MODELL_ROWS, AGENT_MODELL_ROWS, ziel)
    assert pfad.exists()
