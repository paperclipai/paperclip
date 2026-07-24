# LLM-Resident-Platzierung — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein deterministisch resident gehaltenes LLM-Set über Studio/MacBook/RTX mit self-healing Wärter, sodass kein JIT-Load/Eviction mehr passiert und kein Agent-Primär/Fallback ins Leere läuft.

**Architecture:** Eine deklarative `resident-set.json` als einzige Wahrheitsquelle; ein launchd-Wärter (python stdlib) liest `lms ps --json` + `lms link status --json`, difft gegen das Soll und lädt Fehlendes gerätegezielt nach; ein DB-Audit stellt sicher, dass jeder Agent-Modellverweis im Set liegt; zuletzt JIT-aus. Reine Logik (Parsen, Diff, Audit-Check) ist von den Seiteneffekten (lms-Aufrufe, Postgres, PATCH) getrennt und TDD-getestet.

**Tech Stack:** Python 3 (stdlib only), `lms` CLI, LM Studio HTTP-Server :1234, Postgres :54329 (psql), Paperclip API :3100, launchd.

## Global Constraints

- Python **stdlib only** — keine pip-Abhängigkeiten (wie alle bestehenden Wächter).
- Entwicklung im Repo unter `tools/model-warden/`; Deploy nach `~/.paperclip/scripts/model-warden/`.
- Seiteneffekt-freie Kernlogik dependency-injected testen (JSON-Strings/Dicts rein, keine echten `lms`/DB-Aufrufe im Test).
- `lms load` braucht den **kurzen modelKey**, nicht den Repo-Pfad; immer mit `-y`.
- Geräte-IDs (Stand 2026-07-24, zur Laufzeit via `lms link status --json` auflösen, NICHT hartkodieren): Studio `MacStudioM4Max128`, MacBook `MacbookM5Mx128`, RTX `RTX Pro 6000`.
- **Reihenfolge zwingend:** Set laden + RAM messen → Agent-Audit → Wärter scharf → **zuletzt** JIT aus.
- Commit-Sprache Deutsch, Format wie im Repo (`feat(model-warden): …`).

---

## Resident-Set (Sollwerte, Referenz für Task 1)

| device | ps_key (in `lms ps`) | load_key (für `lms load`) | ctx | parallel | when |
|---|---|---|---|---|---|
| studio | `gemma-4-31b-it-mlx` | `gemma-4-31b-it-mlx` | 65000 | 4 | always |
| studio | `google/gemma-4-12b` | `google/gemma-4-12b` | 65024 | 4 | always |
| studio | `qwen/qwen3-coder-30b` | `qwen/qwen3-coder-30b` | 90000 | 4 | always |
| studio | `openbiollm-llama3-8b.gguf` | `openbiollm-llama3-8b.gguf` | 8192 | 4 | always |
| studio | `text-embedding-bge-m3` | `text-embedding-bge-m3` | — | — | always |
| macbook | `qwen3.6-35b-a3b-mlx` | `qwen3.6-35b-a3b-mlx` | 98304 | 4 | always |
| macbook | `qwen/qwen3-coder-next` | `qwen/qwen3-coder-next` | 65000 | 4 | always |
| rtx | `qwen/qwen3-coder-next` | `qwen/qwen3-coder-next` | 131328 | 4 | day-only |
| rtx | `google/gemma-4-12b-qat` | `google/gemma-4-12b-qat` | 65024 | 4 | day-only |

`coder-next` erscheint bewusst zweimal (macbook@65k, rtx@131k) — Schlüssel ist `(load_key, device)`.

---

## File Structure

- Create `tools/model-warden/resident-set.json` — Soll-Konfiguration
- Create `tools/model-warden/config.py` — Set laden + validieren
- Create `tools/model-warden/lms_state.py` — `lms ps`/`link status`-JSON → Ist-Zustand + Geräteauflösung
- Create `tools/model-warden/reconcile.py` — reine Diff-Logik Soll vs. Ist → Aktionsliste
- Create `tools/model-warden/loader.py` — baut `lms`-Kommandos aus Aktionen (argv-Listen)
- Create `tools/model-warden/warden.py` — Hauptlauf: sammeln → diffen → laden → Fehler-Issue
- Create `tools/model-warden/audit_agents.py` — DB-Audit der `adapter_config`-Modellverweise
- Create `tools/model-warden/test_config.py`, `test_lms_state.py`, `test_reconcile.py`, `test_loader.py`, `test_audit_agents.py`
- Create `de.whitestag.model-warden.plist` (Deploy nach `~/Library/LaunchAgents/`)
- Modify `~/Desktop/n8n.sh` — Preload-Block ruft nur noch den Wärter
- Modify `~/.lmstudio/.internal/http-server-config.json` — `justInTimeModelLoading: false`

---

### Task 1: Resident-Set-Konfiguration + Validierung

**Files:**
- Create: `tools/model-warden/resident-set.json`
- Create: `tools/model-warden/config.py`
- Test: `tools/model-warden/test_config.py`

**Interfaces:**
- Produces: `load_resident_set(path: str) -> list[dict]` — validierte Einträge, jeder mit Keys `device, ps_key, load_key, ctx, parallel, when`. `ctx`/`parallel` dürfen `None` sein (Embeddings). Wirft `ValueError` bei fehlenden Pflichtfeldern / unbekanntem `device`/`when`.

- [ ] **Step 1: `resident-set.json` schreiben**

