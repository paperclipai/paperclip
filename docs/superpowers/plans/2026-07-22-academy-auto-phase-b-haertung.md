# Academy-Auto Phase B — Sicherheits-Härtung Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Die zwei vom Final-Review als Pflicht-vor-Automatik markierten Sicherheits-Lücken schließen: (1) ein code-seitiger Scope-Zaun, der Läufe verwirft, die verbotene Dateien (`.env`, Secrets, Signing-Keys, Supabase-Migrationen) anfassen, und (2) echte Tests für die git-mutierenden Helfer, die bisher `pragma: no cover` sind.

**Architecture:** Ergänzt das bestehende `tools/academy-auto/`-Paket. Neues Modul `scope.py` (reine Prüflogik) + `Config.denied_globs`. Der Orchestrator bekommt ein Scope-Gate zwischen grünem Gate und Diff-Cap. Die git-Helfer werden gegen ein echtes temporäres Git-Repo getestet.

**Tech Stack:** Python 3 (stdlib: `fnmatch`, `subprocess`, `dataclasses`, `pathlib`) + pytest.

## Global Constraints

- Nur stdlib + pytest, keine neuen Laufzeit-Abhängigkeiten.
- Arbeit ausschließlich unter `tools/academy-auto/`; niemals `git add -A`/`.`, nur explizite Pfade.
- Verbotene Pfade (Spec-Schicht 2), als `denied_globs` in `Config.default()` — exakt diese Tupel-Werte:
  `(".env", ".env.*", "*.env", "*.pem", "*.key", "*.keystore", "*.jks", "*.p12", "*.p8", "*.mobileprovision", "google-services.json", "GoogleService-Info.plist", "supabase/migrations/*", ".git/*")`
- Scope-Verletzung → Lauf wird VERWORFEN (kein Commit), Digest nennt die verletzenden Dateien, Status `discarded`.
- Reihenfolge in `run_once`: Pause → Worktree → Impl → Gate → **Scope** → Diff-Cap → Commit. Scope VOR Diff-Cap.
- Bestehende 16 Tests müssen grün bleiben.

---

## File Structure

- Create: `tools/academy-auto/academy_auto/scope.py` — `ScopeResult`, `check_scope`
- Modify: `tools/academy-auto/academy_auto/config.py` — Feld `denied_globs`
- Modify: `tools/academy-auto/academy_auto/orchestrator.py` — Scope-Gate + `list_changed_files`-Dep + de-pragma Helfer
- Modify: `tools/academy-auto/academy_auto/report.py` — `build_digest` Scope-Meldung
- Test: `tests/test_scope.py`, erweitert `tests/test_config.py`, `tests/test_orchestrator.py`, `tests/test_report.py`, neu `tests/test_git_helpers.py`

---

## Task 1: Config-Denylist + Scope-Prüfmodul

**Files:**
- Modify: `tools/academy-auto/academy_auto/config.py`
- Create: `tools/academy-auto/academy_auto/scope.py`
- Test: `tools/academy-auto/tests/test_scope.py`, `tools/academy-auto/tests/test_config.py`

**Interfaces:**
- Produces: `Config.denied_globs: tuple[str, ...]`; `ScopeResult` (dataclass: `ok: bool`, `violations: list[str]`); `check_scope(cfg, changed_files: list[str]) -> ScopeResult`. Eine Datei verletzt den Scope, wenn ihr relativer Pfad ODER ihr Basename auf irgendein `denied_globs`-Muster passt (`fnmatch`).

- [ ] **Step 1: Failing test schreiben**

