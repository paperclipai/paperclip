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
        count_diff_lines=lambda cfg, cwd: 10,
        list_changed_files=lambda cfg, cwd: ["src/App.tsx"],
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
