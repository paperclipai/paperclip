# Academy-Auto FS-Isolation Phase 2 (Runner-Integration) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Der headless `claude -p`-Implementierungsaufruf läuft ab jetzt **nur noch** in der sandbox-exec-Kapsel — und wenn die Sandbox nicht startbar ist, läuft er **gar nicht** (fail-closed über den bestehenden `impl_failed`-Pfad).

**Architecture:** `runner.implement_task` prüft vor dem Lauf `sandbox.sandbox_available`, schreibt dann ein Profil, kapselt `CLAUDE_CMD` per `sandbox.wrap_command` und räumt das Temp-Profil im `finally` auf. Die Sandbox-Funktionen sind injizierbar (Tests ohne echtes sandbox-exec). Der Orchestrator bleibt unverändert — `ok=False` läuft automatisch in `impl_failed` (Digest + Worktree-Reset).

**Tech Stack:** Python 3 (stdlib: `os`, `subprocess`) + pytest.

## Global Constraints

- Nur stdlib + pytest, keine neuen Laufzeit-Abhängigkeiten.
- Arbeit ausschließlich unter `tools/academy-auto/`; niemals `git add -A`/`.`, nur explizite Pfade.
- **Fail-closed:** `sandbox_available(cfg)` False → `RunOutcome(ok=False, …)` und der `claude`-Prozess wird NICHT gestartet.
- **Fail-soft:** jede Exception im Sandbox-/Lauf-Pfad → `RunOutcome(ok=False, …)`, nie ein Crash der Orchestrator-Schleife.
- Temp-Profildatei wird im `finally` gelöscht (kein `/tmp`-Leak pro Lauf).
- Der Ranker (`triage/rank.py`) bleibt ungekapselt (keine Datei-Tools) — NICHT anfassen.
- Bestehende 116 Tests müssen grün bleiben (die bisherigen `test_triage_rank`/`test_runner`-Erwartungen an das nackte `CLAUDE_CMD` sind anzupassen).

---

## File Structure

- Modify: `tools/academy-auto/academy_auto/runner.py` — Sandbox-Kapselung + fail-closed
- Test: `tools/academy-auto/tests/test_runner.py` (angepasst + neue Fälle)

---

## Task 1: `implement_task` kapselt in der Sandbox (fail-closed)

**Files:**
- Modify: `tools/academy-auto/academy_auto/runner.py`
- Test: `tools/academy-auto/tests/test_runner.py`

**Interfaces:**
- Consumes: `sandbox.sandbox_available(cfg)`, `sandbox.write_profile(cfg)`, `sandbox.wrap_command(cfg, cmd, profile_path)`.
- Produces: `implement_task(cfg, cwd, task_prompt, runner=subprocess.run, available=None, make_profile=None, wrap=None) -> RunOutcome`. Die drei Sandbox-Callables sind injizierbar (Default = die echten aus `sandbox.py`).

- [ ] **Step 1: Failing test schreiben** (`tests/test_runner.py` — bestehende Tests anpassen + neue)

Die bestehenden Tests erwarten `captured["cmd"][:len(CLAUDE_CMD)] == CLAUDE_CMD`. Das gilt nicht mehr (Kommando ist jetzt sandbox-gewrappt). Ersetze die Testdatei-Inhalte durch:

