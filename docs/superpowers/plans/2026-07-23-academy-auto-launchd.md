# Academy-Auto launchd-Automatik Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Der Loop läuft täglich nachts unbeaufsichtigt — zunächst im Trockenlauf (alles echt außer dem Commit), robust gegen unerwartete Fehler, mit Jarvis/Telegram-Digest.

**Architecture:** `Config` bekommt `dry_run_flag`. `run_once` wird in eine Top-Level-Fehlerbehandlung gewickelt und überspringt im Trockenlauf den Commit (Status `dry_run`, Worktree-Reset, keine State-Verbuchung). Ein neues `notify.py` sendet den Digest per Telegram (Token aus der bestehenden Bot-`.env`, Chat-ID dynamisch aus `voice-echo-tenants.json` über `vault == "whitestag"`) — stdlib-only via `urllib`, fail-soft. Deploy nach `~/.paperclip/scripts/academy-auto/` + plist um 02:00.

**Tech Stack:** Python 3 (stdlib: `json`, `os`, `urllib`) + pytest; launchd/plist; zsh.

## Global Constraints

- Nur stdlib + pytest, keine neuen Laufzeit-Abhängigkeiten.
- Arbeit ausschließlich unter `tools/academy-auto/`; niemals `git add -A`/`.`, nur explizite Pfade.
- **Trockenlauf** (`~/.paperclip/academy-auto.dryrun` existiert): kompletter Lauf, aber KEIN `commit_and_pr`, KEINE `record_triage_outcome`, danach `reset_worktree`; Status `dry_run`.
- **Top-Level-Except:** jede unerwartete Exception in `run_once` → Digest + Status `error`, nie ein Crash.
- Pause-Flag hat weiterhin Vorrang vor allem (auch vor dem Trockenlauf).
- Telegram fail-soft: Versandfehler darf den Lauf nie abbrechen.
- **Keine persönlichen IDs im Repo** — Chat-ID wird zur Laufzeit aus `~/.paperclip/voice-echo-tenants.json` aufgelöst (erster Eintrag mit `vault == "whitestag"`).
- Bestehende 121 Tests müssen grün bleiben.

---

## File Structure

- Modify: `academy_auto/config.py` — Feld `dry_run_flag`
- Modify: `academy_auto/report.py` — Parameter `result_override`
- Modify: `academy_auto/orchestrator.py` — Trockenlauf + Top-Level-Except + Sender-Verdrahtung
- Create: `academy_auto/notify.py` — Telegram-Digest (fail-soft)
- Test: `tests/test_orchestrator.py`, `tests/test_report.py`, `tests/test_notify.py`, `tests/test_config.py`

---

## Task 1: Trockenlauf-Modus + Top-Level-Fehlerbehandlung

**Files:**
- Modify: `academy_auto/config.py`, `academy_auto/report.py`, `academy_auto/orchestrator.py`
- Test: `tests/test_orchestrator.py`, `tests/test_report.py`, `tests/test_config.py`

**Interfaces:**
- Produces: `Config.dry_run_flag: Path`; `build_digest(..., result_override: str = "")`; `run_once` Status `"dry_run"` und `"error"`.

- [ ] **Step 1: Failing test schreiben**

In `tests/test_report.py`:
```python
def test_build_digest_result_override_replaces_result_line():
    from academy_auto.runner import RunOutcome
    from academy_auto.report import build_digest
    text = build_digest(
        task_prompt="x", run_outcome=RunOutcome(ok=True, output=""),
        gate_result=None, committed=False,
        result_override="TROCKENLAUF — hätte committet (3 Dateien, 42 Zeilen)",
    )
    assert "TROCKENLAUF" in text
    assert "42 Zeilen" in text
    assert "kein grünes Gate" not in text
```

