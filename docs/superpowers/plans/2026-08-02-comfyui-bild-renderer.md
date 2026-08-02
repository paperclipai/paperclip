# ComfyUI-Bild-Renderer — Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Paperclip-Agenten erzeugen Bilder lokal über ComfyUI auf dem MacBook statt über OpenAIs `gpt-image-1` — ohne Kostendeckel, ohne Cloud-Upload, mit reproduzierbarem Seed.

**Architecture:** Der bestehende launchd-Dienst `bild-service` bekommt einen zweiten Renderer statt eines Parallel-Dienstes. Er wird zweiphasig: eine Phase sendet Aufträge an ComfyUIs HTTP-API auf dem MacBook ab, eine spätere sammelt fertige Bilder ein. Auf dem MacBook läuft ComfyUI headless als LaunchAgent auf Port 8189, neben der Desktop-App auf 8188.

**Tech Stack:** Python 3.9 (Standardbibliothek, keine Fremdpakete), pytest, launchd, ComfyUI 0.29.2 HTTP-API, Qwen-Image 2512 fp8 mit Turbo-LoRA.

**Spec:** `docs/superpowers/specs/2026-08-02-comfyui-bild-renderer-design.md`

## Global Constraints

- **Python 3.9.6.** Der LaunchAgent fährt `/usr/bin/python3` = 3.9.6. Keine `X | None`-Unions, kein `match`, keine `list[str]`/`dict[str, int]`-Annotationen zur Laufzeit.
- **Nur Standardbibliothek.** Der Dienst importiert ausschließlich `json`, `os`, `sys`, `time`, `fcntl`, `datetime`, `tempfile`, `uuid`, `urllib`, `traceback`. Keine `requests`, kein `pip install`.
- **Flache Imports.** Die Module liegen nebeneinander und importieren sich flach (`import config`, `from brief_parser import parse_brief`). Kein Paket, kein `__init__.py`. pytest wird deshalb **aus dem Modulverzeichnis heraus** gestartet.
- **Deutsch in allen Nutzertexten.** Issue-Kommentare, Mail-Betreffe und Fehlermeldungen an Agenten sind deutsch.
- **Renderknoten:** `http://192.168.2.40:8189`, SSH als `walterschonenbrocher@192.168.2.40` mit `~/.ssh/id_ed25519`.
- **ComfyUI auf dem MacBook:** Python `~/ComfyUI-Installs/ComfyUI/ComfyUI/.venv/bin/python`, Einstiegspunkt `~/ComfyUI-Installs/ComfyUI/ComfyUI/main.py`. Die Umgebung `standalone-env` hat **kein torch** und ist unbrauchbar.
- **Repo-Wurzel:** `~/Library/CloudStorage/SynologyDrive-Mac/Claude Code MAC/Paperclip`. Live-Kopie: `~/.paperclip/scripts/bild-service/`. launchd kann CloudStorage nicht lesen — Code läuft immer aus der Live-Kopie, gepflegt wird im Repo.

## Dateistruktur

Neu im Repo unter `tools/bild-service/`:

| Datei | Verantwortung |
|---|---|
| `config.py` | Konstanten: Companies, Grenzen, Formate, Knoten-URL |
| `paperclip_api.py` | Paperclip-HTTP: Issues, Kommentare, Anhänge, Mail-Alarm |
| `brief_parser.py` | Auftragstext → Brief-Dict |
| `cost_state.py` | Tages-/Monatszähler, OpenAI-Kosten und lokale Menge |
| `openai_image.py` | Renderer OpenAI (synchron, unverändert) |
| `comfy_client.py` | **neu** — ComfyUI-HTTP, kennt kein Paperclip |
| `workflow_template.py` | **neu** — Vorlage laden und Platzhalter füllen |
| `job_state.py` | **neu** — Warteschlange laufender Renders, neustartfest |
| `bild_service.py` | Poller, zwei Phasen, verdrahtet die Module |
| `workflows/qwen-image.api.json` | **neu** — Workflow im ComfyUI-API-Format |
| `node/de.whitestag.comfyui-node.plist` | **neu** — LaunchAgent-Vorlage fürs MacBook |
| `node/install-node.sh` | **neu** — richtet den Knoten per SSH ein |
| `deploy.sh` | **neu** — Repo → `~/.paperclip/scripts/bild-service/` |
| `smoke_comfy.py` | **neu** — Rauchtest Ende zu Ende |

Trennung: `comfy_client.py` weiß nichts von Paperclip, `paperclip_api.py` nichts von ComfyUI, `bild_service.py` verdrahtet beide. So bleibt jedes Modul einzeln testbar.

---

### Task 1: Dienst ins Repo holen und Deploy-Weg bauen

Der Dienst existiert heute **nur** unter `~/.paperclip/scripts/bild-service/` und ist unversioniert — jeder andere Dienst liegt als `tools/<name>/` im Repo mit einem `deploy.sh`. Vor jeder Änderung wird der Ist-Zustand gesichert, sonst ist ein Fehlgriff unwiederbringlich.

**Files:**
- Create: `tools/bild-service/` (Kopie der 9 Live-Dateien)
- Create: `tools/bild-service/deploy.sh`
- Test: die vorhandenen `tools/bild-service/test_*.py`

**Interfaces:**
- Consumes: nichts
- Produces: Repo-Verzeichnis `tools/bild-service/` als alleinige Quelle; `deploy.sh` kopiert nach `~/.paperclip/scripts/bild-service/`

- [ ] **Step 1: Live-Stand ins Repo kopieren**

```bash
cd "$HOME/Library/CloudStorage/SynologyDrive-Mac/Claude Code MAC/Paperclip"
mkdir -p tools/bild-service
cp "$HOME/.paperclip/scripts/bild-service"/*.py tools/bild-service/
ls tools/bild-service/
```

Erwartet: `bild_service.py brief_parser.py config.py cost_state.py openai_image.py paperclip_api.py test_brief_parser.py test_cost_state.py test_openai_image.py`

- [ ] **Step 2: Baseline-Tests im Repo laufen lassen**

Run: `cd tools/bild-service && /usr/bin/python3 -m pytest -q`
Expected: `9 passed`

- [ ] **Step 3: deploy.sh schreiben**

```bash
#!/usr/bin/env bash
# Deploy des Bild-Dienstes nach ~/.paperclip/scripts/bild-service/.
# macOS launchd kann CloudStorage/SynologyDrive nicht lesen -> Live-Kopie unter ~/.paperclip.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$REPO_ROOT/tools/bild-service"
DEST="$HOME/.paperclip/scripts/bild-service"

mkdir -p "$DEST/workflows"

for f in "$SRC"/*.py; do
  cp "$f" "$DEST/$(basename "$f")"
done

if compgen -G "$SRC/workflows/*.json" > /dev/null; then
  cp "$SRC"/workflows/*.json "$DEST/workflows/"
fi

# Tests aus der Live-Kopie ausschliessen waere Unsinn: sie sind winzig und
# machen den Live-Stand selbst pruefbar.
echo "Deployt nach $DEST"
ls -1 "$DEST"
```

- [ ] **Step 4: deploy.sh ausführbar machen und laufen lassen**

Run:
```bash
chmod +x tools/bild-service/deploy.sh && ./tools/bild-service/deploy.sh
```
Expected: Liste der Dateien, kein Fehler

- [ ] **Step 5: Prüfen, dass Repo und Live identisch sind**

Run:
```bash
diff -r tools/bild-service "$HOME/.paperclip/scripts/bild-service" \
  --exclude=__pycache__ --exclude=.pytest_cache --exclude=workflows --exclude=deploy.sh
```
Expected: keine Ausgabe (Deploy ist wirkungsgleich, kein Drift)

- [ ] **Step 6: Commit**

```bash
git add tools/bild-service
git commit -m "chore(bild-service): Live-Stand ins Repo holen und deploy.sh ergänzen

Der Dienst lief bislang unversioniert nur unter ~/.paperclip/scripts/.
Ab jetzt ist tools/bild-service/ die Quelle, deploy.sh der einzige Weg
in den Live-Pfad — wie bei allen anderen Diensten."
```

---

### Task 2: ComfyUI headless als LaunchAgent auf dem MacBook

Unabhängig vom Dienstcode und Voraussetzung für jeden späteren Ende-zu-Ende-Test.

**Files:**
- Create: `tools/bild-service/node/de.whitestag.comfyui-node.plist`
- Create: `tools/bild-service/node/install-node.sh`

**Interfaces:**
- Consumes: nichts
- Produces: erreichbarer ComfyUI-Server unter `http://192.168.2.40:8189`, `GET /system_stats` antwortet mit JSON

- [ ] **Step 1: LaunchAgent-Vorlage schreiben**

