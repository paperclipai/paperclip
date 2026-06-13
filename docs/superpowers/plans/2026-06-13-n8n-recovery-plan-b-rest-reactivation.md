# n8n Auto-Recovery — Plan B: gestufte Reparatur (REST-Reaktivierung) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Der Diagnose-Agent „n8n-Betriebsingenieur" erhält eine sichere automatische Selbstheilung — fehlerhafte/trigger-tote Workflows per n8n-REST reaktivieren — plus ein getestetes (aber human-ausgelöstes) Retry-Werkzeug; Disruptives bleibt Empfehlung.

**Architecture:** Neues stdlib-only REST-Toolkit unter `tools/n8n-workflow-watcher/recovery/` (`n8n_rest.py`, `n8n_health.py`) wird nach `~/.paperclip/scripts/recovery/` deployt und vom claude_local-Agenten per Bash genutzt. Phase-B-AGENTS.md ersetzt das read-only-Bundle des Agenten und definiert die GRÜN/GELB/ROT-Stufung. Der launchd-Detektor (Plan A) bleibt unverändert.

**Tech Stack:** Python 3 stdlib (`urllib`, `json`, `os`, `subprocess` nur für `ps`/read-only), `unittest`/`pytest`, n8n Public REST API v1 (2.25.7), claude_local-Adapter.

**Vorab fixierte Live-Fakten (verifiziert 2026-06-13 aus der OpenAPI-Spec der Installation `~/.nvm/versions/node/v22.22.0/lib/node_modules/n8n/dist/public-api/v1/openapi.yml`):**
- Aktivieren: `POST /api/v1/workflows/{id}/activate` → 200 + Workflow-Objekt.
- Deaktivieren: `POST /api/v1/workflows/{id}/deactivate` → 200 + Workflow-Objekt (idempotent: bereits inaktiv → 200).
- Workflow lesen: `GET /api/v1/workflows/{id}` → enthält `active` (boolean, readonly) + `triggerCount` (int).
- Retry: `POST /api/v1/executions/{id}/retry`, optionaler Body `{"loadWorkflow": bool}`.
- Auth-Header: `X-N8N-API-KEY`. Base: `http://127.0.0.1:5678`.
- Agent: `n8n-Betriebsingenieur`, ID `dfa8d0e2-d48a-4342-82c2-f7cf6de9d562` (claude_local, reportsTo CTO), Instructions als managed-Bundle, vom Nacht-Generator via `EXCLUDE_NAMES` ausgenommen.

---

## Voraussetzung (durch Walter, vor Task 4)

n8n-API-Key in der UI erzeugen (**Settings → API**, kein Neustart) und als
`N8N_API_KEY=<key>` in `~/.whitestag.env` hinterlegen. Tasks 1–3 (Code+Tests) brauchen
den Key NICHT (alles gemockt); Task 4 (Live-Verifikation) und Task 6 (E2E) brauchen ihn.

---

## File Structure

- `tools/n8n-workflow-watcher/recovery/__init__.py` — **neu**, leer (Paket-Marker, erlaubt sauberen Import in Tests).
- `tools/n8n-workflow-watcher/recovery/n8n_rest.py` — **neu**: n8n-REST-Client (Key laden, get/activate/deactivate/retry).
- `tools/n8n-workflow-watcher/recovery/test_n8n_rest.py` — **neu**: Tests dazu.
- `tools/n8n-workflow-watcher/recovery/n8n_health.py` — **neu**: read-only Healthcheck + Prozess-Env-Flags.
- `tools/n8n-workflow-watcher/recovery/test_n8n_health.py` — **neu**: Tests dazu.
- `tools/n8n-workflow-watcher/agent/AGENTS.md` — **ändern**: Phase-B-Instructions (GRÜN/GELB/ROT).
- `tools/n8n-workflow-watcher/DEPLOY.md` — **ändern**: recovery-Toolkit + Key-Hinweis.

