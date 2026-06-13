#!/usr/bin/env python3
"""
Agents Frontmatter Updater
==========================
Aktualisiert die "## Dokument-Frontmatter (Pflicht)"-Sektion in AGENTS.md-Dateien.

WHITESTAG (23 Agenten):
  - Ergänzt `title`, `datum`, `paperclip_company`, `zusammenfassung` im YAML-Block
  - Aktualisiert die erklärenden Bulletpoints danach

Clara (8 Agenten mit Vault-Zugriff):
  - Fügt eine vollständige "## Dokument-Frontmatter (Pflicht)"-Sektion neu ein
  - Inkl. Ablage-Pfad-Regeln und Clara-spezifischem Schema

Standard: Dry-Run. Schreiben nur mit --apply.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

BASE = Path("/Users/walterschoenenbroecher.de/.paperclip/instances/default/companies")

WHITESTAG_COMPANY = "9cebf3cf-efe8-4597-a400-f06488900a87"
CLARA_COMPANY     = "0e426844-309c-4528-9aa5-90ff76790a51"
VAULT             = "/Users/walterschoenenbroecher.de/Obsidian/WHITESTAG-Vault"

# Clara-Agenten, die in den Vault schreiben (alle außer den leeren CEO-Vorlagen)
CLARA_VAULT_WRITERS = {
    "1ebb9ce4-3c14-4a8f-9488-6d0eeb41f4f2",  # Akquise & Booking R2
    "55cfad48-f87e-4b9a-84b7-964a7f1f684d",  # Social Media & Community R3
    "5ec7648d-a055-42de-a7a2-270c552d572d",  # Redaktion & PR R4
    "f2d73a54-dce9-493a-998a-71e7c127f61e",  # Recherche R5
    "8a87a173-ffdb-4b67-b957-ed849cff3c51",  # Creative Assistant R6
    "5cd046f2-d46e-44d0-9539-d8ff56fb8e02",  # Office & Admin R7
    "d673ba70-c557-4b4b-be73-320d7780e1fe",  # Label Manager R8
    "64ad7d03-ce64-46aa-ae79-d17ff26f5d4f",  # Büroleitung R1
}

# ---------------------------------------------------------------------------
# WHITESTAG: altes YAML-Block-Muster → neues Block
# ---------------------------------------------------------------------------

# Altes Muster (flexible wrt agent name und type)
OLD_FM_PATTERN = re.compile(
    r"(```yaml\n---\n)"
    r"(paperclip_issue_id: \"WHI-XX\"\n)"
    r"(paperclip_issue_title: \"Kurztitel aus dem Issue\"\n)"
    r"(paperclip_agent: \"[^\"]*\"\n)"
    r"(paperclip_status: \"done\"\n)"
    r"(paperclip_created_at: \"YYYY-MM-DD\"\n)"
    r"(type: \w+\n)"
    r"(tags: \[paperclip\]\n)"
    r"(---\n```)",
    re.MULTILINE,
)

def build_new_whitestag_yaml(agent_name: str, type_value: str) -> str:
    return (
        "```yaml\n"
        "---\n"
        "title: \"Kurztitel des Dokuments\"\n"
        "datum: YYYY-MM-DD\n"
        f'paperclip_issue_id: "WHI-XX"\n'
        f'paperclip_issue_title: "Kurztitel aus dem Issue"\n'
        f'paperclip_agent: "{agent_name}"\n'
        f'paperclip_company: "whitestag"\n'
        f'paperclip_status: "done"\n'
        f'paperclip_created_at: "YYYY-MM-DD"\n'
        f"type: {type_value}\n"
        "tags: [paperclip]\n"
        'zusammenfassung: ""\n'
        "---\n"
        "```"
    )

# Erklärungstext alt → neu
OLD_EXPLANATION = (
    "- `paperclip_issue_id` und `paperclip_issue_title` aus dem Issue-Kontext (Prefix meist `WHI-`)\n"
    "- `paperclip_agent` ist dein Name exakt wie oben ({agent_name_placeholder})\n"
    "- `type` ist eine kurze Kategorisierung der Dokumentart (z.B. `strategie`, `briefing`, `deliverable`, `recherche`, `spec`, `post`, `drehbuch`, `doku`)\n"
    "- `tags` enthält immer `paperclip` als ersten Tag, dann thematische Tags ergänzen\n"
    "- Bei Updates eines bestehenden Dokuments: Frontmatter beibehalten, `paperclip_status` und ggf. weitere Felder aktualisieren"
)

def build_new_whitestag_explanation(agent_name: str) -> str:
    return (
        f"- `title`: Kurzer Dokumenttitel (1 Zeile, für Obsidian-Suche und Dataview)\n"
        f"- `datum`: Erstellungsdatum ISO (identisch mit `paperclip_created_at`)\n"
        f"- `paperclip_issue_id` und `paperclip_issue_title` aus dem Issue-Kontext (Prefix meist `WHI-`)\n"
        f"- `paperclip_agent` ist dein Name exakt wie oben ({agent_name})\n"
        f"- `paperclip_company`: immer `whitestag` (oder `health` für Health-Company)\n"
        f"- `type` ist eine kurze Kategorisierung der Dokumentart (z.B. `strategie`, `briefing`, `deliverable`, `recherche`, `spec`, `post`, `drehbuch`, `doku`, `analyse`)\n"
        f"- `tags` enthält immer `paperclip` als ersten Tag, dann thematische Tags ergänzen\n"
        f"- `zusammenfassung`: 1-2 Sätze Inhaltsbeschreibung (für Dataview und Walter-Suche)\n"
        f"- Bei Updates eines bestehenden Dokuments: Frontmatter beibehalten, `paperclip_status` und ggf. weitere Felder aktualisieren"
    )

# Regex für den Erklärungstext — unterstützt sowohl `- ` als auch `* ` Bullets
OLD_EXPLANATION_PATTERN = re.compile(
    r"[*-] `paperclip_issue_id` und `paperclip_issue_title` aus dem Issue-Kontext \(Prefix meist `WHI-`\)\n"
    r"[*-] `paperclip_agent` ist dein Name exakt wie oben \([^)]+\)\n"
    r"[*-] `type` ist eine kurze Kategorisierung der Dokumentart \(z\.B\. `strategie`, `briefing`, `deliverable`, `recherche`, `spec`, `post`, `drehbuch`, `doku`\)\n"
    r"[*-] `tags` enthält immer `paperclip` als ersten Tag, dann thematische Tags ergänzen\n"
    r"[*-] Bei Updates eines bestehenden Dokuments: Frontmatter beibehalten, `paperclip_status` und ggf\. weitere Felder aktualisieren",
    re.MULTILINE,
)

# ---------------------------------------------------------------------------
# Clara: neuer Abschnitt zum Einfügen
# ---------------------------------------------------------------------------

CLARA_VAULT_SECTION_TEMPLATE = """\

