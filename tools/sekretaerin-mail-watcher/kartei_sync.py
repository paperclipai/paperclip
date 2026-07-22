#!/usr/bin/env python3
"""Deterministischer Pfleger der Empfänger-Signatur-Kartei (Luna).

Läuft bei jedem Watcher-Tick vor der Mail-Prüfung. Zwei Quellen, beide ohne LLM:

1. **Postfach-Lernen:** Für jede eingehende Mail mit eindeutigem Zielpostfach
   (whitestag.ai/.film, sorbart.de/.shop) wird die Absender-Domain dem Bereich
   zugeordnet und — falls neu — als Domain-Zeile ergänzt (Quelle `postfach`).

2. **Walters Rückfrage-Antworten:** Mails von Walter mit Betreff
   `Re:/AW: [Luna] Bereich? <adresse>` werden gelesen; der Bereich aus der
   Antwort (AI/FILM/SORBART/PRIVAT, case-insensitive) wird als konkrete
   Adress-Zeile eingetragen (Quelle `walter`, überschreibt `auto`/`postfach`).

Idempotent: bereits erfasste Einträge werden nicht dupliziert. Adress-Einträge
haben Vorrang vor Domain-Einträgen (getrennte Tabellen in der Kartei).
"""
from __future__ import annotations

import re
from datetime import date
from pathlib import Path

MAILDIR = Path.home() / "Obsidian" / "WHITESTAG-Vault" / "E-Mails"
KARTEI = Path.home() / "Obsidian" / "WHITESTAG-Vault" / "Paperclip" / "Luna" / "empfaenger-signaturen.md"

WALTER_SENDERS = ("ws@whitestag.", "walter@schoenenbroecher.de", "ws@sorbart.")
VALID = {"AI", "FILM", "SORBART", "PRIVAT"}
EMAIL_RE = re.compile(r"[\w.+-]+@[\w.-]+\.\w+")


def _postfach_bereich(an: str) -> str | None:
    an = an.lower()
    if "whitestag.ai" in an:
        return "AI"
    if "whitestag.film" in an:
        return "FILM"
    if "sorbart.de" in an or "sorbart.shop" in an:
        return "SORBART"
    return None


def _frontmatter(path: Path) -> dict:
    fm = {}
    try:
        with path.open(encoding="utf-8") as fh:
            for _ in range(16):
                line = fh.readline()
                if not line:
                    break
                low = line.lower()
                for key in ("von:", "from:", "an:", "to:", "betreff:", "subject:"):
                    if low.startswith(key):
                        fm[key.rstrip(":")] = line.split(":", 1)[1].strip().strip('"')
    except OSError:
        pass
    return fm


def _load_card() -> tuple[list[str], set[str], set[str]]:
    """Zeilen + bereits erfasste Adressen/Domains (lowercase)."""
    lines = KARTEI.read_text(encoding="utf-8").splitlines()
    addrs, doms = set(), set()
    for ln in lines:
        m = re.match(r"\|\s*(@?[\w.+@-]+)\s*\|", ln)
        if not m:
            continue
        key = m.group(1).lower()
        if key in ("e-mail-adresse", "domain"):
            continue
        (doms if key.startswith("@") else addrs).add(key)
    return lines, addrs, doms


def _insert_row(lines: list[str], section_header: str, row: str) -> list[str]:
    """Zeile direkt nach der Tabellenkopf-Trennzeile des Abschnitts einfügen."""
    out, i = [], 0
    in_section = False
    inserted = False
    while i < len(lines):
        ln = lines[i]
        out.append(ln)
        if ln.strip() == section_header:
            in_section = True
        elif in_section and not inserted and re.match(r"\|\s*-+", ln):
            out.append(row)
            inserted = True
            in_section = False
        i += 1
    if not inserted:  # Abschnitt/Trennzeile nicht gefunden → ans Ende
        out.append(row)
    return out


def sync() -> list[str]:
    """Führt beide Lernquellen aus. Gibt Log-Zeilen zurück."""
    if not KARTEI.exists() or not MAILDIR.is_dir():
        return [f"kartei_sync: Pfad fehlt ({KARTEI if not KARTEI.exists() else MAILDIR})"]

    lines, addrs, doms = _load_card()
    today = date.today().isoformat()
    log = []
    new_dom: dict[str, str] = {}   # domain -> bereich (postfach)
    new_addr: dict[str, str] = {}  # address -> bereich (walter)

    for p in sorted(MAILDIR.glob("*.md")):
        fm = _frontmatter(p)
        von = (fm.get("von") or fm.get("from") or "")
        an = (fm.get("an") or fm.get("to") or "")
        betreff = (fm.get("betreff") or fm.get("subject") or "")

        # Quelle 2: Walters Rückfrage-Antwort (hat Vorrang, konkrete Adresse)
        if any(s in von.lower() for s in WALTER_SENDERS) and "[luna] bereich?" in betreff.lower():
            target = EMAIL_RE.search(betreff)
            bereich = _bereich_from_body(p)
            if target and bereich:
                a = target.group(0).lower()
                if a not in addrs and a not in new_addr:
                    new_addr[a] = bereich
            continue

        # Quelle 1: Postfach-Lernen (Domain)
        b = _postfach_bereich(an)
        if not b:
            continue
        m = EMAIL_RE.search(von)
        if not m:
            continue
        email = m.group(0).lower()
        if any(x in email for x in ("whitestag.", "sorbart.", "mailer-daemon",
                                    "no-reply", "noreply", "postmaster")):
            continue
        dom = "@" + email.split("@", 1)[1]
        if dom not in doms and dom not in new_dom:
            new_dom[dom] = b

    for a, b in new_addr.items():
        lines = _insert_row(lines, "| E-Mail-Adresse | Bereich | Quelle | Stand |",
                             f"| {a} | {b} | walter | {today} |")
        log.append(f"kartei: +Adresse {a} → {b} (Walter)")
    for d, b in new_dom.items():
        lines = _insert_row(lines, "| Domain | Bereich | Quelle | Stand |",
                            f"| {d} | {b} | postfach | {today} |")
        log.append(f"kartei: +Domain {d} → {b} (Postfach)")

    if new_addr or new_dom:
        tmp = KARTEI.with_suffix(".tmp")
        tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
        tmp.replace(KARTEI)
    return log


def _bereich_from_body(path: Path) -> str | None:
    """Erste Nennung von AI/FILM/SORBART/PRIVAT im Mail-Body (nach Frontmatter)."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    # Body = alles nach dem zweiten '---'
    parts = text.split("---", 2)
    body = parts[2] if len(parts) >= 3 else text
    for tok in re.findall(r"[A-Za-zÄÖÜäöü]+", body):
        up = tok.upper()
        if up in VALID:
            return up
    return None


if __name__ == "__main__":
    for line in sync():
        print(line)