```python
# tools/academy-auto/tests/test_scope.py
from academy_auto.config import Config
from academy_auto.scope import check_scope


def test_clean_fileset_passes():
    cfg = Config.default()
    res = check_scope(cfg, ["src/App.tsx", "src/lib/util.ts", "tests/util.test.ts"])
    assert res.ok is True
    assert res.violations == []


def test_env_file_is_violation():
    cfg = Config.default()
    res = check_scope(cfg, ["src/App.tsx", ".env"])
    assert res.ok is False
    assert ".env" in res.violations


def test_nested_env_and_secrets_are_violations():
    cfg = Config.default()
    res = check_scope(cfg, ["config/.env.production", "ios/cert.p12", "src/App.tsx"])
    assert res.ok is False
    assert "config/.env.production" in res.violations
    assert "ios/cert.p12" in res.violations
    assert "src/App.tsx" not in res.violations


def test_supabase_migration_is_violation():
    cfg = Config.default()
    res = check_scope(cfg, ["supabase/migrations/003_add_users.sql"])
    assert res.ok is False
    assert "supabase/migrations/003_add_users.sql" in res.violations


def test_config_default_has_denied_globs():
    cfg = Config.default()
    assert ".env" in cfg.denied_globs
    assert "supabase/migrations/*" in cfg.denied_globs
    assert "*.p12" in cfg.denied_globs
```

Ergänze in `tests/test_config.py` eine Zeile im bestehenden Invarianten-Test:
```python
    assert isinstance(cfg.denied_globs, tuple)
```

- [ ] **Step 2: Test läuft, FEHLSCHLAG bestätigen**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_scope.py -v`
Expected: FAIL (`ModuleNotFoundError: academy_auto.scope` bzw. `AttributeError denied_globs`)

- [ ] **Step 3: Implementieren**

In `config.py` das Feld ergänzen (nach `max_diff_lines`):
```python
    denied_globs: tuple[str, ...]
```
und in `Config.default()` (nach `max_diff_lines=800,`):
```python
            denied_globs=(
                ".env", ".env.*", "*.env",
                "*.pem", "*.key", "*.keystore", "*.jks", "*.p12", "*.p8",
                "*.mobileprovision",
                "google-services.json", "GoogleService-Info.plist",
                "supabase/migrations/*", ".git/*",
            ),
```

```python
# tools/academy-auto/academy_auto/scope.py
from __future__ import annotations

from dataclasses import dataclass, field
from fnmatch import fnmatch

from .config import Config


@dataclass
class ScopeResult:
    ok: bool
    violations: list[str] = field(default_factory=list)


def check_scope(cfg: Config, changed_files: list[str]) -> ScopeResult:
    """Verwirft Läufe, die verbotene Dateien anfassen (Secrets, Signing, Migrationen)."""
    violations: list[str] = []
    for path in changed_files:
        base = path.rsplit("/", 1)[-1]
        for pattern in cfg.denied_globs:
            if fnmatch(path, pattern) or fnmatch(base, pattern):
                violations.append(path)
                break
    return ScopeResult(ok=(not violations), violations=violations)
```

- [ ] **Step 4: Tests grün**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_scope.py tests/test_config.py -v`
Expected: PASS (alle)

- [ ] **Step 5: Commit**

```bash
git add tools/academy-auto/academy_auto/config.py tools/academy-auto/academy_auto/scope.py tools/academy-auto/tests/test_scope.py tools/academy-auto/tests/test_config.py
git commit -m "feat(academy-auto): Scope-Zaun — Config-Denylist + check_scope"
```

---

## Task 2: Scope-Gate im Orchestrator + Digest-Meldung

**Files:**
- Modify: `tools/academy-auto/academy_auto/orchestrator.py`
- Modify: `tools/academy-auto/academy_auto/report.py`
- Test: `tools/academy-auto/tests/test_orchestrator.py`, `tools/academy-auto/tests/test_report.py`

**Interfaces:**
- Consumes: `check_scope`/`ScopeResult` (Task 1), `list_changed_files`-Dep (neu).
- Produces: `run_once` verwirft bei Scope-Verletzung mit Status `discarded`, sendet Digest mit `scope_violations`. `build_digest` bekommt Param `scope_violations: list[str] | None = None`.

- [ ] **Step 1: Failing test schreiben**

