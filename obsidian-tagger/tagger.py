#!/usr/bin/env python3
"""
Obsidian Frontmatter-Tagger
===========================
Geht durch alle .md-Dateien eines Obsidian-Vaults und ergänzt Frontmatter,
wo es fehlt. Nutzt ein lokales LM-Studio-Modell (OpenAI-kompatible API).

Quelle der Wahrheit für Felder, Tag-Taxonomie, Ausschlüsse und LLM-Konfig:
    obsidian-tagger/templates/frontmatter-template.yaml

Default ist Dry-Run. Schreiben nur mit --apply.
"""
from __future__ import annotations
import argparse
import fnmatch
import json
import os
import re
import shutil
import sys
import time
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any

import urllib.request
import urllib.error

try:
    import yaml
except ImportError:
    sys.stderr.write("Brauche PyYAML. Installiere mit:  pip3 install pyyaml\n")
    sys.exit(2)


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_TEMPLATE = SCRIPT_DIR / "templates" / "frontmatter-template.yaml"
DEFAULT_VAULT = Path("/Volumes/WHITESTAG-ARCHIV/Obsidian/WHITESTAG-Vault")
PENDING_TAGS_FILE = SCRIPT_DIR / "pending_tags.yaml"
LOG_FILE = SCRIPT_DIR / "tagger.log"


# ---------------------------------------------------------------------------
# Template laden
# ---------------------------------------------------------------------------
@dataclass
class Template:
    raw: dict
    basis_felder: list[str]
    typen: dict
    flat_tags: list[str]
    ignore_pfade: list[str]
    ignore_pattern: list[str]
    min_zeichen: int
    modell: str
    endpoint: str
    temperatur: float
    max_input_chars: int
    json_schema_strict: bool
    backup_dir: str
    max_dateien: int

    @classmethod
    def load(cls, path: Path) -> "Template":
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
        flat = []
        for _gruppe, tags in (data.get("tag_taxonomie") or {}).items():
            flat.extend(tags or [])
        ig = data.get("ignoriere") or {}
        llm = data.get("llm") or {}
        sec = data.get("sicherheit") or {}
        return cls(
            raw=data,
            basis_felder=list((data.get("basis") or {}).keys()),
            typen=data.get("typen") or {},
            flat_tags=flat,
            ignore_pfade=ig.get("pfade") or [],
            ignore_pattern=ig.get("pattern") or [],
            min_zeichen=int(ig.get("min_zeichen") or 50),
            modell=llm.get("modell") or "mistral-small-3.2-24b-instruct-2506",
            endpoint=llm.get("endpoint") or "http://127.0.0.1:1234/v1/chat/completions",
            temperatur=float(llm.get("temperatur") or 0.2),
            max_input_chars=int(llm.get("max_input_chars") or 8000),
            json_schema_strict=bool(llm.get("json_schema_strict")),
            backup_dir=sec.get("backup_dir") or ".obsidian-tagger-backup/",
            max_dateien=int(sec.get("max_dateien_pro_lauf") or 100),
        )


# ---------------------------------------------------------------------------
# Vault-Scan: Dateien ohne Frontmatter
# ---------------------------------------------------------------------------
def has_frontmatter(path: Path) -> bool:
    try:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            return fh.read(8).startswith("---\n") or fh.read(0) == ""  # 8 Bytes reichen für ---\n
    except OSError:
        return True  # Fehler -> nicht anfassen


def is_ignored(rel: Path, tpl: Template) -> bool:
    s = str(rel).replace(os.sep, "/")
    for p in tpl.ignore_pfade:
        if s.startswith(p) or f"/{p}" in f"/{s}":
            return True
    name = rel.name
    for pat in tpl.ignore_pattern:
        if fnmatch.fnmatch(name, pat):
            return True
    return False