Create `tools/bild-service/node/de.whitestag.comfyui-node.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>de.whitestag.comfyui-node</string>
  <key>ProgramArguments</key>
  <array>
    <string>__HOME__/ComfyUI-Installs/ComfyUI/ComfyUI/.venv/bin/python</string>
    <string>__HOME__/ComfyUI-Installs/ComfyUI/ComfyUI/main.py</string>
    <string>--listen</string><string>0.0.0.0</string>
    <string>--port</string><string>8189</string>
    <string>--extra-model-paths-config</string>
    <string>__HOME__/Library/Application Support/Comfy Desktop/shared_model_paths.yaml</string>
    <string>--input-directory</string><string>__HOME__/ComfyUI-Shared/input</string>
    <string>--output-directory</string><string>__HOME__/ComfyUI-Shared/output</string>
  </array>
  <key>WorkingDirectory</key>
  <string>__HOME__/ComfyUI-Installs/ComfyUI/ComfyUI</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>__HOME__/Library/Logs/comfyui-node.out.log</string>
  <key>StandardErrorPath</key><string>__HOME__/Library/Logs/comfyui-node.err.log</string>
</dict>
</plist>
```

- [ ] **Step 2: Installationsskript schreiben**

Create `tools/bild-service/node/install-node.sh`:

```bash
#!/usr/bin/env bash
# Richtet ComfyUI headless als LaunchAgent auf dem MacBook ein (von der Studio aus).
set -euo pipefail

NODE_HOST="${NODE_HOST:-walterschonenbrocher@192.168.2.40}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="de.whitestag.comfyui-node"

REMOTE_HOME="$(ssh -o BatchMode=yes "$NODE_HOST" 'echo $HOME')"
echo "Ziel-Home: $REMOTE_HOME"

# Pflichtpfade prüfen, bevor irgendetwas installiert wird
ssh -o BatchMode=yes "$NODE_HOST" '
  set -e
  test -x "$HOME/ComfyUI-Installs/ComfyUI/ComfyUI/.venv/bin/python" || { echo "venv fehlt"; exit 1; }
  test -f "$HOME/ComfyUI-Installs/ComfyUI/ComfyUI/main.py" || { echo "main.py fehlt"; exit 1; }
  test -f "$HOME/Library/Application Support/Comfy Desktop/shared_model_paths.yaml" || { echo "Modellpfade fehlen"; exit 1; }
  "$HOME/ComfyUI-Installs/ComfyUI/ComfyUI/.venv/bin/python" -c "import torch; assert torch.backends.mps.is_available()"
  echo "Vorbedingungen ok"
'

sed "s#__HOME__#$REMOTE_HOME#g" "$SRC_DIR/$LABEL.plist" \
  | ssh -o BatchMode=yes "$NODE_HOST" "mkdir -p \$HOME/Library/LaunchAgents && cat > \$HOME/Library/LaunchAgents/$LABEL.plist"

ssh -o BatchMode=yes "$NODE_HOST" "
  launchctl bootout gui/\$(id -u)/$LABEL 2>/dev/null || true
  launchctl bootstrap gui/\$(id -u) \$HOME/Library/LaunchAgents/$LABEL.plist
  launchctl kickstart -k gui/\$(id -u)/$LABEL
"
echo "LaunchAgent installiert. Warte auf Port 8189 ..."

for i in $(seq 1 60); do
  if curl -s -m 3 -o /dev/null "http://192.168.2.40:8189/system_stats"; then
    echo "Knoten antwortet auf 8189."
    exit 0
  fi
  sleep 2
done
echo "Knoten antwortet nicht innerhalb 120 s — Log prüfen:" >&2
ssh -o BatchMode=yes "$NODE_HOST" 'tail -30 $HOME/Library/Logs/comfyui-node.err.log' >&2
exit 1
```

- [ ] **Step 3: Installation ausführen**

Run:
```bash
chmod +x tools/bild-service/node/install-node.sh && ./tools/bild-service/node/install-node.sh
```
Expected: `Vorbedingungen ok`, dann `Knoten antwortet auf 8189.`

- [ ] **Step 4: Erreichbarkeit vom Studio aus prüfen**

Run:
```bash
curl -s -m 5 http://192.168.2.40:8189/system_stats | head -c 200; echo
```
Expected: JSON mit `"comfyui_version": "0.29.2"`

- [ ] **Step 5: Prüfen, dass die Desktop-App unberührt bleibt**

Run:
```bash
ssh -o BatchMode=yes walterschonenbrocher@192.168.2.40 \
  'lsof -nP -iTCP -sTCP:LISTEN | grep -E ":(8188|8189)"'
```
Expected: 8189 vom LaunchAgent belegt; 8188 nur, wenn die Desktop-App gerade offen ist. Beide dürfen nebeneinander lauschen.

- [ ] **Step 6: Commit**

```bash
git add tools/bild-service/node
git commit -m "feat(bild-service): ComfyUI headless als LaunchAgent auf dem MacBook

Die Desktop-App lauscht nur auf 127.0.0.1:8188 und lebt nur mit offenem
Fenster. Der Knoten läuft auf 8189 mit --listen, damit die App zum
Workflow-Bauen daneben nutzbar bleibt."
```

---

### Task 3: `comfy_client.py` — HTTP-Anbindung an den Knoten

Reine ComfyUI-Schicht ohne Paperclip-Wissen. Das Parsen liegt in eigenen Funktionen, damit es ohne Netz testbar ist.

**Files:**
- Create: `tools/bild-service/comfy_client.py`
- Test: `tools/bild-service/test_comfy_client.py`
- Modify: `tools/bild-service/config.py`

**Interfaces:**
- Consumes: `config.COMFY_BASE`
- Produces:
  - `parse_prompt_response(data)` → `str` (prompt_id)
  - `parse_history(prompt_id, hist)` → `(status, payload)` mit `status` aus `"running" | "done" | "error"`; bei `done` ist `payload` eine Liste von Bild-Dicts `{"filename", "subfolder", "type"}`, bei `error` ein Fehlertext, bei `running` `None`
  - `view_path(image)` → `str` (Pfad mit Query für `GET /view`)
  - `health()` → `bool`
  - `submit(workflow)` → `str`
  - `poll(prompt_id)` → `(status, payload)`
  - `fetch_image(image)` → `bytes`

- [ ] **Step 1: Konstanten in `config.py` ergänzen**

Am Ende von `tools/bild-service/config.py` anfügen:

```python
# --- ComfyUI-Renderknoten (MacBook M5 Max) ---
COMFY_BASE = "http://192.168.2.40:8189"
COMFY_HTTP_TIMEOUT = 30          # Sekunden je HTTP-Aufruf
```

- [ ] **Step 2: Die fehlschlagenden Tests schreiben**

Create `tools/bild-service/test_comfy_client.py`:

```python
import pytest
import comfy_client as cc


def test_parse_prompt_response_returns_id():
    assert cc.parse_prompt_response({"prompt_id": "abc-123", "number": 1}) == "abc-123"


def test_parse_prompt_response_without_id_raises():
    with pytest.raises(RuntimeError):
        cc.parse_prompt_response({"error": "kaputt"})


def test_parse_history_unknown_id_is_running():
    status, payload = cc.parse_history("abc", {})
    assert status == "running"
    assert payload is None


def test_parse_history_completed_returns_images():
    hist = {"abc": {
        "status": {"completed": True, "status_str": "success"},
        "outputs": {"11": {"images": [
            {"filename": "whitestag_00001_.png", "subfolder": "", "type": "output"}]}},
    }}
    status, payload = cc.parse_history("abc", hist)
    assert status == "done"
    assert payload == [{"filename": "whitestag_00001_.png", "subfolder": "", "type": "output"}]


def test_parse_history_error_returns_message():
    hist = {"abc": {"status": {"completed": False, "status_str": "error",
                               "messages": [["execution_error",
                                             {"node_type": "UNETLoader",
                                              "exception_message": "Modell fehlt"}]]}}}
    status, payload = cc.parse_history("abc", hist)
    assert status == "error"
    assert "UNETLoader" in payload
    assert "Modell fehlt" in payload


def test_parse_history_still_running():
    hist = {"abc": {"status": {"completed": False, "status_str": "success"}, "outputs": {}}}
    status, payload = cc.parse_history("abc", hist)
    assert status == "running"


def test_view_path_encodes_query():
    p = cc.view_path({"filename": "a b.png", "subfolder": "sub dir", "type": "output"})
    assert p.startswith("/view?")
    assert "filename=a+b.png" in p or "filename=a%20b.png" in p
    assert "subfolder=sub" in p
    assert "type=output" in p
```

- [ ] **Step 3: Tests laufen lassen, Fehlschlag bestätigen**

Run: `cd tools/bild-service && /usr/bin/python3 -m pytest test_comfy_client.py -q`
Expected: FAIL mit `ModuleNotFoundError: No module named 'comfy_client'`

- [ ] **Step 4: `comfy_client.py` schreiben**

