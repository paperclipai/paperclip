# Academy-Auto Triage T-Phase 3 (Baseline-Delta-Gate) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Das Gate misst Fehler zahlmäßig statt nur pass/fail; ist die Baseline schon rot, gilt ein Delta-Gate (Erfolg = weniger Fehler als vorher und keine neuen), sodass sich das System aus einem roten Zustand herausarbeiten kann — bei grüner Baseline bleibt das absolute Gate unverändert.

**Architecture:** Baut auf T-Phase 1+2. Neu in `gate.py`: `measure_gate` (zählt Fehler je Schritt, kein fail-fast) + `delta_decision` (absolut bei grüner Baseline, Delta bei roter). `report.py` bekommt einen optionalen `gate_note`. `orchestrator.py` misst die Baseline vor der Implementierung (steuert `baseline_red` an die Triage), misst nach der Implementierung erneut und entscheidet per `delta_decision` statt `run_gate`.

**Tech Stack:** Python 3 (stdlib: `re`, `subprocess`, `dataclasses`) + pytest.

## Global Constraints

- Nur stdlib + pytest, keine neuen Laufzeit-Abhängigkeiten.
- Arbeit ausschließlich unter `tools/academy-auto/`; niemals `git add -A`/`.`, nur explizite Pfade.
- Fehlerzählung je Gate-Schritt: tsc = Anzahl `error TS`-Zeilen (bzw. `Found N errors`); jest (`npm test`) = `(\d+) failed` sonst returncode-basiert (0→0, sonst 1); lint = `(\d+) error` sonst returncode-basiert.
- `measure_gate` führt ALLE Schritte aus (kein fail-fast), mit `timeout` (Konstante `GATE_TIMEOUT = 180`).
- Delta-Regel: Baseline `total == 0` (grün) → Erfolg nur bei `after.total == 0` (absolut). Baseline `total > 0` (rot) → Erfolg bei `after.total < baseline.total` UND kein Schritt schlechter (`after.count <= baseline.count` je Schritt).
- Reihenfolge in `run_once` bleibt sicherheitskritisch: Pause → Worktree → **Baseline messen** → [Triage mit baseline_red] → Impl → **After messen + Delta** → Scope → Cap → Commit. Scope-Zaun und Diff-Cap unverändert NACH dem Gate.
- Bestehende Tests müssen grün bleiben (aktuell 77).

---

## File Structure

- Modify: `tools/academy-auto/academy_auto/gate.py` — `StepMeasure`, `GateMeasure`, `_count_step_errors`, `measure_gate`, `DeltaResult`, `delta_decision`
- Modify: `tools/academy-auto/academy_auto/report.py` — optionaler `gate_note`, `gate_result` optional
- Modify: `tools/academy-auto/academy_auto/orchestrator.py` — Baseline/After-Messung + Delta statt `run_gate`, `baseline_red` an Triage
- Test: `tests/test_gate.py` (erweitert), `tests/test_report.py` (erweitert), `tests/test_orchestrator.py` (angepasst)

---

## Task 1: Messender Gate (`measure_gate`)

**Files:**
- Modify: `tools/academy-auto/academy_auto/gate.py`
- Test: `tools/academy-auto/tests/test_gate.py`

**Interfaces:**
- Consumes: `Config` (gate_commands).
- Produces: `StepMeasure` (dataclass `cmd: list[str]`, `count: int`); `GateMeasure` (dataclass `steps: list[StepMeasure]`, `total: int`); `_count_step_errors(cmd, output, returncode) -> int`; `measure_gate(cfg, cwd, runner=subprocess.run) -> GateMeasure`. Konstante `GATE_TIMEOUT = 180`.

- [ ] **Step 1: Failing test schreiben** (an `tests/test_gate.py` anhängen)

