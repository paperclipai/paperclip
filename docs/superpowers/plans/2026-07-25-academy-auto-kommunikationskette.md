# academy-auto Kommunikationskette — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** academy-auto arbeitet nachts, meldet aber erst morgens 08:00 (oder später nur bei Milestones) und nimmt über Telegram-Buttons/Freitext Freigaben und Richtungsvorgaben entgegen, die einen GitHub-PR bzw. ein Issue auslösen.

**Architecture:** Der Nachtlauf sendet nicht mehr direkt, sondern **parkt** ein strukturiertes Ergebnis (`pending.json`). Ein neuer 08:00-launchd-Job **stellt zu** (Modus `daily`/`milestone`, Digest mit Inline-Buttons). Der Jarvis-Bot (`voice-echo-bot`) erkennt Button-Callback + Freitext-Reply, schreibt eine **Intent-Datei** und stößt den **Executor** an, der `approve→PR`, `reject→Branch-Reset`, `direction→Issue` ausführt. Zwei kleine JSON-Verträge (`pending.json`, `intent.json`) halten die Teile entkoppelt und einzeln testbar.

**Tech Stack:** Python 3 (stdlib only: `dataclasses`, `json`, `pathlib`, `subprocess`, `urllib`), pytest (`pythonpath=.`, `testpaths=tests`), `gh` CLI für PR/Issue, launchd. Kein neues Paket, keine externen Abhängigkeiten.

## Global Constraints

- **Fail-soft ist Gesetz:** kein neuer Baustein darf den Nachtlauf oder den Bot crashen. Fehlende/kaputte JSON-Datei → `None`, nie werfen. Telegram/`gh`-Fehler → geloggt, nichts geht verloren.
- **Kein zweiter Telegram-Poller:** `voice-echo-bot` bleibt die einzige Instanz, die Updates dieses Bots liest. Der Bot schreibt nur `intent.json` und stößt den Executor per Subprozess an.
- **Quelle vs. Deploy:** Quelle ist `tools/academy-auto/` (Paperclip-Repo) bzw. `tools/voice-echo-bot/`. Deploy-Ziel academy-auto: `~/.paperclip/scripts/academy-auto/`. Tests laufen gegen die Quelle.
- **Repo-Pfade (bestehende `Config.default`):** Academy-Repo `~/Developer/WHITESTAG.ACADEMY`, Worktree `~/.academy-auto/worktree`, Branch `agents/academy-auto`, Base `main`. State-Basis `~/.paperclip/academy-auto/`.
- **Test-Konvention:** neue Tests als `tools/academy-auto/tests/test_<modul>.py`; Ausführung `cd tools/academy-auto && python3 -m pytest tests/test_<modul>.py -v`.
- **Atomare JSON-Schreibvorgänge:** in Temp-Datei schreiben + `os.replace` (kein halber Zustand bei Absturz).
- **YAGNI:** keine Web-UI, keine Historie, kein Auto-Merge, 1 Task/Lauf bleibt.

---

### Task 1: Config um Kommunikations-Felder erweitern

**Files:**
- Modify: `academy_auto/config.py` (Dataclass-Felder + `default()`)
- Test: `tests/test_config.py`

**Interfaces:**
- Produces: `Config.notify_mode: str` (`"daily"`), `Config.pending_path: Path`, `Config.intent_path: Path`, `Config.milestone_delta_threshold: int` (`50`), `Config.github_repo: str` (`"whitestagai/ki-kompass"`).

- [ ] **Step 1: Failing test**

```python
# tests/test_config.py  (append)
def test_default_has_communication_fields():
    from academy_auto.config import Config
    cfg = Config.default()
    assert cfg.notify_mode == "daily"
    assert cfg.pending_path.name == "pending.json"
    assert cfg.intent_path.name == "intent.json"
    assert cfg.milestone_delta_threshold == 50
    assert cfg.github_repo == "whitestagai/ki-kompass"
    # unter der bestehenden State-Basis ~/.paperclip/academy-auto/
    assert cfg.pending_path.parent == cfg.triage_state_path.parent
```

- [ ] **Step 2: Run to verify FAIL**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_config.py::test_default_has_communication_fields -v`
Expected: FAIL (`AttributeError: ... 'notify_mode'`).

- [ ] **Step 3: Implement**

In `config.py` fünf Felder zur `@dataclass` hinzufügen (nach `sandbox_write_paths`):

```python
    protected_write_paths: tuple[str, ...]
    notify_mode: str
    pending_path: Path
    intent_path: Path
    milestone_delta_threshold: int
    github_repo: str
