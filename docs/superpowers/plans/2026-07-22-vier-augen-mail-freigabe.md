# Vier-Augen-System für Lunas Mail-Antworten — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Luna formuliert E-Mail-Antworten und legt sie Walter zur Freigabe vor; bestätigt Walter mit exakt „Okay", versendet ein deterministischer Watcher genau diesen Entwurf an den externen Empfänger.

**Architecture:** Freigabe-Queue (JSON-Dateien) + deterministischer Approval-Watcher (Python, im bestehenden launchd-Job) + Choke-Point am SMTP-Relay (`office@→extern` nur mit `approval`-Feld). Kein LLM im Sende-Pfad — freigegebene Bytes = gesendete Bytes.

**Tech Stack:** Python 3 (stdlib + `urllib`), pytest/unittest, n8n (JS Code-Node im `SMTP Relay`), Paperclip-API via `paperclip_client.py`.

## Global Constraints

- **Dev-Root (im Repo):** Alle Quell- und Testdateien werden unter `tools/sekretaerin-mail-watcher/` im Paperclip-Repo entwickelt (Projekt-Muster wie `tools/seo-geo/`, `tools/vault-lookup/`) — **echte Git-Commits mit Diffs**, kein `--allow-empty`. Wo ein Task-Text unten noch `~/.paperclip/scripts/sekretaerin-mail-watcher/` als Quell-Pfad nennt, gilt stattdessen `tools/sekretaerin-mail-watcher/`. **Laufzeit-Pfade im Code** (`QUEUE_DIR=~/.paperclip/state/luna-approvals`, `SECRET_FILE`, `MAILDIR`, Webhook-URL) bleiben **exakt wie geschrieben** — sie zeigen auf die Deploy-/Runtime-Umgebung.
- **Deploy (separater Schluss-Task):** Nach grünen Tests werden die Module nach `~/.paperclip/scripts/sekretaerin-mail-watcher/` und die Luna-Skripte (`luna_mail_render.py`, `luna-queue-approval.py`) in das Agent-`bin/` (`…/agents/e24b8d9d…/bin/`) kopiert. Der existierende `watcher.py` wird zu Beginn als Baseline ins Repo kopiert, dort modifiziert und am Ende zurück-deployt.
- Tests colocated, `unittest`-Stil (wie `tools/n8n-workflow-watcher/test_*.py`).
- Test-Kommando: `python3 -m pytest <datei> -v` (pytest 8.4.2 vorhanden).
- Company-ID: `9cebf3cf-efe8-4597-a400-f06488900a87` · Luna-Agent-ID: `e24b8d9d-143e-4141-b413-4361aa618771` · Walter-User-ID: `18r34Ghx5N0LHRptMCT6Fp1WaoGqhvc9`.
- Mailhub-Send-Webhook: `http://localhost:5678/webhook/mailhub/send`, Header `X-Mailhub-Secret: mailhub-812a27b07c73e64d7df192c98a3883eb`, Absender `office@whitestag.ai`, Walter `ws@whitestag.ai`.
- Freigabe-Wort: **exakt „okay"** nach Normalisierung (trim, lowercase, End-Satzzeichen `.!` entfernt). Alles andere = Korrektur. Im Zweifel (unparsbar) = Korrektur, **nie senden**.
- Token-Format: 4 Zeichen aus `A-Z2-7` (Base32-Alphabet ohne 0/1/8/9), Betreff-Marker `[Freigabe #<TOKEN>]`.
- TTL pending-Einträge: **7 Tage** → `expired`, kein Versand, keine Meldung.
- n8n-Versionierung (Hausregel): `SMTP Relay V15` unangetastet, neue Version `V16` als Kopie, sauber publishen (deactivate→activate), `activeVersionId == versionId` verifizieren; neueste Version zusätzlich nach `~/Library/CloudStorage/SynologyDrive-Mac/Claude Code MAC/n8n Workflows/` kopieren.
- Luna bleibt read-only auf dem Postfach: kein Verschieben/Löschen.
- Git nach jeder Task committen (echte Diffs unter `tools/sekretaerin-mail-watcher/`). Repo: `~/Library/CloudStorage/SynologyDrive-Mac/Claude Code MAC/Paperclip`, Branch `feat/academy-lektor` (laufender Dev-Branch).

---

## File Structure

- `sekretaerin-mail-watcher/approval_queue.py` — Freigabe-Queue CRUD + Token-Erzeugung + TTL.
- `sekretaerin-mail-watcher/approval_parse.py` — Betreff-Token, Antworttext-Isolierung, „Okay"-Klassifikation.
- `sekretaerin-mail-watcher/approval_send.py` — Versand des freigegebenen Entwurfs an den Relay (mit Approval-Feld).
- `sekretaerin-mail-watcher/watcher.py` — **modifiziert**: Approval-Scan, Korrektur-Issues, TTL, Ausschluss der Freigabe-Antworten aus dem Neu-Mail-Scan, neuer Auftragstext.
- `…/agents/e24b8d9d…/bin/luna_mail_render.py` — geteiltes Rendering (Antwort-HTML + Signatur).
- `…/agents/e24b8d9d…/bin/luna-queue-approval.py` — Lunas Skript: rendern → Queue-Eintrag → Freigabe-Mail an Walter.
- Tests: `test_approval_queue.py`, `test_approval_parse.py`, `test_approval_send.py`, `test_watcher_approvals.py`, `test_luna_mail_render.py`.
- `~/.paperclip/state/luna-approval-secret` — Approval-Secret (chmod 600), nur Watcher + Relay.
- n8n: `SMTP Relay V16` (Kopie aus V15, Guard geöffnet + Reply-To).

---

### Task 1: Freigabe-Queue-Modul

**Files:**
- Create: `/Users/walterschoenenbroecher.de/.paperclip/scripts/sekretaerin-mail-watcher/approval_queue.py`
- Test: `/Users/walterschoenenbroecher.de/.paperclip/scripts/sekretaerin-mail-watcher/test_approval_queue.py`

**Interfaces:**
- Produces:
  - `QUEUE_DIR: Path`
  - `gen_token(existing: set[str] | None = None) -> str` — 4-Zeichen `A-Z2-7`, kollisionsfrei.
  - `create(*, to, area, subject, body_md, rendered_html, original_mail_file, approval_subject, in_reply_to="") -> str` — schreibt `<token>.json`, `status="pending"`, `created=ISO`, gibt Token zurück.
  - `load(token: str) -> dict | None`
  - `save(entry: dict) -> None`
  - `list_pending() -> list[dict]`
  - `mark(token: str, status: str, **extra) -> dict`
  - `expire_stale(ttl_days: int = 7, now: datetime | None = None) -> list[str]`

- [ ] **Step 1: Write the failing test**

