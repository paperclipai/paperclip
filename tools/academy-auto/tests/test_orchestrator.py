from types import SimpleNamespace
from academy_auto.config import Config
from academy_auto.gate import GateMeasure, StepMeasure
from academy_auto.runner import RunOutcome
from academy_auto.orchestrator import run_once

sent: list = []
recorded: list = []
resets: list = []


def _measure(total):
    # ein Schritt trägt den ganzen Fehler-Count
    return GateMeasure(steps=[StepMeasure(["npx", "tsc", "--noEmit"], total)], total=total)


def two_stage_measure(baseline_total, after_total):
    seq = [baseline_total, after_total]

    def m(cfg, cwd):
        return _measure(seq.pop(0))

    return m


def _cfg(tmp_path, **over):
    """Config fuer Tests: beide Flag-Dateien zeigen garantiert ins Leere,
    damit die Suite nicht vom echten ~/.paperclip-Zustand abhaengt."""
    base = dict(Config.default().__dict__)
    base["pause_flag"] = tmp_path / "kein.pause"
    base["dry_run_flag"] = tmp_path / "kein.dryrun"
    base.update(over)
    return Config(**base)


def base_deps(**over):
    d = dict(
        prepare_worktree=lambda cfg: cfg.worktree_path,
        measure_gate=lambda cfg, cwd: _measure(0),  # default: grün (Baseline und After)
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


def test_run_once_paused_when_flag_present(tmp_path):
    global sent
    sent = []
    flag = tmp_path / "academy-auto.pause"
    flag.write_text("stop")
    cfg = _cfg(tmp_path, pause_flag=flag)

    report = run_once(cfg, "irgendeine Aufgabe", base_deps())
    assert report.status == "paused"
    assert sent == []  # kein Digest, nichts passiert


def test_run_once_green_commits_and_reports(tmp_path):
    global sent
    sent = []
    cfg = _cfg(tmp_path)

    report = run_once(cfg, "Login-Bug fixen", base_deps())
    assert report.status == "committed"
    assert len(sent) == 1
    assert "grün" in sent[0].lower()


def test_run_once_red_gate_discards_and_reports(tmp_path):
    global sent
    sent = []
    cfg = _cfg(tmp_path)
    deps = base_deps(
        measure_gate=two_stage_measure(0, 3),  # grün Baseline, rotes After
        commit_and_pr=lambda cfg, cwd, prompt: (_ for _ in ()).throw(AssertionError("darf nicht committen")),
    )
    report = run_once(cfg, "Refactor", deps)
    assert report.status == "discarded"
    assert len(sent) == 1
    assert "rot" in sent[0].lower()


def test_run_once_impl_failure_skips_gate_and_reports(tmp_path):
    global sent
    sent = []
    cfg = _cfg(tmp_path)
    deps = base_deps(
        implement_task=lambda cfg, cwd, prompt: RunOutcome(ok=False, output="claude timeout"),
        commit_and_pr=lambda cfg, cwd, prompt: (_ for _ in ()).throw(AssertionError("kein Commit")),
    )
    report = run_once(cfg, "x", deps)
    assert report.status == "impl_failed"
    assert len(sent) == 1


def test_run_once_diff_cap_exceeded_discards(tmp_path):
    global sent
    sent = []
    cfg = _cfg(tmp_path)
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
    cfg = _cfg(tmp_path)
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
    cfg = _cfg(tmp_path)
    deps = base_deps(triage_and_pick=lambda cfg, cwd, baseline_red: Pick("tsc:a.ts:5:TS1", "Fix a.ts:5", "prio"))
    report = run_once(cfg, None, deps)  # None -> Triage-Modus
    assert report.status == "committed"
    assert recorded == [("tsc:a.ts:5:TS1", "committed")]
    assert resets == []  # bei committed kein Reset
    assert any("prio" in s for s in sent)  # Grund im Digest


def test_run_once_triage_nothing_to_do(tmp_path):
    global sent, recorded, resets
    sent, recorded, resets = [], [], []
    cfg = _cfg(tmp_path)
    deps = base_deps(triage_and_pick=lambda cfg, cwd, baseline_red: None, quarantined=lambda cfg: ["todo:z.ts:3"])
    report = run_once(cfg, None, deps)
    assert report.status == "nothing_to_do"
    assert recorded == []
    assert len(sent) == 1 and "todo:z.ts:3" in sent[0]


def test_run_once_triage_discard_records_and_resets(tmp_path):
    global sent, recorded, resets
    sent, recorded, resets = [], [], []
    from academy_auto.triage.rank import Pick
    cfg = _cfg(tmp_path)
    deps = base_deps(
        triage_and_pick=lambda cfg, cwd, baseline_red: Pick("todo:b.ts:1", "b umsetzen", "einfach"),
        measure_gate=two_stage_measure(0, 3),  # grün Baseline, rotes After
        commit_and_pr=lambda cfg, cwd, prompt: (_ for _ in ()).throw(AssertionError("kein Commit")),
    )
    report = run_once(cfg, None, deps)
    assert report.status == "discarded"
    assert recorded == [("todo:b.ts:1", "discarded")]
    assert len(resets) == 1  # Worktree nach discard zurückgesetzt


def test_run_once_manual_prompt_skips_triage_and_recording(tmp_path):
    global sent, recorded, resets
    sent, recorded, resets = [], [], []
    cfg = _cfg(tmp_path)
    deps = base_deps(triage_and_pick=lambda cfg, cwd, baseline_red: (_ for _ in ()).throw(AssertionError("Triage darf nicht laufen")))
    report = run_once(cfg, "manueller Auftrag", deps)  # String -> kein Triage
    assert report.status == "committed"
    assert recorded == []  # manueller Lauf zeichnet nichts auf


def test_run_once_impl_fail_resets_worktree(tmp_path):
    global sent, recorded, resets
    sent, recorded, resets = [], [], []
    cfg = _cfg(tmp_path)
    deps = base_deps(implement_task=lambda cfg, cwd, prompt: RunOutcome(ok=False, output="claude weg"))
    report = run_once(cfg, "manuell", deps)
    assert report.status == "impl_failed"
    assert len(resets) == 1  # auch manueller Fehllauf setzt Worktree zurück


def test_run_once_committed_digest_lists_quarantine(tmp_path):
    global sent, recorded, resets
    sent, recorded, resets = [], [], []
    cfg = _cfg(tmp_path)
    deps = base_deps(quarantined=lambda cfg: ["todo:z.ts:9"])
    report = run_once(cfg, "manuell", deps)
    assert report.status == "committed"
    assert any("todo:z.ts:9" in s for s in sent)  # Quarantäne auch im committed-Digest


def test_run_once_green_baseline_absolute_pass_commits(tmp_path):
    global sent, recorded, resets
    sent, recorded, resets = [], [], []
    cfg = _cfg(tmp_path)
    deps = base_deps(measure_gate=two_stage_measure(0, 0))  # grün → grün
    assert run_once(cfg, "manuell", deps).status == "committed"


def test_run_once_green_baseline_after_red_discards(tmp_path):
    global sent, recorded, resets
    sent, recorded, resets = [], [], []
    cfg = _cfg(tmp_path)
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
    cfg = _cfg(tmp_path)
    deps = base_deps(measure_gate=two_stage_measure(5, 2))  # rot → weniger Fehler → Delta-Commit
    r = run_once(cfg, "manuell", deps)
    assert r.status == "committed"
    assert any("Delta" in s for s in sent)


def test_run_once_red_baseline_no_progress_discards(tmp_path):
    global sent, recorded, resets
    sent, recorded, resets = [], [], []
    cfg = _cfg(tmp_path)
    deps = base_deps(
        measure_gate=two_stage_measure(5, 5),  # rot → kein Fortschritt → discard
        commit_and_pr=lambda cfg, cwd, prompt: (_ for _ in ()).throw(AssertionError("kein Commit")),
    )
    assert run_once(cfg, "manuell", deps).status == "discarded"


def test_run_once_triage_receives_baseline_red(tmp_path):
    global sent, recorded, resets
    sent, recorded, resets = [], [], []
    from academy_auto.triage.rank import Pick
    cfg = _cfg(tmp_path)
    seen = {}

    def tp(cfg, cwd, baseline_red):
        seen["red"] = baseline_red
        return Pick("todo:b.ts:1", "b umsetzen", "grund")

    deps = base_deps(measure_gate=two_stage_measure(4, 1), triage_and_pick=tp)
    run_once(cfg, None, deps)  # Triage-Modus, Baseline rot
    assert seen["red"] is True


def test_run_once_dry_run_skips_commit_and_recording(tmp_path):
    global sent, recorded, resets
    sent, recorded, resets = [], [], []
    from academy_auto.triage.rank import Pick
    dry = tmp_path / "academy-auto.dryrun"
    dry.write_text("")
    cfg = _cfg(tmp_path, dry_run_flag=dry)
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
    cfg = _cfg(tmp_path)
    report = run_once(cfg, "manuell", base_deps())
    assert report.status == "committed"


def test_run_once_top_level_error_is_caught(tmp_path):
    global sent, recorded, resets
    sent, recorded, resets = [], [], []
    cfg = _cfg(tmp_path)
    deps = base_deps(prepare_worktree=lambda cfg: (_ for _ in ()).throw(RuntimeError("worktree kaputt")))
    report = run_once(cfg, "manuell", deps)
    assert report.status == "error"
    assert len(sent) == 1 and "kaputt" in sent[0]


def test_pause_flag_wins_over_dry_run(tmp_path):
    global sent, recorded, resets
    sent, recorded, resets = [], [], []
    pause = tmp_path / "p.pause"; pause.write_text("")
    dry = tmp_path / "d.dryrun"; dry.write_text("")
    cfg = _cfg(tmp_path, pause_flag=pause, dry_run_flag=dry)
    assert run_once(cfg, None, base_deps()).status == "paused"
    assert sent == []