```python
from academy_auto.gate import measure_gate, GateMeasure, _count_step_errors, GATE_TIMEOUT


def test_count_step_errors_tsc():
    out = "src/a.ts(1,2): error TS2322: x\nsrc/b.ts(3,4): error TS2531: y\nFound 2 errors.\n"
    assert _count_step_errors(["npx", "tsc", "--noEmit"], out, 2) == 2


def test_count_step_errors_jest_failed_count():
    out = "Tests:       3 failed, 5 passed, 8 total\n"
    assert _count_step_errors(["npm", "test"], out, 1) == 3


def test_count_step_errors_jest_green():
    assert _count_step_errors(["npm", "test"], "Tests: 8 passed", 0) == 0


def test_count_step_errors_lint():
    out = "✖ 4 problems (4 errors, 0 warnings)\n"
    assert _count_step_errors(["npm", "run", "lint"], out, 1) == 4


def test_count_step_errors_returncode_fallback():
    # kein parsbares Muster, aber returncode != 0 -> mindestens 1
    assert _count_step_errors(["npm", "run", "lint"], "irgendwas kaputt", 1) == 1
    assert _count_step_errors(["npm", "run", "lint"], "alles gut", 0) == 0


def test_measure_gate_runs_all_steps_no_failfast():
    # Reihenfolge gate_commands: npm test, npx tsc, npm run lint
    outputs = {
        "npm test": ("Tests: 1 failed, 2 total", 1),
        "npx tsc --noEmit": ("Found 2 errors.", 2),
        "npm run lint": ("✖ 0 problems", 0),
    }
    def runner(cmd, **kwargs):
        out, rc = outputs[" ".join(cmd)]
        class R:
            stdout = out; stderr = ""; returncode = rc
        return R()
    from academy_auto.config import Config
    m = measure_gate(Config.default(), "/tmp/wt", runner=runner)
    assert isinstance(m, GateMeasure)
    assert len(m.steps) == 3  # ALLE Schritte, kein fail-fast
    assert m.total == 3  # 1 (jest) + 2 (tsc) + 0 (lint)


def test_measure_gate_passes_timeout():
    captured = {}
    def runner(cmd, **kwargs):
        captured.update(kwargs)
        class R:
            stdout = ""; stderr = ""; returncode = 0
        return R()
    from academy_auto.config import Config
    measure_gate(Config.default(), "/tmp/wt", runner=runner)
    assert captured.get("timeout") == GATE_TIMEOUT
```

- [ ] **Step 2: Test läuft, FEHLSCHLAG bestätigen**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_gate.py -k "measure or count" -v`
Expected: FAIL (`ImportError: cannot import name 'measure_gate'`)

- [ ] **Step 3: Implementieren** (an `gate.py` anhängen; `import re` oben ergänzen)

```python
import re

GATE_TIMEOUT = 180


@dataclass
class StepMeasure:
    cmd: list[str]
    count: int


@dataclass
class GateMeasure:
    steps: list[StepMeasure]
    total: int


def _count_step_errors(cmd, output: str, returncode: int) -> int:
    joined = " ".join(cmd)
    text = output or ""
    if "tsc" in joined:
        m = re.search(r"Found (\d+) error", text)
        if m:
            return int(m.group(1))
        n = len(re.findall(r"error TS\d+", text))
        return n if n else (0 if returncode == 0 else 1)
    if "test" in joined:  # jest
        m = re.search(r"(\d+) failed", text)
        if m:
            return int(m.group(1))
        return 0 if returncode == 0 else 1
    # lint
    m = re.search(r"(\d+) error", text)
    if m:
        return int(m.group(1))
    return 0 if returncode == 0 else 1


def measure_gate(cfg: Config, cwd, runner=subprocess.run) -> GateMeasure:
    """Alle Gate-Schritte ausführen (kein fail-fast) und Fehler je Schritt zählen."""
    steps: list[StepMeasure] = []
    for cmd in cfg.gate_commands:
        try:
            proc = runner(cmd, cwd=str(cwd), capture_output=True, text=True, check=False, timeout=GATE_TIMEOUT)
        except Exception:
            # Timeout / Crash eines Schritts: als „mindestens ein Fehler" werten (nie grün fälschen)
            steps.append(StepMeasure(cmd=cmd, count=1))
            continue
        output = (getattr(proc, "stdout", "") or "") + (getattr(proc, "stderr", "") or "")
        steps.append(StepMeasure(cmd=cmd, count=_count_step_errors(cmd, output, proc.returncode)))
    total = sum(s.count for s in steps)
    return GateMeasure(steps=steps, total=total)
```

- [ ] **Step 4: Tests grün**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_gate.py -v`
Expected: PASS (alle, inkl. bestehender run_gate-Tests)

- [ ] **Step 5: Commit**

```bash
git add tools/academy-auto/academy_auto/gate.py tools/academy-auto/tests/test_gate.py
git commit -m "feat(academy-auto): messender Gate (Fehler je Schritt, kein fail-fast, Timeout)"
```

---

## Task 2: Delta-Entscheidung + Digest-Notiz

