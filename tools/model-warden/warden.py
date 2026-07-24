import json, os, subprocess, sys
from config import load_resident_set
from lms_state import resolve_devices, parse_loaded, available_devices
from reconcile import plan_actions
from loader import set_preferred_cmd, load_cmd

def run(run_cmd, get_link_json, get_ps_json, set_path, notify):
    desired = load_resident_set(set_path)
    link_json = get_link_json()
    devices = resolve_devices(link_json)
    avail = available_devices(link_json)
    loaded = parse_loaded(get_ps_json())
    actions = plan_actions(desired, loaded, devices, avail)

    result = {"loaded": [], "warnings": [], "failures": []}
    for a in actions:
        entry = a["entry"]
        if a["action"] == "ctx_mismatch":
            result["warnings"].append(f"{entry['load_key']}@{entry['device']}: {a['reason']}")
            continue
        device_id = devices.get(entry["device"])
        if device_id:
            run_cmd(set_preferred_cmd(device_id))
        rc, out = run_cmd(load_cmd(entry))
        if rc == 0:
            result["loaded"].append(f"{entry['load_key']}@{entry['device']}")
        else:
            result["failures"].append(f"{entry['load_key']}@{entry['device']}: {out.strip()[:200]}")
    if result["failures"]:
        notify("Modell-Wärter: Laden fehlgeschlagen",
               "Folgende Resident-Modelle konnten nicht geladen werden:\n\n- "
               + "\n- ".join(result["failures"]))
    return result

def _sh(argv):
    p = subprocess.run(argv, capture_output=True, text=True)
    return (p.returncode, (p.stdout or "") + (p.stderr or ""))

def main():
    lms = os.path.expanduser("~/.lmstudio/bin/lms")
    def run_cmd(argv):
        return _sh([lms] + argv[1:])  # argv[0]=="lms" -> echten Pfad einsetzen
    def link_json():
        return _sh([lms, "link", "status", "--json"])[1]
    def ps_json():
        return _sh([lms, "ps", "--json"])[1]
    sys.path.insert(0, os.path.expanduser("~/.paperclip/scripts"))
    import paperclip_client as pc
    WHITESTAG_COMPANY = "9cebf3cf-efe8-4597-a400-f06488900a87"
    CTO_AGENT = None  # optional: an CTO haengen; sonst None
    def notify(title, body):
        token = pc.load_token()
        if token:
            pc.create_issue(pc.DEFAULT_BASE, token, WHITESTAG_COMPANY,
                            title=title, description=body,
                            assignee_agent_id=CTO_AGENT, priority="high")
    set_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "resident-set.json")
    res = run(run_cmd, link_json, ps_json, set_path, notify)
    print(json.dumps(res, ensure_ascii=False))

if __name__ == "__main__":
    main()
