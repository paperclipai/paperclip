"""Dedup-State: Menge aus '<issue_id>:<event>'-Schlüsseln, atomar persistiert."""
import json
import os


def load_state(path):
    if not os.path.exists(path):
        return set()
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return set(json.load(fh).get("seen", []))
    except (json.JSONDecodeError, OSError, ValueError):
        return set()


def save_state(path, seen):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump({"seen": sorted(seen)}, fh)
    os.replace(tmp, path)