<!-- BEGIN: vault-write-standard V1 -->
## Vault-Ablageregeln

Wenn du im Rahmen eines Tasks eine Markdown-Datei erzeugst, landet sie im Obsidian-Vault unter `{vault}/`. Entscheidungsregel:

* **Recherche, Dossiers, Reports** → `{vault}/Paperclip/Clara/Recherche/`
* **Projekt-gebunden** (konkretes Produkt, Tour, Release) → `{vault}/Paperclip/Clara/Projekte/[Projektname]/`
* **Unklar** → `{vault}/Paperclip/Clara/_INBOX/` und im Issue-Kommentar notieren, warum

### KRITISCH: Pfade bei fs_write_file IMMER absolut

`fs_write_file` löst relative Pfade zu deinem Arbeitsverzeichnis auf — **nicht** zum Vault.

**Richtig:** `{vault}/Paperclip/Clara/Recherche/foo.md`
**Falsch:** `Paperclip/Clara/Recherche/foo.md`

## Dokument-Frontmatter (Pflicht)

Jede von dir erzeugte .md-Datei beginnt mit folgendem YAML-Frontmatter:

```yaml
---
title: "Kurztitel des Dokuments"
datum: YYYY-MM-DD
paperclip_issue_id: "CLA-XX"
paperclip_issue_title: "Kurztitel aus dem Issue"
paperclip_agent: "{agent_name}"
paperclip_company: "clara-sound"
paperclip_status: "done"
paperclip_created_at: "YYYY-MM-DD"
type: recherche
tags: [paperclip, clara-sound]
zusammenfassung: ""
---
```

