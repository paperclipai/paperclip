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
import re
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import paperclip_client as pc  # noqa: E402
import approval_queue as approval_queue  # noqa: E402
import approval_parse as approval_parse  # noqa: E402
import approval_send as approval_send  # noqa: E402
import blocklist as blocklist  # noqa: E402
import triage_reconcile as triage_reconcile  # noqa: E402
import ews_sent as ews_sent  # noqa: E402
import office_inbox as office_inbox  # noqa: E402

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


# Walters eigene Absende-Adressen (Adress-Fragmente, NICHT das bloße Wort "walter" —
# sonst würde ein Kunde namens Walter fälschlich aus der Triage gefiltert).
WALTER_OWN_ADDRESSES = ("w.schonenbrocher", "walter@schoenenbroecher", "ws@whitestag.ai")


def _is_walter_mail(path: Path) -> bool:
    """True, wenn die Mail von Walter selbst stammt (Frontmatter `von:`).

    Walters eigene (gesendete) Mails landen als Kopie im Vault; sie sind KEINE
    Kundenpost, auf die Luna antworten soll — sonst entwirft sie Antworten für
    Threads, die Walter längst selbst beantwortet hat. Match nur auf seine echten
    Absende-Adressen, damit ein Kunde mit Vornamen Walter nicht gefiltert wird."""
    try:
        with path.open(encoding="utf-8") as fh:
            for _ in range(12):
                line = fh.readline()
                if not line:
                    break
                low = line.lower()
                if low.startswith(("von:", "from:")):
                    return any(s in low for s in WALTER_OWN_ADDRESSES)
    except OSError:
        return False
    return False


def _is_blocked_sender(path: Path, blocked: set[str] | None = None) -> bool:
    """True, wenn die `von:`-Adresse der Mail auf der Blockliste steht.

    Liest nur das Frontmatter (wie `_is_agent_mail`). `blocked` wird vom Aufrufer
    einmal pro scan() geladen; None → selbst laden (bequem für Tests)."""
    if blocked is None:
        blocked = blocklist.load()
    if not blocked:
        return False
    try:
        with path.open(encoding="utf-8") as fh:
            for _ in range(12):
                line = fh.readline()
                if not line:
                    break
                low = line.lower()
                if low.startswith(("von:", "from:")):
                    m = re.search(r"[\w.+-]+@[\w-]+\.[\w.-]+", line)
                    return bool(m) and m.group(0).lower() in blocked
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


def _apply_reply(token, body, *, dry_run, send, make_issue, save_sent):
    """Kernlogik für EINE Freigabe-Antwort (quellenunabhängig: Vault ODER office@).

    Gibt eine action zurück: skip | would-send | sent | send-error | would-correct
    | correction | would-ignore | ignored. Terminale Aktionen (sent/correction/
    skip/ignored) darf der Aufrufer als erledigt markieren; **send-error bleibt
    retrybar** (Status bleibt pending)."""
    entry = approval_queue.load(token)
    if entry is None or entry.get("status") != "pending":
        return "skip"
    cls = approval_parse.classify(body)
    if cls == "send":
        if dry_run:
            return "would-send"
        code, resp = send(entry)
        if code != 200:
            print(f"FEHLER Freigabe #{token}: Relay HTTP {code}: {resp}", file=sys.stderr)
            return "send-error"
        approval_queue.mark(token, "sent", sent=datetime.now().isoformat())
        print(f"Freigabe #{token}: gesendet an {entry['to']}")
        if save_sent is not None:  # Kopie in ws@ „Gesendete Elemente" (nicht-fatal)
            try:
                ok, resp2 = save_sent(to=entry["to"], subject=entry["subject"],
                                      html=entry["rendered_html"])
                if not ok:
                    print(f"WARN Sent-Kopie #{token} fehlgeschlagen: {resp2[:120]}", file=sys.stderr)
            except Exception as ex:  # noqa: BLE001
                print(f"WARN Sent-Kopie #{token}: {ex}", file=sys.stderr)
        return "sent"
    if cls == "ignore":
        if dry_run:
            return "would-ignore"
        blocklist.add(entry["to"])
        approval_queue.mark(token, "ignored")
        print(f"Freigabe #{token}: ignoriert — {entry['to']} gesperrt")
        return "ignored"
    if dry_run:
        return "would-correct"
    make_issue(token, body, entry)
    return "correction"


