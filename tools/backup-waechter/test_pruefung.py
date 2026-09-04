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
DONNERSTAG = datetime(2026, 8, 27, 9, 0)

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


def test_heartbeat_montags_und_donnerstags():
    """Lebendmeldung: bleibt sie aus, ist der Wächter selbst tot.

    Seit 04.09.2026 zweimal statt einmal die Woche. Mit nur montags war die
    Blindzeit sieben Tage: fiel der Wächter am Dienstag aus, hätte der Ausfall
    des Ausfallmelders erst am folgenden Montag auffallen können. Ein zweiter
    Termin halbiert das, ohne dass die Meldung zur täglichen Gewohnheit wird —
    und eine Meldung, die man gewohnheitsmäßig wegklickt, ist keine.
    """
    assert pruefung.heartbeat_faellig(MONTAG)
    assert pruefung.heartbeat_faellig(DONNERSTAG)
    assert not pruefung.heartbeat_faellig(JETZT)          # Freitag


def test_heartbeat_teilt_die_woche_moeglichst_gleichmaessig():
    """Mo+Do statt etwa Mo+Di: der längste stille Abschnitt soll klein sein.

    Do->Mo sind vier Tage, Mo->Do drei. Bei Mo+Di wären es sechs — dann hätte
    der zweite Termin fast nichts gebracht.
    """
    woche = [datetime(2026, 8, 24) + i * TAG for i in range(7)]
    faellig = [t for t in woche if pruefung.heartbeat_faellig(t)]
    assert len(faellig) == 2
    luecken = [(b - a).days for a, b in zip(faellig, faellig[1:])]
    luecken.append(7 - sum(luecken))
    assert max(luecken) <= 4


# --- Platzwarnung ----------------------------------------------------------
GB = 1024 ** 3


def test_reichlich_platz_ist_kein_problem():
    p, zeile = pruefung.bewerte_platz(12 * GB, 3000 * GB)
    assert p is None
    assert "12" in zeile and "%" in zeile


def test_ueber_der_schwelle_wird_gewarnt():
    p, _ = pruefung.bewerte_platz(2500 * GB, 3000 * GB)
    assert p is not None
    assert "83" in p or "84" in p, p


def test_schwelle_exakt_erreicht_warnt_schon():
    """Bei 80 % soll gewarnt werden, nicht erst darueber — sonst faellt die
    Warnung genau dann aus, wenn man sie zum ersten Mal braucht."""
    p, _ = pruefung.bewerte_platz(2400 * GB, 3000 * GB, schwelle=0.8)
    assert p is not None


def test_knapp_darunter_warnt_nicht():
    p, _ = pruefung.bewerte_platz(2399 * GB, 3000 * GB, schwelle=0.8)
    assert p is None


def test_ohne_hinterlegtes_kontingent_keine_warnung_aber_ein_hinweis():
    """Die Tarifgroesse verraet der Server nicht, sie ist von Hand
    eingetragen. Fehlt sie, ist das kein Alarm — sonst kaeme taeglich eine
    Mail, weil eine Konfigurationsangabe fehlt, nicht weil etwas kaputt ist."""
    p, zeile = pruefung.bewerte_platz(12 * GB, None)
    assert p is None
    assert "nicht hinterlegt" in zeile.lower()


def test_unbekannte_belegung_alarmiert_nicht_doppelt():
    """Kommt rclone nicht durch, sind die restic-Pruefungen ohnehin schon
    fehlgeschlagen und haben alarmiert. Ein zweiter Alarm fuer dieselbe
    Ursache macht die Meldung nur unleserlich."""
    p, zeile = pruefung.bewerte_platz(None, 3000 * GB)
    assert p is None
    assert "nicht ermittelbar" in zeile.lower()