```json
{
  "devices": ["studio", "macbook", "rtx"],
  "models": [
    {"device": "studio",  "ps_key": "gemma-4-31b-it-mlx",        "load_key": "gemma-4-31b-it-mlx",        "ctx": 65000, "parallel": 4, "when": "always"},
    {"device": "studio",  "ps_key": "google/gemma-4-12b",        "load_key": "google/gemma-4-12b",        "ctx": 65024, "parallel": 4, "when": "always"},
    {"device": "studio",  "ps_key": "qwen/qwen3-coder-30b",      "load_key": "qwen/qwen3-coder-30b",      "ctx": 90000, "parallel": 4, "when": "always"},
    {"device": "studio",  "ps_key": "openbiollm-llama3-8b.gguf", "load_key": "openbiollm-llama3-8b.gguf", "ctx": 8192,  "parallel": 4, "when": "always"},
    {"device": "studio",  "ps_key": "text-embedding-bge-m3",     "load_key": "text-embedding-bge-m3",     "ctx": null,  "parallel": null, "when": "always"},
    {"device": "macbook", "ps_key": "qwen3.6-35b-a3b-mlx",       "load_key": "qwen3.6-35b-a3b-mlx",       "ctx": 98304, "parallel": 4, "when": "always"},
    {"device": "macbook", "ps_key": "qwen/qwen3-coder-next",     "load_key": "qwen/qwen3-coder-next",     "ctx": 65000, "parallel": 4, "when": "always"},
    {"device": "rtx",     "ps_key": "qwen/qwen3-coder-next",     "load_key": "qwen/qwen3-coder-next",     "ctx": 131328, "parallel": 4, "when": "day-only"},
    {"device": "rtx",     "ps_key": "google/gemma-4-12b-qat",    "load_key": "google/gemma-4-12b-qat",    "ctx": 65024, "parallel": 4, "when": "day-only"}
  ]
}
```

- [ ] **Step 2: Failing Test schreiben**

```python
# test_config.py
import json, os, tempfile, pytest
from config import load_resident_set

HERE = os.path.dirname(__file__)

def test_loads_real_set():
    entries = load_resident_set(os.path.join(HERE, "resident-set.json"))
    assert len(entries) == 9
    keys = {(e["load_key"], e["device"]) for e in entries}
    assert ("qwen/qwen3-coder-next", "macbook") in keys
    assert ("qwen/qwen3-coder-next", "rtx") in keys

def test_rejects_unknown_device(tmp_path):
    p = tmp_path / "bad.json"
    p.write_text(json.dumps({"devices": ["studio"], "models": [
        {"device": "moon", "ps_key": "x", "load_key": "x", "ctx": 10, "parallel": 4, "when": "always"}]}))
    with pytest.raises(ValueError):
        load_resident_set(str(p))

def test_rejects_missing_field(tmp_path):
    p = tmp_path / "bad.json"
    p.write_text(json.dumps({"devices": ["studio"], "models": [
        {"device": "studio", "load_key": "x", "ctx": 10, "parallel": 4, "when": "always"}]}))
    with pytest.raises(ValueError):
        load_resident_set(str(p))
```

- [ ] **Step 3: Test rot sehen**

Run: `cd tools/model-warden && python3 -m pytest test_config.py -v`
Expected: FAIL (`ModuleNotFoundError: config`)

- [ ] **Step 4: `config.py` implementieren**

```python
# config.py
import json

_VALID_WHEN = {"always", "day-only"}
_REQUIRED = {"device", "ps_key", "load_key", "ctx", "parallel", "when"}

def load_resident_set(path):
    with open(path) as fh:
        data = json.load(fh)
    devices = set(data.get("devices", []))
    out = []
    for m in data.get("models", []):
        missing = _REQUIRED - m.keys()
        if missing:
            raise ValueError(f"Eintrag fehlt Felder {missing}: {m}")
        if m["device"] not in devices:
            raise ValueError(f"Unbekanntes device {m['device']!r}")
        if m["when"] not in _VALID_WHEN:
            raise ValueError(f"Unbekanntes when {m['when']!r}")
        out.append(dict(m))
    return out
```

- [ ] **Step 5: Test grün sehen**

Run: `cd tools/model-warden && python3 -m pytest test_config.py -v`
Expected: PASS (3 passed)

- [ ] **Step 6: Commit**

```bash
git add tools/model-warden/resident-set.json tools/model-warden/config.py tools/model-warden/test_config.py
git commit -m "feat(model-warden): resident-set.json + Validierung"
```

---

### Task 2: Ist-Zustand aus `lms`-JSON (`lms_state.py`)

**Files:**
- Create: `tools/model-warden/lms_state.py`
- Test: `tools/model-warden/test_lms_state.py`

**Interfaces:**
- Consumes: nichts aus früheren Tasks.
- Produces:
  - `resolve_devices(link_json: str) -> dict` → `{"studio": <id>, "macbook": <id>|None, "rtx": <id>|None, "_self": <id>}`. Symbolische Namen aus `deviceName` (Match: `"Studio"`→studio, `"acbook"`→macbook, `"RTX"`→rtx). Nicht verbundene Peers fehlen (→ None).
  - `parse_loaded(ps_json: str) -> list[dict]` → je geladenem Modell `{"model_key": str, "ctx": int|None, "device_id": str|None}` (`device_id=None` = lokal/Studio).
  - `available_devices(link_json: str) -> set[str]` → symbolische Namen der erreichbaren Geräte (immer inkl. `studio`).

- [ ] **Step 1: Failing Test mit echten Fixtures**

