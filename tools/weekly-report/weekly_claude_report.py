#!/usr/bin/env python3
"""Wöchentlicher Claude-Code-Arbeitsbericht.

Liest die Tagesprotokolle (Abschnitt ``## Claude Code``) und die zugehörigen
Chatverläufe aus dem WHITESTAG-Vault, baut einen nach Wochentagen sortierten
Bericht und versendet ihn via ``send-walter-report.sh`` an ws@whitestag.ai.

Pro Protokoll-Punkt:
  Headline = ``HH:MM — Stichwort``  (Uhrzeit = mtime des Chatverlaufs)
  Subline  = dreizeilige Zusammenfassung des Chatverlaufs (LM Studio, lokal)

Reine Logik steckt in testbaren Funktionen; ``main()`` verdrahtet I/O.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from zoneinfo import ZoneInfo

# --------------------------------------------------------------------------- #
# Konfiguration
# --------------------------------------------------------------------------- #
HOME = Path.home()
VAULT = HOME / "Obsidian" / "WHITESTAG-Vault"
PROTO_DIR = VAULT / "Tagesprotokolle"
CHAT_DIR = VAULT / "Claude Code"

SEND_SCRIPT = (
    HOME / ".paperclip" / "instances" / "default" / "companies"
    / "9cebf3cf-efe8-4597-a400-f06488900a87" / "agents"
    / "e24b8d9d-143e-4141-b413-4361aa618771" / "bin" / "send-walter-report.sh"
)

TZ = ZoneInfo("Europe/Berlin")

LMSTUDIO_URL = "http://localhost:1234/v1/chat/completions"
# Dieses Modell lag auf dem MacBook, das am 04.09.2026 aus der Farm genommen
# wurde — zwischenzeitlich war es gar nicht aufloesbar, der Wochenbericht waere
# also ohne Zusammenfassungen geblieben. Die Modelle sind auf die Studio
# geholt worden: gemma-4-31b-it-mlx liegt jetzt LOKAL und bleibt deshalb
# stehen.
# Bewusst NICHT auf die RTX-Variante "gemma4-31b-it" gewechselt: die haengt
# hinter LM Link (flattert seit 03.09.) und traegt die Agentenflotte — am
# 04.09. lief jeder Aufruf dorthin in einen Timeout, waehrend das lokale
# Modell sofort antwortete.
LMSTUDIO_MODEL = "gemma-4-31b-it-mlx"
LMSTUDIO_MAX_BODY = 6000  # Zeichen des Chatverlauf-Bodys, die an den LLM gehen

WEEKDAYS_DE = [
    "Montag", "Dienstag", "Mittwoch", "Donnerstag",
    "Freitag", "Samstag", "Sonntag",
]

# Stoppwörter fürs Matching (Deutsch + generische Projekt-/Chatbegriffe)
_STOPWORDS = {
    "und", "oder", "der", "die", "das", "den", "dem", "des", "ein", "eine",
    "einen", "einem", "einer", "im", "in", "am", "an", "auf", "für", "fuer",
    "mit", "von", "vom", "zu", "zum", "zur", "auch", "neue", "neuer", "neues",
    "via", "per", "bei", "ist", "war", "wird", "werden", "wurde", "nach",
    "fix", "bug", "chatverlauf", "claude", "code", "session", "notiz",
    "abgeschlossen", "global", "live", "plan", "test", "tests",
}
_TOKEN_RE = re.compile(r"[a-z0-9äöüß][a-z0-9äöüß\-]+", re.IGNORECASE)

# Punkt-Regex: laufende Nummern werden ignoriert (im Vault teils doppelt/lückig).
_POINT_RE = re.compile(
    r"^\s*\d+\.\s+\*\*(?P<head>.+?)\*\*\s*(?:[—\-–:]\s*(?P<detail>.*))?$"
)


# --------------------------------------------------------------------------- #
# Datentypen
# --------------------------------------------------------------------------- #
@dataclass
class Point:
    head: str
    detail: str = ""


@dataclass
class ChatDoc:
    path: Path
    title: str
    tags: list[str] = field(default_factory=list)
    zusammenfassung: str = ""
    body: str = ""


@dataclass
class ReportItem:
    time: str          # "HH:MM" oder ""
    head: str
    summary_lines: list[str]


# --------------------------------------------------------------------------- #
# Parsing
# --------------------------------------------------------------------------- #
def extract_claude_section(md_text: str) -> str:
    """Liefert den Text des ``## Claude Code``-Abschnitts (ohne Überschrift)."""
    lines = md_text.splitlines()
    out: list[str] = []
    in_section = False
    for line in lines:
        if re.match(r"^##\s+", line):
            if in_section:
                break  # nächster H2 → Abschnitt zu Ende
            if re.match(r"^##\s+Claude Code\s*$", line.strip()):
                in_section = True
            continue
        if in_section:
            out.append(line)
    return "\n".join(out).strip("\n")


