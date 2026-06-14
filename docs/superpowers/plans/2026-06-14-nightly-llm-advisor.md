# Nightly LLM Advisor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eine nächtliche Routine, die den Ist-Zustand der LLM-Zuweisung über alle drei Companies analysiert, gegen neue MLX-Modelle vergleicht und bei echtem, neuem Verbesserungspotenzial eine begründete Mail an Walter sendet — ohne je selbst etwas zu ändern.

**Architecture:** Hybrid aus deterministischen Host-Skripten (sammeln, benchmarken, State-Diff, Mail) und einem Claude-gestützten Paperclip-Agenten (Online-Rechercheur auf `claude_local`), der Web-Recherche, Bewertung und Begründung übernimmt. Eine Paperclip-Routine mit Cron-Trigger weckt den Agenten nächtlich; dessen Brief steuert den Ablauf und ruft die Skripte per Bash.

**Tech Stack:** Python 3 (Collector, State, Tests via pytest), Bash (Benchmark, Mail-Sender), PostgreSQL (embedded Paperclip-DB Port 54329), `lms` CLI (LM Studio), Paperclip REST-API (`http://127.0.0.1:3100/api`), Mailhub-Webhook (n8n :5678).

---

## File Structure

Alle neuen Dateien liegen unter `~/.paperclip/scripts/llm-advisor/` (Host-lokal, **nicht** in CloudStorage — launchd/Host-Jobs können SynologyDrive nicht lesen). Pfad-Konstante im Plan: `ADV=~/.paperclip/scripts/llm-advisor`.

- `$ADV/collect_ist_zustand.py` — Collector-CLI, schreibt `ist-zustand.json`. Verantwortlich: die 4 Signale deterministisch sammeln.
- `$ADV/advisor/__init__.py` — Paket-Marker.
- `$ADV/advisor/classify.py` — reine Funktion: Rolle/Modell → Fähigkeitsklasse.
- `$ADV/advisor/telemetry.py` — PG-Queries → Fehler-Zähler je Agent.
- `$ADV/advisor/resources.py` — `lms`-Parsing + 110-GB-Budget-Mathematik.
- `$ADV/advisor/state.py` — Load/Diff/Save von `llm-advisor-state.json`.
- `$ADV/benchmark_candidate.sh` — temporäres Laden + Messung eines Kandidaten.
- `$ADV/send_advisor_mail.sh` — Renderer + Mailhub-Versand an Walter.
- `$ADV/prompts/` — Testprompt-Fixtures je Fähigkeitsklasse (Schatten-Benchmark).
- `$ADV/routine-brief.md` — der nächtliche Agenten-Brief (Routine-`description`).
- `$ADV/tests/` — pytest-Tests (Fixtures aus echten `lms`-Ausgaben).
- `$ADV/state/` — Laufzeit-State + Logs (`.gitignore`-würdig, host-lokal).

Bestehende Dateien (nur lesen/referenzieren, **nicht** verändern):
- `companies/9cebf3cf…/lib/build_walter_mail_html.py` — Mail-Renderer.
- `companies/9cebf3cf…/bin/send-walter-deliverable.sh` — Mailhub-Aufrufmuster (Vorlage).

---

## Task 0: Scaffold + Test-Harness

**Files:**
- Create: `$ADV/advisor/__init__.py`
- Create: `$ADV/tests/__init__.py`
- Create: `$ADV/requirements.txt`
- Create: `$ADV/README.md`

- [ ] **Step 1: Verzeichnisstruktur anlegen**

```bash
ADV=~/.paperclip/scripts/llm-advisor
mkdir -p "$ADV/advisor" "$ADV/tests" "$ADV/prompts" "$ADV/state"
touch "$ADV/advisor/__init__.py" "$ADV/tests/__init__.py"
```

- [ ] **Step 2: requirements.txt schreiben**

```
psycopg[binary]>=3.1
pytest>=8.0
```

- [ ] **Step 3: Virtualenv + Install**

Run:
```bash
cd ~/.paperclip/scripts/llm-advisor && python3 -m venv .venv && \
  .venv/bin/pip install -r requirements.txt
```
Expected: „Successfully installed psycopg … pytest …"

- [ ] **Step 4: README.md mit Kurzbeschreibung schreiben**

```markdown
# LLM Advisor
Nächtliche Analyse der LLM-Zuweisung (3 Companies) gegen neue MLX-Modelle.
Spec: docs/superpowers/specs/2026-06-14-nightly-llm-advisor-design.md
Plan: docs/superpowers/plans/2026-06-14-nightly-llm-advisor.md
Einstieg: collect_ist_zustand.py → Agenten-Brief (routine-brief.md) → Mail.
```

- [ ] **Step 5: Smoke-Test, dass pytest läuft**

Run: `cd ~/.paperclip/scripts/llm-advisor && .venv/bin/pytest -q`
Expected: „no tests ran" (Exit 5) — Harness funktioniert.

- [ ] **Step 6: Commit**

```bash
cd ~/.paperclip/scripts/llm-advisor && git init -q 2>/dev/null; \
git add -A && git commit -q -m "chore(llm-advisor): scaffold package + test harness"
```
(Falls `$ADV` nicht in einem Git-Repo liegt: `git init` im Step ist enthalten.)

---

## Task 1: Fähigkeitsklassifikation (reine Funktion)

**Files:**
- Create: `$ADV/advisor/classify.py`
- Test: `$ADV/tests/test_classify.py`

- [ ] **Step 1: Failing Test schreiben**

```python
# tests/test_classify.py
from advisor.classify import capability_class

def test_coding_role_maps_to_coding():
    assert capability_class("VP Engineering", "qwen2.5-coder-14b-instruct-mlx") == "coding"

def test_research_role_maps_to_reasoning():
    assert capability_class("Online-Rechercheur", "qwen3.6-35b-a3b-mlx") == "reasoning"

def test_classifier_model_maps_to_classification():
    assert capability_class("Sekretärin", "qwen2.5-0.5b-instruct-mlx@4bit") == "classification"

def test_unknown_defaults_to_general():
    assert capability_class("Irgendwas", "gemma-4-31b-it-mlx") == "general"
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `cd $ADV && .venv/bin/pytest tests/test_classify.py -v`
Expected: FAIL „ModuleNotFoundError: No module named 'advisor.classify'"

- [ ] **Step 3: Minimal-Implementierung**

```python
# advisor/classify.py
"""Leitet aus Agent-Rolle/Name und zugewiesenem Modell eine Fähigkeitsklasse ab."""

