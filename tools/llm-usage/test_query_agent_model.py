#!/usr/bin/env python3
"""Integrationstest der Tages-Abfrage gegen die echte Paperclip-DB.

Aufruf: python3 -m pytest test_query_agent_model.py -q
Ohne laufende DB werden die Tests uebersprungen, nicht rot.
"""
import socket

import pytest

import query


def _db_da() -> bool:
    try:
        socket.create_connection(("127.0.0.1", 54329), 1).close()
        return True
    except OSError:
        return False


needs_db = pytest.mark.skipif(not _db_da(), reason="Paperclip-DB laeuft nicht")

# Ein Tag mit bekanntem Volumen (306 Aufrufe, erhoben am 20.08.2026).
TAG = "2026-08-19"


@needs_db
def test_agentensumme_entspricht_der_modellsumme():
    """Die Notiz zeigt beide Tabellen nebeneinander — weichen sie ab, ist eine
    von beiden falsch, und der Leser merkt es nie. Genau das faengt dieser Test.
    """
    modell = query.per_llm_on_day(TAG)
    agent = query.agent_model_on_day(TAG)
    assert sum(r[1] for r in modell) == sum(r[2] for r in agent)


@needs_db
def test_je_agent_modell_kombination_nur_einmal():
    rows = query.agent_model_on_day(TAG)
    paare = [(a, m) for a, m, *_ in rows]
    assert len(paare) == len(set(paare))


@needs_db
def test_token_stimmen_mit_der_modellabfrage_ueberein():
    modell = query.per_llm_on_day(TAG)
    agent = query.agent_model_on_day(TAG)
    assert sum(r[2] or 0 for r in modell) == sum(
        (r[3] or 0) + (r[5] or 0) for r in agent
    )


@needs_db
def test_leerer_tag_liefert_leere_liste():
    """Vor dem ersten Datensatz (16.04.2026) gibt es nichts."""
    assert query.agent_model_on_day("2026-01-01") == []