In `tests/test_orchestrator.py` (nutzt die vorhandenen globalen `sent`/`recorded`/`resets`, `base_deps`, `two_stage_measure`):
```python
def test_run_once_dry_run_skips_commit_and_recording(tmp_path):
    global sent, recorded, resets
    sent, recorded, resets = [], [], []
    from academy_auto.triage.rank import Pick
    dry = tmp_path / "academy-auto.dryrun"
    dry.write_text("")
    cfg = Config.default()
    cfg = Config(**{**cfg.__dict__, "pause_flag": tmp_path / "nope.pause", "dry_run_flag": dry})
    deps = base_deps(
        triage_and_pick=lambda cfg, cwd, baseline_red: Pick("todo:b.ts:1", "b umsetzen", "grund"),
        commit_and_pr=lambda cfg, cwd, prompt: (_ for _ in ()).throw(AssertionError("Trockenlauf darf NICHT committen")),
    )
    report = run_once(cfg, None, deps)
    assert report.status == "dry_run"
    assert recorded == []          # keine State-Verbuchung im Trockenlauf
    assert len(resets) == 1        # Worktree zurückgesetzt
    assert any("TROCKENLAUF" in s for s in sent)


def test_run_once_commits_when_dry_run_flag_absent(tmp_path):
    global sent, recorded, resets
    sent, recorded, resets = [], [], []
    cfg = Config.default()
    cfg = Config(**{**cfg.__dict__, "pause_flag": tmp_path / "nope.pause",
                    "dry_run_flag": tmp_path / "kein.dryrun"})
    report = run_once(cfg, "manuell", base_deps())
    assert report.status == "committed"


def test_run_once_top_level_error_is_caught(tmp_path):
    global sent, recorded, resets
    sent, recorded, resets = [], [], []
    cfg = Config.default()
    cfg = Config(**{**cfg.__dict__, "pause_flag": tmp_path / "nope.pause",
                    "dry_run_flag": tmp_path / "kein.dryrun"})
    deps = base_deps(prepare_worktree=lambda cfg: (_ for _ in ()).throw(RuntimeError("worktree kaputt")))
    report = run_once(cfg, "manuell", deps)
    assert report.status == "error"
    assert len(sent) == 1 and "kaputt" in sent[0]


def test_pause_flag_wins_over_dry_run(tmp_path):
    global sent, recorded, resets
    sent, recorded, resets = [], [], []
    pause = tmp_path / "p.pause"; pause.write_text("")
    dry = tmp_path / "d.dryrun"; dry.write_text("")
    cfg = Config.default()
    cfg = Config(**{**cfg.__dict__, "pause_flag": pause, "dry_run_flag": dry})
    assert run_once(cfg, None, base_deps()).status == "paused"
    assert sent == []
```

In `tests/test_config.py` eine Zeile ergänzen:
```python
    assert cfg.dry_run_flag.name == "academy-auto.dryrun"
```

- [ ] **Step 2: Test läuft, FEHLSCHLAG bestätigen**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_orchestrator.py tests/test_report.py tests/test_config.py -v`
Expected: FAIL (`AttributeError dry_run_flag` / `unexpected keyword 'result_override'`)

- [ ] **Step 3: Implementieren**

`config.py` — Feld nach `pause_flag` deklarieren:
```python
    dry_run_flag: Path
```
und in `Config.default()` nach `pause_flag=…`:
```python
            dry_run_flag=home / ".paperclip" / "academy-auto.dryrun",
```

`report.py` — Signatur um `result_override: str = ""` erweitern und den Ergebnis-Block voranstellen:
```python
    if result_override:
        lines.append(f"Ergebnis: {result_override}")
    elif committed:
        lines.append("Ergebnis: auf agents/academy-auto committet")
    elif scope_violations:
        ...
```
(der Rest des elif-Blocks unverändert)

`orchestrator.py` — `run_once` umbauen: Pause-Check + Top-Level-Except außen, Rumpf nach innen:
```python
def run_once(cfg: Config, task_prompt, deps) -> RunReport:
    """Pause → [Top-Level-Schutz] → Worktree → Baseline → Triage → Impl → Delta → Scope → Cap → Commit/Trockenlauf."""
    if cfg.pause_flag.exists():
        return RunReport(status="paused")
    try:
        return _run_once_inner(cfg, task_prompt, deps)
    except Exception as exc:
        try:
            deps.send_digest(f"🎓 Academy-Auto — unerwarteter Fehler\n\n{exc}")
        except Exception:
            pass
        return RunReport(status="error")