_ROLE_KEYWORDS = {
    "coding": ("engineering", "developer", "coder", "vp engineering", "blender", "drehbuch"),
    "reasoning": ("recherche", "rechercheur", "cto", "ceo", "research", "analyst", "strateg"),
    "classification": ("sekretär", "triage", "router", "office", "admin", "label"),
}
_MODEL_HINTS = {
    "coding": ("coder",),
    "classification": ("0.5b", "0.6b"),
}


def capability_class(role_or_name: str, model: str) -> str:
    role = (role_or_name or "").lower()
    mdl = (model or "").lower()
    for cls, hints in _MODEL_HINTS.items():
        if any(h in mdl for h in hints):
            return cls
    for cls, kws in _ROLE_KEYWORDS.items():
        if any(k in role for k in kws):
            return cls
    return "general"
```

- [ ] **Step 4: Test laufen lassen — muss bestehen**

Run: `cd $ADV && .venv/bin/pytest tests/test_classify.py -v`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
cd $ADV && git add advisor/classify.py tests/test_classify.py && \
git commit -q -m "feat(llm-advisor): capability classification"
```

---

## Task 2: Telemetrie-Modul (PG-Queries)

**Files:**
- Create: `$ADV/advisor/telemetry.py`
- Test: `$ADV/tests/test_telemetry.py`

- [ ] **Step 1: Failing Test schreiben** (testet die reine Aggregations-Funktion mit Fake-Rows, kein DB-Zugriff)

```python
# tests/test_telemetry.py
from advisor.telemetry import aggregate_runs

ROWS = [
    # (company_id, agent_id, agent_name, error_code, status, duration_s)
    ("c1", "a1", "VP Engineering", "max_iterations", "failed", 880.0),
    ("c1", "a1", "VP Engineering", "max_iterations", "failed", 870.0),
    ("c1", "a1", "VP Engineering", None, "succeeded", 30.0),
    ("c1", "a2", "Sekretärin", "llm_unreachable", "failed", 5.0),
]

def test_aggregate_counts_per_agent():
    out = aggregate_runs(ROWS)
    a1 = next(a for a in out if a["agent_id"] == "a1")
    assert a1["max_iterations"] == 2
    assert a1["total_runs"] == 3
    assert a1["succeeded"] == 1
    assert round(a1["avg_duration_s"]) == 593

def test_aggregate_llm_unreachable():
    out = aggregate_runs(ROWS)
    a2 = next(a for a in out if a["agent_id"] == "a2")
    assert a2["llm_unreachable"] == 1
    assert a2["fail_rate"] == 1.0
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `cd $ADV && .venv/bin/pytest tests/test_telemetry.py -v`
Expected: FAIL „ModuleNotFoundError: No module named 'advisor.telemetry'"

- [ ] **Step 3: Implementierung (Aggregation rein + DB-Loader getrennt)**

```python
# advisor/telemetry.py
"""Liest heartbeat_runs aus der Paperclip-DB und aggregiert Fehler je Agent."""
from collections import defaultdict

DSN = "host=127.0.0.1 port=54329 dbname=paperclip user=paperclip password=paperclip"

_ERROR_CODES = (
    "max_iterations", "timeout", "llm_unreachable", "llm_error",
    "adapter_failed", "process_lost",
)

_QUERY = """
SELECT r.company_id::text, r.agent_id::text, a.name,
       r.error_code, r.status,
       EXTRACT(EPOCH FROM (r.finished_at - r.started_at)) AS duration_s
FROM heartbeat_runs r
JOIN agents a ON a.id = r.agent_id
WHERE r.created_at > now() - (%s || ' days')::interval
"""


def fetch_rows(days: int = 7):
    import psycopg
    with psycopg.connect(DSN) as conn, conn.cursor() as cur:
        cur.execute(_QUERY, (str(days),))
        return cur.fetchall()


def aggregate_runs(rows):
    by_agent = defaultdict(lambda: {"total_runs": 0, "succeeded": 0,
                                    "_dur_sum": 0.0, "_dur_n": 0})
    for company_id, agent_id, name, error_code, status, duration_s in rows:
        a = by_agent[agent_id]
        a["company_id"] = company_id
        a["agent_id"] = agent_id
        a["agent_name"] = name
        a["total_runs"] += 1
        if status == "succeeded":
            a["succeeded"] += 1
        if error_code in _ERROR_CODES:
            a[error_code] = a.get(error_code, 0) + 1
        if duration_s is not None:
            a["_dur_sum"] += float(duration_s)
            a["_dur_n"] += 1
    out = []
    for a in by_agent.values():
        for code in _ERROR_CODES:
            a.setdefault(code, 0)
        n = a.pop("_dur_n")
        s = a.pop("_dur_sum")
        a["avg_duration_s"] = (s / n) if n else 0.0
        a["fail_rate"] = round(1 - a["succeeded"] / a["total_runs"], 3) if a["total_runs"] else 0.0
        out.append(a)
    return out