def scan_missing(vault: Path, tpl: Template) -> list[Path]:
    out = []
    for root, dirs, files in os.walk(vault):
        rroot = Path(root).relative_to(vault)
        dirs[:] = [d for d in dirs if not is_ignored(rroot / d, tpl) and d not in (".git",)]
        for f in files:
            if not f.endswith(".md"):
                continue
            full = Path(root) / f
            rel = full.relative_to(vault)
            if is_ignored(rel, tpl):
                continue
            try:
                if full.stat().st_size < tpl.min_zeichen:
                    continue
            except OSError:
                continue
            try:
                with full.open("r", encoding="utf-8", errors="replace") as fh:
                    head = fh.read(8)
            except OSError:
                continue
            if head.startswith("---\n") or head.startswith("---\r\n"):
                continue
            out.append(full)
    return out


# ---------------------------------------------------------------------------
# LLM-Aufruf
# ---------------------------------------------------------------------------
SYSTEM_PROMPT = """Du bist ein Metadaten-Extraktor für Obsidian-Notizen.
Antworte IMMER mit einem JSON-Objekt, das exakt dem vorgegebenen Schema entspricht.
Verwende ausschließlich Tags aus der vorgegebenen Tag-Liste.
Wenn ein Feld nicht aus dem Text ableitbar ist, lasse es weg (nicht raten).
Antworte auf Deutsch."""


def build_user_prompt(text: str, filename: str, tpl: Template) -> str:
    typen = list(tpl.typen.keys())
    return f"""Analysiere die folgende Obsidian-Notiz und extrahiere Metadaten.

DATEINAME: {filename}

ERLAUBTE WERTE:
- typ: {', '.join(typen)}
- status: Entwurf | In Bearbeitung | Abgeschlossen | Archiviert
- tags: NUR aus dieser Liste: {', '.join(tpl.flat_tags)}

PFLICHTFELDER: title, tags (2-6 Stück), typ, zusammenfassung
OPTIONAL: datum (YYYY-MM-DD wenn aus Text/Name ableitbar), status, quelle

NOTIZ:
\"\"\"
{text[:tpl.max_input_chars]}
\"\"\"
"""


