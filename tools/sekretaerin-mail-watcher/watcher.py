#!/usr/bin/env python3
"""Weckt die Sekretärin, sobald neue ws@-Mails im Vault liegen.

Ersetzt den starren 07:00-Cron: statt einmal täglich blind zu laufen, prüft
dieser Watcher alle 10 Minuten den Vault-Ordner und legt **nur dann** ein
Triage-Issue an, wenn tatsächlich neue Mail-Dateien aufgetaucht sind.

Zustand: ~/.paperclip/state/sekretaerin-mail-watcher.json (Set gesehener Dateien).
Dadurch ist der Watcher automatisch sein eigener Backstop — war er offline,
holt der nächste Lauf alles Ungesehene nach.

Aufruf:  python3 watcher.py [--dry-run] [--window-days N]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import paperclip_client as pc  # noqa: E402
import approval_queue as approval_queue  # noqa: E402
import approval_parse as approval_parse  # noqa: E402
import approval_send as approval_send  # noqa: E402
import ews_sent as ews_sent  # noqa: E402

WALTER_SENDERS = ("w.schonenbrocher", "walter", "ws@whitestag.ai")

BASE = "http://localhost:3100"
COMPANY = "9cebf3cf-efe8-4597-a400-f06488900a87"
AGENT = "e24b8d9d-143e-4141-b413-4361aa618771"
MAILDIR = Path.home() / "Obsidian" / "WHITESTAG-Vault" / "E-Mails"
STATE = Path.home() / ".paperclip" / "state" / "sekretaerin-mail-watcher.json"

# Ausserhalb dieser Stunden nicht wecken (lokales LM Studio schlaeft nachts).
ACTIVE_FROM, ACTIVE_TO = 6, 20

# Obergrenze pro Issue, damit ein Sync-Nachlauf keine Riesen-Triage ausloest.
MAX_PER_ISSUE = 25


def _triage_in_flight() -> bool:
    """Läuft gerade ein Triage-Issue der Sekretärin (todo/in_progress)?

    in_review und blocked zählen NICHT als aktiv: in_review wartet auf Walter,
    blocked auf Recovery — beide können lange offen bleiben und dürfen neue
    Läufe nicht dauerhaft aussperren.
    """
    try:
        token = pc.load_token()
        url = (f"{BASE}/api/companies/{COMPANY}/issues"
               f"?assigneeAgentId={AGENT}&status=todo,in_progress&limit=50")
        import urllib.request
        req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token})
        import json as _json
        data = _json.load(urllib.request.urlopen(req, timeout=15))
        issues = data if isinstance(data, list) else data.get("issues", data.get("data", []))
        return any(str(i.get("title", "")).startswith("Neue Mails") for i in issues)
    except Exception as e:  # noqa: BLE001 — im Zweifel anlegen, nicht blockieren
        print(f"WARN: In-Flight-Check fehlgeschlagen ({e}) — lege trotzdem an", file=sys.stderr)
        return False


def load_state() -> set[str]:
    if not STATE.exists():
        return set()
    try:
        return set(json.loads(STATE.read_text(encoding="utf-8")).get("seen", []))
    except (json.JSONDecodeError, OSError) as e:
        print(f"WARN: State unlesbar ({e}) — behandle alles als gesehen", file=sys.stderr)
        return set()


def save_state(seen: set[str], window: int) -> None:
    """Nur das relevante Fenster behalten, sonst waechst die Datei ewig."""
    cutoff = str(date.today() - timedelta(days=window * 3))
    keep = sorted(n for n in seen if n[:10] >= cutoff)
    STATE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps({"seen": keep, "updated": datetime.now().isoformat()},
                              ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(STATE)


# Absender, deren Mails NICHT triagiert werden — interne Paperclip-Agenten.
# Zwei Gründe: (1) Lunas eigene office@-Reports synced der Vault zurück →
# Endlosschleife; (2) auf Mails anderer Agenten (C-Suite, Health, Clara) soll
# Luna grundsätzlich NIE antworten — das sind interne Vorgänge, keine Kundenpost.
AGENT_SENDERS = (
    "ceo@whitestag.ai", "cmo@whitestag.ai", "cto@whitestag.ai",
    "cpo@whitestag.ai", "cro@whitestag.ai", "creative@whitestag.ai",
    "dpo@whitestag.ai", "webdesign@whitestag.ai", "health@whitestag.ai",
    "office@whitestag.ai", "paperclip@clara-werden.de",
)


def _is_agent_mail(path: Path) -> bool:
    """True, wenn die Mail von einem Paperclip-Agenten stammt (Frontmatter `von:`)."""
    try:
        with path.open(encoding="utf-8") as fh:
            for _ in range(12):  # Frontmatter steht ganz oben
                line = fh.readline()
                if not line:
                    break
                low = line.lower()
                if low.startswith(("von:", "from:")):
                    return any(s in low for s in AGENT_SENDERS)
    except OSError:
        return False
    return False


def read_body(path: Path) -> str:
    """Reiner Antworttext einer Vault-Mail.

    Entfernt (1) das YAML-Frontmatter und (2) den von „E-Mails v9" gerenderten
    Kopfblock (`# Betreff` + `**Von:**/**An:**/**Datum:**/**Ordner:**` + `---`-Trenner),
    sodass der eigentliche Antworttext ganz oben steht. Roh-Mails ohne Renderblock
    bleiben unverändert (Rückwärtskompatibilität)."""
    text = path.read_text(encoding="utf-8", errors="replace")
    if text.startswith("---"):
        parts = text.split("\n---", 1)
        if len(parts) == 2:
            text = parts[1].lstrip("-\n")
    lines = text.split("\n")
    head = next((l for l in lines if l.strip()), "")
    if head.lstrip().startswith("# "):  # gerenderter Mail-Header → Body ab erstem '---'-Trenner
        for i, l in enumerate(lines):
            if l.strip() == "---":
                return "\n".join(lines[i + 1:]).strip()
    return text.strip()


def is_approval_reply(path: Path) -> str | None:
    """Token, falls die Datei Walters Antwort auf eine Freigabe-Mail ist."""
    try:
        from_ok = False
        subject = ""
        with path.open(encoding="utf-8") as fh:
            for _ in range(12):
                line = fh.readline()
                if not line:
                    break
                low = line.lower()
                if low.startswith(("von:", "from:")):
                    from_ok = any(s in low for s in WALTER_SENDERS)
                elif low.startswith(("subject:", "betreff:")):
                    subject = line.split(":", 1)[1]
        if not from_ok:
            return None
        return approval_parse.extract_token(subject)
    except OSError:
        return None


def process_approvals(new_files, *, dry_run, send=approval_send.send_approved,
                      make_issue=None, save_sent=None):
    """Verarbeitet Freigabe-Antworten. Gibt Liste von {file, token, action} zurück.

    Terminale Aktionen (sent/correction/skip) dürfen vom Aufrufer als gesehen
    markiert werden. **send-error/error bleiben absichtlich ungesehen** → der
    nächste Lauf versucht die noch `pending` Freigabe erneut; ein Doppelversand ist
    ausgeschlossen, weil `mark(..,'sent')` den Status auf non-pending zieht und der
    Status-Guard oben dann `skip` liefert."""
    if make_issue is None:
        make_issue = _create_correction_issue
    results = []
    for name in new_files:
        path = MAILDIR / name
        try:
            token = is_approval_reply(path)
            if not token:
                results.append({"file": name, "token": None, "action": "skip"})
                continue
            entry = approval_queue.load(token)
            if entry is None or entry.get("status") != "pending":
                results.append({"file": name, "token": token, "action": "skip"})
                continue
            action = approval_parse.classify(read_body(path))
            if action == "send":
                if dry_run:
                    results.append({"file": name, "token": token, "action": "would-send"}); continue
                code, resp = send(entry)
                if code == 200:
                    approval_queue.mark(token, "sent", sent=datetime.now().isoformat())
                    print(f"Freigabe #{token}: gesendet an {entry['to']}")
                    # Kopie in ws@ „Gesendete Elemente" (nicht-fatal — Mail ist raus).
                    if save_sent is not None:
                        try:
                            ok, resp2 = save_sent(to=entry["to"], subject=entry["subject"],
                                                  html=entry["rendered_html"])
                            if not ok:
                                print(f"WARN Sent-Kopie #{token} fehlgeschlagen: {resp2[:120]}",
                                      file=sys.stderr)
                        except Exception as ex:  # noqa: BLE001
                            print(f"WARN Sent-Kopie #{token}: {ex}", file=sys.stderr)
                    results.append({"file": name, "token": token, "action": "sent"})
                else:
                    print(f"FEHLER Freigabe #{token}: Relay HTTP {code}: {resp}", file=sys.stderr)
                    results.append({"file": name, "token": token, "action": "send-error"})
            else:
                if dry_run:
                    results.append({"file": name, "token": token, "action": "would-correct"}); continue
                make_issue(token, read_body(path), entry)
                results.append({"file": name, "token": token, "action": "correction"})
        except Exception as e:  # noqa: BLE001 — ein kaputter Eintrag darf den Tick nicht killen
            print(f"WARN Freigabe {name}: {e}", file=sys.stderr)
            results.append({"file": name, "token": None, "action": "error"})
    return results


def _create_correction_issue(token: str, note: str, entry: dict) -> None:
    """Weckt Luna zur Überarbeitung eines Entwurfs nach Walters Korrektur."""
    token_pc = pc.load_token()
    desc = f"""## Korrektur zu Freigabe #{token}

