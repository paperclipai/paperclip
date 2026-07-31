# LLM-Advisor: Melder mit Gedächtnis — Implementierungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Der Advisor meldet Befunde statt Empfehlungen und weist bei jedem Lauf nach, was aus den früheren Befunden geworden ist.

**Architecture:** Zwei neue reine Module im Advisor-Repo — `outcomes.py` (Wirksamkeitsmessung aus `agent_config_revisions` + `heartbeat_runs`) und `findings.py` (Befundform je Ursachenklasse). Beide folgen dem etablierten Muster: DB-Zugriff (`fetch_*`) getrennt von der testbaren Logik. Danach Taktung und Brief nachziehen, zuletzt die Modell-Drift im Paperclip-Hauptrepo.

**Tech Stack:** Python 3, pytest, psycopg (Postgres 54329), bestehendes venv unter `~/.paperclip/scripts/llm-advisor/.venv`

**Spec:** `docs/superpowers/specs/2026-07-31-llm-advisor-melder-design.md`

## Global Constraints

- Arbeitsverzeichnis für Task 1–4: `~/.paperclip/scripts/llm-advisor/` (eigenes Git-Repo, **kein Remote** — nichts zu pushen). Task 5 im Paperclip-Hauptrepo.
- Python-Aufrufe immer über `.venv/bin/python`, nie über System-Python.
- TDD ist Pflicht: Test schreiben, **fehlschlagen sehen**, dann implementieren.
- `state/` ist gitignored — State-Änderungen sind nicht committbar.
- DB nur lesend (`SELECT`). Einzige Schreibzugriffe: `PATCH` über die Paperclip-API.
- Vergleichsfenster: **14 Tage** vor/nach Stichtag. Erfolg = Klassenrate **mindestens halbiert**. Unter **10 Läufen** im Fenster gilt `unklar`.
- Nach jedem Baustein ein Realitäts-Check gegen die Live-DB, nicht nur gegen Fixtures.

---

### Task 1: Klassenrate und Config-Änderung finden

**Files:**
- Create: `advisor/outcomes.py`
- Test: `tests/test_outcomes.py`

**Interfaces:**
- Consumes: nichts (reine Funktionen)
- Produces:
  - `class_rate(runs, codes) -> float | None` — `runs` ist eine Liste von Dicts mit `error_code`; `None` bei unter 10 Läufen
  - `find_config_change(revisions, agent_id, since) -> dict | None` — `revisions` Liste von Dicts mit `agent_id`, `created_at` (ISO-String), `before_config`, `after_config`
  - `MIN_RUNS_FOR_VERDICT = 10`

- [ ] **Step 1: Write the failing tests**

```python
"""Wirksamkeitsmessung: hat ein Befund je etwas verbessert? (WHI-3389)"""
from advisor.outcomes import class_rate, find_config_change, MIN_RUNS_FOR_VERDICT


def _runs(n, **codes):
    """n Laeufe insgesamt, davon je Code die angegebene Anzahl."""
    out = []
    for code, count in codes.items():
        out += [{"error_code": code}] * count
    out += [{"error_code": None}] * (n - len(out))
    return out


def test_class_rate_is_the_share_of_runs_hit_by_the_class():
    rate = class_rate(_runs(100, llm_error=20, process_lost=5), ("llm_error",))
    assert rate == 0.2


def test_class_rate_counts_every_code_of_the_class():
    rate = class_rate(_runs(100, llm_error=20, process_lost=5),
                      ("llm_error", "process_lost"))
    assert rate == 0.25


def test_class_rate_is_unknown_below_the_minimum_run_count():
    # Absolute Zahlen sind wertlos, wenn die Laufzahl schwankt -- und eine
    # Rate aus 3 Laeufen ist keine Aussage.
    assert class_rate(_runs(9, llm_error=9), ("llm_error",)) is None
    assert MIN_RUNS_FOR_VERDICT == 10


def test_class_rate_is_zero_when_the_class_never_fired():
    assert class_rate(_runs(50, llm_error=10), ("process_lost",)) == 0.0


def test_find_config_change_returns_the_first_change_after_the_finding():
    revs = [
        {"agent_id": "a1", "created_at": "2026-07-01T10:00:00+00:00", "after_config": {"model": "alt"}},
        {"agent_id": "a1", "created_at": "2026-07-20T10:00:00+00:00", "after_config": {"model": "neu"}},
        {"agent_id": "a1", "created_at": "2026-07-25T10:00:00+00:00", "after_config": {"model": "neuer"}},
    ]
    found = find_config_change(revs, "a1", since="2026-07-15")
    assert found["after_config"]["model"] == "neu"


def test_find_config_change_ignores_other_agents():
    revs = [{"agent_id": "a2", "created_at": "2026-07-20T10:00:00+00:00", "after_config": {}}]
    assert find_config_change(revs, "a1", since="2026-07-15") is None


def test_find_config_change_returns_none_when_nothing_changed_since():
    revs = [{"agent_id": "a1", "created_at": "2026-07-01T10:00:00+00:00", "after_config": {}}]
    assert find_config_change(revs, "a1", since="2026-07-15") is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/.paperclip/scripts/llm-advisor && .venv/bin/python -m pytest tests/test_outcomes.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'advisor.outcomes'`