```python
# test_lms_state.py
from lms_state import resolve_devices, parse_loaded, available_devices

LINK = '{"deviceName":"MacStudioM4Max128","deviceIdentifier":"S1","peers":[' \
       '{"deviceName":"MacbookM5Mx128","deviceIdentifier":"M1"},' \
       '{"deviceName":"RTX Pro 6000","deviceIdentifier":"R1"}]}'
LINK_NIGHT = '{"deviceName":"MacStudioM4Max128","deviceIdentifier":"S1","peers":[' \
             '{"deviceName":"MacbookM5Mx128","deviceIdentifier":"M1"}]}'
PS = '[{"modelKey":"gemma-4-31b-it-mlx","contextLength":65000,"deviceIdentifier":null},' \
     '{"modelKey":"qwen/qwen3-coder-next","contextLength":131328,"deviceIdentifier":"R1"}]'

def test_resolve_devices():
    d = resolve_devices(LINK)
    assert d["studio"] == "S1" and d["macbook"] == "M1" and d["rtx"] == "R1"

def test_available_excludes_absent_rtx():
    assert available_devices(LINK_NIGHT) == {"studio", "macbook"}
    assert "rtx" in available_devices(LINK)

def test_parse_loaded():
    loaded = parse_loaded(PS)
    assert {"model_key": "gemma-4-31b-it-mlx", "ctx": 65000, "device_id": None} in loaded
    assert {"model_key": "qwen/qwen3-coder-next", "ctx": 131328, "device_id": "R1"} in loaded
```

- [ ] **Step 2: Test rot sehen**

Run: `cd tools/model-warden && python3 -m pytest test_lms_state.py -v`
Expected: FAIL (`ModuleNotFoundError: lms_state`)

- [ ] **Step 3: `lms_state.py` implementieren**

```python
# lms_state.py
import json

def _symbol(device_name):
    n = device_name or ""
    if "Studio" in n: return "studio"
    if "acbook" in n: return "macbook"
    if "RTX" in n:    return "rtx"
    return None

def resolve_devices(link_json):
    d = json.loads(link_json)
    out = {"studio": None, "macbook": None, "rtx": None, "_self": d.get("deviceIdentifier")}
    for entry in [d] + list(d.get("peers", [])):
        sym = _symbol(entry.get("deviceName"))
        if sym:
            out[sym] = entry.get("deviceIdentifier")
    return out

def available_devices(link_json):
    dev = resolve_devices(link_json)
    return {sym for sym in ("studio", "macbook", "rtx") if dev.get(sym)}

def parse_loaded(ps_json):
    raw = json.loads(ps_json)
    models = raw if isinstance(raw, list) else raw.get("models", [])
    out = []
    for m in models:
        out.append({
            "model_key": m.get("modelKey"),
            "ctx": m.get("contextLength"),
            "device_id": m.get("deviceIdentifier"),
        })
    return out
```

- [ ] **Step 4: Test grün sehen**

Run: `cd tools/model-warden && python3 -m pytest test_lms_state.py -v`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add tools/model-warden/lms_state.py tools/model-warden/test_lms_state.py
git commit -m "feat(model-warden): lms ps/link-status Parser + Geraeteaufloesung"
```

---

### Task 3: Diff-Logik Soll vs. Ist (`reconcile.py`)

**Files:**
- Create: `tools/model-warden/reconcile.py`
- Test: `tools/model-warden/test_reconcile.py`

**Interfaces:**
- Consumes: Set-Einträge (Task 1), `parse_loaded`-Ausgabe + Geräte-Map (Task 2).
- Produces: `plan_actions(desired, loaded, devices, available) -> list[dict]`
  - `desired`: Liste aus `load_resident_set`.
  - `loaded`: Liste aus `parse_loaded`.
  - `devices`: `resolve_devices`-Map (symbol→id).
  - `available`: Set erreichbarer Symbole.
  - Rückgabe: Aktionen `{"action": "load"|"ctx_mismatch", "entry": <desired-entry>, "reason": str}`. `load` für fehlende (auf verfügbarem Gerät); `ctx_mismatch` (nur Warnung, kein Reload) für vorhanden-aber-falsche-ctx; `day-only` auf nicht verfügbarem Gerät → keine Aktion (still).

- [ ] **Step 1: Failing Test**

```python
# test_reconcile.py
from reconcile import plan_actions

DEVICES = {"studio": "S1", "macbook": "M1", "rtx": "R1"}
def entry(dev, key, ctx, when="always"):
    return {"device": dev, "ps_key": key, "load_key": key, "ctx": ctx, "parallel": 4, "when": when}

def test_missing_model_yields_load():
    desired = [entry("studio", "gemma-4-31b-it-mlx", 65000)]
    actions = plan_actions(desired, [], DEVICES, {"studio", "macbook", "rtx"})
    assert [a["action"] for a in actions] == ["load"]

def test_present_correct_yields_nothing():
    desired = [entry("studio", "gemma-4-31b-it-mlx", 65000)]
    loaded = [{"model_key": "gemma-4-31b-it-mlx", "ctx": 65000, "device_id": None}]
    assert plan_actions(desired, loaded, DEVICES, {"studio"}) == []

def test_wrong_ctx_yields_mismatch_not_load():
    desired = [entry("studio", "gemma-4-31b-it-mlx", 65000)]
    loaded = [{"model_key": "gemma-4-31b-it-mlx", "ctx": 40000, "device_id": None}]
    actions = plan_actions(desired, loaded, DEVICES, {"studio"})
    assert [a["action"] for a in actions] == ["ctx_mismatch"]

def test_dayonly_on_absent_device_skipped():
    desired = [entry("rtx", "google/gemma-4-12b-qat", 65024, when="day-only")]
    assert plan_actions(desired, [], DEVICES, {"studio", "macbook"}) == []

def test_dayonly_present_on_available_device_ok():
    desired = [entry("rtx", "qwen/qwen3-coder-next", 131328, when="day-only")]
    loaded = [{"model_key": "qwen/qwen3-coder-next", "ctx": 131328, "device_id": "R1"}]
    assert plan_actions(desired, loaded, DEVICES, {"studio", "macbook", "rtx"}) == []

