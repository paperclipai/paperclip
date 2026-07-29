# Jarvis: Zeitbewusstsein und Websuche — Implementierungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jarvis kennt die aktuelle Zeit und kann bei Fragen, die er nicht wissen kann, das Web durchsuchen — statt Uhrzeiten und Fakten zu erfinden.

**Architecture:** Drittes Steuer-Token `WEB:` neben den bestehenden `LOOKUP:` und `ISSUE:` in `jarvis_brain.py`. Ein neues Modul `web_search.py` spricht Tavily über stdlib-`urllib` an, das Ergebnis geht als JSON in einen Folge-Prompt, aus dem das Modell einen vorlesbaren Satz formt. Die aktuelle Zeit wird bei jedem Aufruf frisch in den System-Prompt gesetzt.

**Tech Stack:** Python 3.9 (stdlib only — kein `requests`), pytest, Tavily Search API.

## Global Constraints

- **Python 3.9.** Das Live-venv ist 3.9.6. Keine `match`-Statements, kein `X | Y` in Typannotationen, kein `str.removeprefix`.
- **stdlib only.** Alle bestehenden Clients (`llm.py`, `vault_client.py`) nutzen `urllib`. Keine neuen Abhängigkeiten in `requirements.txt`.
- **Deutsch** in Kommentaren, Docstrings und allen Texten, die Jarvis ausgibt.
- **Geteiltes Gehirn.** `jarvis_brain.py` bedient Sprach-Satellit *und* Telegram-Bot. Jede Änderung wirkt auf beide.
- **Keine echten Netzaufrufe in Tests.** `urlopen` wird gepatcht (Muster: `test_vault_client.py`).
- **Nie fatal.** Ein Werkzeugfehler darf den Bot nicht abschießen — Fehler werden abgefangen und ehrlich gemeldet (Muster: `_do_lookup`).
- **Zwei Teststile, jeweils dem Dateistil folgen:** `test_web_search.py` im `unittest`-Stil wie `test_vault_client.py`; `test_jarvis_brain.py` im pytest-Stil mit `monkeypatch`.

---

### Task 1: Tavily-Client `web_search.py`

**Files:**
- Create: `tools/voice-echo-bot/web_search.py`
- Test: `tools/voice-echo-bot/test_web_search.py`

**Interfaces:**
- Consumes: nichts (erstes Modul)
- Produces:
  - `web_search.search(query, api_key, max_results=3, url=SEARCH_URL, timeout=15) -> dict`
    mit der Form `{"query": str, "antwort": str, "treffer": [{"titel": str, "inhalt": str}]}`
  - `web_search.WebSearchError` (Exception)
  - `web_search.SEARCH_URL` (str)

- [ ] **Step 1: Write the failing test**

`tools/voice-echo-bot/test_web_search.py`:

