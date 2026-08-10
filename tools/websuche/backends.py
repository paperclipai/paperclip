"""Suchquellen für den Websuche-Dienst.

Bewusst schmal gehalten: wer eine andere Suchquelle anbinden will, baut eine
Klasse mit derselben `suche()`-Signatur und tauscht sie in `websuche.py` ein.
Agenten, n8n und die Bots merken davon nichts.
"""
from __future__ import annotations

from dataclasses import dataclass

import requests


class BackendFehler(Exception):
    """Die Suchquelle war nicht erreichbar oder hat unbrauchbar geantwortet.

    Wird bewusst geworfen statt eine leere Trefferliste zurückzugeben: eine
    leere Liste liest sich für ein Modell als "nichts gefunden", und der Agent
    schreibt dann "keine Quellen gefunden" ins Dossier, statt zu eskalieren.
    """


@dataclass(frozen=True)
class Treffer:
    url: str
    titel: str
    snippet: str


class SearxngBackend:
    def __init__(self, basis_url: str = "http://127.0.0.1:8888", timeout: float = 8.0):
        self.basis_url = basis_url.rstrip("/")
        self.timeout = timeout

    def suche(self, frage: str, limit: int) -> list[Treffer]:
        try:
            antwort = requests.get(
                f"{self.basis_url}/search",
                params={"q": frage, "format": "json"},
                timeout=self.timeout,
            )
            antwort.raise_for_status()
            daten = antwort.json()
        except requests.exceptions.ConnectionError as e:
            raise BackendFehler(
                f"SearXNG unter {self.basis_url} nicht erreichbar: {e}") from e
        except requests.exceptions.Timeout as e:
            raise BackendFehler(
                f"SearXNG unter {self.basis_url} antwortet nicht innerhalb "
                f"von {self.timeout}s") from e
        except requests.exceptions.RequestException as e:
            raise BackendFehler(f"SearXNG-Anfrage fehlgeschlagen: {e}") from e
        except ValueError as e:
            raise BackendFehler(
                f"SearXNG lieferte kein verwertbares JSON: {e}") from e

        roh = daten.get("results")
        if not isinstance(roh, list):
            raise BackendFehler("SearXNG-Antwort ohne Feld 'results'")

        treffer = []
        for eintrag in roh:
            url = (eintrag.get("url") or "").strip()
            if not url:
                continue
            treffer.append(Treffer(
                url=url,
                titel=(eintrag.get("title") or "").strip(),
                snippet=(eintrag.get("content") or "").strip(),
            ))
            if len(treffer) >= limit:
                break
        return treffer