```

- [ ] **Step 4: Test laufen lassen — muss bestehen**

Run: `cd $ADV && .venv/bin/pytest tests/test_telemetry.py -v`
Expected: 2 passed

- [ ] **Step 5: Integrations-Smoke gegen Live-DB**

Run:
```bash
cd $ADV && .venv/bin/python -c "from advisor.telemetry import fetch_rows, aggregate_runs; \
rows=fetch_rows(7); print('rows:', len(rows)); \
import json; print(json.dumps(aggregate_runs(rows)[:2], ensure_ascii=False, indent=2))"
```
Expected: positive Zeilenzahl + JSON mit Zählern (z.B. `max_iterations > 0`).

- [ ] **Step 6: Commit**

```bash
cd $ADV && git add advisor/telemetry.py tests/test_telemetry.py && \
git commit -q -m "feat(llm-advisor): telemetry aggregation from heartbeat_runs"
```

---

## Task 3: Ressourcen- & Budget-Modul

**Files:**
- Create: `$ADV/advisor/resources.py`
- Test: `$ADV/tests/test_resources.py`
- Create (Fixture): `$ADV/tests/fixtures/lms_ls.json`, `$ADV/tests/fixtures/lms_ps.json`

- [ ] **Step 1: Fixtures aus echter Ausgabe erzeugen**

Run:
```bash
mkdir -p $ADV/tests/fixtures
~/.lmstudio/bin/lms ls --json > $ADV/tests/fixtures/lms_ls.json
~/.lmstudio/bin/lms ps --json > $ADV/tests/fixtures/lms_ps.json
```
Expected: zwei JSON-Dateien, nicht leer (`[{...}]`).

- [ ] **Step 2: Failing Test schreiben**

```python
# tests/test_resources.py
import json, pathlib
from advisor.resources import parse_models, budget_report

FIX = pathlib.Path(__file__).parent / "fixtures"

def _load(name):
    return json.loads((FIX / name).read_text())

def test_parse_models_extracts_size_and_quant():
    models = parse_models(_load("lms_ls.json"))
    assert any(m["model_key"] for m in models)
    m = models[0]
    assert m["size_gb"] > 0
    assert "quant" in m

def test_budget_report_caps_at_limit():
    models = parse_models(_load("lms_ls.json"))
    loaded = parse_models(_load("lms_ps.json"))
    rep = budget_report(models, loaded, limit_gb=110.0)
    assert rep["limit_gb"] == 110.0
    assert rep["loaded_gb"] >= 0
    assert rep["disk_gb"] >= rep["loaded_gb"]
    assert rep["free_loadable_gb"] == round(110.0 - rep["loaded_gb"], 2)
```

- [ ] **Step 3: Test laufen lassen — muss fehlschlagen**

Run: `cd $ADV && .venv/bin/pytest tests/test_resources.py -v`
Expected: FAIL „No module named 'advisor.resources'"

- [ ] **Step 4: Implementierung**

```python
# advisor/resources.py
"""Parst `lms ls/ps --json` und berechnet das 110-GB-Lade-Budget."""
import json
import subprocess

LMS = "/Users/walterschoenenbroecher.de/.lmstudio/bin/lms"
_GB = 1024 ** 3


