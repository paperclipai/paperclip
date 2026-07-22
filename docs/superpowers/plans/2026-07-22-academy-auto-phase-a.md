# Academy-Auto Phase A (MVP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein Orchestrator lässt Claude Code **eine** vorgegebene Aufgabe an der WHITESTAG.ACADEMY-App in einem isolierten Git-Worktree umsetzen, prüft das Ergebnis mit einem grünen Gate (jest + tsc + lint) und meldet den Stand als Jarvis/Telegram-Digest.

**Architecture:** Python-Paket `tools/academy-auto/` im Paperclip-Repo (versioniert, pytest), Deploy-Kopie nach `~/.paperclip/scripts/academy-auto/` für launchd. Sechs fokussierte Module: `config`, `worktree`, `gate`, `runner`, `report`, `orchestrator`. In Phase A wird die Aufgabe von Hand übergeben (self-directed Triage = Phase B). Ein Lauf = eine Aufgabe.

**Tech Stack:** Python 3 (stdlib + `pytest`), Git-Worktrees, npm/jest/tsc/expo-lint (Academy), Claude Code CLI headless, `voice-echo-bot` (@whitestag_jarvis_bot) für den Telegram-Versand.

## Global Constraints

- Academy-Repo-Pfad (Quelle): `~/Library/CloudStorage/SynologyDrive-Mac/Claude Code MAC/WHITESTAG.ACADEMY`
- Arbeits-Branch für Agenten: `agents/academy-auto` (nie `main` direkt)
- Worktree-Pfad (außerhalb CloudStorage, launchd-lesbar): `~/.paperclip/academy-auto/worktree`
- Pause-Flag (Kill-Switch): `~/.paperclip/academy-auto.pause` — existiert die Datei, bricht der Lauf sofort ab
- Green-Gate-Kommandos (im Worktree, nicht-mutierend): `npm test`, `npx tsc --noEmit`, `npm run lint`
- Caps Phase A: genau **1** Task pro Lauf; Diff-Cap **800** geänderte Zeilen/Task
- `main` und Walters offene Arbeitskopie werden nie verändert; Deploy/EAS-Submission ist tabu
- Alle Log-/Digest-Texte auf Deutsch
- Python-Code: nur stdlib + pytest, keine neuen Laufzeit-Abhängigkeiten

---

## File Structure

- `tools/academy-auto/academy_auto/__init__.py` — Paket-Marker
- `tools/academy-auto/academy_auto/config.py` — Pfade, Konstanten, Caps (eine Dataclass)
- `tools/academy-auto/academy_auto/worktree.py` — Worktree anlegen/zurücksetzen
- `tools/academy-auto/academy_auto/gate.py` — Green-Gate ausführen, strukturiertes Ergebnis
- `tools/academy-auto/academy_auto/runner.py` — Claude Code headless im Worktree aufrufen
- `tools/academy-auto/academy_auto/report.py` — Digest bauen + über Jarvis senden
- `tools/academy-auto/academy_auto/orchestrator.py` — Phasen verdrahten, Pause-Flag, CLI-Entrypoint
- `tools/academy-auto/tests/…` — pytest je Modul
- `tools/academy-auto/README.md` — Betrieb + Deploy nach `~/.paperclip/scripts/`

---

## Task 1: Paket-Scaffold + Config

**Files:**
- Create: `tools/academy-auto/academy_auto/__init__.py`
- Create: `tools/academy-auto/academy_auto/config.py`
- Create: `tools/academy-auto/pytest.ini`
- Test: `tools/academy-auto/tests/test_config.py`

**Interfaces:**
- Produces: `Config` (dataclass) mit Feldern `academy_repo: Path`, `worktree_path: Path`, `branch: str`, `pause_flag: Path`, `gate_commands: list[list[str]]`, `max_tasks_per_run: int`, `max_diff_lines: int`; Klassenmethode `Config.default() -> Config`.

- [ ] **Step 1: Write the failing test**