**Files:**
- Modify: `tools/academy-auto/academy_auto/gate.py`
- Modify: `tools/academy-auto/academy_auto/report.py`
- Test: `tools/academy-auto/tests/test_gate.py`, `tools/academy-auto/tests/test_report.py`

**Interfaces:**
- Consumes: `GateMeasure`/`StepMeasure` (Task 1).
- Produces: `DeltaResult` (dataclass `passed: bool`, `mode: str`, `note: str`); `delta_decision(baseline, after) -> DeltaResult`. `report.build_digest` bekommt `gate_note: str = ""` und `gate_result` wird optional (`gate_result=None`): bei gesetztem `gate_note` wird dieser als Gate-Zeile genutzt; bei `gate_result is None` und leerem `gate_note` entfällt die Gate-Zeile.

- [ ] **Step 1: Failing test schreiben**

An `tests/test_gate.py`:
```python
from academy_auto.gate import delta_decision, GateMeasure, StepMeasure, DeltaResult


def _measure(jest, tsc, lint):
    return GateMeasure(
        steps=[StepMeasure(["npm", "test"], jest), StepMeasure(["npx", "tsc", "--noEmit"], tsc), StepMeasure(["npm", "run", "lint"], lint)],
        total=jest + tsc + lint,
    )


def test_delta_absolute_pass_when_baseline_green():
    d = delta_decision(_measure(0, 0, 0), _measure(0, 0, 0))
    assert d.passed is True and d.mode == "absolut"


def test_delta_absolute_fail_when_baseline_green_but_after_red():
    d = delta_decision(_measure(0, 0, 0), _measure(0, 1, 0))
    assert d.passed is False and d.mode == "absolut"


def test_delta_pass_when_baseline_red_and_fewer_errors():
    d = delta_decision(_measure(0, 5, 0), _measure(0, 2, 0))
    assert d.passed is True and d.mode == "delta"
    assert "5" in d.note and "2" in d.note


def test_delta_fail_when_no_progress():
    d = delta_decision(_measure(0, 5, 0), _measure(0, 5, 0))
    assert d.passed is False and d.mode == "delta"


def test_delta_fail_when_a_step_got_worse_even_if_total_lower():
    # tsc runter (5->1), aber lint hoch (0->1): ein Schritt schlechter -> kein Delta-Pass
    d = delta_decision(_measure(0, 5, 0), _measure(0, 1, 1))
    assert d.passed is False
```

An `tests/test_report.py`:
```python
def test_build_digest_uses_gate_note_when_set():
    from academy_auto.runner import RunOutcome
    from academy_auto.report import build_digest
    text = build_digest(
        task_prompt="x", run_outcome=RunOutcome(ok=True, output=""),
        gate_result=None, committed=True, gate_note="Delta grün (Fehler 5→2)",
    )
    assert "Delta grün (Fehler 5→2)" in text
    assert "Gate: Delta grün" in text
```

- [ ] **Step 2: Test läuft, FEHLSCHLAG bestätigen**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_gate.py -k delta tests/test_report.py -k gate_note -v`
Expected: FAIL (`cannot import name 'delta_decision'` / `gate_note`)

- [ ] **Step 3: Implementieren**

An `gate.py`:
```python
@dataclass
class DeltaResult:
    passed: bool
    mode: str   # "absolut" | "delta"
    note: str


def delta_decision(baseline: GateMeasure, after: GateMeasure) -> DeltaResult:
    """Absolutes Gate bei grüner Baseline, sonst Delta (weniger Fehler + kein Schritt schlechter)."""
    if baseline.total == 0:
        if after.total == 0:
            return DeltaResult(True, "absolut", "grün (absolut)")
        return DeltaResult(False, "absolut", f"rot (Fehler: {after.total})")
    base_by = {tuple(s.cmd): s.count for s in baseline.steps}
    no_regression = all(s.count <= base_by.get(tuple(s.cmd), 0) for s in after.steps)
    improved = after.total < baseline.total
    if no_regression and improved:
        return DeltaResult(True, "delta", f"Delta grün (Fehler {baseline.total}→{after.total})")
    return DeltaResult(False, "delta", f"rot (Fehler {baseline.total}→{after.total}, kein Fortschritt)")
