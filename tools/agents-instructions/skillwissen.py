# agents-instructions/skillwissen.py
"""Skill-Wissen-Ableitung + Section-Rendering fuer B2."""
import os, subprocess

CONFIG = os.environ.get("AGENT_LEARNING_CONFIG",
    os.path.expanduser("~/.paperclip/instances/default/agent-learning.config.yaml"))


def _yq(expr, cfg=None):
    out = subprocess.run(["yq", "-r", expr, cfg or CONFIG], capture_output=True, text=True)
    return out.stdout.strip()


def load_config():
    """Liest Domains aus der agent-learning.config: {domain: {title, skill_refs, file_dir}}."""
    vault_root = _yq(".vault.root")
    knowledge_dir = _yq(".vault.knowledge_dir")
    domains = {}
    keys = [k for k in _yq(".domains | keys | .[]").splitlines() if k]
    for d in keys:
        refs = [r for r in _yq(f'.domains."{d}".skill_refs[]').splitlines() if r]
        title = _yq(f'.domains."{d}".title')
        domains[d] = {"title": title, "skill_refs": refs,
                      "dir": os.path.join(vault_root, knowledge_dir, d)}
    return {"vault_root": vault_root, "knowledge_dir": knowledge_dir, "domains": domains}


def invert_skill_refs(dom2skill):
    """{domain: [skills]} -> {skill: {domains}} (leere skill_refs ignoriert)."""
    inv = {}
    for d, skills in dom2skill.items():
        for s in skills:
            if s:
                inv.setdefault(s, set()).add(d)
    return inv


def derive_domains(agent_skills, inv):
    """Skills eines Agenten -> sortierte Domain-Liste."""
    doms = set()
    for s in agent_skills:
        doms |= inv.get(s, set())
    return sorted(doms)


def count_md_files(domain_dir):
    try:
        return sum(1 for f in os.listdir(domain_dir) if f.endswith(".md"))
    except FileNotFoundError:
        return 0


def render_section(domains, cfg, counts):
    """Rendert die '## Skill-Wissen'-Sektion; '' wenn keine Domains."""
    if not domains:
        return ""
    lines = [
        "## Skill-Wissen (Vault — bei Bedarf per fs_read laden)",
        "",
        "Recherchiertes Fachwissen zu deinen Themen liegt im Vault. Berührt eine Aufgabe ein "
        "Thema, lies die passende Datei per `fs_read`:",
        "",
    ]
    for d in domains:
        info = cfg["domains"][d]
        n = counts.get(d, 0)
        lines.append(f"- **{info['title']}** — `{info['dir']}/` ({n} Dateien)")
    return "\n".join(lines) + "\n"