```python
"""HTTP-Anbindung an einen ComfyUI-Knoten. Kennt kein Paperclip.

Das Parsen der Antworten liegt in eigenen, netzfreien Funktionen, damit es
ohne laufenden Server testbar bleibt.
"""
import json
import urllib.parse
import urllib.request
import urllib.error

from config import COMFY_BASE, COMFY_HTTP_TIMEOUT


class ComfyError(RuntimeError):
    """Knoten nicht erreichbar oder antwortet fehlerhaft."""


def parse_prompt_response(data):
    pid = (data or {}).get("prompt_id")
    if not pid:
        raise RuntimeError("ComfyUI lieferte keine prompt_id: %s" % json.dumps(data)[:300])
    return pid


def _error_text(status):
    parts = []
    for msg in status.get("messages") or []:
        if not isinstance(msg, (list, tuple)) or len(msg) < 2:
            continue
        kind, info = msg[0], msg[1]
        if kind != "execution_error" or not isinstance(info, dict):
            continue
        parts.append("%s: %s" % (info.get("node_type", "?"),
                                 info.get("exception_message", "?")))
    return "; ".join(parts) if parts else "Ausführungsfehler ohne Detailmeldung."


def parse_history(prompt_id, hist):
    entry = (hist or {}).get(prompt_id)
    if not entry:
        return "running", None
    status = entry.get("status") or {}
    if status.get("status_str") == "error":
        return "error", _error_text(status)
    if not status.get("completed"):
        return "running", None
    images = []
    for out in (entry.get("outputs") or {}).values():
        images.extend(out.get("images") or [])
    if not images:
        return "error", "Lauf abgeschlossen, aber ohne Bild im Ergebnis."
    return "done", images


def view_path(image):
    query = urllib.parse.urlencode({
        "filename": image.get("filename", ""),
        "subfolder": image.get("subfolder", ""),
        "type": image.get("type", "output"),
    })
    return "/view?" + query


def _get(path, timeout=None):
    url = COMFY_BASE + path
    try:
        with urllib.request.urlopen(url, timeout=timeout or COMFY_HTTP_TIMEOUT) as resp:
            return resp.read()
    except (urllib.error.URLError, OSError) as e:
        raise ComfyError("ComfyUI nicht erreichbar (%s): %s" % (path, e))


def health():
    try:
        _get("/system_stats", timeout=5)
        return True
    except ComfyError:
        return False


def submit(workflow):
    body = json.dumps({"prompt": workflow}).encode()
    req = urllib.request.Request(COMFY_BASE + "/prompt", data=body,
                                 headers={"Content-Type": "application/json"},
                                 method="POST")
    try:
        with urllib.request.urlopen(req, timeout=COMFY_HTTP_TIMEOUT) as resp:
            return parse_prompt_response(json.loads(resp.read()))
    except urllib.error.HTTPError as e:
        raise ComfyError("ComfyUI HTTP %s: %s" % (e.code, e.read().decode(errors="replace")[:400]))
    except (urllib.error.URLError, OSError) as e:
        raise ComfyError("ComfyUI nicht erreichbar (/prompt): %s" % e)


def poll(prompt_id):
    raw = _get("/history/%s" % urllib.parse.quote(prompt_id))
    return parse_history(prompt_id, json.loads(raw))


def fetch_image(image):
    return _get(view_path(image), timeout=60)
```

- [ ] **Step 5: Tests laufen lassen**

Run: `cd tools/bild-service && /usr/bin/python3 -m pytest test_comfy_client.py -q`
Expected: `7 passed`

- [ ] **Step 6: Gegen den echten Knoten gegenprüfen**

Run: `cd tools/bild-service && /usr/bin/python3 -c "import comfy_client; print(comfy_client.health())"`
Expected: `True`

- [ ] **Step 7: Commit**

```bash
git add tools/bild-service/comfy_client.py tools/bild-service/test_comfy_client.py tools/bild-service/config.py
git commit -m "feat(bild-service): ComfyUI-Client mit netzfrei testbarem Parsing"
```

---

### Task 4: Workflow-Vorlage und Platzhalter-Substitution

**Files:**
- Create: `tools/bild-service/workflows/qwen-image.api.json`
- Create: `tools/bild-service/workflow_template.py`
- Test: `tools/bild-service/test_workflow_template.py`

**Interfaces:**
- Consumes: nichts
- Produces:
  - `PLACEHOLDERS` → Tupel `("__PROMPT__", "__SEED__", "__WIDTH__", "__HEIGHT__")`
  - `load_raw(name)` → `str` (Vorlagentext)
  - `fill(raw, prompt, seed, width, height)` → `dict` (fertiger Workflow)

- [ ] **Step 1: Vorlage schreiben**

Create `tools/bild-service/workflows/qwen-image.api.json`. Der Graph ist gegen `/object_info` der laufenden Instanz verifiziert; `__SEED__`, `__WIDTH__` und `__HEIGHT__` stehen ohne Anführungszeichen, weil dort Zahlen erwartet werden.

```json
{
  "1": {"class_type": "UNETLoader",
        "inputs": {"unet_name": "qwen_image_2512_fp8_e4m3fn.safetensors", "weight_dtype": "default"}},
  "2": {"class_type": "CLIPLoader",
        "inputs": {"clip_name": "qwen_2.5_vl_7b_fp8_scaled.safetensors", "type": "qwen_image"}},
  "3": {"class_type": "VAELoader",
        "inputs": {"vae_name": "qwen_image_vae.safetensors"}},
  "4": {"class_type": "LoraLoaderModelOnly",
        "inputs": {"model": ["1", 0],
                   "lora_name": "Wuli-Qwen-Image-2512-Turbo-LoRA-2steps-V1.0-bf16.safetensors",
                   "strength_model": 1.0}},
  "5": {"class_type": "ModelSamplingAuraFlow",
        "inputs": {"model": ["4", 0], "shift": 3.1}},
  "6": {"class_type": "CLIPTextEncode",
        "inputs": {"text": "__PROMPT__", "clip": ["2", 0]}},
  "7": {"class_type": "CLIPTextEncode",
        "inputs": {"text": "", "clip": ["2", 0]}},
  "8": {"class_type": "EmptySD3LatentImage",
        "inputs": {"width": __WIDTH__, "height": __HEIGHT__, "batch_size": 1}},
  "9": {"class_type": "KSampler",
        "inputs": {"model": ["5", 0], "seed": __SEED__, "steps": 2, "cfg": 1.0,
                   "sampler_name": "euler", "scheduler": "simple",
                   "positive": ["6", 0], "negative": ["7", 0],
                   "latent_image": ["8", 0], "denoise": 1.0}},
  "10": {"class_type": "VAEDecode",
         "inputs": {"samples": ["9", 0], "vae": ["3", 0]}},
  "11": {"class_type": "SaveImage",
         "inputs": {"images": ["10", 0], "filename_prefix": "whitestag"}}
}
```

- [ ] **Step 2: Die fehlschlagenden Tests schreiben**

Create `tools/bild-service/test_workflow_template.py`:

```python
import json
import pytest
import workflow_template as wt


def test_template_contains_all_placeholders():
    raw = wt.load_raw("qwen-image")
    for ph in wt.PLACEHOLDERS:
        assert ph in raw, "Platzhalter %s fehlt in der Vorlage" % ph


def test_fill_leaves_no_placeholder():
    raw = wt.load_raw("qwen-image")
    wf = wt.fill(raw, "Ein Hirsch", 42, 1024, 1024)
    dumped = json.dumps(wf)
    for ph in wt.PLACEHOLDERS:
        assert ph not in dumped


def test_fill_produces_expected_values():
    raw = wt.load_raw("qwen-image")
    wf = wt.fill(raw, "Ein Hirsch", 7, 1536, 1024)
    assert wf["6"]["inputs"]["text"] == "Ein Hirsch"
    assert wf["9"]["inputs"]["seed"] == 7
    assert wf["8"]["inputs"]["width"] == 1536
    assert wf["8"]["inputs"]["height"] == 1024
    assert isinstance(wf["9"]["inputs"]["seed"], int)


def test_fill_escapes_quotes_in_prompt():
    raw = wt.load_raw("qwen-image")
    wf = wt.fill(raw, 'Ein "weisser" Hirsch\nzweite Zeile', 1, 1024, 1024)
    assert wf["6"]["inputs"]["text"] == 'Ein "weisser" Hirsch\nzweite Zeile'


def test_unknown_template_raises():
    with pytest.raises(FileNotFoundError):
        wt.load_raw("gibtsnicht")
```

- [ ] **Step 3: Tests laufen lassen, Fehlschlag bestätigen**

Run: `cd tools/bild-service && /usr/bin/python3 -m pytest test_workflow_template.py -q`
Expected: FAIL mit `ModuleNotFoundError: No module named 'workflow_template'`

- [ ] **Step 4: `workflow_template.py` schreiben**