def test_same_model_two_devices_independent():
    desired = [entry("macbook", "qwen/qwen3-coder-next", 65000),
               entry("rtx", "qwen/qwen3-coder-next", 131328, when="day-only")]
    loaded = [{"model_key": "qwen/qwen3-coder-next", "ctx": 131328, "device_id": "R1"}]
    actions = plan_actions(desired, loaded, DEVICES, {"studio", "macbook", "rtx"})
    # macbook-Instanz fehlt -> genau ein load
    assert [ (a["action"], a["entry"]["device"]) for a in actions ] == [("load", "macbook")]
```

- [ ] **Step 2: Test rot sehen**

Run: `cd tools/model-warden && python3 -m pytest test_reconcile.py -v`
Expected: FAIL (`ModuleNotFoundError: reconcile`)

- [ ] **Step 3: `reconcile.py` implementieren**

```python
# reconcile.py
CTX_TOLERANCE = 512  # kleine Abweichungen (Rundung LM Studio) ignorieren

def _is_loaded_on(entry, loaded, device_id):
    for m in loaded:
        if m["model_key"] != entry["ps_key"]:
            continue
        # device_id None (lokal/Studio) matcht das Studio-Gerät
        same_device = (m["device_id"] == device_id) or (m["device_id"] is None and device_id is not None and entry["device"] == "studio")
        if same_device or m["device_id"] == device_id:
            return m
    return None

def plan_actions(desired, loaded, devices, available):
    actions = []
    for entry in desired:
        dev_sym = entry["device"]
        if dev_sym not in available:
            continue  # day-only auf abwesendem Geraet: still ueberspringen
        device_id = devices.get(dev_sym)
        match = None
        for m in loaded:
            if m["model_key"] != entry["ps_key"]:
                continue
            m_is_studio = m["device_id"] is None
            if (dev_sym == "studio" and m_is_studio) or (m["device_id"] == device_id):
                match = m
                break
        if match is None:
            actions.append({"action": "load", "entry": entry, "reason": "fehlt"})
        elif entry["ctx"] is not None and match["ctx"] is not None and abs(match["ctx"] - entry["ctx"]) > CTX_TOLERANCE:
            actions.append({"action": "ctx_mismatch", "entry": entry,
                            "reason": f"ctx {match['ctx']} != soll {entry['ctx']}"})
    return actions
```

- [ ] **Step 4: Test grün sehen**

Run: `cd tools/model-warden && python3 -m pytest test_reconcile.py -v`
Expected: PASS (6 passed)

- [ ] **Step 5: Commit**

```bash
git add tools/model-warden/reconcile.py tools/model-warden/test_reconcile.py
git commit -m "feat(model-warden): Diff-Logik Soll vs. Ist (load/ctx_mismatch/day-only-skip)"
```

---

### Task 4: `lms`-Kommandobau (`loader.py`)

**Files:**
- Create: `tools/model-warden/loader.py`
- Test: `tools/model-warden/test_loader.py`

**Interfaces:**
- Consumes: eine `load`-Aktion (Task 3) + Geräte-Map (Task 2).
- Produces:
  - `set_preferred_cmd(device_id: str) -> list[str]` → argv für `lms link set-preferred-device`.
  - `load_cmd(entry: dict) -> list[str]` → argv für `lms load` inkl. `-c`, `--parallel`, `-y` (ctx/parallel weggelassen wenn `None`).

- [ ] **Step 1: Failing Test**

```python
# test_loader.py
from loader import set_preferred_cmd, load_cmd

def test_set_preferred():
    assert set_preferred_cmd("R1") == ["lms", "link", "set-preferred-device", "R1"]

def test_load_cmd_full():
    e = {"load_key": "qwen/qwen3-coder-next", "ctx": 65000, "parallel": 4}
    assert load_cmd(e) == ["lms", "load", "qwen/qwen3-coder-next", "-c", "65000", "--parallel", "4", "-y"]

def test_load_cmd_embeddings_no_ctx():
    e = {"load_key": "text-embedding-bge-m3", "ctx": None, "parallel": None}
    assert load_cmd(e) == ["lms", "load", "text-embedding-bge-m3", "-y"]
```

- [ ] **Step 2: Test rot sehen**

Run: `cd tools/model-warden && python3 -m pytest test_loader.py -v`
Expected: FAIL (`ModuleNotFoundError: loader`)

- [ ] **Step 3: `loader.py` implementieren**

```python
# loader.py
def set_preferred_cmd(device_id):
    return ["lms", "link", "set-preferred-device", device_id]

def load_cmd(entry):
    cmd = ["lms", "load", entry["load_key"]]
    if entry.get("ctx") is not None:
        cmd += ["-c", str(entry["ctx"])]
    if entry.get("parallel") is not None:
        cmd += ["--parallel", str(entry["parallel"])]
    cmd.append("-y")
    return cmd
```

- [ ] **Step 4: Test grün sehen**

Run: `cd tools/model-warden && python3 -m pytest test_loader.py -v`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add tools/model-warden/loader.py tools/model-warden/test_loader.py
git commit -m "feat(model-warden): lms-Kommandobau (set-preferred + load)"
```

---

### Task 5: Hauptlauf mit Fehler-Issue (`warden.py`)

**Files:**
- Create: `tools/model-warden/warden.py`
- Test: `tools/model-warden/test_warden.py`

**Interfaces:**
- Consumes: alle vorigen Module + `~/.paperclip/scripts/paperclip_client.py` (`load_token`, `create_issue`).
- Produces:
  - `run(run_cmd, get_link_json, get_ps_json, set_path, notify) -> dict` — dependency-injected Hauptlauf. `run_cmd(argv)->(rc:int, out:str)`; `get_link_json()/get_ps_json()->str`; `notify(title, body)` bei Fehler. Rückgabe `{"loaded": [...], "warnings": [...], "failures": [...]}`.
  - `main()` — verdrahtet echte `subprocess`-/`lms`-Aufrufe + `paperclip_client`.

