# Wake-Word-Satellit „Hey Jarvis" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freihändiger Sprachzugang zu Jarvis am Mac Studio — „Hey Jarvis, …" wird per openwakeword erkannt, transkribiert, von Jarvis' bestehendem Gehirn beantwortet und laut über den HomePod ausgegeben, mit 6-Sekunden-Nachfrage-Fenster.

**Architecture:** Ein neuer Prozess (`tools/wake-satellite/`) läuft als LaunchAgent am Studio. Jarvis' Antwort-Logik wird aus `bot.py` in ein geteiltes Modul `jarvis_brain.py` gezogen, das Telegram-Bot **und** Satellit aufrufen (ein Gehirn, zwei Eingänge). Der Satellit wiederverwendet die vorhandenen `transcribe.py` (whisper.cpp) und `tts.py` (ElevenLabs) und ergänzt Mikrofon-Aufnahme, Wake-Word-Erkennung und AirPlay-Ausgabe.

**Tech Stack:** Python 3 (stdlib für die geteilten voice-echo-bot-Module); neue Deps nur im Satellit-venv: `openwakeword`, `numpy`, `sounddevice` (PortAudio), tflite-Backend (`tensorflow` auf macOS). Externe Tools: `whisper-cli`, `ffmpeg`, `afplay`, `SwitchAudioSource` (brew). LM Studio (gemma) + ElevenLabs wie beim Telegram-Jarvis.

## Global Constraints

- **Geteilte voice-echo-bot-Module bleiben stdlib-only** (`config.py`, `llm.py`, `vault_client.py`, `paperclip_client.py`, `transcribe.py`, `tts.py`, `jarvis_brain.py`). Neue Fremd-Deps ausschließlich in den Satellit-Modulen.
- **Der Live-Telegram-Bot darf sich nicht verändern.** Nach dem `jarvis_brain`-Refactor müssen alle bestehenden Tests in `tools/voice-echo-bot/` grün bleiben; die vom Bot gesendeten Text-Strings bleiben wörtlich identisch.
- **Kein Modul außer `capture.MicStream`, `satellite.main` und `playback`/`earcon`-Wiedergabe fasst Hardware/IO an.** Erkennungs-, Aufnahme- und Wiedergabe-*Logik* ist ohne Mikrofon/HomePod testbar (Streams/Subprozesse injiziert bzw. gemockt).
- **Mandant fest verdrahtet:** `Walter / WHITESTAG`, company `9cebf3cf-efe8-4597-a400-f06488900a87`, ceo_agent `506c873e-3a40-4483-9a45-0eb0fa1554bb`, vault `whitestag`.
- **HomePod-Gerätename exakt:** `"Homepod Studio"`.
- **Env-Wiederverwendung:** Satellit liest denselben `~/.paperclip/voice-echo-bot.env` (Keys `WHISPER_MODEL`, `ELEVENLABS_API_KEY`, `CHAT_MODEL`) und dasselbe Board-Token aus `~/.paperclip/auth.json`.
- **Format-Trennung:** Telegram-Antworten bleiben Opus/OGG; HomePod-Antworten sind mp3. Der Default von `tts.synthesize` bleibt Opus (keine Regression).
- **Testrunner:** `python3 -m pytest` aus dem jeweiligen Modulordner. Commits häufig, ein Commit je Task-Abschluss.

---

## File Structure

**Refactor in `tools/voice-echo-bot/`:**
- Create `jarvis_brain.py` — geteilte Antwort-Logik (System-Prompt, `parse_control`, `respond`, Werkzeug-Ausführung).
- Create `test_jarvis_brain.py`.
- Modify `bot.py` — `_handle_chat` delegiert an `jarvis_brain.respond`; entfernte Helfer werden aus `jarvis_brain` re-importiert.
- Modify `tts.py` + `config.py` — `output_format`-Parameter.
- Modify `test_tts.py`.

**Neuer Satellit in `tools/wake-satellite/`:**
- Create `sat_config.py` — Satellit-Konstanten (bewusst NICHT `config.py`, um Namenskollision mit dem geteilten `config.py` zu vermeiden).
- Create `wake.py` + `test_wake.py` — openwakeword-Wrapper.
- Create `capture.py` + `test_capture.py` — Aufnahme-/Nachfrage-Logik + wav-Schreiben (+ Hardware-`MicStream`).
- Create `playback.py` + `test_playback.py` — AirPlay-Routing + afplay + Fallback.
- Create `earcon.py` + `test_earcon.py` — Bestätigungston.
- Create `satellite.py` + `test_satellite.py` — Interaktions-Schleife + `main`.
- Create `conftest.py` — legt `../voice-echo-bot` auf `sys.path` (Import der geteilten Module in Tests).
- Create `requirements.txt`, `deploy.sh`, `de.whitestag.wake-satellite.plist`, `DEPLOY.md`.

---

## Task 1: `tts.output_format` — mp3 für HomePod, Opus bleibt Default

**Files:**
- Modify: `tools/voice-echo-bot/config.py` (nach `ELEVEN_TTS_URL`)
- Modify: `tools/voice-echo-bot/tts.py` (`synthesize`)
- Test: `tools/voice-echo-bot/test_tts.py`

**Interfaces:**
- Consumes: nichts.
- Produces: `tts.synthesize(text, api_key, dest, output_format=None) -> dest`. Bei `output_format=None` unverändertes Verhalten (Opus-URL). Bei gesetztem Format wird `?output_format=<format>` an die Voice-Basis-URL gehängt.

- [ ] **Step 1: Failing Test schreiben** — hängt an `test_tts.py` an; prüft, dass das übergebene Format in der Request-URL landet und der Default Opus bleibt.

```python
def test_synthesize_uses_output_format_in_url(monkeypatch, tmp_path):
    captured = {}

    class FakeResp:
        def read(self): return b"AUDIO"
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def fake_urlopen(req, timeout=0):
        captured["url"] = req.full_url
        return FakeResp()

    monkeypatch.setattr(tts.urllib.request, "urlopen", fake_urlopen)
    dest = str(tmp_path / "out.mp3")
    tts.synthesize("hallo", "key", dest, output_format="mp3_44100_128")
    assert "output_format=mp3_44100_128" in captured["url"]


def test_synthesize_defaults_to_opus(monkeypatch, tmp_path):
    captured = {}

    class FakeResp:
        def read(self): return b"AUDIO"
        def __enter__(self): return self
        def __exit__(self, *a): return False

    monkeypatch.setattr(tts.urllib.request, "urlopen",
                        lambda req, timeout=0: (captured.__setitem__("url", req.full_url) or FakeResp()))
    dest = str(tmp_path / "out.ogg")
    tts.synthesize("hallo", "key", dest)
    assert "output_format=opus_48000_64" in captured["url"]
```

- [ ] **Step 2: Test rot verifizieren**

Run: `cd tools/voice-echo-bot && python3 -m pytest test_tts.py -k output_format_in_url -v`
Expected: FAIL (`synthesize() got an unexpected keyword argument 'output_format'`).

- [ ] **Step 3: config.py — Basis-URL + Default-Format herausziehen**

Ersetze in `tools/voice-echo-bot/config.py` den `ELEVEN_TTS_URL`-Block durch:

```python
ELEVEN_TTS_BASE = (
    "https://api.elevenlabs.io/v1/text-to-speech/" + ELEVEN_VOICE_ID
)
ELEVEN_OUTPUT_FORMAT_DEFAULT = "opus_48000_64"
# Rückwärtskompatibel: bestehender Voll-URL-Name bleibt erhalten.
ELEVEN_TTS_URL = ELEVEN_TTS_BASE + "?output_format=" + ELEVEN_OUTPUT_FORMAT_DEFAULT
```

- [ ] **Step 4: tts.py — Parameter einbauen**

In `tools/voice-echo-bot/tts.py`, `synthesize`-Signatur und URL-Aufbau ändern:

