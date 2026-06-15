# OpenAI-Bilddienst — Implementierungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein zentraler Python-launchd-Dienst, der über alle drei Paperclip-Companies gelabelte Bild-Subtasks pollt, mit OpenAI `gpt-image-1` ein PNG generiert, es als Issue-Attachment anhängt und den Subtask abschließt (weckt den Parent).

**Architecture:** Python-Skript unter `~/.paperclip/scripts/bild-service/`, scheduled via launchd (~60 s) — exakt das Muster der bestehenden „Wächter" (`paperclip_client.py`, `n8n_workflow_watcher.py`). Idempotenz über den Status-Übergang `todo`→`in_progress` (kein Statefile nötig). Auth gegen Paperclip via Board-Token aus `~/.paperclip/auth.json` (`Authorization: Bearer …`); 401 → lauter Mail-Alarm über den Mailhub-Webhook. OpenAI-Key aus separatem Secret-File.

**Tech Stack:** Python 3 (stdlib: `urllib`/`http.client` oder `requests` falls vorhanden; `json`, `base64`, `os`); launchd; OpenAI Images API (`gpt-image-1`); Paperclip REST (`localhost:3100`).

**Medium-Entscheid:** Python-launchd (nicht reine n8n-Nodes) — Multipart-Upload + Issue-Iteration sind in n8n ungetestetes Neuland; Python reused den bestehenden Client und ist testbar.

---

## Verifizierte Fakten (Ausgangsbasis)

- **Paperclip-Base:** `http://localhost:3100`, alle Pfade mit `/api`-Präfix.
- **Auth:** `Authorization: Bearer <token>`; Token aus `~/.paperclip/auth.json` →
  `credentials["http://localhost:3100"]["token"]` (Präfix `pcp_board_`, ~30 Tage TTL, kein Service-Token). 401/403 ⇒ Mail-Alarm.
- **Company-IDs:** WHITESTAG `9cebf3cf-efe8-4597-a400-f06488900a87`, Clara Sound `0e426844-309c-4528-9aa5-90ff76790a51`, Health Insights `158c4959-4973-4cb0-8066-55ec0f35625e`.
- **Endpunkte:**
  - Issues listen: `GET /api/companies/{companyId}/issues?status={status}&labelId={uuid}&limit=100`
  - Labels listen/erstellen: `GET|POST /api/companies/{companyId}/labels` (`{ "name", "color" }`)
  - Status/Update: `PATCH /api/issues/{id}` (`{ "status": "in_progress" }`)
  - Kommentar: `POST /api/issues/{id}/comments` (`{ "body": "…" }`)
  - Attachment: `POST /api/companies/{companyId}/issues/{issueId}/attachments` (multipart, **Feldname `file`**)
  - Status-Enum: `backlog|todo|in_progress|in_review|done|blocked|cancelled`
- **Wake:** Subtask → `done`/`cancelled` weckt den Parent automatisch (`issue_children_completed`), actor-unabhängig.
- **Mail-Alarm:** `POST http://127.0.0.1:5678/webhook/mailhub/send`, Header `X-Mailhub-Secret: mailhub-812a27b07c73e64d7df192c98a3883eb`, Body `{from,to,subject,text}`.
- **OpenAI:** `POST https://api.openai.com/v1/images/generations`, `{ model:"gpt-image-1", prompt, size, quality, background, output_format:"png", n:1 }`; Antwort `data[0].b64_json` (immer base64). `size ∈ {1024x1024,1024x1536,1536x1024,auto}`, `quality ∈ {low,medium,high,auto}`, `background ∈ {transparent,opaque}`.
- **launchd-Gotcha:** launchd kann CloudStorage/SynologyDrive nicht lesen → Skript MUSS unter `~/.paperclip/scripts/` liegen, State unter `~/.paperclip/instances/default/state/`.

## Datei-Struktur

Alle neu unter `~/.paperclip/scripts/bild-service/`:

