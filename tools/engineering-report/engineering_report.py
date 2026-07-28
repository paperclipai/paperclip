#!/usr/bin/env python3
"""Täglicher Engineering-Report für Walter.

Architektur (bewusst hybrid):
  1. FAKTEN deterministisch holen  — Board-Token → Paperclip-API, sieht ALLE
     Engineering-Agenten (nicht self-scoped wie ein lokaler Agent). Kein
     Halluzinieren, keine fehlenden Agenten.
  2. FORMULIERUNG durch lokales LLM — gemma (LM Studio :1234) giesst die
     Fakten in angenehm lesbares Deutsch. Das LLM erfindet NICHTS, es
     formuliert nur die uebergebenen Fakten um.
  3. VERSAND via Mailhub-Webhook (wie walter-deliverable-watcher).

Fallback: Ist das LLM weg/leer, wird die deterministische Rohfassung gemailt
(nie ein leerer oder falscher Report).

Aufruf:
  engineering_report.py            # 24h-Fenster, sendet
  engineering_report.py --dry-run  # nur ausgeben, nicht senden
  engineering_report.py --window-hours 168   # Wochen-Report
  engineering_report.py --no-llm   # LLM ueberspringen (Rohfassung)
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.request
import urllib.error
from datetime import datetime, timedelta, timezone

# --- Konfiguration ------------------------------------------------------------
API_BASE = "http://localhost:3100"
COMPANY_ID = "9cebf3cf-efe8-4597-a400-f06488900a87"  # WHITESTAG
AUTH_PATH = os.path.expanduser("~/.paperclip/auth.json")

LMSTUDIO_URL = "http://localhost:1234/v1/chat/completions"
LMSTUDIO_MODEL = "gemma-4-31b-it-mlx"

MAILHUB_URL = "http://127.0.0.1:5678/webhook/mailhub/send"
MAILHUB_SECRET = "mailhub-812a27b07c73e64d7df192c98a3883eb"
FROM_ADDR = "cto@whitestag.ai"
TO_ADDR = "ws@whitestag.ai"

# Engineering-Team
AGENTS = [
    ("VP Engineering", "5563514c-4254-48d5-9339-802172304119"),
    ("Produktentwicklung", "6d595481-8cbb-49bf-8ffb-8685c071d557"),
    ("n8n-Betriebsingenieur", "dfa8d0e2-d48a-4342-82c2-f7cf6de9d562"),
    ("CTO", "5b7cb8a7-945f-4861-b3a7-4ae84d242d1e"),
]

# WHITESTAG.ACADEMY — nächtlicher Workshop läuft NICHT über die Engineering-
# Agenten, sondern über CEO (orchestriert) → Online-Rechercheur (schreibt) →
# Lektorat (prüft). Eigene Sektion, sonst fehlt die ACADEMY-Nachtarbeit.
ACADEMY_AGENTS = [
    ("CEO", "506c873e-3a40-4483-9a45-0eb0fa1554bb"),
    ("Online-Rechercheur", "d80fe6b9-b2ac-4d58-8525-8bbbb1d0caf7"),
    ("Lektorat", "3deca5b4-af4b-43a3-93f4-2cc4fc1bd08d"),
]
ACADEMY_KEYWORDS = ("academy", "kurs", "lektorat", "workshop")

# Titel, die aus dem Haupt-Report rausfallen (Selbstbezug / eigener Report-Pfad)
SKIP_TITLE_SUBSTR = ("Täglicher Engineering-Report",)
# Bug-Sweep wird nur als Fussnote erwähnt, nicht als "Erledigt" gedoppelt
BUGSWEEP_SUBSTR = ("Bug-Sweep", "Bug-Fixing")

STATUS_LABELS = {
    "done": "Erledigt",
    "in_progress": "In Arbeit",
    "blocked": "Blockiert",
    "todo": "Wartend/Neu",
    "in_review": "In Review",
}
STATUS_ORDER = ["done", "in_progress", "blocked", "in_review", "todo"]


def log(level: str, msg: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"{ts} [{level}] {msg}", file=sys.stderr)


# --- Auth ---------------------------------------------------------------------
def load_token() -> str:
    with open(AUTH_PATH, encoding="utf-8") as f:
        auth = json.load(f)
    creds = auth.get("credentials", {})
    for base in (API_BASE, API_BASE.rstrip("/")):
        if base in creds and creds[base].get("token"):
            return creds[base]["token"]
    # Fallback: erste Credential mit Token
    for v in creds.values():
        if isinstance(v, dict) and v.get("token"):
            return v["token"]
    raise RuntimeError("Kein Board-Token in auth.json gefunden")


def api_get(path: str, token: str) -> object:
    req = urllib.request.Request(
        f"{API_BASE}{path}", headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def last_comment(token: str, issue_id: str) -> str:
    try:
        d = api_get(f"/api/issues/{issue_id}/comments", token)
        cs = d if isinstance(d, list) else d.get("comments", [])
        return (cs[-1].get("body") or "") if cs else ""
    except Exception:  # noqa: BLE001
        return ""


def extract_verdict(text: str) -> str:
    for v in ("GRÜN", "GELB", "ROT"):
        if v in (text or ""):
            return v
    return ""


def first_meaningful_line(text: str) -> str:
    for ln in (text or "").splitlines():
        s = ln.strip().lstrip("#*-> ").strip()
        if len(s) > 12 and "urteil" not in s.lower() and "geprüft" not in s.lower():
            return s[:160]
    return ""


def clean_snippet(text: str, limit: int = 380) -> str:
    """Whitespace-normalisierter Auszug (für LLM-Kontext, kein Markup-Ballast)."""
    s = " ".join((text or "").split())
    return s[:limit]


def issue_context(token: str, issue: dict) -> str:
    """Letzter Kommentar (Ergebnis/Blocker-Grund) als Kontext, sonst Beschreibung."""
    body = last_comment(token, issue.get("id"))
    if len(body.strip()) < 20:
        body = issue.get("description") or ""
    return clean_snippet(body)


# --- Fakten sammeln -----------------------------------------------------------
def fetch_recent(token: str, agent_id: str, cutoff_iso: str) -> list[dict]:
    d = api_get(
        f"/api/companies/{COMPANY_ID}/issues?assigneeAgentId={agent_id}", token)
    issues = d if isinstance(d, list) else d.get("issues", [])
    recent = [i for i in issues if (i.get("updatedAt") or "") >= cutoff_iso]
    recent.sort(key=lambda i: i.get("updatedAt") or "", reverse=True)
    return recent


def gather(token: str, window_hours: int) -> dict:
    cutoff = (datetime.now(timezone.utc)
              - timedelta(hours=window_hours)).isoformat()
    by_status: dict[str, list[dict]] = {s: [] for s in STATUS_ORDER}
    bugsweep_note = None
    for name, aid in AGENTS:
        for i in fetch_recent(token, aid, cutoff):
            title = i.get("title") or ""
            if any(s in title for s in SKIP_TITLE_SUBSTR):
                continue
            if name == "CTO" and any(s in title for s in BUGSWEEP_SUBSTR):
                # Nur als Fussnote, nicht doppeln
                bugsweep_note = {
                    "identifier": i.get("identifier"),
                    "status": i.get("status"),
                }
                continue
            entry = {
                "identifier": i.get("identifier"),
                "title": title,
                "agent": name,
                "status": i.get("status"),
                "updatedAt": (i.get("updatedAt") or "")[:16],
                "blockedBy": [b.get("identifier")
                              for b in (i.get("blockedBy") or [])],
                "context": issue_context(token, i),
            }
            by_status.setdefault(i.get("status"), []).append(entry)
    academy = gather_academy(token, cutoff)
    return {"by_status": by_status, "bugsweep": bugsweep_note,
            "academy": academy, "window_hours": window_hours}


def gather_academy(token: str, cutoff_iso: str) -> list[dict]:
    """Nächtliche WHITESTAG.ACADEMY-Workshop-Kette (CEO/Rechercheur/Lektorat)."""
    academy: list[dict] = []
    seen: set[str] = set()
    for name, aid in ACADEMY_AGENTS:
        for i in fetch_recent(token, aid, cutoff_iso):
            ident = i.get("identifier")
            title = i.get("title") or ""
            if ident in seen:
                continue
            if not any(k in title.lower() for k in ACADEMY_KEYWORDS):
                continue
            seen.add(ident)
            body = last_comment(token, i.get("id"))
            academy.append({
                "identifier": ident, "title": title, "agent": name,
                "status": i.get("status"),
                "verdict": extract_verdict(body),
                "note": first_meaningful_line(body),
                "context": clean_snippet(body),
            })
    academy.sort(key=lambda e: e["identifier"] or "")
    return academy


def total_items(facts: dict) -> int:
    return (sum(len(v) for v in facts["by_status"].values())
            + len(facts.get("academy") or []))


# --- Deterministische Rohfassung (Fakten-Text + Fallback-Mail) ---------------
def facts_markdown(facts: dict) -> str:
    lines: list[str] = []
    for status in STATUS_ORDER:
        items = facts["by_status"].get(status) or []
        if not items:
            continue
        lines.append(f"## {STATUS_LABELS.get(status, status)}")
        for it in items:
            extra = ""
            if it["status"] == "blocked":
                bb = it["blockedBy"]
                extra = (f" — Blocker: {', '.join(bb)}" if bb
                         else " — kein First-Class-Blocker gesetzt")
            lines.append(
                f"- {it['identifier']} ({it['agent']}): {it['title']}{extra}")
            if it.get("context"):
                lines.append(f"    Kontext: {it['context']}")
        lines.append("")
    academy = facts.get("academy") or []
    if academy:
        lines.append("## WHITESTAG.ACADEMY (nächtlicher Workshop)")
        for e in academy:
            v = f" — Lektorat-Urteil: {e['verdict']}" if e["verdict"] else ""
            lines.append(
                f"- {e['identifier']} ({e['agent']}): {e['title']} "
                f"[{e['status']}]{v}")
            if e.get("context"):
                lines.append(f"    Kontext: {e['context']}")
        lines.append("")
    if facts["bugsweep"]:
        bs = facts["bugsweep"]
        lines.append(f"Nebenbei: nächtlicher Bug-Sweep {bs['identifier']} "
                     f"lief (Status {bs['status']}).")
    if not lines:
        lines.append("Keine Engineering-Aktivität im Zeitfenster.")
    return "\n".join(lines).strip()


# --- LLM-Formulierung ---------------------------------------------------------
def llm_narrate(facts_md: str, window_hours: int, *,
                url: str = LMSTUDIO_URL, model: str = LMSTUDIO_MODEL,
                timeout: int = 120) -> str:
    zeitraum = ("letzten 24 Stunden" if window_hours <= 24
                else f"letzten {window_hours // 24} Tagen")
    prompt = (
        "Du schreibst einen gut lesbaren Engineering-Report für den "
        "Geschäftsführer Walter. Ton: sachlich-freundlich, natürliches Deutsch, "
        "KEIN Techniker-Kauderwelsch. Erkläre für einen Leser, der nicht jeden "
        "Tag im Code steckt, verständlich, woran das Team in den " + zeitraum + " "
        "gearbeitet hat.\n\n"
        "STRIKTE REGELN:\n"
        "- Verwende AUSSCHLIESSLICH die unten gelisteten Fakten (inkl. der "
        "'Kontext:'-Zeilen). Erfinde nichts dazu — keine erfundenen Tickets, "
        "Zahlen oder Ergebnisse. Wenn der Kontext etwas nicht hergibt, spekuliere "
        "nicht.\n"
        "- Nutze die 'Kontext:'-Zeilen, um pro Vorgang in 2-4 Sätzen zu erklären: "
        "WAS wurde gemacht bzw. WORUM geht es, und — falls es ein Problem/Blocker "
        "gibt — WAS ist die Ursache und WAS ist der nächste Schritt / wer muss "
        "handeln. Lieber verständlich ausformuliert als stichwortartig.\n"
        "- Nenne jede Ticket-Nummer (z.B. WHI-3253) genau so, wie sie dasteht, "
        "in **fett**.\n"
        "- Strukturiere mit Markdown-Überschriften '## ' pro Themenblock "
        "(z.B. '## Erledigt', '## Blockiert', '## WHITESTAG.ACADEMY'). Beginne "
        "mit einem kurzen Absatz zur Gesamtlage OHNE Überschrift.\n"
        "- Blockierte Vorgänge klar als 'braucht Aufmerksamkeit' kennzeichnen und "
        "erklären, warum sie hängen.\n"
        "- Gibt es einen ACADEMY-Abschnitt: eigener Block — welcher Kurs entstand, "
        "worum es inhaltlich geht, und wie das Lektorat-Urteil (GRÜN/GELB/ROT) "
        "ausfiel (bei GELB/ROT die Mängel kurz benennen).\n"
        "- Schließe mit '## Wichtigste offene Punkte' und 1-3 Bullets, falls es "
        "welche gibt.\n"
        "- Zielumfang ca. 250-350 Wörter. Keine erfundene Grußformel-Signatur.\n\n"
        "=== FAKTEN ===\n" + facts_md
    )
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.4,
        "max_tokens": 1100,
    }
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    content = (data["choices"][0]["message"]["content"] or "").strip()
    if len(content) < 20:
        raise ValueError("LLM lieferte zu wenig Text")
    return content


# --- HTML ---------------------------------------------------------------------
WEEKDAYS_DE = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag",
               "Samstag", "Sonntag"]
MONTHS_DE = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli",
             "August", "September", "Oktober", "November", "Dezember"]


def german_date(dt: datetime) -> str:
    return f"{WEEKDAYS_DE[dt.weekday()]}, {dt.day}. {MONTHS_DE[dt.month - 1]} {dt.year}"


def _esc(s: str) -> str:
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def _inline(s: str) -> str:
    """Escapen + **fett** und `code` zu HTML."""
    s = _esc(s)
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"`([^`]+)`",
               r"<code style='background:#eef2f4;padding:1px 5px;"
               r"border-radius:4px;font-size:13px'>\1</code>", s)
    return s


def _heading_accent(text: str) -> tuple[str, str]:
    """Farbe + Border-Farbe je nach Abschnitt."""
    t = text.lower()
    if "blockiert" in t or "aufmerksamkeit" in t or "problem" in t:
        return "#b45309", "#f1d9b5"          # Amber
    if "academy" in t:
        return "#0b6b8a", "#c3e0ea"          # ACADEMY-Blau
    if "offene punkte" in t:
        return "#8a2f2f", "#eccccc"          # dezentes Rot
    if "erledigt" in t or "abgeschlossen" in t:
        return "#1f7a4d", "#c7e6d5"          # Grün
    return "#012a3e", "#e3e8ec"              # WHITESTAG-Standard


def _render_body(prose: str) -> str:
    out: list[str] = []
    list_type: str | None = None  # 'ul' | 'ol'

    def close_list() -> None:
        nonlocal list_type
        if list_type:
            out.append(f"</{list_type}>")
            list_type = None

    for raw in prose.split("\n"):
        b = raw.strip()
        if not b:
            close_list()
            continue
        if b.startswith("## "):
            close_list()
            txt = b[3:].strip()
            col, bcol = _heading_accent(txt)
            out.append(
                f"<div style=\"margin:22px 0 10px;padding-bottom:6px;"
                f"border-bottom:2px solid {bcol};color:{col};font-size:15px;"
                f"font-weight:700;letter-spacing:.2px\">{_inline(txt)}</div>")
            continue
        if b.startswith("### "):
            close_list()
            out.append(
                f"<div style='margin:14px 0 6px;color:#33434f;font-size:14px;"
                f"font-weight:600'>{_inline(b[4:].strip())}</div>")
            continue
        if b.startswith(("- ", "* ", "• ")):
            if list_type != "ul":
                close_list()
                out.append("<ul style='margin:0 0 14px;padding-left:22px'>")
                list_type = "ul"
            out.append(f"<li style='margin:0 0 6px'>{_inline(b[2:].strip())}</li>")
            continue
        m = re.match(r"^(\d+)[.)]\s+(.*)$", b)
        if m:
            if list_type != "ol":
                close_list()
                out.append("<ol style='margin:0 0 14px;padding-left:22px'>")
                list_type = "ol"
            out.append(f"<li style='margin:0 0 6px'>{_inline(m.group(2))}</li>")
            continue
        close_list()
        out.append(f"<p style='margin:0 0 12px'>{_inline(b)}</p>")
    close_list()
    return "".join(out)


def render_html(prose: str, title: str, date_label: str) -> str:
    body = _render_body(prose)
    return (
        "<div style=\"margin:0;padding:24px 12px;background:#eef1f4;"
        "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,"
        "Helvetica,Arial,sans-serif\">"
        "<div style=\"max-width:640px;margin:0 auto;background:#ffffff;"
        "border-radius:12px;overflow:hidden;"
        "box-shadow:0 1px 4px rgba(1,42,62,.10)\">"
        # Header
        "<div style=\"background:#012a3e;padding:22px 30px\">"
        f"<div style=\"color:#ffffff;font-size:19px;font-weight:700\">{_esc(title)}</div>"
        f"<div style=\"color:#9fc4d6;font-size:13px;margin-top:3px\">{_esc(date_label)} · WHITESTAG</div>"
        "</div>"
        # Body
        "<div style=\"padding:26px 30px;color:#26333d;font-size:15px;"
        f"line-height:1.65\">{body}</div>"
        # Footer
        "<div style=\"padding:14px 30px;background:#f6f8f9;"
        "border-top:1px solid #e6ebee;color:#8a97a1;font-size:12px;"
        "line-height:1.5\">Automatischer Engineering-Report · Fakten aus "
        "Paperclip (Board-API), sprachlich aufbereitet vom lokalen Modell. "
        "Maßgeblich sind die genannten Ticket-Nummern.</div>"
        "</div></div>")


# --- Versand ------------------------------------------------------------------
def send_mail(subject: str, text_body: str, html_body: str) -> int:
    payload = {"from": FROM_ADDR, "to": TO_ADDR, "subject": subject,
               "text": text_body, "html": html_body, "attachments": []}
    req = urllib.request.Request(
        MAILHUB_URL, data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json",
                 "X-Mailhub-Secret": MAILHUB_SECRET}, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        log("INFO", f"mailhub {r.status}: {r.read()[:200].decode('utf-8','replace')}")
        return r.status


# --- Main ---------------------------------------------------------------------
def build_report(token: str, window_hours: int, use_llm: bool) -> tuple[str, str]:
    facts = gather(token, window_hours)
    facts_md = facts_markdown(facts)
    n = total_items(facts)
    log("INFO", f"{n} Engineering-Vorgang/-Vorgänge im {window_hours}h-Fenster")

    if use_llm and n > 0:
        try:
            prose = llm_narrate(facts_md, window_hours)
            log("INFO", "LLM-Formulierung ok")
        except Exception as e:  # noqa: BLE001
            log("WARN", f"LLM-Fallback (Rohfassung): {e}")
            prose = facts_md
    else:
        prose = facts_md
    return facts_md, prose


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-llm", action="store_true")
    ap.add_argument("--window-hours", type=int, default=24)
    args = ap.parse_args()

    now_local = datetime.now()
    date_str = now_local.strftime("%Y-%m-%d")
    subject = f"Engineering-Report {date_str}"

    token = load_token()
    facts_md, prose = build_report(token, args.window_hours, not args.no_llm)
    html = render_html(prose, "Engineering-Report", german_date(now_local))

    if args.dry_run:
        print("=" * 60)
        print("SUBJECT:", subject)
        print("=" * 60)
        print("--- FAKTEN (roh) ---")
        print(facts_md)
        print("\n--- REPORT (an Walter) ---")
        print(prose)
        return 0

    status = send_mail(subject, prose, html)
    return 0 if status == 200 else 1


if __name__ == "__main__":
    sys.exit(main())