```python
def synthesize(text, api_key, dest, output_format=None):
    text = (text or "").strip()
    if not text:
        raise TtsError("empty text")
    if not api_key:
        raise TtsError("missing ElevenLabs API key")

    fmt = output_format or config.ELEVEN_OUTPUT_FORMAT_DEFAULT
    url = config.ELEVEN_TTS_BASE + "?output_format=" + fmt
    body = json.dumps({"text": text, "model_id": config.ELEVEN_MODEL,
                       "language_code": config.ELEVEN_LANGUAGE}).encode("utf-8")
    req = urllib.request.Request(
        url, data=body,
        headers={"xi-api-key": api_key, "Content-Type": "application/json"},
    )
    # ... Rest (urlopen/Fehlerbehandlung/Schreiben) unverändert ...
```

- [ ] **Step 5: Tests grün verifizieren**

Run: `cd tools/voice-echo-bot && python3 -m pytest test_tts.py -v`
Expected: PASS (alle, inkl. der bestehenden).

- [ ] **Step 6: Commit**

```bash
git add tools/voice-echo-bot/config.py tools/voice-echo-bot/tts.py tools/voice-echo-bot/test_tts.py
git commit -m "feat(voice-echo-bot): tts output_format-Param (mp3 für HomePod, Opus bleibt Default)"
```

---

## Task 2: `jarvis_brain` — Jarvis' Gehirn aus dem Bot herauslösen

**Files:**
- Create: `tools/voice-echo-bot/jarvis_brain.py`
- Create: `tools/voice-echo-bot/test_jarvis_brain.py`
- Modify: `tools/voice-echo-bot/bot.py` (Konstanten/Helfer entfernen, `_handle_chat` delegieren, Re-Import)

**Interfaces:**
- Consumes: `llm.chat`, `llm.LlmError`, `vault_client.lookup`, `vault_client.VaultError`, `paperclip_client.create_issue`, `paperclip_client.derive_title`.
- Produces:
  - `jarvis_brain.SYSTEM_PROMPT`, `jarvis_brain.LOOKUP_RE`, `jarvis_brain.ISSUE_RE`
  - `jarvis_brain.first_name(tenant) -> str`
  - `jarvis_brain.parse_control(raw) -> {"kind": "lookup"|"issue"|"chat", ...}`
  - `jarvis_brain.respond(text, tenant, token, chat_model, history=None) -> {"kind": str, "answer": str}` mit `kind ∈ {chat, lookup, issue, empty, unparsed_ok, unparsed_fail}`. `token` ist ein String (bereits aufgelöst). `history` ist eine Liste `[{"role","content"}, …]` und wird NICHT mutiert.

- [ ] **Step 1: Failing Tests schreiben** — `tools/voice-echo-bot/test_jarvis_brain.py`

```python
import jarvis_brain
import llm

TENANT = {"name": "Walter / WHITESTAG",
          "company_id": "c-1", "ceo_agent_id": "a-1", "vault": "whitestag"}


def test_empty_text_returns_empty_kind():
    r = jarvis_brain.respond("   ", TENANT, "tok", "m")
    assert r["kind"] == "empty"
    assert r["answer"] == "Nichts erkannt, bitte erneut."


def test_plain_chat(monkeypatch):
    monkeypatch.setattr(jarvis_brain.llm, "chat", lambda msgs, model=None: "Hallo Walter.")
    r = jarvis_brain.respond("hi", TENANT, "tok", "m")
    assert r == {"kind": "chat", "answer": "Hallo Walter."}


def test_lookup_two_rounds(monkeypatch):
    calls = []
    def fake_chat(msgs, model=None):
        calls.append(msgs)
        return "LOOKUP kontakt: Jana" if len(calls) == 1 else "Janas Nummer ist 123."
    monkeypatch.setattr(jarvis_brain.llm, "chat", fake_chat)
    monkeypatch.setattr(jarvis_brain.vault_client, "lookup",
                        lambda mode, query, vault=None: {"mode": mode, "treffer": [{"tel": "123"}]})
    r = jarvis_brain.respond("Nummer von Jana?", TENANT, "tok", "m")
    assert r["kind"] == "lookup"
    assert "123" in r["answer"]
    assert len(calls) == 2


def test_issue_created(monkeypatch):
    monkeypatch.setattr(jarvis_brain.llm, "chat",
                        lambda msgs, model=None: "ISSUE: DMARC :: DMARC einrichten")
    seen = {}
    def fake_create(token, company, agent, title, desc):
        seen.update(dict(token=token, company=company, agent=agent, title=title))
        return {"identifier": "WHI-9"}
    monkeypatch.setattr(jarvis_brain, "create_issue", fake_create)
    r = jarvis_brain.respond("leg an: DMARC", TENANT, "tok", "m")
    assert r["kind"] == "issue"
    assert "WHI-9" in r["answer"]
    assert seen["company"] == "c-1" and seen["agent"] == "a-1"


def test_llm_down_files_unparsed_issue(monkeypatch):
    def boom(msgs, model=None): raise llm.LlmError("weg")
    monkeypatch.setattr(jarvis_brain.llm, "chat", boom)
    monkeypatch.setattr(jarvis_brain, "create_issue",
                        lambda *a, **k: {"identifier": "WHI-10"})
    r = jarvis_brain.respond("mach xyz", TENANT, "tok", "m")
    assert r["kind"] == "unparsed_ok"
    assert "WHI-10" in r["answer"]


def test_llm_down_and_issue_fails(monkeypatch):
    monkeypatch.setattr(jarvis_brain.llm, "chat",
                        lambda msgs, model=None: (_ for _ in ()).throw(llm.LlmError("weg")))
    def boom(*a, **k): raise RuntimeError("api tot")
    monkeypatch.setattr(jarvis_brain, "create_issue", boom)
    r = jarvis_brain.respond("mach xyz", TENANT, "tok", "m")
    assert r["kind"] == "unparsed_fail"
    assert "NICHT angekommen" in r["answer"]
```

- [ ] **Step 2: Tests rot verifizieren**

Run: `cd tools/voice-echo-bot && python3 -m pytest test_jarvis_brain.py -v`
Expected: FAIL (`ModuleNotFoundError: jarvis_brain`).

- [ ] **Step 3: `jarvis_brain.py` schreiben** — Konstanten/Helfer aus `bot.py` verbatim übernehmen, Werkzeug-Ausführung als freie Funktionen.