def _run_once_inner(cfg: Config, task_prompt, deps) -> RunReport:
```
Der bisherige Rumpf ab `cwd = deps.prepare_worktree(cfg)` wandert unverändert in `_run_once_inner` — MIT einer Änderung am Commit-Block ganz unten: ersetze
```python
    deps.commit_and_pr(cfg, cwd, task_prompt)
    deps.send_digest(build_digest(task_prompt, outcome, None, committed=True, reason=reason, quarantined=quar, gate_note=delta.note))
    return _finalize(deps, cfg, cwd, pick, "committed")
```
durch
```python
    if cfg.dry_run_flag.exists():
        summary = f"{len(changed)} Dateien, {lines} Zeilen"
        deps.send_digest(build_digest(
            task_prompt, outcome, None, committed=False, reason=reason, quarantined=quar,
            gate_note=delta.note,
            result_override=f"TROCKENLAUF — hätte committet ({summary})",
        ))
        deps.reset_worktree(cfg, cwd)   # nichts bleibt liegen; KEINE State-Verbuchung
        return RunReport(status="dry_run")

    deps.commit_and_pr(cfg, cwd, task_prompt)
    deps.send_digest(build_digest(task_prompt, outcome, None, committed=True, reason=reason, quarantined=quar, gate_note=delta.note))
    return _finalize(deps, cfg, cwd, pick, "committed")
```
Und den `RunReport`-Kommentar erweitern um `"dry_run" | "error"`.

- [ ] **Step 4: Tests grün + volle Suite**

Run: `cd tools/academy-auto && python3 -m pytest tests/ -v`
Expected: PASS (alle bestehenden + neue)

- [ ] **Step 5: Commit**

```bash
git add tools/academy-auto/academy_auto/config.py tools/academy-auto/academy_auto/report.py tools/academy-auto/academy_auto/orchestrator.py tools/academy-auto/tests/test_orchestrator.py tools/academy-auto/tests/test_report.py tools/academy-auto/tests/test_config.py
git commit -m "feat(academy-auto): Trockenlauf-Modus + Top-Level-Fehlerbehandlung"
```

---

## Task 2: Telegram-Digest (`notify.py`)

**Files:**
- Create: `academy_auto/notify.py`
- Modify: `academy_auto/orchestrator.py` (`_build_default_deps`)
- Test: `tests/test_notify.py`

**Interfaces:**
- Produces: `read_env_value(path, key) -> str | None`; `resolve_chat_id(tenants_path, vault="whitestag") -> str | None`; `send_telegram(text, token, chat_id, opener=urllib.request.urlopen) -> bool`; `send_digest(text, env_path=ENV_PATH, tenants_path=TENANTS_PATH, opener=…) -> bool` (fail-soft, gibt False statt zu werfen). Konstanten `ENV_PATH = ~/.paperclip/voice-echo-bot.env`, `TENANTS_PATH = ~/.paperclip/voice-echo-tenants.json`.

- [ ] **Step 1: Failing test schreiben**

```python
# tools/academy-auto/tests/test_notify.py
import json
from academy_auto.notify import read_env_value, resolve_chat_id, send_telegram, send_digest


def test_read_env_value(tmp_path):
    p = tmp_path / "bot.env"
    p.write_text("# Kommentar\nTELEGRAM_BOT_TOKEN=abc123\nANDERES=x\n")
    assert read_env_value(p, "TELEGRAM_BOT_TOKEN") == "abc123"
    assert read_env_value(p, "FEHLT") is None


def test_read_env_value_missing_file(tmp_path):
    assert read_env_value(tmp_path / "gibtsnicht.env", "X") is None


def test_resolve_chat_id_picks_whitestag_tenant(tmp_path):
    p = tmp_path / "tenants.json"
    p.write_text(json.dumps({
        "111": {"name": "Clara", "vault": "clara"},
        "222": {"name": "Walter", "vault": "whitestag"},
    }))
    assert resolve_chat_id(p, vault="whitestag") == "222"