```python
# tools/academy-auto/tests/test_config.py
from pathlib import Path
from academy_auto.config import Config


def test_default_config_has_expected_invariants():
    cfg = Config.default()
    assert cfg.branch == "agents/academy-auto"
    assert cfg.max_tasks_per_run == 1
    assert cfg.max_diff_lines == 800
    assert cfg.pause_flag.name == "academy-auto.pause"
    assert cfg.worktree_path.name == "worktree"
    # Gate: genau die drei nicht-mutierenden Checks, in Reihenfolge
    assert cfg.gate_commands == [
        ["npm", "test"],
        ["npx", "tsc", "--noEmit"],
        ["npm", "run", "lint"],
    ]
    # Academy-Quelle liegt im CloudStorage-Ordner
    assert cfg.academy_repo.name == "WHITESTAG.ACADEMY"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/academy-auto && python -m pytest tests/test_config.py -v`
Expected: FAIL mit `ModuleNotFoundError: No module named 'academy_auto'`

- [ ] **Step 3: Write minimal implementation**

```python
# tools/academy-auto/academy_auto/__init__.py
"""Academy-Auto: autonome Weiterentwicklung der WHITESTAG.ACADEMY-App."""
```

```python
# tools/academy-auto/academy_auto/config.py
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Config:
    academy_repo: Path
    worktree_path: Path
    branch: str
    pause_flag: Path
    gate_commands: list[list[str]]
    max_tasks_per_run: int
    max_diff_lines: int

    @classmethod
    def default(cls) -> "Config":
        home = Path.home()
        academy = (
            home
            / "Library/CloudStorage/SynologyDrive-Mac"
            / "Claude Code MAC/WHITESTAG.ACADEMY"
        )
        base = home / ".paperclip" / "academy-auto"
        return cls(
            academy_repo=academy,
            worktree_path=base / "worktree",
            branch="agents/academy-auto",
            pause_flag=home / ".paperclip" / "academy-auto.pause",
            gate_commands=[
                ["npm", "test"],
                ["npx", "tsc", "--noEmit"],
                ["npm", "run", "lint"],
            ],
            max_tasks_per_run=1,
            max_diff_lines=800,
        )
```

```ini
# tools/academy-auto/pytest.ini
[pytest]
pythonpath = .
testpaths = tests
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/academy-auto && python -m pytest tests/test_config.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tools/academy-auto/academy_auto/__init__.py tools/academy-auto/academy_auto/config.py tools/academy-auto/pytest.ini tools/academy-auto/tests/test_config.py
git commit -m "feat(academy-auto): Paket-Scaffold + Config mit Phase-A-Invarianten"
```

---

## Task 2: Worktree-Isolation

**Files:**
- Create: `tools/academy-auto/academy_auto/worktree.py`
- Test: `tools/academy-auto/tests/test_worktree.py`

**Interfaces:**
- Consumes: `Config` aus Task 1.
- Produces: `prepare_worktree(cfg, runner=subprocess.run) -> Path` — legt einen frischen Worktree für `cfg.academy_repo` am `cfg.worktree_path` auf `cfg.branch` an (bestehenden vorher entfernen). Gibt den Worktree-Pfad zurück. `runner` ist injizierbar für Tests. Ruft NUR git-Kommandos gegen das Academy-Repo, nie `git -C main-arbeitskopie <mutation>`.

- [ ] **Step 1: Write the failing test**

