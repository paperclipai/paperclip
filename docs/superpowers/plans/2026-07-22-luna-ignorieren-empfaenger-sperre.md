# „Ignorieren" → Empfänger-Sperre für Luna — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Walters Antwort „Ignorieren" auf eine Luna-Freigabe-Mail verwirft den Entwurf und setzt den Empfänger auf eine dauerhafte Blockliste, die deterministisch die Triage filtert; entsperren per Mail-Kommando.

**Architecture:** Neuer Blocklist-Store (`blocklist.py`, JSON-State). `approval_parse.classify()` bekommt dritten Ausgang `ignore`. `watcher._apply_reply()` verzweigt bei `ignore` auf Blocklist-Eintrag + Queue-Status `ignored` (kein Versand, kein Issue, still). `watcher.scan()` filtert geblockte Absender wie heute Agenten-Mails. Entsperren über neue office@-Kommando-Schiene (`office_inbox.fetch_unblock_commands` + `watcher.process_unblock_commands`).

**Tech Stack:** Python 3 stdlib (json, re, imaplib, unittest), keine neuen Dependencies. Alle Module in `tools/sekretaerin-mail-watcher/` (flach, kein Package). Tests via `python3 -m pytest` bzw. `python3 -m unittest`.

## Global Constraints

- Arbeitsverzeichnis für alle Befehle: `tools/sekretaerin-mail-watcher/` (Module liegen flach, Import ohne Package-Präfix: `import blocklist`).
- Deterministisch, kein LLM: alle Sperr-/Entsperr-Entscheidungen sind reiner Code.
- **Fail-open** bei unlesbarer Blocklist: `load()` → leere Menge (im Zweifel triagieren, nie Kundenpost verschlucken).
- Atomarer Datei-Write überall: `tmp`→`replace` (Muster aus `approval_queue.save`).
- State-Verzeichnis: `~/.paperclip/state/` — Datei `luna-blocklist.json`.
- Adress-Normalisierung überall identisch: `strip().lower()`; Match = exakte Adresse.
- Adress-Regex überall identisch: `r"[\w.+-]+@[\w-]+\.[\w.-]+"`.
- Sperren geschieht **stillschweigend** (keine Bestätigungsmail). Entsperren ebenso.
- Deploy nach `~/.paperclip/scripts/sekretaerin-mail-watcher/` erst nach grüner Suite (letzte Task).

---

### Task 1: Blocklist-Store

**Files:**
- Create: `tools/sekretaerin-mail-watcher/blocklist.py`
- Test: `tools/sekretaerin-mail-watcher/test_blocklist.py`

**Interfaces:**
- Consumes: nichts.
- Produces: `blocklist.STATE: Path`; `blocklist.is_blocked(addr: str) -> bool`; `blocklist.add(addr: str) -> None`; `blocklist.remove(addr: str) -> None`; `blocklist.load() -> set[str]` (normalisierte Adressen). Alle idempotent, fail-open.

- [ ] **Step 1: Write the failing test**

```python
# test_blocklist.py
import unittest, tempfile
from pathlib import Path
import blocklist as bl


class BlocklistTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        bl.STATE = Path(self.tmp.name) / "luna-blocklist.json"

    def tearDown(self):
        self.tmp.cleanup()

    def test_add_then_blocked(self):
        bl.add("Kunde@Example.com")
        self.assertTrue(bl.is_blocked("kunde@example.com"))
        self.assertTrue(bl.is_blocked("  KUNDE@EXAMPLE.COM  "))

    def test_unknown_not_blocked(self):
        self.assertFalse(bl.is_blocked("fremd@x.de"))

    def test_add_is_idempotent(self):
        bl.add("a@x.de")
        bl.add("a@x.de")
        self.assertEqual(bl.load(), {"a@x.de"})

    def test_remove(self):
        bl.add("a@x.de")
        bl.remove("A@X.DE")
        self.assertFalse(bl.is_blocked("a@x.de"))
        self.assertEqual(bl.load(), set())

    def test_remove_absent_is_noop(self):
        bl.remove("nope@x.de")  # darf nicht werfen
        self.assertEqual(bl.load(), set())

    def test_empty_address_ignored(self):
        bl.add("   ")
        self.assertEqual(bl.load(), set())

    def test_fail_open_on_corrupt_file(self):
        bl.STATE.parent.mkdir(parents=True, exist_ok=True)
        bl.STATE.write_text("{ kaputt", encoding="utf-8")
        self.assertEqual(bl.load(), set())          # kein Crash
        self.assertFalse(bl.is_blocked("a@x.de"))

    def test_missing_file_is_empty(self):
        self.assertEqual(bl.load(), set())


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/sekretaerin-mail-watcher && python3 -m pytest test_blocklist.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'blocklist'`

