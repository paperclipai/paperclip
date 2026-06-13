#!/usr/bin/env python3
"""
Vault Meta Backfill
===================
Ergänzt und korrigiert Frontmatter-Felder regelbasiert (kein LLM) für:

  1. Chatverlauf-Dateien   → Claude Code/<Projekt>/*Chatverlauf*.md
  2. Tagesprotokolle       → Tagesprotokolle/YYYY-MM-DD.md
  3. Health Daily          → Health/Daily/YYYY-MM-DD.md

Regeln:
  - typ: Notiz  →  typ: Chatverlauf  (nur Chatverlauf-Dateien)
  - projekt     →  aus übergeordnetem Ordnernamen ableiten
  - modell      →  aus quelle-Feld extrahieren (best-effort)
  - Tagesprotokolle ohne Frontmatter → minimales Frontmatter hinzufügen
  - Health Daily ohne Frontmatter    → minimales Frontmatter + Metriken hinzufügen

Standard: Dry-Run. Schreiben nur mit --apply.
Log-Datei: obsidian-tagger/vault_meta_backfill.log

Usage:
  python3 vault_meta_backfill.py            # Dry-Run
  python3 vault_meta_backfill.py --apply    # Änderungen schreiben
  python3 vault_meta_backfill.py --type chatverlauf --apply
"""
from __future__ import annotations

import argparse
import re
import sys
from datetime import date, datetime
from pathlib import Path

try:
    import yaml
except ImportError:
    sys.stderr.write("Brauche PyYAML:  pip3 install pyyaml\n")
    sys.exit(2)

VAULT = Path("/Users/walterschoenenbroecher.de/Obsidian/WHITESTAG-Vault")
SCRIPT_DIR = Path(__file__).resolve().parent
LOG_FILE = SCRIPT_DIR / "vault_meta_backfill.log"

# Modell-Extraktion aus quelle-Feld
MODEL_PATTERNS = [
    (r"Opus 4\.8",        "claude-opus-4-8"),
    (r"Opus 4\.7",        "claude-opus-4-7"),
    (r"Opus 4\.6",        "claude-opus-4-6"),
    (r"Opus 4",           "claude-opus-4"),
    (r"Sonnet 4\.6",      "claude-sonnet-4-6"),
    (r"Sonnet 4\.5",      "claude-sonnet-4-5"),
    (r"Sonnet 4",         "claude-sonnet-4"),
    (r"Haiku 4\.5",       "claude-haiku-4-5"),
    (r"Haiku 4",          "claude-haiku-4"),
    (r"claude-opus-4-8",  "claude-opus-4-8"),
    (r"claude-opus-4-7",  "claude-opus-4-7"),
    (r"claude-sonnet-4",  "claude-sonnet-4-6"),
]


# ---------------------------------------------------------------------------
# YAML Frontmatter Parser / Serializer
# ---------------------------------------------------------------------------

FRONT_RE = re.compile(r"^---\r?\n(.*?)\r?\n---\r?\n", re.DOTALL)


def parse_file(path: Path) -> tuple[dict, str]:
    """Gibt (frontmatter_dict, body_ohne_frontmatter) zurück."""
    text = path.read_text(encoding="utf-8")
    m = FRONT_RE.match(text)
    if m:
        try:
            fm = yaml.safe_load(m.group(1)) or {}
        except yaml.YAMLError:
            fm = {}
        body = text[m.end():]
    else:
        fm = {}
        body = text
    return fm, body


def serialize_frontmatter(fm: dict) -> str:
    return "---\n" + yaml.dump(
        fm,
        allow_unicode=True,
        default_flow_style=False,
        sort_keys=False,
    ) + "---\n"


def write_file(path: Path, fm: dict, body: str) -> None:
    path.write_text(serialize_frontmatter(fm) + body, encoding="utf-8")


# ---------------------------------------------------------------------------
# Hilfsfunktionen
# ---------------------------------------------------------------------------