```

In `report.py` — Signatur `build_digest` anpassen: `gate_result` optional + neuer `gate_note`:
```python
def build_digest(
    task_prompt: str,
    run_outcome: RunOutcome,
    gate_result: GateResult | None = None,
    committed: bool = False,
    cap_exceeded: bool = False,
    scope_violations: list[str] | None = None,
    reason: str = "",
    quarantined: list[str] | None = None,
    gate_note: str = "",
) -> str:
```
und den Gate-Block ersetzen durch:
```python
    if gate_note:
        lines.append(f"Gate: {gate_note}")
    elif gate_result is not None:
        if gate_result.passed:
            lines.append("Gate: grün (jest + tsc + lint)")
        else:
            failing = gate_result.steps[-1] if gate_result.steps else None
            cmd = " ".join(failing.cmd) if failing else "unbekannt"
            lines.append(f"Gate: rot bei `{cmd}`")
```
(Der Import `from .gate import GateResult` bleibt.)

- [ ] **Step 4: Tests grün**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_gate.py tests/test_report.py -v`
Expected: PASS (alle, inkl. bestehender Digest-Tests — `committed` ist jetzt Keyword mit Default, bestehende positionale Aufrufe `build_digest(prompt, outcome, gate, committed=False)` bleiben gültig)

- [ ] **Step 5: Commit**

```bash
git add tools/academy-auto/academy_auto/gate.py tools/academy-auto/academy_auto/report.py tools/academy-auto/tests/test_gate.py tools/academy-auto/tests/test_report.py
git commit -m "feat(academy-auto): Delta-Entscheidung (absolut/delta) + Digest gate_note"
```

---

## Task 3: Orchestrator-Integration (Baseline/After-Messung + Delta)

**Files:**
- Modify: `tools/academy-auto/academy_auto/orchestrator.py`
- Test: `tools/academy-auto/tests/test_orchestrator.py`

**Interfaces:**
- Consumes: `measure_gate`/`delta_decision` (gate.py).
- Produces: `run_once` misst Baseline (vor Impl) und After (nach Impl), entscheidet per `delta_decision`; `deps.triage_and_pick(cfg, cwd, baseline_red)` bekommt `baseline_red`; `deps.measure_gate(cfg, cwd)` ersetzt `deps.run_gate`. Digest nutzt `gate_note=delta.note`.

- [ ] **Step 1: Failing test schreiben** (`tests/test_orchestrator.py` anpassen)

`base_deps` anpassen: `run_gate` entfernen, `measure_gate` + `triage_and_pick`-Signatur ergänzen. Hilfs-Helfer für Baseline/After:
```python
from academy_auto.gate import GateMeasure, StepMeasure

def _measure(total):
    # ein Schritt trägt den ganzen Fehler-Count
    return GateMeasure(steps=[StepMeasure(["npx", "tsc", "--noEmit"], total)], total=total)

def base_deps(**over):
    d = dict(
        prepare_worktree=lambda cfg: cfg.worktree_path,
        measure_gate=lambda cfg, cwd: _measure(0),   # default: grün (Baseline und After)
        implement_task=lambda cfg, cwd, prompt: RunOutcome(ok=True, output="done"),
        commit_and_pr=lambda cfg, cwd, prompt: True,
        send_digest=lambda text: sent.append(text),
        count_diff_lines=lambda cfg, cwd: 10,
        list_changed_files=lambda cfg, cwd: ["src/App.tsx"],
        triage_and_pick=lambda cfg, cwd, baseline_red: None,
        record_triage_outcome=lambda cfg, key, status: recorded.append((key, status)),
        reset_worktree=lambda cfg, cwd: resets.append(cwd),
        quarantined=lambda cfg: [],
    )
    d.update(over)
    return SimpleNamespace(**d)
```
Bestehende Tests, die `run_gate=lambda...: GateResult(passed=False,...)` setzten, auf `measure_gate` umstellen. Beispiel für den bisherigen „rotes Gate → discarded"-Test:
```python
def test_run_once_red_gate_discards_and_reports(tmp_path):
    global sent, recorded, resets
    sent, recorded, resets = [], [], []
    cfg = Config.default()
    cfg = Config(**{**cfg.__dict__, "pause_flag": tmp_path / "nope.pause"})
    deps = base_deps(
        measure_gate=lambda cfg, cwd: _measure(0) if not measure_calls.append(1) and len(measure_calls) == 1 else _measure(3),
        commit_and_pr=lambda cfg, cwd, prompt: (_ for _ in ()).throw(AssertionError("kein Commit")),
    )
    report = run_once(cfg, "manuell", deps)
    assert report.status == "discarded"
```
Weil zwei Messungen (Baseline + After) nötig sind, ist ein Call-Zähler robuster. Standardisiere ihn oben in der Datei:
```python
measure_calls = []

def two_stage_measure(baseline_total, after_total):
    seq = [baseline_total, after_total]
    def m(cfg, cwd):
        return _measure(seq.pop(0))
    return m
```
und nutze in Tests `measure_gate=two_stage_measure(baseline, after)`.

