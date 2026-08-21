#!/usr/bin/env python3
"""Tests der Aufbewahrungslogik. Aufruf: python3 -m pytest test_prune.py -q

Warum diese Tests wichtiger sind als sie aussehen: `prune.sh` ist der einzige
Teil des Backups, der LOESCHT. Ein Fehler hier vernichtet echte Sicherungen,
und zwar unbemerkt — genau die Sorte Fehler, die erst im Ernstfall auffaellt.
Deshalb laeuft hier das echte Skript gegen echte Dateien in tmp_path.
"""
import subprocess
from pathlib import Path

import pytest

SKRIPT = Path(__file__).parent / "prune.sh"


def lauf(ordner, taeglich=30, monatlich=24):
    r = subprocess.run(
        ["/bin/bash", str(SKRIPT), str(ordner), str(taeglich), str(monatlich)],
        capture_output=True, text=True,
    )
    assert r.returncode == 0, r.stderr
    return r.stdout


def dump_anlegen(ordner, datum):
    """Ein Sicherungspaar anlegen, wie es das Backup schreibt."""
    (ordner / f"paperclip-{datum}.dump").write_text("dump")
    (ordner / f"paperclip-globals-{datum}.sql").write_text("globals")


def vorhandene_daten(ordner):
    return sorted(p.name[10:-5] for p in ordner.glob("paperclip-*.dump"))


def test_unter_dem_limit_wird_nichts_geloescht(tmp_path):
    for tag in range(2, 12):
        dump_anlegen(tmp_path, f"2026-08-{tag:02d}")
    lauf(tmp_path, taeglich=30)
    assert len(vorhandene_daten(tmp_path)) == 10


def test_ueber_dem_limit_fliegen_die_aeltesten(tmp_path):
    for tag in range(2, 21):  # 19 Dumps, keiner ein Monatserster
        dump_anlegen(tmp_path, f"2026-08-{tag:02d}")
    lauf(tmp_path, taeglich=5, monatlich=24)
    assert vorhandene_daten(tmp_path) == [
        "2026-08-16", "2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20"]


def test_globals_werden_mit_dem_dump_zusammen_geloescht(tmp_path):
    """Sonst bleibt ein Friedhof aus Rollen-Dateien ohne zugehoerigen Dump."""
    for tag in range(2, 11):
        dump_anlegen(tmp_path, f"2026-08-{tag:02d}")
    lauf(tmp_path, taeglich=3, monatlich=24)
    assert len(list(tmp_path.glob("paperclip-globals-*.sql"))) == 3


def test_monatserster_ueberlebt_die_taegliche_grenze(tmp_path):
    """Der Kern der Aufbewahrung: sonst reicht die Historie nur 30 Tage."""
    dump_anlegen(tmp_path, "2026-05-01")
    dump_anlegen(tmp_path, "2026-06-01")
    for tag in range(10, 21):
        dump_anlegen(tmp_path, f"2026-08-{tag:02d}")
    lauf(tmp_path, taeglich=5, monatlich=24)
    uebrig = vorhandene_daten(tmp_path)
    assert "2026-05-01" in uebrig
    assert "2026-06-01" in uebrig


def test_zu_viele_monatserste_werden_gedeckelt(tmp_path):
    for monat in range(1, 13):
        dump_anlegen(tmp_path, f"2025-{monat:02d}-01")
    lauf(tmp_path, taeglich=0, monatlich=3)
    assert vorhandene_daten(tmp_path) == ["2025-10-01", "2025-11-01", "2025-12-01"]


def test_fremde_dateien_werden_nicht_angefasst(tmp_path):
    """Im Zielordner koennen andere Sicherungen liegen — Finger weg."""
    (tmp_path / "wichtig.txt").write_text("nicht loeschen")
    (tmp_path / "n8n-database.sqlite").write_text("fremd")
    for tag in range(2, 11):
        dump_anlegen(tmp_path, f"2026-08-{tag:02d}")
    lauf(tmp_path, taeglich=2, monatlich=0)
    assert (tmp_path / "wichtig.txt").exists()
    assert (tmp_path / "n8n-database.sqlite").exists()


def test_leerer_ordner_ist_kein_fehler(tmp_path):
    lauf(tmp_path)
    assert list(tmp_path.iterdir()) == []


def test_meldet_was_geloescht_wurde(tmp_path):
    """Ein Backup, das stillschweigend loescht, ist nicht pruefbar."""
    for tag in range(2, 6):
        dump_anlegen(tmp_path, f"2026-08-{tag:02d}")
    ausgabe = lauf(tmp_path, taeglich=2, monatlich=0)
    assert "2026-08-02" in ausgabe and "2026-08-03" in ausgabe


def test_fehlender_ordner_bricht_ab_statt_stillzuhalten(tmp_path):
    r = subprocess.run(
        ["/bin/bash", str(SKRIPT), str(tmp_path / "gibtsnicht"), "30", "24"],
        capture_output=True, text=True,
    )
    assert r.returncode != 0