def _run_lms(subcmd):
    out = subprocess.run([LMS, subcmd, "--json"], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def fetch_ls():
    return _run_lms("ls")


def fetch_ps():
    return _run_lms("ps")


def parse_models(raw):
    models = []
    for m in raw:
        if m.get("type") != "llm":
            continue
        quant = (m.get("quantization") or {}).get("name", "")
        models.append({
            "model_key": m.get("modelKey", ""),
            "size_gb": round((m.get("sizeBytes") or 0) / _GB, 2),
            "quant": quant,
            "params": m.get("paramsString", ""),
            "arch": m.get("architecture", ""),
        })
    return models


def budget_report(all_models, loaded_models, limit_gb=110.0):
    disk_gb = round(sum(m["size_gb"] for m in all_models), 2)
    loaded_gb = round(sum(m["size_gb"] for m in loaded_models), 2)
    return {
        "limit_gb": limit_gb,
        "disk_gb": disk_gb,
        "loaded_gb": loaded_gb,
        "free_loadable_gb": round(limit_gb - loaded_gb, 2),
        "over_limit": loaded_gb > limit_gb,
        "loaded_keys": [m["model_key"] for m in loaded_models],
    }
```

- [ ] **Step 5: Test laufen lassen — muss bestehen**

Run: `cd $ADV && .venv/bin/pytest tests/test_resources.py -v`
Expected: 2 passed

- [ ] **Step 6: Commit**

```bash
cd $ADV && git add advisor/resources.py tests/test_resources.py tests/fixtures && \
git commit -q -m "feat(llm-advisor): lms parsing + 110GB budget report"
```

---

## Task 4: Agenten-Modell-Mapping + Collector-CLI

**Files:**
- Create: `$ADV/advisor/agents.py`
- Create: `$ADV/collect_ist_zustand.py`
- Test: `$ADV/tests/test_agents.py`

- [ ] **Step 1: Failing Test für die reine Mapping-Funktion**

```python
# tests/test_agents.py
from advisor.agents import agent_profiles

ROWS = [
    # (company_id, name, role, adapter_type, model)
    ("c1", "VP Engineering", "engineering", "lmstudio_local", "qwen2.5-coder-14b-instruct-mlx@8bit"),
    ("c1", "Büroleitung 2", "office", "claude_local", None),
]

def test_local_agent_has_capability_and_local_flag():
    profs = agent_profiles(ROWS)
    vp = next(p for p in profs if p["name"] == "VP Engineering")
    assert vp["adapter_type"] == "lmstudio_local"
    assert vp["is_local"] is True
    assert vp["capability"] == "coding"

def test_claude_agent_marked_cloud():
    profs = agent_profiles(ROWS)
    bl = next(p for p in profs if p["name"] == "Büroleitung 2")
    assert bl["is_local"] is False
    assert bl["model"] in (None, "")
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `cd $ADV && .venv/bin/pytest tests/test_agents.py -v`
Expected: FAIL „No module named 'advisor.agents'"

- [ ] **Step 3: Implementierung**

```python
# advisor/agents.py
"""Liest Agent→Modell-Zuweisung und leitet Profile ab."""
from advisor.classify import capability_class

DSN = "host=127.0.0.1 port=54329 dbname=paperclip user=paperclip password=paperclip"

_QUERY = """
SELECT a.company_id::text, a.name, a.role, a.adapter_type,
       a.adapter_config->>'model' AS model
FROM agents a
WHERE a.status = 'active'
ORDER BY a.company_id, a.name
"""


def fetch_agent_rows():
    import psycopg
    with psycopg.connect(DSN) as conn, conn.cursor() as cur:
        cur.execute(_QUERY)
        return cur.fetchall()


def agent_profiles(rows):
    profs = []
    for company_id, name, role, adapter_type, model in rows:
        profs.append({
            "company_id": company_id,
            "name": name,
            "role": role,
            "adapter_type": adapter_type,
            "model": model,
            "is_local": adapter_type == "lmstudio_local",
            "capability": capability_class(role + " " + name, model or ""),
        })
    return profs
```

- [ ] **Step 4: Test laufen lassen — muss bestehen**

Run: `cd $ADV && .venv/bin/pytest tests/test_agents.py -v`
Expected: 2 passed

- [ ] **Step 5: Collector-CLI schreiben (verbindet alle Module → ist-zustand.json)**

```python
# collect_ist_zustand.py
#!/usr/bin/env python3
"""Sammelt den Ist-Zustand der LLM-Zuweisung in ein JSON für den Advisor-Agenten."""
import json
import sys
import datetime as _dt
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from advisor.telemetry import fetch_rows, aggregate_runs
from advisor.agents import fetch_agent_rows, agent_profiles
from advisor.resources import fetch_ls, fetch_ps, parse_models, budget_report

OUT = Path(__file__).parent / "state" / "ist-zustand.json"
COMPANY_NAMES = {}  # optional: company_id -> Klarname, wird aus DB ergänzt


def main(days: int = 7, generated_at: str | None = None):
    telemetry = aggregate_runs(fetch_rows(days))
    profiles = agent_profiles(fetch_agent_rows())
    all_models = parse_models(fetch_ls())
    loaded = parse_models(fetch_ps())
    budget = budget_report(all_models, loaded, limit_gb=110.0)

    tel_by_agent = {t["agent_name"]: t for t in telemetry}
    for p in profiles:
        p["telemetry"] = tel_by_agent.get(p["name"], {})

    doc = {
        "generated_at": generated_at or _dt.datetime.now().isoformat(timespec="seconds"),
        "window_days": days,
        "budget": budget,
        "models_on_disk": all_models,
        "agents": profiles,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=2))
    print(f"wrote {OUT} — {len(profiles)} agents, {len(all_models)} models, "
          f"loaded {budget['loaded_gb']}/{budget['limit_gb']} GB")


if __name__ == "__main__":
    main()
```

- [ ] **Step 6: Collector real ausführen**

Run: `cd $ADV && .venv/bin/python collect_ist_zustand.py`
Expected: „wrote …/ist-zustand.json — N agents, M models, loaded X/110.0 GB"

- [ ] **Step 7: Ausgabe prüfen**

Run: `cd $ADV && .venv/bin/python -c "import json; d=json.load(open('state/ist-zustand.json')); print(d['budget']); print([a['name'] for a in d['agents'] if a['is_local']][:5])"`
Expected: Budget-Block + Liste lokaler Agenten.

- [ ] **Step 8: Commit**

```bash
cd $ADV && git add advisor/agents.py collect_ist_zustand.py tests/test_agents.py && \
git commit -q -m "feat(llm-advisor): agent profiles + collect_ist_zustand CLI"
```

---

## Task 5: State + Rausch-Schutz

**Files:**
- Create: `$ADV/advisor/state.py`
- Test: `$ADV/tests/test_state.py`

- [ ] **Step 1: Failing Test schreiben**

```python
# tests/test_state.py
from advisor.state import diff_proposals

def test_new_proposal_is_reported():
    prev = {"proposals": []}
    cur = [{"agent": "VP Engineering", "to_model": "qwen3-coder-30b-mlx"}]
    new = diff_proposals(prev, cur)
    assert len(new) == 1

def test_known_proposal_is_suppressed():
    prev = {"proposals": [{"agent": "VP Engineering", "to_model": "qwen3-coder-30b-mlx", "decision": "pending"}]}
    cur = [{"agent": "VP Engineering", "to_model": "qwen3-coder-30b-mlx"}]
    assert diff_proposals(prev, cur) == []

def test_rejected_proposal_is_never_resurfaced():
    prev = {"proposals": [{"agent": "VP Engineering", "to_model": "qwen3-coder-30b-mlx", "decision": "rejected"}]}
    cur = [{"agent": "VP Engineering", "to_model": "qwen3-coder-30b-mlx"}]
    assert diff_proposals(prev, cur) == []
```

- [ ] **Step 2: Test laufen lassen — muss fehlschlagen**

Run: `cd $ADV && .venv/bin/pytest tests/test_state.py -v`
Expected: FAIL „No module named 'advisor.state'"

- [ ] **Step 3: Implementierung**

```python
# advisor/state.py
"""State-Datei: merkt vorgeschlagene Modelle + Walters Entscheidungen."""
import json
from pathlib import Path

STATE = Path(__file__).resolve().parent.parent / "state" / "llm-advisor-state.json"


def load_state():
    if STATE.exists():
        return json.loads(STATE.read_text())
    return {"proposals": []}


def _key(p):
    return (p.get("agent", ""), p.get("to_model", ""))


def diff_proposals(prev_state, current):
    """Gibt nur Vorschläge zurück, die neu sind (nicht schon pending/rejected/accepted)."""
    known = {_key(p) for p in prev_state.get("proposals", [])}
    return [p for p in current if _key(p) not in known]


def record_proposals(prev_state, new_proposals, generated_at):
    merged = list(prev_state.get("proposals", []))
    for p in new_proposals:
        merged.append({**p, "decision": "pending", "first_seen": generated_at})
    prev_state["proposals"] = merged
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(prev_state, ensure_ascii=False, indent=2))
    return prev_state
```

- [ ] **Step 4: Test laufen lassen — muss bestehen**

Run: `cd $ADV && .venv/bin/pytest tests/test_state.py -v`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
cd $ADV && git add advisor/state.py tests/test_state.py && \
git commit -q -m "feat(llm-advisor): proposal state + noise suppression"
```

---

## Task 6: Schatten-Benchmark-Skript

**Files:**
- Create: `$ADV/benchmark_candidate.sh`
- Create: `$ADV/prompts/coding.txt`, `$ADV/prompts/reasoning.txt`, `$ADV/prompts/classification.txt`, `$ADV/prompts/general.txt`

- [ ] **Step 1: Testprompt-Fixtures schreiben** (je eine repräsentative Aufgabe)

`prompts/coding.txt`:
```
Schreibe eine Python-Funktion `merge_intervals(intervals)`, die überlappende
Intervalle zusammenfasst. Gib nur den Code zurück.
```
`prompts/reasoning.txt`:
```
Ein Agent erreicht 14× pro Woche das max_iterations-Limit bei vagen Routinen.
Nenne die zwei wahrscheinlichsten Ursachen und je eine Gegenmaßnahme. Kurz.
```
`prompts/classification.txt`:
```
Klassifiziere diese E-Mail in genau eines von {Rechnung, Anfrage, Spam, Sonstiges}.
Antworte nur mit dem Label. Text: "Ihre Bestellung #4821 wurde versandt."
```
`prompts/general.txt`:
```
Fasse in einem Satz zusammen, was ein MoE-Sprachmodell von einem dichten Modell
unterscheidet.
```

- [ ] **Step 2: Benchmark-Skript schreiben**

```bash
#!/usr/bin/env bash
# benchmark_candidate.sh — lädt ein Kandidaten-Modell temporär, misst Tokens/s je
# Fähigkeitsklasse und entlädt wieder. Gibt JSON auf stdout.
#
# Usage: benchmark_candidate.sh <model_key> [--keep]
# Exit: 0 Erfolg, 1 Argument-/Ladefehler, 2 Budget-Sprengung
set -euo pipefail

LMS="$HOME/.lmstudio/bin/lms"
ADV="$HOME/.paperclip/scripts/llm-advisor"
MODEL="${1:?model_key fehlt}"
KEEP="${2:-}"

was_loaded="$("$LMS" ps --json | grep -c "\"identifier\":\"$MODEL\"" || true)"