```python
"""Workflow-Vorlagen im ComfyUI-API-Format laden und Platzhalter ersetzen.

Platzhalter statt fester Node-IDs: so kann eine Vorlage in der Desktop-App
umgebaut und neu exportiert werden, ohne dass hier Code angefasst wird.
"""
import json
import os

PLACEHOLDERS = ("__PROMPT__", "__SEED__", "__WIDTH__", "__HEIGHT__")

WORKFLOW_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "workflows")


def load_raw(name):
    path = os.path.join(WORKFLOW_DIR, name + ".api.json")
    with open(path, encoding="utf-8") as f:
        return f.read()


def fill(raw, prompt, seed, width, height):
    # json.dumps liefert einen vollstaendig maskierten String samt
    # Anfuehrungszeichen; die schneiden wir ab, weil der Platzhalter in der
    # Vorlage bereits in Anfuehrungszeichen steht.
    prompt_escaped = json.dumps(prompt, ensure_ascii=False)[1:-1]
    filled = (raw
              .replace("__PROMPT__", prompt_escaped)
              .replace("__SEED__", str(int(seed)))
              .replace("__WIDTH__", str(int(width)))
              .replace("__HEIGHT__", str(int(height))))
    return json.loads(filled)
```

- [ ] **Step 5: Tests laufen lassen**

Run: `cd tools/bild-service && /usr/bin/python3 -m pytest test_workflow_template.py -q`
Expected: `5 passed`

- [ ] **Step 6: Vorlage gegen den echten Knoten prüfen**

Run:
```bash
cd tools/bild-service && /usr/bin/python3 -c "
import json, workflow_template as wt, comfy_client as cc
wf = wt.fill(wt.load_raw('qwen-image'), 'Testbild eines weissen Hirsches im Nebel', 42, 1024, 1024)
print('prompt_id:', cc.submit(wf))
"
```
Expected: eine `prompt_id`. Schlägt der Aufruf mit HTTP 400 fehl, nennt die Meldung den Knoten und das Feld — Vorlage entsprechend korrigieren, **nicht** den Test aufweichen.

- [ ] **Step 7: Commit**

```bash
git add tools/bild-service/workflows tools/bild-service/workflow_template.py tools/bild-service/test_workflow_template.py
git commit -m "feat(bild-service): Qwen-Image-Vorlage im API-Format mit Platzhaltern"
```

---

### Task 5: Brief-Parser um `modell`, `format` und `seed` erweitern

**Files:**
- Modify: `tools/bild-service/config.py`
- Modify: `tools/bild-service/brief_parser.py`
- Test: `tools/bild-service/test_brief_parser.py` (erweitern)

**Interfaces:**
- Consumes: `config.ALLOWED_FORMATS`, `config.DEFAULT_FORMAT`, `config.ALLOWED_MODELS`, `config.DEFAULT_MODEL`, `config.OPENAI_FORMAT_MAP`
- Produces: `parse_brief(text)` → Dict mit den bisherigen Schlüsseln `error`, `prompt`, `size`, `quality`, `background` **plus** `modell` (`"qwen"`/`"openai"`), `width` (int), `height` (int), `seed` (int oder `None`), `openai_size` (str)

`size` bleibt erhalten und trägt weiterhin `"BREITExHÖHE"` — die vorhandenen Tests und der OpenAI-Pfad hängen daran.

- [ ] **Step 1: Konstanten in `config.py` ergänzen**

```python
# --- Lokales Rendern ---
ALLOWED_MODELS = {"qwen", "openai"}
DEFAULT_MODEL = "qwen"

ALLOWED_FORMATS = {"1024x1024", "1024x1536", "1536x1024", "1344x768", "768x1344"}
DEFAULT_FORMAT = "1024x1024"

# Formate, die die OpenAI-API nicht kennt, auf das naechstliegende abbilden.
OPENAI_FORMAT_MAP = {"1344x768": "1536x1024", "768x1344": "1024x1536"}

DAILY_LOCAL_LIMIT = 60      # Amoklauf-Bremse, kostet nichts, schuetzt den Knoten
MAX_INFLIGHT_JOBS = 3       # gleichzeitig auf dem Knoten
JOB_TIMEOUT_SEC = 300       # gemessen: 72 s kalt, 8 s warm
UNREACHABLE_ALERT_CYCLES = 30   # 30 Zyklen a 60 s = 30 Minuten
```

- [ ] **Step 2: Die neuen fehlschlagenden Tests schreiben**

An `tools/bild-service/test_brief_parser.py` anfügen:

```python
def test_model_defaults_to_qwen():
    b = parse_brief("prompt: x")
    assert b["modell"] == "qwen"


def test_model_openai_is_accepted():
    b = parse_brief("prompt: x\nmodell: openai")
    assert b["modell"] == "openai"


def test_invalid_model_falls_back_to_default():
    b = parse_brief("prompt: x\nmodell: midjourney")
    assert b["modell"] == "qwen"


def test_format_sets_width_and_height():
    b = parse_brief("prompt: x\nformat: 1536x1024")
    assert b["width"] == 1536
    assert b["height"] == 1024
    assert b["size"] == "1536x1024"


def test_format_falls_back_when_not_allowed():
    b = parse_brief("prompt: x\nformat: 4096x4096")
    assert b["size"] == "1024x1024"
    assert b["width"] == 1024


def test_size_still_accepted_as_alias_for_format():
    b = parse_brief("prompt: x\nsize: 1024x1536")
    assert b["size"] == "1024x1536"
    assert b["height"] == 1536


def test_format_wins_over_size_when_both_given():
    b = parse_brief("prompt: x\nsize: 1024x1536\nformat: 1536x1024")
    assert b["size"] == "1536x1024"


def test_seed_is_parsed_as_int():
    b = parse_brief("prompt: x\nseed: 4711")
    assert b["seed"] == 4711


def test_seed_absent_is_none():
    assert parse_brief("prompt: x")["seed"] is None


def test_invalid_seed_is_none():
    assert parse_brief("prompt: x\nseed: viele")["seed"] is None


def test_openai_size_maps_unsupported_format():
    b = parse_brief("prompt: x\nformat: 1344x768")
    assert b["size"] == "1344x768"
    assert b["openai_size"] == "1536x1024"


def test_openai_size_passes_supported_format_through():
    b = parse_brief("prompt: x\nformat: 1024x1536")
    assert b["openai_size"] == "1024x1536"
```

- [ ] **Step 3: Tests laufen lassen, Fehlschlag bestätigen**

Run: `cd tools/bild-service && /usr/bin/python3 -m pytest test_brief_parser.py -q`
Expected: FAIL, erste Meldung `KeyError: 'modell'`

- [ ] **Step 4: `brief_parser.py` ersetzen**

```python
from config import (ALLOWED_QUALITIES, DEFAULT_QUALITY,
                    ALLOWED_FORMATS, DEFAULT_FORMAT,
                    ALLOWED_MODELS, DEFAULT_MODEL, OPENAI_FORMAT_MAP)


def _fields(text):
    out = {}
    for line in (text or "").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        key, _, val = line.partition(":")
        out[key.strip().lower()] = val.split("#", 1)[0].strip()
    return out


def _seed(raw):
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def _result(error, prompt, fmt, quality, background, modell, seed):
    width, height = (int(p) for p in fmt.split("x"))
    return {
        "error": error,
        "prompt": prompt,
        "modell": modell,
        "size": fmt,
        "width": width,
        "height": height,
        "openai_size": OPENAI_FORMAT_MAP.get(fmt, fmt),
        "quality": quality,
        "background": background,
        "seed": seed,
    }


def parse_brief(text):
    fields = _fields(text)

    prompt = fields.get("prompt", "").strip()
    if not prompt:
        return _result("Pflichtfeld 'prompt' fehlt oder ist leer.", None,
                       DEFAULT_FORMAT, DEFAULT_QUALITY, "opaque",
                       DEFAULT_MODEL, None)

    # 'format' ist der Name laut Spec, 'size' bleibt als Alias erlaubt,
    # damit bestehende Auftraege nicht brechen.
    fmt = fields.get("format") or fields.get("size") or DEFAULT_FORMAT
    if fmt not in ALLOWED_FORMATS:
        fmt = DEFAULT_FORMAT

    quality = fields.get("quality", DEFAULT_QUALITY)
    if quality not in ALLOWED_QUALITIES:
        quality = DEFAULT_QUALITY

    modell = fields.get("modell", DEFAULT_MODEL).lower()
    if modell not in ALLOWED_MODELS:
        modell = DEFAULT_MODEL

    transparent = fields.get("transparent", "false").lower() in ("true", "1", "ja", "yes")

    return _result(None, prompt, fmt, quality,
                   "transparent" if transparent else "opaque",
                   modell, _seed(fields.get("seed")))
```

- [ ] **Step 5: Tests laufen lassen**