def extract_model(quelle: str) -> str:
    """Extrahiert Modell-ID aus quelle-String. Gibt '' zurück wenn unbekannt."""
    if not quelle:
        return ""
    for pattern, model_id in MODEL_PATTERNS:
        if re.search(pattern, quelle, re.IGNORECASE):
            return model_id
    return ""


def extract_date_from_filename(path: Path) -> str | None:
    """Extrahiert YYYY-MM-DD aus Dateinamen wenn vorhanden."""
    m = re.match(r"(\d{4}-\d{2}-\d{2})", path.stem)
    return m.group(1) if m else None


def log(msg: str, log_lines: list[str]) -> None:
    print(msg)
    log_lines.append(msg)


# ---------------------------------------------------------------------------
# Verarbeitungslogik: Chatverlauf
# ---------------------------------------------------------------------------

def process_chatverlauf(path: Path, apply: bool, log_lines: list[str]) -> bool:
    """Verarbeitet eine Chatverlauf-Datei. Gibt True zurück wenn Änderungen."""
    fm, body = parse_file(path)
    changes: list[str] = []

    # projekt aus übergeordnetem Verzeichnis
    parent_name = path.parent.name
    base_dir = VAULT / "Claude Code"
    if path.parent == base_dir:
        projekt = "Allgemein"
    else:
        projekt = parent_name

    # typ: Notiz → Chatverlauf
    if fm.get("typ") == "Notiz":
        fm["typ"] = "Chatverlauf"
        changes.append("typ: Notiz → Chatverlauf")
    elif "typ" not in fm:
        fm["typ"] = "Chatverlauf"
        changes.append("typ hinzugefügt: Chatverlauf")

    # projekt ergänzen
    if "projekt" not in fm:
        fm["projekt"] = projekt
        changes.append(f"projekt hinzugefügt: {projekt}")

    # modell ergänzen (aus quelle ableiten)
    if "modell" not in fm:
        quelle = str(fm.get("quelle", ""))
        modell = extract_model(quelle)
        fm["modell"] = modell
        label = modell if modell else "(unbekannt)"
        changes.append(f"modell hinzugefügt: {label}")

    if not changes:
        return False

    log(f"  {'WRITE' if apply else 'DRY '} {path.relative_to(VAULT)}", log_lines)
    for c in changes:
        log(f"         {c}", log_lines)

    if apply:
        write_file(path, fm, body)
    return True


# ---------------------------------------------------------------------------
# Verarbeitungslogik: Tagesprotokolle
# ---------------------------------------------------------------------------

def process_tagesprotokoll(path: Path, apply: bool, log_lines: list[str]) -> bool:
    """Ergänzt minimales Frontmatter wenn keines vorhanden."""
    fm, body = parse_file(path)

    if fm:
        # Schon Frontmatter vorhanden — nur typ prüfen
        changes: list[str] = []
        if "typ" not in fm:
            fm["typ"] = "Tagesprotokoll"
            changes.append("typ hinzugefügt: Tagesprotokoll")
        if "datum" not in fm:
            d = extract_date_from_filename(path)
            if d:
                fm["datum"] = d
                changes.append(f"datum hinzugefügt: {d}")
        if not changes:
            return False
        log(f"  {'WRITE' if apply else 'DRY '} {path.relative_to(VAULT)}", log_lines)
        for c in changes:
            log(f"         {c}", log_lines)
        if apply:
            write_file(path, fm, body)
        return True

    # Kein Frontmatter — neu erstellen
    d = extract_date_from_filename(path)
    if not d:
        return False  # Dateiname passt nicht zum Schema

    # Projekte aus Sektions-Headings ableiten
    sektionen = re.findall(r"^## (.+)", body, re.MULTILINE)
    projekte = [s.strip() for s in sektionen if s.strip() not in ("Health",)]

    fm_new: dict = {
        "datum": d,
        "typ": "Tagesprotokoll",
        "tags": [],
        "projekte": projekte if projekte else [],
    }

    log(f"  {'WRITE' if apply else 'DRY '} {path.relative_to(VAULT)}", log_lines)
    log(f"         Frontmatter neu erstellt (datum: {d}, projekte: {projekte})", log_lines)

    if apply:
        write_file(path, fm_new, body)
    return True