```python
# tools/voice-echo-bot/jarvis_brain.py
"""Jarvis' Antwort-Gehirn — geteilt zwischen Telegram-Bot und Wake-Satellit.

Reine Logik: Text rein, {"kind","answer"} raus. Kein Telegram, kein Mikrofon.
Kapselt System-Prompt, Steuer-Token-Parsing (LOOKUP/ISSUE) und die Werkzeug-
Ausführung (Vault-Lookup, CEO-Issue, Unausgewertet-Notfall). stdlib only.
"""
import json
import re
import traceback

import llm
import vault_client
from paperclip_client import create_issue, derive_title

SYSTEM_PROMPT = (
    "Du bist Jarvis, der persönliche CEO-Draht von {name}. Du bist ein ganz "
    "normaler Chat-Assistent: antworte knapp, auf Deutsch, sprich {name} mit "
    "Vornamen an, keine Meta-Sätze (\"Als KI …\"), keine Floskeln.\n\n"
    "Du hast zwei Werkzeuge. Brauchst du eines, gib in der ERSTEN Zeile GENAU "
    "EIN Steuer-Token aus (nichts davor, keine Anführungszeichen):\n\n"
    "1. Vault nachschlagen — für echte Daten (Telefonnummer, Adresse, E-Mail "
    "einer Person; Termine; frühere Mails; Wissens-/Business-Fragen):\n"
    "   LOOKUP <modus>: <suchbegriff>\n"
    "   modus = kontakt (Tel/Mail/Adresse einer Person) | termin (Kalender) | "
    "mail (frühere E-Mails) | wissen (Wissens-/Business-Fragen) | dokument (Volltextsuche in ALLEN Dokumenten/Unterlagen des Vaults, z.B. Angebote, Verträge, Projekte).\n"
    "   Beispiel: LOOKUP kontakt: Jana Kostbar\n\n"
    "2. Aufgabe beim CEO anlegen — NUR wenn {name} dich ausdrücklich darum "
    "bittet (\"leg an\", \"erstelle einen Task\", \"kümmer dich um\"):\n"
    "   ISSUE: <titel> :: <beschreibung>\n"
    "   Beispiel: ISSUE: DMARC einrichten :: DMARC für whitestag.ai konfigurieren.\n\n"
    "Brauchst du KEIN Werkzeug, antworte einfach direkt als Chat-Text (kein "
    "Token). Frag nicht um Erlaubnis, ein Werkzeug zu nutzen — nutze es einfach."
)

LOOKUP_RE = re.compile(r"^\s*LOOKUP\s+(kontakt|termin|mail|wissen|dokument)\s*:\s*(.+)$",
                       re.IGNORECASE)
ISSUE_RE = re.compile(r"^\s*ISSUE\s*:\s*(.+)$", re.IGNORECASE)


def first_name(tenant):
    name = (tenant.get("name") or "").strip()
    head = name.split("/")[0].strip()
    return head.split()[0] if head else "Chef"


def parse_control(raw):
    text = (raw or "").strip()
    lines = text.splitlines()
    first = lines[0] if lines else ""
    m = LOOKUP_RE.match(first)
    if m:
        return {"kind": "lookup", "mode": m.group(1).lower(),
                "query": m.group(2).strip()}
    m = ISSUE_RE.match(first)
    if m:
        title, sep, desc = m.group(1).partition("::")
        title = title.strip()
        desc = desc.strip() if sep else ""
        return {"kind": "issue", "title": title, "description": desc or title}
    return {"kind": "chat", "text": text}


def respond(text, tenant, token, chat_model, history=None):
    text = (text or "").strip()
    if not text:
        return {"kind": "empty", "answer": "Nichts erkannt, bitte erneut."}
    hist = history or []
    messages = ([{"role": "system", "content": SYSTEM_PROMPT.format(name=first_name(tenant))}]
                + list(hist) + [{"role": "user", "content": text}])
    try:
        raw = llm.chat(messages, model=chat_model)
    except llm.LlmError:
        traceback.print_exc()
        return _unparsed(text, tenant, token)
    action = parse_control(raw)
    if action["kind"] == "lookup":
        return {"kind": "lookup",
                "answer": _do_lookup(messages, action["mode"], action["query"], tenant, chat_model)}
    if action["kind"] == "issue":
        return {"kind": "issue",
                "answer": _do_issue(action["title"], action["description"], tenant, token)}
    return {"kind": "chat", "answer": action["text"]}


def _do_lookup(messages, mode, query, tenant, chat_model):
    try:
        result = vault_client.lookup(mode, query, vault=tenant.get("vault"))
    except vault_client.VaultError:
        traceback.print_exc()
        result = {"mode": mode, "query": query, "treffer": [],
                  "fehler": "Vault-Dienst nicht erreichbar"}
    if result.get("vault_unknown"):
        return ("⚠️ Ich kann darauf nicht zugreifen — der für diesen Chat "
                "hinterlegte Vault ist unbekannt oder falsch konfiguriert. "
                "Bitte an die Administration wenden.")
    context = json.dumps(result, ensure_ascii=False)[:4000]
    followup = messages + [
        {"role": "assistant", "content": "LOOKUP {}: {}".format(mode, query)},
        {"role": "user", "content":
            ("Vault-Treffer (JSON):\n{}\n\nBeantworte meine letzte Frage knapp auf "
             "Deutsch mit diesen Daten. Ist nichts Passendes dabei, sag das ehrlich. "
             "Gib KEIN Steuer-Token mehr aus.").format(context)},
    ]
    try:
        answer = llm.chat(followup, model=chat_model)
    except llm.LlmError:
        traceback.print_exc()
        return "⚠️ Konnte die Vault-Daten nicht auswerten, bitte gleich nochmal."
    follow_action = parse_control(answer)
    return follow_action["text"] if follow_action["kind"] == "chat" else answer.strip()


def _do_issue(title, description, tenant, token):
    try:
        issue = create_issue(token, tenant["company_id"], tenant["ceo_agent_id"],
                             derive_title(title), description)
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        return "⚠️ Konnte die Aufgabe nicht anlegen, bitte gleich nochmal."
    label = issue.get("identifier") or issue.get("id", "?")
    return "✅ Task angelegt: {}".format(label)


def _unparsed(text, tenant, token):
    description = (
        "Von Walter per Sprache diktiert. Das Sprachmodell war nicht "
        "erreichbar, der Text ist daher UNAUSGEWERTET durchgereicht — "
        "bitte selbst interpretieren und, falls es keine Aufgabe ist, "
        "schliessen.\n\nWortlaut:\n{}".format(text)
    )
    try:
        issue = create_issue(token, tenant["company_id"], tenant["ceo_agent_id"],
                             derive_title(text), description)
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        return {"kind": "unparsed_fail",
                "answer": ("⚠️ Mein Sprachmodell ist nicht erreichbar und ich konnte auch keine "
                           "Aufgabe anlegen — dein Auftrag ist NICHT angekommen. Bitte nochmal senden.")}
    label = issue.get("identifier") or issue.get("id", "?")
    return {"kind": "unparsed_ok",
            "answer": ("⚠️ Mein Sprachmodell ist gerade nicht erreichbar — ich habe deinen Auftrag "
                       "unausgewertet an den CEO weitergegeben: {}".format(label))}
```

Hinweis: `create_issue` wird als Modul-Attribut `jarvis_brain.create_issue` referenziert (die Tests patchen genau das).

- [ ] **Step 4: Tests grün verifizieren**

Run: `cd tools/voice-echo-bot && python3 -m pytest test_jarvis_brain.py -v`
Expected: PASS (alle 6).

- [ ] **Step 5: `bot.py` auf `jarvis_brain` umstellen**

In `tools/voice-echo-bot/bot.py`:

1. Ersetze die Konstanten/Regex-Definitionen `SYSTEM_PROMPT`, `LOOKUP_RE`, `ISSUE_RE` und die Funktion `parse_control` durch einen Re-Import (Rückwärtskompatibilität für bestehende Tests, die `bot.parse_control`/`bot.SYSTEM_PROMPT` nutzen). Direkt nach den bestehenden Imports:

```python
import jarvis_brain
from jarvis_brain import SYSTEM_PROMPT, LOOKUP_RE, ISSUE_RE, parse_control
```

(`IDENT_RE` und `MAX_HISTORY_MESSAGES` bleiben in `bot.py`.)

2. Entferne die Methoden `_do_lookup`, `_do_issue`, `_file_unparsed` und `_first_name` aus `BotApp` (die Logik lebt jetzt in `jarvis_brain`; `_remember` bleibt).

3. Ersetze `_handle_chat` durch die delegierende Variante:

```python
    def _handle_chat(self, tenant, msg, text):
        chat_id = msg["chat"]["id"]
        text = (text or "").strip()
        hist = self.history.get(chat_id, [])
        result = jarvis_brain.respond(text, tenant, self._token(),
                                      self._chat_model(), history=hist)
        kind, answer = result["kind"], result["answer"]
        if kind in ("empty", "unparsed_ok", "unparsed_fail"):
            self.tg.send_message(chat_id, answer)
            return
        self._remember(chat_id, text, answer)
        self._reply(chat_id, answer, reply_to_message_id=msg["message_id"])
```

- [ ] **Step 6: Gesamte voice-echo-bot-Suite grün verifizieren** (Live-Bot unverändert)

Run: `cd tools/voice-echo-bot && python3 -m pytest -v`
Expected: PASS — insbesondere `test_bot.py` bleibt vollständig grün. Falls ein `test_bot`-Test eine entfernte Methode direkt aufruft (`_do_lookup`/`_do_issue`/`_file_unparsed`/`_first_name`), diesen Test auf `jarvis_brain`-Aufruf umziehen (gleiche Erwartung) und dabei die Assertions unverändert lassen.

- [ ] **Step 7: Commit**

```bash
git add tools/voice-echo-bot/jarvis_brain.py tools/voice-echo-bot/test_jarvis_brain.py tools/voice-echo-bot/bot.py
git commit -m "refactor(voice-echo-bot): Jarvis-Gehirn in jarvis_brain herauslösen (Bot delegiert, Verhalten unverändert)"
```

