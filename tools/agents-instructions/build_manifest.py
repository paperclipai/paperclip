#!/usr/bin/env python3
"""Erzeugt agents-manifest.json fuer die 24 WHITESTAG-Agenten."""
import json, os, urllib.request

API = os.environ.get(
    "PAPERCLIP_API_URL",
    os.environ.get("PCP_API", "http://localhost:3100"),
).rstrip("/")  # PCP_API bleibt als Rueckfall gueltig
CID = os.environ.get("PCP_CID", "9cebf3cf-efe8-4597-a400-f06488900a87")
TOKEN = os.environ.get("PCP_TOKEN", "")
EXCLUDE_NAMES = {"HomePod-Test-Agent", "n8n-Betriebsingenieur"}


def api_get(path):
    req = urllib.request.Request(API + path, headers={"Authorization": "Bearer " + TOKEN})
    return json.load(urllib.request.urlopen(req))


def main():
    d = api_get(f"/api/companies/{CID}/agents")
    agents = d if isinstance(d, list) else d.get("agents", [])
    by_id = {a["id"]: a for a in agents}
    out = []
    for a in agents:
        if a.get("name") in EXCLUDE_NAMES:
            continue
        reports_to = by_id.get(a.get("reportsTo") or "", {}).get("name", "")
        out.append({
            "id": a["id"],
            "name": a["name"],
            "urlKey": a.get("urlKey") or a["id"],
            "reportsToName": reports_to,
        })
    path = os.path.join(os.path.dirname(__file__), "agents-manifest.json")
    with open(path, "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
    print(f"Manifest: {len(out)} Agenten -> {path}")


if __name__ == "__main__":
    main()