- [ ] **Step 3: Write minimal implementation**

```python
# blocklist.py
"""Dauerhafte Empfänger-Sperrliste für Luna (eine JSON-Datei, exakte Adressen).

'Ignorieren' auf eine Freigabe-Mail setzt den Empfänger hierauf; watcher.scan()
filtert gesperrte Absender aus der Triage. Fail-open: unlesbare/fehlende Datei →
niemand gesperrt (im Zweifel triagieren, nie Kundenpost verschlucken)."""
from __future__ import annotations
import json
from datetime import datetime
from pathlib import Path

STATE = Path.home() / ".paperclip" / "state" / "luna-blocklist.json"


def _normalize(addr: str) -> str:
    return (addr or "").strip().lower()


def load() -> set[str]:
    if not STATE.exists():
        return set()
    try:
        raw = json.loads(STATE.read_text(encoding="utf-8")).get("blocked", [])
        return {_normalize(a) for a in raw if a and _normalize(a)}
    except (json.JSONDecodeError, OSError):
        return set()  # fail-open


def _save(blocked: set[str]) -> None:
    STATE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps({"blocked": sorted(blocked),
                               "updated": datetime.now().isoformat()},
                              ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(STATE)


def is_blocked(addr: str) -> bool:
    return _normalize(addr) in load()


def add(addr: str) -> None:
    a = _normalize(addr)
    if not a:
        return
    blocked = load()
    if a not in blocked:
        blocked.add(a)
        _save(blocked)


def remove(addr: str) -> None:
    a = _normalize(addr)
    blocked = load()
    if a in blocked:
        blocked.discard(a)
        _save(blocked)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/sekretaerin-mail-watcher && python3 -m pytest test_blocklist.py -q`
Expected: PASS (8 passed)

- [ ] **Step 5: Commit**

```bash
git add tools/sekretaerin-mail-watcher/blocklist.py tools/sekretaerin-mail-watcher/test_blocklist.py
git commit -m "feat(sekretaerin): Blocklist-Store für Empfänger-Sperre (fail-open)"
```

---

### Task 2: Klassifikation `ignore`

**Files:**
- Modify: `tools/sekretaerin-mail-watcher/approval_parse.py:39-45` (`classify`)
- Test: `tools/sekretaerin-mail-watcher/test_approval_parse.py` (erweitern)

**Interfaces:**
- Consumes: bestehende `isolate_reply`, `normalize`.
- Produces: `approval_parse.classify(body: str) -> str` liefert jetzt `"send" | "ignore" | "correction"`.

- [ ] **Step 1: Write the failing test** (an `ClassifyTest` in `test_approval_parse.py` anhängen)

```python
    def test_bare_ignorieren_is_ignore(self):
        self.assertEqual(ap.classify("Ignorieren"), "ignore")
        self.assertEqual(ap.classify("ignorieren"), "ignore")
        self.assertEqual(ap.classify("  Ignorieren.  "), "ignore")
        self.assertEqual(ap.classify("IGNORIEREN!"), "ignore")

    def test_ignorieren_with_quote_is_ignore(self):
        body = ("Ignorieren\n\n"
                "> Am 22.07.2026 schrieb office@whitestag.ai:\n"
                "> [Freigabe #A7X3] Entwurf …")
        self.assertEqual(ap.classify(body), "ignore")

    def test_mixed_ignorieren_is_correction(self):
        for txt in ["okay ignorieren", "ignorieren bitte", "bitte ignorieren",
                    "ignoriere das", "ignore"]:
            self.assertEqual(ap.classify(txt), "correction", msg=repr(txt))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/sekretaerin-mail-watcher && python3 -m pytest test_approval_parse.py -q`
