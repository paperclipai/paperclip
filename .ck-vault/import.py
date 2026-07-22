#!/usr/bin/env python3
"""ck-vault importer — load credentials from Divino's scattered source files into the
Paperclip native encrypted secret store. Idempotent: creates a secret only if its name
is not already present (use rotate.py to change an existing value). Never prints values."""
import json, re, sys, urllib.request
from pathlib import Path

API = "http://127.0.0.1:3100"
CO = "e651858f-b11b-4b43-aa43-20c1192d7e98"
DA = Path("/home/ckhermes/divino-agent")

# slug, source file (rel to DA), key, separator ('=' env or ':' colon), username, service, persona
MANIFEST = [
    ("divino-mail-infomaniak", "workspace/.divino-mail.env", "DIVINO_MAIL_PASS", "=",
     "info@divinocigars.ch", "Infomaniak IMAP/SMTP mailbox", "Divino brand"),
    ("divino-brave-api-key", "workspace/.divino-mail.env", "BRAVE_API_KEY", "=",
     "-", "Brave Search API", "shared"),
    ("divino-anibis", "workspace/.creds-anibis.txt", "password", ":",
     "info@divinocigars.ch", "Anibis.ch marketplace", "Divino brand"),
    ("divino-browserbase-api-key", "secrets/scripts.env", "BROWSERBASE_API_KEY", "=",
     "-", "Browserbase (stealth browser cloud)", "shared"),
    ("divino-browserbase-project-id", "secrets/scripts.env", "BROWSERBASE_PROJECT_ID", "=",
     "-", "Browserbase project id (non-secret, stored for completeness)", "shared"),
]


def extract(path: Path, key: str, sep: str) -> str | None:
    if sep == "=":
        pat = re.compile(rf"^{re.escape(key)}=(.*)$")
    else:
        pat = re.compile(rf"^{re.escape(key)}:\s*(.*)$")
    for line in path.read_text().splitlines():
        m = pat.match(line.strip())
        if m:
            return m.group(1).strip()
    return None


def api(method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or "{}")


def main():
    apply = "--apply" in sys.argv
    _, existing = api("GET", f"/api/companies/{CO}/secrets")
    have = {s["name"] for s in existing} if isinstance(existing, list) else set()
    created = skipped = missing = 0
    for slug, rel, key, sep, user, service, persona in MANIFEST:
        src = DA / rel
        val = extract(src, key, sep) if src.exists() else None
        if not val or val.startswith("PASTE_") or val in ("", "CHANGEME"):
            print(f"  MISSING value  {slug:32s}  <- {rel}:{key}")
            missing += 1
            continue
        if slug in have:
            print(f"  skip (exists)  {slug}")
            skipped += 1
            continue
        desc = f"user={user} · service={service} · persona={persona}"
        if not apply:
            print(f"  would create   {slug:32s}  ({len(val)} chars)  {desc}")
            created += 1
            continue
        st, resp = api("POST", f"/api/companies/{CO}/secrets",
                       {"name": slug, "value": val, "description": desc})
        if st in (200, 201):
            print(f"  created        {slug:32s}  id={resp.get('id','?')}")
            created += 1
        else:
            print(f"  ERROR {st}     {slug}: {resp}")
    print(f"\n{'APPLIED' if apply else 'DRY-RUN'}: created={created} skipped={skipped} missing={missing}")


if __name__ == "__main__":
    main()