---

## Task 3: `wake.py` — openwakeword-Wrapper

**Files:**
- Create: `tools/wake-satellite/wake.py`
- Create: `tools/wake-satellite/test_wake.py`
- Create: `tools/wake-satellite/conftest.py`

**Interfaces:**
- Consumes: `openwakeword.model.Model` (injizierbar über `model_factory`).
- Produces: `wake.WakeDetector(model_paths, threshold=0.5, inference_framework="tflite", model_factory=Model)` mit `.process(frame) -> (word, score) | None` und `.reset() -> None`.

- [ ] **Step 1: conftest schreiben** — `tools/wake-satellite/conftest.py`

```python
import os
import sys

# Geteilte voice-echo-bot-Module (jarvis_brain, tts, transcribe, config, …)
# in Tests importierbar machen.
_VCO = os.path.join(os.path.dirname(__file__), "..", "voice-echo-bot")
sys.path.insert(0, os.path.abspath(_VCO))
```

- [ ] **Step 2: Failing Test schreiben** — `tools/wake-satellite/test_wake.py`

```python
import numpy as np
import wake


class FakeModel:
    def __init__(self, wakeword_models=None, inference_framework=None):
        self.scores = {"hey_jarvis": 0.0}
        self.reset_called = 0
    def predict(self, frame):
        return self.scores
    def reset(self):
        self.reset_called += 1


def _det(threshold=0.5):
    holder = {}
    def factory(**kw):
        holder["model"] = FakeModel(**kw)
        return holder["model"]
    d = wake.WakeDetector(["hey_jarvis.tflite"], threshold=threshold, model_factory=factory)
    return d, holder["model"]


def test_detects_above_threshold():
    d, model = _det()
    model.scores = {"hey_jarvis": 0.9}
    assert d.process(np.zeros(1280, dtype=np.int16)) == ("hey_jarvis", 0.9)


def test_none_below_threshold():
    d, model = _det()
    model.scores = {"hey_jarvis": 0.2}
    assert d.process(np.zeros(1280, dtype=np.int16)) is None


def test_picks_highest_scoring_word():
    d, model = _det()
    model.scores = {"hey_jarvis": 0.6, "hey_luna": 0.8}
    assert d.process(np.zeros(1280, dtype=np.int16)) == ("hey_luna", 0.8)


def test_reset_delegates():
    d, model = _det()
    d.reset()
    assert model.reset_called == 1
```

- [ ] **Step 3: Test rot verifizieren**

Run: `cd tools/wake-satellite && python3 -m pytest test_wake.py -v`
Expected: FAIL (`ModuleNotFoundError: wake`).

- [ ] **Step 4: `wake.py` schreiben**

```python
# tools/wake-satellite/wake.py
"""openwakeword-Wrapper: Audio-Frames -> Wake-Word-Detektion.

Kapselt Modell-Laden und Schwellenprüfung. Kennt weder Mikrofon noch IO —
int16-Frame rein, (wort, score) über der Schwelle oder None raus. Dadurch
ohne Audio-Hardware testbar (Model-Fabrik injizierbar)."""

DEFAULT_THRESHOLD = 0.5


def _default_factory(**kwargs):
    from openwakeword.model import Model
    return Model(**kwargs)


class WakeDetector:
    def __init__(self, model_paths, threshold=DEFAULT_THRESHOLD,
                 inference_framework="tflite", model_factory=None):
        factory = model_factory or _default_factory
        self._model = factory(wakeword_models=list(model_paths),
                              inference_framework=inference_framework)
        self.threshold = threshold

    def process(self, frame):
        scores = self._model.predict(frame)
        best_word, best_score = None, -1.0
        for word, score in scores.items():
            if score > best_score:
                best_word, best_score = word, float(score)
        if best_word is not None and best_score >= self.threshold:
            return (best_word, best_score)
        return None

    def reset(self):
        self._model.reset()
```

- [ ] **Step 5: Tests grün verifizieren**

Run: `cd tools/wake-satellite && python3 -m pytest test_wake.py -v`
Expected: PASS (4).

- [ ] **Step 6: Commit**

```bash
git add tools/wake-satellite/wake.py tools/wake-satellite/test_wake.py tools/wake-satellite/conftest.py
git commit -m "feat(wake-satellite): openwakeword-Wrapper (Frame -> Detektion, hardware-frei testbar)"
```

---

## Task 4: `capture.py` — Aufnahme-Logik, Nachfrage-Fenster, wav-Schreiben

**Files:**
- Create: `tools/wake-satellite/capture.py`
- Create: `tools/wake-satellite/test_capture.py`

**Interfaces:**
- Consumes: `numpy`; `sounddevice` nur in `MicStream` (nicht getestet).
- Produces:
  - `capture.record_until_silence(frames, *, silence_rms=500, hang=10, max_frames=150) -> list[np.int16-array]`
  - `capture.wait_for_speech(frames, *, window_frames, silence_rms=500) -> bool`
  - `capture.frames_to_wav(frames, path, sample_rate=16000) -> path`
  - `capture.MicStream(device=None)` mit `__iter__` (Hardware, ungetestet)
  - Konstanten `SAMPLE_RATE=16000`, `FRAME_SAMPLES=1280`.

- [ ] **Step 1: Failing Tests schreiben** — `tools/wake-satellite/test_capture.py`

```python
import wave
import numpy as np
import capture


def loud(n=1280):  return (np.ones(n, dtype=np.int16) * 5000)
def quiet(n=1280): return np.zeros(n, dtype=np.int16)


def test_record_starts_at_speech_and_stops_after_silence():
    # 2 stille (ignoriert), 3 laute, dann hang=2 stille -> stop
    frames = [quiet(), quiet(), loud(), loud(), loud(), quiet(), quiet(), loud()]
    out = capture.record_until_silence(iter(frames), hang=2)
    # Startet beim ersten lauten Frame; endet nach 2 stillen; letztes loud nicht mehr
    assert len(out) == 5  # 3 loud + 2 trailing silence


def test_record_respects_max_frames():
    frames = (loud() for _ in range(1000))
    out = capture.record_until_silence(frames, max_frames=10)
    assert len(out) == 10


def test_record_empty_when_only_silence():
    out = capture.record_until_silence(iter([quiet(), quiet(), quiet()]), hang=2)
    assert out == []


def test_wait_for_speech_true_on_first_loud():
    assert capture.wait_for_speech(iter([quiet(), loud(), quiet()]), window_frames=5) is True


def test_wait_for_speech_false_after_window():
    assert capture.wait_for_speech(iter([quiet(), quiet(), quiet()]), window_frames=3) is False


def test_frames_to_wav_roundtrip(tmp_path):
    path = str(tmp_path / "a.wav")
    capture.frames_to_wav([loud(), loud()], path)
    with wave.open(path, "rb") as wf:
        assert wf.getframerate() == 16000
        assert wf.getnchannels() == 1
        assert wf.getnframes() == 2560
```

- [ ] **Step 2: Tests rot verifizieren**

Run: `cd tools/wake-satellite && python3 -m pytest test_capture.py -v`
Expected: FAIL (`ModuleNotFoundError: capture`).

- [ ] **Step 3: `capture.py` schreiben**