Expected: FAIL — `test_bare_ignorieren_is_ignore` erwartet `"ignore"`, bekommt `"correction"`.

- [ ] **Step 3: Write minimal implementation** — `classify` in `approval_parse.py` ersetzen:

```python
def classify(body: str) -> str:
    top = isolate_reply(body)
    if not top:
        return "correction"
    # Nur wenn der GESAMTE oberste Block (ohne Leerzeilen) exakt das Kommando ist.
    compact = " ".join(l for l in top.split("\n") if l.strip()).strip()
    norm = normalize(compact)
    if norm == "okay":
        return "send"
    if norm == "ignorieren":
        return "ignore"
    return "correction"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/sekretaerin-mail-watcher && python3 -m pytest test_approval_parse.py -q`
Expected: PASS (alle, inkl. der bestehenden okay/correction-Fälle)

- [ ] **Step 5: Commit**

```bash
git add tools/sekretaerin-mail-watcher/approval_parse.py tools/sekretaerin-mail-watcher/test_approval_parse.py
git commit -m "feat(sekretaerin): classify() erkennt 'Ignorieren' als dritten Ausgang"
```

---

### Task 3: `_apply_reply` ignore-Zweig + terminal-Menge

**Files:**
- Modify: `tools/sekretaerin-mail-watcher/watcher.py:24-29` (Import `blocklist`), `:160-190` (`_apply_reply`), `:394` (terminal-Menge in `main`)
- Test: `tools/sekretaerin-mail-watcher/test_watcher_approvals.py` (erweitern)

**Interfaces:**
- Consumes: `blocklist.add` (Task 1), `approval_parse.classify` (Task 2), bestehende `approval_queue.mark`.
- Produces: `_apply_reply(...)` liefert neue Actions `"ignored"` (terminal) und `"would-ignore"` (dry_run). Queue-Status `"ignored"`.

- [ ] **Step 1: Write the failing test** (neue Testmethoden an `ApprovalScanTest` anhängen; `MAIL_IGNORE`-Konstante oben bei den anderen MAIL_*-Konstanten ergänzen)

```python
MAIL_IGNORE = """---
von: w.schonenbrocher@whitestag.ai
subject: AW: [Freigabe #A7X3] AW: Textkorrektur → an k@x.de
---
Ignorieren
"""
```

```python
    def test_ignore_blocks_recipient_no_send_no_issue(self):
        import blocklist as bl
        bl.STATE = self.dir / "luna-blocklist.json"
        self._write("2026-07-22-ign-w.schonenbrocher.md", MAIL_IGNORE)
        r = w.process_approvals(
            ["2026-07-22-ign-w.schonenbrocher.md"], dry_run=False,
            send=lambda *a, **k: (_ for _ in ()).throw(AssertionError("darf nicht senden")),
            make_issue=lambda *a, **k: (_ for _ in ()).throw(AssertionError("kein Issue")))
        self.assertEqual(r[0]["action"], "ignored")
        self.assertEqual(q.load("A7X3")["status"], "ignored")
        self.assertTrue(bl.is_blocked("k@x.de"))

    def test_ignore_dry_run_would_ignore_no_write(self):
        import blocklist as bl
        bl.STATE = self.dir / "luna-blocklist.json"
        self._write("2026-07-22-igndry-w.schonenbrocher.md", MAIL_IGNORE)
        r = w.process_approvals(["2026-07-22-igndry-w.schonenbrocher.md"], dry_run=True,
                                send=lambda *a, **k: (200, "ok"), make_issue=lambda *a, **k: None)
        self.assertEqual(r[0]["action"], "would-ignore")
        self.assertEqual(q.load("A7X3")["status"], "pending")  # nichts verändert
        self.assertFalse(bl.is_blocked("k@x.de"))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/sekretaerin-mail-watcher && python3 -m pytest test_watcher_approvals.py -q -k ignore`
Expected: FAIL — Action ist `"correction"` (Issue-Lambda wirft `AssertionError`), nicht `"ignored"`.

- [ ] **Step 3a: Import ergänzen** — nach `import approval_send as approval_send  # noqa: E402` (watcher.py:27) einfügen:

```python
import blocklist as blocklist  # noqa: E402
```