cleanup() {
  if [[ "$KEEP" != "--keep" && "$was_loaded" == "0" ]]; then
    "$LMS" unload "$MODEL" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# Laden (falls noch nicht geladen)
if [[ "$was_loaded" == "0" ]]; then
  "$LMS" load "$MODEL" --yes >/dev/null 2>&1 || { echo '{"error":"load_failed"}'; exit 1; }
fi

results="[]"
for cls in coding reasoning classification general; do
  prompt="$(cat "$ADV/prompts/$cls.txt")"
  start=$(python3 -c 'import time;print(time.time())')
  resp="$("$LMS" chat "$MODEL" --prompt "$prompt" 2>/dev/null | tr -d '\000' || true)"
  end=$(python3 -c 'import time;print(time.time())')
  toks=$(printf '%s' "$resp" | wc -w | tr -d ' ')
  results="$(python3 -c "
import json,sys
r=json.loads('''$results''')
dur=max($end-$start,1e-6)
r.append({'class':'$cls','words':$toks,'seconds':round(dur,2),'words_per_s':round($toks/dur,2)})
print(json.dumps(r))
")"
done

echo "{\"model\":\"$MODEL\",\"benchmarks\":$results}"
```

- [ ] **Step 3: Ausführbar machen**

Run: `chmod +x $ADV/benchmark_candidate.sh`
Expected: kein Output.

- [ ] **Step 4: Gegen ein bereits geladenes Modell testen** (kein neuer Download nötig)

Run: `$ADV/benchmark_candidate.sh qwen3.6-35b-a3b-mlx --keep`
Expected: JSON `{"model":"qwen3.6-35b-a3b-mlx","benchmarks":[{"class":"coding",...}]}` — und das Modell bleibt geladen (`--keep`).

- [ ] **Step 5: Commit**

```bash
cd $ADV && git add benchmark_candidate.sh prompts && \
git commit -q -m "feat(llm-advisor): shadow benchmark script + prompt fixtures"
```

---

## Task 7: Mail-Sender

**Files:**
- Create: `$ADV/send_advisor_mail.sh`

- [ ] **Step 1: Mailhub-Parameter aus der Vorlage bestätigen**

Run: `grep -E "WEBHOOK_URL|MAILHUB_SECRET|TO_ADDR" ~/.paperclip/instances/default/companies/9cebf3cf-efe8-4597-a400-f06488900a87/bin/send-walter-deliverable.sh`
Expected: zeigt `WEBHOOK_URL=http://127.0.0.1:5678/webhook/mailhub/send`, `MAILHUB_SECRET=mailhub-…`, `TO_ADDR=ws@whitestag.ai`.

- [ ] **Step 2: Sender-Skript schreiben** (nimmt Betreff + HTML-Body-Datei, sendet an Walter)

```bash
#!/usr/bin/env bash
# send_advisor_mail.sh — sendet die Advisor-Mail an Walter über den Mailhub.
# Usage: send_advisor_mail.sh --subject "..." --html-file /pfad/body.html [--dry-run]
set -euo pipefail

WEBHOOK_URL="http://127.0.0.1:5678/webhook/mailhub/send"
MAILHUB_SECRET="mailhub-812a27b07c73e64d7df192c98a3883eb"
FROM_ADDR="cto@whitestag.ai"   # CTO = Modellauswahl-Owner
TO_ADDR="ws@whitestag.ai"

SUBJECT=""; HTML_FILE=""; DRY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --subject) SUBJECT="$2"; shift 2;;
    --html-file) HTML_FILE="$2"; shift 2;;
    --dry-run) DRY="1"; shift;;
    *) echo "unbekanntes Argument: $1" >&2; exit 1;;
  esac
done
[[ -n "$SUBJECT" && -f "$HTML_FILE" ]] || { echo "subject/html-file fehlt" >&2; exit 1; }

payload="$(python3 -c "
import json,sys
print(json.dumps({
  'from': '$FROM_ADDR', 'to': '$TO_ADDR',
  'subject': sys.argv[1],
  'html': open(sys.argv[2], encoding='utf-8').read(),
}))" "$SUBJECT" "$HTML_FILE")"

if [[ -n "$DRY" ]]; then
  echo "[dry-run] würde senden an $TO_ADDR: $SUBJECT (${#payload} bytes)"
  exit 0
fi

curl -fsS -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -H "X-Mailhub-Secret: $MAILHUB_SECRET" \
  -d "$payload" && echo "gesendet: $SUBJECT"
```

- [ ] **Step 3: Ausführbar + Dry-Run testen**

Run:
```bash
chmod +x $ADV/send_advisor_mail.sh
echo '<h1>Advisor Test</h1>' > /tmp/advisor-body.html
$ADV/send_advisor_mail.sh --subject "LLM-Advisor Test" --html-file /tmp/advisor-body.html --dry-run
```
Expected: „[dry-run] würde senden an ws@whitestag.ai: LLM-Advisor Test (… bytes)"

- [ ] **Step 4: Header-Schlüssel gegen Mailhub verifizieren** (welcher Secret-Header erwartet wird)

Run: `grep -iE "X-Mailhub|secret|header" ~/.paperclip/instances/default/companies/9cebf3cf-efe8-4597-a400-f06488900a87/bin/send-walter-deliverable.sh | head`
Expected: zeigt den exakt erwarteten Header-Namen; falls abweichend (z.B. anderer Key), `send_advisor_mail.sh` anpassen und Dry-Run-Test wiederholen.

- [ ] **Step 5: Echter Sendetest an Walter**

Run: `$ADV/send_advisor_mail.sh --subject "LLM-Advisor Selbsttest (ignorieren)" --html-file /tmp/advisor-body.html`
Expected: „gesendet: …"; Walter bestätigt Eingang einmalig. (Bei 401/Webhook-Fehler: Mailhub-Token prüfen — siehe Memory „Deliverable-watcher token TTL".)