```python
# tools/wake-satellite/capture.py
"""Mikrofon-Aufnahme: Wake-Trigger-Aufnahme + Nachfrage-Fenster + wav-Export.

Energie-basierte Stille-Erkennung (kein externes VAD), damit mit synthetischen
Frames testbar. Der Mikrofon-Stream (`MicStream`) ist der einzige Hardware-Teil
und wird als Frame-Iterator in die Logik injiziert."""
import wave

import numpy as np

SAMPLE_RATE = 16000
FRAME_SAMPLES = 1280          # 80 ms @ 16 kHz
SILENCE_RMS = 500
SILENCE_HANG_FRAMES = 10      # ~0,8 s Stille beendet die Aufnahme
MAX_RECORD_FRAMES = 150       # ~12 s Deckel


def _rms(frame):
    if len(frame) == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(frame.astype(np.float64)))))


def record_until_silence(frames, *, silence_rms=SILENCE_RMS,
                         hang=SILENCE_HANG_FRAMES, max_frames=MAX_RECORD_FRAMES):
    collected = []
    started = False
    silent_run = 0
    for frame in frames:
        is_loud = _rms(frame) >= silence_rms
        if not started:
            if is_loud:
                started = True
                collected.append(frame)
            continue
        collected.append(frame)
        silent_run = 0 if is_loud else silent_run + 1
        if silent_run >= hang or len(collected) >= max_frames:
            break
    return collected


def wait_for_speech(frames, *, window_frames, silence_rms=SILENCE_RMS):
    for i, frame in enumerate(frames):
        if i >= window_frames:
            return False
        if _rms(frame) >= silence_rms:
            return True
    return False


def frames_to_wav(frames, path, sample_rate=SAMPLE_RATE):
    audio = np.concatenate(frames) if frames else np.zeros(0, dtype=np.int16)
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(audio.astype(np.int16).tobytes())
    return path


class MicStream:  # pragma: no cover — Hardware
    """Fortlaufender 16-kHz-mono-int16-Frame-Iterator via sounddevice."""
    def __init__(self, device=None, blocksize=FRAME_SAMPLES):
        import sounddevice as sd
        self._blocksize = blocksize
        self._stream = sd.InputStream(samplerate=SAMPLE_RATE, channels=1,
                                      dtype="int16", blocksize=blocksize, device=device)
        self._stream.start()

    def read(self):
        data, _ = self._stream.read(self._blocksize)
        return np.asarray(data, dtype=np.int16).reshape(-1)

    def __iter__(self):
        while True:
            yield self.read()
```

- [ ] **Step 4: Tests grün verifizieren**

Run: `cd tools/wake-satellite && python3 -m pytest test_capture.py -v`
Expected: PASS (6).

- [ ] **Step 5: Commit**

```bash
git add tools/wake-satellite/capture.py tools/wake-satellite/test_capture.py
git commit -m "feat(wake-satellite): capture (Aufnahme bis Stille, Nachfrage-Fenster, wav-Export)"
```

---

## Task 5: `playback.py` — AirPlay-Routing zum HomePod + Fallback

**Files:**
- Create: `tools/wake-satellite/playback.py`
- Create: `tools/wake-satellite/test_playback.py`

**Interfaces:**
- Consumes: `SwitchAudioSource` + `afplay` via `subprocess.run` (gemockt in Tests).
- Produces: `playback.play(path, device="Homepod Studio") -> None`. Wirft nie; bei Fehler Fallback-`afplay` ohne Umschaltung. Schaltet danach auf das vorherige Ausgabegerät zurück.

- [ ] **Step 1: Failing Tests schreiben** — `tools/wake-satellite/test_playback.py`

```python
import subprocess
import playback


class FakeRun:
    def __init__(self, fail_on=None):
        self.calls = []
        self.fail_on = fail_on or set()   # z.B. {"-s Homepod Studio"}
    def __call__(self, args, check=False, capture_output=False, text=False):
        self.calls.append(args)
        key = " ".join(args[1:])          # ohne Binary-Namen
        if any(f in " ".join(args) for f in self.fail_on):
            raise subprocess.CalledProcessError(1, args)

        class R:  # afplay/-s liefern nichts Wichtiges; -c liefert Gerätenamen
            stdout = "Alte Ausgabe\n"
        return R()


def test_play_switches_to_homepod_and_back(monkeypatch):
    fake = FakeRun()
    monkeypatch.setattr(playback.subprocess, "run", fake)
    playback.play("/tmp/x.mp3", device="Homepod Studio")
    joined = [" ".join(c) for c in fake.calls]
    assert any("SwitchAudioSource -c" in j for j in joined)          # aktuelles Gerät lesen
    assert any("-s Homepod Studio" in j for j in joined)             # umschalten
    assert any("afplay /tmp/x.mp3" in j for j in joined)             # abspielen
    assert any("-s Alte Ausgabe" in j for j in joined)               # zurückschalten


def test_play_falls_back_when_switch_fails(monkeypatch):
    fake = FakeRun(fail_on={"-s Homepod Studio"})
    monkeypatch.setattr(playback.subprocess, "run", fake)
    playback.play("/tmp/x.mp3", device="Homepod Studio")   # darf NICHT werfen
    joined = [" ".join(c) for c in fake.calls]
    # trotz Umschalt-Fehler wurde direkt abgespielt
    assert any("afplay /tmp/x.mp3" in j for j in joined)


def test_play_never_raises_when_everything_fails(monkeypatch):
    fake = FakeRun(fail_on={"afplay", "SwitchAudioSource"})
    monkeypatch.setattr(playback.subprocess, "run", fake)
    playback.play("/tmp/x.mp3")  # kein Throw
```

- [ ] **Step 2: Tests rot verifizieren**

Run: `cd tools/wake-satellite && python3 -m pytest test_playback.py -v`
Expected: FAIL (`ModuleNotFoundError: playback`).

- [ ] **Step 3: `playback.py` schreiben**

```python
# tools/wake-satellite/playback.py
"""Audio-Ausgabe über AirPlay-HomePod (+ Fallback auf Standardausgabe).

`SwitchAudioSource` (brew) schaltet das Ausgabegerät, `afplay` spielt. Jeder
Fehler fällt still auf die aktuelle Ausgabe zurück und wirft NIE nach aussen —
eine missglückte Sprachausgabe darf den Satelliten nicht abschiessen."""
import subprocess
import traceback

SWITCH_BIN = "SwitchAudioSource"
AFPLAY_BIN = "afplay"


def _run(args):
    return subprocess.run(args, check=True, capture_output=True, text=True)


def _current_output():
    try:
        return _run([SWITCH_BIN, "-c"]).stdout.strip()
    except Exception:  # noqa: BLE001
        return None


def play(path, device="Homepod Studio"):
    previous = _current_output()
    switched = False
    try:
        _run([SWITCH_BIN, "-s", device])
        switched = True
        _run([AFPLAY_BIN, path])
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        try:
            _run([AFPLAY_BIN, path])       # Fallback: aktuelle Ausgabe
        except Exception:  # noqa: BLE001
            traceback.print_exc()
    finally:
        if switched and previous:
            try:
                _run([SWITCH_BIN, "-s", previous])
            except Exception:  # noqa: BLE001
                traceback.print_exc()
```

- [ ] **Step 4: Tests grün verifizieren**

Run: `cd tools/wake-satellite && python3 -m pytest test_playback.py -v`
Expected: PASS (3).

- [ ] **Step 5: Commit**

```bash
git add tools/wake-satellite/playback.py tools/wake-satellite/test_playback.py
git commit -m "feat(wake-satellite): playback (AirPlay-Routing zum HomePod + Fallback, nie fatal)"
```

---

## Task 6: `earcon.py` — Bestätigungston „ich höre"

**Files:**
- Create: `tools/wake-satellite/earcon.py`
- Create: `tools/wake-satellite/test_earcon.py`

**Interfaces:**
- Consumes: `afplay` via `subprocess.run` (gemockt).
- Produces: `earcon.ensure_wav(path=DEFAULT_PATH, freq=880, ms=150, sample_rate=16000) -> path`; `earcon.beep(path=DEFAULT_PATH) -> None` (nie fatal).

- [ ] **Step 1: Failing Tests schreiben** — `tools/wake-satellite/test_earcon.py`

```python
import wave
import earcon


def test_ensure_wav_creates_file_of_expected_length(tmp_path):
    path = str(tmp_path / "beep.wav")
    earcon.ensure_wav(path, ms=100, sample_rate=16000)
    with wave.open(path, "rb") as wf:
        assert wf.getnframes() == 1600  # 100 ms @ 16 kHz


def test_ensure_wav_is_idempotent(tmp_path):
    path = str(tmp_path / "beep.wav")
    earcon.ensure_wav(path, ms=100)
    mtime1 = __import__("os").path.getmtime(path)
    earcon.ensure_wav(path, ms=100)      # existiert -> nicht neu schreiben
    assert __import__("os").path.getmtime(path) == mtime1


def test_beep_never_raises(monkeypatch, tmp_path):
    def boom(*a, **k): raise RuntimeError("afplay weg")
    monkeypatch.setattr(earcon.subprocess, "run", boom)
    earcon.beep(str(tmp_path / "beep.wav"))   # kein Throw
```

