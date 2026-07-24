import json

_VALID_WHEN = {"always", "day-only"}
_REQUIRED = {"device", "ps_key", "load_key", "ctx", "parallel", "when"}

def load_resident_set(path):
    with open(path) as fh:
        data = json.load(fh)
    devices = set(data.get("devices", []))
    out = []
    for m in data.get("models", []):
        missing = _REQUIRED - m.keys()
        if missing:
            raise ValueError(f"Eintrag fehlt Felder {missing}: {m}")
        if m["device"] not in devices:
            raise ValueError(f"Unbekanntes device {m['device']!r}")
        if m["when"] not in _VALID_WHEN:
            raise ValueError(f"Unbekanntes when {m['when']!r}")
        out.append(dict(m))
    return out