Run: `cd tools/bild-service && /usr/bin/python3 -m pytest test_brief_parser.py -q`
Expected: `17 passed` (5 alte, 12 neue)

- [ ] **Step 6: Gesamtsuite laufen lassen**

Run: `cd tools/bild-service && /usr/bin/python3 -m pytest -q`
Expected: alle grün — insbesondere `test_openai_image.py`, das weiter über `brief["size"]` geht

- [ ] **Step 7: Commit**

```bash
git add tools/bild-service/brief_parser.py tools/bild-service/test_brief_parser.py tools/bild-service/config.py
git commit -m "feat(bild-service): Brief um modell, format und seed erweitern

'size' bleibt als Alias fuer 'format' erlaubt, damit laufende Auftraege
nicht brechen. Formate, die die OpenAI-API nicht kennt, werden ueber
openai_size auf das naechstliegende abgebildet."
```

---

### Task 6: Warteschlange und lokaler Tageszähler

**Files:**
- Create: `tools/bild-service/job_state.py`
- Test: `tools/bild-service/test_job_state.py`
- Modify: `tools/bild-service/cost_state.py`
- Test: `tools/bild-service/test_cost_state.py` (erweitern)

**Interfaces:**
- Consumes: `config.STATE_FILE`
- Produces:
  - `job_state.add(issue_id, prompt_id, company_id, now, seed=None)` → `None`
  - `job_state.all()` → `dict` Issue-ID → `{"prompt_id", "company_id", "submitted_at", "attempts", "seed"}`
  - `job_state.get(issue_id)` → Dict oder `None`
  - `job_state.drop(issue_id)` → `None`
  - `job_state.bump_attempt(issue_id, prompt_id, now)` → `int` (neue Versuchszahl)
  - `job_state.age_seconds(job, now)` → `float`
  - `cost_state.record_local(date_str)` → `None`
  - `cost_state.remaining_local_today(date_str)` → `int`

**Achtung:** `cost_state.record()` beschneidet den Zustand mit `sorted(st.keys())[:-31]`. Der neue Schlüssel `jobs` überlebt das heute nur zufällig, weil `"jobs"` alphabetisch nach allen Datumsschlüsseln sortiert. Das wird in dieser Aufgabe explizit abgesichert.

- [ ] **Step 1: Die fehlschlagenden Tests für `job_state` schreiben**

Create `tools/bild-service/test_job_state.py`:

```python
import os
import tempfile

import job_state


def setup_tmp():
    fd, path = tempfile.mkstemp()
    os.close(fd)
    os.remove(path)
    job_state.STATE_FILE = path
    return path


def test_add_and_read_back():
    setup_tmp()
    job_state.add("issue-1", "prompt-1", "company-a", now=1000.0)
    jobs = job_state.all()
    assert list(jobs.keys()) == ["issue-1"]
    assert jobs["issue-1"]["prompt_id"] == "prompt-1"
    assert jobs["issue-1"]["company_id"] == "company-a"
    assert jobs["issue-1"]["attempts"] == 1


def test_survives_restart():
    path = setup_tmp()
    job_state.add("issue-1", "prompt-1", "company-a", now=1000.0)
    job_state.STATE_FILE = path          # simuliert Neustart: neu von Platte lesen
    assert job_state.get("issue-1")["prompt_id"] == "prompt-1"


def test_drop_removes_job():
    setup_tmp()
    job_state.add("issue-1", "prompt-1", "company-a", now=1000.0)
    job_state.drop("issue-1")
    assert job_state.all() == {}
    assert job_state.get("issue-1") is None


def test_drop_unknown_job_is_silent():
    setup_tmp()
    job_state.drop("gibtsnicht")
    assert job_state.all() == {}


def test_bump_attempt_increments_and_replaces_prompt_id():
    setup_tmp()
    job_state.add("issue-1", "prompt-1", "company-a", now=1000.0)
    n = job_state.bump_attempt("issue-1", "prompt-2", now=2000.0)
    assert n == 2
    job = job_state.get("issue-1")
    assert job["prompt_id"] == "prompt-2"
    assert job["submitted_at"] == 2000.0


def test_age_seconds():
    setup_tmp()
    job_state.add("issue-1", "prompt-1", "company-a", now=1000.0)
    assert job_state.age_seconds(job_state.get("issue-1"), now=1300.0) == 300.0


def test_jobs_do_not_disturb_cost_keys():
    path = setup_tmp()
    import cost_state
    cost_state.STATE_FILE = path
    cost_state.record("2026-08-02", "medium")
    job_state.add("issue-1", "prompt-1", "company-a", now=1000.0)
    assert cost_state.remaining_today("2026-08-02") == cost_state.DAILY_IMAGE_LIMIT - 1
    assert job_state.get("issue-1") is not None
```

- [ ] **Step 2: Tests laufen lassen, Fehlschlag bestätigen**

Run: `cd tools/bild-service && /usr/bin/python3 -m pytest test_job_state.py -q`
Expected: FAIL mit `ModuleNotFoundError: No module named 'job_state'`

- [ ] **Step 3: `job_state.py` schreiben**

```python
"""Warteschlange laufender ComfyUI-Renders, neustartfest.

Liegt im selben State-File wie die Kostenzaehler, aber unter dem eigenen
Schluessel 'jobs' — die Datumsschluessel von cost_state bleiben unberuehrt.
"""
import json
import os
import tempfile

from config import STATE_FILE as _DEFAULT_STATE

STATE_FILE = _DEFAULT_STATE

JOBS_KEY = "jobs"


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
    os.replace(tmp, STATE_FILE)


def all():
    return _load().get(JOBS_KEY, {})


def get(issue_id):
    return all().get(issue_id)


def add(issue_id, prompt_id, company_id, now, seed=None):
    st = _load()
    jobs = st.setdefault(JOBS_KEY, {})
    jobs[issue_id] = {"prompt_id": prompt_id, "company_id": company_id,
                      "submitted_at": now, "attempts": 1, "seed": seed}
    _save(st)


def bump_attempt(issue_id, prompt_id, now):
    st = _load()
    jobs = st.setdefault(JOBS_KEY, {})
    job = jobs.get(issue_id)
    if job is None:
        return 0
    job["attempts"] = int(job.get("attempts", 1)) + 1
    job["prompt_id"] = prompt_id
    job["submitted_at"] = now
    _save(st)
    return job["attempts"]


def drop(issue_id):
    st = _load()
    jobs = st.get(JOBS_KEY, {})
    if issue_id in jobs:
        del jobs[issue_id]
        _save(st)


def age_seconds(job, now):
    return now - float(job.get("submitted_at", 0))
```

- [ ] **Step 4: Tests laufen lassen**

Run: `cd tools/bild-service && /usr/bin/python3 -m pytest test_job_state.py -q`
Expected: `7 passed`

- [ ] **Step 5: Test für den lokalen Tageszähler und die Beschneidung schreiben**

An `tools/bild-service/test_cost_state.py` anfügen:

```python
def test_local_counter_is_separate_from_openai_counter():
    setup_tmp()
    cost_state.record_local("2026-08-02")
    assert cost_state.remaining_local_today("2026-08-02") == cost_state.DAILY_LOCAL_LIMIT - 1
    # Der OpenAI-Zaehler bleibt unberuehrt
    assert cost_state.remaining_today("2026-08-02") == cost_state.DAILY_IMAGE_LIMIT
    # ... und kostet nichts
    assert cost_state.monthly_spent("2026-08") == 0.0


def test_local_counter_resets_next_day():
    setup_tmp()
    cost_state.record_local("2026-08-02")
    assert cost_state.remaining_local_today("2026-08-03") == cost_state.DAILY_LOCAL_LIMIT


def test_pruning_keeps_jobs_key():
    path = setup_tmp()
    import job_state
    job_state.STATE_FILE = path
    job_state.add("issue-1", "prompt-1", "company-a", now=1000.0)
    # 40 Tage aufzeichnen -> Beschneidung greift
    for day in range(1, 41):
        cost_state.record("2026-03-%02d" % day, "medium")
    assert job_state.get("issue-1") is not None
    assert len([k for k in cost_state._load() if k.startswith("2026-")]) <= 31
```

- [ ] **Step 6: Tests laufen lassen, Fehlschlag bestätigen**

Run: `cd tools/bild-service && /usr/bin/python3 -m pytest test_cost_state.py -q`
Expected: FAIL mit `AttributeError: module 'cost_state' has no attribute 'record_local'`

- [ ] **Step 7: `cost_state.py` anpassen**

Import-Zeile ersetzen:

```python
from config import (STATE_FILE as _DEFAULT_STATE, DAILY_IMAGE_LIMIT,
                    COST_ESTIMATE, DAILY_LOCAL_LIMIT)
```

In `record()` die zweizeilige Schleife

```python
    for k in sorted(st.keys())[:-31]:   # vollen Monat behalten (für monthly_spent)
        del st[k]
    _save(st)
```

