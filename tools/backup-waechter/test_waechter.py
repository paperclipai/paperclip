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


def test_tests_verschmutzen_das_produktivlog_nicht(tmp_path, monkeypatch):
    """Am 22.08.2026 standen im echten Waechter-Log Zeilen wie
    „NAS nicht lesbar: /private/var/folders/.../pytest-...", geschrieben von
    der Testsuite. Wer spaeter einen Ausfall untersucht, haelt so einen
    Testlauf fuer einen echten Vorfall. Das Log ist Diagnosewerkzeug und
    gehoert deshalb sauber."""
    log = tmp_path / "prod.log"
    monkeypatch.setattr(waechter, "LOG", str(log))
    monkeypatch.setenv("WAECHTER_STILL", "1")
    waechter.db_stand(str(tmp_path / "gibtsnicht"))
    assert not log.exists() or log.read_text() == "", \
        f"Test hat ins Log geschrieben: {log.read_text()!r}"


def test_vault_spiegel_auf_der_nas_wird_erkannt(tmp_path):
    """Fuenfter Datensatz seit 22.08.2026: der Vault-Spiegel auf der NAS.
    Sein Alter kommt aus der Statusdatei des Sync-Skripts, nicht aus einer
    Verzeichnis-mtime — ein Ordner kann frisch aussehen, obwohl der Lauf
    abgebrochen ist."""
    import json
    s = tmp_path / "status.json"
    s.write_text(json.dumps({"stand": "ok", "zeit": "2026-08-22 04:00:11"}))
    assert waechter.status_stand(str(s)) is not None


def test_gescheiterter_lauf_zaehlt_nicht_als_frisch(tmp_path):
    """Der springende Punkt: steht in der Statusdatei „fehler", darf ihr
    Zeitstempel nicht als erfolgreiche Sicherung durchgehen."""
    import json
    s = tmp_path / "status.json"
    s.write_text(json.dumps({"stand": "fehler", "zeit": "2026-08-22 04:00:11"}))
    assert waechter.status_stand(str(s)) is None


def test_fehlende_statusdatei_ergibt_unbekannt(tmp_path):
    assert waechter.status_stand(str(tmp_path / "gibtsnicht.json")) is None


def test_kaputte_statusdatei_ergibt_unbekannt(tmp_path):
    s = tmp_path / "status.json"
    s.write_text("kein json")
    assert waechter.status_stand(str(s)) is None