- [ ] **Step 1: Failing Test (injected, keine echten lms-Calls)**

```python
# test_warden.py
import os
from warden import run

HERE = os.path.dirname(__file__)
LINK = '{"deviceName":"MacStudioM4Max128","deviceIdentifier":"S1","peers":[{"deviceName":"MacbookM5Mx128","deviceIdentifier":"M1"}]}'

def make_run_cmd(calls, fail_keys=()):
    def run_cmd(argv):
        calls.append(argv)
        if argv[:2] == ["lms", "load"] and argv[2] in fail_keys:
            return (1, "insufficient system resources")
        return (0, "OK")
    return run_cmd

def test_loads_missing_and_skips_absent_rtx():
    calls = []
    ps = "[]"  # nichts geladen
    notified = []
    res = run(make_run_cmd(calls), lambda: LINK, lambda: ps,
              os.path.join(HERE, "resident-set.json"),
              lambda t, b: notified.append((t, b)))
    loaded_keys = {c[2] for c in calls if c[:2] == ["lms", "load"]}
    # studio+macbook always-Modelle geladen, RTX (day-only) NICHT (abwesend)
    assert "gemma-4-31b-it-mlx" in loaded_keys
    assert "qwen3.6-35b-a3b-mlx" in loaded_keys
    assert "google/gemma-4-12b-qat" not in loaded_keys
    assert notified == []

def test_failure_triggers_notify():
    calls = []
    notified = []
    res = run(make_run_cmd(calls, fail_keys={"gemma-4-31b-it-mlx"}),
              lambda: LINK, lambda: "[]",
              os.path.join(HERE, "resident-set.json"),
              lambda t, b: notified.append((t, b)))
    assert res["failures"]
    assert notified and "gemma-4-31b-it-mlx" in notified[0][1]
```

- [ ] **Step 2: Test rot sehen**

Run: `cd tools/model-warden && python3 -m pytest test_warden.py -v`
Expected: FAIL (`ModuleNotFoundError: warden`)

- [ ] **Step 3: `warden.py` implementieren**

```python
# warden.py
import json, os, subprocess, sys
from config import load_resident_set
from lms_state import resolve_devices, parse_loaded, available_devices
from reconcile import plan_actions
from loader import set_preferred_cmd, load_cmd

def run(run_cmd, get_link_json, get_ps_json, set_path, notify):
    desired = load_resident_set(set_path)
    link_json = get_link_json()
    devices = resolve_devices(link_json)
    avail = available_devices(link_json)
    loaded = parse_loaded(get_ps_json())
    actions = plan_actions(desired, loaded, devices, avail)

    result = {"loaded": [], "warnings": [], "failures": []}
    for a in actions:
        entry = a["entry"]
        if a["action"] == "ctx_mismatch":
            result["warnings"].append(f"{entry['load_key']}@{entry['device']}: {a['reason']}")
            continue
        device_id = devices.get(entry["device"])
        if device_id:
            run_cmd(set_preferred_cmd(device_id))
        rc, out = run_cmd(load_cmd(entry))
        if rc == 0:
            result["loaded"].append(f"{entry['load_key']}@{entry['device']}")
        else:
            result["failures"].append(f"{entry['load_key']}@{entry['device']}: {out.strip()[:200]}")
    if result["failures"]:
        notify("Modell-Wärter: Laden fehlgeschlagen",
               "Folgende Resident-Modelle konnten nicht geladen werden:\n\n- "
               + "\n- ".join(result["failures"]))
    return result

def _sh(argv):
    p = subprocess.run(argv, capture_output=True, text=True)
    return (p.returncode, (p.stdout or "") + (p.stderr or ""))

def main():
    lms = os.path.expanduser("~/.lmstudio/bin/lms")
    def run_cmd(argv):
        return _sh([lms] + argv[1:])  # argv[0]=="lms" -> echten Pfad einsetzen
    def link_json():
        return _sh([lms, "link", "status", "--json"])[1]
    def ps_json():
        return _sh([lms, "ps", "--json"])[1]
    sys.path.insert(0, os.path.expanduser("~/.paperclip/scripts"))
    import paperclip_client as pc
    WHITESTAG_COMPANY = "9cebf3cf-efe8-4597-a400-f06488900a87"
    CTO_AGENT = None  # optional: an CTO haengen; sonst None
    def notify(title, body):
        token = pc.load_token()
        if token:
            pc.create_issue(pc.DEFAULT_BASE, token, WHITESTAG_COMPANY,
                            title=title, description=body,
                            assignee_agent_id=CTO_AGENT, priority="high")
    set_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "resident-set.json")
    res = run(run_cmd, link_json, ps_json, set_path, notify)
    print(json.dumps(res, ensure_ascii=False))

if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Test grün sehen**

Run: `cd tools/model-warden && python3 -m pytest test_warden.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Volle Suite grün**

Run: `cd tools/model-warden && python3 -m pytest -v`
Expected: PASS (alle Tasks 1–5)

- [ ] **Step 6: Commit**

```bash
git add tools/model-warden/warden.py tools/model-warden/test_warden.py
git commit -m "feat(model-warden): Hauptlauf mit Fehler-Issue (dependency-injected)"
```

---

### Task 6: Empirische RAM-Messung + LM-Link-Routing-Verifikation

**Files:** keine (Verifikationstask; Ergebnis als Kommentar in die Spec/Plan-PR).

**Interfaces:** liefert Go/No-Go für Task 9 (JIT-aus). KEIN Code-Commit.

- [ ] **Step 1: MacBook-RAM-Schätzung ohne Laden**