```python
# test_approval_queue.py
import unittest, tempfile, json
from datetime import datetime, timedelta
from pathlib import Path
import approval_queue as q


class QueueTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        q.QUEUE_DIR = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_token_format_and_uniqueness(self):
        t = q.gen_token(existing={"AAAA"})
        self.assertEqual(len(t), 4)
        self.assertTrue(all(c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567" for c in t))
        self.assertNotEqual(t, "AAAA")

    def test_create_and_load_roundtrip(self):
        tok = q.create(to="k@example.de", area="FILM", subject="AW: Test",
                       body_md="Hallo", rendered_html="<p>Hallo</p>",
                       original_mail_file="2026-07-22-x.md",
                       approval_subject="[Freigabe #ABCD] AW: Test → an k@example.de")
        e = q.load(tok)
        self.assertEqual(e["status"], "pending")
        self.assertEqual(e["to"], "k@example.de")
        self.assertEqual(e["rendered_html"], "<p>Hallo</p>")
        self.assertIn("created", e)

    def test_mark_changes_status(self):
        tok = q.create(to="k@example.de", area="AI", subject="s", body_md="b",
                       rendered_html="h", original_mail_file="f", approval_subject="a")
        q.mark(tok, "sent", sent="2026-07-22T10:00:00")
        self.assertEqual(q.load(tok)["status"], "sent")

    def test_list_pending_only(self):
        t1 = q.create(to="a@x.de", area="AI", subject="s", body_md="b",
                      rendered_html="h", original_mail_file="f", approval_subject="a")
        t2 = q.create(to="b@x.de", area="AI", subject="s", body_md="b",
                      rendered_html="h", original_mail_file="f", approval_subject="a")
        q.mark(t2, "sent")
        pend = [e["token"] for e in q.list_pending()]
        self.assertIn(t1, pend)
        self.assertNotIn(t2, pend)

    def test_expire_stale(self):
        tok = q.create(to="a@x.de", area="AI", subject="s", body_md="b",
                       rendered_html="h", original_mail_file="f", approval_subject="a")
        e = q.load(tok); e["created"] = (datetime.now() - timedelta(days=8)).isoformat(); q.save(e)
        expired = q.expire_stale(ttl_days=7)
        self.assertIn(tok, expired)
        self.assertEqual(q.load(tok)["status"], "expired")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/.paperclip/scripts/sekretaerin-mail-watcher && python3 -m pytest test_approval_queue.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'approval_queue'`

- [ ] **Step 3: Write minimal implementation**

```python
# approval_queue.py
"""Freigabe-Queue für Lunas Vier-Augen-Mailversand (eine JSON-Datei je Token)."""
from __future__ import annotations
import json, secrets
from datetime import datetime, timedelta
from pathlib import Path

QUEUE_DIR = Path.home() / ".paperclip" / "state" / "luna-approvals"
_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"  # Base32 ohne 0/1/8/9


def _existing_tokens() -> set[str]:
    if not QUEUE_DIR.is_dir():
        return set()
    return {p.stem for p in QUEUE_DIR.glob("*.json")}


def gen_token(existing: set[str] | None = None) -> str:
    taken = existing if existing is not None else _existing_tokens()
    while True:
        tok = "".join(secrets.choice(_ALPHABET) for _ in range(4))
        if tok not in taken:
            return tok


def _path(token: str) -> Path:
    return QUEUE_DIR / f"{token}.json"


def save(entry: dict) -> None:
    QUEUE_DIR.mkdir(parents=True, exist_ok=True)
    p = _path(entry["token"])
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(entry, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(p)


def load(token: str) -> dict | None:
    p = _path(token)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def create(*, to: str, area: str, subject: str, body_md: str, rendered_html: str,
           original_mail_file: str, approval_subject: str, in_reply_to: str = "") -> str:
    token = gen_token()
    entry = {
        "token": token, "status": "pending", "to": to, "area": area,
        "subject": subject, "body_md": body_md, "rendered_html": rendered_html,
        "in_reply_to": in_reply_to, "original_mail_file": original_mail_file,
        "approval_subject": approval_subject,
        "created": datetime.now().isoformat(), "sent": None,
    }
    save(entry)
    return token


def list_pending() -> list[dict]:
    if not QUEUE_DIR.is_dir():
        return []
    out = []
    for p in sorted(QUEUE_DIR.glob("*.json")):
        e = load(p.stem)
        if e and e.get("status") == "pending":
            out.append(e)
    return out


def mark(token: str, status: str, **extra) -> dict:
    e = load(token)
    if e is None:
        raise KeyError(token)
    e["status"] = status
    e.update(extra)
    save(e)
    return e


def expire_stale(ttl_days: int = 7, now: datetime | None = None) -> list[str]:
    now = now or datetime.now()
    cutoff = now - timedelta(days=ttl_days)
    expired = []
    for e in list_pending():
        try:
            created = datetime.fromisoformat(e["created"])
        except (ValueError, KeyError):
            continue
        if created < cutoff:
            mark(e["token"], "expired")
            expired.append(e["token"])
    return expired
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/.paperclip/scripts/sekretaerin-mail-watcher && python3 -m pytest test_approval_queue.py -v`
Expected: PASS (5 passed)

- [ ] **Step 5: Commit**

```bash
cd ~/.paperclip/scripts/sekretaerin-mail-watcher
git add approval_queue.py test_approval_queue.py 2>/dev/null || true
git -C "$HOME/Library/CloudStorage/SynologyDrive-Mac/Claude Code MAC/Paperclip" commit --allow-empty -m "feat(luna): Freigabe-Queue-Modul (approval_queue)"
```

---

### Task 2: Approval-Parsing-Modul (sicherheitskritisch)

**Files:**
- Create: `/Users/walterschoenenbroecher.de/.paperclip/scripts/sekretaerin-mail-watcher/approval_parse.py`
- Test: `/Users/walterschoenenbroecher.de/.paperclip/scripts/sekretaerin-mail-watcher/test_approval_parse.py`

**Interfaces:**
- Produces:
  - `TOKEN_RE` (kompiliert)
  - `extract_token(subject: str) -> str | None`
  - `isolate_reply(body: str) -> str` — oberster Antwortblock, Zitat/Signatur abgeschnitten.
  - `normalize(text: str) -> str`
  - `classify(body: str) -> str` — `"send"` nur bei isoliertem, normalisiertem `okay`, sonst `"correction"`.

- [ ] **Step 1: Write the failing test**

```python
# test_approval_parse.py
import unittest
import approval_parse as ap


class TokenTest(unittest.TestCase):
    def test_extract_token(self):
        self.assertEqual(ap.extract_token("AW: [Freigabe #A7X3] Betreff → an k@x.de"), "A7X3")
        self.assertEqual(ap.extract_token("Re: [Freigabe #ZZ44] x"), "ZZ44")
        self.assertIsNone(ap.extract_token("AW: normale Mail ohne Token"))


class ClassifyTest(unittest.TestCase):
    def test_bare_okay_sends(self):
        self.assertEqual(ap.classify("Okay"), "send")
        self.assertEqual(ap.classify("okay"), "send")
        self.assertEqual(ap.classify("OKAY!"), "send")
        self.assertEqual(ap.classify("  Okay.  "), "send")

    def test_okay_with_quote_sends(self):
        body = ("Okay\n\n"
                "> Am 22.07.2026 schrieb office@whitestag.ai:\n"
                "> [Freigabe #A7X3] Entwurf …\n> Sehr geehrte …")
        self.assertEqual(ap.classify(body), "send")

    def test_okay_with_signature_sends(self):
        body = "Okay\n\n-- \nWalter Schönenbröcher\nWHITESTAG"
        self.assertEqual(ap.classify(body), "send")

    def test_non_exact_words_are_corrections(self):
        for txt in ["OK", "Senden", "Ja bitte", "okay, aber Termin streichen",
                    "Bitte förmlicher formulieren", "", "   ",
                    "Freigegeben", "👍"]:
            self.assertEqual(ap.classify(txt), "correction", msg=repr(txt))

    def test_quote_only_is_correction(self):
        body = "> [Freigabe #A7X3] Entwurf …\n> Sehr geehrte …"
        self.assertEqual(ap.classify(body), "correction")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest test_approval_parse.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'approval_parse'`

