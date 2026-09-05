#!/usr/bin/env python3
"""Generiert AGENTS.md = _common (mit eingesetztem role) und schreibt via API."""
import argparse, json, os, re, sys, urllib.request, urllib.error
import importlib.util
from datetime import datetime

API = os.environ.get(
    "PAPERCLIP_API_URL",
    os.environ.get("PCP_API", "http://localhost:3100"),
).rstrip("/")  # PCP_API bleibt als Rueckfall gueltig
TOKEN = os.environ.get("PCP_TOKEN", "")
CID = os.environ.get("PCP_CID", "")
HERE = os.path.dirname(__file__)

_sw_spec = importlib.util.spec_from_file_location("skillwissen", os.path.join(HERE, "skillwissen.py"))
skillwissen = importlib.util.module_from_spec(_sw_spec); _sw_spec.loader.exec_module(skillwissen)


def load_meldepflicht():
    """Block fuer Agenten mit melderecht=true; leer fuer alle anderen."""
    with open(os.path.join(HERE, "_meldepflicht.md"), encoding="utf-8") as fh:
        return fh.read().rstrip("\n")


def assemble(common, role, agent, skill_wissen="", meldepflicht=""):
    out = common.replace("{{ROLE}}", role.strip())
    out = out.replace("{{SKILL_WISSEN}}", skill_wissen)
    out = out.replace("{{MELDEPFLICHT}}", meldepflicht if agent.get("melderecht") else "")
    out = out.replace("{{agent_name}}", agent["name"])
    out = out.replace("{{reports_to_name}}", agent.get("reportsToName", ""))
    left = re.findall(r"\{\{[^}]+\}\}", out)
    if left:
        raise ValueError(f"Offene Platzhalter fuer {agent['name']}: {set(left)}")
    return out


def api_get(path):
    req = urllib.request.Request(API + path, headers={"Authorization": "Bearer " + TOKEN})
    return json.load(urllib.request.urlopen(req))


def api_put(path, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(API + path, data=data, method="PUT",
        headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"})
    raw = urllib.request.urlopen(req).read().decode().strip()
    return json.loads(raw) if raw else {}


def load_sources():
    manifest = json.load(open(os.path.join(HERE, "agents-manifest.json"), encoding="utf-8"))
    common = open(os.path.join(HERE, "_common.md"), encoding="utf-8").read()
    return manifest, common


def role_path(urlkey):
    return os.path.join(HERE, "roles", urlkey + ".role.md")


def read_current(agent_id):
    d = api_get(f"/api/agents/{agent_id}/instructions-bundle/file?path=AGENTS.md")
    return d.get("content", d) if isinstance(d, dict) else d


def do_backup():
    manifest, _ = load_sources()
    snap = {a["id"]: {"name": a["name"], "content": read_current(a["id"])} for a in manifest}
    os.makedirs(os.path.join(HERE, "backups"), exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    path = os.path.join(HERE, "backups", f"agents-md-{stamp}.json")
    json.dump(snap, open(path, "w"), indent=2, ensure_ascii=False)
    print(f"Backup: {path} ({len(snap)} Agenten)")


def load_agent_skills():
    """id -> set(slug) aus den live desiredSkills aller Agenten."""
    d = api_get(f"/api/companies/{CID}/agents")
    agents = d if isinstance(d, list) else d.get("agents", [])
    res = {}
    for a in agents:
        ds = ((a.get("adapterConfig") or {}).get("paperclipSkillSync") or {}).get("desiredSkills") or []
        res[a["id"]] = {r.split("/")[-1] for r in ds}
    return res


def skill_wissen_for(agent, swcfg, inv, skills_by_id):
    domains = skillwissen.derive_domains(skills_by_id.get(agent["id"], set()), inv)
    counts = {d: skillwissen.count_md_files(swcfg["domains"][d]["dir"]) for d in domains}
    return skillwissen.render_section(domains, swcfg, counts)


def gen_for(agent, common, swcfg, inv, skills_by_id):
    role = open(role_path(agent["urlKey"]), encoding="utf-8").read()
    sw = skill_wissen_for(agent, swcfg, inv, skills_by_id)
    return assemble(common, role, agent, sw, load_meldepflicht())


def do_dry_run():
    manifest, common = load_sources()
    swcfg = skillwissen.load_config()
    inv = skillwissen.invert_skill_refs({d: v["skill_refs"] for d, v in swcfg["domains"].items()})
    skills_by_id = load_agent_skills()
    for a in manifest:
        new = gen_for(a, common, swcfg, inv, skills_by_id)
        old = read_current(a["id"])
        print(f"~ {a['name']:22} {old.count(chr(10))}Z -> {new.count(chr(10))}Z")


def do_apply():
    manifest, common = load_sources()
    swcfg = skillwissen.load_config()
    inv = skillwissen.invert_skill_refs({d: v["skill_refs"] for d, v in swcfg["domains"].items()})
    skills_by_id = load_agent_skills()
    for a in manifest:
        new = gen_for(a, common, swcfg, inv, skills_by_id)
        try:
            api_put(f"/api/agents/{a['id']}/instructions-bundle/file",
                    {"path": "AGENTS.md", "content": new})
            print(f"OK  {a['name']}: {new.count(chr(10))}Z geschrieben")
        except urllib.error.HTTPError as e:
            print(f"ERR {a['name']}: HTTP {e.code} {e.read().decode()[:200]}")
        except urllib.error.URLError as e:
            print(f"ERR {a['name']}: {e.reason}")


def do_verify():
    manifest, common = load_sources()
    ok = True
    # erwarteter, agent-unabhaengiger Common-Tail-Marker
    for a in manifest:
        cur = read_current(a["id"])
        role = open(role_path(a["urlKey"]), encoding="utf-8").read().strip().split("\n")[0]
        problems = []
        if role and role not in cur:
            problems.append(f"Role-Kopf fehlt: {role!r}")
        if "## Abschluss-Mail an Walter" not in cur:
            problems.append("Common-Block (Abschluss-Mail) fehlt")
        has_meld = "## Sofort-Meldung an Walter" in cur
        if a.get("melderecht") and not has_meld:
            problems.append("Meldepflicht-Block fehlt (melderecht=true)")
        if not a.get("melderecht") and has_meld:
            problems.append("Meldepflicht-Block vorhanden, obwohl melderecht nicht gesetzt")
        if "{{" in cur:
            problems.append("offener Platzhalter")
        if "relevant-knowledge.md" in cur:
            problems.append("tote relevant-knowledge.md-Referenz noch vorhanden")
        if problems:
            ok = False; print(f"ABWEICHUNG {a['name']}: {problems}")
    print("VERIFY OK" if ok else "VERIFY FEHLGESCHLAGEN")
    sys.exit(0 if ok else 1)


def main():
    p = argparse.ArgumentParser()
    for m in ["backup", "dry-run", "apply", "verify"]:
        p.add_argument("--" + m, action="store_true")
    a = p.parse_args()
    if a.backup: do_backup(); return
    if a.dry_run: do_dry_run(); return
    if a.apply: do_apply(); return
    if a.verify: do_verify(); return
    print("Kein Modus. Siehe --help.", file=sys.stderr)


if __name__ == "__main__":
    main()