durch den Aufruf der neuen Hilfsfunktion ersetzen — beschnitten werden ausschließlich Datumsschlüssel:

```python
    _prune(st)
    _save(st)
```

Und diese Funktionen anfügen:

```python
def _is_day_key(key):
    return len(key) == 10 and key[4] == "-" and key[7] == "-"


def _prune(state):
    """Nur Datumsschluessel beschneiden — 'jobs' und kuenftige Schluessel bleiben."""
    days = sorted(k for k in state if _is_day_key(k))
    for k in days[:-31]:
        del state[k]


def record_local(date_str):
    st = _load()
    day = st.setdefault(date_str, {"count": 0, "cost_usd": 0.0})
    day["local_count"] = int(day.get("local_count", 0)) + 1
    _prune(st)
    _save(st)


def remaining_local_today(date_str):
    day = _load().get(date_str, {})
    return DAILY_LOCAL_LIMIT - int(day.get("local_count", 0))
```

- [ ] **Step 8: Tests laufen lassen**

Run: `cd tools/bild-service && /usr/bin/python3 -m pytest -q`
Expected: alle grün

- [ ] **Step 9: Commit**

```bash
git add tools/bild-service/job_state.py tools/bild-service/test_job_state.py tools/bild-service/cost_state.py tools/bild-service/test_cost_state.py
git commit -m "feat(bild-service): neustartfeste Auftrags-Warteschlange und lokaler Tageszähler

Die Beschneidung in cost_state fasst jetzt ausschliesslich Datumsschluessel
an — vorher haette sie den neuen 'jobs'-Schluessel nur zufaellig verschont,
weil er alphabetisch hinter allen Datumsschluesseln sortiert."
```

---

### Task 7: Poller auf zwei Phasen umbauen

**Files:**
- Modify: `tools/bild-service/bild_service.py`
- Test: `tools/bild-service/test_bild_service.py` (neu)

**Interfaces:**
- Consumes: alles aus Task 3 bis 6
- Produces:
  - `render_local(company, issue, brief, now)` → `None` (sendet ab, legt Auftrag an)
  - `collect_one(issue_id, job, now)` → `str` aus `"running" | "done" | "error" | "timeout"`
  - `collect_phase(now)` / `submit_phase(now)` / `run_once(now)`

- [ ] **Step 1: Die fehlschlagenden Tests schreiben**

Create `tools/bild-service/test_bild_service.py`. Die Tests ersetzen die Netz-Module durch Doppelgänger — kein Netz, keine echten Issues.

```python
import os
import tempfile

import bild_service
import comfy_client
import cost_state
import job_state


class FakeApi(object):
    def __init__(self):
        self.comments = []
        self.status = {}
        self.attachments = []
        self.mails = []

    def add_comment(self, issue_id, body):
        self.comments.append((issue_id, body))

    def patch_status(self, issue_id, status):
        self.status[issue_id] = status

    def upload_attachment(self, company_id, issue_id, filename, data):
        self.attachments.append((issue_id, filename, len(data)))

    def mail_alarm(self, subject, text):
        self.mails.append(subject)


def setup(monkeypatch, tmp_path):
    state = str(tmp_path / "state.json")
    cost_state.STATE_FILE = state
    job_state.STATE_FILE = state
    api = FakeApi()
    for name in ("add_comment", "patch_status", "upload_attachment", "mail_alarm"):
        monkeypatch.setattr(bild_service.api, name, getattr(api, name))
    bild_service.reset_unreachable_counter()
    return api


COMPANY = {"name": "Test", "id": "company-a", "label": "label-a"}


def test_submit_registers_job(monkeypatch, tmp_path):
    api = setup(monkeypatch, tmp_path)
    monkeypatch.setattr(comfy_client, "submit", lambda wf: "prompt-1")
    brief = {"error": None, "prompt": "Hirsch", "modell": "qwen", "size": "1024x1024",
             "width": 1024, "height": 1024, "openai_size": "1024x1024",
             "quality": "medium", "background": "opaque", "seed": 42}
    bild_service.render_local(COMPANY, {"id": "issue-1"}, brief, now=1000.0)
    assert job_state.get("issue-1")["prompt_id"] == "prompt-1"
    assert api.status == {}          # bleibt offen, bis das Bild da ist


def test_collect_done_uploads_and_closes(monkeypatch, tmp_path):
    api = setup(monkeypatch, tmp_path)
    job_state.add("issue-1", "prompt-1", "company-a", now=1000.0)
    monkeypatch.setattr(comfy_client, "poll",
                        lambda pid: ("done", [{"filename": "a.png", "subfolder": "", "type": "output"}]))
    monkeypatch.setattr(comfy_client, "fetch_image", lambda img: b"PNGDATA")
    result = bild_service.collect_one("issue-1", job_state.get("issue-1"), now=1010.0)
    assert result == "done"
    assert api.attachments == [("issue-1", "bild-issue-1.png", 7)]
    assert api.status["issue-1"] == "done"
    assert job_state.get("issue-1") is None


def test_collect_error_cancels_without_retry(monkeypatch, tmp_path):
    api = setup(monkeypatch, tmp_path)
    job_state.add("issue-1", "prompt-1", "company-a", now=1000.0)
    monkeypatch.setattr(comfy_client, "poll", lambda pid: ("error", "UNETLoader: Modell fehlt"))
    result = bild_service.collect_one("issue-1", job_state.get("issue-1"), now=1010.0)
    assert result == "error"
    assert api.status["issue-1"] == "cancelled"
    assert "Modell fehlt" in api.comments[0][1]
    assert job_state.get("issue-1") is None


def test_timeout_retries_once(monkeypatch, tmp_path):
    setup(monkeypatch, tmp_path)
    job_state.add("issue-1", "prompt-1", "company-a", now=0.0)
    monkeypatch.setattr(comfy_client, "poll", lambda pid: ("running", None))
    monkeypatch.setattr(comfy_client, "submit", lambda wf: "prompt-2")
    monkeypatch.setattr(bild_service, "_brief_for_issue", lambda job: {
        "error": None, "prompt": "Hirsch", "modell": "qwen", "size": "1024x1024",
        "width": 1024, "height": 1024, "openai_size": "1024x1024",
        "quality": "medium", "background": "opaque", "seed": 42})
    result = bild_service.collect_one("issue-1", job_state.get("issue-1"), now=999999.0)
    assert result == "timeout"
    job = job_state.get("issue-1")
    assert job["attempts"] == 2
    assert job["prompt_id"] == "prompt-2"


def test_second_timeout_cancels(monkeypatch, tmp_path):
    api = setup(monkeypatch, tmp_path)
    job_state.add("issue-1", "prompt-1", "company-a", now=0.0)
    job_state.bump_attempt("issue-1", "prompt-2", now=0.0)
    monkeypatch.setattr(comfy_client, "poll", lambda pid: ("running", None))
    result = bild_service.collect_one("issue-1", job_state.get("issue-1"), now=999999.0)
    assert result == "error"
    assert api.status["issue-1"] == "cancelled"
    assert job_state.get("issue-1") is None
    assert api.mails


def test_local_daily_limit_blocks_and_comments(monkeypatch, tmp_path):
    api = setup(monkeypatch, tmp_path)
    for _ in range(cost_state.DAILY_LOCAL_LIMIT):
        cost_state.record_local("2026-08-02")
    monkeypatch.setattr(bild_service, "_today", lambda: "2026-08-02")
    brief = {"error": None, "prompt": "Hirsch", "modell": "qwen", "size": "1024x1024",
             "width": 1024, "height": 1024, "openai_size": "1024x1024",
             "quality": "medium", "background": "opaque", "seed": None}
    bild_service.render_local(COMPANY, {"id": "issue-1"}, brief, now=1000.0)
    assert job_state.get("issue-1") is None
    assert api.status["issue-1"] == "cancelled"
    assert "Tageslimit" in api.comments[0][1]


def test_unreachable_alerts_once_after_threshold(monkeypatch, tmp_path):
    api = setup(monkeypatch, tmp_path)
    monkeypatch.setattr(comfy_client, "health", lambda: False)
    monkeypatch.setattr(bild_service, "_waiting_issues", lambda: [("company-a", "issue-1")])
    from config import UNREACHABLE_ALERT_CYCLES
    for _ in range(UNREACHABLE_ALERT_CYCLES):
        bild_service.note_unreachable()
    assert len(api.mails) == 1
    assert len(api.comments) == 1
    bild_service.note_unreachable()          # weitere Zyklen alarmieren nicht erneut
    assert len(api.mails) == 1
```

- [ ] **Step 2: Tests laufen lassen, Fehlschlag bestätigen**

Run: `cd tools/bild-service && /usr/bin/python3 -m pytest test_bild_service.py -q`
Expected: FAIL mit `AttributeError: module 'bild_service' has no attribute 'reset_unreachable_counter'`