- [ ] **Step 2: Tests rot verifizieren**

Run: `cd tools/wake-satellite && python3 -m pytest test_earcon.py -v`
Expected: FAIL (`ModuleNotFoundError: earcon`).

- [ ] **Step 3: `earcon.py` schreiben**

```python
# tools/wake-satellite/earcon.py
"""Kurzer 'ich höre'-Ton. Erzeugt einmalig eine WAV (stdlib) und spielt sie
über die Standardausgabe via afplay. Nie fatal."""
import math
import os
import struct
import subprocess
import traceback
import wave

DEFAULT_PATH = os.path.expanduser("~/.paperclip/wake-satellite/earcon.wav")


def ensure_wav(path=DEFAULT_PATH, freq=880, ms=150, sample_rate=16000):
    if os.path.exists(path):
        return path
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    n = int(sample_rate * ms / 1000)
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        for i in range(n):
            val = int(3000 * math.sin(2 * math.pi * freq * i / sample_rate))
            wf.writeframes(struct.pack("<h", val))
    return path


def beep(path=DEFAULT_PATH):
    try:
        ensure_wav(path)
        subprocess.run(["afplay", path], check=True, capture_output=True)
    except Exception:  # noqa: BLE001
        traceback.print_exc()
```

- [ ] **Step 4: Tests grün verifizieren**

Run: `cd tools/wake-satellite && python3 -m pytest test_earcon.py -v`
Expected: PASS (3).

- [ ] **Step 5: Commit**

```bash
git add tools/wake-satellite/earcon.py tools/wake-satellite/test_earcon.py
git commit -m "feat(wake-satellite): earcon (Bestätigungston, stdlib-generiert, nie fatal)"
```

---

## Task 7: `sat_config.py` + `satellite.py` — Interaktions-Schleife

**Files:**
- Create: `tools/wake-satellite/sat_config.py`
- Create: `tools/wake-satellite/satellite.py`
- Create: `tools/wake-satellite/test_satellite.py`

**Interfaces:**
- Consumes: `sat_config`, `config` (voice-echo-bot: `load_env`, `ENV_PATH`, `load_paperclip_token`), `jarvis_brain.respond`, `transcribe.transcribe`, `tts.synthesize`, `tts.TtsError`, `capture.*`, `playback.play`, `earcon.beep`, `wake.WakeDetector`.
- Produces:
  - `satellite.handle_interaction(frames, deps, tenant=sat_config.TENANT, history=None) -> list` (aktualisierte History). `deps` = dict mit Keys `whisper_model`, `eleven_key`, `chat_model`, `token` (String **oder** Callable).
  - `satellite.build_deps() -> dict` (Hardware-nah; öffnet nichts außer Env-Lesen).
  - `satellite.main() -> None` (Hardware; ungetestet).

- [ ] **Step 1: `sat_config.py` schreiben**

```python
# tools/wake-satellite/sat_config.py
"""Konstanten des Wake-Word-Satelliten (Walter / WHITESTAG, Mac Studio)."""
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(BASE_DIR, "models", "hey_jarvis_v0.1.tflite")

WAKE_THRESHOLD = 0.5
WAKE_MODELS = [MODEL_PATH]

SAMPLE_RATE = 16000
FRAME_SAMPLES = 1280
FOLLOWUP_WINDOW_SEC = 6
FOLLOWUP_WINDOW_FRAMES = int(FOLLOWUP_WINDOW_SEC * SAMPLE_RATE / FRAME_SAMPLES)  # 75
PLAYBACK_COOLDOWN_SEC = 1.0
MAX_HISTORY_MESSAGES = 16

HOMEPOD_DEVICE = "Homepod Studio"
TTS_FORMAT = "mp3_44100_128"

# Mandant fest verdrahtet.
TENANT = {
    "name": "Walter / WHITESTAG",
    "company_id": "9cebf3cf-efe8-4597-a400-f06488900a87",
    "ceo_agent_id": "506c873e-3a40-4483-9a45-0eb0fa1554bb",
    "vault": "whitestag",
}
```

- [ ] **Step 2: Failing Tests schreiben** — `tools/wake-satellite/test_satellite.py`

```python
import numpy as np
import satellite
import sat_config


def loud(n=1280):  return (np.ones(n, dtype=np.int16) * 5000)
def quiet(n=1280): return np.zeros(n, dtype=np.int16)


def _deps():
    return {"whisper_model": "m.bin", "eleven_key": "k",
            "chat_model": "google/gemma-4-12b", "token": "tok"}


def test_single_turn_speaks_answer(monkeypatch):
    spoken = []
    monkeypatch.setattr(satellite.transcribe, "transcribe", lambda wav, model: "Wie spät?")
    monkeypatch.setattr(satellite.jarvis_brain, "respond",
                        lambda text, tenant, token, model, history=None: {"kind": "chat", "answer": "Kurz nach drei."})
    monkeypatch.setattr(satellite, "_speak", lambda text, deps: spoken.append(text))
    # 1 Runde Sprache, dann Nachfrage-Fenster leer -> Ende
    frames = iter([loud(), loud(), quiet(), quiet(), quiet(), quiet(), quiet(),
                   quiet(), quiet(), quiet(), quiet(), quiet(), quiet(), quiet()])
    hist = satellite.handle_interaction(frames, _deps())
    assert spoken == ["Kurz nach drei."]
    # Chat-Antwort landet in der History
    assert hist[-1] == {"role": "assistant", "content": "Kurz nach drei."}


def test_followup_window_triggers_second_turn(monkeypatch):
    answers = iter([{"kind": "chat", "answer": "A1"}, {"kind": "chat", "answer": "A2"}])
    calls = []
    monkeypatch.setattr(satellite.transcribe, "transcribe", lambda wav, model: "frage")
    monkeypatch.setattr(satellite.jarvis_brain, "respond",
                        lambda *a, **k: (calls.append(1) or next(answers)))
    spoken = []
    monkeypatch.setattr(satellite, "_speak", lambda text, deps: spoken.append(text))
    # Runde 1 Sprache -> hang; Nachfrage-Fenster: sofort laut -> Runde 2 Sprache -> hang;
    # Nachfrage-Fenster 2: nur Stille -> Ende.
    frames = iter(
        [loud(), quiet(), quiet(), quiet(), quiet(), quiet(), quiet(), quiet(), quiet(), quiet(), quiet()]  # Runde 1 (hang=10)
        + [loud()]                                                                                          # Nachfrage 1: Sprache!
        + [loud(), quiet(), quiet(), quiet(), quiet(), quiet(), quiet(), quiet(), quiet(), quiet(), quiet()]  # Runde 2
        + [quiet()] * sat_config.FOLLOWUP_WINDOW_FRAMES                                                      # Nachfrage 2: leer
    )
    satellite.handle_interaction(frames, _deps())
    assert spoken == ["A1", "A2"]
    assert len(calls) == 2


def test_empty_transcript_ends_without_speaking(monkeypatch):
    monkeypatch.setattr(satellite.transcribe, "transcribe", lambda wav, model: "")
    responded = []
    monkeypatch.setattr(satellite.jarvis_brain, "respond",
                        lambda *a, **k: responded.append(1) or {"kind": "empty", "answer": "Nichts erkannt, bitte erneut."})
    spoken = []
    monkeypatch.setattr(satellite, "_speak", lambda text, deps: spoken.append(text))
    frames = iter([quiet(), quiet(), quiet()])   # nie Sprache -> record leer
    satellite.handle_interaction(frames, _deps())
    assert spoken == []          # nichts aufgenommen -> nichts gesprochen
    assert responded == []       # respond gar nicht erst aufgerufen


def test_token_callable_is_resolved(monkeypatch):
    seen = {}
    monkeypatch.setattr(satellite.transcribe, "transcribe", lambda wav, model: "hi")
    monkeypatch.setattr(satellite.jarvis_brain, "respond",
                        lambda text, tenant, token, model, history=None: seen.update(token=token) or {"kind": "chat", "answer": "ok"})
    monkeypatch.setattr(satellite, "_speak", lambda text, deps: None)
    deps = _deps()
    deps["token"] = lambda: "AUFGELÖST"
    frames = iter([loud()] + [quiet()] * 12 + [quiet()] * sat_config.FOLLOWUP_WINDOW_FRAMES)
    satellite.handle_interaction(frames, deps)
    assert seen["token"] == "AUFGELÖST"
```

