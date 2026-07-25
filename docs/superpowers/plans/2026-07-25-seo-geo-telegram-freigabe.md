# SEO/GEO-Freigaben per Telegram — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freigabereife SEO/GEO-Changesets per Telegram (Jarvis-Bot) an Walter pushen, per Inline-Button freigeben/ablehnen lassen, den Live-Write deterministisch dahinter ausführen und offene Freigaben nach 24 h einmal erinnern.

**Architecture:** Der seo-geo-Dienst (Python 3.11) legt beim Vorlegen eine Token-Freigabedatei an und pusht direkt über die Jarvis-Bot-Token-API (sendDocument + sendMessage-mit-Buttons). Der laufende Jarvis-Bot (stdlib) empfängt den Button-Callback und ruft deterministisch `seo-geo approve` + `apply` über dessen venv auf. Ein täglicher launchd-Check erinnert an offene Freigaben. Bindeglied ist ausschließlich das gemeinsame Token-JSON unter `~/.paperclip/state/seo-approvals/` — kein Code-Sharing zwischen den beiden Diensten.

**Tech Stack:** Python 3.11 (seo-geo, mit venv), Python stdlib-only (voice-echo-bot), Telegram Bot API (urllib), launchd.

## Global Constraints

- seo-geo läuft unter **Python 3.11** über `./venv/bin/python` — System-python3 ist 3.9 und bricht `str | None`.
- voice-echo-bot ist **stdlib-only** — keine Fremd-Imports, kein Import von seo-geo-Modulen.
- **Feld-Whitelist bleibt die Sicherheitsgrenze** (`EDITABLE_FIELDS` in `changeset.py`), unverändert.
- **Kein LLM im Schreibpfad** — der Button-Callback ruft deterministisch das seo-geo-CLI.
- **Nur Walters Chat `8311805232`** darf einen SEO-Callback auslösen.
- **Push läuft über den Jarvis-Bot** (`@whitestag_jarvis_bot`), Token in `~/.paperclip/voice-echo-bot.env` → `TELEGRAM_BOT_TOKEN`. NICHT Lunas Token aus `~/.whitestag.env`.
- **TDD, kein Live-Telegram in Tests** — alle Netz-/Subprozess-Aufrufe injiziert/gemockt.
- **Zwei-Kopien-Deploy:** Laufzeitcode liegt in `~/.paperclip/scripts/…`, nicht im CloudStorage-Repo. Erst nach Sync + kickstart live.

---

## File Structure

**seo-geo-Dienst (`tools/seo-geo/`, Python 3.11):**
- Create `seo_approvals.py` — Token-Queue (create/load/set_status/list_pending, TTL, atomarer Write).
- Create `approval_render.py` — rendert die Änderungsliste eines Changesets als Text.
- Create `telegram_push.py` — dünner Jarvis-Push (sendDocument + sendMessage-mit-Buttons) via urllib, injizierbar; Bot-Token-Loader.
- Modify `cli.py` — neue Subcommands `notify` und `reping`.
- Create `de.whitestag.seo-geo-reping.plist` — täglicher Re-Ping-launchd.

**voice-echo-bot (`tools/voice-echo-bot/`, stdlib):**
- Modify `telegram_api.py` — `send_document` ergänzen.
- Create `seo_gate.py` — SEO-Callback-Logik: callback_data parsen, Token laden, approve+apply-Runner, Ergebnis zusammenfassen.
- Modify `bot.py` — `handle_update` um `callback_query`-Zweig (nur `seo:`-Präfix) + Reply-auf-SEO-Push-Sonderfall.
- Modify `config.py` — Pfade: Token-Dir, seo-geo venv/CLI/root/sites.

---

## Task 1: Token-Queue `seo_approvals.py`

**Files:**
- Create: `tools/seo-geo/seo_approvals.py`
- Test: `tools/seo-geo/test_seo_approvals.py`

**Interfaces:**
- Produces:
  - `create(base_dir, site, changeset_path, list_path, count, alt_count, chat_id, *, token=None, now=None) -> str` (gibt den Token zurück)
  - `load(base_dir, token) -> dict | None`
  - `set_status(base_dir, token, status, *, note=None) -> None`
  - `list_pending(base_dir, *, older_than_hours=None, now=None) -> list[dict]`
  - Token-JSON-Felder: `token, site, changeset_path, list_path, count, alt_count, status, note, chat_id, created, last_reping`

- [ ] **Step 1: Write the failing test**

```python
# test_seo_approvals.py
import json, os
import seo_approvals as sa

def test_create_and_load(tmp_path):
    tok = sa.create(str(tmp_path), "whitestag.film",
                    "/p/cs-resolved.json", "/p/list.txt",
                    count=79, alt_count=8, chat_id=8311805232,
                    token="TESTTOK", now=1000.0)
    assert tok == "TESTTOK"
    rec = sa.load(str(tmp_path), "TESTTOK")
    assert rec["site"] == "whitestag.film"
    assert rec["status"] == "pending"
    assert rec["count"] == 79
    assert rec["created"] == 1000.0

def test_set_status_and_note(tmp_path):
    sa.create(str(tmp_path), "s", "/c.json", "/l.txt", 1, 0, 1, token="T", now=1.0)
    sa.set_status(str(tmp_path), "T", "rejected", note="zu lang")
    rec = sa.load(str(tmp_path), "T")
    assert rec["status"] == "rejected"
    assert rec["note"] == "zu lang"

def test_list_pending_older_than(tmp_path):
    sa.create(str(tmp_path), "s", "/c.json", "/l.txt", 1, 0, 1, token="OLD", now=0.0)
    sa.create(str(tmp_path), "s", "/c.json", "/l.txt", 1, 0, 1, token="NEW", now=100000.0)
    # 24h = 86400s; bei now=100000 ist OLD >24h, NEW nicht
    pend = sa.list_pending(str(tmp_path), older_than_hours=24, now=100000.0)
    toks = {p["token"] for p in pend}
    assert "OLD" in toks and "NEW" not in toks

def test_list_pending_skips_non_pending(tmp_path):
    sa.create(str(tmp_path), "s", "/c.json", "/l.txt", 1, 0, 1, token="A", now=0.0)
    sa.set_status(str(tmp_path), "A", "applied")
    assert sa.list_pending(str(tmp_path), now=100000.0) == []

def test_load_missing_returns_none(tmp_path):
    assert sa.load(str(tmp_path), "NOPE") is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest test_seo_approvals.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'seo_approvals'`

