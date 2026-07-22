#!/usr/bin/env python3
"""Extract the marketplace logins from Divino's credentials.md into a vault seed JSON.
Parses `## <Platform>` sections and their `- Password:` / `- Login e-mail:` / `- Username:` /
`- E-mail:` lines. Writes a seed file (0600). Never prints password values."""
import json, os, re, sys
from pathlib import Path

SRC = Path("/home/ckhermes/divino-agent/workspace/credentials.md")
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/tmp/credmd-seed.json")

# heading keyword -> (slug, service, persona)
MAP = [
    ("ricardo", "divino-ricardo", "Ricardo.ch marketplace", "Divino brand"),
    ("tutti", "divino-tutti", "Tutti.ch marketplace", "Divino brand"),
    ("locanto", "divino-locanto", "Locanto.ch marketplace", "Divino brand"),
    ("lapulga", "divino-lapulga", "LaPulga.com.do marketplace", "Alan personal"),
]


def val(section, *labels):
    for lab in labels:
        m = re.search(rf"^[\s*-]*{re.escape(lab)}\s*:\s*(.+)$", section, re.IGNORECASE | re.MULTILINE)
        if m:
            return m.group(1).strip()
    return ""


def main():
    text = SRC.read_text()
    # split into sections keyed by their ## heading line
    parts = re.split(r"^##\s+(.+)$", text, flags=re.MULTILINE)
    # parts = [pre, heading1, body1, heading2, body2, ...]
    seed = []
    for i in range(1, len(parts), 2):
        heading, body = parts[i].lower(), parts[i + 1]
        for kw, slug, service, persona in MAP:
            if kw in heading:
                pw = val(body, "Password", "Passwort")
                user = val(body, "Login e-mail", "Username", "E-mail", "Email")
                seed.append({"slug": slug, "username": user or "-", "service": service,
                             "persona": persona, "password": pw})
                print(f"  {slug:20s} user={'set' if user else 'MISSING':7s} pw={'set' if pw else 'MISSING'}")
                break
    OUT.write_text(json.dumps(seed, indent=2))
    os.chmod(OUT, 0o600)
    print(f"wrote {OUT} ({len(seed)} entries)")


if __name__ == "__main__":
    main()