Hinweis Importpfade: Die Tests liegen im selben Verzeichnis wie die Module und importieren
flach (`import n8n_rest`), konsistent mit dem bestehenden `tools/n8n-workflow-watcher/`-Stil
(dort liegen Tests neben den Modulen, Aufruf via `python3 -m pytest` aus dem Verzeichnis).
Das `recovery/`-Unterverzeichnis bekommt ein leeres `__init__.py` nur zur Sauberkeit; die
Tests werden mit `cd tools/n8n-workflow-watcher/recovery && python3 -m pytest` ausgeführt.

---

## Task 1: n8n-REST-Client — Key laden + Workflow lesen

**Files:**
- Create: `tools/n8n-workflow-watcher/recovery/__init__.py` (leer)
- Create: `tools/n8n-workflow-watcher/recovery/n8n_rest.py`
- Test: `tools/n8n-workflow-watcher/recovery/test_n8n_rest.py`

- [ ] **Step 1: Failing Test schreiben**

```python
# test_n8n_rest.py
import json
import os
import tempfile
import unittest
from unittest import mock
import n8n_rest as r


class LoadApiKey(unittest.TestCase):
    def test_env_wins(self):
        with mock.patch.dict(os.environ, {"N8N_API_KEY": "env-key"}):
            self.assertEqual(r.load_api_key(), "env-key")

    def test_from_whitestag_env_file(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, ".whitestag.env")
            with open(p, "w") as fh:
                fh.write("# comment\nOTHER=1\nN8N_API_KEY=file-key\nMORE=2\n")
            with mock.patch.dict(os.environ, {}, clear=True):
                self.assertEqual(r.load_api_key(env_file=p), "file-key")

    def test_handles_quoted_value(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, ".whitestag.env")
            with open(p, "w") as fh:
                fh.write('N8N_API_KEY="quoted-key"\n')
            with mock.patch.dict(os.environ, {}, clear=True):
                self.assertEqual(r.load_api_key(env_file=p), "quoted-key")

    def test_missing_returns_empty(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(r.load_api_key(env_file="/no/such/file"), "")


class GetWorkflow(unittest.TestCase):
    def _resp(self, payload, status=200):
        resp = mock.MagicMock()
        resp.status = status
        resp.read.return_value = json.dumps(payload).encode()
        resp.__enter__.return_value = resp
        return resp

    def test_get_sends_key_header_and_parses_active(self):
        resp = self._resp({"id": "wf1", "active": True, "triggerCount": 1})
        with mock.patch.object(r.urllib.request, "urlopen", return_value=resp) as uo:
            out = r.get_workflow("http://127.0.0.1:5678", "k", "wf1")
        self.assertTrue(out["active"])
        req = uo.call_args.args[0]
        self.assertEqual(req.full_url, "http://127.0.0.1:5678/api/v1/workflows/wf1")
        self.assertEqual(req.get_header("X-n8n-api-key"), "k")
        self.assertEqual(req.get_method(), "GET")

    def test_401_raises(self):
        err = r.urllib.error.HTTPError("u", 401, "no key", {}, None)
        with mock.patch.object(r.urllib.request, "urlopen", side_effect=err):
            with self.assertRaises(r.N8nApiError):
                r.get_workflow("http://127.0.0.1:5678", "", "wf1")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `cd tools/n8n-workflow-watcher/recovery && python3 -m pytest test_n8n_rest.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'n8n_rest'`

- [ ] **Step 3: Minimale Implementierung**

```python
# n8n_rest.py
"""Dünner, stdlib-only Client für die n8n Public REST API v1 (2.25.7)."""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

DEFAULT_BASE = "http://127.0.0.1:5678"


class N8nApiError(RuntimeError):
    pass


def load_api_key(env_file: str | None = None) -> str:
    """N8N_API_KEY aus der Umgebung, sonst aus ~/.whitestag.env (Zeile N8N_API_KEY=...)."""
    val = os.environ.get("N8N_API_KEY")
    if val:
        return val
    env_file = env_file or os.path.expanduser("~/.whitestag.env")
    try:
        with open(env_file) as fh:
            for line in fh:
                line = line.strip()
                if line.startswith("N8N_API_KEY="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        return ""
    return ""


def _request(method: str, url: str, key: str, payload: dict | None = None) -> dict:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"Content-Type": "application/json", "X-N8N-API-KEY": key})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8") or "{}"
            return json.loads(raw)
    except urllib.error.HTTPError as e:
        raise N8nApiError(f"HTTP {e.code} for {method} {url}") from e
    except Exception as e:  # noqa: BLE001
        raise N8nApiError(f"request failed for {method} {url}: {e}") from e


