#!/usr/bin/env python3
"""Three-home skill sync, home 3: push every runner skill file
(~/paperclip/.ck-agent/skills/*.md) into Paperclip's native company_skills DB,
creating missing skills and updating stale ones — so every local adapter sees
the same current knowledge through native paperclipSkillSync or runner
injection.

Run after ANY skill file change:  python3 ~/paperclip/.ck-agent/sync_skills_to_db.py
Known trap: updating content requires PATCH /companies/:id/skills/:skillId/files
with {path:"SKILL.md", content:...} — a bare PATCH of the skill silently no-ops.
"""
import json, pathlib, re, urllib.request

CO = "e651858f-b11b-4b43-aa43-20c1192d7e98"
API = "http://127.0.0.1:3100/api"
SKILLS_DIR = pathlib.Path(__file__).parent / "skills"

def api(method, path, body=None):
    req = urllib.request.Request(API + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        raw = r.read().decode()
        return json.loads(raw) if raw else {}

def ensure_frontmatter(name, text):
    """Native skills expect frontmatter; runner files start with '# Skill: …'."""
    if text.startswith("---"):
        return text
    m = re.match(r"#\s*Skill:\s*([^\n—-]+)[—-]?\s*(.*)", text)
    desc = (m.group(2).strip() if m else "") or name
    return f"---\nname: {name}\ndescription: {desc[:150]}\n---\n\n{text}"

existing = {}
rows = api("GET", f"/companies/{CO}/skills")
rows = rows if isinstance(rows, list) else rows.get("skills", [])
for r in rows:
    key = r.get("key") or ""
    if key.startswith("company/"):
        existing[key.rsplit("/", 1)[-1]] = r

for f in sorted(SKILLS_DIR.glob("*.md")):
    name = f.stem
    content = ensure_frontmatter(name, f.read_text())
    if name in existing:
        sid = existing[name].get("id")
        api("PATCH", f"/companies/{CO}/skills/{sid}/files", {"path": "SKILL.md", "content": content})
        print(f"updated  {name}")
    else:
        created = api("POST", f"/companies/{CO}/skills", {"name": name})
        sid = created.get("id")
        api("PATCH", f"/companies/{CO}/skills/{sid}/files", {"path": "SKILL.md", "content": content})
        print(f"created  {name}")
print("sync complete")