- [ ] **Step 3: Write minimal implementation**

```python
# approval_parse.py
"""Erkennt Walters Freigabe-Antworten: Token aus Betreff + exakt-'okay'-Prüfung.

Sicherheitsregel: nur ein isoliertes, alleinstehendes 'okay' löst Versand aus.
Im Zweifel -> 'correction' (nie senden)."""
from __future__ import annotations
import re

TOKEN_RE = re.compile(r"\[Freigabe #([A-Z2-7]{4})\]")

# Zeilen, ab denen der zitierte Ursprung / die Signatur beginnt.
_QUOTE_MARKERS = (
    ">",                      # klassisches Zitat
    "-- ",                    # Signaturtrenner (RFC)
    "-----",                  # "-----Ursprüngliche Nachricht-----"
    "________",               # Outlook-Trennlinie
    "Von:", "From:",          # Outlook/Exchange-Header im Body
)
_QUOTE_PHRASE_RE = re.compile(r"^\s*Am .+ schrieb .+:", re.IGNORECASE)


def extract_token(subject: str) -> str | None:
    m = TOKEN_RE.search(subject or "")
    return m.group(1) if m else None


def isolate_reply(body: str) -> str:
    """Oberster Antwortblock vor Zitat/Signatur."""
    lines = (body or "").replace("\r\n", "\n").split("\n")
    kept = []
    for line in lines:
        stripped = line.strip()
        if _QUOTE_PHRASE_RE.match(line):
            break
        if any(stripped.startswith(m.strip()) and (m == "-- " and line.rstrip() == "--"
               or m != "-- ") for m in ()):  # placeholder, siehe unten
            pass
        # explizite Marker-Prüfung:
        if stripped.startswith(">") or stripped.startswith("-----") \
           or stripped.startswith("________") \
           or stripped.startswith("Von:") or stripped.startswith("From:") \
           or line.rstrip() == "--" or line.rstrip() == "-- ":
            break
        kept.append(line)
    return "\n".join(kept).strip()


def normalize(text: str) -> str:
    return text.strip().lower().rstrip(".!").strip()


def classify(body: str) -> str:
    top = isolate_reply(body)
    if not top:
        return "correction"
    # Nur wenn der GESAMTE oberste Block (ohne Leerzeilen) 'okay' ist.
    compact = " ".join(l for l in top.split("\n") if l.strip()).strip()
    return "send" if normalize(compact) == "okay" else "correction"
```

> Hinweis für den Umsetzer: die `any(...)`-Zeile mit `placeholder` in `isolate_reply` ist toter Ballast aus einem Zwischenstand — **ersetze `isolate_reply` durch die klare Fassung unten** und lass die Marker-Prüfung nur einmal stehen:

```python
def isolate_reply(body: str) -> str:
    lines = (body or "").replace("\r\n", "\n").split("\n")
    kept = []
    for line in lines:
        stripped = line.strip()
        if _QUOTE_PHRASE_RE.match(line):
            break
        if (stripped.startswith(">") or stripped.startswith("-----")
                or stripped.startswith("________")
                or stripped.startswith("Von:") or stripped.startswith("From:")
                or line.rstrip() in ("--", "-- ")):
            break
        kept.append(line)
    return "\n".join(kept).strip()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m pytest test_approval_parse.py -v`
Expected: PASS (6 passed)

- [ ] **Step 5: Commit**

```bash
git -C "$HOME/Library/CloudStorage/SynologyDrive-Mac/Claude Code MAC/Paperclip" commit --allow-empty -m "feat(luna): Approval-Parsing (exakt-okay, fail-safe)"
```

---

### Task 3: Geteiltes Rendering + Lunas Freigabe-Skript

**Files:**
- Create: `/Users/walterschoenenbroecher.de/.paperclip/instances/default/companies/9cebf3cf-efe8-4597-a400-f06488900a87/agents/e24b8d9d-143e-4141-b413-4361aa618771/bin/luna_mail_render.py`
- Create: `…/bin/luna-queue-approval.py`
- Test: `…/bin/test_luna_mail_render.py`

**Interfaces:**
- Consumes: `approval_queue.create` (Task 1). `luna-queue-approval.py` fügt `~/.paperclip/scripts/sekretaerin-mail-watcher` zu `sys.path` hinzu.
- Produces (`luna_mail_render.py`):
  - `AREAS = {"AI": "ai", "FILM": "film", "SORBART": "sorbart"}`
  - `strip_self_signoff(md: str) -> str`
  - `md_to_html(md: str) -> str`
  - `load_sig(area: str) -> str`
  - `render_customer_html(area: str, body_md: str) -> str` — Antwort-HTML + Signatur, **ohne** Banner (= die Bytes, die an den Kunden gehen).
- `luna-queue-approval.py` CLI: `--area {AI,FILM,SORBART} --to <kunde> --subject <betreff> --body <md-datei> --original-file <vault-dateiname> [--in-reply-to <msgid>]`

- [ ] **Step 1: Write the failing test**

```python
# test_luna_mail_render.py
import unittest, tempfile
from pathlib import Path
import luna_mail_render as r


class RenderTest(unittest.TestCase):
    def test_strip_self_signoff(self):
        md = "Danke für Ihre Mail.\n\nMit freundlichen Grüßen\nLuna"
        self.assertEqual(r.strip_self_signoff(md).strip(), "Danke für Ihre Mail.")

    def test_md_to_html_paragraphs(self):
        html = r.md_to_html("Absatz eins.\n\nAbsatz zwei.")
        self.assertEqual(html.count("<p"), 2)
        self.assertIn("Absatz eins.", html)

    def test_render_customer_html_includes_signature(self):
        # Signatur-Stub in temporärem SIGDIR
        tmp = tempfile.TemporaryDirectory()
        r.SIGDIR = Path(tmp.name)
        (Path(tmp.name) / "signatur-ai.html").write_text("<div>SIG-AI</div>", encoding="utf-8")
        out = r.render_customer_html("AI", "Hallo Welt")
        self.assertIn("Hallo Welt", out)
        self.assertIn("SIG-AI", out)
        self.assertNotIn("Entwurf-Vorschau", out)  # kein Banner
        tmp.cleanup()


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd …/bin && python3 -m pytest test_luna_mail_render.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'luna_mail_render'`

- [ ] **Step 3: Write minimal implementation**

`luna_mail_render.py` (die `strip_self_signoff` / `md_to_html` / `load_sig`-Logik ist 1:1 aus dem bestehenden `luna-draft-mail.py` übernommen, damit Entwurf und Freigabe identisch rendern):