Run (Studio, `lms` steuert Peers):
```bash
export PATH="$HOME/.lmstudio/bin:$PATH"
lms link set-preferred-device e2d3747e7267164e7b49a6d655d3813a   # MacBook (ID zur Laufzeit via 'lms link status --json' prüfen)
lms load qwen3.6-35b-a3b-mlx  -c 98304 --parallel 4 --estimate-only
lms load qwen/qwen3-coder-next -c 65000 --parallel 4 --estimate-only
```
Expected: zwei Schätzwerte; Summe + laufende MacBook-Grundlast < ~115 GB. Notieren.

- [ ] **Step 2: Real laden + messen**

```bash
lms load qwen3.6-35b-a3b-mlx  -c 98304 --parallel 4 -y
lms load qwen/qwen3-coder-next -c 65000 --parallel 4 -y
lms ps   # beide auf MacbookM5Mx128, status idle?
```
Expected: beide resident auf dem MacBook, kein „insufficient system resources".

- [ ] **Step 3: LM-Link-Routing verifizieren (Kern-Annahme der Coder-Kette)**

```bash
# coder-next auf RTX laden (Tag), dann RTX-Instanz stoppen simulieren:
# Anfrage an Modellnamen stellen und Ziel-Device prüfen.
curl -s http://127.0.0.1:1234/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"qwen/qwen3-coder-next","max_tokens":5,"messages":[{"role":"user","content":"hi"}]}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('model'))"
```
Expected: Antwort kommt (egal welche Instanz). **Falls** LM Link geräte-pinnt und bei RTX-aus NICHT auf die MacBook-Instanz ausweicht: in Task 8 vermerken, dass die Coder-Agenten zusätzlich `fallbackModel=qwen/qwen3-coder-30b` behalten (tun sie bereits) — dann ist die Kette auch ohne Auto-Routing gedeckt.

- [ ] **Step 4: Ergebnis dokumentieren**

