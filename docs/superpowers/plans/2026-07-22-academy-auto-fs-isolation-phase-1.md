# Academy-Auto FS-Isolation Phase 1 (sandbox.py) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ein `sandbox.py`-Modul, das aus der Config ein `sandbox-exec`-Profil erzeugt (Schreiben nur im Worktree, Secrets nicht lesbar), den `claude`-Aufruf darin kapselt und per Verfügbarkeits-Check fail-closed absichert — bewiesen durch einen echten Isolations-Smoke-Test.

**Architecture:** Neues Modul `academy_auto/sandbox.py` + zwei Config-Felder. `build_profile` erzeugt SBPL-Text (Pfade via realpath aufgelöst wegen `/tmp`→`/private/tmp`-Symlinks). `write_profile` legt es als Temp-Datei ab. `wrap_command` kapselt ein Kommando in `sandbox-exec -f`. `sandbox_available` prüft Verfügbarkeit + Profil-Kompilierung (Dry-Run). Ein Smoke-Test nutzt das echte `sandbox-exec`, um zu beweisen, dass das Profil wirklich isoliert.

**Tech Stack:** Python 3 (stdlib: `os`, `pathlib`, `subprocess`, `tempfile`, `shutil`) + pytest.

## Global Constraints

- Nur stdlib + pytest, keine neuen Laufzeit-Abhängigkeiten.
- Arbeit ausschließlich unter `tools/academy-auto/`; niemals `git add -A`/`.`, nur explizite Pfade.
- Alle Pfade im Profil werden mit `os.path.realpath` aufgelöst (Symlink-Falle `/tmp`→`/private/tmp`).
- SBPL-Struktur: `(allow default)` → `(deny file-write*)` → write-allow Worktree + `cfg.sandbox_write_paths` → `(allow file-write-data (path "/dev/null") …)` → read-deny `cfg.secret_read_paths` → `(allow file-read* (subpath "<WORKTREE>"))` als letzte Zeile (last-match-wins).
- `~/.claude` ist bewusst NICHT in der Read-Deny-Liste (Claude braucht seine eigenen Auth-Dateien).
- Config bleibt `frozen=True`; neue Felder sind Tupel.
- Smoke-Test wird übersprungen, wenn `sandbox-exec` fehlt (`pytest.mark.skipif`).

---

## File Structure

- Modify: `tools/academy-auto/academy_auto/config.py` — Felder `secret_read_paths`, `sandbox_write_paths`
- Create: `tools/academy-auto/academy_auto/sandbox.py` — `build_profile`, `write_profile`, `wrap_command`, `sandbox_available`
- Test: `tools/academy-auto/tests/test_sandbox.py`, erweitert `tests/test_config.py`

---

## Task 1: Config-Felder + Profil-Bau (`build_profile` / `write_profile` / `wrap_command`)

**Files:**
- Modify: `tools/academy-auto/academy_auto/config.py`
- Create: `tools/academy-auto/academy_auto/sandbox.py`
- Test: `tools/academy-auto/tests/test_sandbox.py`, `tools/academy-auto/tests/test_config.py`

**Interfaces:**
- Produces: `Config.secret_read_paths: tuple[str, ...]`, `Config.sandbox_write_paths: tuple[str, ...]`; `build_profile(cfg) -> str`; `write_profile(cfg) -> Path`; `wrap_command(cfg, cmd, profile_path) -> list[str]`.

- [ ] **Step 1: Failing test schreiben**

```python
# tools/academy-auto/tests/test_sandbox.py
import os
from pathlib import Path
from academy_auto.config import Config
from academy_auto.sandbox import build_profile, write_profile, wrap_command


def _cfg(tmp_path, **over):
    base = Config.default().__dict__
    base.update({"worktree_path": tmp_path / "wt"}, **over)
    return Config(**base)


def test_build_profile_allows_worktree_write_and_denies_secrets(tmp_path):
    cfg = Config(**{**Config.default().__dict__,
                    "worktree_path": tmp_path / "wt",
                    "secret_read_paths": (str(tmp_path / "secret"),)})
    prof = build_profile(cfg)
    wt_real = os.path.realpath(str(tmp_path / "wt"))
    assert "(version 1)" in prof
    assert "(allow default)" in prof
    assert "(deny file-write*)" in prof
    assert f'(subpath "{wt_real}")' in prof  # Worktree schreibbar
    assert "file-read*" in prof and os.path.realpath(str(tmp_path / "secret")) in prof  # Secret gesperrt
    # ~/.claude ist NICHT in der Read-Deny-Liste
    claude_dir = os.path.realpath(str(Path.home() / ".claude"))
    # der Deny-Block darf ~/.claude nicht enthalten
    deny_section = prof.split("deny file-read*")[1] if "deny file-read*" in prof else ""
    assert claude_dir not in deny_section


def test_build_profile_worktree_reallowed_last(tmp_path):
    cfg = _cfg(tmp_path)
    prof = build_profile(cfg)
    # die Worktree-Read-Allow steht NACH dem Read-Deny (last-match-wins)
    assert prof.index("deny file-read*") < prof.rindex("allow file-read*")


def test_write_profile_creates_readable_file(tmp_path):
    cfg = _cfg(tmp_path)
    p = write_profile(cfg)
    assert Path(p).exists()
    assert "(version 1)" in Path(p).read_text()


def test_wrap_command_structure(tmp_path):
    cfg = _cfg(tmp_path)
    wrapped = wrap_command(cfg, ["claude", "-p", "tu was"], "/tmp/prof.sb")
    assert wrapped[:3] == ["sandbox-exec", "-f", "/tmp/prof.sb"]
    assert wrapped[3:] == ["claude", "-p", "tu was"]


def test_config_default_has_sandbox_fields():
    cfg = Config.default()
    assert isinstance(cfg.secret_read_paths, tuple)
    assert isinstance(cfg.sandbox_write_paths, tuple)
    assert any(".ssh" in p for p in cfg.secret_read_paths)
```

