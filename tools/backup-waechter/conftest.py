"""Gemeinsame Test-Voreinstellungen.

Legt die Schreibsperre fuers Produktivlog fuer die GANZE Suite um, nicht nur
in einzelnen Tests: sonst muss jeder neue Test daran denken, und einer
vergisst es. Am 22.08.2026 standen deshalb Testartefakte im echten
Waechter-Log („NAS nicht lesbar: .../pytest-...").
"""
import os

import pytest


@pytest.fixture(autouse=True)
def kein_produktivlog(monkeypatch):
    monkeypatch.setenv("WAECHTER_STILL", "1")