| Datei | Verantwortung |
|---|---|
| `config.py` | Companies + Label-UUIDs + Defaults + Pfade |
| `brief_parser.py` | Parse/Validate des `key: value`-Briefs (pure, TDD) |
| `openai_image.py` | Request-Body bauen + OpenAI-Call, PNG-Bytes liefern |
| `cost_state.py` | Tageslimit + Kosten-Log (atomares Statefile) |
| `paperclip_api.py` | Token-Load, list_issues, patch_status, add_comment, upload_attachment, mail_alarm |
| `bild_service.py` | Hauptschleife: poll → lock → parse → limit → generate → upload → comment → done/cancel |
| `test_brief_parser.py`, `test_openai_image.py`, `test_cost_state.py` | Unit-Tests |

Secrets: `~/.paperclip/instances/default/secrets/openai_image.env` (`OPENAI_API_KEY=…`).
State: `~/.paperclip/instances/default/state/bild-service.json`.
launchd: `~/Library/LaunchAgents/de.whitestag.bild-service.plist`.

---

## Task 0: Secrets anlegen + Smoke-Tests

**Files:** Create `~/.paperclip/instances/default/secrets/openai_image.env`

- [ ] **Step 1: OpenAI-Key-File anlegen** (Walter trägt den Key ein)

```bash
mkdir -p ~/.paperclip/instances/default/secrets
printf 'OPENAI_API_KEY=%s\n' "sk-REPLACE_WITH_REAL_KEY" > ~/.paperclip/instances/default/secrets/openai_image.env
chmod 600 ~/.paperclip/instances/default/secrets/openai_image.env
```

- [ ] **Step 2: Paperclip-Token-Smoke-Test**

Run:
```bash
TOKEN=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.paperclip/auth.json')))['credentials']['http://localhost:3100']['token'])")
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3100/api/companies/9cebf3cf-efe8-4597-a400-f06488900a87/issues?status=todo&limit=1"
```
Expected: `200`. Bei `401` → Board-Token erneuern, bevor es weitergeht.

- [ ] **Step 3: OpenAI-Key-Smoke-Test**

Run:
```bash
source ~/.paperclip/instances/default/secrets/openai_image.env
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $OPENAI_API_KEY" \
  https://api.openai.com/v1/models
```
Expected: `200`.

---

## Task 1: Label `bild:openai` in allen 3 Companies anlegen

**Files:** (keine; erzeugt 3 UUIDs für `config.py`)

- [ ] **Step 1: Label je Company anlegen + UUID notieren**

Run (für jede der 3 Company-IDs einmal):
```bash
TOKEN=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.paperclip/auth.json')))['credentials']['http://localhost:3100']['token'])")
for CID in 9cebf3cf-efe8-4597-a400-f06488900a87 0e426844-309c-4528-9aa5-90ff76790a51 158c4959-4973-4cb0-8066-55ec0f35625e; do
  echo "Company $CID:"
  curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d '{"name":"bild:openai","color":"#7c3aed"}' \
    "http://localhost:3100/api/companies/$CID/labels" | python3 -m json.tool | grep -E '"id"|"name"'
done
```
Expected: je Company ein JSON mit `"name": "bild:openai"` und einer `"id"` (UUID). **Diese 3 UUIDs notieren.**

- [ ] **Step 2: Falls Label schon existiert (409/Duplikat) — UUID per GET holen**

Run:
```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3100/api/companies/9cebf3cf-efe8-4597-a400-f06488900a87/labels" \
  | python3 -c "import sys,json;[print(l['id'],l['name']) for l in json.load(sys.stdin) if l['name']=='bild:openai']"
```
Expected: `<uuid> bild:openai`.

---

## Task 2: Service-Verzeichnis + `config.py`

**Files:** Create `~/.paperclip/scripts/bild-service/config.py`

- [ ] **Step 1: Verzeichnis anlegen**

```bash
mkdir -p ~/.paperclip/scripts/bild-service
```

- [ ] **Step 2: `config.py` schreiben** (Label-UUIDs aus Task 1 eintragen)

