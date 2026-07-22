# Academy-Auto Triage T-Phase 1 (Scanner + State) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ein reines-Python-Scanner-Modul, das aus vier Quellen (TODO/FIXME, übersprungene Tests, tsc/lint, GitHub-Issues) deterministisch Aufgaben-Kandidaten mit stabilen keys erzeugt, plus ein State-Modul, das erledigte und mehrfach gescheiterte Kandidaten herausfiltert (Anti-Oszillation) — beides ohne LLM, voll testbar.

**Architecture:** Neues Unterpaket `tools/academy-auto/academy_auto/triage/`. `scan.py` liefert `Candidate`-Objekte je Quelle + einen `scan_all`-Aggregator (Dedup nach key, Vorsortierung nach `raw_priority`). `state.py` verwaltet eine JSON-State-Datei mit Filter-/Quarantäne-Logik. Subprozess-Aufrufe (`npx tsc`, `expo lint`, `gh`) sind über einen injizierbaren `runner` gekapselt und in Tests gemockt.

**Tech Stack:** Python 3 (stdlib: `re`, `os`/`pathlib`, `json`, `subprocess`, `dataclasses`) + pytest.

## Global Constraints

- Nur stdlib + pytest, keine neuen Laufzeit-Abhängigkeiten.
- Arbeit ausschließlich unter `tools/academy-auto/`; niemals `git add -A`/`.`, nur explizite Pfade.
- `Candidate` (frozen dataclass): `source: str`, `key: str`, `file: str`, `line: int`, `text: str`, `raw_priority: int`.
- `source`-Werte: `"todo"`, `"skip"`, `"tsc"`, `"lint"`, `"issue"`.
- `raw_priority` je Quelle (höher = wichtiger): tsc=50, lint=45, skip=30, issue=20, todo=10.
- key-Formate: `todo:<file>:<zeile>`, `skip:<file>:<zeile>`, `tsc:<file>:<zeile>:<code>`, `lint:<file>:<zeile>:<rule>`, `issue:<nr>`.
- GitHub-Repo als Modulkonstante `GITHUB_REPO = "whitestagai/ki-kompass"`.
- Ausgeschlossene Verzeichnisse beim Datei-Walk: `node_modules`, `.git`, `ios/Pods`, `android/build`, `dist`, `.expo`.
- Quell-Datei-Endungen: `.ts`, `.tsx`, `.js`, `.jsx`.
- Alle Subprozess-Quellen sind **fail-soft**: Fehler/kein-Netz/kein-Tool → leere Liste, nie werfen.

---

## File Structure

- `tools/academy-auto/academy_auto/triage/__init__.py` — Paket-Marker
- `tools/academy-auto/academy_auto/triage/scan.py` — `Candidate`, Quell-Scanner, `scan_all`
- `tools/academy-auto/academy_auto/triage/state.py` — State laden/filtern/aufzeichnen/Quarantäne
- `tools/academy-auto/tests/test_triage_scan.py`, `tests/test_triage_state.py`

---

## Task 1: Candidate + Text-Scanner (TODO/FIXME + übersprungene Tests)

**Files:**
- Create: `tools/academy-auto/academy_auto/triage/__init__.py`
- Create: `tools/academy-auto/academy_auto/triage/scan.py`
- Test: `tools/academy-auto/tests/test_triage_scan.py`

**Interfaces:**
- Produces: `Candidate` (frozen dataclass, Felder wie Global Constraints); `iter_source_files(root: Path) -> list[str]` (repo-relative Pfade der Quelldateien, Ausschlüsse beachtet); `scan_todos(root: Path) -> list[Candidate]`; `scan_skipped_tests(root: Path) -> list[Candidate]`.

- [ ] **Step 1: Failing test schreiben**