- [ ] **Step 3: Write minimal implementation**

```python
# seo_approvals.py
"""Token-Freigabe-Queue für SEO/GEO-Changesets (spiegelt Lunas approval_queue).

Ein Token-JSON pro Freigabevorgang unter <base_dir>/<token>.json. Atomarer Write
über tmp+rename. now/token injizierbar für deterministische Tests (Prod: os.urandom
+ time.time über die Default-None-Pfade)."""
import json, os, time, tempfile

TTL_SECONDS = 7 * 24 * 3600

def _path(base_dir, token):
    return os.path.join(base_dir, token + ".json")

def _write_atomic(path, data):
    d = os.path.dirname(path)
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)

def create(base_dir, site, changeset_path, list_path, count, alt_count, chat_id,
           *, token=None, now=None):
    token = token or os.urandom(9).hex()
    now = time.time() if now is None else now
    rec = {"token": token, "site": site, "changeset_path": changeset_path,
           "list_path": list_path, "count": count, "alt_count": alt_count,
           "status": "pending", "note": None, "chat_id": chat_id,
           "created": now, "last_reping": None}
    _write_atomic(_path(base_dir, token), rec)
    return token

def load(base_dir, token):
    try:
        with open(_path(base_dir, token), encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return None

def set_status(base_dir, token, status, *, note=None):
    rec = load(base_dir, token)
    if rec is None:
        return
    rec["status"] = status
    if note is not None:
        rec["note"] = note
    _write_atomic(_path(base_dir, token), rec)

def list_pending(base_dir, *, older_than_hours=None, now=None):
    now = time.time() if now is None else now
    out = []
    if not os.path.isdir(base_dir):
        return out
    for fn in os.listdir(base_dir):
        if not fn.endswith(".json"):
            continue
        rec = load(base_dir, fn[:-5])
        if not rec or rec.get("status") != "pending":
            continue
        age = now - rec.get("created", now)
        if age > TTL_SECONDS:  # abgelaufen gilt als erledigt
            continue
        if older_than_hours is not None and age < older_than_hours * 3600:
            continue
        out.append(rec)
    return out
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest test_seo_approvals.py -v`
Expected: PASS (5 passed)

- [ ] **Step 5: Commit**

```bash
git add tools/seo-geo/seo_approvals.py tools/seo-geo/test_seo_approvals.py
git commit -m "feat(seo-geo): Token-Freigabe-Queue seo_approvals"
```

---

## Task 2: Änderungsliste rendern `approval_render.py`

**Files:**
- Create: `tools/seo-geo/approval_render.py`
- Test: `tools/seo-geo/test_approval_render.py`

**Interfaces:**
- Consumes: Changeset-Dict `{"site", "changes": [{"url","field","id","target","new", "old"?}]}`
- Produces:
  - `render_change_list(changeset) -> str` (menschenlesbare Liste, ein Block je Change)
  - `summary_line(changeset) -> tuple[int, int]` → `(count, alt_count)`

- [ ] **Step 1: Write the failing test**

```python
# test_approval_render.py
import approval_render as r

CS = {"site": "whitestag.film", "changes": [
    {"url": "https://x/a", "field": "meta_description", "id": 12, "target": "page",
     "new": "Neue Beschreibung", "old": "Alt"},
    {"url": "https://x/b", "field": "alt_text", "id": 99, "target": "media",
     "new": "Ein Foto vom Set"},
]}

def test_summary_counts():
    assert r.summary_line(CS) == (2, 1)

def test_render_contains_fields_and_values():
    text = r.render_change_list(CS)
    assert "whitestag.film" in text
    assert "meta_description" in text
    assert "Neue Beschreibung" in text
    assert "https://x/a" in text
    assert "alt_text" in text

def test_render_shows_old_when_present():
    text = r.render_change_list(CS)
    assert "Alt" in text  # alter Wert wird gezeigt, wenn vorhanden

def test_render_empty_changes():
    assert "0 Änderungen" in r.render_change_list({"site": "s", "changes": []})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest test_approval_render.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 3: Write minimal implementation**

```python
# approval_render.py
"""Rendert ein Changeset als menschenlesbare Freigabe-Liste (Telegram-Dokument)."""

def summary_line(changeset):
    changes = changeset.get("changes", [])
    alt = sum(1 for c in changes if c.get("field") == "alt_text")
    return len(changes), alt

def render_change_list(changeset):
    changes = changeset.get("changes", [])
    site = changeset.get("site", "?")
    count, alt = summary_line(changeset)
    lines = [f"SEO/GEO-Freigabe — {site}",
             f"{count} Änderungen" + (f", davon {alt} Alt-Texte" if alt else ""),
             ""]
    for i, c in enumerate(changes, 1):
        lines.append(f"{i}. {c.get('url','?')}")
        lines.append(f"   Feld: {c.get('field','?')}  (target={c.get('target','?')}, id={c.get('id')})")
        if c.get("old") is not None:
            lines.append(f"   alt: {c.get('old')}")
        lines.append(f"   neu: {c.get('new')}")
        lines.append("")
    return "\n".join(lines)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest test_approval_render.py -v`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add tools/seo-geo/approval_render.py tools/seo-geo/test_approval_render.py
git commit -m "feat(seo-geo): Changeset-Freigabeliste rendern"
```

---

## Task 3: Jarvis-Push `telegram_push.py`

**Files:**
- Create: `tools/seo-geo/telegram_push.py`
- Test: `tools/seo-geo/test_telegram_push.py`