```python
import os

PAPERCLIP_BASE = "http://localhost:3100"
AUTH_JSON = os.path.expanduser("~/.paperclip/auth.json")
SECRETS_ENV = os.path.expanduser("~/.paperclip/instances/default/secrets/openai_image.env")
STATE_FILE = os.path.expanduser("~/.paperclip/instances/default/state/bild-service.json")

# (companyId, label-UUID für "bild:openai") — UUIDs aus Task 1
COMPANIES = [
    {"name": "WHITESTAG", "id": "9cebf3cf-efe8-4597-a400-f06488900a87", "label": "PASTE_WHITESTAG_LABEL_UUID"},
    {"name": "Clara",     "id": "0e426844-309c-4528-9aa5-90ff76790a51", "label": "PASTE_CLARA_LABEL_UUID"},
    {"name": "Health",    "id": "158c4959-4973-4cb0-8066-55ec0f35625e", "label": "PASTE_HEALTH_LABEL_UUID"},
]

POLL_STATUSES = ["todo", "backlog"]   # offene Subtasks, die noch nicht gelockt sind

DEFAULT_SIZE = "1024x1024"
DEFAULT_QUALITY = "medium"
ALLOWED_SIZES = {"1024x1024", "1024x1536", "1536x1024", "auto"}
ALLOWED_QUALITIES = {"low", "medium", "high", "auto"}

DAILY_IMAGE_LIMIT = 50

# grobe Kostenschätzung pro Bild (USD) — nur fürs Log, nicht abrechnungsgenau
COST_ESTIMATE = {"low": 0.02, "medium": 0.04, "high": 0.17, "auto": 0.04}

MAIL_WEBHOOK = "http://127.0.0.1:5678/webhook/mailhub/send"
MAIL_SECRET = "mailhub-812a27b07c73e64d7df192c98a3883eb"
MAIL_FROM = "office@whitestag.ai"
MAIL_TO = "ws@whitestag.ai"
```

- [ ] **Step 3: Commit**

```bash
cd ~/.paperclip && git add scripts/bild-service/config.py 2>/dev/null; \
git -C ~/.paperclip add scripts/bild-service/config.py 2>/dev/null || true
# Falls ~/.paperclip kein Repo ist: nur lokal speichern (kein Commit nötig).
```

---

## Task 3: `brief_parser.py` (TDD)

**Files:** Create `~/.paperclip/scripts/bild-service/brief_parser.py`, Test `test_brief_parser.py`

- [ ] **Step 1: Failing-Test schreiben**

`test_brief_parser.py`:
```python
from brief_parser import parse_brief

def test_full_brief():
    text = "prompt: Ein Poster mit Text\nsize: 1024x1536\nquality: high\ntransparent: true"
    b = parse_brief(text)
    assert b["prompt"] == "Ein Poster mit Text"
    assert b["size"] == "1024x1536"
    assert b["quality"] == "high"
    assert b["background"] == "transparent"
    assert b["error"] is None

def test_defaults_when_optional_missing():
    b = parse_brief("prompt: Nur ein Prompt")
    assert b["size"] == "1024x1024"
    assert b["quality"] == "medium"
    assert b["background"] == "opaque"
    assert b["error"] is None

def test_missing_prompt_is_error():
    b = parse_brief("size: 1024x1024")
    assert b["error"] is not None

def test_invalid_size_falls_back_to_default():
    b = parse_brief("prompt: x\nsize: 999x999")
    assert b["size"] == "1024x1024"

def test_invalid_quality_falls_back():
    b = parse_brief("prompt: x\nquality: ultra")
    assert b["quality"] == "medium"
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `cd ~/.paperclip/scripts/bild-service && python3 -m pytest test_brief_parser.py -v`
Expected: FAIL (`ModuleNotFoundError: brief_parser`).

- [ ] **Step 3: Implementierung**

`brief_parser.py`:
```python
from config import ALLOWED_SIZES, ALLOWED_QUALITIES, DEFAULT_SIZE, DEFAULT_QUALITY