def parse_points(section_text: str) -> list[Point]:
    """Parst nummerierte ``1. **Stichwort** — Detail``-Punkte."""
    points: list[Point] = []
    for line in section_text.splitlines():
        m = _POINT_RE.match(line)
        if not m:
            continue
        head = m.group("head").strip()
        detail = (m.group("detail") or "").strip()
        if head:
            points.append(Point(head=head, detail=detail))
    return points


def split_frontmatter(text: str) -> tuple[dict, str]:
    """Trennt YAML-Frontmatter (simpel) vom Body. Gibt (meta, body)."""
    if not text.startswith("---"):
        return {}, text
    parts = text.split("\n", 1)
    rest = parts[1] if len(parts) > 1 else ""
    end = rest.find("\n---")
    if end == -1:
        return {}, text
    fm = rest[:end]
    body = rest[end + 4:].lstrip("\n")
    meta: dict = {}
    for raw in fm.splitlines():
        if ":" not in raw or raw.startswith(" "):
            continue
        key, _, val = raw.partition(":")
        meta[key.strip()] = val.strip()
    return meta, body


def _parse_tags(raw: str) -> list[str]:
    raw = (raw or "").strip().strip("[]")
    return [t.strip().strip("'\"") for t in raw.split(",") if t.strip()]


def load_chatdoc(path: Path) -> ChatDoc:
    text = path.read_text(encoding="utf-8", errors="replace")
    meta, body = split_frontmatter(text)
    return ChatDoc(
        path=path,
        title=meta.get("title", path.stem),
        tags=_parse_tags(meta.get("tags", "")),
        zusammenfassung=meta.get("zusammenfassung", ""),
        body=body,
    )


# --------------------------------------------------------------------------- #
# Matching
# --------------------------------------------------------------------------- #
def _tokens(text: str) -> set[str]:
    return {
        t.lower() for t in _TOKEN_RE.findall(text or "")
        if t.lower() not in _STOPWORDS and len(t) > 2
    }


def match_score(point: Point, doc: ChatDoc) -> float:
    """Token-Overlap-Score zwischen Punkt und Chatverlauf (0..1)."""
    p_tokens = _tokens(point.head + " " + point.detail)
    d_tokens = _tokens(
        doc.title + " " + " ".join(doc.tags) + " " + doc.zusammenfassung
    )
    if not p_tokens or not d_tokens:
        return 0.0
    overlap = p_tokens & d_tokens
    # Normalisiert auf die kleinere Tokenmenge (Punkt-Headlines sind kurz).
    return len(overlap) / min(len(p_tokens), len(d_tokens))


def best_match(
    point: Point, docs: list[ChatDoc], threshold: float = 0.18
) -> ChatDoc | None:
    best: ChatDoc | None = None
    best_score = threshold
    for doc in docs:
        s = match_score(point, doc)
        if s >= best_score:
            best_score = s
            best = doc
    return best