Ergänze in `tests/test_config.py` eine Zeile im Invarianten-Test:
```python
    assert isinstance(cfg.secret_read_paths, tuple)
```

- [ ] **Step 2: Test läuft, FEHLSCHLAG bestätigen**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_sandbox.py -v`
Expected: FAIL (`ModuleNotFoundError: academy_auto.sandbox` / `AttributeError secret_read_paths`)

- [ ] **Step 3: Implementieren**

In `config.py` die Felder nach `triage_state_path` ergänzen:
```python
    secret_read_paths: tuple[str, ...]
    sandbox_write_paths: tuple[str, ...]
```
und in `Config.default()` (nach `triage_state_path=...`; `home` ist dort definiert):
```python
            secret_read_paths=(
                str(home / ".ssh"), str(home / ".aws"), str(home / ".config/gcloud"),
                str(home / ".whitestag.env"), str(home / ".n8n"), str(home / ".paperclip"),
                str(home / "Library/CloudStorage/SynologyDrive-Mac/Claude Code MAC"),
            ),
            sandbox_write_paths=(
                "/private/tmp", "/private/var/folders",
                str(home / ".npm"), str(home / "Library/Caches"),
                str(home / ".cache"), str(home / ".expo"), str(home / ".claude"),
            ),
```

```python
# tools/academy-auto/academy_auto/sandbox.py
from __future__ import annotations

import os
import tempfile
from pathlib import Path

from .config import Config

_DEVICE_WRITES = ("/dev/null", "/dev/tty", "/dev/dtracehelper", "/dev/random", "/dev/urandom")


def _real(p) -> str:
    return os.path.realpath(str(p))


def build_profile(cfg: Config) -> str:
    """SBPL-Profil: Schreiben nur im Worktree (+ Caches), Secrets nicht lesbar."""
    wt = _real(cfg.worktree_path)
    lines = [
        "(version 1)",
        "(allow default)",
        "(deny file-write*)",
        f'(allow file-write* (subpath "{wt}"))',
    ]
    for w in cfg.sandbox_write_paths:
        lines.append(f'(allow file-write* (subpath "{_real(w)}"))')
    dev = " ".join(f'(path "{d}")' for d in _DEVICE_WRITES)
    lines.append(f"(allow file-write-data {dev})")
    if cfg.secret_read_paths:
        denies = " ".join(f'(subpath "{_real(s)}")' for s in cfg.secret_read_paths)
        lines.append(f"(deny file-read* {denies})")
    # Worktree-Reads zuletzt wieder erlauben (liegt evtl. unter einem Deny-Pfad)
    lines.append(f'(allow file-read* (subpath "{wt}"))')
    return "\n".join(lines) + "\n"


def write_profile(cfg: Config) -> Path:
    fd, path = tempfile.mkstemp(prefix="academy-auto-sb-", suffix=".sb")
    with os.fdopen(fd, "w") as f:
        f.write(build_profile(cfg))
    return Path(path)


def wrap_command(cfg: Config, cmd, profile_path) -> list:
    return ["sandbox-exec", "-f", str(profile_path), *cmd]
```

- [ ] **Step 4: Tests grün**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_sandbox.py tests/test_config.py -v`
Expected: PASS (alle)

- [ ] **Step 5: Commit**

```bash
git add tools/academy-auto/academy_auto/config.py tools/academy-auto/academy_auto/sandbox.py tools/academy-auto/tests/test_sandbox.py tools/academy-auto/tests/test_config.py
git commit -m "feat(academy-auto): sandbox-Profilbau (write-allowlist + read-denylist)"
```

---

## Task 2: Verfügbarkeits-Check + echter Isolations-Smoke-Test

**Files:**
- Modify: `tools/academy-auto/academy_auto/sandbox.py`
- Test: `tools/academy-auto/tests/test_sandbox.py`

**Interfaces:**
- Consumes: `build_profile`/`write_profile`/`wrap_command` (Task 1).
- Produces: `sandbox_available(cfg, runner=subprocess.run) -> bool` — True nur wenn `sandbox-exec` vorhanden UND das Profil kompiliert (Dry-Run `sandbox-exec -f <profil> /usr/bin/true` mit returncode 0); fail-soft (Exception/kein Tool → False).