- [ ] **Step 6: Commit**

```bash
cd $ADV && git add send_advisor_mail.sh && \
git commit -q -m "feat(llm-advisor): mailhub sender to Walter"
```

---

## Task 8: Agenten-Brief (Routine-Description)

**Files:**
- Create: `$ADV/routine-brief.md`

- [ ] **Step 1: Brief schreiben** — die nächtliche Schritt-für-Schritt-Anweisung für den (claude_local) Online-Rechercheur

```markdown
# Nächtliche LLM-Advisor-Routine

Du bist der Online-Rechercheur. Führe jede Nacht diese Schritte exakt aus.
Ändere NIE selbst eine Modell-Zuweisung — du lieferst nur eine Entscheidungsvorlage.

## 1. Ist-Zustand sammeln
Bash: `cd ~/.paperclip/scripts/llm-advisor && .venv/bin/python collect_ist_zustand.py`
Lies danach `state/ist-zustand.json`. Es enthält: Budget (110 GB), alle Modelle
auf Platte, je Agent {Company, Rolle, Modell, is_local, capability, telemetry}.

## 2. Schmerzpunkte identifizieren
Markiere lokale Agenten (`is_local=true`) mit auffälliger Telemetrie:
hohe `max_iterations`, `llm_unreachable`, `llm_error`, `timeout`, hohe `fail_rate`
oder `avg_duration_s`. Das sind Kandidaten für ein stärkeres/passenderes Modell.
Markiere ebenso überdimensionierte Modelle (großes Modell, triviale capability).

## 3. Web-Recherche (deine Kernaufgabe)
Suche per WebSearch nach NEUEN, für LM Studio als MLX verfügbaren Modellen
(Quellen: huggingface.co/mlx-community, lmstudio-community, LM-Studio-Modellkatalog,
aktuelle Benchmark-Leaderboards für Coding/Reasoning/Tool-Use). Für jeden Schmerz-
oder Überdimensionierungs-Kandidaten: gibt es ein MLX-Modell, das die Aufgabenklasse
besser bedient und ins 110-GB-Budget passt (`budget.free_loadable_gb` beachten)?
Prüfe auch: besserer Quant desselben Modells, passendere Kontextlänge, Konsolidierung
(Agenten teilen sich ein Modell), 2–3 Gesamt-Szenarien (RAM-sparsam/Qualität/ausgewogen).
Notiere Drift (z.B. dokumentiertes ≠ tatsächliches Modell).

## 4. Rausch-Schutz
Bash: lies `state/llm-advisor-state.json`. Verwende
`advisor.state.diff_proposals`, um nur NEUE Vorschläge zu behalten
(bereits pending/rejected/accepted werden unterdrückt).
Wenn nach dem Diff KEIN neuer Vorschlag bleibt: heute keine Mail (außer es ist
Sonntag → kurze Status-Mail „Setup weiterhin optimal, X Modelle geprüft").

## 5. Top-Kandidat belegen (stufig)
Nur wenn EIN klarer Gewinner existiert und ins Budget passt:
Bash: `~/.paperclip/scripts/llm-advisor/benchmark_candidate.sh <model_key>`
(lädt temporär, misst, entlädt). Zahlen in die Begründung übernehmen.
Passt er nicht ins Budget → kein Benchmark, Vorschlag als „nur Recherche" markieren.

## 6. Mail bauen + senden
Schreibe einen HTML-Body nach `/tmp/llm-advisor-body.html` mit je Vorschlag:
TL;DR (Agent: A→B, +Reasoning/−RAM) · Begründung (welches Signal) · Belege
(externe Benchmarks + ggf. Schatten-Benchmark + Quell-Links) · Budget-Wirkung
· Drift/Quant/Kontext-Hinweise · konkrete Aktion (`lms get …` / Adapter-Config).
Sende: `~/.paperclip/scripts/llm-advisor/send_advisor_mail.sh --subject
"LLM-Advisor: N neue Empfehlung(en)" --html-file /tmp/llm-advisor-body.html`

## 7. State + Issue
Trage die gesendeten Vorschläge via `advisor.state.record_proposals` in den State
(decision=pending). Erstelle zusätzlich ein Paperclip-Issue an den CTO
(`5b7cb8a7-945f-4861-b3a7-4ae84d242d1e`) mit gleichem Inhalt (Nachverfolgbarkeit).

## Fehlerverhalten
Schlägt Schritt 1 (DB/lms) fehl: brich ab, KEINE Halbdaten-Mail. Logge nach
`state/advisor.log`. Erst nach 3 aufeinanderfolgenden Fehlnächten eine Hinweis-Mail.
```

