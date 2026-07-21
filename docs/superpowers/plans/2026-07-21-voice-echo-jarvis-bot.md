# Voice-Echo Jarvis-Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein Telegram-Bot (`@whitestag_jarvis_bot`), dem nur Walter schreiben darf; er transkribiert Sprachnachrichten lokal mit whisper.cpp, zeigt das Transkript zur Bestätigung und legt es als Issue beim WHITESTAG-CEO an.

**Architecture:** Ein stdlib-only Python-Dienst pollt die Telegram-Bot-API per Long-Polling (kein Webhook, nichts nach außen exponiert). Eingehende Sprach-/Textnachrichten werden gegen eine User-ID-Allowlist geprüft, Voice via `ffmpeg`+`whisper-cli` (on-demand, RAM danach frei) transkribiert, mit Inline-Buttons bestätigt und über die Paperclip-REST-API als Issue an den CEO gesendet. Entwickelt und getestet im Repo unter `tools/voice-echo-bot/`, betrieben als launchd-Dienst aus `~/.paperclip/scripts/voice-echo-bot/`.

**Tech Stack:** Python 3 (nur Standardbibliothek: `urllib`, `json`, `subprocess`, `unittest`), whisper.cpp (`whisper-cli`), ffmpeg, Telegram Bot HTTP API, Paperclip REST API, macOS launchd.

## Global Constraints

- **Nur Python-Standardbibliothek** — keine pip-Abhängigkeiten (Muster wie `tools/n8n-workflow-watcher/`). Tests mit `unittest`.
- **Modulnamen mit Unterstrich** (`telegram_api.py`, `paperclip_client.py`) — Verzeichnisname `voice-echo-bot` hat Bindestriche, daher Tests immer aus dem Verzeichnis heraus per bloßem Modulnamen importieren (`cd tools/voice-echo-bot`).
- **Secrets NICHT ins Git-Repo.** Telegram-Token + User-ID liegen in `~/.paperclip/voice-echo-bot.env` (bereits angelegt, Rechte 600). Paperclip-Token wird zur Laufzeit aus `~/.paperclip/auth.json` gelesen (auto-renewt).
- **Fixe Werte (verbatim):**
  - Telegram-Bot: `@whitestag_jarvis_bot`, ID `8757029765`
  - Erlaubte User-ID: `8311805232` (Walter)
  - WHITESTAG company_id: `9cebf3cf-efe8-4597-a400-f06488900a87`
  - CEO agent_id: `506c873e-3a40-4483-9a45-0eb0fa1554bb`
  - Paperclip API base: `http://127.0.0.1:3100/api`
  - auth.json Token-Pfad: `data["credentials"]["http://localhost:3100"]["token"]`
  - Whisper-Modell: `~/.paperclip/models/whisper/ggml-large-v3-turbo.bin`
- **launchd kann CloudStorage/SynologyDrive nicht lesen** → Laufzeit-Code + Modell liegen unter `~/.paperclip/`, niemals im SynologyDrive-Repo-Pfad.
- Alle Git-Commits gehen in das Paperclip-Repo (Working-Dir `…/Claude Code MAC/Paperclip`). Commit-Nachrichten enden mit `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File Structure

Repo (git-getrackt, Entwicklung + Tests), alle unter `tools/voice-echo-bot/`:
- `config.py` — lädt Konfiguration aus `.env` + Paperclip-Token aus `auth.json`
- `telegram_api.py` — dünner Bot-API-Client (get_updates, send_message, answer_callback_query, get_file, download_file)
- `transcribe.py` — ffmpeg → 16 kHz WAV → whisper-cli → deutscher Text
- `paperclip_client.py` — `derive_title()` + `create_issue()` (POST an CEO)
- `bot.py` — Long-Poll-Schleife, Allowlist-Gate, Kandidaten-Speicher, Handler
- `test_config.py`, `test_telegram_api.py`, `test_transcribe.py`, `test_paperclip_client.py`, `test_bot.py`
- `de.whitestag.voice-echo-bot.plist` — launchd-Vorlage
- `DEPLOY.md` — Deploy-Anleitung

Außerhalb des Repos:
- `~/.paperclip/voice-echo-bot.env` — Secrets (existiert)
- `~/.paperclip/models/whisper/ggml-large-v3-turbo.bin` — Modell
- `~/.paperclip/scripts/voice-echo-bot/` — Laufzeit-Deploy (launchd)
- `~/Library/LaunchAgents/de.whitestag.voice-echo-bot.plist` — installierter launchd-Job

---

### Task 1: Whisper-Modell bereitstellen

**Files:**
- Create: `~/.paperclip/models/whisper/ggml-large-v3-turbo.bin` (Download, nicht im Git)

**Interfaces:**
- Produces: Ein funktionsfähiges ggml-Modell unter dem in den Global Constraints fixierten Pfad, das `whisper-cli` verarbeiten kann.

- [ ] **Step 1: Zielverzeichnis anlegen und Modell laden**

```bash
mkdir -p ~/.paperclip/models/whisper
curl -L --fail -o ~/.paperclip/models/whisper/ggml-large-v3-turbo.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
```

- [ ] **Step 2: Download prüfen (Größe > 1 GB)**

Run:
```bash
ls -lh ~/.paperclip/models/whisper/ggml-large-v3-turbo.bin
```
Expected: Datei existiert, Größe ~1,5–1,7 GB (nicht wenige KB — das wäre eine HTML-Fehlerseite).

- [ ] **Step 3: Modell mit echtem Sample verifizieren**

Run (englisches JFK-Sample, das mit whisper.cpp mitgeliefert wird):
```bash
JFK=$(find /opt/homebrew -name jfk.wav | head -1)
whisper-cli -m ~/.paperclip/models/whisper/ggml-large-v3-turbo.bin -l en -nt -np -f "$JFK"
```
Expected: Transkribierter Satz erscheint (sinngemäß „And so, my fellow Americans, ask not what your country can do for you…"). Exit-Code 0.

- [ ] **Step 4: Commit** — entfällt (Binärdatei außerhalb des Repos, kein Git-Commit).

---

### Task 2: `config.py` — Konfiguration + Token laden

**Files:**
- Create: `tools/voice-echo-bot/config.py`
- Test: `tools/voice-echo-bot/test_config.py`

**Interfaces:**
- Produces:
  - `load_env(path) -> dict` — parst eine einfache `KEY="value"`-Env-Datei zu einem dict (ignoriert Kommentar-/Leerzeilen, entfernt umschließende Quotes und ein optionales `export `-Präfix).
  - `load_paperclip_token(auth_path) -> str` — liest `data["credentials"]["http://localhost:3100"]["token"]` aus einer auth.json.
  - Modul-Konstanten aus den Global Constraints: `API_BASE = "http://127.0.0.1:3100/api"`, `AUTH_JSON = <expanduser ~/.paperclip/auth.json>`, `ENV_PATH = <expanduser ~/.paperclip/voice-echo-bot.env>`.

- [ ] **Step 1: Write the failing test**

```python
# tools/voice-echo-bot/test_config.py
import json
import os
import tempfile
import unittest