- [ ] **Step 3b: `_apply_reply` umbauen** — den Block ab `if approval_parse.classify(body) == "send":` (watcher.py:169) bis `return "correction"` (:190) ersetzen durch:

```python
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
```

- [ ] **Step 3c: terminal-Menge erweitern** — in `main()` die Zeile `terminal = {"sent", "correction", "skip"}` (watcher.py:394) ersetzen durch:

```python
            terminal = {"sent", "correction", "skip", "ignored"}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tools/sekretaerin-mail-watcher && python3 -m pytest test_watcher_approvals.py -q`
Expected: PASS (bestehende + zwei neue ignore-Tests)

- [ ] **Step 5: Commit**

```bash
git add tools/sekretaerin-mail-watcher/watcher.py tools/sekretaerin-mail-watcher/test_watcher_approvals.py
git commit -m "feat(sekretaerin): _apply_reply ignore-Zweig — Empfänger sperren, still, terminal"
```

---

### Task 4: Scan-Filter für geblockte Absender

**Files:**
- Modify: `tools/sekretaerin-mail-watcher/watcher.py:14-21` (Import `re`), `:273-288` (`scan`), neuer Helper `_is_blocked_sender`
- Test: `tools/sekretaerin-mail-watcher/test_watcher_approvals.py` (erweitern)

**Interfaces:**
- Consumes: `blocklist.load` (Task 1).
- Produces: `_is_blocked_sender(path: Path, blocked: set[str] | None = None) -> bool`; `scan()` überspringt geblockte Absender.

- [ ] **Step 1: Write the failing test** (an `ApprovalScanTest` anhängen)

```python
    def test_scan_skips_blocked_sender(self):
        import blocklist as bl
        bl.STATE = self.dir / "luna-blocklist.json"
        bl.add("spam@x.de")
        mail = ("---\nvon: Spam Meier <spam@x.de>\n"
                "subject: Angebot\n---\n\nKaufen Sie jetzt!\n")
        self._write("2026-07-22-spam-eingang.md", mail)
        self.assertNotIn("2026-07-22-spam-eingang.md", w.scan(3))

    def test_scan_keeps_unblocked_sender(self):
        import blocklist as bl
        bl.STATE = self.dir / "luna-blocklist.json"  # leere Blocklist
        mail = ("---\nvon: Echt Kunde <kunde@x.de>\n"
                "subject: Anfrage\n---\n\nHallo Luna\n")
        self._write("2026-07-22-echt-eingang.md", mail)
        self.assertIn("2026-07-22-echt-eingang.md", w.scan(3))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/sekretaerin-mail-watcher && python3 -m pytest test_watcher_approvals.py -q -k blocked`
Expected: FAIL — `test_scan_skips_blocked_sender`: die Datei ist in `scan(3)` enthalten (kein Filter).

- [ ] **Step 3a: Import `re` ergänzen** — im Import-Block oben (watcher.py, bei `import os` / `import sys`) hinzufügen:

```python
import re
```

- [ ] **Step 3b: Helper `_is_blocked_sender` einfügen** — direkt nach `_is_agent_mail` (nach watcher.py:114):

```python
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
```

- [ ] **Step 3c: `scan()` erweitern** — die Schleife in `scan` (watcher.py:280-287) so anpassen, dass die Blocklist einmal geladen und geprüft wird:

```python
    cutoff = str(date.today() - timedelta(days=window))
    blocked = blocklist.load()
    out = []
    for p in sorted(MAILDIR.glob("*.md")):
        if p.name[:10] < cutoff:
            continue
        if _is_agent_mail(p):
            continue
        if _is_blocked_sender(p, blocked):
            continue
        if is_approval_reply(p):
            continue
        out.append(p.name)
    return out
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tools/sekretaerin-mail-watcher && python3 -m pytest test_watcher_approvals.py -q`
Expected: PASS (inkl. beider neuer scan-Tests)

- [ ] **Step 5: Commit**

```bash
git add tools/sekretaerin-mail-watcher/watcher.py tools/sekretaerin-mail-watcher/test_watcher_approvals.py
git commit -m "feat(sekretaerin): scan() filtert geblockte Absender aus der Triage"
```

---

### Task 5: Entsperr-Kommando aus office@ lesen

