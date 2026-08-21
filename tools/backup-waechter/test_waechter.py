#!/usr/bin/env python3
"""Tests der Stand-Ermittlung. Aufruf: python3 -m pytest test_waechter.py -q

Hier geht es um den Fall, der im Ernstfall zählt: die Quelle ist weg. Ein
Wächter, der dann „alles gut" meldet, ist gefährlicher als gar keiner.
"""
import waechter


def test_fehlender_ordner_ergibt_unbekannt_nicht_gesund(tmp_path):
    stand, anzahl = waechter.db_stand(str(tmp_path / "gibtsnicht"))
    assert stand is None
    assert anzahl == 0


def test_leerer_ordner_ergibt_unbekannt(tmp_path):
    """NAS erreichbar, aber keine einzige Sicherung darin — auch das ist ein
    Alarm und kein „alles gut"."""
    stand, anzahl = waechter.db_stand(str(tmp_path))
    assert stand is None
    assert anzahl == 0


def test_juengste_sicherung_gewinnt(tmp_path):
    import os
    import time
    alt = tmp_path / "paperclip-2026-08-01.dump"
    neu = tmp_path / "paperclip-2026-08-21.dump"
    alt.write_text("x")
    neu.write_text("x")
    os.utime(alt, (time.time() - 86400, time.time() - 86400))
    stand, anzahl = waechter.db_stand(str(tmp_path))
    assert anzahl == 2
    assert stand.timestamp() > (time.time() - 60)


def test_fremde_dateien_zaehlen_nicht(tmp_path):
    """Im Zielordner können andere Sicherungen liegen."""
    (tmp_path / "n8n-database.sqlite").write_text("fremd")
    (tmp_path / "paperclip-globals-2026-08-21.sql").write_text("globals")
    stand, anzahl = waechter.db_stand(str(tmp_path))
    assert anzahl == 0 and stand is None