Walter hat den Entwurf an **{entry['to']}** (Betreff „{entry['subject']}") NICHT freigegeben,
sondern folgende Anmerkung geschickt:

> {note.strip().replace(chr(10), chr(10) + '> ')}

## Auftrag

Überarbeite den Entwurf gemäß dieser Anmerkung und lege ihn erneut zur Freigabe vor:

```
bin/luna-queue-approval.py --area {entry['area']} --to {entry['to']} \\
  --subject "{entry['subject']}" --body /tmp/entwurf-neu.md \\
  --original-file "{entry['original_mail_file']}"
```

Der alte Entwurf #{token} ist verbraucht — es entsteht ein neuer Token.
"""
    pc.create_issue(BASE, token_pc, COMPANY,
                    title=f"Korrektur Entwurf #{token} — {entry['subject']}",
                    description=desc, assignee_agent_id=AGENT, priority="high")
    approval_queue.mark(token, "superseded")


def scan(window: int) -> list[str]:
    """Neue Mail-Dateien im Fenster, OHNE die eigenen ausgehenden Mails."""
    if not MAILDIR.is_dir():
        print(f"FEHLER: Vault-Ordner fehlt: {MAILDIR}", file=sys.stderr)
        sys.exit(2)
    cutoff = str(date.today() - timedelta(days=window))
    out = []
    for p in sorted(MAILDIR.glob("*.md")):
        if p.name[:10] < cutoff:
            continue
        if _is_agent_mail(p):
            continue
        if is_approval_reply(p):
            continue
        out.append(p.name)
    return out


def scan_approval_replies(window: int, seen: set[str]) -> list[str]:
    """Neue (ungesehene) Freigabe-Antworten von Walter im Fenster."""
    cutoff = str(date.today() - timedelta(days=window))
    out = []
    for p in sorted(MAILDIR.glob("*.md")):
        if p.name[:10] < cutoff:
            continue
        if p.name in seen:
            continue
        if is_approval_reply(p):
            out.append(p.name)
    return out


def build_description(new: list[str], capped: int) -> str:
    lines = "\n".join(f"- `{n}`" for n in new)
    extra = ""
    if capped:
        extra = (f"\n\n**Hinweis:** {capped} weitere neue Dateien wurden auf das "
                 f"Limit von {MAX_PER_ISSUE} gekürzt und kommen im nächsten Lauf.")
    return f"""## Auftrag

Neue ws@-Mails im Vault. Bearbeite **genau diese {len(new)} Datei(en)** aus
`{MAILDIR}/`:

{lines}{extra}

Kein Datum selbst ermitteln, keinen anderen Zeitraum absuchen — die Liste oben
ist abschliessend.

## Vorgehen (Vier-Augen)

1. **Klassifiziere** jede Mail (spam / fyi / actionable / unklar). Spam→`cancelled`,
   FYI→still archivieren (kein Kommentar-Zwang). **Keine Triage-Übersichtsmail an
   Walter** — die Original-Mails liegen ohnehin in seinem Postfach.
2. **Antwort-Entwurf zur Freigabe** für jede `actionable`/`unklar`-Mail — genau
   ein Skript, das rendert, in die Freigabe-Queue legt und Walter EINE Freigabe-Mail
   schickt:
   `bin/luna-queue-approval.py --area <AI|FILM|SORBART> --to <Absender-Adresse> \\
     --subject "AW: <Original-Betreff>" --body /tmp/entwurf.md --original-file "<Dateiname>"`
   Du sendest **nie** selbst an Externe. Walters „Okay" auf die Freigabe-Mail löst
   den Versand aus (deterministisch, ohne dich). Bei Korrektur weckt dich ein
   „Korrektur Entwurf #…"-Issue → überarbeiten und mit `luna-queue-approval.py` neu vorlegen.
3. **Störung erkannt** (Sync tot, Workflow-Fehler)? Subtask an den CTO, nicht nur kommentieren.
4. **Abschluss:** Issue auf `in_review`, `assigneeUserId` =
   `18r34Ghx5N0LHRptMCT6Fp1WaoGqhvc9`, `assigneeAgentId` = null. **Nicht `done`.**
"""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--window-days", type=int, default=3)
    ap.add_argument("--ignore-hours", action="store_true",
                    help="Aktivfenster ignorieren (fuer Tests)")
    a = ap.parse_args()

    hour = datetime.now().hour
    if not a.ignore_hours and not (ACTIVE_FROM <= hour < ACTIVE_TO):
        print(f"Ausserhalb Aktivfenster ({ACTIVE_FROM}-{ACTIVE_TO}h) — uebersprungen.")
        return

    # Signatur-Kartei deterministisch pflegen (Postfach-Lernen + Walters
    # Bereich-Antworten) — vor der Triage, damit Luna die frische Kartei liest.
    if not a.dry_run:
        try:
            import kartei_sync
            for line in kartei_sync.sync():
                print(line)
        except Exception as e:  # noqa: BLE001 — Kartei-Fehler darf Triage nicht stoppen
            print(f"WARN: kartei_sync fehlgeschlagen ({e})", file=sys.stderr)

    seen = load_state()
    current = scan(a.window_days)

    # Erstlauf: alles als gesehen markieren, nicht rueckwirkend triagieren.
    if not STATE.exists():
        if a.dry_run:
            print(f"[dry-run] Erstlauf — wuerde {len(current)} Datei(en) "
                  f"als gesehen markieren (kein State geschrieben).")
            return
        save_state(set(current), a.window_days)
        print(f"Erstlauf — {len(current)} vorhandene Datei(en) als gesehen markiert.")
        return

    # --- Vier-Augen: Freigaben & TTL zuerst (deterministisch, kein LLM) ---
    if not a.dry_run:
        for tok in approval_queue.expire_stale(ttl_days=7):
            print(f"Freigabe #{tok} nach TTL verfallen.")
    approval_new = scan_approval_replies(a.window_days, seen)
    if approval_new:
        results = process_approvals(approval_new, dry_run=a.dry_run,
                                    save_sent=ews_sent.save_to_sent)
        print(f"Freigabe-Antworten: {results}")
        if not a.dry_run:
            # Nur terminal erledigte Antworten als gesehen markieren. send-error/error
            # bleiben ungesehen → nächster Lauf versucht die noch pending Freigabe
            # erneut (kein stiller Verlust; Doppelversand blockt der Queue-Status-Guard).
            terminal = {"sent", "correction", "skip"}
            done = {r["file"] for r in results if r.get("action") in terminal}
            if done:
                seen = seen | done
                save_state(seen, a.window_days)

    new = [n for n in current if n not in seen]
    if not new:
        print("Keine neuen Mails.")
        return

    # Coalesce: arbeitet sie noch an einem Triage-Issue, kein zweites anlegen —
    # sonst entsteht bei jedem 10-Min-Tick ein neues Issue (Flut). Neue Mails
    # bleiben ungemerkt und werden beim nächsten freien Lauf aufgesammelt.
    if not a.dry_run and _triage_in_flight():
        print(f"{len(new)} neue Mail(s), aber ein Triage-Issue ist noch offen — warte.")
        return

    capped = max(0, len(new) - MAX_PER_ISSUE)
    batch = new[:MAX_PER_ISSUE]

    if a.dry_run:
        print(f"[dry-run] {len(new)} neu, wuerde Issue fuer {len(batch)} anlegen:")
        for n in batch:
            print("   ", n)
        return

    token = pc.load_token()
    title = f"Neue Mails: {len(batch)} — Antwort-Entwürfe — {datetime.now():%Y-%m-%d %H:%M}"
    issue_id = pc.create_issue(
        BASE, token, COMPANY,
        title=title,
        description=build_description(batch, capped),
        assignee_agent_id=AGENT,
        priority="medium",
    )
    print(f"Issue angelegt: {issue_id} ({len(batch)} Mails)")

    # Erst nach erfolgreichem Anlegen als gesehen markieren — sonst gehen
    # Mails verloren, wenn die API gerade nicht erreichbar ist.
    save_state(seen | set(batch), a.window_days)


if __name__ == "__main__":
    main()