# ---------------------------------------------------------------------------
# Verarbeitungslogik: Health Daily
# ---------------------------------------------------------------------------

HEALTH_METRIC_PATTERNS = {
    "schlaf_stunden": [
        r"Total:\s*([\d.,]+)\s*h",
        r"Gesamtschlaf[^:]*:\s*([\d.,]+)\s*h",
    ],
    "hrv": [
        r"HRV.*?:\s*([\d.]+)\s*ms",
        r"HRV \(avg\)[^:]*:\s*([\d.]+)",
    ],
    "ruhepuls": [
        r"Resting HR[^:]*:\s*([\d.]+)\s*bpm",
        r"Ruhepuls[^:]*:\s*([\d.]+)\s*bpm",
    ],
}


def extract_health_metric(body: str, patterns: list[str]) -> float | None:
    for pattern in patterns:
        m = re.search(pattern, body, re.IGNORECASE)
        if m:
            val = m.group(1).replace(",", ".")
            try:
                f = float(val)
                return None if f == 0.0 else f
            except ValueError:
                continue
    return None


def process_health_daily(path: Path, apply: bool, log_lines: list[str]) -> bool:
    fm, body = parse_file(path)
    changes: list[str] = []

    d = extract_date_from_filename(path)
    if not d:
        return False

    if not fm:
        # Neu aufbauen
        fm = {}

    # Pflichtfelder
    if "datum" not in fm:
        fm["datum"] = d
        changes.append(f"datum: {d}")
    if "typ" not in fm:
        fm["typ"] = "Health-Daily"
        changes.append("typ: Health-Daily")
    if "tags" not in fm:
        fm["tags"] = ["health"]
        changes.append("tags: [health]")

    # Metriken aus Body extrahieren (nur wenn noch nicht vorhanden)
    for field, patterns in HEALTH_METRIC_PATTERNS.items():
        if field not in fm:
            val = extract_health_metric(body, patterns)
            if val is not None:
                fm[field] = val
                changes.append(f"{field}: {val}")
            else:
                fm[field] = None
                changes.append(f"{field}: (nicht gefunden → null)")

    # Status Schlaf ableiten (nur wenn schlaf_stunden vorhanden)
    if "status_schlaf" not in fm:
        h = fm.get("schlaf_stunden")
        if isinstance(h, (int, float)) and h > 0:
            if h >= 7:
                status = "🟢"
            elif h >= 5.5:
                status = "🟡"
            else:
                status = "🔴"
            fm["status_schlaf"] = status
            changes.append(f"status_schlaf: {status}")

    if not changes:
        return False

    log(f"  {'WRITE' if apply else 'DRY '} {path.relative_to(VAULT)}", log_lines)
    for c in changes:
        log(f"         {c}", log_lines)

    if apply:
        write_file(path, fm, body)
    return True


# ---------------------------------------------------------------------------
# Verarbeitungslogik: Paperclip Lessons
# ---------------------------------------------------------------------------

def process_lesson(path: Path, apply: bool, log_lines: list[str]) -> bool:
    fm, body = parse_file(path)
    if not fm:
        return False  # Keine Lessons ohne Frontmatter anfassen

    changes: list[str] = []

    # datum ergänzen (= created)
    if "datum" not in fm and "created" in fm:
        fm["datum"] = str(fm["created"])
        changes.append(f"datum: {fm['datum']}")

    # company prüfen — aus Pfad ableiten falls fehlt
    if "company" not in fm:
        # Pfad: .../Paperclip/Agenten/<company>/<agent>/lessons/file.md
        try:
            company = path.parts[path.parts.index("Agenten") + 1]
        except (ValueError, IndexError):
            company = "whitestag"
        fm["company"] = company
        changes.append(f"company: {company}")

    if not changes:
        return False

    log(f"  {'WRITE' if apply else 'DRY '} {path.relative_to(VAULT)}", log_lines)
    for c in changes:
        log(f"         {c}", log_lines)
    if apply:
        write_file(path, fm, body)
    return True