def test_resolve_chat_id_none_when_absent(tmp_path):
    p = tmp_path / "tenants.json"
    p.write_text(json.dumps({"111": {"vault": "clara"}}))
    assert resolve_chat_id(p, vault="whitestag") is None
    assert resolve_chat_id(tmp_path / "weg.json") is None


def test_send_telegram_posts_and_returns_true():
    seen = {}

    class Resp:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): return b'{"ok":true}'

    def opener(req, timeout=None):
        seen["url"] = req.full_url
        seen["data"] = req.data
        return Resp()

    assert send_telegram("hallo", "TOK", "999", opener=opener) is True
    assert "botTOK/sendMessage" in seen["url"]
    assert b"999" in seen["data"] and b"hallo" in seen["data"]


def test_send_telegram_fail_soft():
    def boom(req, timeout=None):
        raise OSError("kein Netz")
    assert send_telegram("x", "T", "1", opener=boom) is False


def test_send_digest_fail_soft_without_config(tmp_path):
    # weder env noch tenants vorhanden -> False, aber KEINE Exception
    assert send_digest("text", env_path=tmp_path / "a.env",
                       tenants_path=tmp_path / "b.json") is False
```

- [ ] **Step 2: Test läuft, FEHLSCHLAG bestätigen**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_notify.py -v`
Expected: FAIL (`ModuleNotFoundError: academy_auto.notify`)

- [ ] **Step 3: Implementieren**

```python
# tools/academy-auto/academy_auto/notify.py
from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request
from pathlib import Path

ENV_PATH = Path.home() / ".paperclip" / "voice-echo-bot.env"
TENANTS_PATH = Path.home() / ".paperclip" / "voice-echo-tenants.json"


def read_env_value(path, key: str):
    """Einfacher KEY=VALUE-Leser. Fehlende Datei/Key -> None, nie werfen."""
    try:
        for line in Path(path).read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            if k.strip() == key:
                return v.strip()
    except OSError:
        return None
    return None


def resolve_chat_id(tenants_path, vault: str = "whitestag"):
    """Chat-ID des Mandanten mit passendem vault (die JSON ist nach Chat-ID gekeyed)."""
    try:
        data = json.loads(Path(tenants_path).read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    for chat_id, entry in data.items():
        if isinstance(entry, dict) and entry.get("vault") == vault:
            return str(chat_id)
    return None


def send_telegram(text: str, token: str, chat_id: str, opener=urllib.request.urlopen) -> bool:
    """Nachricht senden. Fail-soft: Fehler -> False, nie werfen."""
    try:
        data = urllib.parse.urlencode({"chat_id": chat_id, "text": text}).encode()
        req = urllib.request.Request(
            f"https://api.telegram.org/bot{token}/sendMessage", data=data
        )
        with opener(req, timeout=30):
            return True
    except Exception:
        return False


def send_digest(text: str, env_path=ENV_PATH, tenants_path=TENANTS_PATH,
                opener=urllib.request.urlopen) -> bool:
    """Digest an Walters Jarvis-Chat. Fail-soft — der Lauf darf daran nie scheitern."""
    token = read_env_value(env_path, "TELEGRAM_BOT_TOKEN")
    chat_id = resolve_chat_id(tenants_path)
    if not token or not chat_id:
        return False
    return send_telegram(text, token, chat_id, opener=opener)
```

In `orchestrator.py` `_build_default_deps` den Sender umstellen:
```python
        send_digest=_send_digest_default,
```
und den Helfer ergänzen:
```python
def _send_digest_default(text):  # pragma: no cover - echter Versand beim Deploy
    from . import notify
    print(text)              # immer ins launchd-Log
    notify.send_digest(text)  # fail-soft nach Telegram
```

- [ ] **Step 4: Tests grün + volle Suite**

Run: `cd tools/academy-auto && python3 -m pytest tests/ -v`
Expected: PASS (alle)

- [ ] **Step 5: Commit**

```bash
git add tools/academy-auto/academy_auto/notify.py tools/academy-auto/academy_auto/orchestrator.py tools/academy-auto/tests/test_notify.py
git commit -m "feat(academy-auto): Telegram-Digest an den Jarvis-Bot (fail-soft, stdlib)"
```

