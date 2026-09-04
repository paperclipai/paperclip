"""Tests der Aufbewahrung im Auffangordner `_vault-geloescht/`.

Dieses Skript LOESCHT — und es loescht ausgerechnet das, was der Spiegel
aufgefangen hat, also die einzige Kopie einer im Vault geloeschten Datei.
Deshalb steht es wie `prune.sh` getrennt und wird gegen echte Ordner geprueft,
nicht gegen Attrappen.

Die Auswahl richtet sich AUSSCHLIESSLICH nach den vorhandenen Ordnern, nie
nach der Systemuhr: lief der Spiegel drei Tage nicht, soll trotzdem nichts
Zusaetzliches verschwinden.
"""
import subprocess
from pathlib import Path

import pytest

SKRIPT = Path(__file__).parent / "aufraeumen.sh"


def lauf(verzeichnis, taeglich=7, woechentlich=4, monatlich=3):
    e = subprocess.run(
        ["bash", str(SKRIPT), str(verzeichnis),
         str(taeglich), str(woechentlich), str(monatlich)],
        capture_output=True, text=True)
    assert e.returncode == 0, e.stderr
    return e.stdout


def lege_an(wurzel, *daten):
    for d in daten:
        ordner = wurzel / d
        ordner.mkdir(parents=True)
        (ordner / "notiz.md").write_text(f"Inhalt {d}")


def vorhanden(wurzel):
    return sorted(p.name for p in wurzel.iterdir())


# --- Grundfaelle -----------------------------------------------------------

def test_leeres_verzeichnis_ist_kein_fehler(tmp_path):
    assert lauf(tmp_path) == ""


def test_fehlendes_verzeichnis_meldet_fehler(tmp_path):
    e = subprocess.run(["bash", str(SKRIPT), str(tmp_path / "weg")],
                       capture_output=True, text=True)
    assert e.returncode != 0
    assert "nicht gefunden" in e.stderr


def test_weniger_als_die_taegliche_grenze_bleibt_unangetastet(tmp_path):
    daten = ["2026-09-01", "2026-09-02", "2026-09-03"]
    lege_an(tmp_path, *daten)
    lauf(tmp_path)
    assert vorhanden(tmp_path) == daten


# --- Die drei Stufen -------------------------------------------------------

def test_die_sieben_juengsten_tage_bleiben(tmp_path):
    """Kern der taeglichen Stufe: sieben Stueck, juengste zuerst."""
    daten = [f"2026-08-{t:02d}" for t in range(10, 31)]   # 10.–30.08.
    lege_an(tmp_path, *daten)
    lauf(tmp_path, taeglich=7, woechentlich=0, monatlich=0)
    assert vorhanden(tmp_path) == [f"2026-08-{t}" for t in range(24, 31)]


def test_je_woche_bleibt_der_juengste_stand(tmp_path):
    """08-30 ist ein Sonntag, also das Wochenende seiner ISO-Woche."""
    lege_an(tmp_path, "2026-08-24", "2026-08-26", "2026-08-30",  # eine Woche
                      "2026-08-31", "2026-09-02")               # naechste
    lauf(tmp_path, taeglich=0, woechentlich=2, monatlich=0)
    assert vorhanden(tmp_path) == ["2026-08-30", "2026-09-02"]


def test_je_monat_bleibt_der_juengste_stand(tmp_path):
    lege_an(tmp_path, "2026-06-05", "2026-06-30",
                      "2026-07-01", "2026-07-31",
                      "2026-08-15")
    lauf(tmp_path, taeglich=0, woechentlich=0, monatlich=3)
    assert vorhanden(tmp_path) == ["2026-06-30", "2026-07-31", "2026-08-15"]


def test_nur_die_juengsten_monate_zaehlen(tmp_path):
    """Vier Monate vorhanden, drei erlaubt — der aelteste faellt weg."""
    lege_an(tmp_path, "2026-05-31", "2026-06-30", "2026-07-31", "2026-08-31")
    lauf(tmp_path, taeglich=0, woechentlich=0, monatlich=3)
    assert vorhanden(tmp_path) == ["2026-06-30", "2026-07-31", "2026-08-31"]


def test_stufen_ueberlagern_sich_statt_sich_zu_addieren(tmp_path):
    """restic-Semantik: ein Stand, den schon die Tagesstufe haelt, verbraucht
    keinen zusaetzlichen Wochenplatz. Sonst waere die Aufbewahrung viel
    tiefer als 7/4/3 verspricht."""
    daten = [f"2026-08-{t:02d}" for t in range(1, 32)]
    lege_an(tmp_path, *daten)
    lauf(tmp_path, taeglich=7, woechentlich=4, monatlich=3)
    behalten = vorhanden(tmp_path)
    # 7 Tage: 25.–31.08.
    for t in range(25, 32):
        assert f"2026-08-{t}" in behalten
    # Wochenstaende davor: 08-23 und 08-16 (Sonntage), 08-09 als dritter.
    assert "2026-08-23" in behalten
    assert "2026-08-16" in behalten
    # Der Monatsstand August ist der 31., schon durch die Tagesstufe gedeckt.
    assert "2026-08-01" not in behalten


# --- Sicherheit ------------------------------------------------------------

def test_fremde_ordner_bleiben_unberuehrt(tmp_path):
    """Wie prune.sh: angefasst wird ausschliesslich das exakte Namensmuster.

    Im echten Auffangordner liegt `2026-08-22-erstlauf` — ein Sonderstand aus
    der Einrichtung, der dem Muster absichtlich NICHT entspricht.
    """
    lege_an(tmp_path, *[f"2026-08-{t:02d}" for t in range(1, 32)])
    lege_an(tmp_path, "2026-08-22-erstlauf")
    (tmp_path / "LIESMICH.txt").write_text("kein Tagesstand")
    lauf(tmp_path)
    behalten = vorhanden(tmp_path)
    assert "2026-08-22-erstlauf" in behalten
    assert "LIESMICH.txt" in behalten


def test_geloeschte_ordner_werden_gemeldet(tmp_path):
    lege_an(tmp_path, *[f"2026-08-{t:02d}" for t in range(1, 32)])
    ausgabe = lauf(tmp_path)
    assert "geloescht: 2026-08-01" in ausgabe


def test_inhalt_verschwindet_wirklich(tmp_path):
    """rm -rf muss den ganzen Baum nehmen, nicht nur leere Ordner."""
    lege_an(tmp_path, *[f"2026-08-{t:02d}" for t in range(1, 32)])
    tief = tmp_path / "2026-08-01" / "unter" / "tiefer"
    tief.mkdir(parents=True)
    (tief / "datei.md").write_text("x")
    lauf(tmp_path)
    assert not (tmp_path / "2026-08-01").exists()


def test_null_auf_allen_stufen_loescht_trotzdem_nicht_alles(tmp_path):
    """Schutzriegel: 0/0/0 ist mit Sicherheit ein Konfigurationsfehler.

    Ein Aufraeumer, der auf eine leere Konfiguration hin den ganzen
    Auffangordner raeumt, vernichtet die einzige Kopie geloeschter Notizen.
    Lieber nichts tun und meckern.
    """
    lege_an(tmp_path, "2026-08-01", "2026-08-02")
    e = subprocess.run(["bash", str(SKRIPT), str(tmp_path), "0", "0", "0"],
                       capture_output=True, text=True)
    assert e.returncode != 0
    assert vorhanden(tmp_path) == ["2026-08-01", "2026-08-02"]