# ---------------------------------------------------------------------------
# Verarbeitungslogik: Paperclip MEMORY.md
# ---------------------------------------------------------------------------

def process_memory_md(path: Path, apply: bool, log_lines: list[str]) -> bool:
    fm, body = parse_file(path)
    if fm:
        return False  # Bereits Frontmatter vorhanden

    # Pfad: .../Paperclip/Agenten/<company>/<agent>/MEMORY.md
    try:
        parts = path.parts
        agenten_idx = parts.index("Agenten")
        company = parts[agenten_idx + 1]
        agent = parts[agenten_idx + 2]
    except (ValueError, IndexError):
        company = "whitestag"
        agent = path.parent.name

    fm_new: dict = {
        "typ": "Agent-Memory",
        "agent": agent,
        "company": company,
        "auto_generiert": True,
        "tags": ["paperclip", "agent-memory"],
    }

    log(f"  {'WRITE' if apply else 'DRY '} {path.relative_to(VAULT)}", log_lines)
    log(f"         Frontmatter neu (agent: {agent}, company: {company})", log_lines)
    if apply:
        write_file(path, fm_new, body)
    return True


# ---------------------------------------------------------------------------
# Verarbeitungslogik: Paperclip Recherche
# ---------------------------------------------------------------------------

def derive_company_from_issue_id(issue_id: str) -> str:
    if not issue_id:
        return "whitestag"
    prefix = issue_id.split("-")[0].upper()
    return {"WHI": "whitestag", "HEA": "health", "CLA": "clara-sound"}.get(prefix, "whitestag")


def extract_h1_title(body: str) -> str:
    m = re.search(r"^# (.+)", body, re.MULTILINE)
    return m.group(1).strip() if m else ""


def process_recherche(path: Path, apply: bool, log_lines: list[str]) -> bool:
    if path.name.startswith("_"):
        return False  # README etc. überspringen
    fm, body = parse_file(path)
    if not fm:
        return False  # Ohne Frontmatter nicht anfassen

    changes: list[str] = []

    # title ergänzen
    if "title" not in fm:
        t = str(fm.get("paperclip_issue_title", "")) or extract_h1_title(body)
        if t:
            fm["title"] = t
            changes.append(f"title: {t[:60]}")

    # datum ergänzen (= paperclip_created_at)
    if "datum" not in fm and "paperclip_created_at" in fm:
        fm["datum"] = str(fm["paperclip_created_at"])
        changes.append(f"datum: {fm['datum']}")

    # paperclip_company ergänzen
    if "paperclip_company" not in fm:
        company = derive_company_from_issue_id(str(fm.get("paperclip_issue_id", "")))
        fm["paperclip_company"] = company
        changes.append(f"paperclip_company: {company}")

    # zusammenfassung ergänzen (leer — kann nicht auto-befüllt werden)
    if "zusammenfassung" not in fm:
        fm["zusammenfassung"] = ""
        changes.append("zusammenfassung: (leer)")

    if not changes:
        return False

    log(f"  {'WRITE' if apply else 'DRY '} {path.relative_to(VAULT)}", log_lines)
    for c in changes:
        log(f"         {c}", log_lines)
    if apply:
        write_file(path, fm, body)
    return True


# ---------------------------------------------------------------------------
# Verarbeitungslogik: Paperclip Projekte
# ---------------------------------------------------------------------------