def process_approvals(new_files, *, dry_run, send=approval_send.send_approved,
                      make_issue=None, save_sent=None):
    """Vault-Pfad (Fallback): Freigabe-Antworten aus den gespiegelten ws@-Sent-Mails.
    Liste von {file, token, action}."""
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
            action = _apply_reply(token, read_body(path), dry_run=dry_run, send=send,
                                  make_issue=make_issue, save_sent=save_sent)
            results.append({"file": name, "token": token, "action": action})
        except Exception as e:  # noqa: BLE001 — ein kaputter Eintrag darf den Tick nicht killen
            print(f"WARN Freigabe {name}: {e}", file=sys.stderr)
            results.append({"file": name, "token": None, "action": "error"})
    return results


def process_office_approvals(*, dry_run, send=approval_send.send_approved,
                             make_issue=None, save_sent=None):
    """Primärer, zuverlässiger Pfad: liest Walters Freigabe-Antworten direkt aus
    dem office@-Posteingang (unabhängig vom ws@-Sent-Sync). Liste von
    {uid, token, action}. Bearbeitete UIDs werden lokal gemerkt (send-error bleibt
    retrybar → UID NICHT merken)."""
    if make_issue is None:
        make_issue = _create_correction_issue
    processed = office_inbox.load_processed()
    try:
        replies = office_inbox.fetch_approval_replies(processed)
    except Exception as e:  # noqa: BLE001 — office@ nicht erreichbar darf Tick nicht killen
        print(f"WARN office@-Abruf fehlgeschlagen: {e}", file=sys.stderr)
        return []
    results = []
    for r in replies:
        try:
            action = _apply_reply(r["token"], r["body"], dry_run=dry_run, send=send,
                                  make_issue=make_issue, save_sent=save_sent)
            results.append({"uid": r["uid"], "token": r["token"], "action": action})
            if not dry_run and action != "send-error":  # send-error retrybar
                processed.add(r["uid"])
        except Exception as e:  # noqa: BLE001
            print(f"WARN office@ Freigabe #{r.get('token')}: {e}", file=sys.stderr)
    if not dry_run:
        office_inbox.save_processed(processed)
    return results


def process_unblock_commands(*, dry_run):
    """Liest Walters 'Entsperren <adresse>'-Mails aus office@ und entfernt die
    Adresse von der Blockliste (still). Liste von {uid, addr, action}. Bearbeitete
    UIDs werden gemerkt (eigener State, getrennt von den Freigabe-UIDs)."""
    processed = office_inbox.load_processed_unblock()
    try:
        cmds = office_inbox.fetch_unblock_commands(processed)
    except Exception as e:  # noqa: BLE001 — office@ nicht erreichbar darf Tick nicht killen
        print(f"WARN Entsperr-Abruf fehlgeschlagen: {e}", file=sys.stderr)
        return []
    results = []
    for c in cmds:
        try:
            if dry_run:
                results.append({"uid": c["uid"], "addr": c["addr"], "action": "would-unblock"})
                continue
            blocklist.remove(c["addr"])
            print(f"Entsperrt: {c['addr']}")
            results.append({"uid": c["uid"], "addr": c["addr"], "action": "unblocked"})
            processed.add(c["uid"])
        except Exception as e:  # noqa: BLE001
            print(f"WARN Entsperren {c.get('addr')}: {e}", file=sys.stderr)
    if not dry_run:
        office_inbox.save_processed_unblock(processed)
    return results


# Walter als menschlicher Reviewer (in_review braucht laut Server einen echten
# Review-Pfad — assigneeUserId erfüllt das).
WALTER_USER_ID = "18r34Ghx5N0LHRptMCT6Fp1WaoGqhvc9"