```python
# tools/academy-auto/tests/test_triage_scan.py
from pathlib import Path
from academy_auto.triage.scan import Candidate, iter_source_files, scan_todos, scan_skipped_tests


def _write(root: Path, rel: str, content: str):
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)


def test_iter_source_files_excludes_vendor_dirs(tmp_path):
    _write(tmp_path, "src/App.tsx", "x")
    _write(tmp_path, "node_modules/pkg/index.js", "x")
    _write(tmp_path, "ios/Pods/Foo.js", "x")
    _write(tmp_path, "README.md", "x")  # falsche Endung
    files = iter_source_files(tmp_path)
    assert "src/App.tsx" in files
    assert all("node_modules" not in f for f in files)
    assert all("ios/Pods" not in f for f in files)
    assert "README.md" not in files


def test_scan_todos_finds_todo_and_fixme(tmp_path):
    _write(tmp_path, "src/a.ts", "const x = 1; // TODO Feld validieren\nconst y = 2; // FIXME leak\nconst z=3;\n")
    cands = scan_todos(tmp_path)
    keys = {c.key for c in cands}
    assert "todo:src/a.ts:1" in keys
    assert "todo:src/a.ts:2" in keys
    assert len(cands) == 2
    c = next(c for c in cands if c.key == "todo:src/a.ts:1")
    assert c.source == "todo"
    assert c.raw_priority == 10
    assert "validieren" in c.text


def test_scan_skipped_tests_finds_skip_markers(tmp_path):
    _write(tmp_path, "src/a.test.ts", "describe('x', () => {\n  it.skip('later', () => {});\n  xit('nope', () => {});\n});\n")
    cands = scan_skipped_tests(tmp_path)
    keys = {c.key for c in cands}
    assert "skip:src/a.test.ts:2" in keys
    assert "skip:src/a.test.ts:3" in keys
    assert all(c.source == "skip" and c.raw_priority == 30 for c in cands)
```

- [ ] **Step 2: Test läuft, FEHLSCHLAG bestätigen**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_triage_scan.py -v`
Expected: FAIL (`ModuleNotFoundError: academy_auto.triage.scan`)

- [ ] **Step 3: Implementieren**

```python
# tools/academy-auto/academy_auto/triage/__init__.py
"""Triage: deterministischer Scan + (spätere) LLM-Priorisierung von Aufgaben."""
```

```python
# tools/academy-auto/academy_auto/triage/scan.py
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

GITHUB_REPO = "whitestagai/ki-kompass"

_EXCLUDE_PARTS = ("node_modules", ".git", "ios/Pods", "android/build", "dist", ".expo")
_SOURCE_EXTS = (".ts", ".tsx", ".js", ".jsx")

_TODO_RE = re.compile(r"\b(?:TODO|FIXME)\b|@todo")
_SKIP_RE = re.compile(r"\b(?:test|it|describe)\.skip\b|\bxit\s*\(|\bit\.todo\b")


@dataclass(frozen=True)
class Candidate:
    source: str
    key: str
    file: str
    line: int
    text: str
    raw_priority: int


def iter_source_files(root: Path) -> list[str]:
    """Repo-relative Pfade aller Quelldateien, Vendor-/Build-Verzeichnisse ausgeschlossen."""
    out: list[str] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix not in _SOURCE_EXTS:
            continue
        rel = path.relative_to(root).as_posix()
        if any(part in rel for part in _EXCLUDE_PARTS):
            continue
        out.append(rel)
    return out


def _scan_lines(root: Path, pattern: re.Pattern, source: str, priority: int) -> list[Candidate]:
    cands: list[Candidate] = []
    for rel in iter_source_files(root):
        try:
            lines = (root / rel).read_text(errors="ignore").splitlines()
        except OSError:
            continue
        for i, line in enumerate(lines, start=1):
            if pattern.search(line):
                cands.append(Candidate(
                    source=source,
                    key=f"{source}:{rel}:{i}",
                    file=rel,
                    line=i,
                    text=line.strip(),
                    raw_priority=priority,
                ))
    return cands


def scan_todos(root: Path) -> list[Candidate]:
    return _scan_lines(root, _TODO_RE, "todo", 10)


def scan_skipped_tests(root: Path) -> list[Candidate]:
    cands = _scan_lines(root, _SKIP_RE, "skip", 30)
    return [c for c in cands if _is_test_file(c.file)]


def _is_test_file(rel: str) -> bool:
    return ".test." in rel or ".spec." in rel or "__tests__/" in rel
```

- [ ] **Step 4: Tests grün**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_triage_scan.py -v`
Expected: PASS (3 Tests)

- [ ] **Step 5: Commit**

```bash
git add tools/academy-auto/academy_auto/triage/__init__.py tools/academy-auto/academy_auto/triage/scan.py tools/academy-auto/tests/test_triage_scan.py
git commit -m "feat(academy-auto): Triage-Scanner Candidate + TODO/Skip-Quellen"
```