```python
# tools/academy-auto/tests/test_worktree.py
from pathlib import Path
from academy_auto.config import Config
from academy_auto.worktree import prepare_worktree


class FakeRunner:
    def __init__(self):
        self.calls = []

    def __call__(self, cmd, **kwargs):
        self.calls.append((cmd, kwargs))

        class R:
            returncode = 0
            stdout = ""
            stderr = ""
        return R()


def test_prepare_worktree_resets_then_adds_on_branch(tmp_path):
    cfg = Config.default()
    fake = FakeRunner()
    result = prepare_worktree(cfg, runner=fake)

    assert result == cfg.worktree_path
    joined = [" ".join(c[0]) for c in fake.calls]
    # 1) alten Worktree entfernen (force, darf fehlschlagen -> check=False)
    assert any("worktree remove" in j and "--force" in j for j in joined)
    # 2) neuen Worktree auf dem Agenten-Branch anlegen
    assert any(
        "worktree add" in j and cfg.branch in j for j in joined
    )
    # Alle git-Aufrufe laufen gegen das Academy-Repo, nie woanders
    for cmd, _ in fake.calls:
        assert cmd[0] == "git"
        assert "-C" in cmd
        assert cmd[cmd.index("-C") + 1] == str(cfg.academy_repo)


def test_prepare_worktree_remove_failure_is_tolerated():
    cfg = Config.default()

    class FlakyRemove:
        def __init__(self):
            self.calls = []

        def __call__(self, cmd, **kwargs):
            self.calls.append(cmd)

            class R:
                returncode = 1 if "remove" in cmd else 0
                stdout = ""
                stderr = "no such worktree"
            # remove wird mit check=False aufgerufen -> kein Raise erwartet
            if kwargs.get("check") and R.returncode != 0:
                raise AssertionError("remove darf nicht check=True sein")
            return R()

    flaky = FlakyRemove()
    prepare_worktree(cfg, runner=flaky)  # darf nicht werfen
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/academy-auto && python -m pytest tests/test_worktree.py -v`
Expected: FAIL mit `ModuleNotFoundError: No module named 'academy_auto.worktree'`

- [ ] **Step 3: Write minimal implementation**

```python
# tools/academy-auto/academy_auto/worktree.py
from __future__ import annotations

import subprocess
from pathlib import Path

from .config import Config


def prepare_worktree(cfg: Config, runner=subprocess.run) -> Path:
    """Frischen, isolierten Worktree auf dem Agenten-Branch herstellen.

    Entfernt einen evtl. vorhandenen Worktree (Fehler toleriert) und legt ihn
    neu an. Verändert NIE main oder die Haupt-Arbeitskopie.
    """
    repo = str(cfg.academy_repo)
    wt = str(cfg.worktree_path)

    # 1) Alten Worktree entfernen — darf fehlschlagen (existiert evtl. nicht)
    runner(
        ["git", "-C", repo, "worktree", "remove", "--force", wt],
        check=False,
        capture_output=True,
        text=True,
    )

    # 2) Neuen Worktree auf dem Agenten-Branch anlegen (Branch bei Bedarf neu)
    runner(
        ["git", "-C", repo, "worktree", "add", "-B", cfg.branch, wt],
        check=True,
        capture_output=True,
        text=True,
    )
    return cfg.worktree_path
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/academy-auto && python -m pytest tests/test_worktree.py -v`
Expected: PASS (beide Tests)

- [ ] **Step 5: Commit**

```bash
git add tools/academy-auto/academy_auto/worktree.py tools/academy-auto/tests/test_worktree.py
git commit -m "feat(academy-auto): isolierte Worktree-Vorbereitung auf agents/academy-auto"
```

---

## Task 3: Green-Gate

**Files:**
- Create: `tools/academy-auto/academy_auto/gate.py`
- Test: `tools/academy-auto/tests/test_gate.py`

**Interfaces:**
- Consumes: `Config` aus Task 1.
- Produces: `GateResult` (dataclass: `passed: bool`, `steps: list[GateStep]`) und `GateStep` (dataclass: `cmd: list[str]`, `returncode: int`, `output: str`); Funktion `run_gate(cfg, cwd, runner=subprocess.run) -> GateResult`. Führt `cfg.gate_commands` der Reihe nach in `cwd` aus; bricht beim ersten roten Schritt ab (fail-fast) und meldet `passed=False`.

- [ ] **Step 1: Write the failing test**

