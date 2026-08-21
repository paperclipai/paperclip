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

TAG = timedelta(days=1)
STD = timedelta(hours=1)


def p(name, stand, grenze=30 * STD, quelle="NAS"):
    return pruefung.Pruefling(name=name, stand=stand, grenze=grenze, quelle=quelle)


def test_frische_sicherungen_sind_gesund():
    b = pruefung.bewerte(JETZT, [
        p("Datenbank (NAS)", JETZT - 6 * STD),
        p("Vault (Nextcloud)", JETZT - 5 * TAG, 9 * TAG, "restic"),
    ])
    assert b.ok
    assert b.probleme == []


def test_zu_alte_sicherung_schlaegt_alarm():
    b = pruefung.bewerte(JETZT, [p("Datenbank (NAS)", JETZT - 40 * STD)])
    assert not b.ok
    assert any("Datenbank" in x for x in b.probleme), b.probleme


def test_jede_ueberfaellige_wird_einzeln_genannt():
    """Sonst repariert man eine, ist beruhigt und übersieht die anderen."""
    b = pruefung.bewerte(JETZT, [
        p("A", JETZT - 40 * STD),
        p("B", JETZT - 40 * STD),
        p("C", JETZT - 1 * STD),
    ])
    assert len(b.probleme) == 2


def test_unbekannt_ist_NICHT_gesund():
    """Der wichtigste Fall. Wenn der Wächter den Stand nicht ermitteln kann —
    NAS weg, restic nicht erreichbar — darf das niemals als „alles gut"
    durchgehen. Dieselbe Regel wie `None` statt `0` in pricing.py."""
    b = pruefung.bewerte(JETZT, [p("A", None), p("B", None)])
    assert not b.ok
    assert len(b.probleme) == 2
    assert all("unbekannt" in x.lower() for x in b.probleme), b.probleme


def test_jede_sicherung_hat_ihre_eigene_frist():
    """Der Vault läuft wöchentlich, die Datenbank täglich — eine gemeinsame
    Grenze wäre für das eine zu streng und für das andere zu lasch."""
    b = pruefung.bewerte(JETZT, [
        p("taeglich", JETZT - 40 * STD, 30 * STD),
        p("woechentlich", JETZT - 40 * STD, 9 * TAG),
    ])
    assert len(b.probleme) == 1
    assert "taeglich" in b.probleme[0]


def test_grenze_exakt_erreicht_ist_noch_gesund():
    assert pruefung.bewerte(JETZT, [p("A", JETZT - 30 * STD, 30 * STD)]).ok


def test_eine_minute_ueber_der_grenze_ist_es_nicht_mehr():
    b = pruefung.bewerte(JETZT, [p("A", JETZT - 30 * STD - timedelta(minutes=1), 30 * STD)])
    assert not b.ok


def test_bericht_nennt_jede_sicherung_mit_alter():
    """Eine Alarmmail ohne Zahlen zwingt zum Nachgraben."""
    b = pruefung.bewerte(JETZT, [
        p("Datenbank (NAS)", JETZT - 40 * STD),
        p("Vault (Nextcloud)", JETZT - 5 * TAG, 9 * TAG, "restic"),
    ])
    text = " ".join(b.zeilen)
    assert "Datenbank (NAS)" in text and "Vault (Nextcloud)" in text
    assert "40" in text


def test_zukunftszeitstempel_gilt_nicht_als_alt():
    """Uhrzeitversatz zwischen Mac und NAS darf keinen Fehlalarm ausloesen."""
    assert pruefung.bewerte(JETZT, [p("A", JETZT + timedelta(minutes=5))]).ok


def test_leere_liste_ist_kein_stilles_ok():
    """Wenn gar nichts geprüft wurde, ist das kein Gesundheitszeugnis."""
    b = pruefung.bewerte(JETZT, [])
    assert not b.ok


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
    {"time": "2026-08-21T05:00:11.0+02:00", "hostname": "MacStudio",
     "paths": ["/Users/w/Library/CloudStorage/SynologyDrive-Mac/Claude Code MAC"],
     "tags": ["claude-code"]},
]


def test_waehlt_den_neuesten_snapshot_je_schlagwort():
    assert pruefung.neuester_snapshot(SNAPS, "obsidian-vault") \
        == datetime(2026, 8, 16, 3, 30, 5)
    assert pruefung.neuester_snapshot(SNAPS, "claude-code") \
        == datetime(2026, 8, 21, 5, 0, 11)


def test_fremde_snapshots_werden_ignoriert():
    """Regression 21.08.2026: `restic snapshots --latest 1` liefert den
    neuesten Snapshot PRO GRUPPE (Host+Pfad), nicht einen insgesamt. Im Repo
    lag ein `setup-test`-Snapshot vom 24.05.; wer blind das erste Element
    nimmt, meldet das Vault-Backup als 89 Tage alt.

    Seit die drei Datensätze im SELBEN Repo liegen, ist das noch wichtiger:
    ein frischer claude-code-Snapshot darf ein totes Vault-Backup nicht
    verdecken. Deshalb wird nach Schlagwort ausgewählt, nicht nach Datum."""
    assert pruefung.neuester_snapshot([SNAPS[0]], "obsidian-vault") is None
    assert pruefung.neuester_snapshot(SNAPS, "paperclip-db") is None


def test_reihenfolge_der_liste_ist_egal():
    assert pruefung.neuester_snapshot(list(reversed(SNAPS)), "obsidian-vault") \
        == pruefung.neuester_snapshot(SNAPS, "obsidian-vault")


def test_leere_liste_ergibt_None():
    assert pruefung.neuester_snapshot([], "obsidian-vault") is None


def test_heartbeat_nur_montags():
    """Wöchentliche Lebendmeldung: bleibt sie aus, ist der Wächter tot."""
    assert pruefung.heartbeat_faellig(MONTAG)
    assert not pruefung.heartbeat_faellig(JETZT)