**Files:**
- Modify: `tools/sekretaerin-mail-watcher/office_inbox.py` (neue `UNBLOCK_STATE`, `load_processed_unblock`, `save_processed_unblock`, `_parse_unblock`, `fetch_unblock_commands`)
- Test: `tools/sekretaerin-mail-watcher/test_office_inbox.py` (erweitern)

**Interfaces:**
- Consumes: bestehende `office_inbox._decode`, `_body_text`, `load_creds`, `WALTER_MARKERS`, `FakeImap` (Test).
- Produces: `office_inbox.fetch_unblock_commands(processed: set[str], *, imap=None) -> list[dict]` mit `{uid, addr}`; `office_inbox.load_processed_unblock() -> set[str]`; `office_inbox.save_processed_unblock(uids: set[str]) -> None`; `office_inbox._parse_unblock(subject: str, body: str) -> str | None`.

- [ ] **Step 1: Write the failing test** (neue Testklasse in `test_office_inbox.py`)

```python
class UnblockTest(unittest.TestCase):
    def test_parse_from_subject(self):
        self.assertEqual(oi._parse_unblock("Entsperren Kunde@X.de", ""), "kunde@x.de")

    def test_parse_from_first_body_line(self):
        self.assertEqual(oi._parse_unblock("RE: irgendwas", "Entsperren a@b.de\nrest"),
                         "a@b.de")

    def test_parse_none_without_keyword(self):
        self.assertIsNone(oi._parse_unblock("Normale Mail", "Hallo a@b.de wie geht's"))

    def test_parse_none_without_address(self):
        self.assertIsNone(oi._parse_unblock("Entsperren bitte", ""))

    def test_fetch_filters_walter_and_command_and_processed(self):
        msgs = {
            "20": _raw("Walter <w.schonenbrocher@oubifb>", "Entsperren k@x.de", ""),
            "21": _raw("Fremd <x@y.de>", "Entsperren k@x.de", ""),          # nicht Walter
            "22": _raw("Walter <w.schonenbrocher@oubifb>", "RE: Hallo", "kein Kommando"),
            "23": _raw("Walter <w.schonenbrocher@oubifb>", "Entsperren alt@x.de", ""),  # processed
        }
        res = oi.fetch_unblock_commands({"23"}, imap=FakeImap(msgs))
        self.assertEqual([(r["uid"], r["addr"]) for r in res], [("20", "k@x.de")])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/sekretaerin-mail-watcher && python3 -m pytest test_office_inbox.py -q -k Unblock`
Expected: FAIL — `AttributeError: module 'office_inbox' has no attribute '_parse_unblock'`

- [ ] **Step 3: Implementation in `office_inbox.py` ergänzen** — nach den bestehenden `load_processed`/`save_processed` (nach office_inbox.py:131) einfügen:

```python
UNBLOCK_STATE = Path.home() / ".paperclip" / "state" / "office-unblock-uids.json"
_ADDR_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")


def load_processed_unblock() -> set[str]:
    if not UNBLOCK_STATE.exists():
        return set()
    try:
        return set(json.loads(UNBLOCK_STATE.read_text(encoding="utf-8")).get("uids", []))
    except (json.JSONDecodeError, OSError):
        return set()


def save_processed_unblock(uids: set[str]) -> None:
    UNBLOCK_STATE.parent.mkdir(parents=True, exist_ok=True)
    tmp = UNBLOCK_STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps({"uids": sorted(uids)[-500:]}, ensure_ascii=False), encoding="utf-8")
    tmp.replace(UNBLOCK_STATE)


def _parse_unblock(subject: str, body: str) -> str | None:
    """Adresse aus einem 'Entsperren <adresse>'-Kommando (Betreff ODER erste Body-Zeile)."""
    first_line = (body or "").split("\n", 1)[0]
    for src in (subject or "", first_line):
        s = src.strip()
        if s.lower().startswith("entsperren"):
            m = _ADDR_RE.search(s)
            if m:
                return m.group(0).lower()
    return None


def fetch_unblock_commands(processed: set[str], *, imap=None) -> list[dict]:
    """Walters 'Entsperren <adresse>'-Mails aus office@-INBOX, noch nicht bearbeitet.
    Liefert [{uid, addr}]. `imap` injizierbar für Tests."""
    host, user, pw = load_creds()
    M = imap or imaplib.IMAP4_SSL(host, 993)
    if imap is None:
        M.login(user, pw)
    M.select("INBOX")
    typ, data = M.uid("search", None, '(TEXT "Entsperren")')
    out: list[dict] = []
    for uid in data[0].split():
        uid_s = uid.decode() if isinstance(uid, bytes) else str(uid)
        if uid_s in processed:
            continue
        typ, dd = M.uid("fetch", uid, "(RFC822)")
        if not dd or not dd[0]:
            continue
        msg = message_from_bytes(dd[0][1])
        frm = _decode(msg.get("From", "")).lower()
        if not any(m in frm for m in WALTER_MARKERS):
            continue
        addr = _parse_unblock(_decode(msg.get("Subject", "")), _body_text(msg))
        if not addr:
            continue
        out.append({"uid": uid_s, "addr": addr})
    if imap is None:
        M.logout()
    return out
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tools/sekretaerin-mail-watcher && python3 -m pytest test_office_inbox.py -q`
Expected: PASS (bestehende + UnblockTest)

