# Jarvis Rückkanal + Mehrmandanten — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Den live laufenden Jarvis-Bot bidirektional + mehrmandantenfähig machen: ID-basiertes Routing an die richtige Company/CEO, CEO-Events („Fertig", „Entscheidung benötigt") als Telegram-Push in den Chat des Mandanten, und Antwort per Reply (Sprache/Text) → Kommentar ans Issue.

**Architecture:** Ein erweiterter `bot.py`-Prozess: Long-Poll (25 s) + periodischer CEO-Event-Poll (≥60 s) je Mandant. Reine Logik (Mandanten-Auflösung, Event-Sammlung, Dedup) in kleinen stdlib-Modulen, testbar isoliert. „Entscheidung benötigt" wird vom CEO über das Label `entscheidung-noetig` markiert (strukturelles Signal) und vom Bot per `?labelId=` gepollt.

**Tech Stack:** Python 3 stdlib (urllib, json, subprocess, re, unittest), whisper.cpp, ffmpeg, Telegram Bot API, Paperclip REST, launchd.

## Global Constraints

- **Nur Python-Standardbibliothek**, Tests mit `unittest` + `unittest.mock`. Module aus dem Verzeichnis heraus importieren (`cd tools/voice-echo-bot`).
- **Baut auf bestehende Module** (`config.py`, `telegram_api.py`, `transcribe.py`, `paperclip_client.py`, `bot.py`) — bestehende Tests müssen grün bleiben.
- **Secrets/Config außerhalb Git:** `~/.paperclip/voice-echo-tenants.json` (existiert, 600), `~/.paperclip/voice-echo-state.json`, `~/.paperclip/voice-echo-bot.env`. Paperclip-Token aus `~/.paperclip/auth.json` (auto-renewt, erreicht beide Companies).
- **Fixe Werte (verbatim):**
  - Telegram-Bot ID `8757029765`; Tenants: Walter `8311805232` → WHITESTAG `9cebf3cf-efe8-4597-a400-f06488900a87` / CEO `506c873e-3a40-4483-9a45-0eb0fa1554bb`; Clara `1220010628` → Clara Sound `0e426844-309c-4528-9aa5-90ff76790a51` / Büroleitung `64ad7d03-ce64-46aa-ae79-d17ff26f5d4f`.
  - API base `http://127.0.0.1:3100/api`; Kommentar-Write `POST /issues/:id/comments` Body `{"body": <text>, "resume": true}`; Issue-Referenz-Feld = `identifier` (z. B. „WHI-2857"); Label-Filter `GET /companies/:id/issues?labelId=<id>`.
  - Decision-Label-Name: `entscheidung-noetig`. Poll-Intervall 60 s. Long-Poll-Timeout 25 s.
- **launchd-PATH-Falle:** Binaries in `transcribe.py` sind bereits absolut aufgelöst; nichts daran ändern.
- Commits ins Paperclip-Repo, Nachricht endet mit `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File Structure (alle in `tools/voice-echo-bot/`)
- `config.py` (erweitern) — Pfade `TENANTS_PATH`, `STATE_PATH`, Konstanten `DECISION_LABEL`, `POLL_INTERVAL_SEC`, `LONGPOLL_TIMEOUT_SEC`.
- `tenants.py` (neu) — `load_tenants`, `resolve_tenant`.
- `state.py` (neu) — `load_state`, `save_state` (atomar).
- `paperclip_client.py` (erweitern) — `list_issues`, `resolve_label_id`, `find_issue_by_identifier`, `add_comment`.
- `notifier.py` (neu) — `collect_events` (reine Logik: done + decision, Dedup gegen seen).
- `bot.py` (ersetzen) — Mehrmandanten-Gate, Reply→Kommentar, periodischer Poll + Pushes, Erststart-Suppression.
- Tests: `test_tenants.py`, `test_state.py`, `test_paperclip_client.py` (ergänzen), `test_notifier.py`, `test_bot.py` (ersetzen).
- Instruktion/Label (kein Repo-Code): Label in beiden Companies anlegen; CEO/Büroleitung-Rollen-Instruktion + AGENTS.md-Regenerierung.

---

### Task 1: config-Konstanten + tenants.py + state.py

**Files:** Create `tools/voice-echo-bot/tenants.py`, `tools/voice-echo-bot/state.py`, Tests `test_tenants.py`, `test_state.py`; Modify `tools/voice-echo-bot/config.py`.

**Interfaces — Produces:**
- config: `TENANTS_PATH`, `STATE_PATH` (expanduser), `DECISION_LABEL="entscheidung-noetig"`, `POLL_INTERVAL_SEC=60`, `LONGPOLL_TIMEOUT_SEC=25`.
- `tenants.load_tenants(path) -> dict`; `tenants.resolve_tenant(tenants, user_id) -> dict|None` (Key als `str(user_id)`).
- `state.load_state(path) -> set` (leer bei fehlender/korrupter Datei); `state.save_state(path, seen)` (atomar via `.tmp`+`os.replace`).

- [ ] **Step 1: Failing tests**

```python
# tools/voice-echo-bot/test_tenants.py
import json, os, tempfile, unittest
import tenants

class TestTenants(unittest.TestCase):
    def _f(self, obj):
        fd, p = tempfile.mkstemp(suffix=".json"); os.close(fd)
        open(p, "w").write(json.dumps(obj)); self.addCleanup(os.unlink, p); return p
    def test_resolve_by_int_and_str(self):
        t = tenants.load_tenants(self._f({"8311805232": {"company_id": "c", "ceo_agent_id": "a"}}))
        self.assertEqual(tenants.resolve_tenant(t, 8311805232)["company_id"], "c")
        self.assertEqual(tenants.resolve_tenant(t, "8311805232")["ceo_agent_id"], "a")
    def test_unknown_returns_none(self):
        self.assertIsNone(tenants.resolve_tenant({"1": {}}, 999))

if __name__ == "__main__": unittest.main()
```

```python
# tools/voice-echo-bot/test_state.py
import os, tempfile, unittest
import state

class TestState(unittest.TestCase):
    def test_missing_file_is_empty_set(self):
        self.assertEqual(state.load_state("/nonexistent/x.json"), set())
    def test_roundtrip(self):
        fd, p = tempfile.mkstemp(suffix=".json"); os.close(fd); os.unlink(p)
        self.addCleanup(lambda: os.path.exists(p) and os.unlink(p))
        state.save_state(p, {"a:done", "b:decision"})
        self.assertEqual(state.load_state(p), {"a:done", "b:decision"})
    def test_corrupt_file_is_empty_set(self):
        fd, p = tempfile.mkstemp(suffix=".json"); os.close(fd)
        open(p, "w").write("{not json"); self.addCleanup(os.unlink, p)
        self.assertEqual(state.load_state(p), set())

if __name__ == "__main__": unittest.main()
```

- [ ] **Step 2: Run — expect FAIL** (`ModuleNotFoundError`)
Run: `cd tools/voice-echo-bot && python3 -m unittest test_tenants test_state -v`

- [ ] **Step 3: Implement**

Append to `config.py`:
```python

# --- Rückkanal + Mehrmandanten ---
TENANTS_PATH = os.path.expanduser("~/.paperclip/voice-echo-tenants.json")
STATE_PATH = os.path.expanduser("~/.paperclip/voice-echo-state.json")
DECISION_LABEL = "entscheidung-noetig"
POLL_INTERVAL_SEC = 60
LONGPOLL_TIMEOUT_SEC = 25
```

```python
# tools/voice-echo-bot/tenants.py
"""Mandanten-Tabelle: Telegram-User-ID -> {company_id, ceo_agent_id, name}."""
import json

def load_tenants(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)

def resolve_tenant(tenants, user_id):
    return tenants.get(str(user_id))
```

```python
# tools/voice-echo-bot/state.py
"""Dedup-State: Menge aus '<issue_id>:<event>'-Schlüsseln, atomar persistiert."""
import json
import os

def load_state(path):
    if not os.path.exists(path):
        return set()
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return set(json.load(fh).get("seen", []))
    except (json.JSONDecodeError, OSError, ValueError):
        return set()

def save_state(path, seen):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump({"seen": sorted(seen)}, fh)
    os.replace(tmp, path)
```

- [ ] **Step 4: Run — expect PASS**
Run: `cd tools/voice-echo-bot && python3 -m unittest test_tenants test_state -v`

- [ ] **Step 5: Commit**
```bash
git add tools/voice-echo-bot/config.py tools/voice-echo-bot/tenants.py tools/voice-echo-bot/state.py tools/voice-echo-bot/test_tenants.py tools/voice-echo-bot/test_state.py
git commit -m "feat(jarvis): tenants + dedup-state + config konstanten

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: paperclip_client-Erweiterungen (list/label/find/comment)

**Files:** Modify `tools/voice-echo-bot/paperclip_client.py`, `tools/voice-echo-bot/test_paperclip_client.py`.

**Interfaces — Consumes:** `config.API_BASE`. **Produces:**
- `list_issues(token, company_id, label_id=None) -> list` — GET `/companies/{id}/issues` (mit `?labelId=` wenn gesetzt); entpackt `list`/`{issues}`/`{data}`.
- `resolve_label_id(token, company_id, name) -> str|None` — GET `/companies/{id}/labels`, Name-Match.
- `find_issue_by_identifier(token, company_id, identifier) -> dict|None` — sucht in `list_issues` nach `identifier`.
- `add_comment(token, issue_id, body, resume=True) -> dict` — POST `/issues/{id}/comments` mit `{"body", "resume"}` (resume nur wenn True), Bearer.

- [ ] **Step 1: Failing tests** (append to `test_paperclip_client.py`)

```python
class TestReturnChannel(unittest.TestCase):
    def test_add_comment_posts_body_and_resume(self):
        with mock.patch("paperclip_client.urllib.request.urlopen",
                        return_value=_fake_response({"id": "c1"})) as uo:
            pc.add_comment("tok", "iss-1", "Meine Antwort", resume=True)
        req = uo.call_args[0][0]
        self.assertEqual(req.full_url, "http://127.0.0.1:3100/api/issues/iss-1/comments")
        self.assertEqual(req.headers["Authorization"], "Bearer tok")
        body = json.loads(req.data.decode("utf-8"))
        self.assertEqual(body["body"], "Meine Antwort")
        self.assertTrue(body["resume"])

    def test_find_issue_by_identifier(self):
        issues = {"issues": [{"id": "a", "identifier": "WHI-1"}, {"id": "b", "identifier": "WHI-2"}]}
        with mock.patch("paperclip_client.urllib.request.urlopen", return_value=_fake_response(issues)):
            found = pc.find_issue_by_identifier("tok", "comp", "WHI-2")
        self.assertEqual(found["id"], "b")

    def test_resolve_label_id_matches_name(self):
        labels = [{"id": "l1", "name": "andere"}, {"id": "l2", "name": "entscheidung-noetig"}]
        with mock.patch("paperclip_client.urllib.request.urlopen", return_value=_fake_response(labels)):
            self.assertEqual(pc.resolve_label_id("tok", "comp", "entscheidung-noetig"), "l2")

    def test_list_issues_appends_label_query(self):
        with mock.patch("paperclip_client.urllib.request.urlopen",
                        return_value=_fake_response({"issues": []})) as uo:
            pc.list_issues("tok", "comp", label_id="l2")
        self.assertIn("?labelId=l2", uo.call_args[0][0].full_url)
```

- [ ] **Step 2: Run — expect FAIL** (`AttributeError: module 'paperclip_client' has no attribute 'add_comment'`)
Run: `cd tools/voice-echo-bot && python3 -m unittest test_paperclip_client -v`

- [ ] **Step 3: Implement** (append to `paperclip_client.py`)

```python
def _get_json(token, path):
    req = urllib.request.Request(API_BASE + path, headers={"Authorization": "Bearer {}".format(token)})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))

def _unwrap(data):
    if isinstance(data, list):
        return data
    return data.get("issues", data.get("data", data.get("labels", [])))

def list_issues(token, company_id, label_id=None):
    path = "/companies/{}/issues".format(company_id)
    if label_id:
        path += "?labelId={}".format(label_id)
    return _unwrap(_get_json(token, path))

def resolve_label_id(token, company_id, name):
    for label in _unwrap(_get_json(token, "/companies/{}/labels".format(company_id))):
        if label.get("name") == name:
            return label.get("id")
    return None

def find_issue_by_identifier(token, company_id, identifier):
    for issue in list_issues(token, company_id):
        if issue.get("identifier") == identifier:
            return issue
    return None

def add_comment(token, issue_id, body, resume=True):
    payload = {"body": body}
    if resume:
        payload["resume"] = True
    req = urllib.request.Request(
        "{}/issues/{}/comments".format(API_BASE, issue_id),
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer {}".format(token)},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))
```

- [ ] **Step 4: Run — expect PASS** (alte + neue Tests)
Run: `cd tools/voice-echo-bot && python3 -m unittest test_paperclip_client -v`

- [ ] **Step 5: Commit**
```bash
git add tools/voice-echo-bot/paperclip_client.py tools/voice-echo-bot/test_paperclip_client.py
git commit -m "feat(jarvis): paperclip list/label/find/comment helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: notifier.py — Event-Sammlung (reine Logik)

**Files:** Create `tools/voice-echo-bot/notifier.py`, `tools/voice-echo-bot/test_notifier.py`.

**Interfaces — Produces:**
- `collect_events(issues, label_id, seen) -> (events, new_keys)`:
  - **done:** Issue mit `parentId is None` und `status == "done"` → key `"<id>:done"`.
  - **decision:** `label_id` in `issue["labelIds"]` → key `"<id>:decision"`.
  - Nur Keys, die NICHT in `seen` sind, werden zu Events; `new_keys` = alle neuen Keys (Reihenfolge stabil).
  - `event = {"issue": <dict>, "kind": "done"|"decision", "key": <str>}`.

- [ ] **Step 1: Failing test**

```python
# tools/voice-echo-bot/test_notifier.py
import unittest
import notifier

class TestCollectEvents(unittest.TestCase):
    def _issue(self, iid, status="in_progress", parent=None, labels=None):
        return {"id": iid, "status": status, "parentId": parent, "labelIds": labels or []}

    def test_done_toplevel_only(self):
        issues = [self._issue("a", status="done"),           # toplevel done -> event
                  self._issue("b", status="done", parent="a"),  # child done -> ignored
                  self._issue("c", status="in_progress")]
        events, keys = notifier.collect_events(issues, "L", set())
        self.assertEqual([e["key"] for e in events], ["a:done"])
        self.assertEqual(keys, ["a:done"])

    def test_decision_label(self):
        issues = [self._issue("x", labels=["L"]), self._issue("y", labels=["OTHER"])]
        events, _ = notifier.collect_events(issues, "L", set())
        self.assertEqual([(e["kind"], e["key"]) for e in events], [("decision", "x:decision")])

    def test_seen_are_suppressed(self):
        issues = [self._issue("a", status="done")]
        events, keys = notifier.collect_events(issues, "L", {"a:done"})
        self.assertEqual(events, [])
        self.assertEqual(keys, [])

if __name__ == "__main__": unittest.main()
```

- [ ] **Step 2: Run — expect FAIL**
Run: `cd tools/voice-echo-bot && python3 -m unittest test_notifier -v`

- [ ] **Step 3: Implement**

```python
# tools/voice-echo-bot/notifier.py
"""Reine Logik: aus Company-Issues die neuen 'done'/'decision'-Events sammeln."""

def collect_events(issues, label_id, seen):
    events, new_keys = [], []
    for issue in issues:
        iid = issue.get("id")
        if issue.get("parentId") is None and issue.get("status") == "done":
            key = "{}:done".format(iid)
            if key not in seen:
                events.append({"issue": issue, "kind": "done", "key": key})
                new_keys.append(key)
        if label_id and label_id in (issue.get("labelIds") or []):
            key = "{}:decision".format(iid)
            if key not in seen:
                events.append({"issue": issue, "kind": "decision", "key": key})
                new_keys.append(key)
    return events, new_keys
```

- [ ] **Step 4: Run — expect PASS**
Run: `cd tools/voice-echo-bot && python3 -m unittest test_notifier -v`

- [ ] **Step 5: Commit**
```bash
git add tools/voice-echo-bot/notifier.py tools/voice-echo-bot/test_notifier.py
git commit -m "feat(jarvis): notifier event collection (done + decision-label, dedup)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: bot.py — Mehrmandanten + Reply + Poll (Ersetzen)

**Files:** Replace `tools/voice-echo-bot/bot.py`, replace `tools/voice-echo-bot/test_bot.py`.

**Interfaces — Consumes:** `config`, `tenants`, `state`, `notifier`, `transcribe`, `Telegram`, `create_issue`, `derive_title`, `add_comment`, `find_issue_by_identifier`, `list_issues`, `resolve_label_id`.
**Produces:** `BotApp(tg, cfg)` mit `cfg` keys: `tenants` (dict), `paperclip_token` (str|callable), `whisper_model`, `decision_label`, `poll_interval`, `state_path`, `seen` wird intern geladen. Methoden: `handle_update`, `_handle_message`, `_handle_reply`, `_handle_callback`, `_extract_text`, `_offer`, `poll_tenants`, `run`. Candidate-Value = `{"text","company_id","ceo_agent_id"}`; key `"{chat_id}:{message_id}"`; callback_data `send:{key}`/`drop:{key}`.

- [ ] **Step 1: Failing test (replace test_bot.py)**

```python
# tools/voice-echo-bot/test_bot.py
import unittest
from unittest import mock
import bot

TENANTS = {"8311805232": {"name": "W", "company_id": "comp-1", "ceo_agent_id": "ceo-1"},
           "1220010628": {"name": "C", "company_id": "comp-2", "ceo_agent_id": "ceo-2"}}

def make_app(tg):
    cfg = {"tenants": TENANTS, "paperclip_token": "tok", "whisper_model": "m.bin",
           "decision_label": "entscheidung-noetig", "poll_interval": 60, "state_path": "/tmp/nope.json"}
    app = bot.BotApp(tg, cfg); app.seen = set(); app._seeded = True; return app

def msg(uid, mid=1, text=None, voice=False, reply_text=None):
    m = {"message_id": mid, "chat": {"id": uid}, "from": {"id": uid}}
    if voice: m["voice"] = {"file_id": "fid"}
    elif text is not None: m["text"] = text
    if reply_text is not None: m["reply_to_message"] = {"text": reply_text}
    return {"message": m}

class TestTenantRouting(unittest.TestCase):
    def test_foreign_user_ignored(self):
        tg = mock.MagicMock(); make_app(tg).handle_update(msg(999, text="hi"))
        tg.send_message.assert_not_called()

    def test_text_stores_candidate_with_tenant(self):
        tg = mock.MagicMock(); app = make_app(tg)
        app.handle_update(msg(1220010628, mid=5, text="Mische den Song"))
        cand = app.candidates["1220010628:5"]
        self.assertEqual(cand["company_id"], "comp-2")
        self.assertEqual(cand["ceo_agent_id"], "ceo-2")

    def test_callback_send_creates_issue_in_tenant_company(self):
        tg = mock.MagicMock(); app = make_app(tg)
        app.candidates["1220010628:5"] = {"text": "Mische den Song", "company_id": "comp-2", "ceo_agent_id": "ceo-2"}
        with mock.patch.object(bot, "create_issue", return_value={"identifier": "CLR-1"}) as ci:
            app.handle_update({"callback_query": {"id": "q", "from": {"id": 1220010628},
                                                  "message": {"chat": {"id": 1220010628}}, "data": "send:1220010628:5"}})
        ci.assert_called_once_with("tok", "comp-2", "ceo-2", "Mische den Song", "Mische den Song")

class TestReply(unittest.TestCase):
    def test_reply_posts_comment_to_referenced_issue(self):
        tg = mock.MagicMock(); app = make_app(tg)
        with mock.patch.object(bot, "find_issue_by_identifier", return_value={"id": "iss-9", "identifier": "WHI-2857"}) as fi, \
             mock.patch.object(bot, "add_comment", return_value={"id": "c1"}) as ac:
            app.handle_update(msg(8311805232, text="Ja, mach DMARC so.", reply_text="🟠 Entscheidung benötigt — WHI-2857: DMARC"))
        fi.assert_called_once_with("tok", "comp-1", "WHI-2857")
        ac.assert_called_once_with("tok", "iss-9", "Ja, mach DMARC so.", resume=True)

    def test_reply_unknown_identifier_no_comment(self):
        tg = mock.MagicMock(); app = make_app(tg)
        with mock.patch.object(bot, "find_issue_by_identifier", return_value=None), \
             mock.patch.object(bot, "add_comment") as ac:
            app.handle_update(msg(8311805232, text="egal", reply_text="WHI-9999: weg"))
        ac.assert_not_called()

class TestPoll(unittest.TestCase):
    def test_poll_pushes_new_events_per_tenant(self):
        tg = mock.MagicMock(); app = make_app(tg)
        with mock.patch.object(bot, "resolve_label_id", return_value="L"), \
             mock.patch.object(bot, "list_issues", return_value=[{"id": "a", "status": "done", "parentId": None, "labelIds": [], "identifier": "WHI-1", "title": "T"}]), \
             mock.patch.object(bot.state, "save_state"):
            app.poll_tenants()
        # zwei Mandanten, je ein done-Event -> zwei Pushes an die jeweiligen chat_ids
        pushed = {c.args[0] for c in tg.send_message.call_args_list}
        self.assertEqual(pushed, {8311805232, 1220010628})

    def test_first_run_suppresses_push(self):
        tg = mock.MagicMock(); app = make_app(tg); app._seeded = False
        with mock.patch.object(bot, "resolve_label_id", return_value="L"), \
             mock.patch.object(bot, "list_issues", return_value=[{"id": "a", "status": "done", "parentId": None, "labelIds": [], "identifier": "WHI-1", "title": "T"}]), \
             mock.patch.object(bot.state, "save_state"):
            app.poll_tenants()
        tg.send_message.assert_not_called()
        self.assertIn("a:done", app.seen)

if __name__ == "__main__": unittest.main()
```

- [ ] **Step 2: Run — expect FAIL**
Run: `cd tools/voice-echo-bot && python3 -m unittest test_bot -v`

- [ ] **Step 3: Implement (replace bot.py)**

```python
# tools/voice-echo-bot/bot.py
"""Jarvis-Bot: Mehrmandanten-Eingang, Reply→Kommentar, CEO-Event-Poll (stdlib only)."""
import os
import re
import shutil
import sys
import tempfile
import time
import traceback

import config
import state
import tenants as tenants_mod
import transcribe
import notifier
from telegram_api import Telegram
from paperclip_client import (create_issue, derive_title, add_comment,
                              find_issue_by_identifier, list_issues, resolve_label_id)

CONFIRM_PROMPT = "📝 {text}\n\nAls Aufgabe an den CEO senden?"
IDENT_RE = re.compile(r"([A-Z]{2,5}-\d+)")


class BotApp:
    def __init__(self, tg, cfg):
        self.tg = tg
        self.cfg = cfg
        self.candidates = {}
        self.seen = set()
        self._seeded = True

    def _token(self):
        tok = self.cfg["paperclip_token"]
        return tok() if callable(tok) else tok

    # ---- Eingang / Dispatcher ----
    def handle_update(self, update):
        if "callback_query" in update:
            cbq = update["callback_query"]
            tenant = tenants_mod.resolve_tenant(self.cfg["tenants"], cbq.get("from", {}).get("id"))
            if tenant:
                self._handle_callback(tenant, cbq)
        elif "message" in update:
            msg = update["message"]
            tenant = tenants_mod.resolve_tenant(self.cfg["tenants"], msg.get("from", {}).get("id"))
            if tenant:
                self._handle_message(tenant, msg)

    def _extract_text(self, msg):
        """Voice -> Whisper (mit Cleanup) oder Textnachricht; None bei Transkriptionsfehler."""
        if "voice" in msg or "audio" in msg:
            media = msg.get("voice") or msg.get("audio")
            workdir = tempfile.mkdtemp()
            ogg = os.path.join(workdir, "in.oga")
            try:
                path = self.tg.get_file_path(media["file_id"])
                self.tg.download_file(path, ogg)
                return transcribe.transcribe(ogg, self.cfg["whisper_model"], workdir=workdir)
            except transcribe.TranscriptionError:
                self.tg.send_message(msg["chat"]["id"], "Transkription fehlgeschlagen, bitte erneut.")
                return None
            finally:
                shutil.rmtree(workdir, ignore_errors=True)
        return msg.get("text")

    def _handle_message(self, tenant, msg):
        reply_to = msg.get("reply_to_message")
        if reply_to:
            m = IDENT_RE.search(reply_to.get("text") or "")
            if m:
                self._handle_reply(tenant, msg, m.group(1))
                return
        text = self._extract_text(msg)
        if text is None:
            return
        if isinstance(text, str) and text.startswith("/"):
            self.tg.send_message(msg["chat"]["id"],
                                 "Sprich mir eine Aufgabe ein oder tippe sie — ich lege sie beim CEO an.")
            return
        self._offer(tenant, msg["chat"]["id"], msg["message_id"], text)

    # ---- Reply -> Kommentar ----
    def _handle_reply(self, tenant, msg, identifier):
        chat_id = msg["chat"]["id"]
        text = self._extract_text(msg)
        if text is None:
            return
        token = self._token()
        issue = find_issue_by_identifier(token, tenant["company_id"], identifier)
        if not issue:
            self.tg.send_message(chat_id, "Konnte kein passendes Issue ({}) finden.".format(identifier))
            return
        try:
            add_comment(token, issue["id"], text, resume=True)
            self.tg.send_message(chat_id, "✅ Antwort an CEO ({}) gesendet.".format(identifier))
        except Exception:  # noqa: BLE001
            traceback.print_exc()
            self.tg.send_message(chat_id, "⚠️ Konnte die Antwort nicht senden, bitte erneut.")

    # ---- Issue-Erstellung (Bestätigungs-Flow) ----
    def _confirm_markup(self, key):
        return {"inline_keyboard": [[
            {"text": "✅ An CEO senden", "callback_data": "send:" + key},
            {"text": "❌ Verwerfen", "callback_data": "drop:" + key},
        ]]}

    def _offer(self, tenant, chat_id, message_id, text):
        text = (text or "").strip()
        if not text:
            self.tg.send_message(chat_id, "Nichts erkannt, bitte erneut.")
            return
        key = "{}:{}".format(chat_id, message_id)
        self.candidates[key] = {"text": text, "company_id": tenant["company_id"],
                                "ceo_agent_id": tenant["ceo_agent_id"]}
        self.tg.send_message(chat_id, CONFIRM_PROMPT.format(text=text), reply_markup=self._confirm_markup(key))

    def _handle_callback(self, tenant, cbq):
        data = cbq.get("data", "")
        chat_id = cbq["message"]["chat"]["id"]
        action, _, key = data.partition(":")
        cand = self.candidates.pop(key, None)
        if cand is None:
            self.tg.answer_callback_query(cbq["id"], "Abgelaufen — bitte neu senden.")
            return
        if action == "send":
            try:
                issue = create_issue(self._token(), cand["company_id"], cand["ceo_agent_id"],
                                     derive_title(cand["text"]), cand["text"])
            except Exception:  # noqa: BLE001
                traceback.print_exc()
                self.candidates[key] = cand
                self.tg.answer_callback_query(cbq["id"], "Fehler")
                self.tg.send_message(chat_id, "⚠️ Konnte Issue nicht anlegen, bitte erneut senden.")
                return
            label = issue.get("identifier") or issue.get("id", "?")
            try:
                self.tg.answer_callback_query(cbq["id"], "Gesendet")
                self.tg.send_message(chat_id, "✅ An CEO gesendet: {}".format(label))
            except Exception:  # noqa: BLE001
                traceback.print_exc()
        else:
            self.tg.answer_callback_query(cbq["id"], "Verworfen")
            self.tg.send_message(chat_id, "❌ Verworfen.")

    # ---- Rückkanal-Poll ----
    def _format_push(self, ev):
        i = ev["issue"]
        ident = i.get("identifier") or (i.get("id") or "?")[:8]
        title = i.get("title") or "(ohne Titel)"
        if ev["kind"] == "done":
            return "✅ Erledigt — {}: {}".format(ident, title)
        return ("🟠 Entscheidung benötigt — {}: {}\n\n"
                "↩️ Antworte auf diese Nachricht (Sprache/Text), um dem CEO zu antworten.").format(ident, title)

    def poll_tenants(self):
        token = self._token()
        for uid, tenant in self.cfg["tenants"].items():
            try:
                label_id = resolve_label_id(token, tenant["company_id"], self.cfg["decision_label"])
                issues = list_issues(token, tenant["company_id"])
                events, keys = notifier.collect_events(issues, label_id, self.seen)
                if self._seeded:
                    for ev in events:
                        try:
                            self.tg.send_message(int(uid), self._format_push(ev))
                        except Exception:  # noqa: BLE001
                            traceback.print_exc()
                self.seen.update(keys)
            except Exception:  # noqa: BLE001
                traceback.print_exc()
        state.save_state(self.cfg["state_path"], self.seen)
        self._seeded = True

    def _drain(self):
        offset = None
        pending = self.tg.get_updates(offset=-1, timeout=0)
        if pending:
            offset = pending[-1]["update_id"] + 1
        return offset

    def run(self):
        offset = self._drain()
        last_poll = 0.0
        while True:
            try:
                for update in self.tg.get_updates(offset=offset, timeout=config.LONGPOLL_TIMEOUT_SEC):
                    offset = update["update_id"] + 1
                    self.handle_update(update)
            except Exception:  # noqa: BLE001
                traceback.print_exc()
                time.sleep(5)
            now = time.monotonic()
            if now - last_poll >= self.cfg["poll_interval"]:
                self.poll_tenants()
                last_poll = now


def build_app():
    env = config.load_env(config.ENV_PATH)
    cfg = {
        "tenants": tenants_mod.load_tenants(config.TENANTS_PATH),
        "paperclip_token": config.load_paperclip_token,
        "whisper_model": os.path.expanduser(env["WHISPER_MODEL"]),
        "decision_label": config.DECISION_LABEL,
        "poll_interval": config.POLL_INTERVAL_SEC,
        "state_path": config.STATE_PATH,
    }
    app = BotApp(Telegram(env["TELEGRAM_BOT_TOKEN"]), cfg)
    app.seen = state.load_state(config.STATE_PATH)
    app._seeded = os.path.exists(config.STATE_PATH)
    return app


if __name__ == "__main__":
    print("voice-echo jarvis-bot startet…", file=sys.stderr)
    build_app().run()
```

- [ ] **Step 4: Run focused + whole suite — expect PASS**
Run: `cd tools/voice-echo-bot && python3 -m unittest test_bot -v`
Run: `cd tools/voice-echo-bot && python3 -m unittest discover -p "test_*.py" -v`
Expected: alle grün (Tasks 1–4 + bestehende config/telegram/transcribe/paperclip).

- [ ] **Step 5: Commit**
```bash
git add tools/voice-echo-bot/bot.py tools/voice-echo-bot/test_bot.py
git commit -m "feat(jarvis): multi-tenant routing + reply-to-comment + CEO event poll

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Decision-Label anlegen + CEO/Büroleitung-Instruktion

**Files:** kein Repo-Code — API-Aktion + Instruktions-/AGENTS.md-Änderung. Dokumentiere die Schritte in `tools/voice-echo-bot/DEPLOY.md` (Abschnitt „Rückkanal").

**Interfaces — Produces:** Label `entscheidung-noetig` existiert in beiden Companies; beide CEOs (WHITESTAG-CEO, Clara-Büroleitung) sind instruiert, es bei Entscheidungsbedarf zu setzen und nach Klärung zu entfernen.

- [ ] **Step 1: Label in beiden Companies anlegen (idempotent)**
```bash
TOKEN=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.paperclip/auth.json')))['credentials']['http://localhost:3100']['token'])")
for CID in 9cebf3cf-efe8-4597-a400-f06488900a87 0e426844-309c-4528-9aa5-90ff76790a51; do
  echo "company $CID:"
  curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -X POST "http://127.0.0.1:3100/api/companies/$CID/labels" \
    -d '{"name":"entscheidung-noetig","color":"#e8a33d"}' \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print('  label:', d.get('id'), d.get('name'), d.get('error',''))" 2>/dev/null \
    || echo "  (Label evtl. schon vorhanden)"
done
```
Expected: Label-ID je Company (oder Hinweis „schon vorhanden").

- [ ] **Step 2: Label-Auflösung verifizieren**
```bash
cd tools/voice-echo-bot && python3 -c "
import config, paperclip_client as pc
tok=config.load_paperclip_token()
for cid in ['9cebf3cf-efe8-4597-a400-f06488900a87','0e426844-309c-4528-9aa5-90ff76790a51']:
    print(cid, '->', pc.resolve_label_id(tok, cid, 'entscheidung-noetig'))
"
```
Expected: je eine Label-UUID (nicht None).

- [ ] **Step 3: CEO-Instruktion ergänzen (WHITESTAG-CEO)**
Rollen-Quelle: `~/.paperclip/scripts/agents-instructions/roles/ceo.role.md`. Ergänze einen Abschnitt (verbatim):
```markdown
## Entscheidungen an den Menschen (Jarvis-Rückkanal)
Wenn du für eine Aufgabe eine Entscheidung oder Freigabe des Menschen (Walter) brauchst
und ohne sie nicht weiterarbeiten kannst, setze am betroffenen Issue das Label
`entscheidung-noetig`. Formuliere im letzten Kommentar knapp, worüber zu entscheiden ist.
Sobald die Entscheidung vorliegt (Antwort-Kommentar), entferne das Label wieder und arbeite weiter.
Nutze das Label ausschließlich für echte Human-Entscheidungen, nicht für interne Blocker.
```

- [ ] **Step 4: Büroleitung-Instruktion ergänzen (Clara Sound)**
Claras Büroleitung-Rollenquelle liegt unter der Company-Agent-Instruktion. Finde die Quelle:
```bash
ls ~/.paperclip/instances/default/companies/0e426844-309c-4528-9aa5-90ff76790a51/agents/64ad7d03-ce64-46aa-ae79-d17ff26f5d4f/instructions/
grep -rl "Büroleit\|Office\|Leitung" ~/.paperclip/scripts/agents-instructions/ 2>/dev/null
```
Ergänze denselben Abschnitt (Text wie Step 3, „Walter" → „Clara") in der passenden Rollen-/Instruktionsquelle der Büroleitung.

- [ ] **Step 5: AGENTS.md regenerieren + verifizieren**
```bash
python3 ~/.paperclip/scripts/agents-instructions/build-agents-md.py
grep -l "entscheidung-noetig" ~/.paperclip/instances/default/companies/*/agents/*/instructions/AGENTS.md
```
Expected: die AGENTS.md von WHITESTAG-CEO und Clara-Büroleitung enthalten den neuen Abschnitt.

- [ ] **Step 6: Commit (DEPLOY.md-Doku)**
```bash
git add tools/voice-echo-bot/DEPLOY.md
git commit -m "docs(jarvis): Rückkanal-Setup (label + CEO/Büroleitung-Instruktion)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Deploy + E2E (inkl. offener Sende-E2E aus Feature 1)

**Files:** Deploy nach `~/.paperclip/scripts/voice-echo-bot/`; `.env`-Bereinigung (`TELEGRAM_ALLOWED_USER_ID` entfällt).

- [ ] **Step 1: `.env` bereinigen** — `TELEGRAM_ALLOWED_USER_ID`, `WHITESTAG_COMPANY_ID`, `CEO_AGENT_ID` sind für Feature 2 nicht mehr nötig (Routing kommt aus tenants.json). Entferne diese Zeilen; `TELEGRAM_BOT_TOKEN` + `WHISPER_MODEL` bleiben.
```bash
python3 - <<'PY'
import os
p=os.path.expanduser("~/.paperclip/voice-echo-bot.env")
keep=("TELEGRAM_BOT_TOKEN","WHISPER_MODEL")
out=[l for l in open(p,encoding="utf-8").read().splitlines()
     if not l.strip() or l.strip().startswith("#") or l.split("=",1)[0].strip() in keep]
open(p,"w",encoding="utf-8").write("\n".join(out)+"\n"); os.chmod(p,0o600)
print(open(p,encoding="utf-8").read())
PY
```

- [ ] **Step 2: Deploy neue Module + Restart**
```bash
cp tools/voice-echo-bot/{config,telegram_api,transcribe,paperclip_client,bot,tenants,state,notifier}.py ~/.paperclip/scripts/voice-echo-bot/
launchctl kickstart -k gui/$(id -u)/de.whitestag.voice-echo-bot
sleep 3
launchctl print gui/$(id -u)/de.whitestag.voice-echo-bot | grep -E "state =|pid ="
tail -20 ~/.paperclip/logs/voice-echo-bot.log
```
Expected: `state = running`, kein Traceback. (Erststart-Poll markiert Bestand als seen, ohne Push.)

- [ ] **Step 3: E2E-A — Sprachnachricht → Issue (schließt Feature-1-Sende-E2E)**
Walter sendet Sprachnachricht → ✅ drücken → Bot: „✅ An CEO gesendet: WHI-…". Verifikation:
```bash
TOKEN=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.paperclip/auth.json')))['credentials']['http://localhost:3100']['token'])")
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:3100/api/companies/9cebf3cf-efe8-4597-a400-f06488900a87/issues" \
| python3 -c "import sys,json;a=json.load(sys.stdin);a=a if isinstance(a,list) else a.get('issues',a.get('data',[]));a.sort(key=lambda i:i.get('createdAt') or '',reverse=True);print(a[0].get('identifier'),'|',a[0].get('title'))"
```
Expected: das eingesprochene Issue oben.

- [ ] **Step 4: E2E-B — Decision-Label → Push + Reply → Kommentar**
```bash
# an einem existierenden CEO-Issue das Label setzen (simuliert die CEO-Markierung)
TOKEN=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.paperclip/auth.json')))['credentials']['http://localhost:3100']['token'])")
# <ISSUE_ID> = das eben erzeugte Issue aus Step 3; LABEL_ID via resolve
```
Setze das Label am Test-Issue (per `PATCH /issues/:id` mit `labelIds`), warte ≤60 s → Push „🟠 Entscheidung benötigt — WHI-…" kommt in Walters Chat. Walter **antwortet per Reply** (Sprache/Text). Verifikation:
```bash
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:3100/api/issues/<ISSUE_ID>/comments" \
| python3 -c "import sys,json;a=json.load(sys.stdin);print('letzter Kommentar:', (a[-1].get('body') if a else None))"
```
Expected: Walters Antworttext steht als Kommentar am Issue.

- [ ] **Step 5: E2E-C — Fertig-Push**
Ein CEO-Top-Level-Issue auf `done` setzen (oder ein reales) → innerhalb ≤60 s Push „✅ Erledigt — WHI-…" in Walters Chat.

- [ ] **Step 6: Ledger + Abschluss** — E2E-Ergebnisse ins Ledger; danach finale Whole-Branch-Review.

---

## Testing-Zusammenfassung
- **Unit:** `cd tools/voice-echo-bot && python3 -m unittest discover -p "test_*.py" -v` — tenants/state/notifier/paperclip-Erweiterungen/bot (Routing, Reply, Poll, Erststart-Suppression) + bestehende Einbahn-Tests.
- **Live:** Label-Auflösung (Task 5); E2E A/B/C (Task 6).

## Bewusst nicht im Scope
Keine Approve-Buttons; kein Push für jeden Kommentar/Status; keine Weboberfläche; keine Auto-Mandanten-Anlage; „done"-Push nur Top-Level.