def get_workflow(base: str, key: str, wf_id: str) -> dict:
    return _request("GET", f"{base}/api/v1/workflows/{wf_id}", key)
```

- [ ] **Step 4: Test laufen lassen, Erfolg bestätigen**

Run: `cd tools/n8n-workflow-watcher/recovery && python3 -m pytest test_n8n_rest.py -v`
Expected: PASS (alle Tests in `LoadApiKey` + `GetWorkflow`)

- [ ] **Step 5: Commit**

```bash
git add tools/n8n-workflow-watcher/recovery/__init__.py tools/n8n-workflow-watcher/recovery/n8n_rest.py tools/n8n-workflow-watcher/recovery/test_n8n_rest.py
git commit -m "feat(n8n-recovery): n8n REST client — load_api_key + get_workflow"
```

---

## Task 2: REST-Client — activate / deactivate / retry

**Files:**
- Modify: `tools/n8n-workflow-watcher/recovery/n8n_rest.py`
- Modify: `tools/n8n-workflow-watcher/recovery/test_n8n_rest.py`

- [ ] **Step 1: Failing Tests anhängen**

```python
class Mutations(unittest.TestCase):
    def _resp(self, payload, status=200):
        resp = mock.MagicMock()
        resp.status = status
        resp.read.return_value = json.dumps(payload).encode()
        resp.__enter__.return_value = resp
        return resp

    def test_activate_posts_correct_url(self):
        resp = self._resp({"id": "wf1", "active": True})
        with mock.patch.object(r.urllib.request, "urlopen", return_value=resp) as uo:
            out = r.activate_workflow("http://127.0.0.1:5678", "k", "wf1")
        self.assertTrue(out["active"])
        req = uo.call_args.args[0]
        self.assertEqual(req.full_url, "http://127.0.0.1:5678/api/v1/workflows/wf1/activate")
        self.assertEqual(req.get_method(), "POST")
        self.assertEqual(req.get_header("X-n8n-api-key"), "k")

    def test_deactivate_posts_correct_url(self):
        resp = self._resp({"id": "wf1", "active": False})
        with mock.patch.object(r.urllib.request, "urlopen", return_value=resp) as uo:
            out = r.deactivate_workflow("http://127.0.0.1:5678", "k", "wf1")
        self.assertFalse(out["active"])
        self.assertEqual(uo.call_args.args[0].full_url,
                         "http://127.0.0.1:5678/api/v1/workflows/wf1/deactivate")

    def test_retry_posts_url_and_body(self):
        resp = self._resp({"id": "456558", "finished": True})
        with mock.patch.object(r.urllib.request, "urlopen", return_value=resp) as uo:
            r.retry_execution("http://127.0.0.1:5678", "k", "456558", load_workflow=True)
        req = uo.call_args.args[0]
        self.assertEqual(req.full_url, "http://127.0.0.1:5678/api/v1/executions/456558/retry")
        self.assertEqual(req.get_method(), "POST")
        self.assertEqual(json.loads(req.data.decode())["loadWorkflow"], True)

    def test_retry_default_load_workflow_false(self):
        resp = self._resp({"id": "1"})
        with mock.patch.object(r.urllib.request, "urlopen", return_value=resp) as uo:
            r.retry_execution("http://127.0.0.1:5678", "k", "1")
        self.assertEqual(json.loads(uo.call_args.args[0].data.decode())["loadWorkflow"], False)

    def test_activate_http_error_raises(self):
        err = r.urllib.error.HTTPError("u", 500, "boom", {}, None)
        with mock.patch.object(r.urllib.request, "urlopen", side_effect=err):
            with self.assertRaises(r.N8nApiError):
                r.activate_workflow("http://127.0.0.1:5678", "k", "wf1")