```python
# tools/academy-auto/tests/test_runner.py
from academy_auto.config import Config
from academy_auto.runner import implement_task, CLAUDE_CMD


def _ok_proc(stdout="fertig", returncode=0, stderr=""):
    class R:
        pass
    r = R()
    r.stdout = stdout
    r.stderr = stderr
    r.returncode = returncode
    return r


def _deps(**over):
    d = dict(
        available=lambda cfg: True,
        make_profile=lambda cfg: "/tmp/prof.sb",
        wrap=lambda cfg, cmd, profile: ["sandbox-exec", "-f", str(profile), *cmd],
    )
    d.update(over)
    return d


def test_implement_task_runs_inside_sandbox():
    cfg = Config.default()
    captured = {}

    def runner(cmd, **kwargs):
        captured["cmd"] = cmd
        captured["cwd"] = kwargs.get("cwd")
        return _ok_proc()

    outcome = implement_task(cfg, "/tmp/wt", "Fixe den Login-Bug", runner=runner, **_deps())
    assert outcome.ok is True
    assert outcome.output == "fertig"
    # Kommando ist sandbox-gekapselt UND enthält den echten claude-Aufruf + Prompt
    assert captured["cmd"][:2] == ["sandbox-exec", "-f"]
    assert captured["cmd"][3:3 + len(CLAUDE_CMD)] == CLAUDE_CMD
    assert "Fixe den Login-Bug" in captured["cmd"]
    assert captured["cwd"] == "/tmp/wt"


def test_implement_task_fail_closed_when_sandbox_unavailable():
    cfg = Config.default()

    def must_not_run(*a, **k):
        raise AssertionError("claude darf ohne Sandbox NICHT starten")

    outcome = implement_task(
        cfg, "/tmp/wt", "x", runner=must_not_run, **_deps(available=lambda cfg: False)
    )
    assert outcome.ok is False
    assert "andbox" in outcome.output  # nennt die Sandbox als Ursache


def test_implement_task_reports_failure_on_nonzero_exit():
    cfg = Config.default()
    outcome = implement_task(
        cfg, "/tmp/wt", "x",
        runner=lambda cmd, **k: _ok_proc(stdout="", stderr="claude timeout", returncode=2),
        **_deps(),
    )
    assert outcome.ok is False
    assert "timeout" in outcome.output


def test_implement_task_fail_soft_when_runner_raises():
    cfg = Config.default()

    def boom(*a, **k):
        raise RuntimeError("prozess kaputt")

    outcome = implement_task(cfg, "/tmp/wt", "x", runner=boom, **_deps())
    assert outcome.ok is False
    assert "kaputt" in outcome.output


def test_implement_task_cleans_up_profile(tmp_path):
    cfg = Config.default()
    prof = tmp_path / "prof.sb"
    prof.write_text("(version 1)")
    implement_task(
        cfg, "/tmp/wt", "x", runner=lambda cmd, **k: _ok_proc(),
        **_deps(make_profile=lambda cfg: str(prof)),
    )
    assert not prof.exists()  # Temp-Profil nach dem Lauf gelöscht
```

- [ ] **Step 2: Test läuft, FEHLSCHLAG bestätigen**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_runner.py -v`
Expected: FAIL (`implement_task() got an unexpected keyword argument 'available'`)

- [ ] **Step 3: Implementieren** (`runner.py` — `implement_task` ersetzen, `import os` oben ergänzen)

```python
def implement_task(
    cfg: Config,
    cwd,
    task_prompt: str,
    runner=subprocess.run,
    available=None,
    make_profile=None,
    wrap=None,
) -> RunOutcome:
    """Claude Code headless im isolierten Worktree — ausschließlich in der sandbox-exec-Kapsel.

    Fail-closed: Ist die Sandbox nicht startbar, wird claude gar nicht ausgeführt.
    """
    from . import sandbox as _sb

    available = available or _sb.sandbox_available
    make_profile = make_profile or _sb.write_profile
    wrap = wrap or _sb.wrap_command

    if not available(cfg):
        return RunOutcome(
            ok=False,
            output="Sandbox nicht startbar (fail-closed) — Lauf abgebrochen, claude wurde nicht gestartet.",
        )

    profile = None
    try:
        profile = make_profile(cfg)
        cmd = wrap(cfg, CLAUDE_CMD + [task_prompt], str(profile))
        proc = runner(cmd, cwd=str(cwd), capture_output=True, text=True, check=False)
        output = (getattr(proc, "stdout", "") or "") + (getattr(proc, "stderr", "") or "")
        return RunOutcome(ok=(proc.returncode == 0), output=output.strip())
    except Exception as exc:
        return RunOutcome(ok=False, output=f"Sandbox-Lauf fehlgeschlagen: {exc}")
    finally:
        if profile is not None:
            try:
                os.unlink(profile)
            except OSError:
                pass
```

- [ ] **Step 4: Tests grün + volle Suite**

Run: `cd tools/academy-auto && python3 -m pytest tests/ -v`
Expected: PASS (alle; die Orchestrator-Tests bleiben unberührt, da sie `implement_task` über `deps` mocken)

- [ ] **Step 5: Commit**

```bash
git add tools/academy-auto/academy_auto/runner.py tools/academy-auto/tests/test_runner.py
git commit -m "feat(academy-auto): claude laeuft nur noch in der sandbox-exec-Kapsel (fail-closed)"
```

---

## Self-Review

- **Spec-Coverage (Phase 2):** Integration in `runner.implement_task` mit fail-closed über `sandbox_available` → Task 1; Temp-Profil-Cleanup (Minor aus Phase 1) → Task 1 `finally`; fail-soft bei Exceptions → Task 1. Kalibrier-Smoke mit echtem claude bleibt Phase 3 (operativ, kein Code).
- **Platzhalter:** keine; vollständiger Code + Kommandos.
- **Typ-Konsistenz:** `implement_task`-Signatur mit den drei injizierbaren Sandbox-Callables; `RunOutcome(ok, output)` unverändert, sodass der Orchestrator-`impl_failed`-Pfad ohne Änderung greift.