- [ ] **Step 3: Write minimal implementation**

```python
"""Wirksamkeitsmessung: was wurde aus einem Befund? (WHI-3389)

102 Vorschlaege lagen im State, 20 als implemented markiert, und niemand
hatte je geprueft ob einer geholfen hat. Ohne dieses Signal kann die
Qualitaet der Befunde systematisch nicht steigen.
"""

# Eine Rate aus wenigen Laeufen ist keine Aussage -- dieselbe
# Datenbasis-Anforderung wie bei der Schmerzschwelle in signals.py.
MIN_RUNS_FOR_VERDICT = 10


def class_rate(runs, codes):
    """Anteil der Laeufe, die an einem Code dieser Klasse scheiterten.

    Absolute Fehlerzahlen sind unbrauchbar, weil die Zahl der Laeufe je
    Fenster schwankt. `None` heisst: zu duenne Datenbasis fuer ein Urteil.
    """
    total = len(runs)
    if total < MIN_RUNS_FOR_VERDICT:
        return None
    hit = sum(1 for r in runs if r.get("error_code") in codes)
    return round(hit / total, 4)


def find_config_change(revisions, agent_id, since):
    """Die erste Konfigurationsaenderung dieses Agenten nach `since`.

    Spaetere Aenderungen werden bewusst ignoriert: es zaehlt die Reaktion
    auf den Befund, nicht was Wochen danach noch geschah.
    """
    candidates = [
        r for r in revisions
        if r.get("agent_id") == agent_id and str(r.get("created_at", "")) > str(since)
    ]
    if not candidates:
        return None
    return min(candidates, key=lambda r: str(r["created_at"]))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/.paperclip/scripts/llm-advisor && .venv/bin/python -m pytest tests/ -q`
Expected: PASS, alle bisherigen Tests bleiben grün

- [ ] **Step 5: Commit**

```bash
cd ~/.paperclip/scripts/llm-advisor
git add advisor/outcomes.py tests/test_outcomes.py
git commit -m "feat(advisor): Klassenrate + Config-Aenderungssuche als Messgrundlage"
```

---

### Task 2: Ergebnis klassifizieren

**Files:**
- Modify: `advisor/outcomes.py`
- Test: `tests/test_outcomes.py`

**Interfaces:**
- Consumes: `class_rate`, `find_config_change` aus Task 1
- Produces: `classify_outcome(before, after, changed) -> str` — liefert `"behoben"`, `"wirkungslos"`, `"ignoriert"`, `"rauschen"` oder `"unklar"`. `before`/`after` sind `float | None`, `changed` ist `bool`.

- [ ] **Step 1: Write the failing tests**

```python
from advisor.outcomes import classify_outcome


def test_change_and_halved_rate_is_fixed():
    assert classify_outcome(before=0.40, after=0.20, changed=True) == "behoben"


def test_exactly_halved_still_counts_as_fixed():
    # Die Grenze ist bewusst grob: Wirkung von Rauschen trennen, nicht
    # Feinheiten aufloesen.
    assert classify_outcome(before=0.40, after=0.20, changed=True) == "behoben"
    assert classify_outcome(before=0.40, after=0.21, changed=True) == "wirkungslos"


def test_change_without_improvement_means_the_diagnosis_was_wrong():
    assert classify_outcome(before=0.40, after=0.38, changed=True) == "wirkungslos"


def test_no_change_and_persisting_errors_means_ignored():
    assert classify_outcome(before=0.40, after=0.38, changed=False) == "ignoriert"


def test_no_change_but_errors_vanished_means_the_finding_was_noise():
    # Das wichtigste Lernsignal: der Befund haette nie kommen duerfen.
    assert classify_outcome(before=0.40, after=0.05, changed=False) == "rauschen"


def test_missing_data_on_either_side_is_unknown():
    assert classify_outcome(before=None, after=0.2, changed=True) == "unklar"
    assert classify_outcome(before=0.4, after=None, changed=True) == "unklar"


def test_a_zero_baseline_cannot_improve():
    # Ohne Fehler vorher gibt es nichts zu beheben -- sonst wuerde jede
    # 0->0-Messung als Erfolg gezaehlt.
    assert classify_outcome(before=0.0, after=0.0, changed=True) == "unklar"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/.paperclip/scripts/llm-advisor && .venv/bin/python -m pytest tests/test_outcomes.py -q`
