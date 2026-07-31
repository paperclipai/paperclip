from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class PendingRecord:
    run_ts: str
    outcome: str
    task: str
    reason: str
    gate_note: str
    branch_sha: str
    has_change: bool
    tsc_delta: int
    quarantined: list[str]
    # Automatisch nach main gemergte Aufgaben dieses Laufs, je "<sha> <Aufgabe>".
    # Default, damit `PendingRecord(**data)` auch aeltere pending.json-Dateien
    # ohne dieses Feld noch liest.
    landed: list[str] = field(default_factory=list)


def write_pending(path: Path, rec: PendingRecord) -> None:
    """Atomar schreiben: Temp + os.replace, damit kein halber Zustand entsteht."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(asdict(rec), ensure_ascii=False, indent=2))
    os.replace(tmp, path)


def read_pending(path: Path) -> PendingRecord | None:
    """Fehlende/kaputte Datei -> None, nie werfen."""
    try:
        data = json.loads(Path(path).read_text())
        return PendingRecord(**data)
    except (OSError, ValueError, TypeError):
        return None