```python
# tools/voice-echo-bot/test_web_search.py
import io
import json
import unittest
import urllib.error
from unittest import mock

import web_search


class _Resp:
    def __init__(self, payload):
        self._data = json.dumps(payload).encode("utf-8")
    def read(self):
        return self._data
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False


TAVILY_PAYLOAD = {
    "query": "Wetter Cottbus morgen",
    "answer": "Morgen wird es in Cottbus 24 Grad und sonnig.",
    "results": [
        {"title": "Wetter Cottbus", "url": "https://example.com/a",
         "content": "24 Grad, sonnig", "score": 0.9},
        {"title": "Vorhersage", "url": "https://example.com/b",
         "content": "kaum Wolken", "score": 0.8},
    ],
}


class TestSearch(unittest.TestCase):
    def test_returns_normalised_result(self):
        with mock.patch.object(web_search.urllib.request, "urlopen",
                               return_value=_Resp(TAVILY_PAYLOAD)):
            out = web_search.search("Wetter Cottbus morgen", "tvly-k")
        self.assertEqual(out["query"], "Wetter Cottbus morgen")
        self.assertEqual(out["antwort"], "Morgen wird es in Cottbus 24 Grad und sonnig.")
        self.assertEqual(out["treffer"],
                         [{"titel": "Wetter Cottbus", "inhalt": "24 Grad, sonnig"},
                          {"titel": "Vorhersage", "inhalt": "kaum Wolken"}])

    def test_drops_urls_from_result(self):
        # URLs sind für die Sprachausgabe wertlos und kosten nur Kontext.
        with mock.patch.object(web_search.urllib.request, "urlopen",
                               return_value=_Resp(TAVILY_PAYLOAD)):
            out = web_search.search("x", "tvly-k")
        self.assertNotIn("example.com", json.dumps(out))

    def test_sends_bearer_key_and_query(self):
        captured = {}
        def fake_urlopen(req, timeout=None):
            captured["body"] = json.loads(req.data.decode("utf-8"))
            captured["auth"] = req.get_header("Authorization")
            captured["url"] = req.full_url
            return _Resp(TAVILY_PAYLOAD)
        with mock.patch.object(web_search.urllib.request, "urlopen",
                               side_effect=fake_urlopen):
            web_search.search("Wetter", "tvly-geheim", max_results=5)
        self.assertEqual(captured["auth"], "Bearer tvly-geheim")
        self.assertEqual(captured["body"]["query"], "Wetter")
        self.assertEqual(captured["body"]["max_results"], 5)
        self.assertTrue(captured["body"]["include_answer"])
        self.assertIn("api.tavily.com", captured["url"])

    def test_missing_answer_field_is_empty_string(self):
        with mock.patch.object(web_search.urllib.request, "urlopen",
                               return_value=_Resp({"results": []})):
            out = web_search.search("x", "tvly-k")
        self.assertEqual(out["antwort"], "")
        self.assertEqual(out["treffer"], [])

    def test_http_error_raises_websearcherror(self):
        err = urllib.error.HTTPError("u", 401, "unauthorized", {}, io.BytesIO(b""))
        with mock.patch.object(web_search.urllib.request, "urlopen", side_effect=err):
            with self.assertRaises(web_search.WebSearchError):
                web_search.search("x", "tvly-k")

    def test_urlerror_raises_websearcherror(self):
        with mock.patch.object(web_search.urllib.request, "urlopen",
                               side_effect=urllib.error.URLError("offline")):
            with self.assertRaises(web_search.WebSearchError):
                web_search.search("x", "tvly-k")

    def test_broken_json_raises_websearcherror(self):
        class _Bad:
            def read(self):
                return b"kein json"
            def __enter__(self):
                return self
            def __exit__(self, *a):
                return False
        with mock.patch.object(web_search.urllib.request, "urlopen", return_value=_Bad()):
            with self.assertRaises(web_search.WebSearchError):
                web_search.search("x", "tvly-k")

    def test_timeout_raises_websearcherror(self):
        with mock.patch.object(web_search.urllib.request, "urlopen",
                               side_effect=TimeoutError("zu langsam")):
            with self.assertRaises(web_search.WebSearchError):
                web_search.search("x", "tvly-k")

    def test_empty_key_raises_websearcherror(self):
        with self.assertRaises(web_search.WebSearchError):
            web_search.search("x", "")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/voice-echo-bot && python3 -m pytest test_web_search.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'web_search'`

- [ ] **Step 3: Write minimal implementation**

`tools/voice-echo-bot/web_search.py`:

```python
# tools/voice-echo-bot/web_search.py
"""Client für die Tavily-Websuche (stdlib urllib).

POST https://api.tavily.com/search mit Bearer-Key
  -> {"query","antwort","treffer":[{"titel","inhalt"}]}

`include_answer` lässt Tavily eine verdichtete Antwort mitliefern — genau das,
was vorgelesen werden kann. URLs werden verworfen: vorgelesene Links sind
nutzlos und kosten nur Kontext.

Bei Nicht-Erreichbarkeit / kaputter Antwort wird `WebSearchError` geworfen; das
Gehirn fängt das ab und sagt ehrlich, dass es nicht ins Netz kommt.
"""
import json
import urllib.error
import urllib.request

SEARCH_URL = "https://api.tavily.com/search"
DEFAULT_MAX_RESULTS = 3


class WebSearchError(Exception):
    """Tavily nicht erreichbar, Key fehlt oder Antwort unbrauchbar."""


def search(query, api_key, max_results=DEFAULT_MAX_RESULTS,
           url=SEARCH_URL, timeout=15):
    """Sucht bei Tavily und gibt ein normalisiertes dict zurück."""
    if not (api_key or "").strip():
        raise WebSearchError("Kein Tavily-Key hinterlegt")
    body = json.dumps({
        "query": query,
        "max_results": max_results,
        "include_answer": True,
    }).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={
        "Content-Type": "application/json",
        "Authorization": "Bearer {}".format(api_key),
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise WebSearchError("Tavily HTTP {}".format(exc.code)) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise WebSearchError("Tavily nicht erreichbar: {}".format(exc)) from exc
    except (ValueError, json.JSONDecodeError) as exc:
        raise WebSearchError("Tavily-Antwort nicht lesbar: {}".format(exc)) from exc
    if not isinstance(data, dict):
        raise WebSearchError("Tavily-Antwort hat unerwartetes Format")
    treffer = []
    for item in data.get("results") or []:
        if isinstance(item, dict):
            treffer.append({"titel": item.get("title") or "",
                            "inhalt": item.get("content") or ""})
    return {"query": query,
            "antwort": data.get("answer") or "",
            "treffer": treffer}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/voice-echo-bot && python3 -m pytest test_web_search.py -q`