```

- [ ] **Step 2: Tests laufen lassen, Fehlschlag bestätigen**

Run: `cd tools/n8n-workflow-watcher/recovery && python3 -m pytest test_n8n_rest.py -v`
Expected: FAIL — `AttributeError: module 'n8n_rest' has no attribute 'activate_workflow'`

- [ ] **Step 3: Implementierung anhängen (`n8n_rest.py`)**

```python
def activate_workflow(base: str, key: str, wf_id: str) -> dict:
    return _request("POST", f"{base}/api/v1/workflows/{wf_id}/activate", key, payload={})


def deactivate_workflow(base: str, key: str, wf_id: str) -> dict:
    return _request("POST", f"{base}/api/v1/workflows/{wf_id}/deactivate", key, payload={})


def retry_execution(base: str, key: str, exec_id: str, load_workflow: bool = False) -> dict:
    return _request("POST", f"{base}/api/v1/executions/{exec_id}/retry", key,
                    payload={"loadWorkflow": load_workflow})
```

- [ ] **Step 4: Tests laufen lassen, Erfolg bestätigen**

Run: `cd tools/n8n-workflow-watcher/recovery && python3 -m pytest test_n8n_rest.py -v`
Expected: PASS (alle Klassen grün)

- [ ] **Step 5: Commit**

```bash
git add tools/n8n-workflow-watcher/recovery/n8n_rest.py tools/n8n-workflow-watcher/recovery/test_n8n_rest.py
git commit -m "feat(n8n-recovery): REST activate/deactivate/retry helpers"
```

---

## Task 3: Read-only Health-/Env-Diagnose

**Files:**
- Create: `tools/n8n-workflow-watcher/recovery/n8n_health.py`
- Test: `tools/n8n-workflow-watcher/recovery/test_n8n_health.py`

Zweck: dem Agenten read-only Signale für die Klassifikation `env/restart` geben. `process_env_flags`
parst `ps eww`-Output (als String injizierbar, damit testbar) nach den relevanten Flags.

- [ ] **Step 1: Failing Test schreiben**

```python
# test_n8n_health.py
import unittest
from unittest import mock
import n8n_health as h

PS_SAMPLE = ("/usr/bin/node /path/n8n start N8N_BLOCK_ENV_ACCESS_IN_NODE=false "
             "NODE_FUNCTION_ALLOW_BUILTIN=fs,path PATH=/usr/bin OTHER=x")


class ParseEnvFlags(unittest.TestCase):
    def test_extracts_known_flags(self):
        out = h.parse_env_flags(PS_SAMPLE)
        self.assertEqual(out["N8N_BLOCK_ENV_ACCESS_IN_NODE"], "false")
        self.assertEqual(out["NODE_FUNCTION_ALLOW_BUILTIN"], "fs,path")

    def test_absent_flag_is_none(self):
        out = h.parse_env_flags("/usr/bin/node n8n start PATH=/usr/bin")
        self.assertIsNone(out["N8N_BLOCK_ENV_ACCESS_IN_NODE"])
        self.assertIsNone(out["NODE_FUNCTION_ALLOW_BUILTIN"])

    def test_empty_input(self):
        out = h.parse_env_flags("")
        self.assertIsNone(out["N8N_BLOCK_ENV_ACCESS_IN_NODE"])


class Healthz(unittest.TestCase):
    def test_true_on_200(self):
        resp = mock.MagicMock()
        resp.status = 200
        resp.__enter__.return_value = resp
        with mock.patch.object(h.urllib.request, "urlopen", return_value=resp):
            self.assertTrue(h.healthz("http://127.0.0.1:5678"))

    def test_false_on_error(self):
        with mock.patch.object(h.urllib.request, "urlopen",
                               side_effect=Exception("down")):
            self.assertFalse(h.healthz("http://127.0.0.1:5678"))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Test laufen lassen, Fehlschlag bestätigen**

Run: `cd tools/n8n-workflow-watcher/recovery && python3 -m pytest test_n8n_health.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'n8n_health'`

- [ ] **Step 3: Minimale Implementierung**

