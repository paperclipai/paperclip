from types import SimpleNamespace
from academy_auto.config import Config
from academy_auto.gate import GateResult, GateStep
from academy_auto.runner import RunOutcome
from academy_auto.orchestrator import run_once

sent: list = []
recorded: list = []
resets: list = []


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


def test_run_once_diff_cap_exceeded_discards(tmp_path):
    global sent
    sent = []
    cfg = Config.default()
    cfg = Config(**{**cfg.__dict__, "pause_flag": tmp_path / "nope.pause"})
    deps = base_deps(
        count_diff_lines=lambda cfg, cwd: 900,
        commit_and_pr=lambda cfg, cwd, prompt: (_ for _ in ()).throw(AssertionError("darf nicht committen")),
    )
    report = run_once(cfg, "Riesenrefactor", deps)
    assert report.status == "discarded"
    assert len(sent) == 1
    assert "Cap" in sent[0]


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