- [ ] **Step 1: Failing test schreiben** (an `tests/test_sandbox.py` anhängen)

```python
import shutil
import subprocess
import pytest
from academy_auto.sandbox import sandbox_available


def test_sandbox_available_false_when_tool_missing(tmp_path):
    cfg = _cfg(tmp_path)
    def no_tool(*a, **k):
        raise FileNotFoundError("sandbox-exec not found")
    assert sandbox_available(cfg, runner=no_tool) is False


def test_sandbox_available_true_on_clean_dryrun(tmp_path):
    cfg = _cfg(tmp_path)
    def ok(*a, **k):
        class R:
            returncode = 0
        return R()
    assert sandbox_available(cfg, runner=ok) is True


def test_sandbox_available_false_on_bad_profile(tmp_path):
    cfg = _cfg(tmp_path)
    def rc1(*a, **k):
        class R:
            returncode = 1
        return R()
    assert sandbox_available(cfg, runner=rc1) is False


@pytest.mark.skipif(shutil.which("sandbox-exec") is None, reason="sandbox-exec nicht verfügbar")
def test_generated_profile_really_isolates(tmp_path):
    wt = tmp_path / "wt"; wt.mkdir()
    secret = tmp_path / "secret"; secret.mkdir()
    (secret / "token.txt").write_text("TOPSECRET")
    outside = tmp_path / "outside"; outside.mkdir()
    # NUR der Worktree ist schreibbar (Caches leer), Secret-Pfad gesperrt
    cfg = Config(**{**Config.default().__dict__,
                    "worktree_path": wt,
                    "sandbox_write_paths": (),
                    "secret_read_paths": (str(secret),)})
    profile = write_profile(cfg)

    def sb(bash):
        return subprocess.run(
            wrap_command(cfg, ["/bin/bash", "-c", bash], str(profile)),
            capture_output=True, text=True,
        )

    # Schreiben IM Worktree: erlaubt
    r = sb(f'echo x > "{wt}/a.txt" && echo WROTE')
    assert "WROTE" in r.stdout and (wt / "a.txt").exists()
    # Schreiben AUSSERHALB: blockiert
    r = sb(f'echo x > "{outside}/b.txt" 2>/dev/null && echo LEAK || echo BLOCKED')
    assert "BLOCKED" in r.stdout
    assert not (outside / "b.txt").exists()
    # Secret LESEN: verweigert
    r = sb(f'cat "{secret}/token.txt" 2>/dev/null && echo READ || echo DENIED')
    assert "DENIED" in r.stdout
    assert "TOPSECRET" not in r.stdout
```

- [ ] **Step 2: Test läuft, FEHLSCHLAG bestätigen**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_sandbox.py -k "available or isolates" -v`
Expected: FAIL (`ImportError: cannot import name 'sandbox_available'`)

- [ ] **Step 3: Implementieren** (an `sandbox.py` anhängen)

```python
import subprocess


def sandbox_available(cfg: Config, runner=subprocess.run) -> bool:
    """True nur wenn sandbox-exec vorhanden UND das Profil sauber kompiliert (Dry-Run)."""
    profile = write_profile(cfg)
    try:
        proc = runner(
            ["sandbox-exec", "-f", str(profile), "/usr/bin/true"],
            capture_output=True, text=True, check=False, timeout=30,
        )
    except Exception:
        return False
    return getattr(proc, "returncode", 1) == 0
```

- [ ] **Step 4: Tests grün + volle Suite**

Run: `cd tools/academy-auto && python3 -m pytest tests/ -v`
Expected: PASS (alle; der Isolations-Smoke-Test läuft real durch, sofern `sandbox-exec` da ist)

- [ ] **Step 5: Commit**

```bash
git add tools/academy-auto/academy_auto/sandbox.py tools/academy-auto/tests/test_sandbox.py
git commit -m "feat(academy-auto): sandbox_available (fail-closed) + echter Isolations-Smoke-Test"
```

---

## Self-Review

- **Spec-Coverage (Phase 1):** Profilbau (write-allowlist + read-denylist, `~/.claude` offen, `Claude Code MAC` gesperrt) → Task 1; `wrap_command`/`write_profile` → Task 1; `sandbox_available` (fail-closed-Grundlage) + echter Isolations-Beweis → Task 2. Integration in `runner.implement_task` = Phase 2; Kalibrier-Smoke mit echtem claude = Phase 3.
- **Platzhalter:** keine; jeder Schritt enthält vollständigen Code + Kommandos.
- **Typ-Konsistenz:** `build_profile`/`write_profile`/`wrap_command`/`sandbox_available`, `secret_read_paths`/`sandbox_write_paths` durchgängig identisch; realpath-Auflösung überall via `_real`; Smoke-Test setzt `sandbox_write_paths=()` um „nur Worktree schreibbar" scharf zu prüfen.