- [ ] **Step 3: Tests rot verifizieren**

Run: `cd tools/wake-satellite && python3 -m pytest test_satellite.py -v`
Expected: FAIL (`ModuleNotFoundError: satellite`).

- [ ] **Step 4: `satellite.py` schreiben**

```python
# tools/wake-satellite/satellite.py
"""Wake-Word-Satellit „Hey Jarvis": Schleife + Interaktion.

`main` verdrahtet Mikrofon + Wake-Word (Hardware). `handle_interaction` ist die
testbare Interaktion nach einem Wake-Treffer: aufnehmen -> transkribieren ->
Jarvis-Gehirn -> sprechen -> 6-s-Nachfrage-Fenster. Ein Gehirn (jarvis_brain),
geteilt mit dem Telegram-Bot."""
import os
import tempfile
import time
import traceback

import config as vco_config          # voice-echo-bot: load_env, ENV_PATH, load_paperclip_token
import jarvis_brain
import transcribe
import tts

import sat_config
import capture
import earcon
import playback
import wake


def _resolve_token(deps):
    tok = deps["token"]
    return tok() if callable(tok) else tok


def _remember(history, user_text, assistant_text):
    hist = list(history)
    hist.append({"role": "user", "content": user_text})
    hist.append({"role": "assistant", "content": assistant_text})
    if len(hist) > sat_config.MAX_HISTORY_MESSAGES:
        del hist[:len(hist) - sat_config.MAX_HISTORY_MESSAGES]
    return hist


def _transcribe(recorded, deps):
    workdir = tempfile.mkdtemp()
    wav = capture.frames_to_wav(recorded, os.path.join(workdir, "utt.wav"))
    try:
        return transcribe.transcribe(wav, deps["whisper_model"], workdir=workdir)
    except transcribe.TranscriptionError:
        traceback.print_exc()
        return ""


def _speak(text, deps):
    if not (text or "").strip():
        return
    dest = os.path.join(tempfile.mkdtemp(), "reply.mp3")
    try:
        tts.synthesize(text, deps["eleven_key"], dest, output_format=sat_config.TTS_FORMAT)
    except tts.TtsError:
        traceback.print_exc()
        return
    playback.play(dest, device=sat_config.HOMEPOD_DEVICE)


def handle_interaction(frames, deps, tenant=None, history=None):
    tenant = tenant or sat_config.TENANT
    history = list(history or [])
    while True:
        recorded = capture.record_until_silence(frames)
        if not recorded:
            break
        text = _transcribe(recorded, deps)
        result = jarvis_brain.respond(text, tenant, _resolve_token(deps),
                                      deps["chat_model"], history=history)
        answer = result["answer"]
        if result["kind"] in ("chat", "lookup", "issue"):
            history = _remember(history, text, answer)
        _speak(answer, deps)
        if not capture.wait_for_speech(frames, window_frames=sat_config.FOLLOWUP_WINDOW_FRAMES):
            break
    return history


def build_deps():
    env = vco_config.load_env(vco_config.ENV_PATH)
    detector = wake.WakeDetector(sat_config.WAKE_MODELS, threshold=sat_config.WAKE_THRESHOLD)
    return {
        "detector": detector,
        "whisper_model": os.path.expanduser(env["WHISPER_MODEL"]),
        "eleven_key": env.get("ELEVENLABS_API_KEY"),
        "chat_model": env.get("CHAT_MODEL") or jarvis_brain.llm.DEFAULT_MODEL,
        "token": vco_config.load_paperclip_token,
    }


def main():  # pragma: no cover — Hardware
    import sys
    print("wake-satellit „Hey Jarvis" startet…", file=sys.stderr)
    deps = build_deps()
    detector = deps["detector"]
    mic = capture.MicStream()
    frames = iter(mic)
    while True:
        try:
            frame = next(frames)
            if detector.process(frame) is None:
                continue
            earcon.beep()
            handle_interaction(frames, deps)   # verbraucht denselben Stream
            detector.reset()
            time.sleep(sat_config.PLAYBACK_COOLDOWN_SEC)
        except Exception:  # noqa: BLE001
            traceback.print_exc()
            time.sleep(1)


if __name__ == "__main__":
    main()
```

- [ ] **Step 5: Tests grün verifizieren**

Run: `cd tools/wake-satellite && python3 -m pytest test_satellite.py -v`
Expected: PASS (4).

- [ ] **Step 6: Gesamte Satellit-Suite grün verifizieren**

Run: `cd tools/wake-satellite && python3 -m pytest -v`
Expected: PASS (wake + capture + playback + earcon + satellite).

- [ ] **Step 7: Commit**

```bash
git add tools/wake-satellite/sat_config.py tools/wake-satellite/satellite.py tools/wake-satellite/test_satellite.py
git commit -m "feat(wake-satellite): Interaktions-Schleife (Wake -> Aufnahme -> jarvis_brain -> HomePod, 6-s-Nachfrage)"
```

---

## Task 8: Deployment — venv, LaunchAgent, Deploy-Skript, DEPLOY.md

**Files:**
- Create: `tools/wake-satellite/requirements.txt`
- Create: `tools/wake-satellite/de.whitestag.wake-satellite.plist`
- Create: `tools/wake-satellite/deploy.sh`
- Create: `tools/wake-satellite/DEPLOY.md`

**Interfaces:**
- Consumes: die fertigen Module aus Tasks 1–7 + das Repo-Root-Modell `hey_jarvis_v0.1.tflite`.
- Produces: reproduzierbarer Live-Deploy nach `~/.paperclip/scripts/wake-satellite/` + LaunchAgent.

- [ ] **Step 1: `requirements.txt` schreiben**

```
numpy>=1.26
sounddevice>=0.4.6
openwakeword>=0.6.0
# tflite-Backend: auf macOS über tensorflow (tflite-runtime hat dort keine Wheels).
tensorflow>=2.16 ; sys_platform == "darwin"
```

- [ ] **Step 2: `de.whitestag.wake-satellite.plist` schreiben** (LaunchAgent, GUI-Session wg. Mikrofon-TCC; `__HOME__` beim Deploy ersetzt)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!-- LaunchAgent (nicht Daemon): braucht die GUI-Session für Mikrofon-Zugriff.
     Beim Deploy __HOME__ ersetzen (siehe DEPLOY.md). -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>de.whitestag.wake-satellite</string>
    <key>ProgramArguments</key>
    <array>
        <string>__HOME__/.paperclip/scripts/wake-satellite/venv/bin/python3</string>
        <string>__HOME__/.paperclip/scripts/wake-satellite/satellite.py</string>
    </array>
    <key>WorkingDirectory</key><string>__HOME__/.paperclip/scripts/wake-satellite</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>__HOME__/.paperclip/logs/wake-satellite.log</string>
    <key>StandardErrorPath</key><string>__HOME__/.paperclip/logs/wake-satellite.log</string>
</dict>
</plist>
```

- [ ] **Step 3: `deploy.sh` schreiben** (kopiert Satellit + geteilte Module + Modell, baut venv, ersetzt `__HOME__`)

```bash
#!/usr/bin/env bash
# Deploy des Wake-Word-Satelliten nach ~/.paperclip/scripts/wake-satellite/.
# macOS launchd kann CloudStorage/SynologyDrive nicht lesen -> Live-Kopie unter ~/.paperclip.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC_SAT="$REPO_ROOT/tools/wake-satellite"
SRC_VCO="$REPO_ROOT/tools/voice-echo-bot"
DEST="$HOME/.paperclip/scripts/wake-satellite"
MODEL_SRC="$REPO_ROOT/hey_jarvis_v0.1.tflite"