---

## Task 2: tsc- + Lint-Scanner (Subprozess-Parser)

**Files:**
- Modify: `tools/academy-auto/academy_auto/triage/scan.py`
- Test: `tools/academy-auto/tests/test_triage_scan.py`

**Interfaces:**
- Consumes: `Candidate` (Task 1).
- Produces: `scan_tsc(root, runner=subprocess.run) -> list[Candidate]` (parst `file(line,col): error TSxxxx: msg`); `scan_lint(root, runner=subprocess.run) -> list[Candidate]` (parst eslint-JSON). Beide fail-soft.

- [ ] **Step 1: Failing test schreiben** (an `tests/test_triage_scan.py` anhängen)

```python
from academy_auto.triage.scan import scan_tsc, scan_lint


def _proc(stdout="", returncode=0):
    class R:
        pass
    r = R()
    r.stdout = stdout
    r.stderr = ""
    r.returncode = returncode
    return r


def test_scan_tsc_parses_errors():
    tsc_out = (
        "src/App.tsx(12,7): error TS2322: Type 'string' is not assignable to type 'number'.\n"
        "src/lib/u.ts(3,1): error TS2531: Object is possibly 'null'.\n"
        "Found 2 errors.\n"
    )
    cands = scan_tsc(None, runner=lambda *a, **k: _proc(stdout=tsc_out, returncode=2))
    keys = {c.key for c in cands}
    assert "tsc:src/App.tsx:12:TS2322" in keys
    assert "tsc:src/lib/u.ts:3:TS2531" in keys
    assert all(c.source == "tsc" and c.raw_priority == 50 for c in cands)


def test_scan_tsc_fail_soft_on_crash():
    def boom(*a, **k):
        raise FileNotFoundError("npx not found")
    assert scan_tsc(None, runner=boom) == []


def test_scan_lint_parses_json():
    lint_json = (
        '[{"filePath":"/repo/src/a.ts","messages":['
        '{"line":4,"ruleId":"no-unused-vars","message":"x unused","severity":1}]}]'
    )
    cands = scan_lint(None, runner=lambda *a, **k: _proc(stdout=lint_json, returncode=1), repo_root="/repo")
    assert len(cands) == 1
    c = cands[0]
    assert c.key == "lint:src/a.ts:4:no-unused-vars"
    assert c.source == "lint" and c.raw_priority == 45


def test_scan_lint_fail_soft_on_bad_json():
    assert scan_lint(None, runner=lambda *a, **k: _proc(stdout="not json", returncode=1), repo_root="/repo") == []
```

- [ ] **Step 2: Test läuft, FEHLSCHLAG bestätigen**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_triage_scan.py -k "tsc or lint" -v`
Expected: FAIL (`ImportError: cannot import name 'scan_tsc'`)

- [ ] **Step 3: Implementieren** (an `scan.py` anhängen)

```python
import json
import subprocess

_TSC_RE = re.compile(r"^(.+?)\((\d+),\d+\):\s+error\s+(TS\d+):\s+(.+)$")


def scan_tsc(root, runner=subprocess.run) -> list[Candidate]:
    try:
        proc = runner(
            ["npx", "tsc", "--noEmit"],
            cwd=str(root) if root is not None else None,
            capture_output=True, text=True, check=False,
        )
    except Exception:
        return []
    out = (getattr(proc, "stdout", "") or "") + (getattr(proc, "stderr", "") or "")
    cands: list[Candidate] = []
    for line in out.splitlines():
        m = _TSC_RE.match(line.strip())
        if not m:
            continue
        file, ln, code, msg = m.group(1), int(m.group(2)), m.group(3), m.group(4)
        cands.append(Candidate(
            source="tsc", key=f"tsc:{file}:{ln}:{code}", file=file, line=ln,
            text=msg.strip(), raw_priority=50,
        ))
    return cands