Neue/angepasste Tests:
```python
def test_run_once_green_baseline_absolute_pass_commits(tmp_path):
    global sent, recorded, resets
    sent, recorded, resets = [], [], []
    cfg = Config.default(); cfg = Config(**{**cfg.__dict__, "pause_flag": tmp_path / "nope.pause"})
    deps = base_deps(measure_gate=two_stage_measure(0, 0))  # grün → grün
    assert run_once(cfg, "manuell", deps).status == "committed"


def test_run_once_green_baseline_after_red_discards(tmp_path):
    global sent, recorded, resets
    sent, recorded, resets = [], [], []
    cfg = Config.default(); cfg = Config(**{**cfg.__dict__, "pause_flag": tmp_path / "nope.pause"})
    deps = base_deps(
        measure_gate=two_stage_measure(0, 2),  # grün → rot: neuer Fehler → discard
        commit_and_pr=lambda cfg, cwd, prompt: (_ for _ in ()).throw(AssertionError("kein Commit")),
    )
    r = run_once(cfg, "manuell", deps)
    assert r.status == "discarded"
    assert len(resets) == 1


def test_run_once_red_baseline_delta_progress_commits(tmp_path):
    global sent, recorded, resets
    sent, recorded, resets = [], [], []
    cfg = Config.default(); cfg = Config(**{**cfg.__dict__, "pause_flag": tmp_path / "nope.pause"})
    deps = base_deps(measure_gate=two_stage_measure(5, 2))  # rot → weniger Fehler → Delta-Commit
    r = run_once(cfg, "manuell", deps)
    assert r.status == "committed"
    assert any("Delta" in s for s in sent)


def test_run_once_red_baseline_no_progress_discards(tmp_path):
    global sent, recorded, resets
    sent, recorded, resets = [], [], []
    cfg = Config.default(); cfg = Config(**{**cfg.__dict__, "pause_flag": tmp_path / "nope.pause"})
    deps = base_deps(
        measure_gate=two_stage_measure(5, 5),  # rot → kein Fortschritt → discard
        commit_and_pr=lambda cfg, cwd, prompt: (_ for _ in ()).throw(AssertionError("kein Commit")),
    )
    assert run_once(cfg, "manuell", deps).status == "discarded"


def test_run_once_triage_receives_baseline_red(tmp_path):
    global sent, recorded, resets
    sent, recorded, resets = [], [], []
    from academy_auto.triage.rank import Pick
    cfg = Config.default(); cfg = Config(**{**cfg.__dict__, "pause_flag": tmp_path / "nope.pause"})
    seen = {}
    def tp(cfg, cwd, baseline_red):
        seen["red"] = baseline_red
        return Pick("todo:b.ts:1", "b umsetzen", "grund")
    deps = base_deps(measure_gate=two_stage_measure(4, 1), triage_and_pick=tp)
    run_once(cfg, None, deps)  # Triage-Modus, Baseline rot
    assert seen["red"] is True
```
Die übrigen bestehenden Tests (Scope/Cap/Impl-Fehler/committed/nothing_to_do/manual) auf die neuen `base_deps` (mit `measure_gate` statt `run_gate`, `triage_and_pick`-3-Arg-Signatur) umstellen; ihr erwartetes Verhalten bleibt unverändert (Baseline grün + After grün = committed, sofern nicht gezielt anders gesetzt).

