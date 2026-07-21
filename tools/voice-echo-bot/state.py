"""Dedup-State: Menge aus '<issue_id>:<event>'-Schlüsseln, atomar persistiert."""
import json
import os


def load_state(path):
    """Lädt die 'seen'-Menge aus `path`.

    Gibt `None` zurück, wenn die Datei fehlt ODER nicht lesbar/korrupt ist —
    NICHT ein leeres Set. Der Aufrufer muss `None` (= "kein erfolgreicher
    Load") von einem tatsächlich leeren, valide gelesenen Set unterscheiden
    können (siehe bot.build_app: "seeded" darf nur bei erfolgreichem Load
    True sein, sonst droht bei einer korrupten Datei ein Push-Sturm)."""
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return set(json.load(fh).get("seen", []))
    except (json.JSONDecodeError, OSError, ValueError):
        return None


def save_state(path, seen):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump({"seen": sorted(seen)}, fh)
    os.replace(tmp, path)
