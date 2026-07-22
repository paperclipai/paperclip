from __future__ import annotations

import json
from pathlib import Path

_FAIL_STATUSES = {"discarded", "impl_failed"}


def load_state(path) -> dict:
    p = Path(path)
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text())
    except (ValueError, OSError):
        return {}


def save_state(path, state) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(state, indent=2, ensure_ascii=False))


def record_outcome(state, key, status, now=None) -> None:
    entry = state.get(key, {"attempts": 0, "last_status": None, "last_run": None})
    state[key] = {
        "attempts": entry.get("attempts", 0) + 1,
        "last_status": status,
        "last_run": now,
    }


def is_quarantined(entry) -> bool:
    return entry.get("attempts", 0) >= 2 and entry.get("last_status") in _FAIL_STATUSES


def quarantined_keys(state) -> list[str]:
    return [k for k, v in state.items() if is_quarantined(v)]


def filter_candidates(state, candidates) -> list:
    kept = []
    for c in candidates:
        entry = state.get(c.key)
        if entry is None:
            kept.append(c)
            continue
        if entry.get("last_status") == "committed" or is_quarantined(entry):
            continue
        kept.append(c)
    return kept