Expected: FAIL — `ImportError: cannot import name 'classify_outcome'`

- [ ] **Step 3: Write minimal implementation**

```python
# Ein Rueckgang gilt als Wirkung, wenn sich die Klassenrate mindestens
# halbiert. Grob mit Absicht: nebenlaeufige Ursachen kann die Messung
# ohnehin nicht ausschliessen, sie ist ein Indiz, kein Beweis.
IMPROVEMENT_FACTOR = 0.5


def classify_outcome(before, after, changed):
    """Was wurde aus einem Befund?

    `behoben`      Aenderung erfolgt, Rate halbiert -- Diagnose war richtig
    `wirkungslos`  Aenderung erfolgt, Rate blieb    -- Diagnose war falsch
    `ignoriert`    keine Aenderung, Fehler bestehen
    `rauschen`     keine Aenderung, Fehler weg      -- Befund war unnoetig
    `unklar`       zu duenne Datenbasis
    """
    if before is None or after is None or before <= 0:
        return "unklar"
    improved = after <= before * IMPROVEMENT_FACTOR
    if changed:
        return "behoben" if improved else "wirkungslos"
    return "rauschen" if improved else "ignoriert"
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/.paperclip/scripts/llm-advisor && .venv/bin/python -m pytest tests/ -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd ~/.paperclip/scripts/llm-advisor
git add advisor/outcomes.py tests/test_outcomes.py
git commit -m "feat(advisor): Ergebnisklassen behoben/wirkungslos/ignoriert/rauschen"
```

---

### Task 3: Auswertung verdrahten und rückwirkend laufen lassen

**Files:**
- Modify: `advisor/outcomes.py`
- Create: `evaluate_history.py`
- Test: `tests/test_outcomes.py`

**Interfaces:**
- Consumes: `class_rate`, `find_config_change`, `classify_outcome`
- Produces:
  - `evaluate(findings, runs_by_agent, revisions, window_days=14) -> list[dict]` — jedes Element `{finding, outcome, before, after, changed_at}`
  - `fetch_config_revisions(days)` und `fetch_runs_for_window(agent_id, start, end)` (DB, ungetestet)

- [ ] **Step 1: Write the failing test**

```python
from advisor.outcomes import evaluate


def test_evaluate_pairs_each_finding_with_its_outcome():
    findings = [{"agent_id": "a1", "agent_name": "CMO", "cause": "model",
                 "first_seen": "2026-07-01"}]
    runs_by_agent = {
        ("a1", "vorher"): [{"error_code": "llm_error"}] * 20 + [{"error_code": None}] * 30,
        ("a1", "nachher"): [{"error_code": "llm_error"}] * 2 + [{"error_code": None}] * 48,
    }
    revisions = [{"agent_id": "a1", "created_at": "2026-07-02T09:00:00+00:00",
                  "after_config": {"model": "neu"}}]
    out = evaluate(findings, runs_by_agent, revisions)
    assert out[0]["outcome"] == "behoben"
    assert out[0]["before"] == 0.4
    assert out[0]["changed_at"].startswith("2026-07-02")


def test_evaluate_marks_a_finding_without_telemetry_as_unknown():
    findings = [{"agent_id": "a9", "agent_name": "Weg", "cause": "model",
                 "first_seen": "2026-07-01"}]
    out = evaluate(findings, {}, [])
    assert out[0]["outcome"] == "unklar"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/.paperclip/scripts/llm-advisor && .venv/bin/python -m pytest tests/test_outcomes.py -q`
Expected: FAIL — `ImportError: cannot import name 'evaluate'`