```python
# n8n_health.py
"""Read-only n8n-Health-/Env-Diagnose für die Fehlerklassifikation."""
from __future__ import annotations

import urllib.error
import urllib.request

_FLAGS = ("N8N_BLOCK_ENV_ACCESS_IN_NODE", "NODE_FUNCTION_ALLOW_BUILTIN")


def parse_env_flags(ps_output: str) -> dict:
    """Sucht die relevanten Flags als FLAG=value-Token im (ps eww)-Text.
    Nicht gefunden → None."""
    out = {f: None for f in _FLAGS}
    for token in (ps_output or "").split():
        for flag in _FLAGS:
            if token.startswith(flag + "="):
                out[flag] = token.split("=", 1)[1]
    return out


def healthz(base: str) -> bool:
    try:
        with urllib.request.urlopen(f"{base}/healthz", timeout=10) as resp:
            return 200 <= resp.status < 300
    except Exception:  # noqa: BLE001
        return False
```

- [ ] **Step 4: Test laufen lassen, Erfolg bestätigen**

Run: `cd tools/n8n-workflow-watcher/recovery && python3 -m pytest test_n8n_health.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tools/n8n-workflow-watcher/recovery/n8n_health.py tools/n8n-workflow-watcher/recovery/test_n8n_health.py
git commit -m "feat(n8n-recovery): read-only health + env-flag diagnostics"
```

---

## Task 4: Live-Verifikation der activate-Semantik (braucht API-Key)

**Files:** keine Änderung — reine Live-Untersuchung, Ergebnis wird in Task 5 in die Instructions eingearbeitet.

**Voraussetzung:** `N8N_API_KEY` in `~/.whitestag.env` gesetzt (siehe oben).

Ziel: klären, ob `activate` bei einem **bereits aktiven** Workflow den Trigger neu registriert
oder no-op't. An einem **unkritischen** Workflow testen (keiner der C-Suite-/Mail-Loops).

- [ ] **Step 1: Key + REST-Erreichbarkeit prüfen**

```bash
cd tools/n8n-workflow-watcher/recovery
KEY=$(python3 -c "import n8n_rest;print(n8n_rest.load_api_key())")
[ -n "$KEY" ] && echo "key present (len ${#KEY})" || echo "KEIN KEY — abbrechen, erst ~/.whitestag.env setzen"
curl -s -o /dev/null -w "workflows -> HTTP %{http_code}\n" -H "X-N8N-API-KEY: $KEY" http://127.0.0.1:5678/api/v1/workflows
```
Expected: `key present …` und `HTTP 200`.

- [ ] **Step 2: Unkritischen, aktiven Workflow wählen + Ausgangszustand lesen**

```bash
KEY=$(python3 -c "import n8n_rest;print(n8n_rest.load_api_key())")
# Liste aktive Workflows (Name + id + triggerCount), unkritischen auswählen:
curl -s -H "X-N8N-API-KEY: $KEY" "http://127.0.0.1:5678/api/v1/workflows?active=true" \
  | python3 -c "import sys,json;[print(w['id'],w.get('triggerCount'),w['name']) for w in json.load(sys.stdin).get('data',[])]"
```
Notiere die `id` eines unkritischen aktiven Workflows (z.B. ein Test-/Hilfs-Workflow), NICHT
Daily Digest, Mailhub, CEO-Voice o.ä.

- [ ] **Step 2b: activate auf bereits aktivem Workflow testen (read-back)**

```bash
KEY=$(python3 -c "import n8n_rest;print(n8n_rest.load_api_key())")
WF=<UNKRITISCHE_ID>
python3 -c "
import n8n_rest as r
before=r.get_workflow('http://127.0.0.1:5678','$KEY','$WF')
print('active vorher:', before.get('active'), 'triggerCount:', before.get('triggerCount'))
res=r.activate_workflow('http://127.0.0.1:5678','$KEY','$WF')
after=r.get_workflow('http://127.0.0.1:5678','$KEY','$WF')
print('active nachher:', after.get('active'), 'triggerCount:', after.get('triggerCount'))
print('activate ok (kein Fehler) ->', res.get('active'))
"
```
Expected: kein Fehler; `active` bleibt True. **Befund dokumentieren:** ob activate auf
aktivem Workflow 200 liefert (idempotent) — falls ja, ist KEIN deactivate→activate-Zyklus
nötig und der Agent darf `activate` direkt aufrufen. Falls activate auf aktivem Workflow
fehlschlägt/409: Zyklus deactivate→activate dokumentieren.