In `tests/test_report.py` ergänzen:
```python
def test_build_digest_scope_violation_names_files():
    from academy_auto.gate import GateResult, GateStep
    from academy_auto.runner import RunOutcome
    from academy_auto.report import build_digest
    text = build_digest(
        task_prompt="X",
        run_outcome=RunOutcome(ok=True, output="done"),
        gate_result=GateResult(passed=True, steps=[GateStep(["npm", "test"], 0, "ok")]),
        committed=False,
        scope_violations=[".env", "ios/cert.p12"],
    )
    assert "Scope" in text
    assert ".env" in text
    assert "verworfen" in text.lower()
```

In `tests/test_orchestrator.py`: in `base_deps` den Dep ergänzen `list_changed_files=lambda cfg, cwd: ["src/App.tsx"]`, und neuen Test:
```python
def test_run_once_scope_violation_discards(tmp_path):
    global sent
    sent = []
    cfg = Config.default()
    cfg = Config(**{**cfg.__dict__, "pause_flag": tmp_path / "nope.pause"})
    deps = base_deps(
        list_changed_files=lambda cfg, cwd: ["src/App.tsx", ".env"],
        count_diff_lines=lambda cfg, cwd: (_ for _ in ()).throw(AssertionError("Cap darf nicht laufen")),
        commit_and_pr=lambda cfg, cwd, prompt: (_ for _ in ()).throw(AssertionError("darf nicht committen")),
    )
    report = run_once(cfg, "Aufgabe", deps)
    assert report.status == "discarded"
    assert len(sent) == 1
    assert "Scope" in sent[0]
    assert ".env" in sent[0]
```

- [ ] **Step 2: Test läuft, FEHLSCHLAG bestätigen**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_orchestrator.py tests/test_report.py -v`
Expected: FAIL (`build_digest() unexpected keyword 'scope_violations'` und/oder Scope-Gate fehlt → AssertionError beim throw-Guard)

- [ ] **Step 3: Implementieren**

In `report.py` — Signatur um `scope_violations: list[str] | None = None` erweitern und den Ergebnis-Block anpassen:
```python
    if committed:
        lines.append("Ergebnis: auf agents/academy-auto committet")
    elif scope_violations:
        lines.append("Ergebnis: verworfen (Scope-Verletzung: " + ", ".join(scope_violations) + ")")
    elif cap_exceeded:
        lines.append("Ergebnis: verworfen (Diff-Cap überschritten)")
    else:
        lines.append("Ergebnis: verworfen (kein grünes Gate)")
```

In `orchestrator.py` — nach dem Gate-Block (nach Zeile `return RunReport(status="discarded")` des Gates), VOR dem Diff-Cap-Block, einfügen:
```python
    changed = deps.list_changed_files(cfg, cwd)
    scope = check_scope(cfg, changed)
    if not scope.ok:
        deps.send_digest(build_digest(task_prompt, outcome, gate, committed=False, scope_violations=scope.violations))
        return RunReport(status="discarded")
```
Oben ergänzen: `from .scope import check_scope`.
In `_build_default_deps` den Dep ergänzen:
```python
        list_changed_files=_list_changed_files,
```
und die Default-Impl (analog zu `_count_diff_lines`, ebenfalls vorerst `pragma: no cover` — wird in Task 3 getestet):
```python
def _list_changed_files(cfg, cwd):  # pragma: no cover - in Task 3 getestet
    import subprocess
    subprocess.run(["git", "-C", str(cwd), "add", "-A"], check=True)
    proc = subprocess.run(
        ["git", "-C", str(cwd), "diff", "--cached", "--name-only"],
        cwd=str(cwd), capture_output=True, text=True, check=False,
    )
    return [line for line in proc.stdout.splitlines() if line]