- [ ] **Step 3: Write minimal implementation**

```python
from advisor.signals import CONFIG_CODES, MODEL_CODES, UPSTREAM_CODES

# Welche Fehlercodes zu einer Ursachenklasse gehoeren. `adapter` teilt sich
# die Codes mit `model` -- der Unterschied liegt im Adapter, nicht im Code.
CODES_BY_CAUSE = {
    "config": CONFIG_CODES,
    "model": MODEL_CODES,
    "adapter": MODEL_CODES,
    "upstream": UPSTREAM_CODES,
}
# Altvorschlaege tragen kein `cause` -- fuer sie zaehlt jeder Fehlercode.
ALL_CODES = tuple(set(CONFIG_CODES + MODEL_CODES + UPSTREAM_CODES))


def evaluate(findings, runs_by_agent, revisions, window_days=14):
    """Haelt jeden Befund gegen das, was danach geschah."""
    out = []
    for f in findings:
        agent_id = f.get("agent_id")
        codes = CODES_BY_CAUSE.get(f.get("cause")) or ALL_CODES
        before = class_rate(runs_by_agent.get((agent_id, "vorher"), []), codes)
        after = class_rate(runs_by_agent.get((agent_id, "nachher"), []), codes)
        change = find_config_change(revisions, agent_id, since=f.get("first_seen", ""))
        out.append({
            "finding": f,
            "outcome": classify_outcome(before, after, changed=bool(change)),
            "before": before,
            "after": after,
            "changed_at": str(change["created_at"]) if change else None,
        })
    return out
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/.paperclip/scripts/llm-advisor && .venv/bin/python -m pytest tests/ -q`
Expected: PASS

- [ ] **Step 5: DB-Anbindung ergänzen**

An `outcomes.py` anhängen — analog zu `telemetry.fetch_rows`, ungetestet weil reine Abfrage:

```python
_REVISIONS_QUERY = """
SELECT agent_id::text, created_at, before_config, after_config, changed_keys
FROM agent_config_revisions
WHERE created_at > now() - (%s || ' days')::interval
ORDER BY created_at
"""

_WINDOW_QUERY = """
SELECT error_code FROM heartbeat_runs
WHERE agent_id = %s AND created_at >= %s::timestamptz
  AND created_at < %s::timestamptz
"""


def fetch_config_revisions(days=120):
    import psycopg
    with psycopg.connect(DSN) as conn, conn.cursor() as cur:
        cur.execute(_REVISIONS_QUERY, (str(days),))
        return [{"agent_id": a, "created_at": c.isoformat(),
                 "before_config": b, "after_config": af, "changed_keys": ck}
                for a, c, b, af, ck in cur.fetchall()]


def fetch_runs_for_window(agent_id, start, end):
    import psycopg
    with psycopg.connect(DSN) as conn, conn.cursor() as cur:
        cur.execute(_WINDOW_QUERY, (agent_id, start, end))
        return [{"error_code": code} for (code,) in cur.fetchall()]
```

Import oben in `outcomes.py` ergänzen: `from advisor.db import DSN`

- [ ] **Step 6: Backfill-Skript schreiben**

`evaluate_history.py` im Repo-Wurzelverzeichnis — wertet die Altvorschläge aus dem State aus:

```python
#!/usr/bin/env python3
"""Rueckwirkende Auswertung: hat der Advisor je etwas verbessert?

Die Altvorschlaege tragen kein `cause` (die Klassen gibt es erst seit dem
31.07.) und nur 21 von 102 eine `agent_id` -- der Rest wird ueber den Namen
gejoint. Nicht aufloesbare Faelle zaehlen als `unklar`, nicht als Erfolg.
"""
import datetime as dt
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from advisor.state import load_state
from advisor.agents import fetch_agent_rows, agent_profiles
from advisor.outcomes import evaluate, fetch_config_revisions, fetch_runs_for_window

WINDOW = 14


def main():
    state = load_state()
    proposals = state.get("proposals", [])
    proposals = list(proposals.values()) if isinstance(proposals, dict) else proposals
    by_name = {p["name"]: p["agent_id"] for p in agent_profiles(fetch_agent_rows())}

    findings = []
    for p in proposals:
        if p.get("decision") != "implemented" or not p.get("first_seen"):
            continue
        findings.append({
            "agent_id": p.get("agent_id") or by_name.get(p.get("agent")),
            "agent_name": p.get("agent"),
            "cause": None,
            "first_seen": p["first_seen"][:10],
            "to_model": p.get("to_model"),
        })

    revisions = fetch_config_revisions(days=180)
    runs = {}
    for f in findings:
        if not f["agent_id"]:
            continue
        day = dt.date.fromisoformat(f["first_seen"])
        runs[(f["agent_id"], "vorher")] = fetch_runs_for_window(
            f["agent_id"], str(day - dt.timedelta(days=WINDOW)), str(day))
        runs[(f["agent_id"], "nachher")] = fetch_runs_for_window(
            f["agent_id"], str(day), str(day + dt.timedelta(days=WINDOW)))

    results = evaluate(findings, runs, revisions, window_days=WINDOW)
    print(f"{len(findings)} angewendete Vorschlaege ausgewertet\n")
    for r in results:
        f = r["finding"]
        print(f"  {f['first_seen']}  {f['agent_name'][:26]:<28} "
              f"{r['outcome']:<12} {r['before']} -> {r['after']}")
    print("\nBilanz:", dict(Counter(r["outcome"] for r in results)))


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 7: Rückwirkend laufen lassen (Realitäts-Check)**

Run: `cd ~/.paperclip/scripts/llm-advisor && .venv/bin/python evaluate_history.py`
Expected: Bilanz über die 20 `implemented`-Vorschläge. Ein hoher `unklar`-Anteil ist ein zulässiges Ergebnis (siehe Spec, Risiken) — dann trägt die Messung erst vorwärts.

- [ ] **Step 8: Commit**

```bash
cd ~/.paperclip/scripts/llm-advisor
git add advisor/outcomes.py tests/test_outcomes.py evaluate_history.py
git commit -m "feat(advisor): rueckwirkende Wirksamkeitsauswertung der Altvorschlaege"
```

---

### Task 4: Befundtypen je Ursachenklasse

**Files:**
- Create: `advisor/findings.py`
- Test: `tests/test_findings.py`

**Interfaces:**
- Consumes: `advisor.evidence.evidence_line`, Profile aus `state/ist-zustand.json`
- Produces: `build_findings(profiles, window_days) -> list[dict]` mit den Feldern `agent_id`, `agent_name`, `cause`, `evidence`, `dominant`, `action`, `first_seen`

- [ ] **Step 1: Write the failing tests**

```python
"""Befundform je Ursachenklasse (WHI-3389)."""
from advisor.findings import build_findings


def _profile(name, cause, actionable=True, allowed=False, **kw):
    p = {
        "agent_id": "a-" + name, "name": name,
        "model": "gemma-4-31b-it-mlx", "max_iterations": 12,
        "telemetry": {"total_runs": 80, "succeeded": 20, "fail_rate": 0.75,
                      "llm_error": 40,
                      "top_errors": [{"code": "llm_error", "count": 40,
                                      "sample": "LM Studio API error 500"}]},
        "signals": {"cause": cause, "actionable": actionable,
                    "model_change_allowed": allowed,
                    "config_signals": {}, "model_signals": {"llm_error": 40},
                    "upstream_signals": {}},
    }
    p.update(kw)
    return p


def test_an_upstream_finding_never_carries_an_action():
    # Rate-Limit heilt kein Modellwechsel und keine Config-Aenderung.
    out = build_findings([_profile("n8n", "upstream")], window_days=7)
    assert out[0]["action"] is None
    assert out[0]["cause"] == "upstream"


def test_an_adapter_finding_never_carries_an_action():
    out = build_findings([_profile("Rechercheur", "adapter")], window_days=7)
    assert out[0]["action"] is None


def test_a_config_finding_carries_a_concrete_patch():
    out = build_findings([_profile("CHO", "config")], window_days=7)
    assert out[0]["action"]["kind"] == "config"


def test_a_model_finding_carries_a_model_change_when_allowed():
    out = build_findings([_profile("CMO", "model", allowed=True)], window_days=7)
    assert out[0]["action"]["kind"] == "model"


def test_a_model_cause_without_permission_carries_no_action():
    out = build_findings([_profile("CMO", "model", allowed=False)], window_days=7)
    assert out[0]["action"] is None


def test_findings_below_the_threshold_are_dropped():
    out = build_findings([_profile("CMO", "model", actionable=False)], window_days=7)
    assert out == []


def test_a_finding_without_a_cause_is_dropped():
    out = build_findings([_profile("Ruhig", "none")], window_days=7)
    assert out == []