def process_projekt(path: Path, apply: bool, log_lines: list[str]) -> bool:
    if path.name.startswith("_") or path.name.upper() == "README.MD":
        return False
    fm, body = parse_file(path)
    if not fm:
        return False

    changes: list[str] = []

    # title ergänzen
    if "title" not in fm:
        t = str(fm.get("paperclip_issue_title", "")) or extract_h1_title(body)
        if t:
            fm["title"] = t
            changes.append(f"title: {t[:60]}")

    # datum ergänzen
    if "datum" not in fm and "paperclip_created_at" in fm:
        fm["datum"] = str(fm["paperclip_created_at"])
        changes.append(f"datum: {fm['datum']}")
    elif "datum" not in fm and "erstellt" in fm:
        fm["datum"] = str(fm["erstellt"])
        changes.append(f"datum: {fm['datum']} (aus erstellt)")

    # paperclip_company ergänzen
    if "paperclip_company" not in fm:
        company = derive_company_from_issue_id(str(fm.get("paperclip_issue_id", "")))
        fm["paperclip_company"] = company
        changes.append(f"paperclip_company: {company}")

    # zusammenfassung ergänzen
    if "zusammenfassung" not in fm:
        fm["zusammenfassung"] = ""
        changes.append("zusammenfassung: (leer)")

    if not changes:
        return False

    log(f"  {'WRITE' if apply else 'DRY '} {path.relative_to(VAULT)}", log_lines)
    for c in changes:
        log(f"         {c}", log_lines)
    if apply:
        write_file(path, fm, body)
    return True


# ---------------------------------------------------------------------------
# Verarbeitungslogik: Analysen
# ---------------------------------------------------------------------------

def process_analyse(path: Path, apply: bool, log_lines: list[str]) -> bool:
    fm, body = parse_file(path)
    if not fm:
        return False

    changes: list[str] = []

    # typ: Analysen → typ: Analyse
    if fm.get("typ") == "Analysen":
        fm["typ"] = "Analyse"
        changes.append("typ: Analysen → Analyse")

    # datum aus erstellt ableiten
    if "datum" not in fm and "erstellt" in fm:
        fm["datum"] = str(fm["erstellt"])
        changes.append(f"datum: {fm['datum']} (aus erstellt)")

    if not changes:
        return False

    log(f"  {'WRITE' if apply else 'DRY '} {path.relative_to(VAULT)}", log_lines)
    for c in changes:
        log(f"         {c}", log_lines)
    if apply:
        write_file(path, fm, body)
    return True