Expected: PASS (8 Tests)

- [ ] **Step 5: Commit**

```bash
git add tools/voice-echo-bot/web_search.py tools/voice-echo-bot/test_web_search.py
git commit -m "feat(jarvis): Tavily-Client für die Websuche"
```

---

### Task 2: Aktuelle Zeit im System-Prompt

**Files:**
- Modify: `tools/voice-echo-bot/jarvis_brain.py` (Imports, neue Konstanten, `format_now`, `respond`)
- Test: `tools/voice-echo-bot/test_jarvis_brain.py` (anhängen)

**Interfaces:**
- Consumes: nichts aus Task 1
- Produces:
  - `jarvis_brain.format_now(now) -> str` — z.B. `"Dienstag, 29. Juli 2026, 15:42 Uhr"`
  - `respond(...)` akzeptiert zusätzlich `now=None` (ein `datetime.datetime`; `None` = jetzt)

**Wichtig:** Wochentags- und Monatsnamen werden **fest im Code** geführt, nicht über `strftime("%A")`. Unter launchd ist die Locale typischerweise `C`, dann lieferte `strftime` englische Namen.

- [ ] **Step 1: Write the failing test**

An `tools/voice-echo-bot/test_jarvis_brain.py` anhängen:

```python
def test_format_now_is_german_and_readable():
    import datetime
    stamp = jarvis_brain.format_now(datetime.datetime(2026, 7, 29, 15, 42))
    assert stamp == "Mittwoch, 29. Juli 2026, 15:42 Uhr"


def test_system_prompt_carries_current_time(monkeypatch):
    import datetime
    seen = {}
    def fake_chat(msgs, model=None):
        seen["system"] = msgs[0]["content"]
        return "Es ist Viertel vor vier."
    monkeypatch.setattr(jarvis_brain.llm, "chat", fake_chat)
    jarvis_brain.respond("wie spät?", TENANT, "tok", "m",
                         now=datetime.datetime(2026, 7, 29, 15, 42))
    assert "Mittwoch, 29. Juli 2026, 15:42 Uhr" in seen["system"]


def test_time_is_read_per_call_not_frozen(monkeypatch):
    # Der Satellit ist ein Dauerprozess: eine beim Start eingefrorene Uhr wäre
    # nur eine langsamere Form derselben Falschauskunft.
    import datetime
    seen = []
    monkeypatch.setattr(jarvis_brain.llm, "chat",
                        lambda msgs, model=None: seen.append(msgs[0]["content"]) or "ok")
    jarvis_brain.respond("a", TENANT, "tok", "m", now=datetime.datetime(2026, 7, 29, 9, 0))
    jarvis_brain.respond("b", TENANT, "tok", "m", now=datetime.datetime(2026, 7, 29, 17, 30))
    assert "09:00 Uhr" in seen[0]
    assert "17:30 Uhr" in seen[1]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/voice-echo-bot && python3 -m pytest test_jarvis_brain.py -q -k "format_now or current_time or frozen"`
Expected: FAIL — `AttributeError: module 'jarvis_brain' has no attribute 'format_now'`

- [ ] **Step 3: Write minimal implementation**

In `tools/voice-echo-bot/jarvis_brain.py`:

Import ergänzen (zu den bestehenden `import json`, `import re`, `import traceback`):

```python
import datetime
```

Nach `SYSTEM_PROMPT` einfügen:

```python
# Wochentage/Monate fest im Code: unter launchd ist die Locale typischerweise
# "C", dann lieferte strftime("%A") englische Namen.
WEEKDAYS = ("Montag", "Dienstag", "Mittwoch", "Donnerstag",
            "Freitag", "Samstag", "Sonntag")
MONTHS = ("Januar", "Februar", "März", "April", "Mai", "Juni", "Juli",
          "August", "September", "Oktober", "November", "Dezember")

TIME_HINT = ("\n\nAktuelle Zeit: {}. Nutze sie direkt für Fragen nach Uhrzeit, "
             "Datum oder Wochentag — dafür brauchst du kein Werkzeug.")


def format_now(now):
    """Datum/Uhrzeit als deutscher Klartext für den System-Prompt."""
    return "{}, {}. {} {}, {:02d}:{:02d} Uhr".format(
        WEEKDAYS[now.weekday()], now.day, MONTHS[now.month - 1],
        now.year, now.hour, now.minute)
```

In `respond` die Signatur erweitern und den Hinweis anhängen:

```python
def respond(text, tenant, token, chat_model, history=None, source="per Telegram",
            voice_output=False, now=None):
    text = (text or "").strip()
    if not text:
        return {"kind": "empty", "answer": "Nichts erkannt, bitte erneut."}
    hist = history or []
    system_content = SYSTEM_PROMPT.format(name=first_name(tenant))
    system_content += TIME_HINT.format(format_now(now or datetime.datetime.now()))
    if voice_output:
        system_content += VOICE_OUTPUT_HINT
    # ... Rest unverändert
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/voice-echo-bot && python3 -m pytest test_jarvis_brain.py -q`
Expected: PASS — alle Tests der Datei, auch die bestehenden

- [ ] **Step 5: Commit**

```bash
git add tools/voice-echo-bot/jarvis_brain.py tools/voice-echo-bot/test_jarvis_brain.py
git commit -m "feat(jarvis): aktuelle Zeit bei jedem Aufruf in den System-Prompt"
```

---

### Task 3: Steuer-Token `WEB:`, Ausführung, Sperre und Protokoll

**Files:**
- Modify: `tools/voice-echo-bot/jarvis_brain.py` (Import, `SYSTEM_PROMPT`, `WEB_RE`, `parse_control`, `_strip_control_lines`, `_do_web`, `respond`)
- Test: `tools/voice-echo-bot/test_jarvis_brain.py` (anhängen)

**Interfaces:**
- Consumes: `web_search.search(query, api_key)`, `web_search.WebSearchError` aus Task 1; `respond(..., now=None)` aus Task 2
- Produces:
  - `respond(...)` akzeptiert zusätzlich `web_key=None`
  - `respond(...)` kann `{"kind": "web", "answer": str}` liefern
  - `parse_control(raw)` kann `{"kind": "web", "query": str}` liefern

**Kernpunkte:**
1. Das Werkzeug erscheint **nur im Prompt, wenn ein Key vorliegt**.
2. Nach einem Vault-Lookup wird ein nachgereichtes `WEB:` **nie ausgeführt**, sondern gestrippt. Dazu wird der Rückgabepfad von `_do_lookup` auf `_strip_control_lines` umgestellt — das behebt nebenbei, dass dort bisher ein nachgereichtes `LOOKUP:`/`ISSUE:` im Text stehenblieb und vorgelesen wurde.
3. Jeder Suchbegriff wird vor dem Absenden protokolliert.

- [ ] **Step 1: Write the failing test**

An `tools/voice-echo-bot/test_jarvis_brain.py` anhängen:

```python
def test_web_tool_absent_from_prompt_without_key(monkeypatch):
    seen = {}
    monkeypatch.setattr(jarvis_brain.llm, "chat",
                        lambda msgs, model=None: seen.update(system=msgs[0]["content"]) or "ok")
    jarvis_brain.respond("hi", TENANT, "tok", "m")
    assert "WEB:" not in seen["system"]


def test_web_tool_offered_with_key(monkeypatch):
    seen = {}
    monkeypatch.setattr(jarvis_brain.llm, "chat",
                        lambda msgs, model=None: seen.update(system=msgs[0]["content"]) or "ok")
    jarvis_brain.respond("hi", TENANT, "tok", "m", web_key="tvly-k")
    assert "WEB:" in seen["system"]


def test_parse_control_recognises_web_token():
    assert jarvis_brain.parse_control("WEB: Wetter Cottbus morgen") == {
        "kind": "web", "query": "Wetter Cottbus morgen"}
    assert jarvis_brain.parse_control("  web :  Bahnstreik  ")["kind"] == "web"


def test_web_search_result_is_answered(monkeypatch):
    calls = []
    def fake_chat(msgs, model=None):
        calls.append(msgs)
        return "WEB: Wetter Cottbus" if len(calls) == 1 else "Morgen 24 Grad, sonnig."
    monkeypatch.setattr(jarvis_brain.llm, "chat", fake_chat)
    monkeypatch.setattr(jarvis_brain.web_search, "search",
                        lambda q, key, **kw: {"query": q, "antwort": "24 Grad", "treffer": []})
    r = jarvis_brain.respond("wetter morgen?", TENANT, "tok", "m", web_key="tvly-k")
    assert r == {"kind": "web", "answer": "Morgen 24 Grad, sonnig."}


def test_web_search_failure_is_honest(monkeypatch):
    def fake_chat(msgs, model=None):
        return "WEB: Wetter"
    monkeypatch.setattr(jarvis_brain.llm, "chat", fake_chat)
    def boom(q, key, **kw):
        raise jarvis_brain.web_search.WebSearchError("offline")
    monkeypatch.setattr(jarvis_brain.web_search, "search", boom)
    r = jarvis_brain.respond("wetter?", TENANT, "tok", "m", web_key="tvly-k")
    assert r["kind"] == "web"
    assert "nicht ins Netz" in r["answer"]


def test_web_query_is_logged(monkeypatch, capsys):
    monkeypatch.setattr(jarvis_brain.llm, "chat",
                        lambda msgs, model=None: "WEB: Bahnstreik heute")
    monkeypatch.setattr(jarvis_brain.web_search, "search",
                        lambda q, key, **kw: {"query": q, "antwort": "", "treffer": []})
    jarvis_brain.respond("gibt es streik?", TENANT, "tok", "m", web_key="tvly-k")
    assert "[web] query='Bahnstreik heute'" in capsys.readouterr().out


def test_web_token_without_key_is_honest_not_silent(monkeypatch):
    # Ohne Key wird das Werkzeug nicht angeboten — setzt das Modell trotzdem
    # ein Token, darf es weder ausgeführt werden noch eine leere (= stumme)
    # Antwort ergeben.
    searched = []
    monkeypatch.setattr(jarvis_brain.llm, "chat",
                        lambda msgs, model=None: "WEB: Wetter Cottbus")
    monkeypatch.setattr(jarvis_brain.web_search, "search",
                        lambda q, key, **kw: searched.append(q) or {})
    r = jarvis_brain.respond("wetter?", TENANT, "tok", "m")
    assert searched == []
    assert r["answer"].strip()          # nicht stumm
    assert "ins Netz" in r["answer"]


def test_web_token_after_vault_lookup_is_not_executed(monkeypatch):
    # Harte Sperre: in derselben Anfrage gewonnene Vault-Daten dürfen nicht in
    # einen Suchbegriff wandern.
    searched = []
    calls = []
    def fake_chat(msgs, model=None):
        calls.append(msgs)
        if len(calls) == 1:
            return "LOOKUP kontakt: Jana Kostbar"
        return "Sie wohnt in Cottbus.\nWEB: Wetter Cottbus"
    monkeypatch.setattr(jarvis_brain.llm, "chat", fake_chat)
    monkeypatch.setattr(jarvis_brain.vault_client, "lookup",
                        lambda mode, query, vault=None: {"treffer": [{"inhalt": "Cottbus"}]})
    monkeypatch.setattr(jarvis_brain.web_search, "search",
                        lambda q, key, **kw: searched.append(q) or {"query": q, "antwort": "", "treffer": []})
    r = jarvis_brain.respond("wo wohnt jana?", TENANT, "tok", "m", web_key="tvly-k")
    assert searched == []                     # keine Suche ausgelöst
    assert r["kind"] == "lookup"
    assert "WEB:" not in r["answer"]          # Token gestrippt, nicht vorgelesen
    assert r["answer"] == "Sie wohnt in Cottbus."
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/voice-echo-bot && python3 -m pytest test_jarvis_brain.py -q -k "web"`
Expected: FAIL — `AttributeError: module 'jarvis_brain' has no attribute 'web_search'`

- [ ] **Step 3: Write minimal implementation**

In `tools/voice-echo-bot/jarvis_brain.py`:

Import ergänzen (bei `import vault_client`):

```python
import web_search
```

`SYSTEM_PROMPT` anpassen — der Satz „Du hast zwei Werkzeuge." wird zu:

```python
    "Du hast diese Werkzeuge. Brauchst du eines, gib in der ERSTEN Zeile GENAU "
```