def test_every_finding_carries_evidence_and_the_dominant_plaintext():
    out = build_findings([_profile("n8n", "upstream")], window_days=7)
    assert "llm_error=40x" in out[0]["evidence"]
    assert "LM Studio API error 500" in out[0]["dominant"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/.paperclip/scripts/llm-advisor && .venv/bin/python -m pytest tests/test_findings.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'advisor.findings'`

- [ ] **Step 3: Write minimal implementation**

```python
"""Befundform je Ursachenklasse (WHI-3389).

Wenn das einzige Werkzeug ein Modellwechsel ist, sieht jedes Problem wie ein
falsches Modell aus. Die Ausgabeform folgt deshalb der Ursache -- und eine
konkrete Aktion gibt es nur, wo sie ausfuehrbar UND belegbar ist.
"""
from advisor.evidence import evidence_line

REPORTABLE = ("config", "model", "upstream", "adapter")


def _action(profile):
    cause = profile["signals"]["cause"]
    if cause == "config":
        return {
            "kind": "config",
            "hint": (f"maxIterations={profile.get('max_iterations')} pruefen "
                     f"(PATCH /api/agents/{profile['agent_id']})"),
        }
    if cause == "model" and profile["signals"].get("model_change_allowed"):
        return {"kind": "model", "from_model": profile.get("model")}
    # upstream und adapter sind Befunde ohne Handlungsempfehlung: das
    # Zustaendige liegt ausserhalb der Agenten-Konfiguration.
    return None


def build_findings(profiles, window_days):
    out = []
    for p in profiles:
        signals = p.get("signals") or {}
        if signals.get("cause") not in REPORTABLE or not signals.get("actionable"):
            continue
        top = (p.get("telemetry") or {}).get("top_errors") or []
        out.append({
            "agent_id": p.get("agent_id"),
            "agent_name": p.get("name"),
            "cause": signals["cause"],
            "evidence": evidence_line(p.get("telemetry") or {}, window_days),
            "dominant": top[0]["sample"] if top else "",
            "action": _action(p),
        })
    return out
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/.paperclip/scripts/llm-advisor && .venv/bin/python -m pytest tests/ -q`
Expected: PASS

- [ ] **Step 5: Realitäts-Check gegen den Live-Snapshot**

Run:
```bash
cd ~/.paperclip/scripts/llm-advisor && .venv/bin/python -c "
import json
from advisor.findings import build_findings
d = json.load(open('state/ist-zustand.json'))
for f in build_findings(d['agents'], d['window_days']):
    print(f\"{f['cause']:<9} {f['agent_name'][:26]:<28} action={bool(f['action'])}\")
"
```
Expected: Nur Agenten über der Schwelle; `upstream`/`adapter` ohne Aktion.

- [ ] **Step 6: Commit**

```bash
cd ~/.paperclip/scripts/llm-advisor
git add advisor/findings.py tests/test_findings.py
git commit -m "feat(advisor): Befundform je Ursachenklasse statt nur Modellwechsel"
```

---

### Task 5: Brief, Taktung und Routine-Titel

**Files:**
- Modify: `routine-brief.md`
- Modify: `README.md`
- API: Routine `666f3c66-e9e6-47a5-ad8a-96b86a8b21fb`, Trigger `946965d8-1cb1-422c-b3f2-29e67fd8eda6`

- [ ] **Step 1: Brief um Berichtsaufbau und Schweigepflicht ergänzen**

In `routine-brief.md` nach dem Abschnitt zur Schmerzschwelle einfügen:

```markdown
## Berichtsaufbau

Der Bericht beginnt mit **„Was aus den letzten Befunden wurde"** (Ergebnisse aus
`evaluate_history.py` bzw. der laufenden Messung), danach folgen neue Befunde.

**Ohne Befund und ohne Ergebnis gibt es keine Mail.** Ein stiller Lauf ist ein gutes
Ergebnis, kein erfolgloser. Von 42 Agenten ist nach dem Umbau vom 31.07. genau einer
modellwechsel-fähig — wer trotzdem jede Woche etwas melden will, muss etwas erfinden.

Melde `upstream`- und `adapter`-Befunde **ohne Handlungsempfehlung**: benenne die
zuständige Baustelle (Kontingent, Taktung, Prompt-Größe, Erreichbarkeit) und den
dominanten Klartext. Ein Modellname gehört dort nicht hin.
```

- [ ] **Step 2: Taktung im Brief und README korrigieren**

Alle Vorkommen von „täglich um 11:00" / „täglich 11:00" auf „wöchentlich, montags 07:00" ändern — in `routine-brief.md` (Kopfzeile und Abschnitt 1) und `README.md`.

- [ ] **Step 3: Trigger umstellen**

```bash
TOKEN=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.paperclip/auth.json')))['credentials']['http://localhost:3100']['token'])")
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"cronExpression":"0 7 * * 1"}' \
  http://localhost:3100/api/routine-triggers/946965d8-1cb1-422c-b3f2-29e67fd8eda6