**Interfaces:**
- Produces:
  - `load_bot_token(env_path) -> str` (liest `TELEGRAM_BOT_TOKEN` aus der Bot-.env)
  - `push_approval(token_str, chat_id, caption, doc_path, approval_token, *, sender=None) -> None`
    — schickt Dokument + Nachricht mit Inline-Buttons `seo:ok:<t>` / `seo:no:<t>`.
    `sender(method, params_or_multipart)` ist injizierbar; Default nutzt urllib.
  - `push_text(token_str, chat_id, text, *, sender=None) -> None` (für Re-Ping)

- [ ] **Step 1: Write the failing test**

```python
# test_telegram_push.py
import telegram_push as tp

def test_load_bot_token(tmp_path):
    p = tmp_path / "bot.env"
    p.write_text('TELEGRAM_BOT_TOKEN="123:ABC"\nOTHER=x\n')
    assert tp.load_bot_token(str(p)) == "123:ABC"

def test_push_approval_sends_doc_and_buttons(tmp_path):
    doc = tmp_path / "list.txt"; doc.write_text("liste")
    calls = []
    def fake_sender(method, params):
        calls.append((method, params))
    tp.push_approval("T", 8311805232, "🟢 film — 79 Änderungen",
                     str(doc), "APPROV", sender=fake_sender)
    methods = [m for m, _ in calls]
    assert "sendDocument" in methods
    assert "sendMessage" in methods
    msg = next(p for m, p in calls if m == "sendMessage")
    kb = msg["reply_markup"]["inline_keyboard"][0]
    datas = {btn["callback_data"] for btn in kb}
    assert "seo:ok:APPROV" in datas and "seo:no:APPROV" in datas

def test_push_text(tmp_path):
    calls = []
    tp.push_text("T", 1, "⏳ wartet", sender=lambda m, p: calls.append((m, p)))
    assert calls[0][0] == "sendMessage"
    assert calls[0][1]["text"] == "⏳ wartet"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest test_telegram_push.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 3: Write minimal implementation**

```python
# telegram_push.py
"""Direkter Jarvis-Bot-Push für SEO-Freigaben (stdlib urllib, im seo-geo-venv).

Kein Prozess-Coupling zum laufenden Bot — wir sprechen dieselbe Bot-Token-API an.
Der laufende Bot bedient nur die *eingehenden* Callbacks."""
import json, os, urllib.request, uuid

