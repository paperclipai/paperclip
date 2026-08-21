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

# Die Datenbank wird täglich um 02:30 gesichert. 30 Stunden lassen einen
# verspäteten Lauf durch, schlagen aber an, sobald eine Nacht ausfällt.
DB_GRENZE_H = 30
# Der Vault geht nur sonntags 03:30 raus — 9 Tage decken einen verschobenen
# Lauf ab, ohne einen ausgefallenen Sonntag zu verschlucken.
VAULT_GRENZE_TAGE = 9


class Befund(NamedTuple):
    ok: bool
    probleme: List[str]
    zeilen: List[str]


def _alter_text(delta: timedelta) -> str:
    stunden = delta.total_seconds() / 3600
    if stunden < 48:
        return f"{stunden:.0f} Stunden"
    return f"{delta.days} Tage"


def _pruefe(name: str, stand: Optional[datetime], jetzt: datetime,
            grenze: timedelta, quelle: str):
    """(problem_oder_None, berichtszeile) für eine einzelne Sicherung."""
    if stand is None:
        return (f"{name}: Stand unbekannt — {quelle} nicht abfragbar.",
                f"{name}: KEINE Angabe (Quelle nicht erreichbar)")

    # Negatives Alter durch Uhrzeitversatz zwischen Mac und NAS nicht als
    # „uralt" oder gar als Fehler auslegen.
    alter = max(jetzt - stand, timedelta(0))
    zeile = (f"{name}: {stand:%Y-%m-%d %H:%M} "
             f"(vor {_alter_text(alter)})")
    if alter > grenze:
        return (f"{name}: letzte Sicherung ist {_alter_text(alter)} alt "
                f"(Grenze {_alter_text(grenze)}).", zeile)
    return (None, zeile)


def bewerte(jetzt: datetime,
            db_stand: Optional[datetime],
            vault_stand: Optional[datetime],
            db_grenze_h: int = DB_GRENZE_H,
            vault_grenze_tage: int = VAULT_GRENZE_TAGE) -> Befund:
    """Urteil über beide Sicherungen.

    `None` als Stand bedeutet „nicht ermittelbar" und gilt IMMER als Problem —
    niemals als „alles gut". Ein Wächter, der bei fehlender Auskunft schweigt,
    ist schlimmer als keiner: er erzeugt Vertrauen, das nichts trägt.
    Dieselbe Regel wie `None` statt `0` in pricing.py.
    """
    probleme = []
    zeilen = []
    for problem, zeile in (
        _pruefe("Datenbank (NAS)", db_stand, jetzt,
                timedelta(hours=db_grenze_h), "NAS"),
        _pruefe("Vault (Nextcloud)", vault_stand, jetzt,
                timedelta(days=vault_grenze_tage), "restic"),
    ):
        zeilen.append(zeile)
        if problem:
            probleme.append(problem)
    return Befund(ok=not probleme, probleme=probleme, zeilen=zeilen)


def neuester_snapshot(snapshots, tag: str) -> Optional[datetime]:
    """Zeitpunkt des jüngsten Snapshots mit diesem Tag, oder None.

    Nach TAG filtern statt einfach den jüngsten zu nehmen — und das ist keine
    Feinheit: `restic snapshots --latest 1` liefert den jüngsten Snapshot
    **pro Gruppe** (Host + Pfade), nicht einen insgesamt. Im Repo liegt neben
    dem Vault-Backup noch ein `setup-test`-Snapshot vom 24.05.2026; wer das
    erste Listenelement nimmt, meldet das Vault-Backup als 89 Tage alt
    (genau so passiert am 21.08.2026).

    „Jüngster von allen" wäre ebenfalls falsch: käme später ein zweites
    Backup ins selbe Repo, verdeckte dessen frischer Snapshot ein längst
    totes Vault-Backup.
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