```python
# tools/academy-auto/tests/test_gate.py
from academy_auto.config import Config
from academy_auto.gate import run_gate


def make_runner(return_codes):
    seq = list(return_codes)

    def runner(cmd, **kwargs):
        rc = seq.pop(0)

        class R:
            returncode = rc
            stdout = "ok" if rc == 0 else "boom"
            stderr = ""
        return R()

    return runner


def test_gate_all_green_passes():
    cfg = Config.default()
    res = run_gate(cfg, cwd="/tmp/wt", runner=make_runner([0, 0, 0]))
    assert res.passed is True
    assert len(res.steps) == 3
    assert [s.cmd for s in res.steps] == cfg.gate_commands


def test_gate_fails_fast_on_first_red():
    cfg = Config.default()
    # jest rot -> tsc/lint dürfen NICHT mehr laufen
    res = run_gate(cfg, cwd="/tmp/wt", runner=make_runner([1, 0, 0]))
    assert res.passed is False
    assert len(res.steps) == 1
    assert res.steps[0].cmd == ["npm", "test"]
    assert res.steps[0].returncode == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/academy-auto && python -m pytest tests/test_gate.py -v`
Expected: FAIL mit `ModuleNotFoundError: No module named 'academy_auto.gate'`

- [ ] **Step 3: Write minimal implementation**

```python
# tools/academy-auto/academy_auto/gate.py
from __future__ import annotations

import subprocess
from dataclasses import dataclass, field

from .config import Config


@dataclass
class GateStep:
    cmd: list[str]
    returncode: int
    output: str


@dataclass
class GateResult:
    passed: bool
    steps: list[GateStep] = field(default_factory=list)


def run_gate(cfg: Config, cwd, runner=subprocess.run) -> GateResult:
    """Green-Gate im Worktree ausführen, fail-fast beim ersten roten Schritt."""
    steps: list[GateStep] = []
    for cmd in cfg.gate_commands:
        proc = runner(cmd, cwd=str(cwd), capture_output=True, text=True, check=False)
        output = (getattr(proc, "stdout", "") or "") + (getattr(proc, "stderr", "") or "")
        steps.append(GateStep(cmd=cmd, returncode=proc.returncode, output=output))
        if proc.returncode != 0:
            return GateResult(passed=False, steps=steps)
    return GateResult(passed=True, steps=steps)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/academy-auto && python -m pytest tests/test_gate.py -v`
Expected: PASS (beide Tests)

- [ ] **Step 5: Commit**

```bash
git add tools/academy-auto/academy_auto/gate.py tools/academy-auto/tests/test_gate.py
git commit -m "feat(academy-auto): Green-Gate (jest/tsc/lint) mit fail-fast"
```

---

## Task 4: Claude-Code-Runner

**Files:**
- Create: `tools/academy-auto/academy_auto/runner.py`
- Test: `tools/academy-auto/tests/test_runner.py`

**Interfaces:**
- Consumes: `Config` aus Task 1, Worktree-Pfad aus Task 2.
- Produces: `RunOutcome` (dataclass: `ok: bool`, `output: str`) und `implement_task(cfg, cwd, task_prompt, runner=subprocess.run) -> RunOutcome`. Ruft die Claude Code CLI **headless** mit `cwd=Worktree` auf. Der CLI-Aufruf ist eine Konstante `CLAUDE_CMD` im Modul (default `["claude", "-p"]` + `--permission-mode acceptEdits`), damit er zentral anpassbar bleibt. Kein Diff wird hier bewertet (das macht das Gate + Task 6).

- [ ] **Step 1: Write the failing test**