- [ ] **Step 5: Commit**

```bash
git add tools/sekretaerin-mail-watcher/office_inbox.py tools/sekretaerin-mail-watcher/test_office_inbox.py
git commit -m "feat(sekretaerin): office@-Kommando 'Entsperren <adresse>' lesen"
```

---

### Task 6: Entsperren im Watcher verdrahten

**Files:**
- Modify: `tools/sekretaerin-mail-watcher/watcher.py` (neue `process_unblock_commands`, Aufruf in `main` nach `process_office_approvals`)
- Test: `tools/sekretaerin-mail-watcher/test_watcher_approvals.py` (erweitern)

**Interfaces:**
- Consumes: `office_inbox.load_processed_unblock`, `office_inbox.fetch_unblock_commands`, `office_inbox.save_processed_unblock` (Task 5); `blocklist.remove` (Task 1).
- Produces: `watcher.process_unblock_commands(*, dry_run) -> list[dict]` mit `{uid, addr, action}` (`"unblocked"` | `"would-unblock"`).

- [ ] **Step 1: Write the failing test** (neue Testmethode an `ApprovalScanTest` anhängen; nutzt Monkeypatch von `office_inbox`)

```python
    def test_process_unblock_removes_from_blocklist(self):
        import blocklist as bl
        import office_inbox as oi
        bl.STATE = self.dir / "luna-blocklist.json"
        bl.add("weg@x.de")
        saved = {}
        oi.fetch_unblock_commands = lambda processed, **kw: [{"uid": "20", "addr": "weg@x.de"}]
        oi.load_processed_unblock = lambda: set()
        oi.save_processed_unblock = lambda uids: saved.update({"uids": set(uids)})
        r = w.process_unblock_commands(dry_run=False)
        self.assertEqual(r[0]["action"], "unblocked")
        self.assertEqual(r[0]["addr"], "weg@x.de")
        self.assertFalse(bl.is_blocked("weg@x.de"))
        self.assertIn("20", saved["uids"])

    def test_process_unblock_dry_run_keeps_block(self):
        import blocklist as bl
        import office_inbox as oi
        bl.STATE = self.dir / "luna-blocklist.json"
        bl.add("weg@x.de")
        oi.fetch_unblock_commands = lambda processed, **kw: [{"uid": "20", "addr": "weg@x.de"}]
        oi.load_processed_unblock = lambda: set()
        oi.save_processed_unblock = lambda uids: None
        r = w.process_unblock_commands(dry_run=True)
        self.assertEqual(r[0]["action"], "would-unblock")
        self.assertTrue(bl.is_blocked("weg@x.de"))  # unverändert
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/sekretaerin-mail-watcher && python3 -m pytest test_watcher_approvals.py -q -k unblock`
Expected: FAIL — `AttributeError: module 'watcher' has no attribute 'process_unblock_commands'`

- [ ] **Step 3a: `process_unblock_commands` einfügen** — direkt nach `process_office_approvals` (nach watcher.py:242):

```python
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
```

- [ ] **Step 3b: In `main()` verdrahten** — direkt nach dem `process_office_approvals`-Block (watcher.py:381-383, nach dem `if office_results:`-Print) einfügen:

