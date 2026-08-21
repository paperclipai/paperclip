#!/usr/bin/env python3
"""Tests der Wächter-Bewertung. Aufruf: python3 -m pytest test_pruefung.py -q

`bewerte()` ist bewusst eine reine Funktion: sie bekommt Zeitstempel und gibt
ein Urteil zurück, ohne NAS, ohne restic, ohne Mail. Nur so lassen sich die
Fälle prüfen, die im Ernstfall zählen — und die man sonst nie zu Gesicht
bekommt, weil sie hoffentlich nie eintreten.
"""
from datetime import datetime, timedelta

import pruefung

JETZT = datetime(2026, 8, 21, 9, 0)          # ein Freitag
MONTAG = datetime(2026, 8, 24, 9, 0)


def test_frische_sicherungen_sind_gesund():
    b = pruefung.bewerte(JETZT, JETZT - timedelta(hours=6), JETZT - timedelta(days=5))
    assert b.ok
    assert b.probleme == []


def test_zu_alte_db_sicherung_schlaegt_alarm():
    b = pruefung.bewerte(JETZT, JETZT - timedelta(hours=40), JETZT - timedelta(days=5))
    assert not b.ok
    assert any("Datenbank" in p for p in b.probleme), b.probleme


def test_zu_altes_vault_backup_schlaegt_alarm():
    """Läuft nur wöchentlich — deshalb eine eigene, großzügigere Grenze."""
    b = pruefung.bewerte(JETZT, JETZT - timedelta(hours=6), JETZT - timedelta(days=12))
    assert not b.ok
    assert any("Vault" in p for p in b.probleme), b.probleme


def test_beide_alt_werden_beide_genannt():
    """Sonst repariert man eins, ist beruhigt und übersieht das andere."""
    b = pruefung.bewerte(JETZT, JETZT - timedelta(hours=40), JETZT - timedelta(days=12))
    assert len(b.probleme) == 2


def test_unbekannt_ist_NICHT_gesund():
    """Der wichtigste Fall. Wenn der Wächter den Stand nicht ermitteln kann —
    NAS weg, restic nicht erreichbar — darf das niemals als „alles gut"
    durchgehen. Dieselbe Regel wie `None` statt `0` in pricing.py."""
    b = pruefung.bewerte(JETZT, None, None)
    assert not b.ok
    assert len(b.probleme) == 2
    assert all("unbekannt" in p.lower() or "keine" in p.lower() for p in b.probleme), b.probleme


def test_fehlende_db_sicherung_allein_reicht_fuer_alarm():
    b = pruefung.bewerte(JETZT, None, JETZT - timedelta(days=2))
    assert not b.ok
    assert len(b.probleme) == 1


def test_grenze_exakt_erreicht_ist_noch_gesund():
    b = pruefung.bewerte(JETZT, JETZT - timedelta(hours=30), JETZT - timedelta(days=9),
                         db_grenze_h=30, vault_grenze_tage=9)
    assert b.ok


def test_eine_minute_ueber_der_grenze_ist_es_nicht_mehr():
    b = pruefung.bewerte(JETZT,
                         JETZT - timedelta(hours=30, minutes=1),
                         JETZT - timedelta(days=9),
                         db_grenze_h=30, vault_grenze_tage=9)
    assert not b.ok


def test_bericht_nennt_das_alter_in_klartext():
    """Eine Alarmmail ohne Zahlen zwingt zum Nachgraben."""
    b = pruefung.bewerte(JETZT, JETZT - timedelta(hours=40), JETZT - timedelta(days=5))
    text = " ".join(b.zeilen)
    assert "40" in text or "1 Tag" in text
    assert "Datenbank" in text and "Vault" in text


def test_heartbeat_nur_montags():
    """Wöchentliche Lebendmeldung: bleibt sie aus, ist der Wächter tot."""
    assert pruefung.heartbeat_faellig(MONTAG)
    assert not pruefung.heartbeat_faellig(JETZT)


# --- Auswahl des richtigen Snapshots ---------------------------------------
# Form wie `restic snapshots --json`.
SNAPS = [
    {"time": "2026-05-24T09:33:48.1+02:00", "hostname": "MacStudioM4-8.local",
     "paths": ["/Users/w/.restic"], "tags": ["setup-test"]},
    {"time": "2026-08-09T03:30:06.2+02:00", "hostname": "MacStudio",
     "paths": ["/Users/w/Obsidian/WHITESTAG-Vault"],
     "tags": ["obsidian-vault", "automated"]},
    {"time": "2026-08-16T03:30:05.9+02:00", "hostname": "MacStudio",
     "paths": ["/Users/w/Obsidian/WHITESTAG-Vault"],
     "tags": ["obsidian-vault", "automated"]},
]


def test_waehlt_den_neuesten_vault_snapshot():
    stand = pruefung.neuester_snapshot(SNAPS, "obsidian-vault")
    assert stand == datetime(2026, 8, 16, 3, 30, 5)


def test_fremde_snapshots_werden_ignoriert():
    """Regression 21.08.2026: `restic snapshots --latest 1` liefert den
    neuesten Snapshot PRO GRUPPE (Host+Pfad), nicht einen insgesamt. Im Repo
    liegt noch ein `setup-test`-Snapshot vom 24.05.; wer blind das erste
    Element nimmt, meldet das Vault-Backup als 89 Tage alt."""
    nur_fremd = [SNAPS[0]]
    assert pruefung.neuester_snapshot(nur_fremd, "obsidian-vault") is None


def test_reihenfolge_der_liste_ist_egal():
    assert pruefung.neuester_snapshot(list(reversed(SNAPS)), "obsidian-vault") \
        == pruefung.neuester_snapshot(SNAPS, "obsidian-vault")


def test_leere_liste_ergibt_None():
    assert pruefung.neuester_snapshot([], "obsidian-vault") is None


def test_zukunftszeitstempel_gilt_nicht_als_alt():
    """Uhrzeitversatz zwischen Mac und NAS darf keinen Fehlalarm ausloesen."""
    b = pruefung.bewerte(JETZT, JETZT + timedelta(minutes=5), JETZT - timedelta(days=2))
    assert b.ok