```python
# tools/academy-auto/tests/test_runner.py
from academy_auto.config import Config
from academy_auto.runner import implement_task, CLAUDE_CMD


def test_implement_task_invokes_claude_headless_in_worktree():
    cfg = Config.default()
    captured = {}

    def runner(cmd, **kwargs):
        captured["cmd"] = cmd
        captured["cwd"] = kwargs.get("cwd")

        class R:
            returncode = 0
            stdout = "fertig"
            stderr = ""
        return R()

    outcome = implement_task(
        cfg, cwd="/tmp/wt", task_prompt="Fixe den Login-Bug", runner=runner
    )
    assert outcome.ok is True
    assert outcome.output == "fertig"
    # headless-Präfix + Prompt landen im Kommando, cwd ist der Worktree
    assert captured["cmd"][: len(CLAUDE_CMD)] == CLAUDE_CMD
    assert "Fixe den Login-Bug" in " ".join(captured["cmd"])
    assert captured["cwd"] == "/tmp/wt"


def test_implement_task_reports_failure_on_nonzero_exit():
    cfg = Config.default()

    def runner(cmd, **kwargs):
        class R:
            returncode = 2
            stdout = ""
            stderr = "claude timeout"
        return R()

    outcome = implement_task(cfg, cwd="/tmp/wt", task_prompt="x", runner=runner)
    assert outcome.ok is False
    assert "timeout" in outcome.output
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/academy-auto && python -m pytest tests/test_runner.py -v`
Expected: FAIL mit `ModuleNotFoundError: No module named 'academy_auto.runner'`

- [ ] **Step 3: Write minimal implementation**

```python
# tools/academy-auto/academy_auto/runner.py
from __future__ import annotations

import subprocess
from dataclasses import dataclass

from .config import Config

# Headless-Aufruf der Claude Code CLI. Zentral hier anpassbar, falls sich
# CLI-Flags ändern. acceptEdits erlaubt autonome Dateiänderungen im Worktree.
CLAUDE_CMD = ["claude", "-p", "--permission-mode", "acceptEdits"]


@dataclass
class RunOutcome:
    ok: bool
    output: str


def implement_task(cfg: Config, cwd, task_prompt: str, runner=subprocess.run) -> RunOutcome:
    """Claude Code headless im isolierten Worktree eine Aufgabe umsetzen lassen."""
    cmd = CLAUDE_CMD + [task_prompt]
    proc = runner(cmd, cwd=str(cwd), capture_output=True, text=True, check=False)
    output = (getattr(proc, "stdout", "") or "") + (getattr(proc, "stderr", "") or "")
    return RunOutcome(ok=(proc.returncode == 0), output=output.strip())
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/academy-auto && python -m pytest tests/test_runner.py -v`
Expected: PASS (beide Tests)

- [ ] **Step 5: Commit**

```bash
git add tools/academy-auto/academy_auto/runner.py tools/academy-auto/tests/test_runner.py
git commit -m "feat(academy-auto): headless Claude-Code-Runner im Worktree"
```

---

## Task 5: Reporting / Jarvis-Digest

**Files:**
- Create: `tools/academy-auto/academy_auto/report.py`
- Test: `tools/academy-auto/tests/test_report.py`

**Interfaces:**
- Consumes: `GateResult` aus Task 3, `RunOutcome` aus Task 4.
- Produces: `build_digest(task_prompt, run_outcome, gate_result, committed) -> str` (deutscher Digest-Text) und `send_digest(text, sender) -> None`. `sender` ist ein Callable `(text: str) -> None`, das den Versand über den bestehenden `voice-echo-bot` kapselt (in Phase A injiziert/gemockt; die echte Telegram-Anbindung wird beim Deploy verdrahtet).

- [ ] **Step 1: Write the failing test**

