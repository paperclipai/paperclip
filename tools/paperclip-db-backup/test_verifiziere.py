#!/usr/bin/env python3
"""Tests des Verifikations-Gates. Aufruf: python3 -m pytest test_verifiziere.py -q

Das Gate entscheidet, ob ein frischer Dump auf die NAS darf und ob die
Aufbewahrung alte Sicherungen loeschen darf. Faellt es faelschlich positiv aus,
ersetzt eine kaputte Datei eine heile — der schlimmste denkbare Ausgang eines
Backups. Deshalb wird hier gegen echte Dumps und echten Muell geprueft.
"""
import shutil
import subprocess
from pathlib import Path

import pytest

SKRIPT = Path(__file__).parent / "verifiziere.sh"
PG_DUMP = "/opt/homebrew/bin/pg_dump"
DSN = ["-h", "127.0.0.1", "-p", "54329", "-U", "paperclip", "-d", "paperclip"]


def db_da():
    import socket
    try:
        socket.create_connection(("127.0.0.1", 54329), 1).close()
        return True
    except OSError:
        return False


needs_db = pytest.mark.skipif(
    not db_da() or not Path(PG_DUMP).exists(),
    reason="Paperclip-DB oder pg_dump nicht verfuegbar",
)


def lauf(pfad):
    return subprocess.run(
        ["/bin/bash", str(SKRIPT), str(pfad)], capture_output=True, text=True
    ).returncode


@needs_db
def test_echter_dump_besteht(tmp_path):
    ziel = tmp_path / "echt.dump"
    env = {"PGPASSWORD": "paperclip", "PATH": "/usr/bin:/bin"}
    r = subprocess.run(
        [PG_DUMP, *DSN, "-Fc", "-t", "cost_events", "-f", str(ziel)],
        capture_output=True, text=True, env=env,
    )
    assert r.returncode == 0, r.stderr
    assert lauf(ziel) == 0


@needs_db
def test_dump_mit_vielen_eintraegen_besteht(tmp_path):
    """Regression 21.08.2026: das Gate wies den ECHTEN Dump zurueck.

    Ursache war `set -o pipefail` zusammen mit `echo "$x" | grep -q`: grep
    steigt beim ersten Treffer aus, echo bekommt SIGPIPE und endet mit 141,
    und pipefail reicht die 141 als Ergebnis der Pipeline durch — die Pruefung
    schlug also fehl, WEIL sie erfolgreich war.

    Der Fehler haengt an der Groesse der `--list`-Ausgabe, nicht an der des
    Dumps: bei wenigen Eintraegen schreibt echo fertig, bevor grep aussteigt.
    Deshalb reicht hier ein Schema-Dump (klein, aber ueber 900 Eintraege) —
    der Ein-Tabellen-Dump im Test darueber hat den Fehler nie ausgeloest.
    """
    ziel = tmp_path / "schema.dump"
    env = {"PGPASSWORD": "paperclip", "PATH": "/usr/bin:/bin"}
    r = subprocess.run([PG_DUMP, *DSN, "-Fc", "-s", "-f", str(ziel)],
                       capture_output=True, text=True, env=env)
    assert r.returncode == 0, r.stderr
    liste = subprocess.run(["/opt/homebrew/bin/pg_restore", "--list", str(ziel)],
                           capture_output=True, text=True)
    assert len(liste.stdout.splitlines()) > 500, "Testdump zu klein fuer die Regression"
    assert lauf(ziel) == 0


def test_muell_faellt_durch(tmp_path):
    datei = tmp_path / "muell.dump"
    datei.write_bytes(b"das ist kein Postgres-Dump" * 100)
    assert lauf(datei) != 0


def test_leere_datei_faellt_durch(tmp_path):
    """Der wahrscheinlichste Schadensfall: pg_dump bricht ab, Datei bleibt leer."""
    datei = tmp_path / "leer.dump"
    datei.touch()
    assert lauf(datei) != 0


@needs_db
def test_abgeschnittener_dump_faellt_durch(tmp_path):
    """Ein Abbruch mitten im Schreiben — SMB-Aussetzer, volle Platte."""
    voll = tmp_path / "voll.dump"
    env = {"PGPASSWORD": "paperclip", "PATH": "/usr/bin:/bin"}
    subprocess.run([PG_DUMP, *DSN, "-Fc", "-t", "cost_events", "-f", str(voll)],
                   check=True, capture_output=True, env=env)
    halb = tmp_path / "halb.dump"
    daten = voll.read_bytes()
    halb.write_bytes(daten[: len(daten) // 2])
    assert lauf(halb) != 0


def test_fehlende_datei_faellt_durch(tmp_path):
    assert lauf(tmp_path / "gibtsnicht.dump") != 0