def parse_brief(text):
    fields = {}
    for line in (text or "").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        key, _, val = line.partition(":")
        # Inline-Kommentare nach dem Wert abschneiden
        fields[key.strip().lower()] = val.split("#", 1)[0].strip()

    prompt = fields.get("prompt", "").strip()
    if not prompt:
        return {"error": "Pflichtfeld 'prompt' fehlt oder ist leer.",
                "prompt": None, "size": DEFAULT_SIZE,
                "quality": DEFAULT_QUALITY, "background": "opaque"}

    size = fields.get("size", DEFAULT_SIZE)
    if size not in ALLOWED_SIZES:
        size = DEFAULT_SIZE
    quality = fields.get("quality", DEFAULT_QUALITY)
    if quality not in ALLOWED_QUALITIES:
        quality = DEFAULT_QUALITY
    transparent = fields.get("transparent", "false").lower() in ("true", "1", "ja", "yes")

    return {"error": None, "prompt": prompt, "size": size,
            "quality": quality, "background": "transparent" if transparent else "opaque"}
```

- [ ] **Step 4: Test laufen lassen — muss bestehen**

Run: `python3 -m pytest test_brief_parser.py -v`
Expected: 5 passed.

- [ ] **Step 5: Commit** (siehe Task 2 Step 3 zur Repo-Frage)

---

## Task 4: `openai_image.py` (TDD Request-Bau + Integration)

**Files:** Create `openai_image.py`, Test `test_openai_image.py`

- [ ] **Step 1: Failing-Test für Request-Body**

`test_openai_image.py`:
```python
from openai_image import build_request_body

def test_build_body_maps_fields():
    brief = {"prompt": "Hallo", "size": "1024x1536", "quality": "high", "background": "transparent"}
    body = build_request_body(brief)
    assert body == {
        "model": "gpt-image-1", "prompt": "Hallo", "size": "1024x1536",
        "quality": "high", "background": "transparent", "output_format": "png", "n": 1,
    }
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `python3 -m pytest test_openai_image.py -v`
Expected: FAIL (`ModuleNotFoundError`).

- [ ] **Step 3: Implementierung**

`openai_image.py`:
```python
import json, base64, os, urllib.request, urllib.error
from config import SECRETS_ENV

def _load_openai_key():
    with open(SECRETS_ENV) as f:
        for line in f:
            if line.startswith("OPENAI_API_KEY="):
                return line.split("=", 1)[1].strip()
    raise RuntimeError("OPENAI_API_KEY nicht in Secrets-File gefunden.")

def build_request_body(brief):
    return {
        "model": "gpt-image-1",
        "prompt": brief["prompt"],
        "size": brief["size"],
        "quality": brief["quality"],
        "background": brief["background"],
        "output_format": "png",
        "n": 1,
    }

def generate_png(brief, timeout=180):
    """Gibt PNG-Bytes zurück oder wirft RuntimeError mit lesbarer Meldung."""
    body = json.dumps(build_request_body(brief)).encode()
    req = urllib.request.Request(
        "https://api.openai.com/v1/images/generations", data=body,
        headers={"Authorization": f"Bearer {_load_openai_key()}",
                 "Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:500]
        raise RuntimeError(f"OpenAI HTTP {e.code}: {detail}")
    b64 = data["data"][0]["b64_json"]
    return base64.b64decode(b64)
```

- [ ] **Step 4: Unit-Test bestehen**

Run: `python3 -m pytest test_openai_image.py -v`
Expected: 1 passed.

- [ ] **Step 5: Echter Integrations-Call (kostet ~4 Cent)**

Run:
```bash
cd ~/.paperclip/scripts/bild-service
python3 -c "from openai_image import generate_png; \
open('/tmp/bildtest.png','wb').write(generate_png({'prompt':'Ein blaues Quadrat mit dem Wort TEST','size':'1024x1024','quality':'low','background':'opaque'})); \
print('OK')" && file /tmp/bildtest.png
```
Expected: `OK` und `/tmp/bildtest.png: PNG image data, 1024 x 1024`.

- [ ] **Step 6: Commit**

---

## Task 5: `cost_state.py` (TDD Tageslimit + Log)

**Files:** Create `cost_state.py`, Test `test_cost_state.py`

- [ ] **Step 1: Failing-Test**