---

## Task 3: Deploy-Artefakte (`run-nightly.sh` + plist + DEPLOY.md)

**Files:**
- Create: `tools/academy-auto/run-nightly.sh`
- Create: `tools/academy-auto/de.whitestag.academy-auto.plist`
- Modify: `tools/academy-auto/README.md` (Deploy-Abschnitt)

**Interfaces:** Betriebsartefakte; keine Python-Schnittstellen.

- [ ] **Step 1: Artefakte anlegen**

```bash
# tools/academy-auto/run-nightly.sh
#!/bin/zsh
# Nächtlicher academy-auto-Lauf. Wird von launchd über /usr/bin/python3 aufgerufen
# (nicht über das Executable-Bit — SynologyDrive flippt Dateimodi beim Sync).
set -u
cd "$HOME/.paperclip/scripts/academy-auto" || exit 1
exec /usr/bin/python3 -m academy_auto.orchestrator
```

```xml
<!-- tools/academy-auto/de.whitestag.academy-auto.plist
     Beim Deploy HOME-Pfad ersetzen (siehe README). -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>de.whitestag.academy-auto</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/zsh</string>
        <string>/Users/walterschoenenbroecher.de/.paperclip/scripts/academy-auto/run-nightly.sh</string>
    </array>
    <key>WorkingDirectory</key><string>/Users/walterschoenenbroecher.de/.paperclip/scripts/academy-auto</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key><integer>2</integer>
        <key>Minute</key><integer>0</integer>
    </dict>
    <key>RunAtLoad</key><false/>
    <key>StandardOutPath</key><string>/Users/walterschoenenbroecher.de/.paperclip/logs/academy-auto.log</string>
    <key>StandardErrorPath</key><string>/Users/walterschoenenbroecher.de/.paperclip/logs/academy-auto.log</string>
</dict>
</plist>
```

Im `README.md` einen Abschnitt ergänzen:
```markdown
## Betrieb (launchd)

    # Deploy (launchd kann CloudStorage nicht lesen -> Kopie nötig)
    rsync -a --delete tools/academy-auto/ ~/.paperclip/scripts/academy-auto/
    cp tools/academy-auto/de.whitestag.academy-auto.plist ~/Library/LaunchAgents/
    launchctl load ~/Library/LaunchAgents/de.whitestag.academy-auto.plist

    touch ~/.paperclip/academy-auto.dryrun   # Trockenlauf (committet nicht)
    rm    ~/.paperclip/academy-auto.dryrun   # scharf schalten
    touch ~/.paperclip/academy-auto.pause    # Not-Aus

Log: `~/.paperclip/logs/academy-auto.log`
```

- [ ] **Step 2: Syntax prüfen**

Run: `cd tools/academy-auto && zsh -n run-nightly.sh && plutil -lint de.whitestag.academy-auto.plist`
Expected: keine Fehler, `OK`

- [ ] **Step 3: Volle Suite**

Run: `cd tools/academy-auto && python3 -m pytest tests/ -q`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add tools/academy-auto/run-nightly.sh tools/academy-auto/de.whitestag.academy-auto.plist tools/academy-auto/README.md
git commit -m "feat(academy-auto): launchd-Artefakte (run-nightly.sh, plist 02:00, Deploy-Doku)"
```

---

## Self-Review

- **Spec-Coverage:** Trockenlauf-Flag + kein Commit + kein Record + Reset + Diff-Summary → Task 1; Top-Level-Except → Task 1; Telegram-Digest ohne neue Credential, Chat-ID dynamisch → Task 2; launchd-Artefakte inkl. der bekannten Fallstricke (zsh statt Executable-Bit, PATH, Deploy-Kopie) → Task 3. Das eigentliche Deployen/Laden + der Probelauf sind operative Schritte nach dem Plan.
- **Platzhalter:** keine; vollständiger Code + Kommandos.
- **Typ-Konsistenz:** `dry_run_flag`, `result_override`, Status `dry_run`/`error`, `notify.send_digest` durchgängig identisch; Pause-Check bleibt VOR dem try (damit `paused` nie als `error` maskiert wird).