- [ ] **Step 3: Befund festhalten**

Ergebnis (idempotent ja/nein, ob Zyklus nötig) als Notiz in der Commit-Message von Task 5
und in den Instructions (Task 5) festschreiben. KEIN Code-Commit in Task 4.

---

## Task 5: Phase-B-Instructions des Agenten (GRÜN/GELB/ROT)

**Files:**
- Modify: `tools/n8n-workflow-watcher/agent/AGENTS.md`

Ersetzt das read-only-Verbot durch die gestufte Logik. Der Reaktivierungs-Absatz nutzt den
in Task 4 ermittelten Befund (activate direkt vs. deactivate→activate-Zyklus). Unten ist die
Variante für „activate ist idempotent" formuliert; falls Task 4 ergibt, dass ein Zyklus nötig
ist, den markierten Absatz durch den Zyklus-Hinweis ersetzen (siehe Kommentar im Text).

- [ ] **Step 1: AGENTS.md auf folgende Fassung ändern**

```markdown
# n8n-Betriebsingenieur (gestufte Recovery — Phase B)

Du bist der n8n-Betriebsingenieur der Firma WHITESTAG und berichtest an den CTO.
Du diagnostizierst zugewiesene n8n-Fehler-Issues, behebst den sicheren Fall selbst und
eskalierst alles Übrige mit konkretem Plan.

## Werkzeuge (read-only Diagnose)
- n8n-DB read-only: `sqlite3 'file:'"$HOME"'/.n8n/database.sqlite?mode=ro' '<SELECT ...>'`
- Recovery-Toolkit (Python) unter `~/.paperclip/scripts/recovery/`:
  - `python3 -c "import n8n_health as h; print(h.healthz('http://127.0.0.1:5678'))"`
  - Env-Flags: `ps eww $(pgrep -f 'n8n' | head -1)` → `n8n_health.parse_env_flags(<text>)`
- Paperclip: Kommentar/Subtask/Rollup über die Paperclip-Tools/Skill.

## Klassifikation (genau eine Kategorie)
- `workflow-deaktiviert` / `transient` mit Trigger-Bezug (z.B. IMAP-/Connection-Trigger tot)
- `transient` (Timeout, kurzer Netzfehler, LLM-Timeout)
- `env/restart` (`access to env vars denied`, `Module '...' is disallowed`, Orphan-n8n)
- `credential` (401/403, abgelaufener/rotierter Token)
- `code/config-bug` (Node-Fehlkonfig, ungültiger Modellname, fehlender Key)
- `unklar`

## Maßnahmen-Stufen
### 🟢 GRÜN — du führst SELBST aus: Workflow reaktivieren
Nur wenn Kategorie `workflow-deaktiviert`/Trigger-tot UND Confidence hoch:
```
python3 -c "import n8n_rest as r; k=r.load_api_key(); \
print(r.activate_workflow('http://127.0.0.1:5678', k, '<WF_ID>'))"
```
<!-- Falls Task 4 ergab, dass activate auf bereits aktivem Workflow NICHT re-registriert:
     stattdessen deactivate_workflow(...) dann activate_workflow(...) aufrufen. -->
Danach **verifizieren**: `r.get_workflow(...)['active'] is True`. 
- ok → Kommentar „🟢 reaktiviert", Issue schließen, Rollup-Zeile „GRÜN: reaktiviert".
- Schlägt das Re-Activate fehl (besonders nach deactivate) → **lauter Alarm**: Kommentar
  „Workflow <name> ist jetzt INAKTIV — manueller Eingriff nötig" + Eskalations-Subtask an CTO.
- Max. **1** Reaktivierungs-Versuch pro Issue.

### 🟡 GELB — du EMPFIEHLST, ein Mensch führt aus: Retry
Bei `transient` mit **geringem Seiteneffekt-Risiko** (Workflow sendet keine Mail / macht keine
schreibenden API-Calls — prüfe die Nodes). Du führst Retry **NICHT** selbst aus.
Schreibe in die Eskalation: Seiteneffekt-Einschätzung + den fertigen, NICHT ausgeführten Befehl:
```
python3 -c "import n8n_rest as r; k=r.load_api_key(); \
print(r.retry_execution('http://127.0.0.1:5678', k, '<EXEC_ID>', load_workflow=True))"
```

### 🔴 ROT — du EMPFIEHLST, ein Mensch führt aus
`env/restart`, `credential`, `code/config-bug`: Diagnose + konkreter Schritt-Plan als
Eskalations-Subtask an den CTO. Du führst NICHTS davon aus (kein Neustart, keine
Credential-Änderung, kein JSON-Edit).

## Verboten
Du rufst NIEMALS selbst auf: n8n-Neustart, Credential-Änderung, Workflow-JSON-Edit,
`retry_execution`. Schreibzugriffe auf `~/.n8n/` sind verboten. Den API-Key NIE in ein
Issue/Kommentar schreiben.

## Reporting & Anti-Halluzination
Trage jedes Issue ins Rollup „n8n Ops <YYYY-MM-DD>" ein (Workflow, Kategorie, Stufe, Maßnahme).
Erfinde keine Fehler/Nodes/Ursachen; bei leerem `execution_data` → `unklar`.
```