- [ ] **Step 3: `bild_service.py` ersetzen**

```python
#!/usr/bin/env python3
import datetime
import fcntl
import os
import random
import sys
import time
import traceback

import comfy_client
import config
import cost_state
import job_state
import paperclip_api as api
import workflow_template as wt
from brief_parser import parse_brief
from openai_image import generate_png

FORMAT_HINT = ("Format:\n"
               "prompt: <Beschreibung>\n"
               "modell: qwen | openai\n"
               "format: 1024x1024\n"
               "seed: 42")

_unreachable_cycles = 0
_unreachable_alerted = False


def _today():
    return datetime.date.today().isoformat()


def reset_unreachable_counter():
    global _unreachable_cycles, _unreachable_alerted
    _unreachable_cycles = 0
    _unreachable_alerted = False


# --- Absenden ------------------------------------------------------------

def render_local(company, issue, brief, now):
    iid = issue["id"]
    if cost_state.remaining_local_today(_today()) <= 0:
        api.add_comment(iid, "⚠️ Tageslimit (%d lokale Bilder) erreicht. "
                             "Morgen erneut versuchen." % config.DAILY_LOCAL_LIMIT)
        api.patch_status(iid, "cancelled")
        return
    seed = brief["seed"] if brief["seed"] is not None else random.randint(1, 2 ** 31 - 1)
    workflow = wt.fill(wt.load_raw("qwen-image"), brief["prompt"], seed,
                       brief["width"], brief["height"])
    try:
        prompt_id = comfy_client.submit(workflow)
    except comfy_client.ComfyError:
        return          # Knoten weg: Auftrag bleibt liegen, naechster Zyklus versucht erneut
    job_state.add(iid, prompt_id, company["id"], now, seed=seed)
    cost_state.record_local(_today())


def render_openai(company, issue, brief):
    iid = issue["id"]
    if cost_state.remaining_today(_today()) <= 0:
        api.add_comment(iid, "⚠️ Tageslimit (%d Bilder) erreicht. "
                             "Morgen erneut versuchen." % config.DAILY_IMAGE_LIMIT)
        api.patch_status(iid, "cancelled")
        return
    month = _today()[:7]
    est = config.COST_ESTIMATE.get(brief["quality"], 0.04)
    if cost_state.monthly_spent(month) + est > config.MONTHLY_BUDGET_USD:
        api.add_comment(iid, "⚠️ Monatsbudget ($%.2f) erreicht — bereits ~$%.2f verbraucht."
                        % (config.MONTHLY_BUDGET_USD, cost_state.monthly_spent(month)))
        api.patch_status(iid, "cancelled")
        return
    openai_brief = dict(brief, size=brief["openai_size"])
    try:
        png = generate_png(openai_brief)
    except Exception as e:
        api.add_comment(iid, "⚠️ OpenAI-Fehler: %s" % e)
        api.patch_status(iid, "cancelled")
        return
    api.upload_attachment(company["id"], iid, "bild-%s.png" % iid[:8], png)
    cost_state.record(_today(), brief["quality"])
    note = ""
    if brief["openai_size"] != brief["size"]:
        note = "\nHinweis: %s kennt die OpenAI-API nicht, gerendert wurde %s." % (
            brief["size"], brief["openai_size"])
    api.add_comment(iid,
                    "✅ Bild erzeugt (gpt-image-1).\nPrompt: %s\n"
                    "Einstellungen: %s, quality=%s, bg=%s\n"
                    "Geschätzte Kosten: ~%.2f USD%s"
                    % (brief["prompt"], brief["openai_size"], brief["quality"],
                       brief["background"], est, note))
    api.patch_status(iid, "done")


def process_new_issue(company, issue, now):
    iid = issue["id"]
    brief = parse_brief(issue.get("description") or issue.get("title", ""))
    if brief["error"]:
        api.add_comment(iid, "⚠️ Bild nicht erzeugt: %s\n%s" % (brief["error"], FORMAT_HINT))
        api.patch_status(iid, "cancelled")
        return
    if brief["modell"] == "openai":
        render_openai(company, issue, brief)
    else:
        render_local(company, issue, brief, now)


# --- Einsammeln ----------------------------------------------------------

def _brief_for_issue(job):
    """Brief eines laufenden Auftrags neu einlesen (fuer den Wiederholversuch)."""
    issue = api.get_issue(job["issue_id"])
    return parse_brief(issue.get("description") or issue.get("title", ""))


def collect_one(issue_id, job, now):
    try:
        status, payload = comfy_client.poll(job["prompt_id"])
    except comfy_client.ComfyError:
        return "running"        # Knoten weg: nichts entscheiden, spaeter erneut

    if status == "done":
        png = comfy_client.fetch_image(payload[0])
        api.upload_attachment(job["company_id"], issue_id,
                              "bild-%s.png" % issue_id[:8], png)
        api.add_comment(issue_id,
                        "✅ Bild erzeugt (Qwen-Image 2512, lokal).\n"
                        "Seed: %s\nDauer: %.0f s"
                        % (job.get("seed", "—"), job_state.age_seconds(job, now)))
        api.patch_status(issue_id, "done")
        job_state.drop(issue_id)
        return "done"

    if status == "error":
        api.add_comment(issue_id, "⚠️ ComfyUI-Fehler: %s" % payload)
        api.patch_status(issue_id, "cancelled")
        job_state.drop(issue_id)
        return "error"

    if job_state.age_seconds(job, now) > config.JOB_TIMEOUT_SEC:
        if int(job.get("attempts", 1)) < 2:
            brief = _brief_for_issue(dict(job, issue_id=issue_id))
            seed = brief["seed"] if brief["seed"] is not None else random.randint(1, 2 ** 31 - 1)
            workflow = wt.fill(wt.load_raw("qwen-image"), brief["prompt"], seed,
                               brief["width"], brief["height"])
            try:
                new_id = comfy_client.submit(workflow)
            except comfy_client.ComfyError:
                return "running"
            job_state.bump_attempt(issue_id, new_id, now)
            return "timeout"
        api.add_comment(issue_id,
                        "⚠️ Render nach zwei Versuchen ohne Ergebnis "
                        "(je über %d s). Auftrag abgebrochen." % config.JOB_TIMEOUT_SEC)
        api.patch_status(issue_id, "cancelled")
        job_state.drop(issue_id)
        api.mail_alarm("[Bilddienst] Render zweimal ohne Ergebnis",
                       "Issue %s, prompt_id %s" % (issue_id, job["prompt_id"]))
        return "error"

    return "running"


# --- Knoten nicht erreichbar --------------------------------------------

def _waiting_issues():
    out = []
    for company in config.COMPANIES:
        for status in config.POLL_STATUSES:
            for issue in api.list_issues(company["id"], status, company["label"]):
                out.append((company["id"], issue["id"]))
    return out


def note_unreachable():
    global _unreachable_cycles, _unreachable_alerted
    _unreachable_cycles += 1
    if _unreachable_cycles < config.UNREACHABLE_ALERT_CYCLES or _unreachable_alerted:
        return
    _unreachable_alerted = True
    waiting = _waiting_issues()
    for _company_id, issue_id in waiting:
        api.add_comment(issue_id,
                        "⚠️ Renderknoten seit über %d Minuten nicht erreichbar. "
                        "Der Auftrag bleibt in der Warteschlange."
                        % config.UNREACHABLE_ALERT_CYCLES)
    api.mail_alarm("[Bilddienst] Renderknoten nicht erreichbar",
                   "ComfyUI auf %s antwortet seit %d Zyklen nicht. "
                   "Wartende Aufträge: %d"
                   % (config.COMFY_BASE, _unreachable_cycles, len(waiting)))


# --- Zyklus --------------------------------------------------------------

def collect_phase(now):
    for issue_id, job in list(job_state.all().items()):
        try:
            collect_one(issue_id, job, now)
        except api.AuthError:
            raise
        except Exception:
            api.mail_alarm("[Bilddienst] Fehler beim Einsammeln", traceback.format_exc())


def submit_phase(now):
    free = config.MAX_INFLIGHT_JOBS - len(job_state.all())
    if free <= 0:
        return
    for company in config.COMPANIES:
        for status in config.POLL_STATUSES:
            for issue in api.list_issues(company["id"], status, company["label"]):
                if job_state.get(issue["id"]):
                    continue
                if free <= 0:
                    return
                try:
                    process_new_issue(company, issue, now)
                    free = config.MAX_INFLIGHT_JOBS - len(job_state.all())
                except api.AuthError:
                    raise
                except Exception:
                    api.mail_alarm("[Bilddienst] Unerwarteter Fehler", traceback.format_exc())


def run_once(now):
    try:
        if not comfy_client.health():
            note_unreachable()
        else:
            reset_unreachable_counter()
        collect_phase(now)
        submit_phase(now)
    except api.AuthError as e:
        api.mail_alarm("[Bilddienst] Paperclip-Token abgelaufen", str(e))
        sys.exit(1)


def main():
    lock_path = os.path.join(os.path.dirname(config.STATE_FILE), "bild-service.lock")
    os.makedirs(os.path.dirname(lock_path), exist_ok=True)
    lock_fd = open(lock_path, "w")
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        sys.exit(0)
    try:
        run_once(time.time())
    finally:
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        lock_fd.close()


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: `paperclip_api.get_issue` ergänzen**

Der Wiederholversuch braucht den Brief erneut. An `tools/bild-service/paperclip_api.py` anfügen:

```python
def get_issue(issue_id):
    return _request("GET", "/api/issues/%s" % issue_id)