`test_cost_state.py`:
```python
import os, tempfile, importlib
import cost_state

def setup_tmp(monkeypatch=None):
    fd, path = tempfile.mkstemp(); os.close(fd); os.remove(path)
    cost_state.STATE_FILE = path
    return path

def test_increment_and_limit():
    setup_tmp()
    # frischer Tag: 0 verbraucht
    assert cost_state.remaining_today("2026-06-15") == cost_state.DAILY_IMAGE_LIMIT
    cost_state.record("2026-06-15", "medium")
    assert cost_state.remaining_today("2026-06-15") == cost_state.DAILY_IMAGE_LIMIT - 1

def test_new_day_resets():
    setup_tmp()
    cost_state.record("2026-06-15", "high")
    assert cost_state.remaining_today("2026-06-16") == cost_state.DAILY_IMAGE_LIMIT
```

- [ ] **Step 2: Test fehlschlagen lassen**

Run: `python3 -m pytest test_cost_state.py -v`
Expected: FAIL (`ModuleNotFoundError`).

- [ ] **Step 3: Implementierung**

`cost_state.py`:
```python
import json, os, tempfile
from config import STATE_FILE as _DEFAULT_STATE, DAILY_IMAGE_LIMIT, COST_ESTIMATE

STATE_FILE = _DEFAULT_STATE

def _load():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}

def _save(state):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(STATE_FILE))
    with os.fdopen(fd, "w") as f:
        json.dump(state, f)
    os.replace(tmp, STATE_FILE)   # atomar

def remaining_today(date_str):
    st = _load()
    day = st.get(date_str, {})
    return DAILY_IMAGE_LIMIT - int(day.get("count", 0))

def record(date_str, quality):
    st = _load()
    day = st.setdefault(date_str, {"count": 0, "cost_usd": 0.0})
    day["count"] += 1
    day["cost_usd"] = round(day["cost_usd"] + COST_ESTIMATE.get(quality, 0.04), 4)
    # alte Tage kappen (nur letzte 30 behalten)
    for k in sorted(st.keys())[:-30]:
        del st[k]
    _save(st)
```

- [ ] **Step 4: Tests bestehen**

Run: `python3 -m pytest test_cost_state.py -v`
Expected: 2 passed.

- [ ] **Step 5: Commit**

---

## Task 6: `paperclip_api.py` (Integration)

**Files:** Create `paperclip_api.py`

- [ ] **Step 1: Implementierung**

`paperclip_api.py`:
```python
import json, os, uuid, urllib.request, urllib.error
from config import (PAPERCLIP_BASE, AUTH_JSON, MAIL_WEBHOOK, MAIL_SECRET,
                    MAIL_FROM, MAIL_TO)

class AuthError(Exception):
    pass

def _token():
    with open(AUTH_JSON) as f:
        return json.load(f)["credentials"][PAPERCLIP_BASE]["token"]

def _request(method, path, *, json_body=None, multipart=None, base=PAPERCLIP_BASE):
    url = base + path
    headers = {"Authorization": f"Bearer {_token()}"}
    data = None
    if json_body is not None:
        data = json.dumps(json_body).encode()
        headers["Content-Type"] = "application/json"
    elif multipart is not None:
        boundary = "----bild" + uuid.uuid4().hex
        filename, content = multipart  # (filename, bytes)
        pre = (f"--{boundary}\r\n"
               f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
               f"Content-Type: image/png\r\n\r\n").encode()
        post = f"\r\n--{boundary}--\r\n".encode()
        data = pre + content + post
        headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise AuthError(f"Paperclip {e.code} — Board-Token abgelaufen.")
        raise RuntimeError(f"Paperclip HTTP {e.code}: {e.read().decode(errors='replace')[:300]}")

def list_issues(company_id, status, label_id, limit=100):
    return _request("GET",
        f"/api/companies/{company_id}/issues?status={status}&labelId={label_id}&limit={limit}")

def patch_status(issue_id, status):
    return _request("PATCH", f"/api/issues/{issue_id}", json_body={"status": status})

def add_comment(issue_id, body):
    return _request("POST", f"/api/issues/{issue_id}/comments", json_body={"body": body})

def upload_attachment(company_id, issue_id, filename, png_bytes):
    return _request("POST",
        f"/api/companies/{company_id}/issues/{issue_id}/attachments",
        multipart=(filename, png_bytes))

def mail_alarm(subject, text):
    body = json.dumps({"from": MAIL_FROM, "to": MAIL_TO,
                       "subject": subject, "text": text}).encode()
    req = urllib.request.Request(MAIL_WEBHOOK, data=body,
        headers={"Content-Type": "application/json", "X-Mailhub-Secret": MAIL_SECRET},
        method="POST")
    try:
        urllib.request.urlopen(req, timeout=20)
    except Exception:
        pass  # Alarm-Pfad darf nie selbst crashen
```

