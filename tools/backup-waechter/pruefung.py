#!/usr/bin/env python3
"""Bewertung des Sicherungsstands — reine Logik, kein I/O.

Getrennt vom Wächter, weil genau diese Entscheidung im Ernstfall zählt und
sich sonst nie prüfen ließe: die interessanten Fälle (NAS weg, restic stumm,
Sicherung zwei Tage alt) treten hoffentlich nie ein.

Python 3.9 — launchd fährt /usr/bin/python3, also kein `X | None`.
"""
import re
from datetime import datetime, timedelta
from typing import List, NamedTuple, Optional


class Pruefling(NamedTuple):
    """Eine zu überwachende Sicherung."""
    name: str
    stand: Optional[datetime]   # None = nicht ermittelbar
    grenze: timedelta           # ab hier gilt sie als überfällig
    quelle: str                 # woher der Stand kommt, für die Fehlermeldung


class Befund(NamedTuple):
    ok: bool
    probleme: List[str]
    zeilen: List[str]


def _alter_text(delta: timedelta) -> str:
    stunden = delta.total_seconds() / 3600
    if stunden < 48:
        return f"{stunden:.0f} Stunden"
    return f"{delta.days} Tage"


def bewerte(jetzt: datetime, prueflinge) -> Befund:
    """Urteil über beliebig viele Sicherungen.

    `stand is None` bedeutet „nicht ermittelbar" und gilt IMMER als Problem —
    niemals als „alles gut". Ein Wächter, der bei fehlender Auskunft schweigt,
    ist schlimmer als keiner: er erzeugt Vertrauen, das nichts trägt.
    Dieselbe Regel wie `None` statt `0` in pricing.py.

    Eine leere Liste ist ebenfalls kein Gesundheitszeugnis: wenn gar nichts
    geprüft wurde, ist auch nichts bestätigt.
    """
    prueflinge = list(prueflinge)
    if not prueflinge:
        return Befund(ok=False,
                      probleme=["Es wurde keine einzige Sicherung geprüft."],
                      zeilen=[])

    probleme, zeilen = [], []
    for pr in prueflinge:
        if pr.stand is None:
            zeilen.append(f"{pr.name}: KEINE Angabe ({pr.quelle} nicht erreichbar)")
            probleme.append(f"{pr.name}: Stand unbekannt — "
                            f"{pr.quelle} nicht abfragbar.")
            continue
        # Negatives Alter durch Uhrzeitversatz zwischen Mac und NAS nicht als
        # „uralt" oder gar als Fehler auslegen.
        alter = max(jetzt - pr.stand, timedelta(0))
        zeilen.append(f"{pr.name}: {pr.stand:%Y-%m-%d %H:%M} "
                      f"(vor {_alter_text(alter)})")
        if alter > pr.grenze:
            probleme.append(f"{pr.name}: letzte Sicherung ist "
                            f"{_alter_text(alter)} alt "
                            f"(Grenze {_alter_text(pr.grenze)}).")
    return Befund(ok=not probleme, probleme=probleme, zeilen=zeilen)


def neuester_snapshot(snapshots, tag: str) -> Optional[datetime]:
    """Zeitpunkt des jüngsten Snapshots mit diesem Schlagwort, oder None.

    Nach SCHLAGWORT filtern statt einfach den jüngsten zu nehmen — und das ist
    keine Feinheit: `restic snapshots --latest 1` liefert den jüngsten Snapshot
    **pro Gruppe** (Host + Pfade), nicht einen insgesamt. Im Repo lag neben dem
    Vault-Backup ein `setup-test`-Snapshot vom 24.05.2026; wer das erste
    Listenelement nimmt, meldet das Vault-Backup als 89 Tage alt (genau so
    passiert am 21.08.2026).

    Seit an diesem Tag auch Datenbank und Claude-Code-Ordner im SELBEN Repo
    liegen, wiegt das schwerer: „jüngster von allen" würde ein totes
    Vault-Backup hinter einem frischen claude-code-Snapshot verstecken.
    """
    passende = []
    for s in snapshots:
        if tag not in (s.get("tags") or []):
            continue
        passende.append(_zeit(s["time"]))
    return max(passende) if passende else None


def _zeit(roh: str) -> datetime:
    """restic-Zeitstempel -> lokale naive Zeit.

    Nur die Sekundenbruchteile werden entfernt, NICHT der Zonenversatz —
    `split('.')[0]` würde auch das '+02:00' abschneiden und den Zeitstempel
    stillschweigend als Ortszeit auslegen. Python 3.9 kann '+HH:MM' lesen.
    """
    ohne_bruch = re.sub(r"\.\d+", "", roh)
    stand = datetime.fromisoformat(ohne_bruch)
    if stand.tzinfo is not None:
        stand = stand.astimezone().replace(tzinfo=None)
    return stand


def heartbeat_faellig(jetzt: datetime) -> bool:
    """Montags eine Lebendmeldung.

    Der Wächter kann selbst sterben; dann herrscht wieder Stille. Das einzige
    verlässliche Gegenmittel ist eine erwartete Nachricht, deren AUSBLEIBEN
    auffällt.
    """
    return jetzt.weekday() == 0