```

- [ ] **Step 5: Tests laufen lassen**

Run: `cd tools/bild-service && /usr/bin/python3 -m pytest -q`
Expected: alle grün

- [ ] **Step 6: Commit**

```bash
git add tools/bild-service/bild_service.py tools/bild-service/test_bild_service.py tools/bild-service/paperclip_api.py
git commit -m "feat(bild-service): Poller auf Absenden/Einsammeln umbauen

Ein Render blockiert den 60-Sekunden-Takt nicht mehr. Knoten weg heisst
warten statt abbrechen; Alarm erst nach 30 Zyklen, dann genau einmal."
```

---

### Task 8: Rauchtest, Label-Umbenennung und Inbetriebnahme

**Files:**
- Create: `tools/bild-service/smoke_comfy.py`
- Modify: Agenten-Instruktionen in der Generator-Quelle (`roles/*.role.md`)

**Interfaces:**
- Consumes: alles Vorherige
- Produces: laufender Dienst, der auf `bild`-Label reagiert

- [ ] **Step 1: Rauchtest schreiben**

Create `tools/bild-service/smoke_comfy.py`:

```python
#!/usr/bin/env python3
"""Rauchtest Ende zu Ende gegen den echten Knoten. Kein pytest — manuell.

Aufruf: /usr/bin/python3 smoke_comfy.py
"""
import sys
import time

import comfy_client as cc
import workflow_template as wt

if not cc.health():
    sys.exit("Knoten %s antwortet nicht." % cc.COMFY_BASE)

wf = wt.fill(wt.load_raw("qwen-image"),
             "Ein weisser Hirsch im Morgennebel, fotorealistisch", 42, 1024, 1024)
t0 = time.time()
pid = cc.submit(wf)
print("abgesendet:", pid)

while time.time() - t0 < 300:
    time.sleep(2)
    status, payload = cc.poll(pid)
    if status == "done":
        png = cc.fetch_image(payload[0])
        with open("/tmp/smoke-bild.png", "wb") as f:
            f.write(png)
        print("fertig in %.1f s, %d Bytes -> /tmp/smoke-bild.png"
              % (time.time() - t0, len(png)))
        sys.exit(0)
    if status == "error":
        sys.exit("Fehler: %s" % payload)

sys.exit("Zeitüberschreitung nach 300 s")
```

- [ ] **Step 2: Rauchtest laufen lassen**

Run: `cd tools/bild-service && /usr/bin/python3 smoke_comfy.py`
Expected: `fertig in <Zeit> s, <Bytes> Bytes -> /tmp/smoke-bild.png`. Die Datei öffnen und ansehen — ein Bild, kein Rauschen.

- [ ] **Step 3a: Label-Endpunkt ermitteln**

Der Pfad zum Umbenennen ist nicht geraten, sondern nachgesehen:

```bash
TOKEN=$(/usr/bin/python3 -c "import json;print(json.load(open('$HOME/.paperclip/auth.json'))['credentials']['http://localhost:3100']['token'])")
curl -s "http://localhost:3100/api/companies/9cebf3cf-efe8-4597-a400-f06488900a87/labels" \
  -H "Authorization: Bearer $TOKEN" | /usr/bin/python3 -m json.tool | head -30
```

Expected: Liste mit einem Eintrag `"name": "bild:openai"` und der ID `9433325a-fa6e-43c2-bb09-b077a01843de`. Damit ist bestätigt, dass die IDs aus der Spec stimmen. Schlägt der Aufruf fehl, in `server/src/routes/` nach der Label-Route sehen und den tatsächlichen Pfad verwenden.

- [ ] **Step 3b: Label in allen drei Companies umbenennen**

Run:
```bash
for L in 9433325a-fa6e-43c2-bb09-b077a01843de \
         f8212203-db94-4c20-9922-0078289e874e \
         36ad26e6-4ed8-4ac3-8f43-28c8600a1ab1; do
  curl -s -X PATCH "http://localhost:3100/api/labels/$L" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d '{"name":"bild"}' | head -c 200; echo
done
```
Expected: je eine JSON-Antwort mit `"name":"bild"`

- [ ] **Step 3c: Umbenennung prüfen**

Run:
```bash
curl -s "http://localhost:3100/api/companies/9cebf3cf-efe8-4597-a400-f06488900a87/labels" \
  -H "Authorization: Bearer $TOKEN" | grep -o '"name":"[^"]*"' | grep bild
```
Expected: `"name":"bild"`, kein `bild:openai` mehr

- [ ] **Step 4: Agenten-Instruktionen anpassen**

Alle Stellen finden, die das alte Label oder Briefformat nennen:

```bash
grep -rn "bild:openai" ~/.paperclip/instances/default/companies/*/roles/*.role.md \
  "$HOME/Library/CloudStorage/SynologyDrive-Mac/Claude Code MAC/Paperclip" \
  --include="*.md" 2>/dev/null | grep -v node_modules
```

Jede Fundstelle in der **Generator-Quelle** (`roles/*.role.md`) auf das neue Format umstellen:

```
Bilder bestellst du über einen Subtask mit dem Label `bild`. In die
Beschreibung gehört:

prompt: <was auf dem Bild zu sehen sein soll>
modell: qwen        # Standard, lokal und kostenlos; 'openai' nur in Ausnahmen
format: 1024x1024   # oder 1024x1536, 1536x1024, 1344x768, 768x1344
seed: 42            # optional; der verwendete Seed steht im Abschlusskommentar

Das fertige Bild hängt danach als Anhang am Subtask.
```

**Nicht** `AGENTS.md` bearbeiten — die wird nachts überschrieben.

- [ ] **Step 5: Generator laufen lassen und Ergebnis prüfen**

Run:
```bash
grep -rn "bild" ~/.paperclip/instances/default/companies/*/agents/*/instructions/AGENTS.md | head
```
Expected: das neue Format erscheint in den erzeugten Instruktionen; `bild:openai` kommt nicht mehr vor.

- [ ] **Step 6: Deployen und Dienst neu starten**

Run:
```bash
cd "$HOME/Library/CloudStorage/SynologyDrive-Mac/Claude Code MAC/Paperclip"
./tools/bild-service/deploy.sh
launchctl kickstart -k "gui/$(id -u)/de.whitestag.bild-service"
sleep 70
tail -20 "$HOME/.paperclip/instances/default/state/bild-service.err.log"
```
Expected: keine Traceback-Ausgabe

- [ ] **Step 7: Ende-zu-Ende über Paperclip prüfen**

Ein Testissue mit Label `bild` und dieser Beschreibung anlegen:

```
prompt: Ein weisser Hirsch auf einer Nebelwiese, fotorealistisch
format: 1536x1024
seed: 1234
```

Erwartet: innerhalb von zwei Minuten hängt ein PNG am Issue, der Status steht auf `done`, und der Abschlusskommentar nennt Seed 1234.

- [ ] **Step 8: Live-Kopie gegen Repo abgleichen**

Run:
```bash
diff -r tools/bild-service "$HOME/.paperclip/scripts/bild-service" \
  --exclude=__pycache__ --exclude=.pytest_cache --exclude=deploy.sh --exclude=node
```
Expected: keine Ausgabe

- [ ] **Step 9: Commit**

```bash
git add tools/bild-service/smoke_comfy.py
git commit -m "feat(bild-service): Rauchtest und Inbetriebnahme des lokalen Renderns

Label 'bild:openai' heisst jetzt 'bild', das Modell steht im Brief.
Agenten-Instruktionen in der Generator-Quelle nachgezogen."
```

---

## Nach dem Plan — offene Punkte aus der Spec

Diese gehören **nicht** in die Umsetzung, müssen aber entschieden werden:

1. **Lizenz der Turbo-LoRA** (`Wuli-Qwen-Image-2512-Turbo-LoRA-2steps`) klären, bevor damit Kundenmaterial entsteht. Qwen-Image selbst ist Apache 2.0, die LoRA erbt das nicht automatisch.
2. **10 GB abgebrochener Download** in `~/ComfyUI-Shared/models/.desktop2-downloads/` löschen oder fertigladen.
3. **Video-Spec** — LTX und Hunyuan liegen auf dem Mac Studio, nicht auf dem MacBook.