- [ ] **Step 2: Test läuft, FEHLSCHLAG bestätigen**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_orchestrator.py -v`
Expected: FAIL (run_once nutzt noch run_gate / kennt measure_gate+delta nicht)

- [ ] **Step 3: Implementieren** (`orchestrator.py`)

Imports oben ergänzen:
```python
from .gate import delta_decision
from .report import build_digest, build_nothing_digest
```
`run_once` umbauen — Baseline vor Triage, After nach Impl, Delta statt Gate:
```python
def run_once(cfg: Config, task_prompt, deps) -> RunReport:
    """Pause → Worktree → Baseline → [Triage] → Impl → After+Delta → Scope → Cap → Commit."""
    if cfg.pause_flag.exists():
        return RunReport(status="paused")

    cwd = deps.prepare_worktree(cfg)
    quar = deps.quarantined(cfg)

    baseline = deps.measure_gate(cfg, cwd)
    baseline_red = baseline.total > 0

    pick = None
    if task_prompt is None:
        pick = deps.triage_and_pick(cfg, cwd, baseline_red)
        if pick is None:
            deps.send_digest(build_nothing_digest(quar))
            return RunReport(status="nothing_to_do")
        task_prompt = pick.task_prompt
    reason = pick.reason if pick is not None else ""

    outcome = deps.implement_task(cfg, cwd, task_prompt)
    if not outcome.ok:
        deps.send_digest(build_digest(task_prompt, outcome, None, committed=False, reason=reason, quarantined=quar, gate_note="Umsetzung fehlgeschlagen"))
        return _finalize(deps, cfg, cwd, pick, "impl_failed")

    after = deps.measure_gate(cfg, cwd)
    delta = delta_decision(baseline, after)
    if not delta.passed:
        deps.send_digest(build_digest(task_prompt, outcome, None, committed=False, reason=reason, quarantined=quar, gate_note=delta.note))
        return _finalize(deps, cfg, cwd, pick, "discarded")

    changed = deps.list_changed_files(cfg, cwd)
    scope = check_scope(cfg, changed)
    if not scope.ok:
        deps.send_digest(build_digest(task_prompt, outcome, None, committed=False, scope_violations=scope.violations, reason=reason, quarantined=quar, gate_note=delta.note))
        return _finalize(deps, cfg, cwd, pick, "discarded")

    lines = deps.count_diff_lines(cfg, cwd)
    if lines > cfg.max_diff_lines:
        deps.send_digest(build_digest(task_prompt, outcome, None, committed=False, cap_exceeded=True, reason=reason, quarantined=quar, gate_note=delta.note))
        return _finalize(deps, cfg, cwd, pick, "discarded")

    deps.commit_and_pr(cfg, cwd, task_prompt)
    deps.send_digest(build_digest(task_prompt, outcome, None, committed=True, reason=reason, quarantined=quar, gate_note=delta.note))
    return _finalize(deps, cfg, cwd, pick, "committed")
```
`_empty_gate` wird nicht mehr gebraucht (kann bleiben oder entfernt werden — belassen ist ok). `_build_default_deps` anpassen: `run_gate` durch `measure_gate` ersetzen, `triage_and_pick` mit 3 Args:
```python
        measure_gate=lambda cfg, cwd: gate.measure_gate(cfg, cwd),
        triage_and_pick=lambda cfg, cwd, baseline_red: _triage_and_pick(cfg, cwd, baseline_red),
```
und `_triage_and_pick` erweitern:
```python
def _triage_and_pick(cfg, cwd, baseline_red):  # pragma: no cover - echte Triage beim Deploy
    from .triage.pick import triage_and_pick
    return triage_and_pick(cfg, cwd, baseline_red=baseline_red)
```
(Der Import `from . import worktree, gate, runner, report` in `main`/`_build_default_deps` liefert `gate.measure_gate`.)

- [ ] **Step 4: Tests grün + volle Suite**

Run: `cd tools/academy-auto && python3 -m pytest tests/ -v`
Expected: PASS (alle — bestehende auf measure_gate umgestellt + neue Delta-Tests)

- [ ] **Step 5: Commit**

```bash
git add tools/academy-auto/academy_auto/orchestrator.py tools/academy-auto/tests/test_orchestrator.py
git commit -m "feat(academy-auto): Baseline-Delta-Gate im Orchestrator (baseline_red an Triage)"
```

---

## Self-Review

- **Spec-Coverage (T-Phase 3):** Baseline-Snapshot → Task 1 (`measure_gate`); Delta-Regel (absolut/delta) → Task 2 (`delta_decision`); Orchestrator misst Baseline+After, steuert `baseline_red` an die Triage, entscheidet per Delta → Task 3. Damit ist die in der Spec beschriebene Gate-Wechselwirkung vollständig umgesetzt.
- **Platzhalter:** keine; jeder Schritt enthält vollständigen Code + Kommandos.
- **Typ-Konsistenz:** `StepMeasure`/`GateMeasure`/`DeltaResult`, `measure_gate`/`delta_decision`, `gate_note`, `triage_and_pick(cfg, cwd, baseline_red)` durchgängig identisch. `measure_gate` fälscht bei Timeout/Crash NIE grün (count=1). Delta-Regel: absolute Prüfung bei grüner Baseline erhält das bestehende Sicherheitsniveau; Delta erlaubt Fortschritt nur ohne Verschlechterung eines Schritts.