import config


class TestLoadEnv(unittest.TestCase):
    def test_parses_quoted_and_export_lines_ignoring_comments(self):
        with tempfile.NamedTemporaryFile("w", suffix=".env", delete=False) as f:
            f.write('# comment\n')
            f.write('\n')
            f.write('export TELEGRAM_BOT_TOKEN="abc:123"\n')
            f.write('TELEGRAM_ALLOWED_USER_ID="8311805232"\n')
            path = f.name
        self.addCleanup(os.unlink, path)
        env = config.load_env(path)
        self.assertEqual(env["TELEGRAM_BOT_TOKEN"], "abc:123")
        self.assertEqual(env["TELEGRAM_ALLOWED_USER_ID"], "8311805232")
        self.assertNotIn("# comment", env)


class TestLoadToken(unittest.TestCase):
    def test_reads_localhost_3100_token(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump({"credentials": {"http://localhost:3100": {"token": "tok-xyz"}}}, f)
            path = f.name
        self.addCleanup(os.unlink, path)
        self.assertEqual(config.load_paperclip_token(path), "tok-xyz")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/voice-echo-bot && python3 -m unittest test_config -v`
Expected: FAIL mit `ModuleNotFoundError: No module named 'config'`.

- [ ] **Step 3: Write minimal implementation**

```python
# tools/voice-echo-bot/config.py
"""Konfiguration für den Voice-Echo Jarvis-Bot (stdlib only)."""
import json
import os

API_BASE = "http://127.0.0.1:3100/api"
AUTH_JSON = os.path.expanduser("~/.paperclip/auth.json")
ENV_PATH = os.path.expanduser("~/.paperclip/voice-echo-bot.env")


def load_env(path):
    """Parst eine einfache KEY="value"-Env-Datei zu einem dict."""
    env = {}
    with open(path, "r", encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            if line.startswith("export "):
                line = line[len("export "):]
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key:
                env[key] = value
    return env


def load_paperclip_token(auth_path=AUTH_JSON):
    """Liest das Board-Token aus der auth.json (auto-renewt)."""
    with open(auth_path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    return data["credentials"]["http://localhost:3100"]["token"]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/voice-echo-bot && python3 -m unittest test_config -v`
Expected: PASS (2 Tests).

- [ ] **Step 5: Commit**

```bash
git add tools/voice-echo-bot/config.py tools/voice-echo-bot/test_config.py
git commit -m "feat(voice-echo): config loader (env + paperclip token)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `telegram_api.py` — Bot-API-Client

**Files:**
- Create: `tools/voice-echo-bot/telegram_api.py`
- Test: `tools/voice-echo-bot/test_telegram_api.py`

**Interfaces:**
- Consumes: nichts aus anderen Tasks.
- Produces: Klasse `Telegram(token)` mit Methoden:
  - `get_updates(offset=None, timeout=50) -> list` — Liste der `result`-Updates.
  - `send_message(chat_id, text, reply_markup=None) -> dict` — gibt das `result`-Objekt (mit `message_id`) zurück.
  - `answer_callback_query(callback_query_id, text=None)` — bestätigt einen Button-Klick.
  - `get_file_path(file_id) -> str` — der `file_path` aus `getFile`.
  - `download_file(file_path, dest)` — lädt `…/file/bot<token>/<file_path>` nach `dest`.
  - Interne `_call(method, params)`-Hilfe, die POST-JSON an `https://api.telegram.org/bot<token>/<method>` schickt und `result` zurückgibt.

- [ ] **Step 1: Write the failing test**

```python
# tools/voice-echo-bot/test_telegram_api.py
import json
import unittest
from unittest import mock

import telegram_api


def _fake_response(payload):
    m = mock.MagicMock()
    m.read.return_value = json.dumps(payload).encode("utf-8")
    m.__enter__.return_value = m
    m.__exit__.return_value = False
    return m


class TestTelegram(unittest.TestCase):
    def setUp(self):
        self.tg = telegram_api.Telegram("123:ABC")

    def test_send_message_returns_result_and_posts_json(self):
        with mock.patch("telegram_api.urllib.request.urlopen",
                        return_value=_fake_response({"ok": True, "result": {"message_id": 10}})) as uo:
            res = self.tg.send_message(555, "hi", reply_markup={"inline_keyboard": []})
        self.assertEqual(res["message_id"], 10)
        req = uo.call_args[0][0]
        self.assertIn("/bot123:ABC/sendMessage", req.full_url)
        body = json.loads(req.data.decode("utf-8"))
        self.assertEqual(body["chat_id"], 555)
        self.assertEqual(body["text"], "hi")
        self.assertEqual(body["reply_markup"], {"inline_keyboard": []})

    def test_get_updates_returns_result_list(self):
        with mock.patch("telegram_api.urllib.request.urlopen",
                        return_value=_fake_response({"ok": True, "result": [{"update_id": 1}]})):
            updates = self.tg.get_updates(offset=7, timeout=0)
        self.assertEqual(updates, [{"update_id": 1}])

    def test_get_file_path_extracts_file_path(self):
        with mock.patch("telegram_api.urllib.request.urlopen",
                        return_value=_fake_response({"ok": True, "result": {"file_path": "voice/file_1.oga"}})):
            self.assertEqual(self.tg.get_file_path("fid"), "voice/file_1.oga")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/voice-echo-bot && python3 -m unittest test_telegram_api -v`
Expected: FAIL mit `ModuleNotFoundError: No module named 'telegram_api'`.

- [ ] **Step 3: Write minimal implementation**

```python
# tools/voice-echo-bot/telegram_api.py
"""Dünner Telegram-Bot-API-Client (stdlib only)."""
import json
import shutil
import urllib.request


class Telegram:
    def __init__(self, token):
        self.token = token
        self.api = "https://api.telegram.org/bot{}".format(token)
        self.file_api = "https://api.telegram.org/file/bot{}".format(token)

    def _call(self, method, params, timeout=60):
        data = json.dumps(params).encode("utf-8")
        req = urllib.request.Request(
            "{}/{}".format(self.api, method),
            data=data,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        return payload.get("result")

    def get_updates(self, offset=None, timeout=50):
        params = {"timeout": timeout}
        if offset is not None:
            params["offset"] = offset
        return self._call("getUpdates", params, timeout=timeout + 10) or []

    def send_message(self, chat_id, text, reply_markup=None):
        params = {"chat_id": chat_id, "text": text}
        if reply_markup is not None:
            params["reply_markup"] = reply_markup
        return self._call("sendMessage", params)

    def answer_callback_query(self, callback_query_id, text=None):
        params = {"callback_query_id": callback_query_id}
        if text:
            params["text"] = text
        return self._call("answerCallbackQuery", params)

    def get_file_path(self, file_id):
        result = self._call("getFile", {"file_id": file_id})
        return result["file_path"]

    def download_file(self, file_path, dest):
        url = "{}/{}".format(self.file_api, file_path)
        with urllib.request.urlopen(url, timeout=60) as resp, open(dest, "wb") as out:
            shutil.copyfileobj(resp, out)
        return dest
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/voice-echo-bot && python3 -m unittest test_telegram_api -v`
Expected: PASS (3 Tests).

- [ ] **Step 5: Commit**

```bash
git add tools/voice-echo-bot/telegram_api.py tools/voice-echo-bot/test_telegram_api.py
git commit -m "feat(voice-echo): Telegram bot API client

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `transcribe.py` — ffmpeg + whisper-cli

**Files:**
- Create: `tools/voice-echo-bot/transcribe.py`
- Test: `tools/voice-echo-bot/test_transcribe.py`

**Interfaces:**
- Consumes: nichts aus anderen Tasks.
- Produces: `transcribe(ogg_path, model, workdir=None) -> str` — konvertiert die Audiodatei via `ffmpeg` nach 16 kHz mono WAV, ruft `whisper-cli -m <model> -l de -nt -np -otxt -of <prefix> -f <wav>` und liefert den getrimmten Text aus `<prefix>.txt`. Wirft `TranscriptionError` bei ffmpeg-/whisper-Fehlern.

- [ ] **Step 1: Write the failing test**

```python
# tools/voice-echo-bot/test_transcribe.py
import os
import tempfile
import unittest
from unittest import mock

import transcribe


class TestTranscribe(unittest.TestCase):
    def test_runs_ffmpeg_then_whisper_and_returns_text(self):
        workdir = tempfile.mkdtemp()
        ogg = os.path.join(workdir, "in.oga")
        open(ogg, "wb").close()

        def fake_run(cmd, **kwargs):
            if cmd[0] == "whisper-cli":
                # -of <prefix> steht direkt vor -f <wav>; schreibe <prefix>.txt
                prefix = cmd[cmd.index("-of") + 1]
                with open(prefix + ".txt", "w", encoding="utf-8") as fh:
                    fh.write("  Kaufe Milch und rufe den Steuerberater an.  \n")
            return mock.MagicMock(returncode=0)

        with mock.patch("transcribe.subprocess.run", side_effect=fake_run):
            text = transcribe.transcribe(ogg, "model.bin", workdir=workdir)
        self.assertEqual(text, "Kaufe Milch und rufe den Steuerberater an.")

    def test_raises_on_ffmpeg_failure(self):
        workdir = tempfile.mkdtemp()
        ogg = os.path.join(workdir, "in.oga")
        open(ogg, "wb").close()
        import subprocess

        def boom(cmd, **kwargs):
            raise subprocess.CalledProcessError(1, cmd)

        with mock.patch("transcribe.subprocess.run", side_effect=boom):
            with self.assertRaises(transcribe.TranscriptionError):
                transcribe.transcribe(ogg, "model.bin", workdir=workdir)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/voice-echo-bot && python3 -m unittest test_transcribe -v`
Expected: FAIL mit `ModuleNotFoundError: No module named 'transcribe'`.

- [ ] **Step 3: Write minimal implementation**

```python
# tools/voice-echo-bot/transcribe.py
"""Sprachnachricht -> deutscher Text via ffmpeg + whisper.cpp (on-demand)."""
import os
import subprocess
import tempfile


class TranscriptionError(Exception):
    pass


def transcribe(ogg_path, model, workdir=None):
    workdir = workdir or tempfile.mkdtemp()
    wav = os.path.join(workdir, "audio.wav")
    prefix = os.path.join(workdir, "transcript")
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", ogg_path, "-ar", "16000", "-ac", "1", "-f", "wav", wav],
            check=True, capture_output=True,
        )
        subprocess.run(
            ["whisper-cli", "-m", model, "-l", "de", "-nt", "-np",
             "-otxt", "-of", prefix, "-f", wav],
            check=True, capture_output=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError) as exc:
        raise TranscriptionError(str(exc)) from exc

    txt_path = prefix + ".txt"
    if not os.path.exists(txt_path):
        raise TranscriptionError("whisper produced no output")
    with open(txt_path, "r", encoding="utf-8") as fh:
        return fh.read().strip()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/voice-echo-bot && python3 -m unittest test_transcribe -v`
Expected: PASS (2 Tests).

- [ ] **Step 5: Commit**

```bash
git add tools/voice-echo-bot/transcribe.py tools/voice-echo-bot/test_transcribe.py
git commit -m "feat(voice-echo): ffmpeg+whisper transcription wrapper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `paperclip_client.py` — Titel + Issue anlegen

**Files:**
- Create: `tools/voice-echo-bot/paperclip_client.py`
- Test: `tools/voice-echo-bot/test_paperclip_client.py`

**Interfaces:**
- Consumes: `config.API_BASE` (aus Task 2).
- Produces:
  - `derive_title(text, max_len=80) -> str` — erste Zeile bzw. erster Satz, auf `max_len` gekürzt (mit `…`); Fallback `"Sprachnotiz"` bei leerem Text.
  - `create_issue(token, company_id, assignee_agent_id, title, description) -> dict` — POST `{API_BASE}/companies/{company_id}/issues` mit `Authorization: Bearer <token>`, Body `{"title", "description", "assigneeAgentId", "priority": "medium"}` (kein `status` → Server-Default). Gibt das JSON-Antwortobjekt zurück.

- [ ] **Step 1: Write the failing test**

```python
# tools/voice-echo-bot/test_paperclip_client.py
import json
import unittest
from unittest import mock

import paperclip_client as pc


def _fake_response(payload):
    m = mock.MagicMock()
    m.read.return_value = json.dumps(payload).encode("utf-8")
    m.__enter__.return_value = m
    m.__exit__.return_value = False
    return m


class TestDeriveTitle(unittest.TestCase):
    def test_first_sentence(self):
        self.assertEqual(pc.derive_title("Kaufe Milch. Und Brot."), "Kaufe Milch.")

    def test_truncates_long_text(self):
        long = "wort " * 40
        title = pc.derive_title(long)
        self.assertLessEqual(len(title), 81)
        self.assertTrue(title.endswith("…"))

    def test_empty_fallback(self):
        self.assertEqual(pc.derive_title("   "), "Sprachnotiz")


class TestCreateIssue(unittest.TestCase):
    def test_posts_to_ceo_with_bearer(self):
        with mock.patch("paperclip_client.urllib.request.urlopen",
                        return_value=_fake_response({"id": "iss-1", "shortId": "WHI-999"})) as uo:
            res = pc.create_issue("tok", "comp-1", "ceo-1", "Titel", "Beschreibung")
        self.assertEqual(res["shortId"], "WHI-999")
        req = uo.call_args[0][0]
        self.assertEqual(req.full_url, "http://127.0.0.1:3100/api/companies/comp-1/issues")
        self.assertEqual(req.headers["Authorization"], "Bearer tok")
        body = json.loads(req.data.decode("utf-8"))
        self.assertEqual(body["title"], "Titel")
        self.assertEqual(body["description"], "Beschreibung")
        self.assertEqual(body["assigneeAgentId"], "ceo-1")
        self.assertNotIn("status", body)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/voice-echo-bot && python3 -m unittest test_paperclip_client -v`
Expected: FAIL mit `ModuleNotFoundError: No module named 'paperclip_client'`.

- [ ] **Step 3: Write minimal implementation**

```python
# tools/voice-echo-bot/paperclip_client.py
"""Paperclip-Issue-Erzeugung für den Voice-Echo-Bot."""
import json
import re
import urllib.request

from config import API_BASE


def derive_title(text, max_len=80):
    text = (text or "").strip()
    if not text:
        return "Sprachnotiz"
    # erste Zeile
    first = text.splitlines()[0].strip()
    # erster Satz (bis zum ersten . ! ? gefolgt von Space/Ende)
    match = re.search(r"^(.*?[.!?])(\s|$)", first)
    candidate = match.group(1).strip() if match else first
    if len(candidate) > max_len:
        candidate = candidate[:max_len].rstrip() + "…"
    return candidate


def create_issue(token, company_id, assignee_agent_id, title, description):
    url = "{}/companies/{}/issues".format(API_BASE, company_id)
    body = {
        "title": title,
        "description": description,
        "assigneeAgentId": assignee_agent_id,
        "priority": "medium",
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer {}".format(token),
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/voice-echo-bot && python3 -m unittest test_paperclip_client -v`
Expected: PASS (4 Tests).

- [ ] **Step 5: Commit**

```bash
git add tools/voice-echo-bot/paperclip_client.py tools/voice-echo-bot/test_paperclip_client.py
git commit -m "feat(voice-echo): paperclip issue creation + title derivation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `bot.py` — Orchestrierung (Loop, Allowlist, Handler)

**Files:**
- Create: `tools/voice-echo-bot/bot.py`
- Test: `tools/voice-echo-bot/test_bot.py`

**Interfaces:**
- Consumes: `Telegram` (Task 3), `transcribe`/`TranscriptionError` (Task 4), `derive_title`/`create_issue` (Task 5), `config` (Task 2).
- Produces: Klasse `BotApp(tg, cfg)` mit:
  - `cfg` — dict mit Schlüsseln `allowed_user_id` (int), `company_id`, `ceo_agent_id`, `paperclip_token` (callable oder str), `whisper_model`.
  - `candidates` — dict `key -> text`, key = `"{chat_id}:{message_id}"`.
  - `handle_update(update)` — Dispatcher für `message` / `callback_query`, inkl. Allowlist-Gate.
  - `_handle_message(msg)`, `_handle_callback(cbq)` — die konkreten Handler.
  - `run()` — Long-Poll-Schleife mit Startup-Drain (nur für den Live-Betrieb, in Tests nicht aufgerufen).
- Der `paperclip_token` wird pro Issue-Erstellung frisch bezogen (falls callable), damit ein rotiertes auth.json-Token wirkt.

- [ ] **Step 1: Write the failing test**

```python
# tools/voice-echo-bot/test_bot.py
import unittest
from unittest import mock

import bot
import transcribe


def make_app(tg):
    cfg = {
        "allowed_user_id": 8311805232,
        "company_id": "comp-1",
        "ceo_agent_id": "ceo-1",
        "paperclip_token": "tok",
        "whisper_model": "model.bin",
    }
    return bot.BotApp(tg, cfg)


class TestAllowlist(unittest.TestCase):
    def test_foreign_user_is_ignored(self):
        tg = mock.MagicMock()
        app = make_app(tg)
        app.handle_update({"message": {"message_id": 1, "chat": {"id": 999},
                                       "from": {"id": 999}, "text": "hallo"}})
        tg.send_message.assert_not_called()


class TestTextMessage(unittest.TestCase):
    def test_text_stores_candidate_and_sends_confirm_buttons(self):
        tg = mock.MagicMock()
        app = make_app(tg)
        app.handle_update({"message": {"message_id": 5, "chat": {"id": 8311805232},
                                       "from": {"id": 8311805232}, "text": "Steuer erledigen"}})
        self.assertEqual(app.candidates["8311805232:5"], "Steuer erledigen")
        args, kwargs = tg.send_message.call_args
        self.assertIn("Steuer erledigen", args[1])
        markup = kwargs["reply_markup"]
        datas = [b["callback_data"] for row in markup["inline_keyboard"] for b in row]
        self.assertIn("send:8311805232:5", datas)
        self.assertIn("drop:8311805232:5", datas)


class TestVoiceMessage(unittest.TestCase):
    def test_voice_is_transcribed_into_candidate(self):
        tg = mock.MagicMock()
        tg.get_file_path.return_value = "voice/f.oga"
        app = make_app(tg)
        with mock.patch.object(bot.transcribe, "transcribe", return_value="Milch kaufen"):
            app.handle_update({"message": {"message_id": 7, "chat": {"id": 8311805232},
                                           "from": {"id": 8311805232},
                                           "voice": {"file_id": "fid"}}})
        self.assertEqual(app.candidates["8311805232:7"], "Milch kaufen")


class TestCallbackSend(unittest.TestCase):
    def test_send_creates_issue_and_clears_candidate(self):
        tg = mock.MagicMock()
        app = make_app(tg)
        app.candidates["8311805232:5"] = "Steuer erledigen"
        with mock.patch.object(bot, "create_issue",
                               return_value={"shortId": "WHI-1", "id": "iss-1"}) as ci:
            app.handle_update({"callback_query": {"id": "cbq1", "from": {"id": 8311805232},
                                                  "message": {"chat": {"id": 8311805232}},
                                                  "data": "send:8311805232:5"}})
        ci.assert_called_once_with("tok", "comp-1", "ceo-1", "Steuer erledigen", "Steuer erledigen")
        self.assertNotIn("8311805232:5", app.candidates)
        tg.answer_callback_query.assert_called_once()

    def test_drop_discards_candidate_without_issue(self):
        tg = mock.MagicMock()
        app = make_app(tg)
        app.candidates["8311805232:5"] = "egal"
        with mock.patch.object(bot, "create_issue") as ci:
            app.handle_update({"callback_query": {"id": "cbq2", "from": {"id": 8311805232},
                                                  "message": {"chat": {"id": 8311805232}},
                                                  "data": "drop:8311805232:5"}})
        ci.assert_not_called()
        self.assertNotIn("8311805232:5", app.candidates)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/voice-echo-bot && python3 -m unittest test_bot -v`
Expected: FAIL mit `ModuleNotFoundError: No module named 'bot'`.

- [ ] **Step 3: Write minimal implementation**

```python
# tools/voice-echo-bot/bot.py
"""Voice-Echo Jarvis-Bot: Long-Poll-Loop, Allowlist, Bestätigungs-Flow."""
import os
import sys
import tempfile
import time
import traceback

import config
import transcribe
from telegram_api import Telegram
from paperclip_client import create_issue, derive_title

CONFIRM_PROMPT = "📝 {text}\n\nAls Aufgabe an den CEO senden?"


class BotApp:
    def __init__(self, tg, cfg):
        self.tg = tg
        self.cfg = cfg
        self.candidates = {}

    def _token(self):
        tok = self.cfg["paperclip_token"]
        return tok() if callable(tok) else tok

    def _confirm_markup(self, key):
        return {"inline_keyboard": [[
            {"text": "✅ An CEO senden", "callback_data": "send:" + key},
            {"text": "❌ Verwerfen", "callback_data": "drop:" + key},
        ]]}

    def _offer(self, chat_id, message_id, text):
        text = (text or "").strip()
        if not text:
            self.tg.send_message(chat_id, "Nichts erkannt, bitte erneut.")
            return
        key = "{}:{}".format(chat_id, message_id)
        self.candidates[key] = text
        self.tg.send_message(chat_id, CONFIRM_PROMPT.format(text=text),
                             reply_markup=self._confirm_markup(key))

    def _handle_message(self, msg):
        chat_id = msg["chat"]["id"]
        message_id = msg["message_id"]
        if "voice" in msg or "audio" in msg:
            media = msg.get("voice") or msg.get("audio")
            workdir = tempfile.mkdtemp()
            ogg = os.path.join(workdir, "in.oga")
            try:
                path = self.tg.get_file_path(media["file_id"])
                self.tg.download_file(path, ogg)
                text = transcribe.transcribe(ogg, self.cfg["whisper_model"], workdir=workdir)
            except transcribe.TranscriptionError:
                self.tg.send_message(chat_id, "Transkription fehlgeschlagen, bitte erneut.")
                return
            self._offer(chat_id, message_id, text)
        elif "text" in msg:
            text = msg["text"]
            if text.startswith("/"):
                self.tg.send_message(chat_id,
                                     "Sprich mir eine Aufgabe ein oder tippe sie — ich lege sie beim CEO an.")
                return
            self._offer(chat_id, message_id, text)

    def _handle_callback(self, cbq):
        data = cbq.get("data", "")
        chat_id = cbq["message"]["chat"]["id"]
        action, _, key = data.partition(":")
        text = self.candidates.pop(key, None)
        if text is None:
            self.tg.answer_callback_query(cbq["id"], "Abgelaufen — bitte neu senden.")
            return
        if action == "send":
            try:
                issue = create_issue(self._token(), self.cfg["company_id"],
                                     self.cfg["ceo_agent_id"], derive_title(text), text)
                label = issue.get("shortId") or issue.get("id", "?")
                self.tg.answer_callback_query(cbq["id"], "Gesendet")
                self.tg.send_message(chat_id, "✅ An CEO gesendet: {}".format(label))
            except Exception:  # noqa: BLE001 - Fehler dem Nutzer melden, Text nicht verlieren
                self.candidates[key] = text
                self.tg.answer_callback_query(cbq["id"], "Fehler")
                self.tg.send_message(chat_id, "⚠️ Konnte Issue nicht anlegen, bitte erneut senden.")
        else:  # drop
            self.tg.answer_callback_query(cbq["id"], "Verworfen")
            self.tg.send_message(chat_id, "❌ Verworfen.")

    def handle_update(self, update):
        if "callback_query" in update:
            cbq = update["callback_query"]
            if cbq.get("from", {}).get("id") != self.cfg["allowed_user_id"]:
                return
            self._handle_callback(cbq)
        elif "message" in update:
            msg = update["message"]
            if msg.get("from", {}).get("id") != self.cfg["allowed_user_id"]:
                return
            self._handle_message(msg)

    def run(self):
        # Startup-Drain: alten Rückstau überspringen
        offset = None
        pending = self.tg.get_updates(offset=-1, timeout=0)
        if pending:
            offset = pending[-1]["update_id"] + 1
        while True:
            try:
                for update in self.tg.get_updates(offset=offset, timeout=50):
                    offset = update["update_id"] + 1
                    self.handle_update(update)
            except Exception:  # noqa: BLE001 - Dienst am Leben halten
                traceback.print_exc()
                time.sleep(5)


def build_app():
    env = config.load_env(config.ENV_PATH)
    cfg = {
        "allowed_user_id": int(env["TELEGRAM_ALLOWED_USER_ID"]),
        "company_id": env["WHITESTAG_COMPANY_ID"],
        "ceo_agent_id": env["CEO_AGENT_ID"],
        "whisper_model": os.path.expanduser(env["WHISPER_MODEL"]),
        "paperclip_token": config.load_paperclip_token,  # callable: pro Issue frisch
    }
    tg = Telegram(env["TELEGRAM_BOT_TOKEN"])
    return BotApp(tg, cfg)


if __name__ == "__main__":
    print("voice-echo jarvis-bot startet…", file=sys.stderr)
    build_app().run()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/voice-echo-bot && python3 -m unittest test_bot -v`
Expected: PASS (5 Tests).

- [ ] **Step 5: Ganze Suite grün**

Run: `cd tools/voice-echo-bot && python3 -m unittest discover -p "test_*.py" -v`
Expected: PASS (alle Tests aus Task 2–6).

- [ ] **Step 6: Commit**

```bash
git add tools/voice-echo-bot/bot.py tools/voice-echo-bot/test_bot.py
git commit -m "feat(voice-echo): bot orchestration (loop, allowlist, confirm flow)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Konfiguration finalisieren, launchd-Deploy, E2E-Smoke

**Files:**
- Modify: `~/.paperclip/voice-echo-bot.env` (Werte füllen, außerhalb Git)
- Create: `tools/voice-echo-bot/de.whitestag.voice-echo-bot.plist`
- Create: `tools/voice-echo-bot/DEPLOY.md`
- Deploy-Ziel: `~/.paperclip/scripts/voice-echo-bot/` + `~/Library/LaunchAgents/de.whitestag.voice-echo-bot.plist`

**Interfaces:**
- Consumes: alle Module aus Task 2–6, das Modell aus Task 1, die Secrets in `~/.paperclip/voice-echo-bot.env`.
- Produces: laufender launchd-Dienst, der auf Nachrichten an `@whitestag_jarvis_bot` reagiert.

- [ ] **Step 1: `.env` mit aufgelösten Werten füllen**

Run:
```bash
python3 - <<'PY'
import re, io
p = __import__('os').path.expanduser("~/.paperclip/voice-echo-bot.env")
vals = {
    "WHITESTAG_COMPANY_ID": "9cebf3cf-efe8-4597-a400-f06488900a87",
    "CEO_AGENT_ID": "506c873e-3a40-4483-9a45-0eb0fa1554bb",
    "WHISPER_MODEL": "~/.paperclip/models/whisper/ggml-large-v3-turbo.bin",
}
lines = open(p, encoding="utf-8").read().splitlines()
out = []
for ln in lines:
    key = ln.split("=", 1)[0].strip() if "=" in ln else None
    if key in vals:
        out.append('%s="%s"' % (key, vals.pop(key)))
    elif key == "PAPERCLIP_TOKEN":
        out.append("# PAPERCLIP_TOKEN: nicht nötig — Token wird aus ~/.paperclip/auth.json gelesen")
    else:
        out.append(ln)
for k, v in vals.items():
    out.append('%s="%s"' % (k, v))
open(p, "w", encoding="utf-8").write("\n".join(out) + "\n")
print(open(p, encoding="utf-8").read())
PY
```
Expected: Ausgabe zeigt `WHITESTAG_COMPANY_ID`, `CEO_AGENT_ID`, `WHISPER_MODEL` gesetzt; `TELEGRAM_BOT_TOKEN`/`TELEGRAM_ALLOWED_USER_ID` unverändert vorhanden.

- [ ] **Step 2: launchd-Plist schreiben**

```xml
<!-- tools/voice-echo-bot/de.whitestag.voice-echo-bot.plist
     ${HOME} beim Deploy durch echten Home-Pfad ersetzen (siehe DEPLOY.md). -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>de.whitestag.voice-echo-bot</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/python3</string>
        <string>__HOME__/.paperclip/scripts/voice-echo-bot/bot.py</string>
    </array>
    <key>WorkingDirectory</key><string>__HOME__/.paperclip/scripts/voice-echo-bot</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>__HOME__/.paperclip/logs/voice-echo-bot.log</string>
    <key>StandardErrorPath</key><string>__HOME__/.paperclip/logs/voice-echo-bot.log</string>
</dict>
</plist>
```

- [ ] **Step 3: `DEPLOY.md` schreiben**

````markdown
# Deploy: Voice-Echo Jarvis-Bot

Läuft als launchd-Dienst aus `~/.paperclip/scripts/` (launchd kann SynologyDrive nicht lesen).

## Deploy / Update
```bash
mkdir -p ~/.paperclip/scripts/voice-echo-bot ~/.paperclip/logs
cp tools/voice-echo-bot/{config,telegram_api,transcribe,paperclip_client,bot}.py \
   ~/.paperclip/scripts/voice-echo-bot/
sed "s|__HOME__|$HOME|g" tools/voice-echo-bot/de.whitestag.voice-echo-bot.plist \
   > ~/Library/LaunchAgents/de.whitestag.voice-echo-bot.plist
launchctl bootout gui/$(id -u)/de.whitestag.voice-echo-bot 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/de.whitestag.voice-echo-bot.plist
launchctl kickstart -k gui/$(id -u)/de.whitestag.voice-echo-bot
```

## Status / Logs
```bash
launchctl print gui/$(id -u)/de.whitestag.voice-echo-bot | grep -E "state|pid"
tail -f ~/.paperclip/logs/voice-echo-bot.log
```

## Voraussetzungen
- `~/.paperclip/voice-echo-bot.env` (Token, User-ID, IDs, Modellpfad)
- `~/.paperclip/models/whisper/ggml-large-v3-turbo.bin`
- Homebrew: `whisper-cli`, `ffmpeg`
````

- [ ] **Step 4: Deploy ausführen**

Run: die Kommandos aus `DEPLOY.md` → "## Deploy / Update".
Expected: keine Fehler; `launchctl bootstrap` legt den Job an.

- [ ] **Step 5: Dienst-Status prüfen**

Run:
```bash
sleep 3
launchctl print gui/$(id -u)/de.whitestag.voice-echo-bot | grep -E "state =|pid ="
tail -20 ~/.paperclip/logs/voice-echo-bot.log
```
Expected: `state = running`, eine PID, Log zeigt "voice-echo jarvis-bot startet…" ohne Traceback.

- [ ] **Step 6: E2E-Smoke (manuell, mit Walter)**

Anleitung an Walter:
1. In Telegram an **@whitestag_jarvis_bot** eine **Sprachnachricht** senden (z. B. „Bitte prüfe das Angebot für Kunde X bis Freitag.").
2. Bot antwortet mit „📝 <Transkript>" + Buttons **[✅ An CEO senden] [❌ Verwerfen]**.
3. **✅** drücken → Bot bestätigt „✅ An CEO gesendet: WHI-…".

Verifikation (Issue liegt beim CEO):
```bash
TOKEN=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.paperclip/auth.json')))['credentials']['http://localhost:3100']['token'])")
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:3100/api/companies/9cebf3cf-efe8-4597-a400-f06488900a87/issues?assigneeAgentId=506c873e-3a40-4483-9a45-0eb0fa1554bb" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);a=d if isinstance(d,list) else d.get('issues',d.get('data',[]));print('\n'.join('%s | %s' % (i.get('shortId'), i.get('title')) for i in a[:5]))"
```
Expected: Das eben eingesprochene Issue erscheint oben (Titel = erster Satz), zugewiesen an den CEO.

- [ ] **Step 7: Commit**

```bash
git add tools/voice-echo-bot/de.whitestag.voice-echo-bot.plist tools/voice-echo-bot/DEPLOY.md
git commit -m "feat(voice-echo): launchd plist + deploy docs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Testing-Zusammenfassung
- **Unit (automatisiert, gemockt):** `cd tools/voice-echo-bot && python3 -m unittest discover -p "test_*.py" -v` — deckt config, Telegram-Client, Transkription, Issue-Erzeugung/Titel, Allowlist + Bestätigungs-Flow ab.
- **Modell-Verifikation:** whisper-cli auf `jfk.wav` (Task 1).
- **E2E-Smoke:** echte Sprachnachricht → Issue beim CEO (Task 7).

## Bewusst nicht im Scope (aus Spec)
Keine Web-Seite/Cloudflare, keine CEO-Auswahl/Multi-Company, kein KI-Titel, keine Audio-Archivierung, kein Rückkanal CEO→Telegram.