(Der bisherige Wortlaut „Du hast zwei Werkzeuge.\n\n" entfällt; der Rest des Prompts bleibt unverändert.)

Nach `VOICE_OUTPUT_HINT` einfügen:

```python
WEB_TOOL_HINT = (
    "\n\n3. Web durchsuchen — für alles, was du nicht wissen kannst, weil es "
    "aktuell oder öffentlich ist (Wetter, Nachrichten, Verkehr, Öffnungszeiten, "
    "Preise, Fakten von Webseiten):\n"
    "   WEB: <suchbegriff>\n"
    "   Beispiel: WEB: Wetter Cottbus morgen\n"
    "   Rate NIE bei solchen Fragen — such nach oder sag, dass du es nicht weisst."
)
```

`WEB_RE` zu den anderen Regexen:

```python
WEB_RE = re.compile(r"^\s*WEB\s*:\s*(.+)$", re.IGNORECASE)
```

`parse_control` — vor dem abschliessenden `return` den WEB-Zweig ergänzen:

```python
    m = WEB_RE.match(first)
    if m:
        return {"kind": "web", "query": m.group(1).strip()}
    return {"kind": "chat", "text": text}
```

`_strip_control_lines` um `WEB_RE` erweitern:

```python
    kept = [ln for ln in (text or "").splitlines()
            if not LOOKUP_RE.match(ln) and not ISSUE_RE.match(ln)
            and not WEB_RE.match(ln)]
```

`_do_lookup` — die letzten drei Zeilen ersetzen. Bisher:

```python
    follow_action = parse_control(answer)
    if follow_action["kind"] == "chat":
        return _strip_control_lines(follow_action["text"])
    return answer.strip()
```

Neu (jedes nachgereichte Steuer-Token wird gestrippt, keines ausgeführt — das ist die harte Sperre):

```python
    # Nach einem Vault-Zugriff wird KEIN weiteres Werkzeug mehr ausgeführt:
    # in dieser Anfrage gewonnene Vault-Daten dürfen nicht nach draussen
    # (z.B. in einen Suchbegriff) wandern. Token werden nur entfernt.
    return _strip_control_lines(answer)
```

`_do_web` neu, direkt nach `_do_lookup`:

```python
def _do_web(messages, query, chat_model, api_key):
    print("[web] query='{}'".format((query or "").replace("\n", " ")[:120]),
          flush=True)
    try:
        result = web_search.search(query, api_key)
    except web_search.WebSearchError:
        traceback.print_exc()
        return "⚠️ Ich komme gerade nicht ins Netz."
    context = json.dumps(result, ensure_ascii=False)[:4000]
    followup = messages + [
        {"role": "assistant", "content": "WEB: {}".format(query)},
        {"role": "user", "content":
            ("Web-Suchergebnis (JSON):\n{}\n\nBeantworte meine letzte Frage knapp "
             "auf Deutsch mit diesen Daten. Ist nichts Passendes dabei, sag das "
             "ehrlich. Nenne keine URLs. Gib KEIN Steuer-Token mehr aus."
             ).format(context)},
    ]
    try:
        answer = llm.chat(followup, model=chat_model)
    except llm.LlmError:
        traceback.print_exc()
        return "⚠️ Konnte das Suchergebnis nicht auswerten, bitte gleich nochmal."
    return _strip_control_lines(answer)
```

`respond` — Signatur und Werkzeug-Verdrahtung:

```python
def respond(text, tenant, token, chat_model, history=None, source="per Telegram",
            voice_output=False, now=None, web_key=None):
    text = (text or "").strip()
    if not text:
        return {"kind": "empty", "answer": "Nichts erkannt, bitte erneut."}
    hist = history or []
    system_content = SYSTEM_PROMPT.format(name=first_name(tenant))
    system_content += TIME_HINT.format(format_now(now or datetime.datetime.now()))
    if web_key:
        system_content += WEB_TOOL_HINT
    if voice_output:
        system_content += VOICE_OUTPUT_HINT
    messages = ([{"role": "system", "content": system_content}]
                + list(hist) + [{"role": "user", "content": text}])
    try:
        raw = llm.chat(messages, model=chat_model)
    except llm.LlmError:
        traceback.print_exc()
        return _unparsed(text, tenant, token, source)
    action = parse_control(raw)
    if action["kind"] == "lookup":
        return {"kind": "lookup",
                "answer": _do_lookup(messages, action["mode"], action["query"], tenant, chat_model)}
    if action["kind"] == "issue":
        return {"kind": "issue",
                "answer": _do_issue(action["title"], action["description"], tenant, token)}
    if action["kind"] == "web":
        if not web_key:
            # Ohne Key ist das Werkzeug nicht im Prompt — kommt trotzdem eines
            # durch, muss die Antwort ehrlich sein und darf nicht leer werden
            # (leerer Text = stumme Sprachausgabe).
            return {"kind": "chat",
                    "answer": "Dafür müsste ich ins Netz — das ist gerade nicht eingerichtet."}
        return {"kind": "web",
                "answer": _do_web(messages, action["query"], chat_model, web_key)}
    return {"kind": "chat", "answer": _strip_control_lines(action["text"])}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/voice-echo-bot && python3 -m pytest test_jarvis_brain.py -q`
Expected: PASS — alle Tests, auch die bestehenden

- [ ] **Step 5: Run the whole bot suite for regressions**

Run: `cd tools/voice-echo-bot && python3 -m pytest -q`
Expected: PASS — keine Regression in `test_bot.py` und den übrigen Dateien

- [ ] **Step 6: Commit**

```bash
git add tools/voice-echo-bot/jarvis_brain.py tools/voice-echo-bot/test_jarvis_brain.py
git commit -m "feat(jarvis): WEB-Steuer-Token mit Tavily, Vault-Sperre und Protokoll"
```

---

### Task 4: Verdrahtung in Satellit und Telegram-Bot

**Files:**
- Modify: `tools/wake-satellite/satellite.py` (`build_deps`, `handle_interaction`)
- Modify: `tools/wake-satellite/test_satellite.py` (anhängen)
- Modify: `tools/voice-echo-bot/bot.py` (Aufruf von `respond`)
- Modify: `tools/wake-satellite/deploy.sh` (Kopierliste)

**Interfaces:**
- Consumes: `respond(..., web_key=...)` und `{"kind": "web"}` aus Task 3
- Produces: `deps["web_key"]` im Satelliten

- [ ] **Step 1: Write the failing test**

An `tools/wake-satellite/test_satellite.py` anhängen:

```python
def test_web_answer_is_remembered(monkeypatch):
    # Suchantworten gehören ins Gedächtnis, sonst laufen Nachfragen ins Leere.
    monkeypatch.setattr(satellite.transcribe, "transcribe", lambda wav, model: "wetter?")
    monkeypatch.setattr(satellite.jarvis_brain, "respond",
                        lambda *a, **k: {"kind": "web", "answer": "Morgen 24 Grad."})
    monkeypatch.setattr(satellite, "_speak", lambda text, deps: None)
    frames = iter(_turn() + [quiet()] * sat_config.FOLLOWUP_WINDOW_FRAMES)
    hist = satellite.handle_interaction(frames, _deps())
    assert hist[-1] == {"role": "assistant", "content": "Morgen 24 Grad."}


def test_web_key_is_passed_to_brain(monkeypatch):
    seen = {}
    monkeypatch.setattr(satellite.transcribe, "transcribe", lambda wav, model: "wetter?")
    monkeypatch.setattr(satellite.jarvis_brain, "respond",
                        lambda *a, **k: seen.update(k) or {"kind": "chat", "answer": "ok"})
    monkeypatch.setattr(satellite, "_speak", lambda text, deps: None)
    deps = _deps()
    deps["web_key"] = "tvly-k"
    frames = iter(_turn() + [quiet()] * sat_config.FOLLOWUP_WINDOW_FRAMES)
    satellite.handle_interaction(frames, deps)
    assert seen["web_key"] == "tvly-k"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/wake-satellite && python3 -m pytest test_satellite.py -q -k "web"`
Expected: FAIL — `test_web_answer_is_remembered` mit `IndexError`/leerer History (kind `"web"` ist nicht in der Merkliste), `test_web_key_is_passed_to_brain` mit `KeyError: 'web_key'`

- [ ] **Step 3: Write minimal implementation**

In `tools/wake-satellite/satellite.py`, `handle_interaction` — der `respond`-Aufruf bekommt den Key:

```python
        result = jarvis_brain.respond(text, tenant, _resolve_token(deps),
                                      deps["chat_model"], history=history,
                                      source="per Sprache", voice_output=True,
                                      web_key=deps.get("web_key"))
```

und die Merkliste bekommt `"web"`:

```python
        if result["kind"] in ("chat", "lookup", "issue", "web"):
```

In `build_deps` den Key aus der Env lesen:

```python
        "chat_model": sat_config.CHAT_MODEL or env.get("CHAT_MODEL") or jarvis_brain.llm.DEFAULT_MODEL,
        "token": vco_config.load_paperclip_token,
        "web_key": env.get("TAVILY_API_KEY"),
```

In `tools/voice-echo-bot/bot.py` zwei Stellen. Erstens in `build_app()` (Zeile ~249) den Key ins `cfg`-dict aufnehmen, direkt nach `"chat_model"`:

```python
        "chat_model": env.get("CHAT_MODEL") or llm.DEFAULT_MODEL,
        "web_key": env.get("TAVILY_API_KEY"),
    }
```

Zweitens in `_handle_chat` (Zeile ~169) den Key durchreichen:

```python
        result = jarvis_brain.respond(text, tenant, self._token(),
                                      self._chat_model(), history=hist,
                                      web_key=self.cfg.get("web_key"))
```

**Am Gedächtnis des Bots ist nichts zu tun:** `_handle_chat` ruft `self._remember` für jede Antwortart ausser `empty`/`unparsed_ok`/`unparsed_fail` auf — `"web"` wird also automatisch gemerkt. Nur der Satellit führt eine explizite Positivliste, die ergänzt werden muss.

In `tools/wake-satellite/deploy.sh` die Kopierliste der geteilten Module um `web_search.py` ergänzen:

```bash
for f in config.py llm.py vault_client.py paperclip_client.py transcribe.py tts.py jarvis_brain.py web_search.py; do
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/wake-satellite && python3 -m pytest -q && cd ../voice-echo-bot && python3 -m pytest -q`
Expected: PASS in beiden Suiten

- [ ] **Step 5: Verify the deploy list is complete**

Run: `grep -n "web_search" tools/wake-satellite/deploy.sh`
Expected: eine Trefferzeile in der Kopierschleife der geteilten Module

- [ ] **Step 6: Commit**

```bash
git add tools/wake-satellite/satellite.py tools/wake-satellite/test_satellite.py \
        tools/wake-satellite/deploy.sh tools/voice-echo-bot/bot.py
git commit -m "feat(jarvis): Websuche in Satellit und Telegram-Bot verdrahtet"
```

---

### Task 5: Key beschaffen und ausrollen

**Files:**
- Modify: `~/.paperclip/voice-echo-bot.env` (ausserhalb des Repos, nicht committen)
- Deploy: `~/.paperclip/scripts/wake-satellite/`, `~/.paperclip/scripts/voice-echo-bot/`

**Interfaces:**
- Consumes: alles aus Tasks 1–4

**HALT — Freigabe erforderlich.** Schritt 1 liest ein Secret. Ohne ausdrückliches „ja" von Walter wird er nicht ausgeführt; stattdessen trägt Walter den Key selbst ein und der Task beginnt bei Schritt 2.

- [ ] **Step 1: Key aus der n8n-Credential holen (nur nach Freigabe)**

Der Key liegt AES-verschlüsselt in der n8n-Credential `Tavily` (id `umKYjuwVI8fk1DBN`). n8n verschlüsselt mit dem `encryptionKey` aus `~/.n8n/config`. Entschlüsseln, dann anhängen:

```bash
printf 'TAVILY_API_KEY="%s"\n' "$KEY" >> ~/.paperclip/voice-echo-bot.env
chmod 600 ~/.paperclip/voice-echo-bot.env
```

Prüfen, dass der Key **nicht** im Klartext in der Shell-History oder in einem Log landet.

- [ ] **Step 2: Key gegen Tavily verifizieren**

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://api.tavily.com/search \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"query":"test","max_results":1,"include_answer":true}'
```

Expected: `200`. Bei `401` ist der Key falsch — dann nicht weiter deployen.

- [ ] **Step 3: Deploy-Drift des Telegram-Bots prüfen (vor dem Kopieren)**

```bash
diff -rq tools/voice-echo-bot ~/.paperclip/scripts/voice-echo-bot \
  --exclude=venv --exclude=__pycache__ --exclude='test_*'
```

Erwartet: nur die Dateien, die dieser Plan geändert hat. Erscheinen **andere** Unterschiede, ist der Live-Stand eigenständig weitergelaufen — dann stoppen und mit Walter klären, statt zu überschreiben.

- [ ] **Step 4: Ausrollen**

```bash
bash tools/wake-satellite/deploy.sh
for f in jarvis_brain.py web_search.py; do
  cp "tools/voice-echo-bot/$f" ~/.paperclip/scripts/voice-echo-bot/"$f"
done
```

- [ ] **Step 5: Dienste neu starten und Start verifizieren**

```bash
launchctl kickstart -k gui/$(id -u)/de.whitestag.wake-satellite
tail -20 ~/.paperclip/logs/wake-satellite.log
```

Expected: `wake-satellit „Hey Jarvis" startet…` ohne Traceback, insbesondere ohne `ModuleNotFoundError: web_search`. Den Telegram-Bot analog neu starten (Dienstname vorher mit `launchctl list | grep -i echo` ermitteln).

- [ ] **Step 6: Am lebenden Objekt prüfen**

„Hey Jarvis, wie spät ist es?" → nennt die korrekte Uhrzeit, **ohne** `[web]`-Zeile im Log (die Zeit kommt aus dem Prompt, nicht aus dem Netz).
„Hey Jarvis, wie wird morgen das Wetter in Cottbus?" → `[web] query='…'` im Log, danach eine Antwort mit echten Werten.

- [ ] **Step 7: Commit**

Es gibt nichts zu committen (der Key liegt ausserhalb des Repos). Stattdessen den Ist-Stand prüfen:

```bash
git status --short
```

Expected: keine ungewollten Änderungen; `voice-echo-bot.env` taucht nicht auf, weil sie ausserhalb des Repos liegt.

---

## Verifikation zum Schluss

```bash
cd tools/voice-echo-bot && python3 -m pytest -q
cd ../wake-satellite && python3 -m pytest -q
```

Beide Suiten grün. Der Satellit läuft (`launchctl print gui/$(id -u)/de.whitestag.wake-satellite | grep "state ="`), im Log steht kein Traceback.
