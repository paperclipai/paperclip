# Academy-Auto Triage T-Phase 2 (Ranker + Integration + Digest) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ein haiku-Ranker wählt aus den (gefilterten) Kandidaten der T-Phase 1 genau eine Aufgabe + formuliert sie, und der Orchestrator nutzt die Triage selbstständig (kein manueller Auftrag mehr nötig), zeichnet das Ergebnis im State auf und setzt den Worktree nach Fehlschlägen sauber zurück.

**Architecture:** Baut auf T-Phase 1 (`triage/scan.py`, `triage/state.py`). Neu: `triage/rank.py` (Ranker), `triage/pick.py` (scan→filter→rank-Verdrahtung). `report.py` bekommt Triage-Meldungen; `orchestrator.py` bekommt einen Triage-Modus (wenn kein CLI-Auftrag übergeben wird) samt State-Aufzeichnung und Worktree-Reset. `Config` bekommt `triage_state_path`.

**Tech Stack:** Python 3 (stdlib: `json`, `subprocess`, `dataclasses`, `pathlib`) + pytest.

## Global Constraints

- Nur stdlib + pytest, keine neuen Laufzeit-Abhängigkeiten.
- Arbeit ausschließlich unter `tools/academy-auto/`; niemals `git add -A`/`.`, nur explizite Pfade.
- `Pick` (dataclass): `chosen_key: str`, `task_prompt: str`, `reason: str`.
- Ranker-Kontrakt: liefert JSON `{"chosen_key": "...", "task_prompt": "...", "reason": "..."}`. `chosen_key` MUSS in der Kandidatenmenge liegen, sonst `None`. Leerer `task_prompt` → `None`. Ranker-Aufruf fail-soft (Exception → `None`).
- Reihenfolge in `run_once` unverändert sicherheitskritisch: Pause → Worktree → [Triage falls kein CLI-Auftrag] → Impl → Gate → Scope → Diff-Cap → Commit. Triage sitzt VOR Impl, ändert die bestehenden Guards nicht.
- **Worktree-Reset-Vorbedingung:** Nach Status `impl_failed` und `discarded` MUSS der Worktree zurückgesetzt werden (`git reset --hard` + `git clean -fd`), damit zeilenbasierte keys nicht driften und die Quarantäne greift.
- Triage-Status-Aufzeichnung: nur wenn die Aufgabe per Triage gewählt wurde (`pick is not None`); manueller CLI-Auftrag zeichnet nichts auf.
- `baseline_red` wird in T-Phase 2 immer als `False` übergeben (echter Baseline-Snapshot + Delta-Gate = T-Phase 3); `rank` unterstützt den Parameter aber schon.
- Bestehende Tests müssen grün bleiben (aktuell 55).

---

## File Structure