```

In `default()` innerhalb des `return cls(` (Basis `base = home / ".paperclip" / "academy-auto"` existiert bereits):

```python
            notify_mode="daily",
            pending_path=base / "pending.json",
            intent_path=base / "intent.json",
            milestone_delta_threshold=50,
            github_repo="whitestagai/ki-kompass",
```

- [ ] **Step 4: Run to verify PASS**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_config.py -v`
Expected: PASS (alle, inkl. bestehende).

- [ ] **Step 5: Commit**

```bash
git add tools/academy-auto/academy_auto/config.py tools/academy-auto/tests/test_config.py
git commit -m "feat(academy-auto): Config-Felder fuer Kommunikationskette"
```

---

### Task 2: `pending.py` — Vertrag Nacht → Morgen

**Files:**
- Create: `academy_auto/pending.py`
- Test: `tests/test_pending.py`

**Interfaces:**
- Produces:
  - `@dataclass(frozen=True) PendingRecord(run_ts: str, outcome: str, task: str, reason: str, gate_note: str, branch_sha: str, has_change: bool, tsc_delta: int, quarantined: list[str])`
  - `write_pending(path: Path, rec: PendingRecord) -> None` (atomar)
  - `read_pending(path: Path) -> PendingRecord | None` (fail-soft)

- [ ] **Step 1: Failing test**

```python
# tests/test_pending.py
from pathlib import Path
from academy_auto.pending import PendingRecord, write_pending, read_pending


def _rec():
    return PendingRecord(
        run_ts="2026-07-25T02:00:03", outcome="committed", task="Jest-Typen",
        reason="17x impact", gate_note="Delta grün (658→12)", branch_sha="abc123",
        has_change=True, tsc_delta=646, quarantined=["tsc:foo:1:TS2593"],
    )


def test_roundtrip(tmp_path):
    p = tmp_path / "pending.json"
    write_pending(p, _rec())
    got = read_pending(p)
    assert got == _rec()


def test_missing_file_returns_none(tmp_path):
    assert read_pending(tmp_path / "nope.json") is None


def test_broken_json_returns_none(tmp_path):
    p = tmp_path / "pending.json"
    p.write_text("{ this is not json")
    assert read_pending(p) is None
```

- [ ] **Step 2: Run to verify FAIL**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_pending.py -v`
Expected: FAIL (`ModuleNotFoundError: academy_auto.pending`).

- [ ] **Step 3: Implement**

```python
# academy_auto/pending.py
from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass(frozen=True)
class PendingRecord:
    run_ts: str
    outcome: str
    task: str
    reason: str
    gate_note: str
    branch_sha: str
    has_change: bool
    tsc_delta: int
    quarantined: list[str]


def write_pending(path: Path, rec: PendingRecord) -> None:
    """Atomar schreiben: Temp + os.replace, damit kein halber Zustand entsteht."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(asdict(rec), ensure_ascii=False, indent=2))
    os.replace(tmp, path)


def read_pending(path: Path) -> PendingRecord | None:
    """Fehlende/kaputte Datei -> None, nie werfen."""
    try:
        data = json.loads(Path(path).read_text())
        return PendingRecord(**data)
    except (OSError, ValueError, TypeError):
        return None
```

- [ ] **Step 4: Run to verify PASS**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_pending.py -v`
Expected: PASS (3 Tests).

- [ ] **Step 5: Commit**

```bash
git add tools/academy-auto/academy_auto/pending.py tools/academy-auto/tests/test_pending.py
git commit -m "feat(academy-auto): pending.json-Vertrag (Nacht->Morgen)"
```

---

### Task 3: `intent.py` — Vertrag Bot → Executor

**Files:**
- Create: `academy_auto/intent.py`
- Test: `tests/test_intent.py`

**Interfaces:**
- Produces:
  - `@dataclass(frozen=True) Intent(ts: str, kind: str, text: str, ref_run_ts: str)` — `kind ∈ {"approve","reject","direction"}`
  - `write_intent(path: Path, intent: Intent) -> None` (atomar)
  - `read_intent(path: Path) -> Intent | None` (fail-soft)
  - `clear_intent(path: Path) -> None` (fehlt-egal)

- [ ] **Step 1: Failing test**

```python
# tests/test_intent.py
from academy_auto.intent import Intent, write_intent, read_intent, clear_intent


def test_roundtrip(tmp_path):
    p = tmp_path / "intent.json"
    it = Intent(ts="2026-07-25T08:03:11", kind="direction",
                text="Login-Screen responsive", ref_run_ts="2026-07-25T02:00:03")
    write_intent(p, it)
    assert read_intent(p) == it


def test_clear_removes_file(tmp_path):
    p = tmp_path / "intent.json"
    write_intent(p, Intent(ts="t", kind="approve", text="", ref_run_ts="r"))
    clear_intent(p)
    assert read_intent(p) is None
    clear_intent(p)  # zweites Mal wirft nicht


def test_missing_returns_none(tmp_path):
    assert read_intent(tmp_path / "nope.json") is None
```

- [ ] **Step 2: Run to verify FAIL**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_intent.py -v`
Expected: FAIL (`ModuleNotFoundError`).

- [ ] **Step 3: Implement**

```python
# academy_auto/intent.py
from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass(frozen=True)
class Intent:
    ts: str
    kind: str          # approve | reject | direction
    text: str          # "" ausser bei direction
    ref_run_ts: str    # korreliert mit PendingRecord.run_ts


def write_intent(path: Path, intent: Intent) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(asdict(intent), ensure_ascii=False, indent=2))
    os.replace(tmp, path)


def read_intent(path: Path) -> Intent | None:
    try:
        data = json.loads(Path(path).read_text())
        return Intent(**data)
    except (OSError, ValueError, TypeError):
        return None


def clear_intent(path: Path) -> None:
    try:
        Path(path).unlink()
    except OSError:
        pass
```

- [ ] **Step 4: Run to verify PASS**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_intent.py -v`
Expected: PASS (3 Tests).

- [ ] **Step 5: Commit**

```bash
git add tools/academy-auto/academy_auto/intent.py tools/academy-auto/tests/test_intent.py
git commit -m "feat(academy-auto): intent.json-Vertrag (Bot->Executor)"
```

---

### Task 4: `milestone.py` — Milestone-Klassifikator

**Files:**
- Create: `academy_auto/milestone.py`
- Test: `tests/test_milestone.py`

**Interfaces:**
- Consumes: `pending.PendingRecord`
- Produces: `is_milestone(rec: PendingRecord, delta_threshold: int) -> bool`

- [ ] **Step 1: Failing test**

```python
# tests/test_milestone.py
from academy_auto.pending import PendingRecord
from academy_auto.milestone import is_milestone


def _rec(**kw):
    base = dict(run_ts="t", outcome="nothing_to_do", task="", reason="",
                gate_note="", branch_sha="", has_change=False, tsc_delta=0,
                quarantined=[])
    base.update(kw)
    return PendingRecord(**base)


def test_change_ready_is_milestone():
    assert is_milestone(_rec(has_change=True), 50) is True


def test_error_is_milestone():
    assert is_milestone(_rec(outcome="error"), 50) is True


def test_big_delta_is_milestone():
    assert is_milestone(_rec(tsc_delta=646), 50) is True


def test_small_delta_nothing_is_not_milestone():
    assert is_milestone(_rec(tsc_delta=3), 50) is False


def test_nothing_to_do_is_not_milestone():
    assert is_milestone(_rec(), 50) is False
```

- [ ] **Step 2: Run to verify FAIL**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_milestone.py -v`
Expected: FAIL (`ModuleNotFoundError`).

- [ ] **Step 3: Implement**

```python
# academy_auto/milestone.py
from __future__ import annotations

from .pending import PendingRecord


def is_milestone(rec: PendingRecord, delta_threshold: int) -> bool:
    """Milestone, wenn ein Change bereitliegt ODER ein Fehler auftrat ODER
    das Gate-Delta die Schwelle erreicht (grosser Test)."""
    if rec.has_change:
        return True
    if rec.outcome == "error":
        return True
    return abs(rec.tsc_delta) >= delta_threshold
```

- [ ] **Step 4: Run to verify PASS**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_milestone.py -v`
Expected: PASS (5 Tests).

- [ ] **Step 5: Commit**

```bash
git add tools/academy-auto/academy_auto/milestone.py tools/academy-auto/tests/test_milestone.py
git commit -m "feat(academy-auto): Milestone-Klassifikator"
```

---

### Task 5: `report.build_digest_from_pending` — Digest aus PendingRecord

**Files:**
- Modify: `academy_auto/report.py` (neue Funktion, bestehende unangetastet)
- Test: `tests/test_report.py`

**Interfaces:**
- Consumes: `pending.PendingRecord`
- Produces: `build_digest_from_pending(rec: PendingRecord) -> str`

- [ ] **Step 1: Failing test**

```python
# tests/test_report.py  (append)
def test_build_digest_from_pending_change():
    from academy_auto.pending import PendingRecord
    from academy_auto.report import build_digest_from_pending
    rec = PendingRecord(
        run_ts="2026-07-25T02:00:03", outcome="committed", task="Jest-Typen",
        reason="17x impact", gate_note="Delta grün (658→12)", branch_sha="abc",
        has_change=True, tsc_delta=646, quarantined=["tsc:foo:1:TS2593"],
    )
    text = build_digest_from_pending(rec)
    assert "Academy-Auto" in text
    assert "Jest-Typen" in text
    assert "Delta grün (658→12)" in text
    assert "Quarantäne" in text


def test_build_digest_from_pending_nothing():
    from academy_auto.pending import PendingRecord
    from academy_auto.report import build_digest_from_pending
    rec = PendingRecord("t", "nothing_to_do", "", "", "", "", False, 0, [])
    text = build_digest_from_pending(rec)
    assert "nichts Umsetzbares" in text
```

- [ ] **Step 2: Run to verify FAIL**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_report.py -k from_pending -v`
Expected: FAIL (`ImportError: cannot import name 'build_digest_from_pending'`).

- [ ] **Step 3: Implement**

In `report.py` anhängen (nutzt denselben Stil wie `build_digest`/`build_nothing_digest`):

```python
def build_digest_from_pending(rec) -> str:
    """Digest aus einem geparkten PendingRecord bauen (Zustell-Job 08:00)."""
    if rec.outcome == "nothing_to_do":
        return build_nothing_digest(rec.quarantined)
    lines = ["🎓 Academy-Auto — Tagesstand", "", f"Aufgabe: {rec.task}"]
    if rec.gate_note:
        lines.append(f"Gate: {rec.gate_note}")
    if rec.has_change:
        lines.append("Ergebnis: Change liegt freigabebereit auf agents/academy-auto")
    elif rec.outcome == "error":
        lines.append("Ergebnis: Fehler im Nachtlauf")
    else:
        lines.append(f"Ergebnis: {rec.outcome}")
    if rec.reason:
        lines.append(f"Warum diese Aufgabe: {rec.reason}")
    if rec.has_change:
        lines.append("")
        lines.append("Freigabe: ✅ PR öffnen · ❌ Verwerfen · ✍️ Richtung als Antwort schreiben")
    if rec.quarantined:
        lines.append("Quarantäne (bitte anschauen): " + ", ".join(rec.quarantined))
    return "\n".join(lines)
```

- [ ] **Step 4: Run to verify PASS**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_report.py -v`
Expected: PASS (neue + bestehende).

- [ ] **Step 5: Commit**

```bash
git add tools/academy-auto/academy_auto/report.py tools/academy-auto/tests/test_report.py
git commit -m "feat(academy-auto): Digest aus PendingRecord"
```

---

### Task 6: `notify.send_digest` um `reply_markup` erweitern

**Files:**
- Modify: `academy_auto/notify.py` (`send_telegram`, `send_digest`)
- Test: `tests/test_notify.py`

**Interfaces:**
- Produces: `send_telegram(text, token, chat_id, reply_markup=None, opener=...) -> bool`; `send_digest(text, reply_markup=None, ...) -> bool`. Rückwärtskompatibel (Default `None`).

- [ ] **Step 1: Failing test**

```python
# tests/test_notify.py  (append)
def test_send_telegram_includes_reply_markup():
    from academy_auto import notify
    captured = {}

    class FakeResp:
        def __enter__(self): return self
        def __exit__(self, *a): return False

    def fake_opener(req, timeout=0):
        captured["data"] = req.data.decode()
        return FakeResp()

    ok = notify.send_telegram("hallo", "TOK", "123",
                              reply_markup={"inline_keyboard": [[{"text": "✅", "callback_data": "x"}]]},
                              opener=fake_opener)
    assert ok is True
    assert "reply_markup" in captured["data"]
```

- [ ] **Step 2: Run to verify FAIL**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_notify.py -k reply_markup -v`
Expected: FAIL (`TypeError: send_telegram() got an unexpected keyword argument 'reply_markup'`).

- [ ] **Step 3: Implement**

`send_telegram` signatur + Body anpassen:

```python
def send_telegram(text: str, token: str, chat_id: str, reply_markup=None,
                  opener=urllib.request.urlopen) -> bool:
    try:
        fields = {"chat_id": chat_id, "text": text}
        if reply_markup is not None:
            fields["reply_markup"] = json.dumps(reply_markup)
        data = urllib.parse.urlencode(fields).encode()
        req = urllib.request.Request(
            f"https://api.telegram.org/bot{token}/sendMessage", data=data
        )
        with opener(req, timeout=30):
            return True
    except Exception:
        return False
```

`send_digest` durchreichen:

```python
def send_digest(text: str, reply_markup=None, env_path=ENV_PATH, tenants_path=TENANTS_PATH,
                opener=urllib.request.urlopen) -> bool:
    token = read_env_value(env_path, "TELEGRAM_BOT_TOKEN")
    chat_id = resolve_chat_id(tenants_path)
    if not token or not chat_id:
        return False
    return send_telegram(text, token, chat_id, reply_markup=reply_markup, opener=opener)
```

- [ ] **Step 4: Run to verify PASS**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_notify.py -v`
Expected: PASS (neue + bestehende).

- [ ] **Step 5: Commit**

```bash
git add tools/academy-auto/academy_auto/notify.py tools/academy-auto/tests/test_notify.py
git commit -m "feat(academy-auto): notify unterstuetzt Inline-Buttons"
```

---

### Task 7: Nachtlauf parkt statt zu senden + persistiert Branch

**Files:**
- Modify: `academy_auto/orchestrator.py` (Digest-Aufrufe → `park`; Sharp-Pfad committet auf Branch statt Trockenlauf-Reset)
- Test: `tests/test_orchestrator.py`

**Interfaces:**
- Consumes: `pending.PendingRecord`, `pending.write_pending`
- Produces: neue Dep `deps.park(cfg, rec: PendingRecord) -> None` ersetzt `deps.send_digest` im Nacht-Pfad; Dep `deps.branch_sha(cfg, cwd) -> str`. `RunReport.status`-Werte unverändert.

**Hinweis für den Umbau:** Der Orchestrator ruft heute an sieben Stellen `deps.send_digest(build_digest(...))`. Jede wird durch `deps.park(cfg, PendingRecord(...))` ersetzt. Der Trockenlauf-Zweig (`cfg.dry_run_flag.exists()`) **entfällt vollständig**: bei grünem Gate + Scope + Cap wird **immer** auf den Branch committet (persistiert für den späteren PR) und mit `has_change=True` geparkt. `tsc_delta` kommt aus `baseline.total - after.total` (positiv = Fehler reduziert). **Das Sicherheitsnetz ist jetzt die Freigabe, nicht mehr der Trockenlauf:** der Branch-Commit ist isoliert und wird erst durch Walters „Ja" (Executor → PR) nach außen wirksam; ohne Freigabe passiert nichts Bleibendes im echten Repo. Das `dry_run_flag`-Feld in `Config` bleibt ungenutzt bestehen (kein Entfernen nötig), der `dry_run`-`RunReport`-Status wird nicht mehr erzeugt.

- [ ] **Step 1: Failing test**

```python
# tests/test_orchestrator.py  (append — Muster an bestehende Tests anlehnen)
from types import SimpleNamespace
from academy_auto.orchestrator import run_once
from academy_auto.pending import PendingRecord


def _gate(total):
    return SimpleNamespace(total=total, passed=(total == 0), steps=[])


def _deps(parked, **over):
    base = dict(
        prepare_worktree=lambda cfg: "/wt",
        quarantined=lambda cfg: [],
        measure_gate=lambda cfg, cwd: _gate(0),
        triage_and_pick=lambda cfg, cwd, red: SimpleNamespace(
            task_prompt="Tu was", reason="weil", chosen_key="k"),
        implement_task=lambda cfg, cwd, p: SimpleNamespace(ok=True, output=""),
        list_changed_files=lambda cfg, cwd: ["a.ts"],
        count_diff_lines=lambda cfg, cwd: 3,
        commit_and_pr=lambda cfg, cwd, p: True,
        branch_sha=lambda cfg, cwd: "deadbee",
        now_ts=lambda: "2026-07-25T02:00:03",
        record_triage_outcome=lambda cfg, k, s: None,
        reset_worktree=lambda cfg, cwd: None,
        park=lambda cfg, rec: parked.append(rec),
    )
    base.update(over)
    return SimpleNamespace(**base)


def test_green_change_parks_has_change(tmp_path):
    from academy_auto.config import Config
    cfg = Config.default()
    # Baseline rot (10), After grün-er (0) -> delta positiv, Change bereit
    parked = []
    deps = _deps(parked,
                 measure_gate=_seq_gate([10, 0]))
    rep = run_once(cfg, None, deps)
    assert rep.status == "committed"
    assert len(parked) == 1
    assert isinstance(parked[0], PendingRecord)
    assert parked[0].has_change is True
    assert parked[0].tsc_delta == 10


def _seq_gate(totals):
    it = iter(totals)
    return lambda cfg, cwd: _gate(next(it))
```

- [ ] **Step 2: Run to verify FAIL**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_orchestrator.py -k parks_has_change -v`
Expected: FAIL (`AttributeError: 'SimpleNamespace' object has no attribute 'park'` bzw. Orchestrator ruft noch `send_digest`).

- [ ] **Step 3: Implement**

In `_run_once_inner` jeden `deps.send_digest(build_digest(...))`-Aufruf durch `deps.park(cfg, PendingRecord(...))` ersetzen. Beispiel für den grünen Commit-Pfad (ersetzt den bisherigen `dry_run`/`commit`-Block am Ende):

```python
    tsc_delta = baseline.total - after.total
    run_ts = deps.now_ts()  # neue Dep, ISO-String
    committed = deps.commit_and_pr(cfg, cwd, task_prompt)  # committet auf Branch (kein PR!)
    deps.park(cfg, PendingRecord(
        run_ts=run_ts, outcome="committed", task=task_prompt, reason=reason,
        gate_note=delta.note, branch_sha=deps.branch_sha(cfg, cwd),
        has_change=True, tsc_delta=tsc_delta, quarantined=quar,
    ))
    return _finalize(deps, cfg, cwd, pick, "committed")
```

Für `nothing_to_do`, `impl_failed`, `discarded` (Scope/Cap/Gate), `error` analog `deps.park(cfg, PendingRecord(..., has_change=False, outcome=<status>, tsc_delta=0))`. Den Top-Level-`except` in `run_once` von `send_digest` auf `park` mit `outcome="error"` umstellen.

Neue Default-Deps in `_build_default_deps` ergänzen:

```python
        park=lambda cfg, rec: _park_default(cfg, rec),
        branch_sha=lambda cfg, cwd: _branch_sha(cfg, cwd),
        now_ts=_now_ts,
```

Und Hilfsfunktionen (unten in orchestrator.py):

```python
def _park_default(cfg, rec):  # pragma: no cover - IO beim Deploy
    from . import pending
    print(f"[park] {rec.outcome} has_change={rec.has_change}")  # ins launchd-Log
    pending.write_pending(cfg.pending_path, rec)


def _branch_sha(cfg, cwd):
    import subprocess
    proc = subprocess.run(["git", "-C", str(cwd), "rev-parse", "HEAD"],
                          capture_output=True, text=True, check=False)
    return proc.stdout.strip()


def _now_ts():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()
```

`commit_and_pr` in `_commit_and_pr` **belässt es beim Commit** (kein PR hier — der PR entsteht erst im Executor bei Freigabe). Umbenennen nicht nötig; Kommentar ergänzen: `# committet nur auf den Branch; PR erst bei Freigabe (executor.py)`.

- [ ] **Step 4: Run to verify PASS**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_orchestrator.py -v`
Expected: PASS. Bestehende Orchestrator-Tests, die `send_digest` mockten, auf `park` umstellen (Mock-Namen ändern; die Assertions auf „Digest verschickt" werden zu „geparkt").

- [ ] **Step 5: Commit**

```bash
git add tools/academy-auto/academy_auto/orchestrator.py tools/academy-auto/tests/test_orchestrator.py
git commit -m "feat(academy-auto): Nachtlauf parkt Ergebnis statt direkt zu senden"
```

---

### Task 8: `deliver.py` — 08:00-Zustell-Job

**Files:**
- Create: `academy_auto/deliver.py`
- Test: `tests/test_deliver.py`

**Interfaces:**
- Consumes: `pending.read_pending`, `milestone.is_milestone`, `report.build_digest_from_pending`, `notify.send_digest`
- Produces:
  - `build_reply_markup(run_ts: str) -> dict` — Inline-Tastatur `✅/❌` mit `callback_data` `academy:approve:<run_ts>` / `academy:reject:<run_ts>`
  - `deliver(cfg, deps) -> str` — `"no_pending" | "skipped" | "sent"`

- [ ] **Step 1: Failing test**

```python
# tests/test_deliver.py
from types import SimpleNamespace
from academy_auto.pending import PendingRecord
from academy_auto.deliver import deliver, build_reply_markup


def _cfg(mode="daily"):
    return SimpleNamespace(pending_path="p", notify_mode=mode, milestone_delta_threshold=50)


def _deps(rec, sent):
    return SimpleNamespace(
        read_pending=lambda p: rec,
        send=lambda text, markup: sent.append((text, markup)),
    )


def test_no_pending():
    assert deliver(_cfg(), _deps(None, [])) == "no_pending"


def test_daily_sends_even_nothing():
    rec = PendingRecord("t", "nothing_to_do", "", "", "", "", False, 0, [])
    sent = []
    assert deliver(_cfg("daily"), _deps(rec, sent)) == "sent"
    assert sent and sent[0][1] is None  # keine Buttons ohne Change


def test_milestone_skips_nothing():
    rec = PendingRecord("t", "nothing_to_do", "", "", "", "", False, 0, [])
    sent = []
    assert deliver(_cfg("milestone"), _deps(rec, sent)) == "skipped"
    assert not sent


def test_change_gets_buttons():
    rec = PendingRecord("2026-07-25T02:00:03", "committed", "T", "", "n", "s",
                        True, 646, [])
    sent = []
    assert deliver(_cfg("daily"), _deps(rec, sent)) == "sent"
    text, markup = sent[0]
    assert markup["inline_keyboard"][0][0]["callback_data"] == "academy:approve:2026-07-25T02:00:03"


def test_build_reply_markup_shape():
    m = build_reply_markup("R")
    labels = [b["text"] for row in m["inline_keyboard"] for b in row]
    assert "✅ PR öffnen" in labels and "❌ Verwerfen" in labels
```

- [ ] **Step 2: Run to verify FAIL**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_deliver.py -v`
Expected: FAIL (`ModuleNotFoundError`).

- [ ] **Step 3: Implement**

```python
# academy_auto/deliver.py
from __future__ import annotations

from .milestone import is_milestone
from .report import build_digest_from_pending


def build_reply_markup(run_ts: str) -> dict:
    return {"inline_keyboard": [[
        {"text": "✅ PR öffnen", "callback_data": f"academy:approve:{run_ts}"},
        {"text": "❌ Verwerfen", "callback_data": f"academy:reject:{run_ts}"},
    ]]}


def deliver(cfg, deps) -> str:
    """Liest pending.json, entscheidet nach notify_mode, sendet Digest (+Buttons)."""
    rec = deps.read_pending(cfg.pending_path)
    if rec is None:
        return "no_pending"
    if cfg.notify_mode == "milestone" and not is_milestone(rec, cfg.milestone_delta_threshold):
        return "skipped"
    text = build_digest_from_pending(rec)
    markup = build_reply_markup(rec.run_ts) if rec.has_change else None
    deps.send(text, markup)
    return "sent"


def main() -> None:  # pragma: no cover - CLI/launchd
    from types import SimpleNamespace
    from .config import Config
    from . import pending, notify
    cfg = Config.default()
    deps = SimpleNamespace(
        read_pending=pending.read_pending,
        send=lambda text, markup: notify.send_digest(text, reply_markup=markup),
    )
    print(deliver(cfg, deps))


if __name__ == "__main__":  # pragma: no cover
    main()
```

- [ ] **Step 4: Run to verify PASS**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_deliver.py -v`
Expected: PASS (5 Tests).

- [ ] **Step 5: Commit**

```bash
git add tools/academy-auto/academy_auto/deliver.py tools/academy-auto/tests/test_deliver.py
git commit -m "feat(academy-auto): 08:00-Zustell-Job (Modus daily/milestone + Buttons)"
```

---

### Task 9: `executor.py` — Intent ausführen (PR / Reset / Issue)

**Files:**
- Create: `academy_auto/executor.py`
- Test: `tests/test_executor.py`

**Interfaces:**
- Consumes: `intent.read_intent/clear_intent`, `pending.read_pending`
- Produces: `process_intent(cfg, deps) -> str` — `"none" | "stale" | "approved" | "rejected" | "direction"`. Deps: `read_intent`, `read_pending`, `clear_intent`, `open_pr(cfg) -> str`, `reset_branch(cfg) -> None`, `create_issue(cfg, text) -> int`, `notify(text) -> None`.

- [ ] **Step 1: Failing test**

```python
# tests/test_executor.py
from types import SimpleNamespace
from academy_auto.intent import Intent
from academy_auto.pending import PendingRecord
from academy_auto.executor import process_intent


def _cfg():
    return SimpleNamespace(intent_path="i", pending_path="p", github_repo="o/r")


def _deps(intent, pending, notes, calls):
    return SimpleNamespace(
        read_intent=lambda p: intent,
        read_pending=lambda p: pending,
        clear_intent=lambda p: calls.append("clear"),
        open_pr=lambda cfg: (calls.append("pr"), "https://gh/pr/1")[1],
        reset_branch=lambda cfg: calls.append("reset"),
        create_issue=lambda cfg, text: (calls.append(f"issue:{text}"), 42)[1],
        notify=lambda text: notes.append(text),
    )


def _rec(run_ts="R"):
    return PendingRecord(run_ts, "committed", "T", "", "", "s", True, 5, [])


def test_no_intent():
    assert process_intent(_cfg(), _deps(None, _rec(), [], [])) == "none"


def test_approve_opens_pr():
    calls, notes = [], []
    it = Intent(ts="t", kind="approve", text="", ref_run_ts="R")
    assert process_intent(_cfg(), _deps(it, _rec("R"), notes, calls)) == "approved"
    assert "pr" in calls and "clear" in calls
    assert any("PR" in n for n in notes)


def test_stale_ref_no_action():
    calls, notes = [], []
    it = Intent(ts="t", kind="approve", text="", ref_run_ts="OLD")
    assert process_intent(_cfg(), _deps(it, _rec("NEW"), notes, calls)) == "stale"
    assert "pr" not in calls and "clear" in calls
    assert any("überholt" in n for n in notes)


def test_reject_resets():
    calls, notes = [], []
    it = Intent(ts="t", kind="reject", text="", ref_run_ts="R")
    assert process_intent(_cfg(), _deps(it, _rec("R"), notes, calls)) == "rejected"
    assert "reset" in calls


def test_direction_creates_issue():
    calls, notes = [], []
    it = Intent(ts="t", kind="direction", text="Login responsive", ref_run_ts="")
    assert process_intent(_cfg(), _deps(it, _rec("R"), notes, calls)) == "direction"
    assert "issue:Login responsive" in calls
    assert any("#42" in n for n in notes)
```

- [ ] **Step 2: Run to verify FAIL**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_executor.py -v`
Expected: FAIL (`ModuleNotFoundError`).

- [ ] **Step 3: Implement**

```python
# academy_auto/executor.py
from __future__ import annotations


def process_intent(cfg, deps) -> str:
    """Verarbeitet genau eine Intent-Datei. Fail-soft, idempotent (löscht am Ende)."""
    intent = deps.read_intent(cfg.intent_path)
    if intent is None:
        return "none"

    # Freigabe/Verwerfen nur auf den passenden Nachtstand (ref_run_ts).
    if intent.kind in ("approve", "reject"):
        rec = deps.read_pending(cfg.pending_path)
        if rec is None or rec.run_ts != intent.ref_run_ts:
            deps.notify("Dieser Vorschlag ist überholt — keine Aktion.")
            deps.clear_intent(cfg.intent_path)
            return "stale"

    result = "none"
    try:
        if intent.kind == "approve":
            url = deps.open_pr(cfg)
            deps.notify(f"✅ PR geöffnet: {url}")
            result = "approved"
        elif intent.kind == "reject":
            deps.reset_branch(cfg)
            deps.notify("❌ Verworfen — Branch zurückgesetzt.")
            result = "rejected"
        elif intent.kind == "direction":
            num = deps.create_issue(cfg, intent.text)
            deps.notify(f"✍️ Als Nachtaufgabe notiert (Issue #{num}).")
            result = "direction"
    except Exception as exc:  # fail-soft: Fehler melden, Intent bleibt NICHT stehen
        deps.notify(f"⚠️ Konnte Aktion nicht ausführen: {exc}")
    deps.clear_intent(cfg.intent_path)
    return result


def _open_pr_default(cfg):  # pragma: no cover - echter gh-Aufruf beim Deploy
    import subprocess
    wt = str(cfg.worktree_path)
    subprocess.run(["git", "-C", wt, "push", "-f", "origin", cfg.branch], check=True)
    proc = subprocess.run(
        ["gh", "pr", "create", "--repo", cfg.github_repo, "--head", cfg.branch.split("/")[-1],
         "--base", cfg.base_branch, "--fill"],
        capture_output=True, text=True, check=True,
    )
    return proc.stdout.strip()


def _reset_branch_default(cfg):  # pragma: no cover
    import subprocess
    wt = str(cfg.worktree_path)
    subprocess.run(["git", "-C", wt, "reset", "--hard", cfg.base_branch], check=False)
    subprocess.run(["git", "-C", wt, "clean", "-fd"], check=False)


def _create_issue_default(cfg, text):  # pragma: no cover
    import subprocess
    proc = subprocess.run(
        ["gh", "issue", "create", "--repo", cfg.github_repo,
         "--title", text[:70], "--body", f"Von Walter via Jarvis: {text}"],
        capture_output=True, text=True, check=True,
    )
    url = proc.stdout.strip()
    return int(url.rstrip("/").split("/")[-1])


def main() -> None:  # pragma: no cover - vom Bot per Subprozess angestoßen
    from types import SimpleNamespace
    from .config import Config
    from . import intent as intent_mod, pending, notify
    cfg = Config.default()
    deps = SimpleNamespace(
        read_intent=intent_mod.read_intent,
        read_pending=pending.read_pending,
        clear_intent=intent_mod.clear_intent,
        open_pr=_open_pr_default,
        reset_branch=_reset_branch_default,
        create_issue=_create_issue_default,
        notify=lambda text: notify.send_digest(text),
    )
    print(process_intent(cfg, deps))


if __name__ == "__main__":  # pragma: no cover
    main()
```

- [ ] **Step 4: Run to verify PASS**

Run: `cd tools/academy-auto && python3 -m pytest tests/test_executor.py -v`
Expected: PASS (5 Tests).

- [ ] **Step 5: Commit**

```bash
git add tools/academy-auto/academy_auto/executor.py tools/academy-auto/tests/test_executor.py
git commit -m "feat(academy-auto): Executor (approve->PR, reject->reset, direction->issue)"
```

---

### Task 10: `voice-echo-bot` erkennt Academy-Antworten

**Files:**
- Create: `tools/voice-echo-bot/academy_bridge.py` (reine Erkennungs-/Schreiblogik, testbar)
- Modify: `tools/voice-echo-bot/bot.py` (`handle_update`: callback_query-Zweig + Academy-Reply im `_handle_message`)
- Test: `tools/voice-echo-bot/test_academy_bridge.py`

**Interfaces:**
- Consumes: —
- Produces (in `academy_bridge.py`):
  - `parse_callback(data: str) -> tuple[str, str] | None` — `"academy:approve:<ts>"` → `("approve", ts)`, sonst `None`
  - `is_academy_reply(reply_to_text: str) -> bool` — True, wenn auf einen Academy-Digest geantwortet wird (Marker „Academy-Auto — Tagesstand")
  - `build_intent_dict(kind, text, ref_run_ts, now_ts) -> dict`
  - `write_intent_file(path, d) -> None`; `trigger_executor(academy_auto_dir) -> None` (fire-and-forget Subprozess, fail-soft)

- [ ] **Step 1: Failing test**

```python
# tools/voice-echo-bot/test_academy_bridge.py
import academy_bridge as ab


def test_parse_callback_approve():
    assert ab.parse_callback("academy:approve:2026-07-25T02:00:03") == ("approve", "2026-07-25T02:00:03")


def test_parse_callback_reject():
    assert ab.parse_callback("academy:reject:R") == ("reject", "R")


def test_parse_callback_foreign_returns_none():
    assert ab.parse_callback("issue:confirm:WHI-1") is None
    assert ab.parse_callback("") is None


def test_is_academy_reply():
    assert ab.is_academy_reply("🎓 Academy-Auto — Tagesstand\n...") is True
    assert ab.is_academy_reply("irgendeine andere Nachricht") is False


def test_build_intent_dict():
    d = ab.build_intent_dict("direction", "Login responsive", "", "2026-07-25T08:00:00")
    assert d == {"ts": "2026-07-25T08:00:00", "kind": "direction",
                 "text": "Login responsive", "ref_run_ts": ""}


def test_write_intent_file(tmp_path):
    import json
    p = tmp_path / "intent.json"
    ab.write_intent_file(str(p), {"ts": "t", "kind": "approve", "text": "", "ref_run_ts": "R"})
    assert json.loads(p.read_text())["kind"] == "approve"
```

- [ ] **Step 2: Run to verify FAIL**

Run: `cd tools/voice-echo-bot && python3 -m pytest test_academy_bridge.py -v`
Expected: FAIL (`ModuleNotFoundError: academy_bridge`).

- [ ] **Step 3: Implement**

```python
# tools/voice-echo-bot/academy_bridge.py
from __future__ import annotations

import json
import os
import subprocess

ACADEMY_MARKER = "Academy-Auto — Tagesstand"


def parse_callback(data):
    """'academy:approve:<ts>' -> ('approve', ts); Fremd-Callback -> None."""
    if not isinstance(data, str) or not data.startswith("academy:"):
        return None
    parts = data.split(":", 2)
    if len(parts) != 3 or parts[1] not in ("approve", "reject"):
        return None
    return (parts[1], parts[2])


def is_academy_reply(reply_to_text) -> bool:
    return isinstance(reply_to_text, str) and ACADEMY_MARKER in reply_to_text


def build_intent_dict(kind, text, ref_run_ts, now_ts) -> dict:
    return {"ts": now_ts, "kind": kind, "text": text, "ref_run_ts": ref_run_ts}


def write_intent_file(path, d) -> None:
    path = str(path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(d, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def trigger_executor(academy_auto_dir) -> None:
    """Fire-and-forget: Executor im Deploy-Verzeichnis anstoßen. Fail-soft."""
    try:
        subprocess.Popen(
            ["python3", "-m", "academy_auto.executor"],
            cwd=academy_auto_dir,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    except Exception:
        pass
```

In `bot.py` `handle_update` den callback_query-Zweig ergänzen (der Kommentar „keine callback_query" gilt nur fürs Issue-System — Academy-Callbacks sind neu):

```python
    def handle_update(self, update):
        if "callback_query" in update:
            self._handle_academy_callback(update["callback_query"])
            return
        if "message" in update:
            ...  # unverändert
```

Neue Methoden in `bot.py` (nutzen `self.cfg["academy_intent_path"]` + `self.cfg["academy_auto_dir"]`, aus config.py mit Defaults `~/.paperclip/academy-auto/intent.json` bzw. `~/.paperclip/scripts/academy-auto`):

```python
    def _handle_academy_callback(self, cq):
        import academy_bridge as ab
        parsed = ab.parse_callback((cq.get("data") or ""))
        if parsed is None:
            return
        kind, ref = parsed
        d = ab.build_intent_dict(kind, "", ref, self._now_ts())
        ab.write_intent_file(self.cfg["academy_intent_path"], d)
        ab.trigger_executor(self.cfg["academy_auto_dir"])
        self.tg.answer_callback_query(cq["id"], text="Verstanden — läuft.")
```

Im `_handle_message`, im bestehenden `reply_to`-Block, VOR der `IDENT_RE`-Prüfung die Academy-Reply abfangen:

```python
        reply_to = msg.get("reply_to_message")
        if reply_to:
            import academy_bridge as ab
            if ab.is_academy_reply(reply_to.get("text") or ""):
                text = self._extract_text(msg)
                if text:
                    d = ab.build_intent_dict("direction", text, "", self._now_ts())
                    ab.write_intent_file(self.cfg["academy_intent_path"], d)
                    ab.trigger_executor(self.cfg["academy_auto_dir"])
                    self.tg.send_message(msg["chat"]["id"], "✍️ Als Nachtaufgabe notiert.")
                return
            m = IDENT_RE.search(reply_to.get("text") or "")
            ...  # unverändert
```

`_now_ts` als kleine Methode ergänzen (`from datetime import datetime, timezone; return datetime.now(timezone.utc).isoformat()`).

- [ ] **Step 4: Run to verify PASS**

Run: `cd tools/voice-echo-bot && python3 -m pytest test_academy_bridge.py test_bot.py -v`
Expected: PASS (neue + bestehende Bot-Tests; letztere dürfen nicht brechen).

- [ ] **Step 5: Commit**

```bash
git add tools/voice-echo-bot/academy_bridge.py tools/voice-echo-bot/bot.py tools/voice-echo-bot/test_academy_bridge.py
git commit -m "feat(voice-echo-bot): Academy-Callback + Freitext-Reply -> intent.json"
```

---

### Task 11: launchd-Zustell-Job + Deploy + manuelle E2E-Probe

**Files:**
- Create: `tools/academy-auto/de.whitestag.academy-deliver.plist` (08:00)
- Create: `tools/academy-auto/run-deliver.sh`
- Modify: `tools/voice-echo-bot/config.py` (Defaults `academy_intent_path`, `academy_auto_dir`)
- Test: `tools/voice-echo-bot/test_config.py` (neue Defaults)

**Interfaces:**
- Consumes: `deliver.main`, `executor.main`
- Produces: launchd-Dienst `de.whitestag.academy-deliver` @ 08:00; Bot-Config-Keys.

- [ ] **Step 1: Failing test (Bot-Config)**

```python
# tools/voice-echo-bot/test_config.py  (append)
def test_academy_defaults_present():
    import config
    cfg = config.load_config()  # bestehende Loader-Funktion; ggf. Namen anpassen
    assert cfg["academy_intent_path"].endswith("academy-auto/intent.json")
    assert cfg["academy_auto_dir"].endswith("scripts/academy-auto")
```

- [ ] **Step 2: Run to verify FAIL**

Run: `cd tools/voice-echo-bot && python3 -m pytest test_config.py -k academy_defaults -v`
Expected: FAIL (Keys fehlen).

- [ ] **Step 3: Implement**

In `voice-echo-bot/config.py` die zwei Keys mit Home-basierten Defaults ergänzen (Muster der bestehenden Pfad-Defaults folgen):

```python
    cfg.setdefault("academy_intent_path",
                   os.path.expanduser("~/.paperclip/academy-auto/intent.json"))
    cfg.setdefault("academy_auto_dir",
                   os.path.expanduser("~/.paperclip/scripts/academy-auto"))
```

`run-deliver.sh` (nach Muster von `run-nightly.sh`):

```bash
#!/bin/zsh
cd "$HOME/.paperclip/scripts/academy-auto" || exit 1
/usr/bin/python3 -m academy_auto.deliver
```

`de.whitestag.academy-deliver.plist` — `StartCalendarInterval` Hour 8 Minute 0, `ProgramArguments` = `run-deliver.sh`, StdOut/Err → `~/.paperclip/logs/academy-deliver.log`, `RunAtLoad` false (Muster: bestehende `de.whitestag.academy-auto.plist`).

- [ ] **Step 4: Run to verify PASS + manuelle E2E-Probe**

Run: `cd tools/voice-echo-bot && python3 -m pytest test_config.py -v` → PASS.

Volle Suite beider Pakete:
```bash
cd tools/academy-auto && python3 -m pytest -q
cd ../voice-echo-bot && python3 -m pytest -q
```
Expected: alles grün.

Deploy + Trockenprobe (ohne scharfe launchd-Aktivierung):
```bash
# 1) Deploy academy-auto
rsync -a --delete tools/academy-auto/academy_auto/ ~/.paperclip/scripts/academy-auto/academy_auto/
cp tools/academy-auto/run-deliver.sh ~/.paperclip/scripts/academy-auto/ && chmod +x ~/.paperclip/scripts/academy-auto/run-deliver.sh
# 2) Fake-pending schreiben (has_change=false, damit KEIN PR/Change entsteht)
python3 - <<'PY'
from pathlib import Path
import sys; sys.path.insert(0, str(Path.home()/".paperclip/scripts/academy-auto"))
from academy_auto.pending import PendingRecord, write_pending
from academy_auto.config import Config
write_pending(Config.default().pending_path,
              PendingRecord("2026-07-25T02:00:03","nothing_to_do","","","","",False,0,[]))
PY
# 3) Zustellung testweise auslösen -> Telegram-Nachricht muss ankommen
cd ~/.paperclip/scripts/academy-auto && python3 -m academy_auto.deliver   # erwartet: "sent"
```
Erwartung: Telegram-Digest „nichts Umsetzbares" erscheint im Jarvis-Chat (kein Nacht-Ping-Risiko, da manuell). launchd erst nach Bestätigung scharf schalten:
```bash
cp tools/academy-auto/de.whitestag.academy-deliver.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/de.whitestag.academy-deliver.plist
launchctl list | grep academy-deliver
```

- [ ] **Step 5: Commit**

```bash
git add tools/academy-auto/run-deliver.sh tools/academy-auto/de.whitestag.academy-deliver.plist \
        tools/voice-echo-bot/config.py tools/voice-echo-bot/test_config.py
git commit -m "feat(academy-auto): 08:00-launchd-Zustellung + Bot-Config + E2E-Probe"
```

---

## Betrieb & Scharfschalten (nach Task 11)

- **Nacht committet jetzt auf den isolierten Branch** (statt Trockenlauf-Reset). Das ist ungefährlich: Sicherheitsnetz ist die **Freigabe** — ohne dein „Ja" entsteht kein PR und kein Merge ins echte Repo. Das alte `~/.paperclip/academy-auto.dryrun`-Flag wird nicht mehr ausgewertet und kann entfernt werden.
- **Modus umschalten (später):** `notify_mode` in `config.py` von `"daily"` auf `"milestone"`.
- **Prüfen:** `cat ~/.paperclip/logs/academy-deliver.log`, `launchctl list | grep academy`.

## Offene Punkte für die Umsetzung (aus dem Spec)

- **Branch-Lebenszyklus:** Der Nachtlauf setzt den Worktree jeden Lauf auf `main` zurück — ein nicht freigegebener Commit von gestern geht verloren. Für die tägliche Anfangsphase (Antwort am selben Morgen) akzeptabel; falls Akkumulation gewünscht, in einem Folge-Task per-Run-Branch einführen.
- **`gh`-Auth im launchd-/Subprozess-Kontext** verifizieren (Executor läuft als Bot-Kind-Prozess); ggf. `GH_TOKEN` aus `~/.paperclip/…` nachziehen.
- **Freitext-Richtung** wird über Reply-auf-den-Digest erkannt (Marker „Academy-Auto — Tagesstand"). Falls Telegram bei Voice-Antworten kein `reply_to_message` mitschickt, in der Umsetzung auf Präfix-Kommando ausweichen.