- [ ] **Step 2: Brief auf Vollständigkeit gegen Spec prüfen**

Run: `grep -c -E "collect_ist_zustand|benchmark_candidate|send_advisor_mail|diff_proposals|record_proposals" $ADV/routine-brief.md`
Expected: `>= 5` (alle Skript-/Funktions-Referenzen vorhanden).

- [ ] **Step 3: Commit**

```bash
cd $ADV && git add routine-brief.md && \
git commit -q -m "docs(llm-advisor): nightly routine brief for the agent"
```

---

## Task 9: Online-Rechercheur auf claude_local umstellen

**Files:**
- Modify (DB): `agents.adapter_config` / `adapter_type` für `d80fe6b9-…`

- [ ] **Step 1: Aktuelle Config sichern**

Run:
```bash
PGPASSWORD=paperclip psql -h 127.0.0.1 -p 54329 -U paperclip -d paperclip -At \
 -c "SELECT adapter_type, adapter_config FROM agents WHERE id='d80fe6b9-b2ac-4d58-8525-8bbbb1d0caf7';" \
 > $ADV/state/online-rechercheur-config.bak.txt
cat $ADV/state/online-rechercheur-config.bak.txt | head -c 200
```
Expected: Backup-Datei enthält `lmstudio_local|{…}`.

- [ ] **Step 2: Umstellung als Transaktion** (entfernt lmstudio-Felder, behält Instructions + Skills)

Run:
```bash
PGPASSWORD=paperclip psql -h 127.0.0.1 -p 54329 -U paperclip -d paperclip <<'SQL'
BEGIN;
UPDATE agents SET
  adapter_type = 'claude_local',
  adapter_config = (adapter_config
    - 'model' - 'effort' - 'variant' - 'graceSec' - 'timeoutSec'
    - 'mode' - 'modelReasoningEffort' - 'allowedWriteRoots' - 'env')
WHERE id = 'd80fe6b9-b2ac-4d58-8525-8bbbb1d0caf7';
SELECT adapter_type, adapter_config->'paperclipSkillSync' IS NOT NULL AS keeps_skills,
       adapter_config ? 'instructionsFilePath' AS keeps_instructions
FROM agents WHERE id = 'd80fe6b9-b2ac-4d58-8525-8bbbb1d0caf7';
COMMIT;
SQL
```
Expected: `claude_local | t | t` (Skills + Instructions erhalten).

- [ ] **Step 3: Verifizieren, dass der Agent jetzt wie ein claude_local-Agent aussieht**

Run:
```bash
PGPASSWORD=paperclip psql -h 127.0.0.1 -p 54329 -U paperclip -d paperclip -At \
 -c "SELECT name, adapter_type, adapter_config->>'model' FROM agents WHERE id='d80fe6b9-b2ac-4d58-8525-8bbbb1d0caf7';"
```
Expected: `Online-Rechercheur|claude_local|` (kein Modell mehr).

- [ ] **Step 4: Smoke — Agent kann Bash + WebSearch** (manueller Funktionsnachweis über Paperclip-UI oder ein Test-Issue)

Erstelle ein Test-Issue an den Agenten „Führe `echo advisor-smoke` aus und suche im Web den aktuellen Namen des neuesten Qwen-MLX-Modells." Erwartet: Agent liefert Bash-Ausgabe + ein Web-Ergebnis. (Bestätigt Engine vor Routine-Anlage.)

- [ ] **Step 5: Commit der Doku zur Umstellung**

```bash
cd $ADV && git add state/online-rechercheur-config.bak.txt && \
git commit -q -m "chore(llm-advisor): switch Online-Rechercheur to claude_local (backup kept)"
```

---

## Task 10: Paperclip-Routine + Cron-Trigger anlegen

**Files:**
- Create (DB via API): Routine + zwei Trigger (nächtlich + wöchentlich)

- [ ] **Step 1: Routine-Brief als description bereitstellen**

Run: `BRIEF=$(cat $ADV/routine-brief.md); echo "${#BRIEF} Zeichen geladen"`
Expected: positive Zeichenzahl.

- [ ] **Step 2: Routine über Paperclip-API anlegen** (assignee = Online-Rechercheur)

Run:
```bash
ADV=~/.paperclip/scripts/llm-advisor
curl -fsS -X POST http://127.0.0.1:3100/api/companies/9cebf3cf-efe8-4597-a400-f06488900a87/routines \
  -H "Content-Type: application/json" \
  -d "$(python3 -c "
import json
brief=open('$ADV/routine-brief.md',encoding='utf-8').read()
print(json.dumps({
  'title':'Nightly LLM Advisor',
  'description':brief,
  'assigneeAgentId':'d80fe6b9-b2ac-4d58-8525-8bbbb1d0caf7',
  'priority':'medium',
}))")"
```
Expected: JSON mit `"id":"…"` der neuen Routine. **Routine-ID notieren** → `ROUTINE_ID`.

> Falls der exakte Endpunkt/Body abweicht: vorher die `paperclip`-Skill öffnen und
> den Routinen-Endpunkt + Cron-Trigger-Schema dort nachschlagen (autoritative Quelle
> für API-Form). Dann diesen und den nächsten Step entsprechend anpassen.

- [ ] **Step 3: Nächtlichen Cron-Trigger anlegen (04:30 Europe/Berlin)**