def llm_extract(text: str, filename: str, tpl: Template, timeout: int = 180) -> dict:
    schema = {
        "name": "frontmatter",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "datum": {"type": "string"},
                "tags": {
                    "type": "array",
                    "items": {"type": "string", "enum": tpl.flat_tags},
                    "minItems": 2,
                    "maxItems": 6,
                },
                "typ": {"type": "string", "enum": list(tpl.typen.keys())},
                "status": {
                    "type": "string",
                    "enum": ["Entwurf", "In Bearbeitung", "Abgeschlossen", "Archiviert"],
                },
                "zusammenfassung": {"type": "string"},
                "quelle": {"type": "string"},
            },
            "required": ["title", "tags", "typ", "zusammenfassung"],
            "additionalProperties": False,
        },
    }
    body = {
        "model": tpl.modell,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": build_user_prompt(text, filename, tpl)},
        ],
        "temperature": tpl.temperatur,
        "response_format": {"type": "json_schema", "json_schema": schema},
    }
    req = urllib.request.Request(
        tpl.endpoint,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    content = payload["choices"][0]["message"]["content"]
    return json.loads(content)


# ---------------------------------------------------------------------------
# Frontmatter rendern + einfügen
# ---------------------------------------------------------------------------
FIELD_ORDER = ["title", "datum", "erstellt", "aktualisiert", "tags", "typ", "status", "zusammenfassung", "quelle"]


def render_frontmatter(meta: dict) -> str:
    ordered = {k: meta[k] for k in FIELD_ORDER if k in meta and meta[k] not in (None, "", [])}
    extras = {k: v for k, v in meta.items() if k not in ordered and v not in (None, "", [])}
    ordered.update(extras)
    body = yaml.safe_dump(
        ordered,
        sort_keys=False,
        allow_unicode=True,
        default_flow_style=False,
        width=10**9,
    )
    return f"---\n{body}---\n"


def file_dates(path: Path) -> tuple[str, str]:
    st = path.stat()
    erstellt = datetime.fromtimestamp(st.st_birthtime if hasattr(st, "st_birthtime") else st.st_ctime).date().isoformat()
    aktualisiert = datetime.fromtimestamp(st.st_mtime).date().isoformat()
    return erstellt, aktualisiert


def date_from_name(name: str) -> str | None:
    # 2026-04-25, 25.04.2026
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", name)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    m = re.search(r"(\d{2})\.(\d{2})\.(\d{4})", name)
    if m:
        return f"{m.group(3)}-{m.group(2)}-{m.group(1)}"
    return None


TAGESPROTOKOLL_RE = re.compile(r"^(\d{2})\.(\d{2})\.(\d{4})$")


def enrich(meta: dict, path: Path) -> dict:
    erstellt, aktualisiert = file_dates(path)
    meta.setdefault("erstellt", erstellt)
    meta.setdefault("aktualisiert", aktualisiert)

    name_date = date_from_name(path.name) or date_from_name(str(path))
    if "datum" not in meta and name_date:
        meta["datum"] = name_date

    is_tagesprotokoll = (
        path.parent.name == "Tagesprotokolle"
        and TAGESPROTOKOLL_RE.match(path.stem) is not None
    )
    if is_tagesprotokoll and name_date:
        meta["title"] = f"Tagesprotokoll {path.stem}"
        meta["erstellt"] = name_date
        meta["aktualisiert"] = name_date
        meta["typ"] = "Tagesprotokoll"

    meta.setdefault("status", "Abgeschlossen")
    if "title" not in meta or not meta["title"]:
        meta["title"] = path.stem
    return meta


def backup_file(path: Path, vault: Path, backup_root: Path) -> Path:
    rel = path.relative_to(vault)
    target = backup_root / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, target)
    return target


def write_with_frontmatter(path: Path, meta: dict) -> None:
    original = path.read_text(encoding="utf-8")
    fm = render_frontmatter(meta)
    new = fm + "\n" + original.lstrip("\n")
    tmp = path.with_suffix(path.suffix + ".tagger.tmp")
    tmp.write_text(new, encoding="utf-8")
    tmp.replace(path)


