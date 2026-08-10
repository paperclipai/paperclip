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


# Ab so vielen ausgefallenen Engines ist ein nicht-leeres Ergebnis zwar
# brauchbar, aber nicht mehr repraesentativ — SearXNG faehrt gut ein Dutzend
# Engines, drei Ausfaelle sind ein spuerbarer Teil davon.
WARNUNG_AB_ENGINES = 3


def _ausgefallene_engines(roh) -> list[str]:
    """Normalisiert `unresponsive_engines` zu lesbaren Klartext-Eintraegen.

    SearXNG liefert je nach Stand Paare (`["startpage", "Suspended: CAPTCHA"]`)
    oder Objekte; beides wird hier auf "name (grund)" gebracht.
    """
    eintraege = []
    for roh_eintrag in roh or []:
        if isinstance(roh_eintrag, dict):
            name = roh_eintrag.get("name") or roh_eintrag.get("engine") or "?"
            grund = roh_eintrag.get("error") or roh_eintrag.get("reason") or ""
        elif isinstance(roh_eintrag, (list, tuple)):
            name = roh_eintrag[0] if roh_eintrag else "?"
            grund = roh_eintrag[1] if len(roh_eintrag) > 1 else ""
        else:
            name, grund = roh_eintrag, ""
        name, grund = str(name).strip(), str(grund).strip()
        eintraege.append(f"{name} ({grund})" if grund else name)
    return eintraege


class SearxngBackend:
    def __init__(self, basis_url: str = "http://127.0.0.1:8888", timeout: float = 8.0):
        self.basis_url = basis_url.rstrip("/")
        self.timeout = timeout
        # Nicht-blockierende Warnung des letzten Laufs; `websuche` haengt sie
        # an den `hinweis` an. Bewusst ein Attribut statt eines zweiten
        # Rueckgabewerts, damit die Signatur `suche(frage, limit) -> list`
        # als Tauschstelle fuer andere Backends erhalten bleibt.
        self.letzte_warnung: str | None = None

    def suche(self, frage: str, limit: int) -> list[Treffer]:
        self.letzte_warnung = None
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

        ausgefallen = _ausgefallene_engines(daten.get("unresponsive_engines"))

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

        # HTTP 200 mit leerer Trefferliste ist der gefaehrlichste Fall: genau
        # so antwortet SearXNG, wenn seine Engines in CAPTCHA oder Rate-Limit
        # laufen. Ohne Fehler liest der Agent das als "es gibt dazu nichts".
        if not treffer:
            if ausgefallen:
                raise BackendFehler(
                    f"SearXNG hat gesucht, aber kein einziger Treffer kam "
                    f"zurueck, weil {len(ausgefallen)} Engine(s) ausgefallen "
                    f"sind: {', '.join(ausgefallen)}. Das heisst NICHT, dass es "
                    f"zu dieser Frage keine Quellen gibt — der Suchdienst ist "
                    f"gerade blockiert. Spaeter erneut versuchen bzw. "
                    f"eskalieren, statt 'keine Quellen gefunden' zu berichten.")
            raise BackendFehler(
                "SearXNG lieferte keinen einzigen Treffer, und keine Engine "
                "meldete einen Ausfall. Entweder ist die Frage zu eng gefasst "
                "oder die Engine-Anbindung ist stumm defekt — vor einem "
                "'keine Quellen gefunden' im Dossier von Hand nachpruefen.")

        if len(ausgefallen) >= WARNUNG_AB_ENGINES:
            # Blockiert bewusst nicht: es gibt ja Treffer. Der Aufrufer haengt
            # das an den `hinweis`, damit die Luecke im Dossier sichtbar wird.
            self.letzte_warnung = (
                f"{len(ausgefallen)} Suchmaschinen waren waehrend der Suche "
                f"ausgefallen ({', '.join(ausgefallen)}) — die Trefferliste ist "
                f"moeglicherweise unvollstaendig.")
        return treffer