def chatdocs_for_date(date: dt.date, chat_dir: Path = CHAT_DIR) -> list[ChatDoc]:
    """Alle Chatverläufe eines Datums über alle Projektordner."""
    prefix = date.strftime("%Y-%m-%d")
    docs: list[ChatDoc] = []
    if not chat_dir.exists():
        return docs
    for path in chat_dir.glob(f"**/{prefix} Chatverlauf *.md"):
        try:
            docs.append(load_chatdoc(path))
        except OSError:
            continue
    return docs


def time_from_mtime(path: Path, tz: ZoneInfo = TZ) -> str:
    ts = path.stat().st_mtime
    return dt.datetime.fromtimestamp(ts, tz).strftime("%H:%M")


# --------------------------------------------------------------------------- #
# Zusammenfassung
# --------------------------------------------------------------------------- #
def _three_lines(text: str) -> list[str]:
    """Normalisiert beliebigen Text auf bis zu 3 nicht-leere Zeilen."""
    # Nur echte Listen-/Bullet-Marker entfernen — NICHT führende Zahlen wie "16-seitiger".
    lines = [re.sub(r"^\s*(?:[-*•]\s+|\d+[.)]\s+)", "", l).strip()
             for l in (text or "").splitlines()]
    lines = [l for l in lines if l]
    if len(lines) <= 1 and text:
        # Ein Fließtext → an Satzgrenzen in bis zu 3 Stücke teilen.
        sentences = re.split(r"(?<=[.!?;])\s+", text.strip())
        lines = [s.strip() for s in sentences if s.strip()]
    return lines[:3]


def llm_summarize(body: str, *, url: str = LMSTUDIO_URL,
                  model: str = LMSTUDIO_MODEL, timeout: int = 120) -> list[str]:
    """Ruft LM Studio (OpenAI-kompatibel) für eine 3-Zeilen-Zusammenfassung."""
    snippet = (body or "")[:LMSTUDIO_MAX_BODY]
    prompt = (
        "Fasse die folgende Arbeits-Session in GENAU DREI kurzen deutschen "
        "Zeilen zusammen (je eine prägnante Aussage pro Zeile, keine "
        "Aufzählungszeichen, keine Einleitung). Beschreibe konkret, WAS "
        "gemacht wurde.\n\n=== SESSION ===\n" + snippet
    )
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.3,
        "max_tokens": 220,
    }
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    content = data["choices"][0]["message"]["content"]
    lines = _three_lines(content)
    if not lines:
        raise ValueError("LLM lieferte keine verwertbaren Zeilen")
    return lines


def summarize_item(doc: ChatDoc | None, point: Point,
                   summarizer=llm_summarize,
                   cache: dict[str, list[str]] | None = None) -> list[str]:
    """3-Zeilen-Subline mit Fallback-Kette: LLM → Frontmatter → Detailtext.

    Mehrere Protokoll-Punkte zeigen oft auf denselben Chatverlauf; das
    optionale ``cache`` (key = Chatverlauf-Pfad) berechnet die LLM-Zusammenfassung
    pro Datei nur einmal und hält die Sublines konsistent.
    """
    if doc is not None and doc.body.strip():
        key = str(doc.path)
        if cache is not None and key in cache:
            return cache[key]
        try:
            lines = summarizer(doc.body)
            if cache is not None:
                cache[key] = lines
            return lines
        except Exception:
            pass
    if doc is not None and doc.zusammenfassung.strip():
        return _three_lines(doc.zusammenfassung)
    if point.detail.strip():
        return _three_lines(point.detail)
    return ["(keine Zusammenfassung verfügbar)"]


