"""Gemeinsame Test-Voreinstellungen.

Sperrt das Produktivlog fuer die GANZE Suite. Ohne das schreiben Testlaeufe
in `~/.paperclip/logs/vault-nas-sync.log` — am 22.08.2026 stand dort
„ABBRUCH: rsync nicht gefunden: /gibt/es/nicht/rsync", was aus einem Test kam
und beim Nachsehen wie ein echter Vorfall aussah.
"""
import pytest


@pytest.fixture(autouse=True)
def kein_produktivlog(monkeypatch):
    monkeypatch.setenv("SYNC_STILL", "1")