def _api(method: str, path: str, payload: dict | None = None):
    import urllib.request
    import json as _json
    data = _json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        f"{BASE}{path}", data=data, method=method,
        headers={"Authorization": "Bearer " + pc.load_token(),
                 "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read().decode("utf-8") or "{}"
    return _json.loads(raw)


def _unwrap(d, *keys):
    if isinstance(d, list):
        return d
    for k in keys:
        if isinstance(d.get(k), list):
            return d[k]
    return []


def _list_blocked_issues():
    return _unwrap(_api("GET", f"/api/companies/{COMPANY}/issues"
                               f"?assigneeAgentId={AGENT}&status=blocked&limit=100"),
                   "issues", "data")


def _issue_comments(issue_id: str):
    return _unwrap(_api("GET", f"/api/issues/{issue_id}/comments"), "comments", "data")


def _close_triage_issue(issue_id: str) -> None:
    """Endzustand setzen, den Luna beabsichtigt hatte: in_review + Walter."""
    _api("PATCH", f"/api/issues/{issue_id}",
         {"status": "in_review", "assigneeUserId": WALTER_USER_ID, "assigneeAgentId": None})
    pc.add_comment(BASE, pc.load_token(), issue_id,
                   "Deterministisch auf `in_review` gesetzt: Der Adapter-Guard hatte das Issue "
                   "blockiert, weil das Modell den abschließenden `paperclip_update_issue`-Call "
                   "nicht ausgeführt hat — die Triage-Arbeit selbst war erledigt.")


def reconcile_blocked_triage(*, dry_run):
    """Erledigte-aber-blockierte Triage-Issues abschließen (Details: triage_reconcile)."""
    try:
        return triage_reconcile.reconcile(
            list_blocked=_list_blocked_issues, get_comments=_issue_comments,
            close_issue=_close_triage_issue, dry_run=dry_run)
    except Exception as e:  # noqa: BLE001 — darf den Tick nicht killen
        print(f"WARN Triage-Abgleich fehlgeschlagen: {e}", file=sys.stderr)
        return []


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
    blocked = blocklist.load()
    out = []
    for p in sorted(MAILDIR.glob("*.md")):
        if p.name[:10] < cutoff:
            continue
        if _is_agent_mail(p):
            continue
        if _is_walter_mail(p):
            continue
        if _is_blocked_sender(p, blocked):
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
    # PRIMÄR: office@-Posteingang (dorthin gehen Walters Antworten direkt, zuverlässig).
    office_results = process_office_approvals(dry_run=a.dry_run, save_sent=ews_sent.save_to_sent)
    if office_results:
        print(f"office@-Freigaben: {office_results}")
    unblock_results = process_unblock_commands(dry_run=a.dry_run)
    if unblock_results:
        print(f"Entsperr-Kommandos: {unblock_results}")
    # Triage-Issues abschließen, die Luna erledigt hat, die aber der Adapter-Guard
    # blockiert hat (Modell rief den terminalen Status-Call nicht auf).
    reconciled = reconcile_blocked_triage(dry_run=a.dry_run)
    if reconciled:
        print(f"Triage-Abgleich: {reconciled}")
    # FALLBACK: ws@-Sent-Spiegelung im Vault (falls office@ mal nicht erreichbar war).
    approval_new = scan_approval_replies(a.window_days, seen)
    if approval_new:
        results = process_approvals(approval_new, dry_run=a.dry_run,
                                    save_sent=ews_sent.save_to_sent)
        print(f"Freigabe-Antworten: {results}")
        if not a.dry_run:
            # Nur terminal erledigte Antworten als gesehen markieren. send-error/error
            # bleiben ungesehen → nächster Lauf versucht die noch pending Freigabe
            # erneut (kein stiller Verlust; Doppelversand blockt der Queue-Status-Guard).
            terminal = {"sent", "correction", "skip", "ignored"}
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
