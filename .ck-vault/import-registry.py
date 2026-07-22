#!/usr/bin/env python3
"""Import a JSON seed of accounts into the Paperclip vault. Idempotent (create-only).
Seed = JSON array of {slug, username, service, persona, password}. Entries with an empty
password are recorded SKIPPED (nothing to store yet). Never prints password values."""
import json, sys, urllib.request, urllib.error
from pathlib import Path

API = "http://127.0.0.1:3100"
CO = "e651858f-b11b-4b43-aa43-20c1192d7e98"


def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or "{}")


def main():
    if len(sys.argv) < 2:
        print("usage: import-registry.py <seed.json> [--apply]"); sys.exit(1)
    seed = json.loads(Path(sys.argv[1]).read_text())
    apply = "--apply" in sys.argv
    _, existing = api("GET", f"/api/companies/{CO}/secrets")
    have = {s["name"] for s in existing} if isinstance(existing, list) else set()
    created = skipped = empty = 0
    for e in seed:
        slug = e.get("slug", "").strip()
        pw = (e.get("password") or "").strip()
        if not slug:
            continue
        if not pw:
            print(f"  no-password    {slug:32s}  (registry-only, add value later)"); empty += 1; continue
        if slug in have:
            print(f"  skip (exists)  {slug}"); skipped += 1; continue
        desc = f"user={e.get('username','-')} · service={e.get('service','-')} · persona={e.get('persona','-')}"
        if not apply:
            print(f"  would create   {slug:32s}  {desc}"); created += 1; continue
        st, resp = api("POST", f"/api/companies/{CO}/secrets", {"name": slug, "value": pw, "description": desc})
        if st in (200, 201):
            print(f"  created        {slug:32s}  id={resp.get('id','?')}"); created += 1
        else:
            print(f"  ERROR {st}     {slug}: {resp}")
    print(f"\n{'APPLIED' if apply else 'DRY-RUN'}: created={created} skipped_exists={skipped} no_password={empty}")


if __name__ == "__main__":
    main()
