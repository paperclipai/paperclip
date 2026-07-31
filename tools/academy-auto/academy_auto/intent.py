from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass(frozen=True)
class Intent:
    ts: str
    kind: str          # approve | reject | direction
    text: str          # "" ausser bei direction
    ref_run_ts: str    # korreliert mit PendingRecord.run_ts


def write_intent(path: Path, intent: Intent) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(asdict(intent), ensure_ascii=False, indent=2))
    os.replace(tmp, path)


def read_intent(path: Path) -> Intent | None:
    try:
        data = json.loads(Path(path).read_text())
        return Intent(**data)
    except (OSError, ValueError, TypeError):
        return None


def clear_intent(path: Path) -> None:
    try:
        Path(path).unlink()
    except OSError:
        pass