# --------------------------------------------------------------------------- #
# Bericht zusammenbauen
# --------------------------------------------------------------------------- #
def build_day_items(date: dt.date, vault: Path = VAULT,
                    summarizer=llm_summarize,
                    cache: dict[str, list[str]] | None = None) -> list[ReportItem]:
    proto = (vault / "Tagesprotokolle" / f"{date.strftime('%Y-%m-%d')}.md")
    if not proto.exists():
        return []
    section = extract_claude_section(
        proto.read_text(encoding="utf-8", errors="replace"))
    points = parse_points(section)
    if not points:
        return []
    docs = chatdocs_for_date(date, vault / "Claude Code")
    items: list[ReportItem] = []
    for point in points:
        doc = best_match(point, docs)
        time = time_from_mtime(doc.path) if doc else ""
        summary = summarize_item(doc, point, summarizer=summarizer, cache=cache)
        items.append(ReportItem(time=time, head=point.head,
                                summary_lines=summary))
    # Chronologisch je Tag; Punkte ohne Uhrzeit ans Ende.
    items.sort(key=lambda it: it.time or "99:99")
    return items


def iso_week_label(start: dt.date, end: dt.date) -> str:
    kw = start.isocalendar().week
    return (f"KW{kw:02d} ({start.strftime('%d.%m.')}–"
            f"{end.strftime('%d.%m.%Y')})")


def render_markdown(start: dt.date, end: dt.date,
                    items_by_date: dict[dt.date, list[ReportItem]]) -> str:
    out: list[str] = [f"**Zeitraum:** {iso_week_label(start, end)}", ""]
    day = start
    while day <= end:
        weekday = WEEKDAYS_DE[day.weekday()]
        out.append(f"## {weekday} · {day.strftime('%d.%m.%Y')}")
        items = items_by_date.get(day, [])
        if not items:
            out.append("_Keine protokollierten Arbeiten._")
        else:
            for it in items:
                head = f"**{it.time} — {it.head}**" if it.time else f"**{it.head}**"
                out.append(head)
                out.extend(it.summary_lines)
                out.append("")
        out.append("")
        day += dt.timedelta(days=1)
    return "\n".join(out).rstrip() + "\n"


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #
def _default_end() -> dt.date:
    return dt.datetime.now(TZ).date() - dt.timedelta(days=1)


def generate_report(end: dt.date, vault: Path = VAULT,
                    summarizer=llm_summarize) -> tuple[str, dt.date, dt.date]:
    start = end - dt.timedelta(days=6)
    items_by_date: dict[dt.date, list[ReportItem]] = {}
    cache: dict[str, list[str]] = {}
    day = start
    while day <= end:
        items_by_date[day] = build_day_items(
            day, vault, summarizer=summarizer, cache=cache)
        day += dt.timedelta(days=1)
    return render_markdown(start, end, items_by_date), start, end


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--end", help="Letzter Tag (YYYY-MM-DD), Default: gestern")
    ap.add_argument("--out", help="Markdown-Ausgabedatei")
    ap.add_argument("--send", action="store_true",
                    help="Bericht via send-walter-report.sh versenden")
    ap.add_argument("--dry-run", action="store_true",
                    help="Nichts versenden, Markdown auf stdout/--out")
    args = ap.parse_args(argv)

    end = (dt.date.fromisoformat(args.end) if args.end else _default_end())
    markdown, start, end = generate_report(end)

    if args.out:
        Path(args.out).write_text(markdown, encoding="utf-8")
        print(f"Markdown → {args.out}", file=sys.stderr)
    if args.dry_run or not args.send:
        if not args.out:
            print(markdown)
        return 0

    # Versand
    subject = f"Wochenbericht Claude Code · {iso_week_label(start, end)}"
    out_file = args.out or "/tmp/weekly_claude_report.md"
    Path(out_file).write_text(markdown, encoding="utf-8")
    if not SEND_SCRIPT.exists():
        print(f"Versand-Skript fehlt: {SEND_SCRIPT}", file=sys.stderr)
        return 2
    res = subprocess.run([str(SEND_SCRIPT), subject, out_file],
                         capture_output=True, text=True)
    sys.stderr.write(res.stdout + res.stderr)
    return res.returncode


if __name__ == "__main__":
    raise SystemExit(main())