- `title`: Kurzer Dokumenttitel (1 Zeile, für Obsidian-Suche und Dataview)
- `datum`: Erstellungsdatum ISO (identisch mit `paperclip_created_at`)
- `paperclip_issue_id` und `paperclip_issue_title` aus dem Issue-Kontext (Prefix `CLA-`)
- `paperclip_agent` ist dein Name exakt wie oben ({agent_name})
- `paperclip_company`: immer `clara-sound`
- `type` ist eine kurze Kategorisierung (z.B. `recherche`, `briefing`, `deliverable`, `post`, `drehbuch`, `songtext`, `doku`, `analyse`)
- `tags` enthält immer `paperclip` und `clara-sound`, dann thematische Tags
- `zusammenfassung`: 1-2 Sätze Inhaltsbeschreibung (für Dataview und Suche)
- Bei Updates eines bestehenden Dokuments: Frontmatter beibehalten, `paperclip_status` und ggf. weitere Felder aktualisieren
<!-- END: vault-write-standard V1 -->
"""


# ---------------------------------------------------------------------------
# Hilfsfunktionen
# ---------------------------------------------------------------------------

def extract_agent_name_from_yaml(content: str) -> str:
    """Extrahiert den Agent-Namen aus dem bestehenden paperclip_agent-Feld."""
    m = re.search(r'paperclip_agent: "([^"]+)"', content)
    return m.group(1) if m else "Unknown"

def extract_type_from_yaml(content: str) -> str:
    """Extrahiert den type-Wert aus dem bestehenden YAML-Block."""
    m = re.search(r"type: (\w+)\n", content)
    return m.group(1) if m else "strategie"

def extract_agent_name_from_header(content: str) -> str:
    """Extrahiert den Agent-Kurznamen aus dem Markdown-Heading."""
    m = re.match(r"# (.+)", content)
    if m:
        return m.group(1).strip()
    return "Agent"

def get_clara_agent_short_name(content: str) -> str:
    """Extrahiert den Rollennamen aus dem Clara-Agent (z.B. 'Recherche', 'Redaktion & PR')."""
    m = re.match(r"# (.+?) — Clara Sound", content)
    if m:
        return m.group(1).strip()
    m = re.match(r"# (.+)", content)
    if m:
        return m.group(1).strip()
    return "Agent"


# ---------------------------------------------------------------------------
# Verarbeitungslogik
# ---------------------------------------------------------------------------

def update_whitestag_agent(path: Path, apply: bool, log_lines: list[str]) -> bool:
    content = path.read_text(encoding="utf-8")

    # Prüfe ob YAML-Block vorhanden
    m = OLD_FM_PATTERN.search(content)
    if not m:
        log_lines.append(f"  SKIP  (kein passendes YAML-Muster): {path.name}")
        return False

    agent_name = extract_agent_name_from_yaml(content)
    type_value = extract_type_from_yaml(content)

    new_yaml = build_new_whitestag_yaml(agent_name, type_value)
    new_content = OLD_FM_PATTERN.sub(new_yaml, content, count=1)

    # Erklärungstext aktualisieren
    new_explanation = build_new_whitestag_explanation(agent_name)
    m2 = OLD_EXPLANATION_PATTERN.search(new_content)
    if m2:
        new_content = OLD_EXPLANATION_PATTERN.sub(new_explanation, new_content, count=1)
        log_lines.append(f"  {'WRITE' if apply else 'DRY  '} WHITESTAG [{agent_name}]: YAML + Erklärung aktualisiert")
    else:
        log_lines.append(f"  {'WRITE' if apply else 'DRY  '} WHITESTAG [{agent_name}]: nur YAML aktualisiert (Erklärung nicht gefunden)")

    if apply:
        path.write_text(new_content, encoding="utf-8")
    return True


def update_clara_agent(path: Path, agent_id: str, apply: bool, log_lines: list[str]) -> bool:
    content = path.read_text(encoding="utf-8")

    # Prüfe ob bereits vorhanden
    if "vault-write-standard" in content or "Dokument-Frontmatter (Pflicht)" in content:
        log_lines.append(f"  SKIP  (bereits vorhanden): {path.name}")
        return False

    agent_name = get_clara_agent_short_name(content)

    section = CLARA_VAULT_SECTION_TEMPLATE.format(
        vault=VAULT,
        agent_name=agent_name,
    )

    # Einfügen nach <!-- brain-tool-block --> Block (nach der zweiten Leerzeile nach dem Block)
    insert_marker = "<!-- brain-tool-block -->"
    if insert_marker in content:
        # Finde Ende des brain-tool-blocks: erste Zeile die mit "**Wann nutzen:**..." anfängt
        end_pattern = re.compile(r"\*\*Wann nutzen:\*\*[^\n]*\n\n")
        m = end_pattern.search(content)
        if m:
            insert_pos = m.end()
            new_content = content[:insert_pos] + section + content[insert_pos:]
        else:
            # Fallback: hänge am Ende des brain-tool-block Abschnitts an
            new_content = content + "\n" + section
    else:
        # Kein brain-tool-block → vor dem restlichen Inhalt einfügen (nach H1)
        h1_end = re.search(r"\n\n", content)
        if h1_end:
            new_content = content[:h1_end.end()] + section + content[h1_end.end():]
        else:
            new_content = content + "\n" + section

    log_lines.append(f"  {'WRITE' if apply else 'DRY  '} CLARA [{agent_name}]: Vault-Sektion + Frontmatter hinzugefügt")

    if apply:
        path.write_text(new_content, encoding="utf-8")
    return True


# ---------------------------------------------------------------------------
# Hauptprogramm
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Agents Frontmatter Updater")
    parser.add_argument("--apply", action="store_true", help="Änderungen schreiben")
    parser.add_argument("--company", choices=["whitestag", "clara", "all"], default="all")
    args = parser.parse_args()

    log_lines: list[str] = []
    mode = "APPLY" if args.apply else "DRY-RUN"
    print(f"\n{'='*60}")
    print(f"Agents Frontmatter Updater [{mode}]")
    print(f"{'='*60}")

    total = 0

    # WHITESTAG
    if args.company in ("whitestag", "all"):
        ws_dir = BASE / WHITESTAG_COMPANY / "agents"
        print(f"\n[WHITESTAG] Durchsuche {ws_dir}")
        for agent_dir in sorted(ws_dir.iterdir()):
            agents_md = agent_dir / "instructions" / "AGENTS.md"
            if agents_md.exists():
                if update_whitestag_agent(agents_md, args.apply, log_lines):
                    total += 1

    # Clara
    if args.company in ("clara", "all"):
        clara_dir = BASE / CLARA_COMPANY / "agents"
        print(f"\n[CLARA] Durchsuche {clara_dir}")
        for agent_id in CLARA_VAULT_WRITERS:
            agents_md = clara_dir / agent_id / "instructions" / "AGENTS.md"
            if agents_md.exists():
                if update_clara_agent(agents_md, agent_id, args.apply, log_lines):
                    total += 1
            else:
                log_lines.append(f"  MISSING: {agent_id}/instructions/AGENTS.md")

    print("\n" + "\n".join(log_lines))
    print(f"\nGesamt: {total} Dateien {'geändert' if args.apply else 'würden geändert'}")


if __name__ == "__main__":
    main()