# ---------------------------------------------------------------------------
# Pending Tags (LLM hat etwas außerhalb der Taxonomie versucht)
# ---------------------------------------------------------------------------
def record_pending_tags(suggested: list[str], known: list[str], path: Path) -> list[str]:
    new = [t for t in suggested if t and t not in known]
    if not new:
        return []
    existing = {}
    if PENDING_TAGS_FILE.exists():
        existing = yaml.safe_load(PENDING_TAGS_FILE.read_text(encoding="utf-8")) or {}
    bucket = existing.setdefault("vorschlaege", {})
    for t in new:
        bucket.setdefault(t, []).append(str(path))
    PENDING_TAGS_FILE.write_text(
        yaml.safe_dump(existing, allow_unicode=True, sort_keys=True),
        encoding="utf-8",
    )
    return new


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
def log(msg: str) -> None:
    line = f"[{datetime.now().isoformat(timespec='seconds')}] {msg}"
    print(line)
    try:
        with LOG_FILE.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description="Obsidian Frontmatter-Tagger")
    ap.add_argument("--vault", type=Path, default=DEFAULT_VAULT, help="Pfad zum Vault")
    ap.add_argument("--template", type=Path, default=DEFAULT_TEMPLATE, help="Pfad zum YAML-Template")
    ap.add_argument("--apply", action="store_true", help="Schreiben aktivieren (default: dry-run)")
    ap.add_argument("--limit", type=int, default=None, help="Max. Dateien diesem Lauf (Override gegen Template)")
    ap.add_argument("--only", type=Path, default=None, help="Nur eine Datei bearbeiten")
    ap.add_argument("--list", action="store_true", help="Nur Dateien auflisten, kein LLM-Call")
    ap.add_argument("--report", action="store_true", help="Markdown-Report in <vault>/Paperclip/_Meta/Vault-Tagger-Reports/ schreiben")
    ap.add_argument("--report-dir", type=Path, default=None, help="Override für Report-Verzeichnis")
    args = ap.parse_args()

    if not args.template.exists():
        log(f"FEHLER: Template fehlt: {args.template}")
        return 2
    tpl = Template.load(args.template)
    if not args.vault.exists():
        log(f"FEHLER: Vault nicht erreichbar: {args.vault}")
        return 2

    if args.only:
        targets = [args.only.resolve()]
    else:
        log(f"Scanne Vault: {args.vault}")
        targets = scan_missing(args.vault, tpl)
        log(f"Gefunden ohne Frontmatter: {len(targets)}")

    if args.list:
        for p in targets:
            print(p)
        return 0

    limit = args.limit or tpl.max_dateien
    targets = targets[:limit]
    log(f"Zu bearbeiten: {len(targets)} (Limit {limit})  Modus={'APPLY' if args.apply else 'DRY-RUN'}")

    backup_root = args.vault / tpl.backup_dir
    if args.apply:
        backup_root.mkdir(parents=True, exist_ok=True)

    ok = fail = 0
    run_started = datetime.now()
    processed: list[dict] = []
    failures: list[dict] = []
    for i, path in enumerate(targets, 1):
        rel = path.relative_to(args.vault) if args.vault in path.parents or path == args.vault else path
        log(f"[{i}/{len(targets)}] {rel}")
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError as e:
            log(f"  LESEFEHLER: {e}")
            fail += 1
            failures.append({"path": str(path), "stage": "read", "error": str(e)})
            continue
        try:
            t0 = time.time()
            meta = llm_extract(text, path.name, tpl)
            dt = time.time() - t0
        except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError, TimeoutError) as e:
            log(f"  LLM-FEHLER: {e}")
            fail += 1
            failures.append({"path": str(path), "stage": "llm", "error": str(e)})
            continue
        suggested = list(meta.get("tags", []))
        record_pending_tags(suggested, tpl.flat_tags, path)
        meta["tags"] = [t for t in suggested if t in tpl.flat_tags]
        meta = enrich(meta, path)
        log(f"  -> typ={meta.get('typ')}  tags={meta.get('tags')}  ({dt:.1f}s)")

        wrote = False
        if args.apply:
            try:
                backup_file(path, args.vault, backup_root)
                write_with_frontmatter(path, meta)
                ok += 1
                wrote = True
            except OSError as e:
                log(f"  SCHREIBFEHLER: {e}")
                fail += 1
                failures.append({"path": str(path), "stage": "write", "error": str(e)})
                continue
        else:
            ok += 1
            preview = render_frontmatter(meta)
            for line in preview.splitlines():
                log(f"  | {line}")

        try:
            rel_path = str(path.relative_to(args.vault))
        except ValueError:
            rel_path = str(path)
        processed.append({
            "path": rel_path,
            "title": meta.get("title", ""),
            "typ": meta.get("typ", ""),
            "tags": meta.get("tags", []),
            "duration_s": round(dt, 1),
            "wrote": wrote,
        })

    log(f"Fertig. ok={ok} fail={fail} apply={args.apply}")

    if args.report or args.report_dir:
        try:
            report_path = write_report(
                args.report_dir or (args.vault / "Paperclip" / "_Meta" / "Vault-Tagger-Reports"),
                run_started,
                datetime.now(),
                tpl,
                processed,
                failures,
                len(targets),
                args.apply,
            )
            log(f"Report: {report_path}")
            print(f"REPORT_PATH={report_path}")
        except OSError as e:
            log(f"REPORT-FEHLER: {e}")

    return 0 if fail == 0 else 1