```python
# luna_mail_render.py
"""Geteiltes Rendering: Antwort-Markdown -> Kunden-HTML inkl. Bereichs-Signatur."""
from __future__ import annotations
import html as htmllib
import re
from pathlib import Path

SIGDIR = Path.home() / "Obsidian" / "WHITESTAG-Vault" / "Paperclip" / "Luna" / "signaturen"
AREAS = {"AI": "ai", "FILM": "film", "SORBART": "sorbart"}

_GREETING_RE = re.compile(
    r"^\s*(mit freundlichen gr[üue]+ßen|mit besten gr[üue]+ßen|"
    r"beste gr[üue]+ße|freundliche gr[üue]+ße|viele gr[üue]+ße|"
    r"herzliche gr[üue]+ße|liebe gr[üue]+ße)\b", re.IGNORECASE)


def strip_self_signoff(md: str) -> str:
    lines = md.rstrip().split("\n")
    cut = None
    for i, line in enumerate(lines):
        if _GREETING_RE.match(line):
            tail = [l for l in lines[i + 1:] if l.strip()]
            if len(tail) <= 2:
                cut = i
                break
    if cut is None:
        return md
    return "\n".join(lines[:cut]).rstrip() + "\n"


def md_to_html(md: str) -> str:
    md = md.strip()
    blocks = [b.strip() for b in md.split("\n\n") if b.strip()]
    out = []
    for b in blocks:
        safe = htmllib.escape(b).replace("\n", "<br>")
        out.append(f'<p style="margin:0 0 12px 0;font-size:14px;line-height:1.5;color:#222;">{safe}</p>')
    return "\n".join(out)


def load_sig(area: str) -> str:
    p = SIGDIR / f"signatur-{AREAS[area]}.html"
    if not p.exists():
        raise FileNotFoundError(f"Signatur fehlt: {p}")
    return p.read_text(encoding="utf-8")


def render_customer_html(area: str, body_md: str) -> str:
    answer = md_to_html(strip_self_signoff(body_md))
    sig = load_sig(area)
    return (
        '<!DOCTYPE html><html><head><meta charset="utf-8"></head>'
        '<body style="font-family:Arial,Helvetica,sans-serif;max-width:720px;margin:0 auto;padding:20px;">'
        f'<div style="margin:0 0 24px 0;">{answer}</div>{sig}</body></html>'
    )
```

`luna-queue-approval.py`:

```python
#!/usr/bin/env python3
"""Luna: Antwort rendern -> Freigabe-Queue-Eintrag -> Freigabe-Mail an Walter.

Ersetzt den Draft-Weg von luna-draft-mail.py. Versendet NIE an Externe —
nur die Freigabe-Mail an ws@. Der Versand an den Kunden erfolgt später
deterministisch durch den Approval-Watcher nach Walters 'Okay'."""
from __future__ import annotations
import argparse, json, sys, urllib.request, urllib.error
from pathlib import Path

sys.path.insert(0, str(Path.home() / ".paperclip" / "scripts" / "sekretaerin-mail-watcher"))
import approval_queue as q                      # noqa: E402
import luna_mail_render as render               # noqa: E402

WEBHOOK = "http://localhost:5678/webhook/mailhub/send"
SECRET = "mailhub-812a27b07c73e64d7df192c98a3883eb"
FROM = "office@whitestag.ai"
WALTER = "ws@whitestag.ai"


def _send_approval_mail(token: str, to: str, subject: str, rendered_html: str) -> None:
    approval_subject = f"[Freigabe #{token}] AW: {subject} → an {to}"
    banner = (
        '<div style="background:#fff8e1;border:1px solid #ffe082;border-radius:6px;'
        'padding:10px 14px;margin:0 0 20px 0;font-family:Arial,sans-serif;font-size:12px;color:#7a5c00;">'
        f'<strong>Freigabe nötig</strong> — Antworte mit <strong>„Okay"</strong>, um diese Mail an '
        f'<strong>{to}</strong> zu senden. Jede andere Antwort = Korrektur (ich überarbeite).'
        '</div>')
    html = rendered_html.replace("<body ", banner + "<!--b--><body ", 1) if False else \
        rendered_html.replace('padding:20px;">', 'padding:20px;">' + banner, 1)
    payload = json.dumps({"from": FROM, "to": WALTER, "subject": approval_subject,
                          "text": f"Freigabe #{token}: Antwort an {to} zum Betreff „{subject}".",
                          "html": html}).encode()
    req = urllib.request.Request(WEBHOOK, data=payload, method="POST",
                                 headers={"Content-Type": "application/json",
                                          "X-Mailhub-Secret": SECRET})
    with urllib.request.urlopen(req, timeout=30) as r:
        if r.status != 200:
            raise RuntimeError(f"Freigabe-Mail fehlgeschlagen: HTTP {r.status}")
    return approval_subject


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--area", required=True, choices=list(render.AREAS))
    ap.add_argument("--to", required=True)
    ap.add_argument("--subject", required=True)
    ap.add_argument("--body", required=True)
    ap.add_argument("--original-file", required=True)
    ap.add_argument("--in-reply-to", default="")
    a = ap.parse_args()

    body_md = Path(a.body).read_text(encoding="utf-8")
    rendered_html = render.render_customer_html(a.area, body_md)
    token = q.gen_token()
    approval_subject = f"[Freigabe #{token}] AW: {a.subject} → an {a.to}"
    # Queue-Eintrag zuerst (Versand-Quelle), dann Freigabe-Mail.
    q.save({
        "token": token, "status": "pending", "to": a.to, "area": a.area,
        "subject": a.subject, "body_md": body_md, "rendered_html": rendered_html,
        "in_reply_to": a.in_reply_to, "original_mail_file": a.original_file,
        "approval_subject": approval_subject,
        "created": __import__("datetime").datetime.now().isoformat(), "sent": None,
    })
    _send_approval_mail(token, a.to, a.subject, rendered_html)
    print(f"OK Freigabe #{token} → Walter (Kunde: {a.to})")


if __name__ == "__main__":
    main()
```

> Umsetzer-Hinweis: die `... if False else ...`-Konstruktion bei `html =` ist ein Zwischenstand — **ersetze sie durch die klare Zeile**:
> `html = rendered_html.replace('padding:20px;">', 'padding:20px;">' + banner, 1)`

- [ ] **Step 4: Run test to verify it passes**

Run: `cd …/bin && python3 -m pytest test_luna_mail_render.py -v`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git -C "$HOME/Library/CloudStorage/SynologyDrive-Mac/Claude Code MAC/Paperclip" commit --allow-empty -m "feat(luna): geteiltes Rendering + luna-queue-approval Skript"
```

---

### Task 4: Approval-Secret + Versand-Modul

**Files:**
- Create: `/Users/walterschoenenbroecher.de/.paperclip/state/luna-approval-secret` (chmod 600)
- Create: `/Users/walterschoenenbroecher.de/.paperclip/scripts/sekretaerin-mail-watcher/approval_send.py`
- Test: `/Users/walterschoenenbroecher.de/.paperclip/scripts/sekretaerin-mail-watcher/test_approval_send.py`

**Interfaces:**
- Consumes: Queue-Eintrag-Dict (Task 1).
- Produces:
  - `load_secret() -> str`
  - `build_payload(entry: dict, secret: str) -> dict` — `{from, to, subject, text, html, replyTo, inReplyTo, approval}`.
  - `send_approved(entry: dict, *, urlopen=urllib.request.urlopen) -> tuple[int, str]` — POST an Relay; `urlopen` injizierbar für Tests.

- [ ] **Step 1: Generate the secret**

```bash
umask 177
python3 -c "import secrets; open('$HOME/.paperclip/state/luna-approval-secret','w').write('luna-approval-'+secrets.token_hex(16))"
chmod 600 "$HOME/.paperclip/state/luna-approval-secret"
cat "$HOME/.paperclip/state/luna-approval-secret"   # Wert notieren — Task 6 (Relay) braucht ihn identisch
```

- [ ] **Step 2: Write the failing test**

```python
# test_approval_send.py
import unittest, json
import approval_send as s


