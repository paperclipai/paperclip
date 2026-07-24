CTX_TOLERANCE = 512  # kleine Abweichungen (Rundung LM Studio) ignorieren

def plan_actions(desired, loaded, devices, available):
    actions = []
    for entry in desired:
        dev_sym = entry["device"]
        if dev_sym not in available:
            continue  # day-only auf abwesendem Geraet: still ueberspringen
        device_id = devices.get(dev_sym)
        match = None
        for m in loaded:
            if m["model_key"] != entry["ps_key"]:
                continue
            m_is_studio = m["device_id"] is None
            if (dev_sym == "studio" and m_is_studio) or (m["device_id"] == device_id):
                match = m
                break
        if match is None:
            actions.append({"action": "load", "entry": entry, "reason": "fehlt"})
        elif entry["ctx"] is not None and match["ctx"] is not None and abs(match["ctx"] - entry["ctx"]) > CTX_TOLERANCE:
            actions.append({"action": "ctx_mismatch", "entry": entry,
                            "reason": f"ctx {match['ctx']} != soll {entry['ctx']}"})
    return actions