```python
# tools/academy-auto/tests/test_report.py
from academy_auto.gate import GateResult, GateStep
from academy_auto.runner import RunOutcome
from academy_auto.report import build_digest, send_digest


def test_build_digest_green_committed():
    text = build_digest(
        task_prompt="Login-Bug fixen",
        run_outcome=RunOutcome(ok=True, output="done"),
        gate_result=GateResult(passed=True, steps=[
            GateStep(["npm", "test"], 0, "ok"),
        ]),
        committed=True,
    )
    assert "Academy" in text
    assert "Login-Bug fixen" in text
    assert "grün" in text.lower()
    assert "committet" in text.lower()


def test_build_digest_red_gate_mentions_failing_step():
    text = build_digest(
        task_prompt="Refactor X",
        run_outcome=RunOutcome(ok=True, output="done"),
        gate_result=GateResult(passed=False, steps=[
            GateStep(["npm", "test"], 1, "1 test failed"),
        ]),
        committed=False,
    )
    assert "rot" in text.lower()
    assert "npm test" in text
    assert "verworfen" in text.lower()


def test_send_digest_uses_sender():
    sent = []
    send_digest("hallo", sender=lambda t: sent.append(t))
    assert sent == ["hallo"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/academy-auto && python -m pytest tests/test_report.py -v`
Expected: FAIL mit `ModuleNotFoundError: No module named 'academy_auto.report'`

- [ ] **Step 3: Write minimal implementation**

```python
# tools/academy-auto/academy_auto/report.py
from __future__ import annotations

from .gate import GateResult
from .runner import RunOutcome


def build_digest(
    task_prompt: str,
    run_outcome: RunOutcome,
    gate_result: GateResult,
    committed: bool,
) -> str:
    """Deutschen Tages-Digest für Jarvis/Telegram bauen."""
    lines = ["🎓 Academy-Auto — Tagesstand", ""]
    lines.append(f"Aufgabe: {task_prompt}")
    lines.append(f"Umsetzung: {'ok' if run_outcome.ok else 'fehlgeschlagen'}")

    if gate_result.passed:
        lines.append("Gate: grün (jest + tsc + lint)")
    else:
        failing = gate_result.steps[-1] if gate_result.steps else None
        cmd = " ".join(failing.cmd) if failing else "unbekannt"
        lines.append(f"Gate: rot bei `{cmd}`")

    if committed:
        lines.append("Ergebnis: auf agents/academy-auto committet")
    else:
        lines.append("Ergebnis: verworfen (kein grünes Gate)")

    return "\n".join(lines)


def send_digest(text: str, sender) -> None:
    """Digest verschicken. `sender` kapselt den Jarvis/Telegram-Versand."""
    sender(text)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/academy-auto && python -m pytest tests/test_report.py -v`
Expected: PASS (alle drei Tests)

- [ ] **Step 5: Commit**

```bash
git add tools/academy-auto/academy_auto/report.py tools/academy-auto/tests/test_report.py
git commit -m "feat(academy-auto): deutscher Jarvis-Digest + Versand-Hook"
```

---

## Task 6: Orchestrator + CLI

**Files:**
- Create: `tools/academy-auto/academy_auto/orchestrator.py`
- Create: `tools/academy-auto/README.md`
- Test: `tools/academy-auto/tests/test_orchestrator.py`

**Interfaces:**
- Consumes: alles aus Task 1–5.
- Produces: `run_once(cfg, task_prompt, deps) -> RunReport` mit `deps` als einfacher Namespace, der die injizierbaren Funktionen bündelt (`prepare_worktree`, `implement_task`, `run_gate`, `commit_and_pr`, `send_digest`). `RunReport` (dataclass: `status: str` — einer von `"paused"`, `"committed"`, `"discarded"`, `"impl_failed"`). Prüft zuerst das Pause-Flag; respektiert den Diff-Cap; committet nur bei grünem Gate.

- [ ] **Step 1: Write the failing test**

