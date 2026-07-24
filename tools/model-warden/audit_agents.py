import json, os, subprocess, sys

def resident_model_keys(desired):
    keys = set()
    for e in desired:
        keys.add(e["load_key"]); keys.add(e["ps_key"])
    return keys

def _is_allowed(name, allowed):
    if not name:
        return True
    if name.startswith("claude-"):  # Cloud, nie missing
        return True
    return name in allowed

def _dig(obj, *keys):
    """Verschachtelte .get()-Kette, robust gegen Nicht-Dict-Zwischenwerte
    (kaputtes Live-adapter_config crasht sonst violations())."""
    for k in keys:
        if not isinstance(obj, dict):
            return None
        obj = obj.get(k)
    return obj

def violations(adapter_config, allowed):
    out = []
    for field in ("model", "fallbackModel", "defaultModel"):
        name = adapter_config.get(field)
        if not _is_allowed(name, allowed):
            out.append(f"{field}: {name}")
    cheap = _dig(adapter_config, "modelProfiles", "cheap", "adapterConfig", "model")
    if not _is_allowed(cheap, allowed):
        out.append(f"cheap.model: {cheap}")
    return out

# --- DB/PATCH-Schicht (dünn, nicht unit-getestet) ---
DB = ["psql", "-h", "127.0.0.1", "-p", "54329", "-U", "paperclip", "-d", "paperclip", "-tAc"]

def _fetch_agents():
    env = dict(os.environ, PGPASSWORD="paperclip")
    q = "select id, name, adapter_config from agents where adapter_config is not null;"
    out = subprocess.run(DB + [q], capture_output=True, text=True, env=env).stdout
    rows = []
    for line in out.splitlines():
        parts = line.split("|", 2)
        if len(parts) == 3:
            try:
                rows.append((parts[0], parts[1], json.loads(parts[2])))
            except ValueError:
                pass
    return rows

def main():
    from config import load_resident_set
    here = os.path.dirname(os.path.abspath(__file__))
    allowed = resident_model_keys(load_resident_set(os.path.join(here, "resident-set.json")))
    bad = []
    for aid, name, cfg in _fetch_agents():
        v = violations(cfg, allowed)
        if v:
            bad.append((aid, name, v))
    for aid, name, v in bad:
        print(f"[VERLETZUNG] {name} ({aid}): {', '.join(v)}")
    print(f"\n{len(bad)} Agenten mit Verweis außerhalb des Resident-Sets.")
    # --fix bewusst manuell/kuratiert (siehe Plan Step 5) — kein Blind-PATCH.

if __name__ == "__main__":
    main()