def load_bot_token(env_path):
    with open(os.path.expanduser(env_path), encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if line.startswith("export "):
                line = line[len("export "):]
            if line.startswith("TELEGRAM_BOT_TOKEN="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise KeyError("TELEGRAM_BOT_TOKEN nicht in " + env_path)

def _urllib_sender(bot_token):
    api = "https://api.telegram.org/bot{}".format(bot_token)
    def send(method, params):
        if method == "sendDocument":
            _send_document(api, params)
            return
        data = json.dumps(params).encode("utf-8")
        req = urllib.request.Request("{}/{}".format(api, method), data=data,
                                     headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=30).read()
    return send

def _send_document(api, params):
    boundary = uuid.uuid4().hex
    with open(params["_doc_path"], "rb") as fh:
        content = fh.read()
    parts = []
    for k, v in (("chat_id", params["chat_id"]), ("caption", params.get("caption", ""))):
        parts += ["--" + boundary,
                  'Content-Disposition: form-data; name="{}"'.format(k), "", str(v)]
    head = ("--{b}\r\nContent-Disposition: form-data; name=\"document\"; "
            "filename=\"aenderungen.txt\"\r\nContent-Type: text/plain\r\n\r\n").format(b=boundary)
    body = ("\r\n".join(parts) + "\r\n").encode("utf-8") + head.encode("utf-8") + \
           content + ("\r\n--{}--\r\n".format(boundary)).encode("utf-8")
    req = urllib.request.Request("{}/sendDocument".format(api), data=body,
        headers={"Content-Type": "multipart/form-data; boundary={}".format(boundary)})
    urllib.request.urlopen(req, timeout=30).read()

def push_approval(bot_token, chat_id, caption, doc_path, approval_token, *, sender=None):
    send = sender or _urllib_sender(bot_token)
    send("sendDocument", {"chat_id": chat_id, "caption": caption, "_doc_path": doc_path})
    send("sendMessage", {"chat_id": chat_id,
        # Token im Text, damit eine Freitext-Antwort (Reply) ihn zuordnen kann.
        "text": caption + "\n\nFreigeben? (Token " + approval_token + ")",
        "reply_markup": {"inline_keyboard": [[
            {"text": "✅ Freigeben", "callback_data": "seo:ok:" + approval_token},
            {"text": "❌ Ablehnen", "callback_data": "seo:no:" + approval_token}]]}})

def push_text(bot_token, chat_id, text, *, sender=None):
    send = sender or _urllib_sender(bot_token)
    send("sendMessage", {"chat_id": chat_id, "text": text})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest test_telegram_push.py -v`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add tools/seo-geo/telegram_push.py tools/seo-geo/test_telegram_push.py
git commit -m "feat(seo-geo): Jarvis-Push für Freigaben (Dokument + Buttons)"
```

---

## Task 4: CLI-Subcommand `notify`

**Files:**
- Modify: `tools/seo-geo/cli.py`
- Test: `tools/seo-geo/test_cli.py` (ergänzen)

**Interfaces:**
- Consumes: `seo_approvals.create`, `approval_render.render_change_list`/`summary_line`, `telegram_push.push_approval`/`load_bot_token`, `changeset.validate_changeset`
- Produces: CLI `seo-geo notify --site <s> --changeset <pfad> --approvals-dir <dir> --list-dir <dir> --bot-env <pfad> --chat-id <id>` (Defaults für Dirs/Env/Chat in `main`); Rückgabe 0 = Push raus, 1 = Changeset unsauber (kein Push)

- [ ] **Step 1: Write the failing test**

```python
# test_cli.py (ergänzen)
import json, os
import cli

def test_notify_rejects_invalid_changeset(tmp_path, capsys):
    cs = {"site": "s", "changes": [{"url": "u", "field": "NICHT_WHITELIST",
                                    "id": 1, "target": "page", "new": "x"}]}
    csf = tmp_path / "cs.json"; csf.write_text(json.dumps(cs))
    rc = cli.main(["notify", "--site", "s", "--changeset", str(csf),
                   "--approvals-dir", str(tmp_path / "appr"),
                   "--list-dir", str(tmp_path / "lists"),
                   "--bot-env", str(tmp_path / "bot.env"), "--chat-id", "42"],
                  os.environ, pusher=_no_push, token_maker=lambda: "T")
    assert rc == 1  # validate schlägt an -> kein Push

def test_notify_valid_creates_token_and_pushes(tmp_path):
    (tmp_path / "bot.env").write_text('TELEGRAM_BOT_TOKEN="1:A"\n')
    cs = {"site": "whitestag.film", "changes": [
        {"url": "u", "field": "meta_description", "id": 1, "target": "page",
         "new": "x" * 130}]}
    csf = tmp_path / "cs.json"; csf.write_text(json.dumps(cs))
    sent = []
    rc = cli.main(["notify", "--site", "whitestag.film", "--changeset", str(csf),
                   "--approvals-dir", str(tmp_path / "appr"),
                   "--list-dir", str(tmp_path / "lists"),
                   "--bot-env", str(tmp_path / "bot.env"), "--chat-id", "42"],
                  os.environ,
                  pusher=lambda *a, **k: sent.append((a, k)), token_maker=lambda: "TOK")
    assert rc == 0
    import seo_approvals as sa
    rec = sa.load(str(tmp_path / "appr"), "TOK")
    assert rec["site"] == "whitestag.film" and rec["status"] == "pending"
    assert sent  # Push wurde ausgelöst

def _no_push(*a, **k):
    raise AssertionError("darf bei unsauberem Changeset nicht pushen")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest test_cli.py -k notify -v`
Expected: FAIL (`main() got an unexpected keyword argument 'pusher'` / unknown command `notify`)

- [ ] **Step 3: Write minimal implementation**

Add to `cli.py` (new command handler + wiring). Note the injizierbaren `pusher`/`token_maker` params on `main` for tests:

```python
def _cmd_notify(args, environ, pusher, token_maker):
    import seo_approvals as sa
    from approval_render import render_change_list, summary_line
    from changeset import validate_changeset
    cs = json.loads(open(os.path.expanduser(args.changeset)).read())
    problems = validate_changeset(cs)
    if problems:
        print(f"KEIN PUSH — Changeset unsauber ({len(problems)} Problem(e)):")
        for p in problems:
            print(f"  ✗ {p}")
        return 1
    count, alt = summary_line(cs)
    list_dir = os.path.expanduser(args.list_dir); os.makedirs(list_dir, exist_ok=True)
    token = token_maker()
    list_path = os.path.join(list_dir, token + ".txt")
    with open(list_path, "w", encoding="utf-8") as fh:
        fh.write(render_change_list(cs))
    sa.create(os.path.expanduser(args.approvals_dir), args.site,
              os.path.expanduser(args.changeset), list_path, count, alt,
              int(args.chat_id), token=token)
    caption = (f"🟢 SEO-Freigabe {args.site} — {count} Änderungen"
               + (f" ({alt} Alt-Texte)" if alt else ""))
    pusher(caption, list_path, token, int(args.chat_id), args.bot_env)
    print(f"PUSH RAUS — {args.site}, Token {token}")
    return 0

def _default_pusher(caption, list_path, token, chat_id, bot_env):
    from telegram_push import push_approval, load_bot_token
    bot_token = load_bot_token(bot_env)
    push_approval(bot_token, chat_id, caption, list_path, token)
```

Wire into `main` (add params with defaults, register subparser, dispatch):

```python
def main(argv, environ, fetch=None, client_factory=None,
         pusher=None, token_maker=None) -> int:
    client_factory = client_factory or _default_client_factory
    if token_maker is None:
        import os as _os
        token_maker = lambda: _os.urandom(9).hex()
    # … existing parser setup …
    nt = sub.add_parser("notify")
    for a in ("--site", "--changeset", "--approvals-dir", "--list-dir",
              "--bot-env", "--chat-id"):
        nt.add_argument(a)
    # … after existing dispatch lines …
    # NB: pusher wird NICHT global gesetzt — notify und reping haben verschiedene
    # Pusher-Signaturen, jeder Command wählt seinen eigenen Default beim Dispatch.
    if args.cmd == "notify": return _cmd_notify(args, environ, pusher or _default_pusher, token_maker)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest test_cli.py -v`
Expected: PASS (all, incl. existing cli tests)

- [ ] **Step 5: Commit**

```bash
git add tools/seo-geo/cli.py tools/seo-geo/test_cli.py
git commit -m "feat(seo-geo): CLI notify — validieren, Token anlegen, pushen"
```

---

## Task 5: Bot `send_document` in `telegram_api.py`

**Files:**
- Modify: `tools/voice-echo-bot/telegram_api.py`
- Test: `tools/voice-echo-bot/test_telegram_api.py` (ergänzen)

**Interfaces:**
- Produces: `Telegram.send_document(chat_id, file_path, caption=None) -> dict | None`

- [ ] **Step 1: Write the failing test**

```python
# test_telegram_api.py (ergänzen) — Muster wie test send_voice
import telegram_api

def test_send_document_posts_multipart(tmp_path, monkeypatch):
    doc = tmp_path / "l.txt"; doc.write_text("inhalt")
    captured = {}
    class FakeResp:
        def read(self): return b'{"result":{"ok":true}}'
        def __enter__(self): return self
        def __exit__(self, *a): return False
    def fake_urlopen(req, timeout=60):
        captured["url"] = req.full_url
        captured["ctype"] = req.headers.get("Content-type")
        captured["body"] = req.data
        return FakeResp()
    monkeypatch.setattr(telegram_api.urllib.request, "urlopen", fake_urlopen)
    tg = telegram_api.Telegram("TOK")
    tg.send_document(123, str(doc), caption="Kopf")
    assert captured["url"].endswith("/sendDocument")
    assert "multipart/form-data" in captured["ctype"]
    assert b"inhalt" in captured["body"]
    assert b"Kopf" in captured["body"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/voice-echo-bot && python3 -m pytest test_telegram_api.py -k document -v`
Expected: FAIL (`AttributeError: 'Telegram' object has no attribute 'send_document'`)

- [ ] **Step 3: Write minimal implementation**

Add to the `Telegram` class in `telegram_api.py` (reuse the multipart pattern from `send_voice`, but generic content type):

```python
    def send_document(self, chat_id, file_path, caption=None):
        fields = {"chat_id": str(chat_id)}
        if caption:
            fields["caption"] = caption
        with open(file_path, "rb") as fh:
            content = fh.read()
        boundary = uuid.uuid4().hex
        body = self._encode_multipart(
            fields, "document", os.path.basename(file_path) or "file.txt",
            content, boundary, content_type="text/plain")
        req = urllib.request.Request(
            "{}/{}".format(self.api, "sendDocument"), data=body,
            headers={"Content-Type": "multipart/form-data; boundary={}".format(boundary)})
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8")).get("result")
```

And extend `_encode_multipart` to accept the content type (default keeps `send_voice` working):

```python
    @staticmethod
    def _encode_multipart(fields, file_field, filename, file_bytes, boundary,
                          content_type="audio/ogg"):
        # … unchanged, but replace the hardcoded b"Content-Type: audio/ogg" line with:
        parts.append("Content-Type: {}".format(content_type).encode("utf-8"))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tools/voice-echo-bot && python3 -m pytest test_telegram_api.py -v`
Expected: PASS (incl. existing send_voice test — default content_type preserves it)

- [ ] **Step 5: Commit**

```bash
git add tools/voice-echo-bot/telegram_api.py tools/voice-echo-bot/test_telegram_api.py
git commit -m "feat(jarvis): Telegram.send_document (multipart, generischer Content-Type)"
```

---

## Task 6: Bot-SEO-Gate `seo_gate.py`

**Files:**
- Create: `tools/voice-echo-bot/seo_gate.py`
- Test: `tools/voice-echo-bot/test_seo_gate.py`

**Interfaces:**
- Consumes: Token-JSON aus `~/.paperclip/state/seo-approvals/` (stdlib `json`, kein seo-geo-Import)
- Produces:
  - `parse_callback(data) -> tuple[str, str] | None` → `("ok"|"no", token)` oder None
  - `load_token(approvals_dir, token) -> dict | None`
  - `apply_token(cfg, rec, *, runner=None) -> str` → Ergebnistext; ruft approve+apply via Subprozess, liest ApplyLog
  - `reject_token(cfg, rec) -> str` (setzt Status `rejected` + verschiebt Changeset nach `rejected/`)
  - `note_token(cfg, token, text) -> None` (legt Freitext-Notiz am Token ab, kein Auto-Apply)
  - `summarize_last_apply(site_dir) -> tuple[int, int]` → `(applied, failed)`
- `cfg`-Felder: `approvals_dir, seo_geo_venv, seo_geo_cli, seo_geo_root, seo_geo_sites`

- [ ] **Step 1: Write the failing test**

```python
# test_seo_gate.py
import json, os
import seo_gate

def test_parse_callback():
    assert seo_gate.parse_callback("seo:ok:ABC") == ("ok", "ABC")
    assert seo_gate.parse_callback("seo:no:XY") == ("no", "XY")
    assert seo_gate.parse_callback("other:stuff") is None
    assert seo_gate.parse_callback("") is None

def _cfg(tmp_path):
    # seo_geo_root MUSS auf tmp zeigen — sonst schreibt der Test in echte Verzeichnisse.
    return {"approvals_dir": str(tmp_path / "appr"),
            "seo_geo_venv": "/v/python", "seo_geo_cli": "/c/cli.py",
            "seo_geo_root": str(tmp_path / "sgroot"), "seo_geo_sites": "/s/sites.json"}

def test_apply_token_runs_approve_then_apply(tmp_path):
    cfg = _cfg(tmp_path)
    rec = {"token": "T", "site": "whitestag.film", "status": "pending",
           "changeset_path": "/p/cs.json", "count": 79}
    ran = []
    def runner(argv):
        ran.append(argv); return 0
    # applied/failed-Verzeichnisse simulieren
    sdir = os.path.expanduser(os.path.join(cfg["seo_geo_root"], "whitestag.film"))
    os.makedirs(os.path.join(sdir, "applied"), exist_ok=True)
    with open(os.path.join(sdir, "applied", "apply-log.cs.json.json"), "w") as fh:
        json.dump({"applied": [1]*79, "skipped": [], "failed": []}, fh)
    msg = seo_gate.apply_token(cfg, rec, runner=runner)
    assert any("approve" in a for a in ran[0])
    assert any("apply" in a for a in ran[1])
    assert "79" in msg and "0" in msg  # "79 angewendet, 0 Fehler"

def test_apply_token_idempotent(tmp_path):
    cfg = _cfg(tmp_path)
    rec = {"token": "T", "site": "s", "status": "applied", "count": 1}
    msg = seo_gate.apply_token(cfg, rec, runner=lambda a: 0)
    assert "bereits" in msg.lower()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tools/voice-echo-bot && python3 -m pytest test_seo_gate.py -v`
Expected: FAIL (`ModuleNotFoundError`)

- [ ] **Step 3: Write minimal implementation**

```python
# seo_gate.py
"""SEO-Freigabe-Callback-Logik für den Jarvis-Bot (stdlib only).

Liest das gemeinsame Token-JSON (vom seo-geo-Dienst geschrieben) und ruft
approve+apply deterministisch via Subprozess über das seo-geo-venv auf. Kein
Import von seo-geo — nur das JSON-Format ist geteilt."""
import json, os, shutil, subprocess

def parse_callback(data):
    parts = (data or "").split(":")
    if len(parts) == 3 and parts[0] == "seo" and parts[1] in ("ok", "no"):
        return parts[1], parts[2]
    return None

def load_token(approvals_dir, token):
    path = os.path.join(os.path.expanduser(approvals_dir), token + ".json")
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return None

def _set_status(approvals_dir, token, status, note=None):
    rec = load_token(approvals_dir, token)
    if rec is None:
        return
    rec["status"] = status
    if note is not None:
        rec["note"] = note
    path = os.path.join(os.path.expanduser(approvals_dir), token + ".json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(rec, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, path)

def summarize_last_apply(site_dir):
    for sub in ("applied", "failed"):
        d = os.path.join(site_dir, sub)
        if not os.path.isdir(d):
            continue
        logs = sorted(f for f in os.listdir(d) if f.startswith("apply-log."))
        if logs:
            data = json.load(open(os.path.join(d, logs[-1])))
            return len(data.get("applied", [])), len(data.get("failed", []))
    return 0, 0

def _run(cfg, runner, subcmd_argv):
    argv = [cfg["seo_geo_venv"], cfg["seo_geo_cli"]] + subcmd_argv
    return runner(argv) if runner else subprocess.run(argv).returncode

def apply_token(cfg, rec, *, runner=None):
    if rec.get("status") != "pending":
        return "ℹ️ Diese Freigabe wurde bereits bearbeitet ({}).".format(rec.get("status"))
    root = cfg["seo_geo_root"]
    _run(cfg, runner, ["approve", "--changeset", rec["changeset_path"], "--root", root])
    rc = _run(cfg, runner, ["apply", "--site", rec["site"],
                            "--sites", cfg["seo_geo_sites"], "--root", root])
    site_dir = os.path.expanduser(os.path.join(root, rec["site"]))
    applied, failed = summarize_last_apply(site_dir)
    status = "failed" if (failed or rc != 0) else "applied"
    _set_status(cfg["approvals_dir"], rec["token"], status)
    if status == "applied":
        return "✅ {} live — {} angewendet, {} Fehler".format(rec["site"], applied, failed)
    return "⚠️ {} — {} angewendet, {} Fehler. Bitte prüfen.".format(rec["site"], applied, failed)

def reject_token(cfg, rec):
    if rec.get("status") != "pending":
        return "ℹ️ Bereits bearbeitet ({}).".format(rec.get("status"))
    _set_status(cfg["approvals_dir"], rec["token"], "rejected")
    # Changeset aus pending/ nach rejected/ verschieben (Spec-Anforderung).
    src = rec.get("changeset_path")
    if src and os.path.isfile(src):
        rej = os.path.join(os.path.dirname(os.path.dirname(src)), "rejected")
        os.makedirs(rej, exist_ok=True)
        shutil.move(src, os.path.join(rej, os.path.basename(src)))
    return "❌ {} abgelehnt. Grund? (Antwort optional)".format(rec["site"])

def note_token(cfg, token, text):
    """Legt Walters Freitext-Antwort als Notiz am Token ab (kein Auto-Apply)."""
    rec = load_token(cfg["approvals_dir"], token)
    if rec is None:
        return
    rec["note"] = text
    path = os.path.join(os.path.expanduser(cfg["approvals_dir"]), token + ".json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(rec, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, path)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tools/voice-echo-bot && python3 -m pytest test_seo_gate.py -v`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add tools/voice-echo-bot/seo_gate.py tools/voice-echo-bot/test_seo_gate.py
git commit -m "feat(jarvis): SEO-Freigabe-Gate (callback-parse, approve+apply, Idempotenz)"
```

---

## Task 7: Bot-Integration in `bot.py` + `config.py`

**Files:**
- Modify: `tools/voice-echo-bot/config.py`
- Modify: `tools/voice-echo-bot/bot.py`
- Test: `tools/voice-echo-bot/test_bot.py` (ergänzen)

**Interfaces:**
- Consumes: `seo_gate.parse_callback/load_token/apply_token/reject_token`
- Produces: `BotApp.handle_update` bedient jetzt `callback_query` mit `seo:`-Präfix; Reply auf eine SEO-Push-Nachricht legt eine Notiz am Token ab.

- [ ] **Step 1: Write the failing test**

```python
# test_bot.py (ergänzen)
def test_seo_callback_only_walter(make_app):
    app, tg = make_app()  # bestehende Fixture; Walter-Chat = 8311805232
    calls = []
    # seo_gate.apply_token gemockt über cfg-Runner: hier prüfen wir Dispatch + Chat-Guard
    update = {"callback_query": {"id": "cq1", "data": "seo:ok:TOK",
              "from": {"id": 999999}, "message": {"chat": {"id": 999999}}}}
    app.handle_update(update)
    # fremder Chat -> answerCallbackQuery mit Ablehnung, KEIN apply
    assert any("nicht berechtigt" in (c.get("text","")) for c in tg.answered)

def test_seo_callback_walter_applies(make_app, monkeypatch, tmp_path):
    app, tg = make_app()
    import seo_gate
    monkeypatch.setattr(seo_gate, "load_token", lambda d, t: {"token": t, "site": "s",
                        "status": "pending", "changeset_path": "/c.json"})
    monkeypatch.setattr(seo_gate, "apply_token", lambda cfg, rec, **k: "✅ s live — 3 angewendet, 0 Fehler")
    update = {"callback_query": {"id": "cq2", "data": "seo:ok:TOK",
              "from": {"id": 8311805232}, "message": {"chat": {"id": 8311805232}}}}
    app.handle_update(update)
    assert any("live" in m["text"] for m in tg.sent)
```

(If `make_app`/`tg` fakes don't yet expose `answered`/`sent`, extend the existing test doubles in `test_bot.py` minimally to record `answer_callback_query` and `send_message` calls.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/voice-echo-bot && python3 -m pytest test_bot.py -k seo -v`
Expected: FAIL (callback_query nicht behandelt)

- [ ] **Step 3: Write minimal implementation**

Add SEO config to `config.py`:

```python
# --- SEO/GEO-Freigaben ---
SEO_APPROVALS_DIR = os.path.expanduser("~/.paperclip/state/seo-approvals")
SEO_GEO_VENV = os.path.expanduser("~/.paperclip/scripts/seo-geo/venv/bin/python")
SEO_GEO_CLI = os.path.expanduser("~/.paperclip/scripts/seo-geo/cli.py")
SEO_GEO_ROOT = "~/.paperclip/seo-geo"
SEO_GEO_SITES = os.path.expanduser("~/.paperclip/scripts/seo-geo/sites.json")
WALTER_CHAT_ID = 8311805232
```

Extend `handle_update` in `bot.py` (add the `callback_query` branch that was removed — but scoped to `seo:`):

```python
    def handle_update(self, update):
        if "callback_query" in update:
            self._handle_seo_callback(update["callback_query"])
            return
        if "message" in update:
            msg = update["message"]
            tenant = tenants_mod.resolve_tenant(self.cfg["tenants"], msg.get("from", {}).get("id"))
            if tenant:
                self._handle_message(tenant, msg)

    def _seo_cfg(self):
        return {"approvals_dir": config.SEO_APPROVALS_DIR,
                "seo_geo_venv": config.SEO_GEO_VENV, "seo_geo_cli": config.SEO_GEO_CLI,
                "seo_geo_root": config.SEO_GEO_ROOT, "seo_geo_sites": config.SEO_GEO_SITES}

    def _handle_seo_callback(self, cq):
        import seo_gate
        parsed = seo_gate.parse_callback(cq.get("data"))
        if not parsed:
            return
        chat_id = cq.get("message", {}).get("chat", {}).get("id")
        if cq.get("from", {}).get("id") != config.WALTER_CHAT_ID:
            self.tg.answer_callback_query(cq["id"], "nicht berechtigt")
            return
        self.tg.answer_callback_query(cq["id"])
        action, token = parsed
        rec = seo_gate.load_token(config.SEO_APPROVALS_DIR, token)
        if rec is None:
            self.tg.send_message(chat_id, "⚠️ Freigabe nicht mehr gefunden (abgelaufen?).")
            return
        if action == "ok":
            self.tg.send_message(chat_id, "⏳ Wende an …")
            msg = seo_gate.apply_token(self._seo_cfg(), rec)
        else:
            msg = seo_gate.reject_token(self._seo_cfg(), rec)
        self.tg.send_message(chat_id, msg + "\n\n(Token {})".format(token))
```

For the reply-note special case, extend `_handle_message`: before the existing `reply_to` Ident-Match, check whether the quoted message text contains `Token <tok>` (regex `Token (\w+)`). If so, call `seo_gate.note_token(self._seo_cfg(), tok, text)` with the reply's extracted text and confirm to the user (`"📝 Notiz zur Freigabe {} gespeichert — ich ziehe das manuell nach."`), then return. No auto-apply. Add a focused test:

```python
def test_reply_with_token_stores_note(make_app, monkeypatch):
    app, tg = make_app()
    noted = {}
    import seo_gate
    monkeypatch.setattr(seo_gate, "note_token", lambda cfg, tok, txt: noted.update({tok: txt}))
    msg = {"chat": {"id": 8311805232}, "message_id": 5,
           "from": {"id": 8311805232}, "text": "nur die Startseite bitte",
           "reply_to_message": {"text": "🟢 SEO-Freigabe film …\n\n(Token ABC)"}}
    app._handle_message(app.cfg["tenants"].get("8311805232") or
                        list(app.cfg["tenants"].values())[0], msg)
    assert noted.get("ABC") == "nur die Startseite bitte"
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tools/voice-echo-bot && python3 -m pytest test_bot.py -v`
Expected: PASS (incl. existing bot tests)

- [ ] **Step 5: Commit**

```bash
git add tools/voice-echo-bot/bot.py tools/voice-echo-bot/config.py tools/voice-echo-bot/test_bot.py
git commit -m "feat(jarvis): SEO-Callback-Dispatch + Chat-Guard in handle_update"
```

---

## Task 8: Re-Ping-Subcommand + launchd

**Files:**
- Modify: `tools/seo-geo/cli.py` (Subcommand `reping`)
- Test: `tools/seo-geo/test_cli.py` (ergänzen)
- Create: `tools/seo-geo/de.whitestag.seo-geo-reping.plist`

**Interfaces:**
- Consumes: `seo_approvals.list_pending`, `telegram_push.push_text`/`load_bot_token`
- Produces: CLI `seo-geo reping --approvals-dir <dir> --bot-env <pfad> --older-than-hours 24` → pusht je offenem Token einen Re-Ping, setzt `last_reping`, ein Ping pro Token.

- [ ] **Step 1: Write the failing test**

```python
# test_cli.py (ergänzen)
def test_reping_pings_only_stale_once(tmp_path):
    (tmp_path / "bot.env").write_text('TELEGRAM_BOT_TOKEN="1:A"\n')
    import seo_approvals as sa
    ad = str(tmp_path / "appr")
    sa.create(ad, "film", "/c.json", "/l.txt", 5, 0, 42, token="OLD", now=0.0)
    pings = []
    rc = cli.main(["reping", "--approvals-dir", ad, "--bot-env", str(tmp_path / "bot.env"),
                   "--older-than-hours", "24"], os.environ,
                  pusher=lambda *a, **k: pings.append(a), now=100000.0)
    assert rc == 0 and len(pings) == 1
    # zweiter Lauf: last_reping gesetzt -> kein zweiter Ping
    rc2 = cli.main(["reping", "--approvals-dir", ad, "--bot-env", str(tmp_path / "bot.env"),
                    "--older-than-hours", "24"], os.environ,
                   pusher=lambda *a, **k: pings.append(a), now=100050.0)
    assert len(pings) == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest test_cli.py -k reping -v`
Expected: FAIL (unknown command `reping`)

- [ ] **Step 3: Write minimal implementation**

Add to `cli.py` (handler reuses `push_text`; `now` param on `main` for tests). Guard `last_reping` so each token pings once:

```python
def _cmd_reping(args, environ, pusher, now):
    import seo_approvals as sa
    ad = os.path.expanduser(args.approvals_dir)
    pend = sa.list_pending(ad, older_than_hours=int(args.older_than_hours), now=now)
    n = 0
    for rec in pend:
        if rec.get("last_reping"):
            continue
        days = int((now - rec.get("created", now)) / 86400)
        pusher(rec["chat_id"], "⏳ SEO-Freigabe {} wartet seit {} Tag(en).".format(
            rec["site"], days), args.bot_env)
        rec["last_reping"] = now
        sa._write_atomic(sa._path(ad, rec["token"]), rec)
        n += 1
    print(f"RE-PING — {n} Erinnerung(en)")
    return 0

def _default_text_pusher(chat_id, text, bot_env):
    from telegram_push import push_text, load_bot_token
    push_text(load_bot_token(bot_env), chat_id, text)
```

Wire into `main`: add `now=None` param (`now = time.time() if now is None else now`), register the `reping` subparser (`--approvals-dir --bot-env --older-than-hours`), and for `reping` pass `pusher or _default_text_pusher`. Note: `notify` and `reping` use different pusher signatures — resolve `reping`'s default separately inside the dispatch, not from the shared `pusher` param.

Create the launchd plist (`de.whitestag.seo-geo-reping.plist`) — daily 08:00, calls the deployed CLI:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>de.whitestag.seo-geo-reping</string>
  <key>ProgramArguments</key><array>
    <string>/Users/walterschoenenbroecher.de/.paperclip/scripts/seo-geo/venv/bin/python</string>
    <string>/Users/walterschoenenbroecher.de/.paperclip/scripts/seo-geo/cli.py</string>
    <string>reping</string>
    <string>--approvals-dir</string><string>/Users/walterschoenenbroecher.de/.paperclip/state/seo-approvals</string>
    <string>--bot-env</string><string>/Users/walterschoenenbroecher.de/.paperclip/voice-echo-bot.env</string>
    <string>--older-than-hours</string><string>24</string>
  </array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardErrorPath</key><string>/Users/walterschoenenbroecher.de/.paperclip/logs/seo-geo-reping.err</string>
  <key>StandardOutPath</key><string>/Users/walterschoenenbroecher.de/.paperclip/logs/seo-geo-reping.out</string>
</dict></plist>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tools/seo-geo && ./venv/bin/python -m pytest test_cli.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tools/seo-geo/cli.py tools/seo-geo/test_cli.py tools/seo-geo/de.whitestag.seo-geo-reping.plist
git commit -m "feat(seo-geo): täglicher Re-Ping für offene Freigaben (24h, ein Ping/Token)"
```

---

## Task 9: Deploy + Live-Verifikation

**Files:** (keine Codeänderung — Deploy)

- [ ] **Step 1: Deploy seo-geo**

```bash
cd "…/Paperclip"
rsync -a --exclude venv --exclude __pycache__ --exclude .pytest_cache \
  tools/seo-geo/ ~/.paperclip/scripts/seo-geo/
```

- [ ] **Step 2: Deploy Jarvis-Bot + kickstart**

```bash
cp tools/voice-echo-bot/*.py ~/.paperclip/scripts/voice-echo-bot/
launchctl kickstart -k gui/501/de.whitestag.voice-echo-bot
```

- [ ] **Step 3: Re-Ping-launchd installieren**

```bash
cp tools/seo-geo/de.whitestag.seo-geo-reping.plist ~/Library/LaunchAgents/
mkdir -p ~/.paperclip/logs
launchctl bootstrap gui/501 ~/Library/LaunchAgents/de.whitestag.seo-geo-reping.plist
launchctl list | grep seo-geo-reping   # muss auftauchen
```

- [ ] **Step 4: Live-Test mit whitestag.film (das reife Paket)**

```bash
cd ~/.paperclip/scripts/seo-geo
./venv/bin/python cli.py notify --site whitestag.film \
  --changeset ~/.paperclip/seo-geo/whitestag.film/pending/changeset-01-resolved.json \
  --approvals-dir ~/.paperclip/state/seo-approvals \
  --list-dir ~/.paperclip/state/seo-approvals/lists \
  --bot-env ~/.paperclip/voice-echo-bot.env --chat-id 8311805232
```
Erwartet: Walter bekommt im Jarvis-Chat das Dokument + Buttons. Tippt **[✅ Freigeben]** → „⏳ Wende an …" → „✅ whitestag.film live — N angewendet, 0 Fehler". Danach im WP-Backend / per REST stichprobenartig verifizieren, dass die Meta-Werte stehen.

- [ ] **Step 5: Verifikation dokumentieren**

Ergebnis (angewendete Anzahl, Fehler, geprüfte Stichprobe) festhalten. Bei Fehlern: `~/.paperclip/seo-geo/whitestag.film/failed/apply-log.*.json` lesen.

---

## Notes für den Umsetzer

- **`test_bot.py`-Fixtures:** Die bestehenden Test-Doubles (`Telegram`-Fake) müssen ggf. um das Aufzeichnen von `answer_callback_query` und `send_message` erweitert werden — minimal halten, dem vorhandenen Muster folgen.
- **Reihenfolge:** Tasks 1–4 (seo-geo) und 5–7 (Bot) sind bis auf das gemeinsame Token-JSON-Format unabhängig; das Format ist in Task 1 festgelegt. Task 8 hängt an 1+3, Task 9 an allem.
- **Kein Live-Telegram im Test** — jeder Netz-/Subprozess-Pfad ist injizierbar (`pusher`, `runner`, `sender`, `monkeypatch` auf `urlopen`).