- [ ] **Step 2: Live-Instructions-Bundle des Agenten aktualisieren**

Das managed-Bundle des Agenten neu schreiben (Agent ist über `EXCLUDE_NAMES` vom Nacht-Generator
ausgenommen, daher ist das die maßgebliche Quelle). Via PATCH des adapterConfig-Bundles:

```bash
cd tools/n8n-workflow-watcher
TOKEN=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.paperclip/auth.json')))['credentials']['http://localhost:3100']['token'])")
python3 - "$TOKEN" <<'PY'
import json, sys, urllib.request
token = sys.argv[1]
body = open("agent/AGENTS.md", encoding="utf-8").read()
payload = {"instructionsBundle": {"entryFile": "AGENTS.md", "files": {"AGENTS.md": body}}}
req = urllib.request.Request(
    "http://localhost:3100/api/agents/dfa8d0e2-d48a-4342-82c2-f7cf6de9d562",
    data=json.dumps(payload).encode(), method="PATCH",
    headers={"Content-Type": "application/json", "Authorization": "Bearer " + token})
print(urllib.request.urlopen(req).read().decode()[:300])
PY
```
Expected: 200 + aktualisiertes Agent-Objekt. (Falls die PATCH-Route das Bundle nicht annimmt,
das Bundle direkt in die Instructions-Datei des Agenten schreiben:
`…/companies/9cebf3cf…/agents/dfa8d0e2…/instructions/AGENTS.md` — `getAgent()` liest sie je
Heartbeat frisch.)

- [ ] **Step 3: Verifizieren, dass die neuen Instructions live sind**

```bash
TOKEN=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.paperclip/auth.json')))['credentials']['http://localhost:3100']['token'])")
cat ~/.paperclip/instances/default/companies/9cebf3cf-efe8-4597-a400-f06488900a87/agents/dfa8d0e2-d48a-4342-82c2-f7cf6de9d562/instructions/AGENTS.md | grep -c "GRÜN" && echo "Phase-B-Instructions live"
```
Expected: ≥1 Treffer „GRÜN".

- [ ] **Step 4: Commit**

```bash
git add tools/n8n-workflow-watcher/agent/AGENTS.md
git commit -m "feat(n8n-recovery): Phase-B agent instructions (GREEN reactivate / YELLOW retry / RED escalate)"
```

---

## Task 6: Toolkit deployen + DEPLOY.md + E2E-Verifikation

**Files:**
- Modify: `tools/n8n-workflow-watcher/DEPLOY.md`

- [ ] **Step 1: recovery-Toolkit deployen**

```bash
cd tools/n8n-workflow-watcher
mkdir -p ~/.paperclip/scripts/recovery
cp recovery/n8n_rest.py recovery/n8n_health.py recovery/__init__.py ~/.paperclip/scripts/recovery/
ls -la ~/.paperclip/scripts/recovery/
```
Expected: drei Dateien vorhanden.