Run:
```bash
curl -fsS -X POST http://127.0.0.1:3100/api/companies/9cebf3cf-efe8-4597-a400-f06488900a87/routines/$ROUTINE_ID/triggers \
  -H "Content-Type: application/json" \
  -d '{"kind":"schedule","label":"nightly","cronExpression":"30 4 * * *","timezone":"Europe/Berlin","enabled":true}'
```
Expected: JSON-Trigger mit `next_run_at` am morgigen 04:30.

- [ ] **Step 4: Verifizieren in der DB**

Run:
```bash
PGPASSWORD=paperclip psql -h 127.0.0.1 -p 54329 -U paperclip -d paperclip -At \
 -c "SELECT r.title, t.cron_expression, t.timezone, t.next_run_at FROM routines r JOIN routine_triggers t ON t.routine_id=r.id WHERE r.title='Nightly LLM Advisor';"
```
Expected: `Nightly LLM Advisor|30 4 * * *|Europe/Berlin|<morgen 04:30>`

- [ ] **Step 5: Commit der Anlage-Doku**

```bash
echo "ROUTINE_ID=$ROUTINE_ID angelegt $(date -Iseconds)" >> $ADV/state/routine-provisioning.log
cd $ADV && git add state/routine-provisioning.log && \
git commit -q -m "chore(llm-advisor): provision nightly routine + cron trigger"
```

---

## Task 11: End-to-End-Trockenlauf + Doku/Memory

**Files:**
- Modify: `docs/superpowers/specs/2026-06-14-nightly-llm-advisor-design.md` (Status → umgesetzt)
- Create: Memory-Datei + MEMORY.md-Zeile

- [ ] **Step 1: Routine einmal manuell auslösen** (statt auf 04:30 zu warten)

Run:
```bash
curl -fsS -X POST http://127.0.0.1:3100/api/companies/9cebf3cf-efe8-4597-a400-f06488900a87/routines/$ROUTINE_ID/run \
  -H "Content-Type: application/json" -d '{}'
```
Expected: Run wird erzeugt; der Agent durchläuft den Brief. (Endpunkt ggf. via `paperclip`-Skill verifizieren.)

- [ ] **Step 2: Ergebnis prüfen**

Run:
```bash
cat $ADV/state/ist-zustand.json | python3 -c "import json,sys;d=json.load(sys.stdin);print('agents',len(d['agents']),'budget',d['budget']['loaded_gb'],'/',d['budget']['limit_gb'])"
cat $ADV/state/llm-advisor-state.json 2>/dev/null | head
```
Expected: ist-zustand.json frisch; State-Datei existiert (ggf. leere proposals, wenn nichts Neues). Bei Vorschlag: Mail im Postfach.

- [ ] **Step 3: Spec-Status aktualisieren**

In `docs/superpowers/specs/2026-06-14-nightly-llm-advisor-design.md` die Statuszeile auf
`Status: umgesetzt 2026-06-14` setzen.

- [ ] **Step 4: Memory schreiben**

Create `…/memory/project_nightly_llm_advisor.md`:
```markdown
---
name: project-nightly-llm-advisor
description: Nächtliche LLM-Advisor-Routine — analysiert Modell-Zuweisung der 3 Companies vs. neue MLX-Modelle, mailt Verbesserungsvorschläge an Walter.
metadata:
  type: project
---

Routine „Nightly LLM Advisor" (Company 9cebf3cf…, assignee Online-Rechercheur
d80fe6b9…, jetzt claude_local) läuft 04:30 Europe/Berlin. Skripte unter
`~/.paperclip/scripts/llm-advisor/`: `collect_ist_zustand.py` (Telemetrie aus
heartbeat_runs + agents.adapter_config + `lms ls/ps` → state/ist-zustand.json,
110-GB-Budget), `benchmark_candidate.sh` (Schatten-Benchmark), `send_advisor_mail.sh`
(Mailhub → ws@whitestag.ai), `advisor/state.py` (Rausch-Schutz, nur Neues mailen).
Brief = routine-brief.md. Ändert nie selbst Zuweisungen. Siehe
[[project_lmstudio_agent_setup]], [[project_n8n_workflow_watcher]].
```

- [ ] **Step 5: MEMORY.md-Zeile ergänzen**

Füge in `…/memory/MEMORY.md` hinzu:
```
- [Nightly LLM Advisor](project_nightly_llm_advisor.md) — 04:30-Routine analysiert Modell-Zuweisung der 3 Companies vs. neue MLX-Modelle, mailt Vorschläge an Walter; Skripte in ~/.paperclip/scripts/llm-advisor/.
```

- [ ] **Step 6: Abschluss-Commit**

```bash
cd ~/Library/CloudStorage/SynologyDrive-Mac/"Claude Code MAC"/Paperclip && \
git add docs/superpowers/specs/2026-06-14-nightly-llm-advisor-design.md && \
git commit -q -m "docs(llm-advisor): mark spec implemented"
```

---

## Self-Review-Ergebnis

- **Spec-Abdeckung:** 4 Signale → Tasks 2 (Telemetrie), 4 (Profil/Modell), 3 (Ressourcen/Budget), Brief-Schritt 3 (externe Benchmarks). Stufiger Benchmark → Task 6 + Brief-5. Rausch-Schutz/State → Task 5 + Brief-4. Mail nur bei Neuem → Brief-4/6. Engine-Umstellung claude_local → Task 9. Zeitplan 04:30 + wöchentlich → Task 10 + Brief-4. Zusatz-Ideen (Drift, Quant, Kontext, Lade-Profil, Szenarien, Lernen aus Entscheidungen) → Brief-3 + State. CTO-Issue → Brief-7.
- **Platzhalter:** keine — jeder Code-Step zeigt vollständigen Code; API-Form-Unsicherheiten sind als explizite „via paperclip-Skill verifizieren"-Hinweise markiert, nicht als TODO.
- **Typ-Konsistenz:** `aggregate_runs`/`agent_profiles`/`parse_models`/`budget_report`/`diff_proposals`/`record_proposals` werden überall gleich benannt und mit denselben Feldern verwendet (`agent_name`, `model_key`, `to_model`, `decision`).