class FakeResp:
    def __init__(self, code, body=b"ok"):
        self.status = code; self._b = body
    def read(self): return self._b
    def __enter__(self): return self
    def __exit__(self, *a): return False


class SendTest(unittest.TestCase):
    def test_build_payload_has_approval_and_replyto(self):
        entry = {"to": "k@example.de", "subject": "AW: x", "body_md": "Hallo",
                 "rendered_html": "<p>Hallo</p>", "in_reply_to": "<id@x>"}
        p = s.build_payload(entry, "SECRET")
        self.assertEqual(p["from"], "office@whitestag.ai")
        self.assertEqual(p["to"], "k@example.de")
        self.assertEqual(p["replyTo"], "ws@whitestag.ai")
        self.assertEqual(p["approval"], "SECRET")
        self.assertEqual(p["inReplyTo"], "<id@x>")
        self.assertEqual(p["html"], "<p>Hallo</p>")

    def test_send_approved_posts_and_returns_code(self):
        captured = {}
        def fake_urlopen(req, timeout=0):
            captured["url"] = req.full_url
            captured["data"] = json.loads(req.data.decode())
            return FakeResp(200)
        entry = {"to": "k@example.de", "subject": "s", "body_md": "b",
                 "rendered_html": "h", "in_reply_to": ""}
        s._secret_cache = "SECRET"  # Secret-Lesen umgehen
        code, _ = s.send_approved(entry, urlopen=fake_urlopen)
        self.assertEqual(code, 200)
        self.assertIn("/webhook/mailhub/send", captured["url"])
        self.assertEqual(captured["data"]["approval"], "SECRET")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 3: Run test to verify it fails**

Run: `python3 -m pytest test_approval_send.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'approval_send'`

- [ ] **Step 4: Write minimal implementation**

```python
# approval_send.py
"""Versendet den freigegebenen Entwurf verbatim an den SMTP-Relay.

Trägt das Approval-Feld, das die (geöffnete) Luna-Guard in Relay V16 verlangt.
Nur dieser Pfad kennt das Secret — Luna selbst nie."""
from __future__ import annotations
import json, urllib.request
from pathlib import Path

WEBHOOK = "http://localhost:5678/webhook/mailhub/send"
WEBHOOK_SECRET = "mailhub-812a27b07c73e64d7df192c98a3883eb"
SECRET_FILE = Path.home() / ".paperclip" / "state" / "luna-approval-secret"
FROM = "office@whitestag.ai"
REPLY_TO = "ws@whitestag.ai"
_secret_cache: str | None = None


def load_secret() -> str:
    global _secret_cache
    if _secret_cache is None:
        _secret_cache = SECRET_FILE.read_text(encoding="utf-8").strip()
    return _secret_cache


def build_payload(entry: dict, secret: str) -> dict:
    return {
        "from": FROM, "to": entry["to"], "subject": entry["subject"],
        "text": entry.get("body_md", ""), "html": entry["rendered_html"],
        "replyTo": REPLY_TO, "inReplyTo": entry.get("in_reply_to", ""),
        "approval": secret,
    }


def send_approved(entry: dict, *, urlopen=urllib.request.urlopen) -> tuple[int, str]:
    payload = build_payload(entry, load_secret())
    req = urllib.request.Request(
        WEBHOOK, data=json.dumps(payload).encode(), method="POST",
        headers={"Content-Type": "application/json", "X-Mailhub-Secret": WEBHOOK_SECRET})
    try:
        with urlopen(req, timeout=30) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:  # type: ignore[attr-defined]
        return e.code, e.read().decode()
```

- [ ] **Step 5: Run test to verify it passes**

Run: `python3 -m pytest test_approval_send.py -v`
Expected: PASS (2 passed)

- [ ] **Step 6: Commit**

```bash
git -C "$HOME/Library/CloudStorage/SynologyDrive-Mac/Claude Code MAC/Paperclip" commit --allow-empty -m "feat(luna): Approval-Secret + Versand-Modul (approval_send)"
```

---

### Task 5: Watcher-Integration (Approval-Scan, Korrektur-Issues, TTL, Neu-Mail-Ausschluss)

**Files:**
- Modify: `/Users/walterschoenenbroecher.de/.paperclip/scripts/sekretaerin-mail-watcher/watcher.py`
- Test: `/Users/walterschoenenbroecher.de/.paperclip/scripts/sekretaerin-mail-watcher/test_watcher_approvals.py`

**Interfaces:**
- Consumes: `approval_queue` (Task 1), `approval_parse` (Task 2), `approval_send` (Task 4), `paperclip_client` (`create_issue`).
- Produces (neue Funktionen in `watcher.py`):
  - `is_approval_reply(path: Path) -> str | None` — Token, falls Datei eine Freigabe-Antwort von Walter ist (Betreff enthält `[Freigabe #..]` und Absender = Walter), sonst `None`.
  - `read_body(path: Path) -> str`
  - `process_approvals(new_files: list[str], *, dry_run: bool, send=approval_send.send_approved, make_issue=None) -> list[dict]`
  - `WALTER_SENDERS = ("w.schonenbrocher", "walter", "ws@whitestag.ai")`

- [ ] **Step 1: Write the failing test**

```python
# test_watcher_approvals.py
import unittest, tempfile
from pathlib import Path
import approval_queue as q
import watcher as w


MAIL_OKAY = """---
von: w.schonenbrocher@whitestag.ai
subject: AW: [Freigabe #A7X3] AW: Textkorrektur → an k@x.de
---
Okay

> Am 22.07. schrieb office@whitestag.ai:
> Sehr geehrte …
"""

MAIL_CORRECTION = """---
von: w.schonenbrocher@whitestag.ai
subject: AW: [Freigabe #A7X3] AW: Textkorrektur → an k@x.de
---
Bitte etwas förmlicher formulieren.
"""


class ApprovalScanTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        q.QUEUE_DIR = self.dir / "queue"
        w.MAILDIR = self.dir / "mail"
        w.MAILDIR.mkdir()
        q.save({"token": "A7X3", "status": "pending", "to": "k@x.de", "area": "FILM",
                "subject": "AW: Textkorrektur", "body_md": "b", "rendered_html": "<p>b</p>",
                "in_reply_to": "", "original_mail_file": "orig.md",
                "approval_subject": "[Freigabe #A7X3] AW: Textkorrektur → an k@x.de",
                "created": "2026-07-22T10:00:00", "sent": None})

    def tearDown(self):
        self.tmp.cleanup()

    def _write(self, name, content):
        (w.MAILDIR / name).write_text(content, encoding="utf-8")

    def test_is_approval_reply_detects_token(self):
        self._write("2026-07-22-AW-Freigabe-w.schonenbrocher.md", MAIL_OKAY)
        tok = w.is_approval_reply(w.MAILDIR / "2026-07-22-AW-Freigabe-w.schonenbrocher.md")
        self.assertEqual(tok, "A7X3")

    def test_okay_triggers_send_and_marks_sent(self):
        self._write("2026-07-22-okay-w.schonenbrocher.md", MAIL_OKAY)
        sent_calls = []
        def fake_send(entry, **kw):
            sent_calls.append(entry["token"]); return (200, "ok")
        res = w.process_approvals(["2026-07-22-okay-w.schonenbrocher.md"],
                                  dry_run=False, send=fake_send, make_issue=lambda *a, **k: None)
        self.assertEqual(sent_calls, ["A7X3"])
        self.assertEqual(q.load("A7X3")["status"], "sent")

    def test_correction_makes_issue_no_send(self):
        self._write("2026-07-22-korr-w.schonenbrocher.md", MAIL_CORRECTION)
        issues = []
        res = w.process_approvals(["2026-07-22-korr-w.schonenbrocher.md"],
                                  dry_run=False,
                                  send=lambda *a, **k: (_ for _ in ()).throw(AssertionError("darf nicht senden")),
                                  make_issue=lambda tok, note, entry: issues.append((tok, note)))
        self.assertEqual(len(issues), 1)
        self.assertEqual(issues[0][0], "A7X3")
        self.assertEqual(q.load("A7X3")["status"], "pending")  # kein Versand


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest test_watcher_approvals.py -v`
Expected: FAIL — `AttributeError: module 'watcher' has no attribute 'is_approval_reply'`