Messwerte + Routing-Befund als Kommentar an den PR / in die Spec (Abschnitt „Risiken") schreiben. Entscheidung Go/No-Go für JIT-aus (Task 9) festhalten.

---

### Task 7: Agent-Config-Audit + Fixes (`audit_agents.py`)

**Files:**
- Create: `tools/model-warden/audit_agents.py`
- Test: `tools/model-warden/test_audit_agents.py`

**Interfaces:**
- Consumes: `resident-set.json` (Task 1) für die erlaubte Modell-Menge.
- Produces:
  - `resident_model_keys(desired) -> set[str]` → alle `load_key`/`ps_key` + Cloud-Freibrief-Präfix `claude-` (Cloud-Modelle sind nie „missing").
  - `violations(adapter_config: dict, allowed: set[str]) -> list[str]` → Liste der Felder (`model`/`fallbackModel`/`modelProfiles.cheap.adapterConfig.model`), die auf ein Modell außerhalb `allowed` zeigen. Leere Strings/None werden ignoriert. `defaultModel` wird ebenfalls geprüft.
  - `main(--report|--fix)` — liest `agents` aus Postgres (:54329), druckt Audit-Tabelle; mit `--fix` PATCHt Self-Fallbacks/mistral-Reste (siehe Mapping unten) via `PATCH /api/agents/:id`.

- [ ] **Step 1: Failing Test (reine Prüf-Logik)**

```python
# test_audit_agents.py
import os
from config import load_resident_set
from audit_agents import resident_model_keys, violations

HERE = os.path.dirname(__file__)
ALLOWED = resident_model_keys(load_resident_set(os.path.join(HERE, "resident-set.json")))

def test_allowed_contains_set_and_cloud():
    assert "gemma-4-31b-it-mlx" in ALLOWED
    assert "qwen/qwen3-coder-next" in ALLOWED

def test_clean_config_no_violations():
    cfg = {"model": "gemma-4-31b-it-mlx", "fallbackModel": "google/gemma-4-12b",
           "defaultModel": "gemma-4-31b-it-mlx"}
    assert violations(cfg, ALLOWED) == []

def test_cloud_model_ignored():
    cfg = {"model": "claude-sonnet-4-6", "fallbackModel": ""}
    assert violations(cfg, ALLOWED) == []

def test_mistral_flagged():
    cfg = {"model": "mistral-small-3.2-24b-instruct-2506-mlx",
           "fallbackModel": "google/gemma-4-12b", "defaultModel": "gemma-4-31b-it-mlx"}
    v = violations(cfg, ALLOWED)
    assert any("model" == f.split(":")[0] for f in v)

def test_cheap_profile_checked():
    cfg = {"model": "gemma-4-31b-it-mlx", "fallbackModel": "google/gemma-4-12b",
           "modelProfiles": {"cheap": {"adapterConfig": {"model": "mistral-small-3.2-24b-instruct-2506-mlx"}}}}
    assert violations(cfg, ALLOWED)
```

- [ ] **Step 2: Test rot sehen**

Run: `cd tools/model-warden && python3 -m pytest test_audit_agents.py -v`
Expected: FAIL (`ModuleNotFoundError: audit_agents`)

- [ ] **Step 3: `audit_agents.py` implementieren (Prüf-Kern zuerst)**

```python
# audit_agents.py
import json, os, subprocess, sys

def resident_model_keys(desired):
    keys = set()
    for e in desired:
        keys.add(e["load_key"]); keys.add(e["ps_key"])
    return keys

def _is_allowed(name, allowed):
    if not name:
        return True
    if name.startswith("claude-"):  # Cloud, nie missing
        return True
    return name in allowed

def violations(adapter_config, allowed):
    out = []
    for field in ("model", "fallbackModel", "defaultModel"):
        name = adapter_config.get(field)
        if not _is_allowed(name, allowed):
            out.append(f"{field}: {name}")
    cheap = (((adapter_config.get("modelProfiles") or {}).get("cheap") or {}).get("adapterConfig") or {}).get("model")
    if not _is_allowed(cheap, allowed):
        out.append(f"cheap.model: {cheap}")
    return out

# --- DB/PATCH-Schicht (dünn, nicht unit-getestet) ---
DB = ["psql", "-h", "127.0.0.1", "-p", "54329", "-U", "paperclip", "-d", "paperclip", "-tAc"]

def _fetch_agents():
    env = dict(os.environ, PGPASSWORD="paperclip")
    q = "select id, name, adapter_config from agents where adapter_config is not null;"
    out = subprocess.run(DB + [q], capture_output=True, text=True, env=env).stdout
    rows = []
    for line in out.splitlines():
        parts = line.split("|", 2)
        if len(parts) == 3:
            try:
                rows.append((parts[0], parts[1], json.loads(parts[2])))
            except ValueError:
                pass
    return rows

def main():
    from config import load_resident_set
    here = os.path.dirname(os.path.abspath(__file__))
    allowed = resident_model_keys(load_resident_set(os.path.join(here, "resident-set.json")))
    bad = []
    for aid, name, cfg in _fetch_agents():
        v = violations(cfg, allowed)
        if v:
            bad.append((aid, name, v))
    for aid, name, v in bad:
        print(f"[VERLETZUNG] {name} ({aid}): {', '.join(v)}")
    print(f"\n{len(bad)} Agenten mit Verweis außerhalb des Resident-Sets.")
    # --fix bewusst manuell/kuratiert (siehe Plan Step 5) — kein Blind-PATCH.

if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Test grün sehen**

Run: `cd tools/model-warden && python3 -m pytest test_audit_agents.py -v`
Expected: PASS (5 passed)

- [ ] **Step 5: Audit real laufen lassen + kuratiert fixen**

Run: `cd tools/model-warden && python3 audit_agents.py`
Expected: Liste der Verletzer (mind. „Office & Admin" mit `model: mistral-…`).

Fixe je Verletzer gezielt via API (adapterConfig-PATCH merged; **nicht** `/companies/:cid/agents/:id`):
```bash
# Beispiel Self-Fallback -> gemma-4-12b:
curl -s -X PATCH http://localhost:3100/api/agents/<AGENT_ID> \
  -H "Authorization: Bearer $(python3 -c 'import sys;sys.path.insert(0,"/Users/walterschoenenbroecher.de/.paperclip/scripts");import paperclip_client as pc;print(pc.load_token())')" \
  -H 'Content-Type: application/json' \
  -d '{"adapterConfig":{"fallbackModel":"google/gemma-4-12b"}}'
```
Mapping (aus Design):
- Self-Fallback `gemma-4-31b`→`gemma-4-31b` (Creative Director, Drehbuch, Link-Detektor, Marken-Spezialist, Social-Media-Spezialist, Clara-Designer, Redaktion&PR): `fallbackModel` → `google/gemma-4-12b`.
- `model = mistral-small-3.2-24b…` (Office & Admin, ggf. weitere): `model` → `gemma-4-31b-it-mlx` (Admin-Primär) oder `qwen3.6-35b-a3b-mlx` (falls Reasoning) — pro Agent entscheiden; `cheap.model` mistral → `gemma-4-31b-it-mlx`.

- [ ] **Step 6: Audit erneut — 0 Verletzungen**

Run: `cd tools/model-warden && python3 audit_agents.py`
Expected: „0 Agenten mit Verweis außerhalb des Resident-Sets."

- [ ] **Step 7: Commit**

```bash
git add tools/model-warden/audit_agents.py tools/model-warden/test_audit_agents.py
git commit -m "feat(model-warden): Agent-Config-Audit (alle Modellverweise im Resident-Set)"
```

---

### Task 8: Deploy + launchd scharf

**Files:**
- Create: `de.whitestag.model-warden.plist` (im Repo `tools/model-warden/`, deployt nach `~/Library/LaunchAgents/`)
- Deploy: `tools/model-warden/*` → `~/.paperclip/scripts/model-warden/`

**Interfaces:** keine neuen; verdrahtet den laufenden Dienst.

- [ ] **Step 1: plist schreiben**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>de.whitestag.model-warden</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>/Users/walterschoenenbroecher.de/.paperclip/scripts/model-warden/warden.py</string>
  </array>
  <key>StartInterval</key><integer>180</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/tmp/model-warden.log</string>
  <key>StandardErrorPath</key><string>/tmp/model-warden.err.log</string>
  <key>WorkingDirectory</key><string>/Users/walterschoenenbroecher.de/.paperclip/scripts/model-warden</string>
</dict>
</plist>
```

- [ ] **Step 2: Deploy ins Live-Verzeichnis**

```bash
mkdir -p ~/.paperclip/scripts/model-warden
rsync -a --exclude '__pycache__' --exclude 'test_*.py' \
  "tools/model-warden/" ~/.paperclip/scripts/model-warden/
cp tools/model-warden/de.whitestag.model-warden.plist ~/Library/LaunchAgents/
```

- [ ] **Step 3: Einmal manuell prüfen (Trockenlauf gegen echten lms)**

```bash
python3 ~/.paperclip/scripts/model-warden/warden.py
```
Expected: JSON `{"loaded":[...],"warnings":[...],"failures":[]}`; bei bereits vollständigem Set `loaded` leer.

- [ ] **Step 4: launchd laden + Lauf verifizieren**

```bash
launchctl unload ~/Library/LaunchAgents/de.whitestag.model-warden.plist 2>/dev/null
launchctl load  ~/Library/LaunchAgents/de.whitestag.model-warden.plist
sleep 5; cat /tmp/model-warden.log; launchctl list | grep model-warden
```
Expected: Exit 0, JSON-Ausgabe im Log.

- [ ] **Step 5: Selbstheilung beweisen**

```bash
export PATH="$HOME/.lmstudio/bin:$PATH"
lms unload gemma-4-31b-it-mlx        # gezielt ein Set-Modell entladen
sleep 200                            # < 2 Intervalle warten
lms ps | grep gemma-4-31b-it-mlx     # Wärter muss es nachgeladen haben
```
Expected: gemma-4-31b wieder resident (auf der Studio).

- [ ] **Step 6: Commit**

```bash
git add tools/model-warden/de.whitestag.model-warden.plist
git commit -m "feat(model-warden): launchd-Dienst (180s, self-healing) + Deploy"
```

---

### Task 9: JIT aus + n8n.sh entkoppeln (ZULETZT)

**Voraussetzung:** Task 6 Go, Task 7 = 0 Verletzungen, Task 8 Selbstheilung bewiesen.

**Files:**
- Modify: `~/.lmstudio/.internal/http-server-config.json`
- Modify: `~/Desktop/n8n.sh` (Preload-Block)

- [ ] **Step 1: Set-Vollständigkeit bestätigen**

```bash
python3 ~/.paperclip/scripts/model-warden/warden.py   # failures == [] und loaded == []
```
Expected: nichts zu tun → Set steht vollständig resident.

- [ ] **Step 2: JIT aus**

`~/.lmstudio/.internal/http-server-config.json`: `"justInTimeModelLoading": true` → `false`. Danach:
```bash
export PATH="$HOME/.lmstudio/bin:$PATH"; lms server stop; lms server start; sleep 3
python3 -c "import json;print(json.load(open('$HOME/.lmstudio/.internal/http-server-config.json'))['justInTimeModelLoading'])"
```
Expected: `False`.

- [ ] **Step 3: Wärter re-asserted JIT-Flag (Gotcha: GUI/Restart kippt es zurück)**

In `warden.py` `main()` vor dem Lauf ergänzen:
```python
    cfg_path = os.path.expanduser("~/.lmstudio/.internal/http-server-config.json")
    try:
        c = json.load(open(cfg_path))
        if c.get("justInTimeModelLoading") is not False:
            c["justInTimeModelLoading"] = False
            json.dump(c, open(cfg_path, "w"), indent=2)
    except OSError:
        pass
```
Deploy erneut (`rsync` wie Task 8 Step 2), dann `launchctl kickstart -k gui/$(id -u)/de.whitestag.model-warden`.

- [ ] **Step 4: n8n.sh-Preload entkoppeln**

Den großen Preload-Block in `~/Desktop/n8n.sh` (Zeilen ~150–216) ersetzen durch einen einzigen Aufruf:
```bash
# LM-Studio-Resident-Set: einzige Wahrheitsquelle ist der Modell-Wärter.
python3 "$HOME/.paperclip/scripts/model-warden/warden.py" >>"$LOGDIR/lmstudio-preload.log" 2>&1 || true
```
(Der launchd-Wärter hält das Set ohnehin; dieser Aufruf sorgt nur für sofortiges Laden beim n8n-Start.)

- [ ] **Step 5: Regressionsprobe — kein Agent ins Leere**

```bash
# Ein bekannter lokaler Agent je Modellklasse: kurzer Testlauf ohne llm_error.
python3 ~/.paperclip/scripts/model-warden/audit_agents.py   # 0 Verletzungen
lms ps   # alle always-Modelle resident, RTX-Modelle (tags) präsent
```
Expected: 0 Verletzungen; Set komplett; JIT aus.

- [ ] **Step 6: Digest-Gegenprobe (Bezug zum Auslöser)**

Am selben/nächsten 18:00-Lauf der Daily Digest V15 prüfen: `gemma`-Sublines kommen ohne JIT-Verzögerung (Modell resident). Log `execution_entity` Status `success`.

- [ ] **Step 7: Commit + Memory-Update**

```bash
git add -A tools/model-warden/
git commit -m "feat(model-warden): JIT aus + n8n.sh entkoppelt (Resident-Set self-healing)"
```
Danach Memory `project_llm_night_architecture` + `project_lmstudio_startup_preload` aktualisieren (JIT jetzt AUS, Wärter ist Wahrheitsquelle, n8n.sh-Preload abgelöst) und in `docs/Agenten-LLM-Zuordnung.md` den neuen Stand eintragen.

---

## Self-Review (gegen die Spec)

- **Resident-Set/Verteilung** → Task 1 (JSON) + Task 6 (RAM-Beweis). ✓
- **Modell-Wärter self-healing** → Tasks 2–5 (Logik) + Task 8 (launchd + Selbstheilungs-Beweis). ✓
- **Eine Wahrheitsquelle** → Task 1 JSON, Task 9 Step 4 (n8n.sh liest nur noch Wärter). ✓
- **JIT aus + TTL aus** → Task 9 Step 2/3 (JIT); TTL: `load_cmd` setzt **kein** `--ttl` (Task 4) → kein Auto-Eviction. ✓
- **Kein stilles Scheitern** → Task 5 (Fehler→Paperclip-Issue). ✓
- **Agent-Audit (kein Agent ins Leere)** → Task 7. ✓
- **day-only RTX ohne Fehler-Spam** → Task 3 (`day-only`-Skip) + Task 5-Test. ✓
- **Dreistufige Coder-Kette / LM-Link-Routing** → Task 6 Step 3 (verifiziert; Fallback coder-30b bleibt als Absicherung). ✓
- **Umsetzungsreihenfolge (JIT zuletzt)** → Tasks 6→7→8→9. ✓
- **Risiken** (MacBook-RAM, LM-Link, GUI-Reset) → Task 6, Task 9 Step 3. ✓

Keine Platzhalter; Typen/Signaturen über Tasks konsistent (`plan_actions`, `resolve_devices`, `parse_loaded`, `load_cmd`, `violations`, `run`).