```

- [ ] **Step 4: Tests grün**

Run: `cd tools/academy-auto && python3 -m pytest tests/ -v`
Expected: PASS (alle, inkl. der 16 bestehenden)

- [ ] **Step 5: Commit**

```bash
git add tools/academy-auto/academy_auto/orchestrator.py tools/academy-auto/academy_auto/report.py tools/academy-auto/tests/test_orchestrator.py tools/academy-auto/tests/test_report.py
git commit -m "feat(academy-auto): Scope-Gate im Orchestrator + Digest-Meldung"
```

---

## Task 3: Echte Git-Tests für die Helfer (pragma entfernen)

**Files:**
- Modify: `tools/academy-auto/academy_auto/orchestrator.py` (nur `# pragma: no cover` von `_count_diff_lines`, `_commit_and_pr`, `_list_changed_files` entfernen)
- Test: `tools/academy-auto/tests/test_git_helpers.py`

**Interfaces:**
- Consumes: `_count_diff_lines`, `_commit_and_pr`, `_list_changed_files` aus `orchestrator.py`.
- Produces: Tests gegen ein echtes temporäres Git-Repo; die drei Helfer haben danach echte Coverage.

- [ ] **Step 1: Failing test schreiben**

```python
# tools/academy-auto/tests/test_git_helpers.py
import subprocess
from pathlib import Path
import pytest
from academy_auto.orchestrator import _count_diff_lines, _commit_and_pr, _list_changed_files


def _git(repo, *args):
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True)


@pytest.fixture
def repo(tmp_path):
    _git(tmp_path, "init")
    _git(tmp_path, "config", "user.email", "test@example.com")
    _git(tmp_path, "config", "user.name", "Test")
    (tmp_path / "seed.txt").write_text("base\n")
    _git(tmp_path, "add", "-A")
    _git(tmp_path, "commit", "-m", "seed")
    return tmp_path


def test_list_changed_files_reports_new_and_modified(repo):
    (repo / "a.txt").write_text("neu\n")
    (repo / "seed.txt").write_text("base\nmehr\n")
    files = _list_changed_files(None, repo)
    assert "a.txt" in files
    assert "seed.txt" in files


def test_count_diff_lines_counts_added_lines(repo):
    (repo / "a.txt").write_text("eins\nzwei\ndrei\n")
    n = _count_diff_lines(None, repo)
    assert n >= 3


def test_commit_and_pr_creates_commit(repo):
    (repo / "b.txt").write_text("inhalt\n")
    result = _commit_and_pr(None, repo, "meine Aufgabe")
    assert result is True
    log = subprocess.run(["git", "-C", str(repo), "log", "--oneline"], capture_output=True, text=True)
    assert "meine Aufgabe" in log.stdout
```

- [ ] **Step 2: Test läuft**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_git_helpers.py -v`
Expected: PASS (die Helfer funktionieren bereits; dieser Schritt gibt ihnen Coverage). Falls ein Test rot ist, ist das ein echter Bug im Helfer — dann beheben.

- [ ] **Step 3: pragma entfernen**

In `orchestrator.py` bei `_count_diff_lines`, `_commit_and_pr` und `_list_changed_files` jeweils das `  # pragma: no cover ...` am Funktionskopf entfernen (nur diese drei; `main`, `_build_default_deps`, `__main__` behalten ihr pragma).

- [ ] **Step 4: Volle Suite grün**

Run: `cd tools/academy-auto && python3 -m pytest tests/ -v`
Expected: PASS (alle)

- [ ] **Step 5: Commit**

```bash
git add tools/academy-auto/academy_auto/orchestrator.py tools/academy-auto/tests/test_git_helpers.py
git commit -m "test(academy-auto): echte Git-Tests fuer count/commit/list-Helfer"
```

---

## Self-Review

- **Spec-Coverage:** Sicherheitsschicht 2 (Scope-Zaun) → Task 1+2; Final-Review-Finding 2 (ungetestete Git-Helfer) → Task 3. Findings 3/4 (Top-Level-except, in-run-Worktree-Reset) bleiben bewusst offen für den Automatik-Task (launchd) in einem späteren Plan.
- **Platzhalter:** keine; alle Werte/Code vollständig.
- **Typ-Konsistenz:** `ScopeResult`, `check_scope`, `denied_globs`, `list_changed_files`, `scope_violations` durchgängig gleich benannt; Scope-Gate nutzt exakt die `run_once`-Guard-Signatur wie Gate/Cap.
