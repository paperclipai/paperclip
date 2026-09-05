#!/usr/bin/env python3
"""Seeding: extrahiert rollenspezifischen Teil jeder AGENTS.md -> roles/<urlKey>.role.md"""
import json, os, re, urllib.request

API = os.environ.get(
    "PAPERCLIP_API_URL",
    os.environ.get("PCP_API", "http://localhost:3100"),
).rstrip("/")  # PCP_API bleibt als Rueckfall gueltig
TOKEN = os.environ.get("PCP_TOKEN", "")
HERE = os.path.dirname(__file__)

# Universelle ## -Abschnitte (Praefix-Match auf die Header-Zeile), die nach _common gehoeren.
UNIVERSAL_PREFIXES = [
    "## 0. Fast-Exit-Gate",
    "## Sprache",
    "## Abschluss-Mail an Walter",
    "## Dokument-Frontmatter",
    "## Gedächtnis & Lernen",
    "## Tabellen-Deliverables",
    "## Markenidentität",
    "## Genauigkeit & Anti-Halluzination",
]
# Zusaetzliche Bloecke ohne eigene ##-Ueberschrift, die entfernt werden (Start..Ende-Marker).
HTML_BLOCKS = [("<!-- BEGIN: WHITESTAG-Dossier", "<!-- END: WHITESTAG-Dossier")]


def api_get(path):
    req = urllib.request.Request(API + path, headers={"Authorization": "Bearer " + TOKEN})
    return json.load(urllib.request.urlopen(req))


def read_agents_md(agent_id):
    d = api_get(f"/api/agents/{agent_id}/instructions-bundle/file?path=AGENTS.md")
    # readFile liefert ein Objekt; akzeptiere {'content': ...} oder rohen String.
    return d.get("content", d) if isinstance(d, dict) else d


def strip_universal(md):
    # 1) HTML-Kommentar-Bloecke entfernen
    for start, end in HTML_BLOCKS:
        while start in md and end in md:
            i = md.index(start); j = md.index(end, i); k = md.index("\n", j)
            md = md[:i] + md[k + 1:]
    # 2) Universelle ##-Abschnitte entfernen (Header bis naechste gleichrangige Ueberschrift)
    lines = md.split("\n")
    out, skip = [], False
    for ln in lines:
        is_h2 = ln.startswith("## ")
        is_h1 = ln.startswith("# ")
        if skip and (is_h2 or is_h1):
            skip = False  # Abschnitt endet an naechster ##/#-Ueberschrift
        if is_h2 and any(ln.startswith(p) for p in UNIVERSAL_PREFIXES):
            skip = True
        if not skip:
            out.append(ln)
    # 3) ueberzaehlige Leerzeilen kollabieren
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip() + "\n"
    return text


def main():
    manifest = json.load(open(os.path.join(HERE, "agents-manifest.json"), encoding="utf-8"))
    os.makedirs(os.path.join(HERE, "roles"), exist_ok=True)
    for a in manifest:
        md = read_agents_md(a["id"])
        role = strip_universal(md)
        with open(os.path.join(HERE, "roles", a["urlKey"] + ".role.md"), "w") as f:
            f.write(role)
        print(f"  {a['name']:22} role={role.count(chr(10))}Z (von {md.count(chr(10))}Z)")


if __name__ == "__main__":
    main()