def scan_lint(root, runner=subprocess.run, repo_root=None) -> list[Candidate]:
    base = repo_root if repo_root is not None else (str(root) if root is not None else "")
    try:
        proc = runner(
            ["npx", "eslint", ".", "--format", "json"],
            cwd=str(root) if root is not None else None,
            capture_output=True, text=True, check=False,
        )
    except Exception:
        return []
    try:
        data = json.loads(getattr(proc, "stdout", "") or "")
    except (ValueError, TypeError):
        return []
    cands: list[Candidate] = []
    for entry in data:
        abs_path = entry.get("filePath", "")
        rel = abs_path[len(base):].lstrip("/") if base and abs_path.startswith(base) else abs_path
        for m in entry.get("messages", []):
            ln = m.get("line", 0)
            rule = m.get("ruleId") or "unknown"
            cands.append(Candidate(
                source="lint", key=f"lint:{rel}:{ln}:{rule}", file=rel, line=ln,
                text=(m.get("message") or "").strip(), raw_priority=45,
            ))
    return cands
```

- [ ] **Step 4: Tests grün**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_triage_scan.py -v`
Expected: PASS (alle, inkl. Task 1)

- [ ] **Step 5: Commit**

```bash
git add tools/academy-auto/academy_auto/triage/scan.py tools/academy-auto/tests/test_triage_scan.py
git commit -m "feat(academy-auto): Triage tsc- + Lint-Scanner (fail-soft Subprozess-Parser)"
```

---

## Task 3: GitHub-Issue-Scanner

**Files:**
- Modify: `tools/academy-auto/academy_auto/triage/scan.py`
- Test: `tools/academy-auto/tests/test_triage_scan.py`

**Interfaces:**
- Consumes: `Candidate`, `GITHUB_REPO`.
- Produces: `scan_issues(runner=subprocess.run) -> list[Candidate]` — `gh issue list` JSON, fail-soft.

- [ ] **Step 1: Failing test schreiben** (anhängen)

```python
from academy_auto.triage.scan import scan_issues


def test_scan_issues_parses_gh_json():
    gh_json = '[{"number":42,"title":"Login-Flow bricht ab","labels":[{"name":"bug"}],"body":"..."},{"number":7,"title":"Dark Mode","labels":[],"body":""}]'
    cands = scan_issues(runner=lambda *a, **k: _proc(stdout=gh_json, returncode=0))
    keys = {c.key for c in cands}
    assert "issue:42" in keys
    assert "issue:7" in keys
    c = next(c for c in cands if c.key == "issue:42")
    assert c.source == "issue" and c.raw_priority == 20 and c.line == 0 and c.file == ""
    assert "Login-Flow" in c.text


def test_scan_issues_fail_soft_when_gh_missing():
    def boom(*a, **k):
        raise FileNotFoundError("gh not found")
    assert scan_issues(runner=boom) == []
```

- [ ] **Step 2: Test läuft, FEHLSCHLAG bestätigen**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_triage_scan.py -k issue -v`
Expected: FAIL (`ImportError: cannot import name 'scan_issues'`)

- [ ] **Step 3: Implementieren** (anhängen)

```python
def scan_issues(runner=subprocess.run) -> list[Candidate]:
    try:
        proc = runner(
            ["gh", "issue", "list", "--repo", GITHUB_REPO, "--state", "open",
             "--json", "number,title,labels,body"],
            capture_output=True, text=True, check=False,
        )
    except Exception:
        return []
    try:
        data = json.loads(getattr(proc, "stdout", "") or "")
    except (ValueError, TypeError):
        return []
    cands: list[Candidate] = []
    for issue in data:
        number = issue.get("number")
        if number is None:
            continue
        cands.append(Candidate(
            source="issue", key=f"issue:{number}", file="", line=0,
            text=(issue.get("title") or "").strip(), raw_priority=20,
        ))
    return cands
```

- [ ] **Step 4: Tests grün**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_triage_scan.py -v`
Expected: PASS (alle)

- [ ] **Step 5: Commit**

```bash
git add tools/academy-auto/academy_auto/triage/scan.py tools/academy-auto/tests/test_triage_scan.py
git commit -m "feat(academy-auto): Triage GitHub-Issue-Scanner (fail-soft)"
```

---

## Task 4: Aggregator `scan_all` (Dedup + Vorsortierung)

**Files:**
- Modify: `tools/academy-auto/academy_auto/triage/scan.py`
- Test: `tools/academy-auto/tests/test_triage_scan.py`

**Interfaces:**
- Consumes: alle Quell-Scanner.
- Produces: `scan_all(root, runner=subprocess.run) -> list[Candidate]` — ruft alle Quellen, dedupt nach `key` (erster gewinnt), sortiert nach `raw_priority` absteigend, dann `key` aufsteigend.