- Create: `tools/academy-auto/academy_auto/triage/rank.py` — `Pick`, `rank`, Prompt-Bau, Default-Ranker
- Create: `tools/academy-auto/academy_auto/triage/pick.py` — `triage_and_pick`
- Modify: `tools/academy-auto/academy_auto/config.py` — Feld `triage_state_path`
- Modify: `tools/academy-auto/academy_auto/report.py` — Triage-Digest (reason + Quarantäne + „nichts zu tun")
- Modify: `tools/academy-auto/academy_auto/orchestrator.py` — Triage-Modus + State-Aufzeichnung + Worktree-Reset
- Test: `tests/test_triage_rank.py`, `tests/test_triage_pick.py`, erweitert `tests/test_report.py`, `tests/test_orchestrator.py`, `tests/test_config.py`

---

## Task 1: Ranker (`rank.py`)

**Files:**
- Create: `tools/academy-auto/academy_auto/triage/rank.py`
- Test: `tools/academy-auto/tests/test_triage_rank.py`

**Interfaces:**
- Consumes: `Candidate` (scan.py).
- Produces: `Pick` (dataclass `chosen_key, task_prompt, reason`); `rank(candidates, baseline_red=False, ranker=_default_ranker) -> Pick | None`; `_default_ranker(prompt: str) -> str` (headless `claude -p`, injizierbar). Modulkonstanten `RANK_CMD`, `MAX_CANDIDATES = 30`.

- [ ] **Step 1: Failing test schreiben**

```python
# tools/academy-auto/tests/test_triage_rank.py
from academy_auto.triage.scan import Candidate
from academy_auto.triage.rank import rank, Pick


def _cands():
    return [
        Candidate("tsc", "tsc:a.ts:5:TS1", "a.ts", 5, "Object possibly null", 50),
        Candidate("todo", "todo:b.ts:1", "b.ts", 1, "TODO validate", 10),
    ]


def test_rank_returns_valid_pick():
    def ranker(prompt):
        assert "tsc:a.ts:5:TS1" in prompt  # Kandidaten stehen im Prompt
        return '{"chosen_key": "tsc:a.ts:5:TS1", "task_prompt": "Fix null bug in a.ts:5", "reason": "höchste Priorität"}'
    pick = rank(_cands(), ranker=ranker)
    assert isinstance(pick, Pick)
    assert pick.chosen_key == "tsc:a.ts:5:TS1"
    assert "a.ts" in pick.task_prompt
    assert pick.reason == "höchste Priorität"


def test_rank_rejects_key_not_in_candidates():
    pick = rank(_cands(), ranker=lambda p: '{"chosen_key": "erfunden:1", "task_prompt": "x", "reason": "y"}')
    assert pick is None


def test_rank_none_on_empty_task_prompt():
    pick = rank(_cands(), ranker=lambda p: '{"chosen_key": "todo:b.ts:1", "task_prompt": "", "reason": "y"}')
    assert pick is None


def test_rank_none_on_non_json():
    assert rank(_cands(), ranker=lambda p: "kein json hier") is None


def test_rank_none_on_empty_candidates():
    assert rank([], ranker=lambda p: '{"chosen_key":"x","task_prompt":"y","reason":"z"}') is None


def test_rank_fail_soft_when_ranker_raises():
    def boom(prompt):
        raise RuntimeError("claude weg")
    assert rank(_cands(), ranker=boom) is None


def test_rank_extracts_json_embedded_in_prose():
    raw = 'Klar! Hier meine Wahl:\n{"chosen_key": "todo:b.ts:1", "task_prompt": "TODO b umsetzen", "reason": "einfach"}\nViel Erfolg.'
    pick = rank(_cands(), ranker=lambda p: raw)
    assert pick is not None and pick.chosen_key == "todo:b.ts:1"


def test_default_ranker_calls_claude(monkeypatch):
    from academy_auto.triage import rank as rankmod
    captured = {}
    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        class R:
            stdout = '{"ok": true}'
            stderr = ""
            returncode = 0
        return R()
    monkeypatch.setattr(rankmod.subprocess, "run", fake_run)
    out = rankmod._default_ranker("mein prompt")
    assert out == '{"ok": true}'
    assert captured["cmd"][:len(rankmod.RANK_CMD)] == rankmod.RANK_CMD
    assert "mein prompt" in captured["cmd"]
```

- [ ] **Step 2: Test läuft, FEHLSCHLAG bestätigen**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_triage_rank.py -v`
Expected: FAIL (`ModuleNotFoundError: academy_auto.triage.rank`)

- [ ] **Step 3: Implementieren**

```python
# tools/academy-auto/academy_auto/triage/rank.py
from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass

RANK_CMD = ["claude", "-p", "--tools", "", "--strict-mcp-config"]
MAX_CANDIDATES = 30


@dataclass
class Pick:
    chosen_key: str
    task_prompt: str
    reason: str


def _build_prompt(candidates, baseline_red: bool) -> str:
    lines = [
        "Du bist Tech-Lead der WHITESTAG.ACADEMY-App (Expo/React Native).",
        "Wähle aus der Kandidatenliste GENAU EINE gut umsetzbare, klar abgegrenzte Aufgabe.",
        "Meide zu große/riskante Aufgaben. Antworte AUSSCHLIESSLICH als JSON in einer Zeile:",
        '{"chosen_key": "<key aus der Liste>", "task_prompt": "<konkreter Auftrag für den Entwickler>", "reason": "<kurze Begründung>"}',
    ]
    if baseline_red:
        lines.append("HINWEIS: Die Baseline ist ROT (tsc/lint-Fehler). Bevorzuge eine Aufgabe, die das Gate grün macht.")
    lines.append("Kandidaten:")
    for c in candidates[:MAX_CANDIDATES]:
        loc = f"{c.file}:{c.line}" if c.file else c.key
        lines.append(f"- {c.key} [{c.source}] {loc} — {c.text}")
    return "\n".join(lines)


def _extract_json(raw: str):
    try:
        start = raw.index("{")
        end = raw.rindex("}") + 1
    except ValueError:
        return None
    try:
        return json.loads(raw[start:end])
    except ValueError:
        return None


def _default_ranker(prompt: str) -> str:  # pragma: no cover - echter claude-Aufruf beim Deploy
    proc = subprocess.run(RANK_CMD + [prompt], capture_output=True, text=True, check=False)
    return getattr(proc, "stdout", "") or ""


def rank(candidates, baseline_red: bool = False, ranker=_default_ranker) -> "Pick | None":
    if not candidates:
        return None
    prompt = _build_prompt(candidates, baseline_red)
    try:
        raw = ranker(prompt)
    except Exception:
        return None
    data = _extract_json(raw or "")
    if not isinstance(data, dict):
        return None
    key = data.get("chosen_key")
    if key not in {c.key for c in candidates}:
        return None
    task_prompt = data.get("task_prompt")
    if not task_prompt:
        return None
    return Pick(chosen_key=key, task_prompt=task_prompt, reason=data.get("reason") or "")
```

Hinweis: Der Test `test_default_ranker_calls_claude` patcht `rankmod.subprocess.run` — deshalb ruft `_default_ranker` `subprocess.run` über das Modul auf (Import `import subprocess`, Aufruf `subprocess.run(...)`), damit der Patch greift.

- [ ] **Step 4: Tests grün**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_triage_rank.py -v`
Expected: PASS (8 Tests)

- [ ] **Step 5: Commit**

```bash
git add tools/academy-auto/academy_auto/triage/rank.py tools/academy-auto/tests/test_triage_rank.py
git commit -m "feat(academy-auto): Triage-Ranker (haiku, JSON-validiert, fail-soft)"
```

---

## Task 2: Verdrahtung `pick.py` + Config-Feld

**Files:**
- Modify: `tools/academy-auto/academy_auto/config.py`
- Create: `tools/academy-auto/academy_auto/triage/pick.py`
- Test: `tools/academy-auto/tests/test_triage_pick.py`, `tools/academy-auto/tests/test_config.py`

**Interfaces:**
- Consumes: `scan_all` (scan.py), `load_state`/`filter_candidates` (state.py), `rank` (rank.py), `Config`.
- Produces: `Config.triage_state_path: Path`; `triage_and_pick(cfg, cwd, ranker=None, baseline_red=False) -> Pick | None`.

- [ ] **Step 1: Failing test schreiben**

```python
# tools/academy-auto/tests/test_triage_pick.py
from academy_auto.config import Config
from academy_auto.triage.scan import Candidate
from academy_auto.triage import pick as pickmod


def _cfg(tmp_path):
    base = Config.default()
    return Config(**{**base.__dict__, "triage_state_path": tmp_path / "triage-state.json"})


def test_triage_and_pick_filters_then_ranks(tmp_path, monkeypatch):
    cfg = _cfg(tmp_path)
    cands = [
        Candidate("tsc", "tsc:a.ts:5:TS1", "a.ts", 5, "err", 50),
        Candidate("todo", "todo:done:1", "b.ts", 1, "x", 10),
    ]
    monkeypatch.setattr(pickmod, "scan_all", lambda cwd: cands)
    # State: der todo:done:1-Kandidat ist erledigt -> muss rausgefiltert werden
    monkeypatch.setattr(pickmod, "load_state", lambda p: {"todo:done:1": {"attempts": 1, "last_status": "committed"}})
    seen = {}
    def fake_rank(fresh, baseline_red=False):
        seen["keys"] = [c.key for c in fresh]
        from academy_auto.triage.rank import Pick
        return Pick("tsc:a.ts:5:TS1", "Fix a.ts", "prio")
    monkeypatch.setattr(pickmod, "rank", fake_rank)
    result = pickmod.triage_and_pick(cfg, "/tmp/wt")
    assert seen["keys"] == ["tsc:a.ts:5:TS1"]  # erledigter Kandidat gefiltert
    assert result.chosen_key == "tsc:a.ts:5:TS1"


def test_triage_and_pick_none_when_no_fresh(tmp_path, monkeypatch):
    cfg = _cfg(tmp_path)
    monkeypatch.setattr(pickmod, "scan_all", lambda cwd: [])
    monkeypatch.setattr(pickmod, "load_state", lambda p: {})
    called = {"rank": False}
    def fake_rank(fresh, baseline_red=False):
        called["rank"] = True
        return None
    monkeypatch.setattr(pickmod, "rank", fake_rank)
    assert pickmod.triage_and_pick(cfg, "/tmp/wt") is None
    assert called["rank"] is False  # ohne Kandidaten kein Ranker-Aufruf


def test_config_default_has_triage_state_path():
    cfg = Config.default()
    assert cfg.triage_state_path.name == "triage-state.json"
```

- [ ] **Step 2: Test läuft, FEHLSCHLAG bestätigen**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_triage_pick.py -v`
Expected: FAIL (`AttributeError: triage_state_path` bzw. `ModuleNotFoundError: pick`)

- [ ] **Step 3: Implementieren**

In `config.py` das Feld nach `denied_globs` ergänzen:
```python
    triage_state_path: Path
```
und in `Config.default()` (nach dem `denied_globs=(...)`-Block, `base` ist dort schon definiert):
```python
            triage_state_path=base / "triage-state.json",
```

```python
# tools/academy-auto/academy_auto/triage/pick.py
from __future__ import annotations

from .scan import scan_all
from .state import load_state, filter_candidates
from .rank import rank


def triage_and_pick(cfg, cwd, ranker=None, baseline_red: bool = False):
    """scan → filter (State/Quarantäne) → rank. Gibt einen Pick oder None."""
    candidates = scan_all(cwd)
    state = load_state(cfg.triage_state_path)
    fresh = filter_candidates(state, candidates)
    if not fresh:
        return None
    if ranker is None:
        return rank(fresh, baseline_red=baseline_red)
    return rank(fresh, baseline_red=baseline_red, ranker=ranker)
```

- [ ] **Step 4: Tests grün + volle Suite**

Run: `cd tools/academy-auto && python3 -m pytest tests/ -v`
Expected: PASS (alle, inkl. der bestehenden `test_config`-Invarianten)

- [ ] **Step 5: Commit**

```bash
git add tools/academy-auto/academy_auto/config.py tools/academy-auto/academy_auto/triage/pick.py tools/academy-auto/tests/test_triage_pick.py tools/academy-auto/tests/test_config.py
git commit -m "feat(academy-auto): Triage-Verdrahtung triage_and_pick + Config triage_state_path"
```

---

## Task 3: Digest-Erweiterung (Grund + Quarantäne + „nichts zu tun")

**Files:**
- Modify: `tools/academy-auto/academy_auto/report.py`
- Test: `tools/academy-auto/tests/test_report.py`

**Interfaces:**
- Produces: `build_digest(...)` bekommt Zusatzparameter `reason: str = ""` und `quarantined: list[str] | None = None` (rückwärtskompatibel); neue Funktion `build_nothing_digest(quarantined=None) -> str`.

- [ ] **Step 1: Failing test schreiben** (an `tests/test_report.py` anhängen)

```python
def test_build_digest_includes_reason_and_quarantine():
    from academy_auto.gate import GateResult, GateStep
    from academy_auto.runner import RunOutcome
    from academy_auto.report import build_digest
    text = build_digest(
        task_prompt="Fix a.ts",
        run_outcome=RunOutcome(ok=True, output="done"),
        gate_result=GateResult(passed=True, steps=[GateStep(["npm", "test"], 0, "ok")]),
        committed=True,
        reason="höchste Priorität",
        quarantined=["todo:x.ts:9"],
    )
    assert "höchste Priorität" in text
    assert "todo:x.ts:9" in text
    assert "Quarant" in text


def test_build_nothing_digest():
    from academy_auto.report import build_nothing_digest
    text = build_nothing_digest(quarantined=["todo:x.ts:9"])
    assert "nichts" in text.lower() or "keine" in text.lower()
    assert "todo:x.ts:9" in text
```

- [ ] **Step 2: Test läuft, FEHLSCHLAG bestätigen**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_report.py -k "reason or nothing" -v`
Expected: FAIL (`unexpected keyword 'reason'` / `cannot import build_nothing_digest`)

- [ ] **Step 3: Implementieren** (in `report.py`)

`build_digest`-Signatur erweitern:
```python
def build_digest(
    task_prompt: str,
    run_outcome: RunOutcome,
    gate_result: GateResult,
    committed: bool,
    cap_exceeded: bool = False,
    scope_violations: list[str] | None = None,
    reason: str = "",
    quarantined: list[str] | None = None,
) -> str:
```
und VOR `return "\n".join(lines)` ergänzen:
```python
    if reason:
        lines.append(f"Warum diese Aufgabe: {reason}")
    if quarantined:
        lines.append("Quarantäne (bitte anschauen): " + ", ".join(quarantined))
```
Neue Funktion am Dateiende:
```python
def build_nothing_digest(quarantined: list[str] | None = None) -> str:
    """Digest, wenn die Triage keine umsetzbare Aufgabe findet."""
    lines = ["🎓 Academy-Auto — Tagesstand", "", "Aufgabe: keine (Triage fand nichts Umsetzbares)"]
    if quarantined:
        lines.append("Quarantäne (bitte anschauen): " + ", ".join(quarantined))
    return "\n".join(lines)
```

- [ ] **Step 4: Tests grün**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_report.py -v`
Expected: PASS (alle, inkl. bestehender Digest-Tests — `reason`/`quarantined` default leer, ändert nichts)

- [ ] **Step 5: Commit**

```bash
git add tools/academy-auto/academy_auto/report.py tools/academy-auto/tests/test_report.py
git commit -m "feat(academy-auto): Digest um Triage-Grund + Quarantaene + nichts-zu-tun erweitert"
```

---

## Task 4: Orchestrator-Integration (Triage-Modus + State + Worktree-Reset)

**Files:**
- Modify: `tools/academy-auto/academy_auto/orchestrator.py`
- Test: `tools/academy-auto/tests/test_orchestrator.py`

**Interfaces:**
- Consumes: `Pick` (rank.py), `triage_and_pick` (pick.py), `build_nothing_digest` (report.py), State-Funktionen.
- Produces: `run_once(cfg, task_prompt, deps)` akzeptiert `task_prompt=None` (Triage-Modus); `RunReport.status` erweitert um `"nothing_to_do"`. Neue `deps`-Callables: `triage_and_pick(cfg, cwd)`, `record_triage_outcome(cfg, key, status)`, `reset_worktree(cfg, cwd)`, `quarantined(cfg)`. Interne Helfer `_record_triage_outcome`, `_reset_worktree`, `_quarantined` als Defaults.

- [ ] **Step 1: Failing test schreiben** (an `tests/test_orchestrator.py`)

Zuerst `base_deps` um die neuen Callables ergänzen (die bestehenden Tests brauchen sie):
```python
def base_deps(**over):
    d = dict(
        prepare_worktree=lambda cfg: cfg.worktree_path,
        implement_task=lambda cfg, cwd, prompt: RunOutcome(ok=True, output="done"),
        run_gate=lambda cfg, cwd: GateResult(passed=True, steps=[GateStep(["npm", "test"], 0, "ok")]),
        commit_and_pr=lambda cfg, cwd, prompt: True,
        send_digest=lambda text: sent.append(text),
        count_diff_lines=lambda cfg, cwd: 10,
        list_changed_files=lambda cfg, cwd: ["src/App.tsx"],
        triage_and_pick=lambda cfg, cwd: None,
        record_triage_outcome=lambda cfg, key, status: recorded.append((key, status)),
        reset_worktree=lambda cfg, cwd: resets.append(cwd),
        quarantined=lambda cfg: [],
    )
    d.update(over)
    return SimpleNamespace(**d)
```
(Am Anfang der Testdatei sicherstellen, dass Modul-globale Listen `recorded = []` und `resets = []` existieren und in den Tests wie `sent` zurückgesetzt werden.)

Neue Tests:
```python
def test_run_once_triage_mode_picks_and_commits(tmp_path):
    global sent, recorded, resets
    sent, recorded, resets = [], [], []
    from academy_auto.triage.rank import Pick
    cfg = Config.default()
    cfg = Config(**{**cfg.__dict__, "pause_flag": tmp_path / "nope.pause"})
    deps = base_deps(triage_and_pick=lambda cfg, cwd: Pick("tsc:a.ts:5:TS1", "Fix a.ts:5", "prio"))
    report = run_once(cfg, None, deps)  # None -> Triage-Modus
    assert report.status == "committed"
    assert recorded == [("tsc:a.ts:5:TS1", "committed")]
    assert resets == []  # bei committed kein Reset
    assert any("prio" in s for s in sent)  # Grund im Digest


def test_run_once_triage_nothing_to_do(tmp_path):
    global sent, recorded, resets
    sent, recorded, resets = [], [], []
    cfg = Config.default()
    cfg = Config(**{**cfg.__dict__, "pause_flag": tmp_path / "nope.pause"})
    deps = base_deps(triage_and_pick=lambda cfg, cwd: None, quarantined=lambda cfg: ["todo:z.ts:3"])
    report = run_once(cfg, None, deps)
    assert report.status == "nothing_to_do"
    assert recorded == []
    assert len(sent) == 1 and "todo:z.ts:3" in sent[0]


def test_run_once_triage_discard_records_and_resets(tmp_path):
    global sent, recorded, resets
    sent, recorded, resets = [], [], []
    from academy_auto.triage.rank import Pick
    cfg = Config.default()
    cfg = Config(**{**cfg.__dict__, "pause_flag": tmp_path / "nope.pause"})
    deps = base_deps(
        triage_and_pick=lambda cfg, cwd: Pick("todo:b.ts:1", "b umsetzen", "einfach"),
        run_gate=lambda cfg, cwd: GateResult(passed=False, steps=[GateStep(["npm", "test"], 1, "fail")]),
        commit_and_pr=lambda cfg, cwd, prompt: (_ for _ in ()).throw(AssertionError("kein Commit")),
    )
    report = run_once(cfg, None, deps)
    assert report.status == "discarded"
    assert recorded == [("todo:b.ts:1", "discarded")]
    assert len(resets) == 1  # Worktree nach discard zurückgesetzt


def test_run_once_manual_prompt_skips_triage_and_recording(tmp_path):
    global sent, recorded, resets
    sent, recorded, resets = [], [], []
    cfg = Config.default()
    cfg = Config(**{**cfg.__dict__, "pause_flag": tmp_path / "nope.pause"})
    deps = base_deps(triage_and_pick=lambda cfg, cwd: (_ for _ in ()).throw(AssertionError("Triage darf nicht laufen")))
    report = run_once(cfg, "manueller Auftrag", deps)  # String -> kein Triage
    assert report.status == "committed"
    assert recorded == []  # manueller Lauf zeichnet nichts auf


def test_run_once_impl_fail_resets_worktree(tmp_path):
    global sent, recorded, resets
    sent, recorded, resets = [], [], []
    cfg = Config.default()
    cfg = Config(**{**cfg.__dict__, "pause_flag": tmp_path / "nope.pause"})
    deps = base_deps(implement_task=lambda cfg, cwd, prompt: RunOutcome(ok=False, output="claude weg"))
    report = run_once(cfg, "manuell", deps)
    assert report.status == "impl_failed"
    assert len(resets) == 1  # auch manueller Fehllauf setzt Worktree zurück
```

- [ ] **Step 2: Test läuft, FEHLSCHLAG bestätigen**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_orchestrator.py -v`
Expected: FAIL (neue Triage-Tests scheitern; ggf. AttributeError bis Reset/Record verdrahtet ist)

- [ ] **Step 3: Implementieren** (`orchestrator.py`)

Imports oben ergänzen:
```python
from .report import build_digest, build_nothing_digest
```
`RunReport`-Kommentar erweitern und `run_once` ersetzen:
```python
@dataclass
class RunReport:
    status: str  # "paused" | "committed" | "discarded" | "impl_failed" | "nothing_to_do"


def run_once(cfg: Config, task_prompt, deps) -> RunReport:
    """Ein Lauf: Pause → Worktree → [Triage] → Impl → Gate → Scope → Cap → Commit."""
    if cfg.pause_flag.exists():
        return RunReport(status="paused")

    cwd = deps.prepare_worktree(cfg)

    pick = None
    if task_prompt is None:
        pick = deps.triage_and_pick(cfg, cwd)
        if pick is None:
            deps.send_digest(build_nothing_digest(deps.quarantined(cfg)))
            return RunReport(status="nothing_to_do")
        task_prompt = pick.task_prompt
    reason = pick.reason if pick is not None else ""

    outcome = deps.implement_task(cfg, cwd, task_prompt)
    if not outcome.ok:
        deps.send_digest(build_digest(task_prompt, outcome, _empty_gate(), committed=False, reason=reason))
        return _finalize(deps, cfg, cwd, pick, "impl_failed")

    gate = deps.run_gate(cfg, cwd)
    if not gate.passed:
        deps.send_digest(build_digest(task_prompt, outcome, gate, committed=False, reason=reason))
        return _finalize(deps, cfg, cwd, pick, "discarded")

    changed = deps.list_changed_files(cfg, cwd)
    scope = check_scope(cfg, changed)
    if not scope.ok:
        deps.send_digest(build_digest(task_prompt, outcome, gate, committed=False, scope_violations=scope.violations, reason=reason))
        return _finalize(deps, cfg, cwd, pick, "discarded")

    lines = deps.count_diff_lines(cfg, cwd)
    if lines > cfg.max_diff_lines:
        deps.send_digest(build_digest(task_prompt, outcome, gate, committed=False, cap_exceeded=True, reason=reason))
        return _finalize(deps, cfg, cwd, pick, "discarded")

    deps.commit_and_pr(cfg, cwd, task_prompt)
    deps.send_digest(build_digest(task_prompt, outcome, gate, committed=True, reason=reason))
    return _finalize(deps, cfg, cwd, pick, "committed")


def _finalize(deps, cfg, cwd, pick, status) -> RunReport:
    if pick is not None:
        deps.record_triage_outcome(cfg, pick.chosen_key, status)
    if status in ("impl_failed", "discarded"):
        deps.reset_worktree(cfg, cwd)
    return RunReport(status=status)
```
`_build_default_deps` um die vier neuen Callables ergänzen:
```python
        triage_and_pick=lambda cfg, cwd: _triage_and_pick(cfg, cwd),
        record_triage_outcome=_record_triage_outcome,
        reset_worktree=_reset_worktree,
        quarantined=_quarantined,
```
und die Default-Helfer am Dateiende ergänzen:
```python
def _triage_and_pick(cfg, cwd):  # pragma: no cover - echte Triage beim Deploy
    from .triage.pick import triage_and_pick
    return triage_and_pick(cfg, cwd)


def _record_triage_outcome(cfg, key, status):
    from .triage.state import load_state, record_outcome, save_state
    state = load_state(cfg.triage_state_path)
    record_outcome(state, key, status)
    save_state(cfg.triage_state_path, state)


def _quarantined(cfg):
    from .triage.state import load_state, quarantined_keys
    return quarantined_keys(load_state(cfg.triage_state_path))


def _reset_worktree(cfg, cwd):  # pragma: no cover - echter Git-Reset beim Deploy
    import subprocess
    subprocess.run(["git", "-C", str(cwd), "reset", "--hard"], check=False)
    subprocess.run(["git", "-C", str(cwd), "clean", "-fd"], check=False)
```
Außerdem in `main()` den CLI-Auftrag optional machen (kein Auftrag → Triage-Modus):
```python
    parser.add_argument("task_prompt", nargs="?", default=None, help="Aufgabe (leer = Triage wählt selbst)")
```

- [ ] **Step 4: Tests grün + volle Suite**

Run: `cd tools/academy-auto && python3 -m pytest tests/ -v`
Expected: PASS (alle bestehenden + neue; die bestehenden Orchestrator-Tests laufen dank ergänztem `base_deps` weiter)

- [ ] **Step 5: Commit**

```bash
git add tools/academy-auto/academy_auto/orchestrator.py tools/academy-auto/tests/test_orchestrator.py
git commit -m "feat(academy-auto): Orchestrator Triage-Modus + State-Aufzeichnung + Worktree-Reset"
```

---

## Self-Review

- **Spec-Coverage (T-Phase 2):** haiku-Ranker → Task 1; scan→filter→rank-Verdrahtung → Task 2; Digest (Grund + Quarantäne + nichts-zu-tun) → Task 3; Orchestrator-Integration + State-Aufzeichnung + Worktree-Reset-Vorbedingung → Task 4. Baseline-Delta-Gate bleibt T-Phase 3.
- **Platzhalter:** keine; jeder Schritt enthält vollständigen Code + Kommandos.
- **Typ-Konsistenz:** `Pick`-Felder, `rank`/`triage_and_pick`-Signaturen, `deps`-Callables (`triage_and_pick`, `record_triage_outcome`, `reset_worktree`, `quarantined`), `build_digest`-Zusatzparameter und `RunReport.status="nothing_to_do"` durchgängig identisch verwendet. `_finalize` zeichnet nur bei `pick is not None` auf und resettet nur bei `impl_failed`/`discarded` — konsistent mit den Global Constraints.