- [ ] **Step 3: Add the new functions to `watcher.py`**

Nach den bestehenden Imports ergänzen:

```python
import approval_queue as approval_queue
import approval_parse as approval_parse
import approval_send as approval_send

WALTER_SENDERS = ("w.schonenbrocher", "walter", "ws@whitestag.ai")


def read_body(path: Path) -> str:
    """Body ohne Frontmatter."""
    text = path.read_text(encoding="utf-8", errors="replace")
    if text.startswith("---"):
        parts = text.split("\n---", 1)
        if len(parts) == 2:
            return parts[1].lstrip("-\n")
    return text


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


def process_approvals(new_files, *, dry_run, send=approval_send.send_approved, make_issue=None):
    """Verarbeitet Freigabe-Antworten. Gibt Liste von {token, action} zurück."""
    if make_issue is None:
        make_issue = _create_correction_issue
    results = []
    for name in new_files:
        path = MAILDIR / name
        token = is_approval_reply(path)
        if not token:
            continue
        entry = approval_queue.load(token)
        if entry is None or entry.get("status") != "pending":
            results.append({"token": token, "action": "skip"})
            continue
        action = approval_parse.classify(read_body(path))
        if action == "send":
            if dry_run:
                results.append({"token": token, "action": "would-send"}); continue
            code, resp = send(entry)
            if code == 200:
                approval_queue.mark(token, "sent",
                                    sent=datetime.now().isoformat())
                print(f"Freigabe #{token}: gesendet an {entry['to']}")
                results.append({"token": token, "action": "sent"})
            else:
                print(f"FEHLER Freigabe #{token}: Relay HTTP {code}: {resp}", file=sys.stderr)
                results.append({"token": token, "action": "send-error"})
        else:
            if dry_run:
                results.append({"token": token, "action": "would-correct"}); continue
            make_issue(token, read_body(path), entry)
            results.append({"token": token, "action": "correction"})
    return results
```

- [ ] **Step 4: Add the correction-issue helper to `watcher.py`**

```python
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
```

- [ ] **Step 5: Wire into `main()` + exclude approval-replies from the new-mail scan**