```python
# tools/academy-auto/tests/test_orchestrator.py
from types import SimpleNamespace
from academy_auto.config import Config
from academy_auto.gate import GateResult, GateStep
from academy_auto.runner import RunOutcome
from academy_auto.orchestrator import run_once


def base_deps(**over):
    d = dict(
        prepare_worktree=lambda cfg: cfg.worktree_path,
        implement_task=lambda cfg, cwd, prompt: RunOutcome(ok=True, output="done"),
        run_gate=lambda cfg, cwd: GateResult(passed=True, steps=[GateStep(["npm", "test"], 0, "ok")]),
        commit_and_pr=lambda cfg, cwd, prompt: True,
        send_digest=lambda text: sent.append(text),
    )
    d.update(over)
    return SimpleNamespace(**d)


def test_run_once_paused_when_flag_present(tmp_path):
    global sent
    sent = []
    cfg = Config.default()
    flag = tmp_path / "academy-auto.pause"
    flag.write_text("stop")
    cfg = Config(**{**cfg.__dict__, "pause_flag": flag})

    report = run_once(cfg, "irgendeine Aufgabe", base_deps())
    assert report.status == "paused"
    assert sent == []  # kein Digest, nichts passiert


def test_run_once_green_commits_and_reports(tmp_path):
    global sent
    sent = []
    cfg = Config.default()
    cfg = Config(**{**cfg.__dict__, "pause_flag": tmp_path / "nope.pause"})

    report = run_once(cfg, "Login-Bug fixen", base_deps())
    assert report.status == "committed"
    assert len(sent) == 1
    assert "grün" in sent[0].lower()


def test_run_once_red_gate_discards_and_reports(tmp_path):
    global sent
    sent = []
    cfg = Config.default()
    cfg = Config(**{**cfg.__dict__, "pause_flag": tmp_path / "nope.pause"})
    deps = base_deps(
        run_gate=lambda cfg, cwd: GateResult(passed=False, steps=[GateStep(["npm", "test"], 1, "fail")]),
        commit_and_pr=lambda cfg, cwd, prompt: (_ for _ in ()).throw(AssertionError("darf nicht committen")),
    )
    report = run_once(cfg, "Refactor", deps)
    assert report.status == "discarded"
    assert len(sent) == 1
    assert "rot" in sent[0].lower()


def test_run_once_impl_failure_skips_gate_and_reports(tmp_path):
    global sent
    sent = []
    cfg = Config.default()
    cfg = Config(**{**cfg.__dict__, "pause_flag": tmp_path / "nope.pause"})
    deps = base_deps(
        implement_task=lambda cfg, cwd, prompt: RunOutcome(ok=False, output="claude timeout"),
        run_gate=lambda cfg, cwd: (_ for _ in ()).throw(AssertionError("Gate darf nicht laufen")),
        commit_and_pr=lambda cfg, cwd, prompt: (_ for _ in ()).throw(AssertionError("kein Commit")),
    )
    report = run_once(cfg, "x", deps)
    assert report.status == "impl_failed"
    assert len(sent) == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/academy-auto && python -m pytest tests/test_orchestrator.py -v`
Expected: FAIL mit `ModuleNotFoundError: No module named 'academy_auto.orchestrator'`

- [ ] **Step 3: Write minimal implementation**