- [ ] **Step 1: Failing test schreiben** (anhängen)

```python
from academy_auto.triage import scan as scanmod


def test_scan_all_dedups_and_sorts(tmp_path, monkeypatch):
    from academy_auto.triage.scan import Candidate
    monkeypatch.setattr(scanmod, "scan_todos", lambda root: [
        Candidate("todo", "todo:a.ts:1", "a.ts", 1, "TODO x", 10)])
    monkeypatch.setattr(scanmod, "scan_skipped_tests", lambda root: [])
    monkeypatch.setattr(scanmod, "scan_tsc", lambda root, runner=None: [
        Candidate("tsc", "tsc:a.ts:5:TS1", "a.ts", 5, "err", 50),
        Candidate("tsc", "tsc:a.ts:5:TS1", "a.ts", 5, "dup", 50)])
    monkeypatch.setattr(scanmod, "scan_lint", lambda root, runner=None: [])
    monkeypatch.setattr(scanmod, "scan_issues", lambda runner=None: [
        Candidate("issue", "issue:9", "", 0, "Titel", 20)])
    out = scanmod.scan_all(tmp_path)
    keys = [c.key for c in out]
    assert keys == ["tsc:a.ts:5:TS1", "issue:9", "todo:a.ts:1"]  # nach Priorität, Dup entfernt
```

- [ ] **Step 2: Test läuft, FEHLSCHLAG bestätigen**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_triage_scan.py -k scan_all -v`
Expected: FAIL (`AttributeError: scan_all`)

- [ ] **Step 3: Implementieren** (anhängen; die internen Aufrufe MÜSSEN über das Modul erfolgen, damit monkeypatch greift — daher Modul-qualifizierte Aufrufe vermeiden und stattdessen die Funktionen direkt referenzieren, die zur Laufzeit im Modul-Namespace nachgeschlagen werden)

```python
def scan_all(root, runner=subprocess.run) -> list[Candidate]:
    collected: list[Candidate] = []
    collected += scan_todos(root)
    collected += scan_skipped_tests(root)
    collected += scan_tsc(root, runner=runner)
    collected += scan_lint(root, runner=runner)
    collected += scan_issues(runner=runner)
    seen: set[str] = set()
    unique: list[Candidate] = []
    for c in collected:
        if c.key in seen:
            continue
        seen.add(c.key)
        unique.append(c)
    unique.sort(key=lambda c: (-c.raw_priority, c.key))
    return unique
```

- [ ] **Step 4: Tests grün**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_triage_scan.py -v`
Expected: PASS (alle)

- [ ] **Step 5: Commit**

```bash
git add tools/academy-auto/academy_auto/triage/scan.py tools/academy-auto/tests/test_triage_scan.py
git commit -m "feat(academy-auto): Triage scan_all Aggregator (Dedup + Priorisierung)"
```

---

## Task 5: State-Modul (Filter + Quarantäne)

**Files:**
- Create: `tools/academy-auto/academy_auto/triage/state.py`
- Test: `tools/academy-auto/tests/test_triage_state.py`

**Interfaces:**
- Consumes: `Candidate` (scan.py).
- Produces: `load_state(path) -> dict`; `save_state(path, state) -> None`; `record_outcome(state, key, status, now=None) -> None`; `is_quarantined(entry) -> bool`; `quarantined_keys(state) -> list[str]`; `filter_candidates(state, candidates) -> list[Candidate]` (entfernt erledigte `committed` + quarantänierte). State-Form: `{key: {"attempts": int, "last_status": str, "last_run": str|None}}`.

- [ ] **Step 1: Failing test schreiben**