# ---------------------------------------------------------------------------
# Hauptprogramm
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Vault Meta Backfill")
    parser.add_argument("--apply", action="store_true", help="Änderungen schreiben")
    parser.add_argument(
        "--type",
        choices=["chatverlauf", "tagesprotokoll", "health",
                 "lesson", "memory", "recherche", "projekt", "analyse", "paperclip"],
        help="Nur diesen Typ verarbeiten (paperclip = alle Paperclip-Typen)",
    )
    args = parser.parse_args()

    log_lines: list[str] = []
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    mode = "APPLY" if args.apply else "DRY-RUN"
    log(f"\n{'='*60}", log_lines)
    log(f"Vault Meta Backfill — {timestamp} [{mode}]", log_lines)
    log(f"{'='*60}", log_lines)

    total_changed = 0

    # 1. Chatverlauf
    if args.type in (None, "chatverlauf"):
        chatverlauf_dir = VAULT / "Claude Code"
        files = sorted(chatverlauf_dir.rglob("*Chatverlauf*.md"))
        log(f"\n[Chatverlauf] {len(files)} Dateien gefunden", log_lines)
        changed = 0
        for f in files:
            if process_chatverlauf(f, args.apply, log_lines):
                changed += 1
        log(f"[Chatverlauf] {changed} Dateien {'geändert' if args.apply else 'würden geändert'}", log_lines)
        total_changed += changed

    # 2. Tagesprotokolle
    if args.type in (None, "tagesprotokoll"):
        tp_dir = VAULT / "Tagesprotokolle"
        files = sorted(tp_dir.glob("*.md"))
        log(f"\n[Tagesprotokoll] {len(files)} Dateien gefunden", log_lines)
        changed = 0
        for f in files:
            if process_tagesprotokoll(f, args.apply, log_lines):
                changed += 1
        log(f"[Tagesprotokoll] {changed} Dateien {'geändert' if args.apply else 'würden geändert'}", log_lines)
        total_changed += changed

    # 3. Health Daily
    if args.type in (None, "health"):
        health_dir = VAULT / "Health" / "Daily"
        files = sorted(health_dir.glob("*.md"))
        log(f"\n[Health Daily] {len(files)} Dateien gefunden", log_lines)
        changed = 0
        for f in files:
            if process_health_daily(f, args.apply, log_lines):
                changed += 1
        log(f"[Health Daily] {changed} Dateien {'geändert' if args.apply else 'würden geändert'}", log_lines)
        total_changed += changed

    # 4. Paperclip Lessons
    if args.type in (None, "lesson", "paperclip"):
        lesson_files = sorted(
            (VAULT / "Paperclip" / "Agenten").rglob("*.md")
        )
        lesson_files = [f for f in lesson_files if "lessons" in f.parts]
        log(f"\n[Lessons] {len(lesson_files)} Dateien gefunden", log_lines)
        changed = 0
        for f in lesson_files:
            if process_lesson(f, args.apply, log_lines):
                changed += 1
        log(f"[Lessons] {changed} Dateien {'geändert' if args.apply else 'würden geändert'}", log_lines)
        total_changed += changed

    # 5. Paperclip MEMORY.md
    if args.type in (None, "memory", "paperclip"):
        memory_files = sorted(
            (VAULT / "Paperclip" / "Agenten").rglob("MEMORY.md")
        )
        log(f"\n[MEMORY.md] {len(memory_files)} Dateien gefunden", log_lines)
        changed = 0
        for f in memory_files:
            if process_memory_md(f, args.apply, log_lines):
                changed += 1
        log(f"[MEMORY.md] {changed} Dateien {'geändert' if args.apply else 'würden geändert'}", log_lines)
        total_changed += changed

    # 6. Paperclip Recherche
    if args.type in (None, "recherche", "paperclip"):
        recherche_files = sorted(
            (VAULT / "Paperclip" / "Recherche").rglob("*.md")
        )
        log(f"\n[Recherche] {len(recherche_files)} Dateien gefunden", log_lines)
        changed = 0
        for f in recherche_files:
            if process_recherche(f, args.apply, log_lines):
                changed += 1
        log(f"[Recherche] {changed} Dateien {'geändert' if args.apply else 'würden geändert'}", log_lines)
        total_changed += changed

    # 7. Paperclip Projekte
    if args.type in (None, "projekt", "paperclip"):
        projekt_files = sorted(
            (VAULT / "Paperclip" / "Projekte").rglob("*.md")
        )
        log(f"\n[Projekte] {len(projekt_files)} Dateien gefunden", log_lines)
        changed = 0
        for f in projekt_files:
            if process_projekt(f, args.apply, log_lines):
                changed += 1
        log(f"[Projekte] {changed} Dateien {'geändert' if args.apply else 'würden geändert'}", log_lines)
        total_changed += changed

    # 8. Analysen
    if args.type in (None, "analyse", "paperclip"):
        analysen_files = sorted((VAULT / "Analysen").rglob("*.md"))
        log(f"\n[Analysen] {len(analysen_files)} Dateien gefunden", log_lines)
        changed = 0
        for f in analysen_files:
            if process_analyse(f, args.apply, log_lines):
                changed += 1
        log(f"[Analysen] {changed} Dateien {'geändert' if args.apply else 'würden geändert'}", log_lines)
        total_changed += changed

    log(f"\nGesamt: {total_changed} Dateien {'geändert' if args.apply else 'würden geändert'}", log_lines)

    # Log schreiben
    LOG_FILE.write_text("\n".join(log_lines) + "\n", encoding="utf-8")
    print(f"\nLog: {LOG_FILE}")


if __name__ == "__main__":
    main()