```

- [ ] **Step 4: Routine-Titel und Beschreibung nachziehen**

Titel auf `LLM-Advisor (wöchentlich, Mo 07:00)` ändern und `description` mit dem neuen
`routine-brief.md` überschreiben:

```bash
BODY=$(python3 -c "import json;print(json.dumps({'title':'LLM-Advisor (wöchentlich, Mo 07:00)','description':open('/Users/walterschoenenbroecher.de/.paperclip/scripts/llm-advisor/routine-brief.md').read()}))")
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "$BODY" http://localhost:3100/api/routines/666f3c66-e9e6-47a5-ad8a-96b86a8b21fb
```

- [ ] **Step 5: Verifizieren**

```bash
PGPASSWORD=paperclip psql -h 127.0.0.1 -p 54329 -U paperclip -d paperclip -At -F ' | ' -c \
"select r.title, t.cron_expression from routine_triggers t join routines r on r.id=t.routine_id
 where r.id='666f3c66-e9e6-47a5-ad8a-96b86a8b21fb';"
```
Expected: `LLM-Advisor (wöchentlich, Mo 07:00) | 0 7 * * 1`

- [ ] **Step 6: Commit**

```bash
cd ~/.paperclip/scripts/llm-advisor
git add routine-brief.md README.md
git commit -m "docs(advisor): Berichtsaufbau, Schweigen bei Befundfreiheit, Mo 07:00"
```

---

### Task 6: Modell-Drift des Advisor-Agenten beheben

**Files:**
- Modify: `packages/adapters/claude-local/src/index.ts:9-11`

Anderes Repo: Paperclip-Hauptrepo unter `~/Library/CloudStorage/SynologyDrive-Mac/Claude Code MAC/Paperclip`.

- [ ] **Step 1: Modell in die Adapterliste aufnehmen**

In `packages/adapters/claude-local/src/index.ts` die Modellliste um Opus 5 ergänzen —
`claude-opus-5` fehlt, weshalb 6 von 9 Läufen des Advisor-Agenten auf den Default
`claude-sonnet-4-6` zurückfielen:

```typescript
  { id: "claude-opus-5", label: "Claude Opus 5" },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
```

- [ ] **Step 2: Verifizieren, dass der Agent das Modell behält**

Nach dem Neustart des Dev-Servers prüfen, dass `adapter_config->>'model'` unverändert
`claude-opus-5` ist und der nächste Lauf es auch verwendet:

```bash
PGPASSWORD=paperclip psql -h 127.0.0.1 -p 54329 -U paperclip -d paperclip -At -F ' | ' -c \
"select usage_json->>'model', count(*) from heartbeat_runs
 where agent_id='efe7168d-a813-4d82-9cfa-f1b887f1ebeb'
 and created_at > now() - interval '1 day' group by 1;"
```

- [ ] **Step 3: Commit**

```bash
cd "/Users/walterschoenenbroecher.de/Library/CloudStorage/SynologyDrive-Mac/Claude Code MAC/Paperclip"
git add packages/adapters/claude-local/src/index.ts
git commit -m "fix(claude-local): claude-opus-5 in die Modellliste aufnehmen"
```

---

## Reihenfolge und Abhängigkeiten

Task 1 → 2 → 3 bauen aufeinander auf (`outcomes.py`). Task 3 liefert mit dem
rückwirkenden Lauf die erste Erkenntnis und ist der Punkt, an dem sich zeigt, ob die
Messung trägt — **hier innehalten und das Ergebnis bewerten**, bevor Task 4 folgt.

Task 4 (`findings.py`) ist unabhängig von 1–3 und könnte auch vorgezogen werden.
Task 5 setzt Task 4 voraus (der Brief beschreibt die Befundformen).
Task 6 ist von allem unabhängig und betrifft ein anderes Repo.