- [ ] **Step 2: Integration — Kommentar + Statuswechsel an einem Wegwerf-Issue**

Erst ein Test-Issue manuell anlegen (WHITESTAG), dessen ID notieren:
```bash
cd ~/.paperclip/scripts/bild-service
python3 -c "import paperclip_api as p; \
print(p.list_issues('9cebf3cf-efe8-4597-a400-f06488900a87','todo','PASTE_WHITESTAG_LABEL_UUID'))"
```
Expected: `[]` (noch keine gelabelten Issues) — bestätigt, dass Auth + Endpoint funktionieren (kein Fehler).

- [ ] **Step 3: Attachment-Upload gegen ein echtes Test-Issue (Neuland verifizieren)**

```bash
# <ISSUE_ID> = ein beliebiges existierendes WHITESTAG-Issue
python3 -c "import paperclip_api as p; \
png=open('/tmp/bildtest.png','rb').read(); \
print(p.upload_attachment('9cebf3cf-efe8-4597-a400-f06488900a87','<ISSUE_ID>','test.png',png))"
```
Expected: JSON mit einer Attachment-`id`. Danach im Paperclip-UI prüfen, dass das PNG am Issue hängt.
**Falls Fehler:** Multipart-Format an `server/src/routes/issues.ts:4483` (multer-Erwartung, Feldname `file`) abgleichen, korrigieren, erneut testen.

- [ ] **Step 4: Commit**

---

## Task 7: `bild_service.py` Hauptschleife

**Files:** Create `bild_service.py`

- [ ] **Step 1: Implementierung**

`bild_service.py`:
```python
#!/usr/bin/env python3
import sys, datetime, traceback
import config, paperclip_api as api
from brief_parser import parse_brief
from openai_image import generate_png
import cost_state

def _today():
    return datetime.date.today().isoformat()

def process_issue(company, issue):
    iid = issue["id"]
    title = issue.get("title", "")
    # 1. Lock
    api.patch_status(iid, "in_progress")
    # 2. Brief parsen (Description, sonst Titel)
    brief = parse_brief(issue.get("description") or title)
    if brief["error"]:
        api.add_comment(iid, f"⚠️ Bild nicht erzeugt: {brief['error']}\n"
                             f"Format:\nprompt: <Beschreibung>\nsize: 1024x1024\nquality: medium")
        api.patch_status(iid, "cancelled")
        return
    # 3. Tageslimit
    if cost_state.remaining_today(_today()) <= 0:
        api.add_comment(iid, f"⚠️ Tageslimit ({config.DAILY_IMAGE_LIMIT} Bilder) erreicht. "
                             f"Morgen erneut versuchen.")
        api.patch_status(iid, "cancelled")
        return
    # 4. Generieren
    try:
        png = generate_png(brief)
    except Exception as e:
        api.add_comment(iid, f"⚠️ OpenAI-Fehler: {e}")
        api.patch_status(iid, "cancelled")
        return
    # 5. Upload + Buchung + Kommentar + done
    fname = "bild-" + iid[:8] + ".png"
    api.upload_attachment(company["id"], iid, fname, png)
    cost_state.record(_today(), brief["quality"])
    est = config.COST_ESTIMATE.get(brief["quality"], 0.04)
    api.add_comment(iid,
        f"✅ Bild erzeugt (gpt-image-1).\n"
        f"Prompt: {brief['prompt']}\n"
        f"Settings: {brief['size']}, quality={brief['quality']}, bg={brief['background']}\n"
        f"Geschätzte Kosten: ~{est:.2f} USD")
    api.patch_status(iid, "done")

def run_once():
    for company in config.COMPANIES:
        for status in config.POLL_STATUSES:
            try:
                issues = api.list_issues(company["id"], status, company["label"])
            except api.AuthError as e:
                api.mail_alarm("[Bilddienst] Paperclip-Token abgelaufen", str(e))
                sys.exit(1)
            for issue in issues:
                try:
                    process_issue(company, issue)
                except api.AuthError as e:
                    api.mail_alarm("[Bilddienst] Paperclip-Token abgelaufen", str(e))
                    sys.exit(1)
                except Exception:
                    api.mail_alarm("[Bilddienst] Unerwarteter Fehler",
                                   traceback.format_exc())

if __name__ == "__main__":
    run_once()
```