```python
# tools/academy-auto/tests/test_triage_state.py
from academy_auto.triage.scan import Candidate
from academy_auto.triage.state import (
    load_state, save_state, record_outcome, is_quarantined, quarantined_keys, filter_candidates,
)


def _cand(key):
    return Candidate("todo", key, "a.ts", 1, "x", 10)


def test_load_missing_returns_empty(tmp_path):
    assert load_state(tmp_path / "nope.json") == {}


def test_load_corrupt_returns_empty(tmp_path):
    p = tmp_path / "s.json"
    p.write_text("{not json")
    assert load_state(p) == {}


def test_record_and_save_roundtrip(tmp_path):
    p = tmp_path / "s.json"
    state = {}
    record_outcome(state, "todo:a.ts:1", "discarded", now="2026-07-22")
    assert state["todo:a.ts:1"]["attempts"] == 1
    assert state["todo:a.ts:1"]["last_status"] == "discarded"
    record_outcome(state, "todo:a.ts:1", "discarded", now="2026-07-22")
    assert state["todo:a.ts:1"]["attempts"] == 2
    save_state(p, state)
    assert load_state(p) == state


def test_is_quarantined_after_two_fails():
    assert is_quarantined({"attempts": 2, "last_status": "discarded"}) is True
    assert is_quarantined({"attempts": 2, "last_status": "impl_failed"}) is True
    assert is_quarantined({"attempts": 1, "last_status": "discarded"}) is False
    assert is_quarantined({"attempts": 5, "last_status": "committed"}) is False


def test_filter_removes_done_and_quarantined():
    state = {
        "todo:done:1": {"attempts": 1, "last_status": "committed"},
        "todo:quar:1": {"attempts": 2, "last_status": "discarded"},
    }
    cands = [_cand("todo:done:1"), _cand("todo:quar:1"), _cand("todo:fresh:1")]
    kept = filter_candidates(state, cands)
    assert [c.key for c in kept] == ["todo:fresh:1"]


def test_quarantined_keys_lists_them():
    state = {
        "a": {"attempts": 2, "last_status": "discarded"},
        "b": {"attempts": 1, "last_status": "discarded"},
    }
    assert quarantined_keys(state) == ["a"]
```

- [ ] **Step 2: Test läuft, FEHLSCHLAG bestätigen**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_triage_state.py -v`
Expected: FAIL (`ModuleNotFoundError: academy_auto.triage.state`)

- [ ] **Step 3: Implementieren**

```python
# tools/academy-auto/academy_auto/triage/state.py
from __future__ import annotations

import json
from pathlib import Path

_FAIL_STATUSES = {"discarded", "impl_failed"}


def load_state(path) -> dict:
    p = Path(path)
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text())
    except (ValueError, OSError):
        return {}


def save_state(path, state) -> None:
    Path(path).write_text(json.dumps(state, indent=2, ensure_ascii=False))


def record_outcome(state, key, status, now=None) -> None:
    entry = state.get(key, {"attempts": 0, "last_status": None, "last_run": None})
    state[key] = {
        "attempts": entry.get("attempts", 0) + 1,
        "last_status": status,
        "last_run": now,
    }


def is_quarantined(entry) -> bool:
    return entry.get("attempts", 0) >= 2 and entry.get("last_status") in _FAIL_STATUSES


def quarantined_keys(state) -> list[str]:
    return [k for k, v in state.items() if is_quarantined(v)]


def filter_candidates(state, candidates) -> list:
    kept = []
    for c in candidates:
        entry = state.get(c.key)
        if entry is None:
            kept.append(c)
            continue
        if entry.get("last_status") == "committed" or is_quarantined(entry):
            continue
        kept.append(c)
    return kept
```

- [ ] **Step 4: Tests grün + volle Suite**

Run: `cd tools/academy-auto && python3 -m pytest tests/ -v`
Expected: PASS (alle bestehenden + neue Triage-Tests)

- [ ] **Step 5: Commit**

```bash
git add tools/academy-auto/academy_auto/triage/state.py tools/academy-auto/tests/test_triage_state.py
git commit -m "feat(academy-auto): Triage-State mit Quarantaene + Kandidaten-Filter"
```

---

## Self-Review

- **Spec-Coverage (T-Phase 1):** vier Quellen → Task 1 (todo/skip), Task 2 (tsc/lint), Task 3 (issues); Dedup+Vorsortierung → Task 4; State/Quarantäne (§4 der Spec) → Task 5. haiku-Ranker, Orchestrator-Integration, Digest und Delta-Gate sind bewusst T-Phase 2/3 (eigene Pläne).
- **Platzhalter:** keine; jeder Schritt enthält vollständigen Code + Kommandos.
- **Typ-Konsistenz:** `Candidate`-Felder/`source`/`raw_priority`/key-Formate durchgängig identisch; `scan_*`-Signaturen mit injizierbarem `runner`; `filter_candidates`/`record_outcome`/`is_quarantined` konsistent mit der State-Form. `scan_all` referenziert die Funktionen im Modul-Namespace (monkeypatch-fähig).