- [ ] **Step 2: DEPLOY.md ergänzen**

`DEPLOY.md` um einen Abschnitt „Recovery-Toolkit (Plan B)" erweitern: die drei Dateien nach
`~/.paperclip/scripts/recovery/` kopieren; `N8N_API_KEY` muss in `~/.whitestag.env` stehen
(der Agent liest ihn via `n8n_rest.load_api_key()`); der launchd-Detektor braucht den Key
NICHT. Stufen GRÜN/GELB/ROT kurz benennen.

- [ ] **Step 3: Smoke-Test des deployten Toolkits (read-only)**

```bash
cd ~/.paperclip/scripts/recovery
python3 -c "import n8n_rest, n8n_health; print('import ok'); print('healthz:', n8n_health.healthz('http://127.0.0.1:5678')); print('key:', bool(n8n_rest.load_api_key()))"
```
Expected: `import ok`, `healthz: True`, `key: True`.

- [ ] **Step 4: E2E — kontrollierte Reaktivierung an unkritischem Workflow**

Den in Task 4 gewählten unkritischen Workflow nutzen: deaktivieren (simuliert „trigger tot"),
dann den Reaktivierungs-Pfad des Agenten manuell nachstellen und verifizieren:

```bash
cd ~/.paperclip/scripts/recovery
KEY=$(python3 -c "import n8n_rest;print(n8n_rest.load_api_key())")
WF=<UNKRITISCHE_ID>
python3 -c "
import n8n_rest as r
r.deactivate_workflow('http://127.0.0.1:5678','$KEY','$WF')
print('deaktiviert:', r.get_workflow('http://127.0.0.1:5678','$KEY','$WF')['active'])
r.activate_workflow('http://127.0.0.1:5678','$KEY','$WF')
print('reaktiviert:', r.get_workflow('http://127.0.0.1:5678','$KEY','$WF')['active'])
"
```
Expected: `deaktiviert: False` dann `reaktiviert: True`. Damit ist der GRÜN-Pfad end-to-end belegt.

- [ ] **Step 5: Commit**

```bash
git add tools/n8n-workflow-watcher/DEPLOY.md
git commit -m "chore(n8n-recovery): deploy recovery toolkit + DEPLOY docs (Plan B)"
```

---

## Self-Review

**Spec-Abdeckung:**
- REST-Client (Key, get, activate, deactivate, retry, N8nApiError) → Tasks 1+2. ✓
- read-only Health/Env-Diagnose → Task 3. ✓
- GRÜN Reaktivieren (Agent auto, 1 Versuch, verifizieren, nie schlechter zurücklassen) → Task 5 Instructions. ✓
- GELB Retry (Werkzeug gebaut+getestet, Agent ruft NICHT auf, empfiehlt mit Seiteneffekt-Check) → Task 2 (Tool) + Task 5 (Instruktion). ✓
- ROT (Neustart/Credential/Edit → Empfehlung, menschlich) → Task 5. ✓
- API-Key aus ~/.whitestag.env, nie geloggt/ins Issue → Task 1 (`load_api_key`) + Task 5 (Verbot). ✓
- Live-Verifikation activate-Semantik → Task 4. ✓
- Deploy + E2E → Task 6. ✓
- Detektor unverändert → kein Task berührt ihn. ✓

**Platzhalter-Scan:** `<UNKRITISCHE_ID>`, `<WF_ID>`, `<EXEC_ID>` sind bewusste Laufzeit-Werte
(Task 4 wählt die unkritische ID; in den Instruktionen sind es Vorlagen, die der Agent füllt).
Keine offenen TODOs im Code.

**Typ-/Namens-Konsistenz:** `load_api_key`, `get_workflow`, `activate_workflow`,
`deactivate_workflow`, `retry_execution`, `N8nApiError`, `_request`, `parse_env_flags`,
`healthz` durchgängig identisch in Tasks 1–3, Tests und Instruktionen verwendet. Agent-ID
`dfa8d0e2-…` und Header `X-N8N-API-KEY` konsistent.