In `scan()` die Freigabe-Antworten ausschließen (sonst würde Luna auf Walters „Okay" antworten). Direkt vor `out.append(p.name)` einfügen:

```python
        if is_approval_reply(p):
            continue
```

In `main()`, nach `save_state`-Erstlauf-Block und **vor** `new = [...]`, den Approval-Scan + TTL einhängen:

```python
    # --- Vier-Augen: Freigaben & TTL zuerst (deterministisch, kein LLM) ---
    if not a.dry_run:
        for tok in approval_queue.expire_stale(ttl_days=7):
            print(f"Freigabe #{tok} nach TTL verfallen.")
    new_all = [n for n in current if n not in seen]
    approval_results = process_approvals(new_all, dry_run=a.dry_run)
    if approval_results:
        # Verarbeitete Freigabe-Antworten als gesehen markieren (kein Doppelversand).
        handled = {r["token"] for r in approval_results}
        print(f"Freigabe-Antworten verarbeitet: {approval_results}")
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `python3 -m pytest test_watcher_approvals.py test_approval_queue.py test_approval_parse.py -v`
Expected: PASS (alle grün)

- [ ] **Step 7: Smoke-test the watcher dry-run**

Run: `python3 watcher.py --dry-run --ignore-hours`
Expected: läuft ohne Traceback, gibt „Freigabe-Antworten verarbeitet"/„Keine neuen Mails" o.ä. aus.

- [ ] **Step 8: Commit**

```bash
git -C "$HOME/Library/CloudStorage/SynologyDrive-Mac/Claude Code MAC/Paperclip" commit --allow-empty -m "feat(luna): Watcher verarbeitet Freigaben (send/correction/TTL)"
```

---

### Task 6: SMTP Relay V16 — Guard öffnen + Reply-To

**Files:**
- Modify (n8n): Workflow `SMTP Relay V15 — nur ws@ (gmail gestrichen)` → Kopie `SMTP Relay V16 — Office Freigabe-gated`.
- Create: `~/.paperclip/scripts/sekretaerin-mail-watcher/test_relay_guard.mjs` (Node-Unit-Test der Guard-Logik)

**Interfaces:**
- Consumes: Approval-Secret aus Task 4 (`~/.paperclip/state/luna-approval-secret`, gleicher Wert).

- [ ] **Step 1: Unit-test the guard logic in isolation (Node)**

`test_relay_guard.mjs` — repliziert nur die Guard-Entscheidung, damit die Logik testbar ist, bevor sie in n8n landet:

```javascript
// test_relay_guard.mjs  —  node test_relay_guard.mjs
import assert from 'node:assert';

const APPROVAL_SECRET = 'TEST-SECRET';
function guard({from, addrs, approval}) {
  if (from === 'office@whitestag.ai') {
    const onlyWalter = addrs.length > 0 && addrs.every(a => a === 'ws@whitestag.ai');
    const approved = approval && approval === APPROVAL_SECRET;
    if (!onlyWalter && !approved) return 'reject';
  }
  return 'ok';
}

assert.equal(guard({from:'office@whitestag.ai', addrs:['ws@whitestag.ai'], approval:''}), 'ok');            // Draft an Walter
assert.equal(guard({from:'office@whitestag.ai', addrs:['k@example.de'], approval:''}), 'reject');           // extern ohne Freigabe
assert.equal(guard({from:'office@whitestag.ai', addrs:['k@example.de'], approval:'WRONG'}), 'reject');      // falsches Secret
assert.equal(guard({from:'office@whitestag.ai', addrs:['k@example.de'], approval:'TEST-SECRET'}), 'ok');    // Freigabe gültig
console.log('relay guard: alle 4 Fälle ok');
```

Run: `node ~/.paperclip/scripts/sekretaerin-mail-watcher/test_relay_guard.mjs`
Expected: `relay guard: alle 4 Fälle ok`

- [ ] **Step 2: Export V15, copy to V16**

```bash
cd ~/.n8n
sqlite3 database.sqlite "SELECT id FROM workflow_entity WHERE name='SMTP Relay V15 — nur ws@ (gmail gestrichen)';"
# Über die n8n-API/GUI V15 duplizieren und in "SMTP Relay V16 — Office Freigabe-gated" umbenennen.
# (Kein direktes DB-Schreiben; n8n-REST duplicate oder GUI "Duplicate".)
```

- [ ] **Step 3: Edit the `Validate Request` Code-Node in V16**

Den Office-Block der Aussen-Sperre ersetzen. Suche in V16 `Validate Request`:

```js
  if (from === 'office@whitestag.ai') {
    const ok = addrs.length > 0 && addrs.every(a => a === 'ws@whitestag.ai');
    if (!ok) return reject('Phase-2-Sperre: office@ (Luna) darf ausschliesslich an ws@whitestag.ai senden. Blockiert: to=' + to + (cc ? ' cc=' + cc : ''));
  } else {
```

ersetzen durch (Secret-Wert aus `~/.paperclip/state/luna-approval-secret` einsetzen):

```js
  if (from === 'office@whitestag.ai') {
    const APPROVAL_SECRET = 'luna-approval-XXXXXXXX';  // == ~/.paperclip/state/luna-approval-secret
    const approval = String(body.approval || '').trim();
    const onlyWalter = addrs.length > 0 && addrs.every(a => a === 'ws@whitestag.ai');
    const approved = approval.length > 0 && approval === APPROVAL_SECRET;
    if (!onlyWalter && !approved) {
      return reject('Phase-3-Gate: office@ (Luna) an Externe nur mit gueltiger Freigabe. Blockiert: to=' + to + (cc ? ' cc=' + cc : ''));
    }
  } else {
```

- [ ] **Step 4: Add `replyTo` to the outgoing office@ mail**

Im Node `SMTP Send Office` (V16) die Option `Reply To` = `ws@whitestag.ai` setzen (oder `={{$json.replyTo || 'ws@whitestag.ai'}}`). Falls Threading unterstützt: `In-Reply-To`-Header aus `{{$json.inReplyTo}}` ergänzen (best effort; Reply-To ist die harte Anforderung).

- [ ] **Step 5: Publish V16 cleanly + verify active version**

```bash
# Per n8n-REST: deactivate -> activate (Hausregel), danach:
cd ~/.n8n
sqlite3 database.sqlite "SELECT name, active, versionId, (SELECT activeVersionId FROM workflow_entity w2 WHERE w2.id=w.id) AS activeVersionId FROM workflow_entity w WHERE name='SMTP Relay V16 — Office Freigabe-gated';"
# Erwartung: active=1 und activeVersionId == versionId
```

- [ ] **Step 6: Integration-verify the gate with curl**

```bash
SECRET=$(cat ~/.paperclip/state/luna-approval-secret)
WH=http://localhost:5678/webhook/mailhub/send
HDR='X-Mailhub-Secret: mailhub-812a27b07c73e64d7df192c98a3883eb'

# 6a) office@ -> ws@ ohne approval  => 200 (unverändert erlaubt)
curl -s -o /dev/null -w "6a=%{http_code}\n" -X POST "$WH" -H "$HDR" -H 'Content-Type: application/json' \
  -d '{"from":"office@whitestag.ai","to":"ws@whitestag.ai","subject":"gate-test 6a","text":"x"}'

# 6b) office@ -> extern OHNE approval  => 400 (blockiert)
curl -s -o /dev/null -w "6b=%{http_code}\n" -X POST "$WH" -H "$HDR" -H 'Content-Type: application/json' \
  -d '{"from":"office@whitestag.ai","to":"gate-test@example.com","subject":"gate-test 6b","text":"x"}'

# 6c) office@ -> extern mit FALSCHEM approval  => 400
curl -s -o /dev/null -w "6c=%{http_code}\n" -X POST "$WH" -H "$HDR" -H 'Content-Type: application/json' \
  -d '{"from":"office@whitestag.ai","to":"gate-test@example.com","subject":"gate-test 6c","text":"x","approval":"WRONG"}'

# 6d) office@ -> eine dir gehörende externe Test-Adresse mit KORREKTEM approval => 200 (sendet 1 echte Testmail)
curl -s -o /dev/null -w "6d=%{http_code}\n" -X POST "$WH" -H "$HDR" -H 'Content-Type: application/json' \
  -d "{\"from\":\"office@whitestag.ai\",\"to\":\"DEINE-EXTERNE-TESTADRESSE\",\"subject\":\"gate-test 6d\",\"text\":\"Vier-Augen-Gate live\",\"approval\":\"$SECRET\",\"replyTo\":\"ws@whitestag.ai\"}"
```

Expected: `6a=200`, `6b=400`, `6c=400`, `6d=200`. Bei 6d prüfen, dass die Testmail `Reply-To: ws@whitestag.ai` trägt.

- [ ] **Step 7: Copy V16 export to central n8n Workflows folder + commit**

```bash
# V16 als JSON exportieren (GUI/REST) nach:
#   ~/Library/CloudStorage/SynologyDrive-Mac/Claude Code MAC/n8n Workflows/SMTP Relay V16.json
git -C "$HOME/Library/CloudStorage/SynologyDrive-Mac/Claude Code MAC/Paperclip" add . 2>/dev/null || true
git -C "$HOME/Library/CloudStorage/SynologyDrive-Mac/Claude Code MAC/Paperclip" commit --allow-empty -m "feat(relay): SMTP Relay V16 — office@ Freigabe-gated + Reply-To ws@"
```

---

### Task 7: Luna-Rolle auf „Phase 3, Okay-gated" + AGENTS.md-Regen

**Files:**
- Modify: `/Users/walterschoenenbroecher.de/.paperclip/scripts/agents-instructions/roles/sekret-rin.role.md`
- Modify: `watcher.py` — `build_description()` + Titel (kein Triage-Übersichts-Output mehr).

- [ ] **Step 1: Rewrite the hard-block + phase section in `sekret-rin.role.md`**

Ersetze den Abschnitt „⛔ HARTE SPERRE" durch die Freigabe-gated-Regel:

```markdown
## ⛔ HARTE REGEL: Versand nur nach Walters „Okay" (Vier-Augen)

Du sendest **niemals** direkt an einen externen Empfänger. Für jede Antwort, die
rausgehen soll, legst du einen **Freigabe-Entwurf** an — genau **ein** Skript:

    bin/luna-queue-approval.py --area {AI|FILM|SORBART} --to <kunde> \
      --subject "<Betreff>" --body /tmp/entwurf.md --original-file "<Vault-Dateiname>"

Das Skript rendert die finale Mail, legt sie in die Freigabe-Queue und schickt
Walter eine Freigabe-Mail. **Du rufst den Mailhub-Webhook nie direkt auf**, kein
`--mode direct`, kein eigenes `curl`, kein Nachbau. Den eigentlichen Versand an
den Kunden macht **nach Walters „Okay"** ein deterministischer Watcher — nicht du.

- Antwortet Walter mit **„Okay"**, geht dein Entwurf **unverändert** raus.
- Antwortet er mit einer **Korrektur**, weckt dich der Watcher mit einem
  „Korrektur Entwurf #…"-Issue. Überarbeite den Entwurf und lege mit
  `luna-queue-approval.py` **neu** vor (neuer Token).

Du kennst das Approval-Secret nicht und brauchst es nicht — der Relay lässt ohne
gültige Freigabe kein Byte an Externe durch.
```

- [ ] **Step 2: Remove the triage-summary duty from the role**

Suche den Abschnitt, der Triage-Übersichts- und Entwurfs-Mails via `send-walter-report.sh` beschreibt (Schattenbetrieb), und ersetze die Anweisung „Antwort-Entwürfe als eigene Mail an Walter via send-walter-report.sh" durch: „Antwort-Entwürfe **ausschließlich** über `bin/luna-queue-approval.py` (Freigabe-Weg). **Keine Triage-Übersichtsmail an Walter** mehr — die Original-Mails liegen in seinem Postfach." `send-walter-report.sh` bleibt nur für echte Walter-Issue-Ergebnis-Reports.

- [ ] **Step 3: Update `watcher.py` `build_description()` + issue title**

`build_description` neu (kein Triage-Tabellen-/Übersichts-Output; pro Mail ein Freigabe-Entwurf):

```python
def build_description(new: list[str], capped: int) -> str:
    lines = "\n".join(f"- `{n}`" for n in new)
    extra = (f"\n\n**Hinweis:** {capped} weitere Dateien auf das Limit von "
             f"{MAX_PER_ISSUE} gekürzt — kommen im nächsten Lauf.") if capped else ""
    return f"""## Auftrag

Neue ws@-Mails im Vault. Bearbeite **genau diese {len(new)} Datei(en)** aus `{MAILDIR}/`:

{lines}{extra}

## Vorgehen (Vier-Augen)

1. Klassifiziere jede Mail (spam / fyi / actionable / unklar). Spam→`cancelled`,
   FYI→still archivieren (kein Report an Walter). **Keine Triage-Übersichtsmail.**
2. Für jede `actionable`/`unklar`-Mail: formuliere die Antwort und lege sie zur
   **Freigabe** vor — genau ein Skript:
   `bin/luna-queue-approval.py --area <AI|FILM|SORBART> --to <Absender> \\
     --subject "AW: <Betreff>" --body /tmp/entwurf.md --original-file "<Dateiname>"`
   Du sendest NIE selbst an Externe. Walters „Okay" löst den Versand aus.
3. Störung (Sync tot, Workflow-Fehler)? Subtask an den CTO.
4. Abschluss: Issue auf `in_review`, `assigneeUserId` =
   `18r34Ghx5N0LHRptMCT6Fp1WaoGqhvc9`, `assigneeAgentId` = null. Nicht `done`.
"""
```

Titel + In-Flight-Check von „Mail-Triage" auf „Neue Mails" umstellen:
- In `main()`: `title = f"Neue Mails: {len(batch)} — Antwort-Entwürfe — {datetime.now():%Y-%m-%d %H:%M}"`
- In `_triage_in_flight()`: `startswith("Neue Mails")` statt `startswith("Mail-Triage")`.

- [ ] **Step 4: Regenerate AGENTS.md**

```bash
cd ~/.paperclip/scripts/agents-instructions
ls *.py *.sh 2>/dev/null   # Generator-Einstieg finden (z.B. generate.py / build.sh)
# Generator ausführen, damit sekret-rin.role.md in Lunas AGENTS.md landet.
# Danach prüfen, dass die Vier-Augen-Regel in der generierten AGENTS.md steht:
grep -l "luna-queue-approval" $(find .. -name AGENTS.md -path "*e24b8d9d*") 2>/dev/null
```

- [ ] **Step 5: Verify watcher still runs + commit**

Run: `cd ~/.paperclip/scripts/sekretaerin-mail-watcher && python3 -m pytest -v && python3 watcher.py --dry-run --ignore-hours`
Expected: Tests grün, Dry-Run ohne Traceback.

```bash
git -C "$HOME/Library/CloudStorage/SynologyDrive-Mac/Claude Code MAC/Paperclip" commit --allow-empty -m "feat(luna): Rolle Phase-3 Okay-gated + Watcher-Auftrag ohne Triage-Mails"
```

---

### Task 8: Sicherheitsnetz — office@-Inbound leitet echte Kundenantworten weiter (optional, zuletzt)

**Files:**
- Modify (n8n): `Mailhub V7 — Inbound`, Node `Allowlist + Auth Filter` / `IMAP Office`.

- [ ] **Step 1: Add forward rule**

Im Node, der office@-Eingänge zu Paperclip-Issues macht: echte Kundenantworten (kein Bot/Newsletter, `from` nicht in Agent-/Noreply-Liste) zusätzlich an `ws@whitestag.ai` weiterleiten bzw. das erzeugte Issue mit „⚠️ Kundenantwort landete an office@ statt ws@" markieren, damit Walter es sieht. Kein neuer Workflow.

- [ ] **Step 2: Verify + commit**

Testmail an `office@` mit Kunden-artigem Absender → landet als markiertes Issue / Weiterleitung bei Walter.

```bash
git -C "$HOME/Library/CloudStorage/SynologyDrive-Mac/Claude Code MAC/Paperclip" commit --allow-empty -m "feat(mailhub): office@-Inbound leitet echte Kundenantworten an ws@"
```

---

### Task 9: End-to-End-Schattenlauf (manuelle Verifikation)

**Files:** keine.

- [ ] **Step 1: Provoke a draft**

Eine echte, unkritische Kundenmail im Vault auswählen. Luna (oder manuell) `luna-queue-approval.py` mit einer Test-Antwort an eine **dir gehörende externe Adresse** aufrufen.
Verifizieren: Queue-Eintrag `pending` unter `~/.paperclip/state/luna-approvals/`, Freigabe-Mail „[Freigabe #…]" bei Walter.

- [ ] **Step 2: Approve**

Auf die Freigabe-Mail mit **„Okay"** antworten. Warten, bis der Sync die Antwort in den Vault legt (≤5 Min), dann `python3 watcher.py --ignore-hours` laufen lassen.
Verifizieren: Testmail kommt an der externen Adresse an, `Reply-To: ws@`, Queue-Eintrag `status=sent`.

- [ ] **Step 3: Correction round**

Neuen Entwurf anlegen, diesmal mit „Bitte förmlicher" antworten. Watcher laufen lassen.
Verifizieren: **kein** Versand, `status=superseded`, „Korrektur Entwurf #…"-Issue bei Luna.

- [ ] **Step 4: Final commit / Feierabend-Doku**

```bash
git -C "$HOME/Library/CloudStorage/SynologyDrive-Mac/Claude Code MAC/Paperclip" commit --allow-empty -m "chore(luna): Vier-Augen-System end-to-end verifiziert"
```

---

## Self-Review (Autor)

- **Spec-Abdeckung:** Triage-Mails weg → T5/T7. Read-only → unverändert (kein Schreibpfad ergänzt). Entwurf-statt-Triage → T3/T7. „Okay"-Riegel exakt → T2. Korrektur→Neu-Entwurf → T5/T7. office@ + Reply-To:ws@ → T6. Relay als Choke-Point → T6. Queue/verbatim → T1/T4. TTL 7d → T1/T5. Fail-safe → T2. Sicherheitsnetz → T8. Alle Spec-Abschnitte haben eine Task.
- **Platzhalter:** die zwei bewusst markierten Zwischenstände (`isolate_reply` toter `any(...)`; `if False else` in `luna-queue-approval`) sind mit expliziten Umsetzer-Hinweisen + klarer Ersatzfassung versehen — kein offener Platzhalter.
- **Typ-Konsistenz:** `create/load/mark/save/list_pending/expire_stale` (T1) durchgängig genutzt in T3/T4/T5. `send_approved(entry)`-Signatur (T4) == Aufruf in T5. `extract_token/classify/isolate_reply` (T2) == Nutzung in T5. `render_customer_html(area, body_md)` (T3) == Nutzung in `luna-queue-approval`.