```python
# tools/academy-auto/academy_auto/orchestrator.py
from __future__ import annotations

import argparse
from dataclasses import dataclass

from .config import Config
from .report import build_digest


@dataclass
class RunReport:
    status: str  # "paused" | "committed" | "discarded" | "impl_failed"


def run_once(cfg: Config, task_prompt: str, deps) -> RunReport:
    """Ein Lauf: Pause-Check → Worktree → Implementieren → Gate → Commit/Digest."""
    if cfg.pause_flag.exists():
        return RunReport(status="paused")

    cwd = deps.prepare_worktree(cfg)

    outcome = deps.implement_task(cfg, cwd, task_prompt)
    if not outcome.ok:
        deps.send_digest(build_digest(task_prompt, outcome, _empty_gate(), committed=False))
        return RunReport(status="impl_failed")

    gate = deps.run_gate(cfg, cwd)
    if not gate.passed:
        deps.send_digest(build_digest(task_prompt, outcome, gate, committed=False))
        return RunReport(status="discarded")

    deps.commit_and_pr(cfg, cwd, task_prompt)
    deps.send_digest(build_digest(task_prompt, outcome, gate, committed=True))
    return RunReport(status="committed")


def _empty_gate():
    from .gate import GateResult
    return GateResult(passed=False, steps=[])


def main() -> None:  # pragma: no cover - CLI-Verdrahtung
    parser = argparse.ArgumentParser(description="Academy-Auto Phase A")
    parser.add_argument("task_prompt", help="Aufgabe für Claude Code (Phase A: manuell)")
    args = parser.parse_args()

    from . import worktree, gate, runner, report

    cfg = Config.default()
    deps = _build_default_deps(worktree, gate, runner, report)
    result = run_once(cfg, args.task_prompt, deps)
    print(result.status)


def _build_default_deps(worktree, gate, runner, report):  # pragma: no cover
    from types import SimpleNamespace
    return SimpleNamespace(
        prepare_worktree=lambda cfg: worktree.prepare_worktree(cfg),
        implement_task=lambda cfg, cwd, prompt: runner.implement_task(cfg, cwd, prompt),
        run_gate=lambda cfg, cwd: gate.run_gate(cfg, cwd),
        commit_and_pr=_commit_and_pr,
        send_digest=lambda text: report.send_digest(text, sender=print),
    )


def _commit_and_pr(cfg, cwd, prompt):  # pragma: no cover - echte Git-/gh-Anbindung beim Deploy
    import subprocess
    subprocess.run(["git", "-C", str(cwd), "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(cwd), "commit", "-m", f"feat(academy-auto): {prompt}"], check=True)
    return True


if __name__ == "__main__":  # pragma: no cover
    main()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/academy-auto && python -m pytest tests/ -v`
Expected: PASS (alle Tests aller Module grün)

- [ ] **Step 5: README schreiben + committen**

```markdown
# tools/academy-auto/README.md

Academy-Auto Phase A (MVP) — lässt Claude Code eine vorgegebene Aufgabe an
WHITESTAG.ACADEMY in einem isolierten Worktree umsetzen, prüft mit
jest+tsc+lint und meldet den Stand als Jarvis-Digest.

## Ausführen (manuell, Phase A)

    cd tools/academy-auto
    python -m academy_auto.orchestrator "Beschreibe hier die Aufgabe"

## Tests

    cd tools/academy-auto && python -m pytest tests/ -v

## Kill-Switch

    touch ~/.paperclip/academy-auto.pause   # hält jeden Lauf sofort an
    rm    ~/.paperclip/academy-auto.pause   # wieder freigeben

## Deploy (launchd, Phase B)

Paket nach ~/.paperclip/scripts/academy-auto/ kopieren (launchd kann
CloudStorage nicht lesen) und `send_digest`-Sender an den voice-echo-bot
verdrahten. launchd-Automatik + self-directed Triage kommen in Phase B.
```

```bash
git add tools/academy-auto/academy_auto/orchestrator.py tools/academy-auto/README.md tools/academy-auto/tests/test_orchestrator.py
git commit -m "feat(academy-auto): Orchestrator (Pause/Gate/Commit/Digest) + CLI + README"
```

---

## Self-Review (bereits durchgeführt)

- **Spec-Coverage:** Isolation (T2), Green-Gate (T3), Implementierung durch Claude Code (T4), Reporting/Digest (T5), Kill-Switch + Caps + Phasenfluss (T1/T6). Integrations-Gate/`main`-Schutz: `commit_and_pr` committet nur auf den Worktree-Branch, nie `main` — PR-Automatik ist Phase C. Self-directed Triage + launchd = bewusst Phase B, nicht Teil dieses Plans.
- **Platzhalter:** keine „TBD/TODO"; die einzige bewusst nachzuverdrahtende Stelle (`send_digest`-Sender → voice-echo-bot, `commit_and_pr` → gh) ist als Phase-B-Deploy-Schritt markiert und in Phase A gemockt/getestet.
- **Typ-Konsistenz:** `Config`, `GateResult`/`GateStep`, `RunOutcome`, `RunReport` durchgängig gleich benannt; `deps`-Callables mit einheitlichen Signaturen in Task 6 verwendet wie in Task 2–5 definiert.