mkdir -p "$DEST/models" "$HOME/.paperclip/logs"

# Satellit-Module
for f in wake.py capture.py playback.py earcon.py sat_config.py satellite.py; do
  cp "$SRC_SAT/$f" "$DEST/$f"
done
# Geteilte voice-echo-bot-Module (ein config.py, keine Kollision)
for f in config.py llm.py vault_client.py paperclip_client.py transcribe.py tts.py jarvis_brain.py; do
  cp "$SRC_VCO/$f" "$DEST/$f"
done
# Wake-Modell
cp "$MODEL_SRC" "$DEST/models/hey_jarvis_v0.1.tflite"

# venv
if [ ! -d "$DEST/venv" ]; then
  python3 -m venv "$DEST/venv"
fi
"$DEST/venv/bin/pip" install --upgrade pip
"$DEST/venv/bin/pip" install -r "$SRC_SAT/requirements.txt"

# Modell-Ladbarkeit prüfen (scheitert früh statt im Crashloop)
"$DEST/venv/bin/python3" -c "from openwakeword.model import Model; \
Model(wakeword_models=['$DEST/models/hey_jarvis_v0.1.tflite'], inference_framework='tflite'); \
print('openwakeword: Modell geladen ✓')"

# LaunchAgent installieren
PLIST_DEST="$HOME/Library/LaunchAgents/de.whitestag.wake-satellite.plist"
sed "s#__HOME__#$HOME#g" "$SRC_SAT/de.whitestag.wake-satellite.plist" > "$PLIST_DEST"

echo "Deploy fertig. Nächste Schritte (siehe DEPLOY.md):"
echo "  1) Mikrofon-Freigabe für $DEST/venv/bin/python3 in Systemeinstellungen."
echo "  2) launchctl bootstrap gui/\$(id -u) $PLIST_DEST"
```

- [ ] **Step 4: `deploy.sh` ausführbar machen + syntaktisch prüfen**

Run:
```bash
cd tools/wake-satellite && chmod +x deploy.sh && bash -n deploy.sh && plutil -lint de.whitestag.wake-satellite.plist
```
Expected: `deploy.sh` ohne Syntaxfehler; `plutil` meldet `OK`.

- [ ] **Step 5: `DEPLOY.md` schreiben** (venv, Mikrofon-Freigabe, SwitchAudioSource, LaunchAgent, HomePod-Name)

````markdown
# Wake-Word-Satellit „Hey Jarvis" — Deploy (Mac Studio)

Freihändiger Sprachzugang zu Jarvis: „Hey Jarvis, …" -> Antwort laut über den
HomePod „Homepod Studio". Läuft als **LaunchAgent** (nicht Daemon) in Walters
GUI-Session — nur so bekommt der Prozess Mikrofon-Zugriff.

## Voraussetzungen (einmalig)

- Homebrew-Tools: `brew install switchaudio-osx ffmpeg whisper-cpp`
  (`SwitchAudioSource`, `ffmpeg`, `whisper-cli`).
- Der HomePod muss in **Systemeinstellungen -> Ton -> Ausgabe** als
  `Homepod Studio` erscheinen (AirPlay). Heißt er anders, `HOMEPOD_DEVICE`
  in `sat_config.py` anpassen und neu deployen.
- `~/.paperclip/voice-echo-bot.env` existiert bereits (vom Telegram-Jarvis) mit
  `WHISPER_MODEL`, `ELEVENLABS_API_KEY`, `CHAT_MODEL`. Der Satellit nutzt sie.

## Deploy

```bash
cd "…/Paperclip/tools/wake-satellite"
./deploy.sh
```

Das Skript kopiert Satellit + geteilte Module + Wake-Modell nach
`~/.paperclip/scripts/wake-satellite/`, baut das venv, prüft die
Modell-Ladbarkeit und installiert den LaunchAgent.

### macOS-Hinweis zum tflite-Backend

`openwakeword` braucht ein tflite-Backend. Auf macOS liefert `tensorflow`
(in `requirements.txt`) das mit. Falls die Modell-Prüfung im Deploy fehlschlägt,
im venv `pip install tensorflow` nachziehen und `deploy.sh` erneut laufen lassen.

## Mikrofon-Freigabe (Pflicht, manuell)

Ein launchd-Prozess kann den Berechtigungsdialog nicht auslösen. Einmalig:

1. `~/.paperclip/scripts/wake-satellite/venv/bin/python3` in
   **Systemeinstellungen -> Datenschutz & Sicherheit -> Mikrofon** hinzufügen
   und aktivieren. (Ggf. den Ordner via Finder „Gehe zu" öffnen und die Binärdatei
   dorthin ziehen.)
2. Ohne Freigabe protokolliert der Satellit einen klaren Fehler statt still zu
   crashen — im Log sichtbar.

## Start / Stop / Logs

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/de.whitestag.wake-satellite.plist
launchctl kickstart -k gui/$(id -u)/de.whitestag.wake-satellite     # Neustart
launchctl bootout   gui/$(id -u)/de.whitestag.wake-satellite        # Stop
tail -f ~/.paperclip/logs/wake-satellite.log
```

## Bekannte Grenzen (Phase 1)

- Nur Jarvis. Luna folgt in Phase 2 (eigener Zugang zu ihrem n8n-Gehirn).
- Während der HomePod spricht, ist die Wake-Erkennung aus; das 6-s-Nachfrage-
  Fenster startet erst nach der Wiedergabe. Restliches Echo dämpft der Cooldown.
- Deploy-Lücke Repo <-> Live ist ansage-pflichtig: nach Code-Änderung erneut
  `./deploy.sh` + `kickstart -k`.
````

- [ ] **Step 6: Commit**

```bash
git add tools/wake-satellite/requirements.txt tools/wake-satellite/de.whitestag.wake-satellite.plist tools/wake-satellite/deploy.sh tools/wake-satellite/DEPLOY.md
git commit -m "feat(wake-satellite): Deploy (venv, LaunchAgent, deploy.sh, DEPLOY.md)"
```

---

## Abschluss-Verifikation (nach Task 8)

- [ ] `cd tools/voice-echo-bot && python3 -m pytest -v` — Live-Bot-Suite vollständig grün (Refactor ohne Regression).
- [ ] `cd tools/wake-satellite && python3 -m pytest -v` — Satellit-Suite grün.
- [ ] Deploy auf dem Mac Studio ausführen, Mikrofon freigeben, LaunchAgent booten.
- [ ] **Manueller Smoke-Test** (Hardware, nicht automatisierbar): „Hey Jarvis, wie spät ist es?" -> Earcon-Beep -> Antwort laut über „Homepod Studio". Direkt danach (ohne Wake-Word) eine Anschlussfrage stellen -> wird im 6-s-Fenster beantwortet. Log prüfen.

## Self-Review (Plan gegen Spec)

- **Spec-Abdeckung:** Wake-Word-Erkennung (T3), Aufnahme bis Stille + 6-s-Nachfrage (T4, T7), whisper-Transkription (T7 via bestehendem `transcribe`), geteiltes Jarvis-Gehirn (T2), ElevenLabs-mp3 (T1), AirPlay-HomePod (T5), Earcon (T6), fester Mandant (T7 `sat_config.TENANT`), Selbst-Trigger-Vermeidung (T7 `main`: keine Detektion während Interaktion + Cooldown), Mikrofon-TCC/LaunchAgent (T8), Deploy-Lücke (T8). Alle Spec-Abschnitte haben eine Task.
- **Platzhalter:** keine — jeder Code-Step enthält vollständigen Code, jeder Test echte Assertions.
- **Typkonsistenz:** `respond(...)->{"kind","answer"}` einheitlich in T2 (Def) und T7 (Consumer); `record_until_silence`/`wait_for_speech`/`frames_to_wav`-Signaturen aus T4 exakt in T7 genutzt; `play(path, device=...)` aus T5 in T7 (`_speak`); `WakeDetector` aus T3 in T7 (`build_deps`). `tts.synthesize(..., output_format=...)` aus T1 in T7.