def write_report(
    out_dir: Path,
    started: datetime,
    finished: datetime,
    tpl: Template,
    processed: list[dict],
    failures: list[dict],
    total: int,
    applied: bool,
) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = started.strftime("%Y-%m-%d_%H%M")
    report_path = out_dir / f"{stamp}.md"

    pending = {}
    if PENDING_TAGS_FILE.exists():
        pending = yaml.safe_load(PENDING_TAGS_FILE.read_text(encoding="utf-8")) or {}
    pending_now = (pending.get("vorschlaege") or {})

    duration_s = (finished - started).total_seconds()
    ok = sum(1 for p in processed if p.get("wrote") or not applied)
    fail = len(failures)

    lines: list[str] = []
    lines.append("---")
    lines.append(f"title: Vault-Tagger Report {started.strftime('%Y-%m-%d %H:%M')}")
    lines.append(f"datum: '{started.date().isoformat()}'")
    lines.append("typ: Doku")
    lines.append("status: Abgeschlossen")
    lines.append("tags:")
    lines.append("- Automatisierung")
    lines.append("- Dokument")
    lines.append(f"zusammenfassung: '{ok} Dateien getaggt, {fail} Fehler in {duration_s:.0f}s. Modus={'APPLY' if applied else 'DRY-RUN'}.'")
    lines.append("---")
    lines.append("")
    lines.append(f"# Vault-Tagger Report — {started.strftime('%Y-%m-%d %H:%M')}")
    lines.append("")
    lines.append("## Zusammenfassung")
    lines.append("")
    lines.append(f"- Modus: **{'APPLY' if applied else 'DRY-RUN'}**")
    lines.append(f"- Modell: `{tpl.modell}`")
    lines.append(f"- Kandidaten gefunden: **{total}**")
    lines.append(f"- Erfolgreich: **{ok}**")
    lines.append(f"- Fehler: **{fail}**")
    lines.append(f"- Dauer: **{duration_s:.0f}s** ({duration_s/max(total,1):.1f}s/Datei)")
    lines.append(f"- Start: {started.isoformat(timespec='seconds')}")
    lines.append(f"- Ende:  {finished.isoformat(timespec='seconds')}")
    lines.append("")

    lines.append("## Bearbeitete Dateien")
    lines.append("")
    if not processed:
        lines.append("_(keine)_")
    else:
        lines.append("| # | Datei | Typ | Tags | s |")
        lines.append("|---|---|---|---|---|")
        for i, p in enumerate(processed, 1):
            tags = ", ".join(p["tags"])
            lines.append(f"| {i} | `{p['path']}` | {p['typ']} | {tags} | {p['duration_s']} |")
    lines.append("")

    lines.append("## Fehler")
    lines.append("")
    if not failures:
        lines.append("_(keine)_")
    else:
        for f in failures:
            lines.append(f"- **{f['stage']}** `{f['path']}` — {f['error']}")
    lines.append("")

    lines.append("## Pending Tag-Vorschläge")
    lines.append("")
    if not pending_now:
        lines.append("_(keine)_")
    else:
        lines.append("Tags, die das LLM vorgeschlagen hat aber nicht in der Taxonomie sind. Sichtung durch DPO empfohlen.")
        lines.append("")
        lines.append("| Vorschlag | Häufigkeit | Beispiel-Pfad |")
        lines.append("|---|---|---|")
        for tag, paths in sorted(pending_now.items(), key=lambda kv: -len(kv[1])):
            example = paths[0] if paths else ""
            lines.append(f"| `{tag}` | {len(paths)} | `{example}` |")
    lines.append("")

    lines.append("---")
    lines.append("")
    lines.append("Generiert von `obsidian-tagger/tagger.py`. Template: `obsidian-tagger/templates/frontmatter-template.yaml`.")

    report_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return report_path


if __name__ == "__main__":
    sys.exit(main())