```python
    unblock_results = process_unblock_commands(dry_run=a.dry_run)
    if unblock_results:
        print(f"Entsperr-Kommandos: {unblock_results}")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tools/sekretaerin-mail-watcher && python3 -m pytest test_watcher_approvals.py -q -k unblock`
Expected: PASS (beide unblock-Tests)

- [ ] **Step 5: Commit**

```bash
git add tools/sekretaerin-mail-watcher/watcher.py tools/sekretaerin-mail-watcher/test_watcher_approvals.py
git commit -m "feat(sekretaerin): process_unblock_commands + Verdrahtung in main()"
```

---

### Task 7: Volle Suite grün + Deploy

**Files:**
- Copy: `tools/sekretaerin-mail-watcher/blocklist.py`, `approval_parse.py`, `watcher.py`, `office_inbox.py` → `~/.paperclip/scripts/sekretaerin-mail-watcher/`

**Interfaces:**
- Consumes: alle vorigen Tasks.
- Produces: deployter Watcher inkl. Sperr-/Entsperr-Funktion; Live-Verzeichnis synchron mit Repo.

- [ ] **Step 1: Volle Test-Suite im Repo laufen**

Run: `cd tools/sekretaerin-mail-watcher && python3 -m pytest -q`
Expected: PASS (alle Tests, keine Fehler)

- [ ] **Step 2: Dry-Run des Watchers gegen echte State-Pfade (kein Schreiben)**

Run: `cd tools/sekretaerin-mail-watcher && python3 watcher.py --dry-run --ignore-hours`
Expected: läuft ohne Traceback durch (office@-Abruf ggf. WARN, das ist ok); keine Exception aus `blocklist`/`process_unblock_commands`.

- [ ] **Step 3: Geänderte/neue Module ins Live-Verzeichnis kopieren**

Run:
```bash
cd tools/sekretaerin-mail-watcher
cp blocklist.py approval_parse.py watcher.py office_inbox.py \
   ~/.paperclip/scripts/sekretaerin-mail-watcher/
```
Expected: keine Ausgabe (Erfolg).

- [ ] **Step 4: Deploy verifizieren — Import + Smoke im Live-Verzeichnis**

Run:
```bash
cd ~/.paperclip/scripts/sekretaerin-mail-watcher && \
python3 -c "import blocklist, approval_parse, watcher, office_inbox; \
print(approval_parse.classify('Ignorieren'))"
```
Expected: Ausgabe `ignore` (keine ImportError).

- [ ] **Step 5: Commit (Repo-Stand; Live-Verzeichnis ist außerhalb des Repos)**

```bash
cd "$(git rev-parse --show-toplevel)"
git add tools/sekretaerin-mail-watcher/
git commit -m "chore(sekretaerin): Ignorieren-Sperre deployt + volle Suite grün" --allow-empty
```

---

## Self-Review

**Spec coverage:**
- Blocklist-Store → Task 1 ✓
- Klassifikation `ignore` → Task 2 ✓
- `_apply_reply` ignore-Zweig (still, kein Send/Issue, terminal) → Task 3 ✓
- Scan-Filter deterministisch → Task 4 ✓
- Entsperren per Mail (office_inbox) → Task 5 ✓; Verdrahtung im Watcher → Task 6 ✓
- Fail-open → Task 1 (`load`), getestet ✓
- Deploy in beide Verzeichnisse → Task 7 ✓
- YAGNI (keine Domain-Wildcards, keine Bestätigungsmail, kein Listing) → nicht implementiert, wie spezifiziert ✓

**Placeholder scan:** keine TBD/TODO; jeder Code-Step zeigt vollständigen Code.

**Type consistency:** `blocklist.add/remove/is_blocked/load` konsistent über Tasks 1/3/4/6; `office_inbox.fetch_unblock_commands` liefert `{uid, addr}`, von `watcher.process_unblock_commands` so konsumiert; `_parse_unblock(subject, body)` konsistent Task 5. `classify` → `"send"|"ignore"|"correction"` konsistent Task 2/3. Adress-Regex `[\w.+-]+@[\w-]+\.[\w.-]+` identisch in watcher `_is_blocked_sender` und office_inbox `_ADDR_RE`.
