"""Dauerhafte Empfänger-Sperrliste für Luna (eine JSON-Datei, exakte Adressen).

'Ignorieren' auf eine Freigabe-Mail setzt den Empfänger hierauf; watcher.scan()
filtert gesperrte Absender aus der Triage. Fail-open: unlesbare/fehlende Datei →
niemand gesperrt (im Zweifel triagieren, nie Kundenpost verschlucken)."""
from __future__ import annotations
import json
from datetime import datetime
from pathlib import Path

STATE = Path.home() / ".paperclip" / "state" / "luna-blocklist.json"


def _normalize(addr: str) -> str:
    return (addr or "").strip().lower()


def load() -> set[str]:
    if not STATE.exists():
        return set()
    try:
        data = json.loads(STATE.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return set()  # fail-open: JSON ist nicht Objekt
        raw = data.get("blocked", [])
        if not isinstance(raw, list):
            return set()  # fail-open: "blocked" ist keine Liste
        return {_normalize(a) for a in raw if a and _normalize(a)}
    except Exception:
        return set()  # fail-open: jede Parse/Shape/Encoding-Fehler → leer


def _save(blocked: set[str]) -> None:
    STATE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps({"blocked": sorted(blocked),
                               "updated": datetime.now().isoformat()},
                              ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(STATE)


def is_blocked(addr: str) -> bool:
    return _normalize(addr) in load()


def add(addr: str) -> None:
    a = _normalize(addr)
    if not a:
        return
    blocked = load()
    if a not in blocked:
        blocked.add(a)
        _save(blocked)


def remove(addr: str) -> None:
    a = _normalize(addr)
    blocked = load()
    if a in blocked:
        blocked.discard(a)
        _save(blocked)