- [ ] **Step 2: Trockenlauf (keine gelabelten Issues vorhanden ⇒ No-Op)**

Run: `cd ~/.paperclip/scripts/bild-service && python3 bild_service.py && echo "EXIT $?"`
Expected: `EXIT 0`, keine Ausgabe (nichts zu tun).

- [ ] **Step 3: Commit**

---

## Task 8: launchd-Service installieren

**Files:** Create `~/Library/LaunchAgents/de.whitestag.bild-service.plist`

- [ ] **Step 1: plist schreiben**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>de.whitestag.bild-service</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>/Users/walterschoenenbroecher.de/.paperclip/scripts/bild-service/bild_service.py</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/walterschoenenbroecher.de/.paperclip/scripts/bild-service</string>
  <key>StartInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>/Users/walterschoenenbroecher.de/.paperclip/instances/default/state/bild-service.out.log</string>
  <key>StandardErrorPath</key><string>/Users/walterschoenenbroecher.de/.paperclip/instances/default/state/bild-service.err.log</string>
</dict>
</plist>
```

- [ ] **Step 2: Laden + Status prüfen**

Run:
```bash
launchctl unload ~/Library/LaunchAgents/de.whitestag.bild-service.plist 2>/dev/null
launchctl load ~/Library/LaunchAgents/de.whitestag.bild-service.plist
launchctl list | grep de.whitestag.bild-service
```
Expected: eine Zeile mit dem Label (PID oder `-` und Exit 0).

- [ ] **Step 3: Nach ~70 s Error-Log prüfen**

Run: `sleep 70 && cat ~/.paperclip/instances/default/state/bild-service.err.log`
Expected: leer oder nur harmlose Zeilen — kein Traceback.

---

## Task 9: AGENTS.md — „Bild bestellen"-Anleitung für Agenten

**Files:** Modify `~/.paperclip/scripts/agents-instructions/_common.md` (gemeinsamer Block für alle Agenten)

- [ ] **Step 1: Generator-Mechanik prüfen**

Run: `sed -n '1,40p' ~/.paperclip/scripts/agents-instructions/_common.md; ls ~/.paperclip/scripts/agents-instructions/`
Erwartung: verstehen, wie `_common.md` in die AGENTS.md eingebaut wird (Template/Concat).

- [ ] **Step 2: Block in `_common.md` ergänzen**

Folgenden Abschnitt anhängen (statische 3-Zeilen-Tabelle; jeder Agent nutzt die Zeile seiner Company):

```markdown
## Bild/Grafik bestellen (OpenAI gpt-image-1)

Wenn du eine Grafik brauchst (Poster, Infografik, Diagramm, Social-Bild),
delegiere sie an den zentralen Bilddienst — du musst nichts ausführen, nur
einen Subtask anlegen:

1. Lege einen Subtask unter deinem aktuellen Issue an
   (`POST /api/companies/{companyId}/issues/{deinIssueId}/children`):
   - `labelIds: [ <Label-UUID deiner Company aus der Tabelle unten> ]`
   - `blockParentUntilDone: true`
   - `title`: kurze Bezeichnung
   - `description` im Format:
     ```
     prompt: <genaue Bildbeschreibung; bei Text im Bild den Text in Anführungszeichen>
     size: 1024x1024        # optional: 1024x1024 | 1024x1536 | 1536x1024
     quality: medium        # optional: low | medium | high
     transparent: false     # optional
     ```
2. Der Dienst hängt das fertige PNG als Attachment an den Subtask und schließt ihn.
   Du wirst automatisch geweckt (issue_children_completed) und findest das Bild dort.

| Company    | Label-UUID für `bild:openai` |
|------------|------------------------------|
| WHITESTAG  | PASTE_WHITESTAG_LABEL_UUID   |
| Clara      | PASTE_CLARA_LABEL_UUID       |
| Health     | PASTE_HEALTH_LABEL_UUID      |
```

- [ ] **Step 3: AGENTS.md neu generieren** (über den bestehenden Generator)

Run: den Generator-Aufruf nutzen, den der Generator-Ordner vorgibt (aus Step 1 ermittelt), z.B.
`python3 ~/.paperclip/scripts/agents-instructions/generate.py` (exakter Name in Step 1 verifizieren).
Expected: AGENTS.md der Agenten enthalten den neuen Block.

- [ ] **Step 4: Commit**

---

## Task 10: End-to-End-Verifikation

- [ ] **Step 1: Test-Subtask mit Label anlegen** (simuliert eine Agenten-Bestellung)

Run (WHITESTAG; `<PARENT_ISSUE_ID>` = beliebiges offenes Issue, `<LABEL_UUID>` aus Task 1):
```bash
TOKEN=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.paperclip/auth.json')))['credentials']['http://localhost:3100']['token'])")
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"E2E Bildtest","description":"prompt: Ein minimalistisches Logo mit dem Wort \"WHITESTAG\", dunkler Hintergrund\nsize: 1024x1024\nquality: medium","labelIds":["<LABEL_UUID>"],"blockParentUntilDone":true}' \
  "http://localhost:3100/api/issues/<PARENT_ISSUE_ID>/children" | python3 -m json.tool | grep '"id"'
```
Expected: neuer Subtask mit `id`, Status `todo`.

- [ ] **Step 2: Auf den nächsten Service-Lauf warten + Ergebnis prüfen**

Run: `sleep 75` dann den Subtask abrufen:
```bash
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:3100/api/issues/<SUBTASK_ID>/attachments" | python3 -m json.tool
```
Expected: ein Attachment-Eintrag (PNG). Subtask-Status = `done`; im UI hängt das Bild + Erfolgs-Kommentar.

- [ ] **Step 3: Fehlerpfad prüfen — Brief ohne prompt**

Subtask mit `description: "size: 1024x1024"` anlegen (kein prompt). Nach ~75 s: Status = `cancelled`, Kommentar erklärt das fehlende Pflichtfeld.

- [ ] **Step 4: Kosten-Log prüfen**

Run: `cat ~/.paperclip/instances/default/state/bild-service.json`
Expected: `{"2026-06-15": {"count": N, "cost_usd": …}}`.

- [ ] **Step 5: Abschluss-Commit** (alle Service-Dateien + plist-Referenz dokumentiert)

---

## Bekannte V1-Grenzen (bewusst, für später)

- **Hängende `in_progress`-Subtasks:** Crasht der Dienst zwischen Lock und Abschluss,
  bleibt der Subtask in `in_progress` (wird nicht erneut gepollt). V2: Sweep für
  `in_progress`-Items älter als X Minuten.
- **Board-Token-TTL (~30 Tage):** Bei Ablauf stoppt der Dienst mit Mail-Alarm; Token
  manuell erneuern. (Siehe Memory „Deliverable-watcher token TTL".)
- **Kostenschätzung ist grob** (Tabelle, nicht abrechnungsgenau) — nur fürs Log/Limit.
- **Nur Text-zu-Bild**, keine Variationen/Edits in V1.
```
