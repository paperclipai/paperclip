from types import SimpleNamespace
from academy_auto.config import Config
from academy_auto.gate import GateMeasure, StepMeasure
from academy_auto.pending import PendingRecord
from academy_auto.runner import RunOutcome
from academy_auto.orchestrator import run_once

parked: list = []
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
    base["pending_path"] = tmp_path / "pending.json"
    base.update(over)
    return Config(**base)


def base_deps(**over):
    d = dict(
        prepare_worktree=lambda cfg: cfg.worktree_path,
        measure_gate=lambda cfg, cwd: _measure(0),  # default: grün (Baseline und After)
        implement_task=lambda cfg, cwd, prompt: RunOutcome(ok=True, output="done"),
        commit_and_pr=lambda cfg, cwd, prompt: True,
        branch_sha=lambda cfg, cwd: "deadbee",
        now_ts=lambda: "2026-07-25T02:00:03",
        park=lambda cfg, rec: parked.append(rec),
        count_diff_lines=lambda cfg, cwd: 10,
        list_changed_files=lambda cfg, cwd: ["src/App.tsx"],
        triage_and_pick=lambda cfg, cwd, baseline_red: None,
        record_triage_outcome=lambda cfg, key, status: recorded.append((key, status)),
        reset_worktree=lambda cfg, cwd: resets.append(cwd),
        quarantined=lambda cfg: [],
        awaiting_approval=lambda cfg: False,  # default: nichts wartet auf ✅
    )
    d.update(over)
    return SimpleNamespace(**d)


def test_run_is_skipped_while_a_commit_awaits_approval(tmp_path):
    """prepare_worktree macht `reset --hard main` und wuerde einen noch nicht
    freigegebenen Commit vernichten — es darf gar nicht erst dazu kommen."""
    global parked
    parked = []
    prepared: list = []
    cfg = _cfg(tmp_path)

    report = run_once(cfg, "irgendeine Aufgabe", base_deps(
        awaiting_approval=lambda cfg: True,
        prepare_worktree=lambda cfg: prepared.append(cfg) or cfg.worktree_path,
    ))

    assert report.status == "awaiting_approval"
    assert prepared == []  # Worktree wurde nicht angefasst


def test_pending_record_survives_a_skipped_run(tmp_path):
    """pending.json traegt die run_ts, auf die die Telegram-Buttons zeigen
    (executor prueft ref_run_ts). Ueberschreiben wuerde die Freigabe
    unmoeglich machen — der Commit waere weder freigebbar noch gerettet."""
    global parked
    parked = []
    cfg = _cfg(tmp_path)

    run_once(cfg, "irgendeine Aufgabe", base_deps(awaiting_approval=lambda cfg: True))

    assert parked == []


def test_run_once_paused_when_flag_present(tmp_path):
    global parked
    parked = []
    flag = tmp_path / "academy-auto.pause"
    flag.write_text("stop")
    cfg = _cfg(tmp_path, pause_flag=flag)

    report = run_once(cfg, "irgendeine Aufgabe", base_deps())
    assert report.status == "paused"
    assert parked == []  # nichts geparkt, nichts passiert


def test_run_once_green_commits_and_reports(tmp_path):
    global parked
    parked = []
    cfg = _cfg(tmp_path)

    report = run_once(cfg, "Login-Bug fixen", base_deps())
    assert report.status == "committed"
    assert len(parked) == 1
    rec = parked[0]
    assert isinstance(rec, PendingRecord)
    assert rec.outcome == "committed"
    assert rec.has_change is True
    assert rec.branch_sha == "deadbee"


def test_run_once_red_gate_discards_and_reports(tmp_path):
    global parked
    parked = []
    cfg = _cfg(tmp_path)
    deps = base_deps(
        measure_gate=two_stage_measure(0, 3),  # grün Baseline, rotes After
        commit_and_pr=lambda cfg, cwd, prompt: (_ for _ in ()).throw(AssertionError("darf nicht committen")),
    )
    report = run_once(cfg, "Refactor", deps)
    assert report.status == "discarded"
    assert len(parked) == 1
    assert parked[0].has_change is False
    assert parked[0].tsc_delta == 0
    assert "rot" in parked[0].gate_note.lower()


def test_run_once_impl_failure_skips_gate_and_reports(tmp_path):
    global parked
    parked = []
    cfg = _cfg(tmp_path)
    deps = base_deps(
        implement_task=lambda cfg, cwd, prompt: RunOutcome(ok=False, output="claude timeout"),
        commit_and_pr=lambda cfg, cwd, prompt: (_ for _ in ()).throw(AssertionError("kein Commit")),
    )
    report = run_once(cfg, "x", deps)
    assert report.status == "impl_failed"
    assert len(parked) == 1
    assert parked[0].outcome == "impl_failed"
    assert parked[0].has_change is False


def test_run_once_diff_cap_exceeded_discards(tmp_path):
    global parked
    parked = []
    cfg = _cfg(tmp_path)
    deps = base_deps(
        count_diff_lines=lambda cfg, cwd: 900,
        commit_and_pr=lambda cfg, cwd, prompt: (_ for _ in ()).throw(AssertionError("darf nicht committen")),
    )
    report = run_once(cfg, "Riesenrefactor", deps)
    assert report.status == "discarded"
    assert len(parked) == 1
    assert "Cap" in parked[0].gate_note


def test_run_once_scope_violation_discards(tmp_path):
    global parked
    parked = []
    cfg = _cfg(tmp_path)
    deps = base_deps(
        list_changed_files=lambda cfg, cwd: ["src/App.tsx", ".env"],
        count_diff_lines=lambda cfg, cwd: (_ for _ in ()).throw(AssertionError("Cap darf nicht laufen")),
        commit_and_pr=lambda cfg, cwd, prompt: (_ for _ in ()).throw(AssertionError("darf nicht committen")),
    )
    report = run_once(cfg, "Aufgabe", deps)
    assert report.status == "discarded"
    assert len(parked) == 1
    assert "Scope" in parked[0].gate_note
    assert ".env" in parked[0].gate_note


def test_run_once_triage_mode_picks_and_commits(tmp_path):
    global parked, recorded, resets
    parked, recorded, resets = [], [], []
    from academy_auto.triage.rank import Pick
    cfg = _cfg(tmp_path)
    deps = base_deps(triage_and_pick=lambda cfg, cwd, baseline_red: Pick("tsc:a.ts:5:TS1", "Fix a.ts:5", "prio"))
    report = run_once(cfg, None, deps)  # None -> Triage-Modus
    assert report.status == "committed"
    assert recorded == [("tsc:a.ts:5:TS1", "committed")]
    assert resets == []  # bei committed kein Reset
    assert parked[0].reason == "prio"  # Grund im geparkten Datensatz


def test_run_once_triage_nothing_to_do(tmp_path):
    global parked, recorded, resets
    parked, recorded, resets = [], [], []
    cfg = _cfg(tmp_path)
    deps = base_deps(triage_and_pick=lambda cfg, cwd, baseline_red: None, quarantined=lambda cfg: ["todo:z.ts:3"])
    report = run_once(cfg, None, deps)
    assert report.status == "nothing_to_do"
    assert recorded == []
    assert len(parked) == 1
    assert parked[0].outcome == "nothing_to_do"
    assert "todo:z.ts:3" in parked[0].quarantined


def test_run_once_triage_discard_records_and_resets(tmp_path):
    global parked, recorded, resets
    parked, recorded, resets = [], [], []
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
    global parked, recorded, resets
    parked, recorded, resets = [], [], []
    cfg = _cfg(tmp_path)
    deps = base_deps(triage_and_pick=lambda cfg, cwd, baseline_red: (_ for _ in ()).throw(AssertionError("Triage darf nicht laufen")))
    report = run_once(cfg, "manueller Auftrag", deps)  # String -> kein Triage
    assert report.status == "committed"
    assert recorded == []  # manueller Lauf zeichnet nichts auf


def test_run_once_impl_fail_resets_worktree(tmp_path):
    global parked, recorded, resets
    parked, recorded, resets = [], [], []
    cfg = _cfg(tmp_path)
    deps = base_deps(implement_task=lambda cfg, cwd, prompt: RunOutcome(ok=False, output="claude weg"))
    report = run_once(cfg, "manuell", deps)
    assert report.status == "impl_failed"
    assert len(resets) == 1  # auch manueller Fehllauf setzt Worktree zurück


def test_run_once_committed_digest_lists_quarantine(tmp_path):
    global parked, recorded, resets
    parked, recorded, resets = [], [], []
    cfg = _cfg(tmp_path)
    deps = base_deps(quarantined=lambda cfg: ["todo:z.ts:9"])
    report = run_once(cfg, "manuell", deps)
    assert report.status == "committed"
    assert "todo:z.ts:9" in parked[0].quarantined  # Quarantäne auch im geparkten Datensatz


def test_run_once_green_baseline_absolute_pass_commits(tmp_path):
    global parked, recorded, resets
    parked, recorded, resets = [], [], []
    cfg = _cfg(tmp_path)
    deps = base_deps(measure_gate=two_stage_measure(0, 0))  # grün → grün
    assert run_once(cfg, "manuell", deps).status == "committed"
    assert parked[0].tsc_delta == 0


def test_run_once_green_baseline_after_red_discards(tmp_path):
    global parked, recorded, resets
    parked, recorded, resets = [], [], []
    cfg = _cfg(tmp_path)
    deps = base_deps(
        measure_gate=two_stage_measure(0, 2),  # grün → rot: neuer Fehler → discard
        commit_and_pr=lambda cfg, cwd, prompt: (_ for _ in ()).throw(AssertionError("kein Commit")),
    )
    r = run_once(cfg, "manuell", deps)
    assert r.status == "discarded"
    assert len(resets) == 1


def test_run_once_red_baseline_delta_progress_commits(tmp_path):
    global parked, recorded, resets
    parked, recorded, resets = [], [], []
    cfg = _cfg(tmp_path)
    deps = base_deps(measure_gate=two_stage_measure(5, 2))  # rot → weniger Fehler → Delta-Commit
    r = run_once(cfg, "manuell", deps)
    assert r.status == "committed"
    assert "Delta" in parked[0].gate_note
    assert parked[0].tsc_delta == 3


def test_run_once_red_baseline_no_progress_discards(tmp_path):
    global parked, recorded, resets
    parked, recorded, resets = [], [], []
    cfg = _cfg(tmp_path)
    deps = base_deps(
        measure_gate=two_stage_measure(5, 5),  # rot → kein Fortschritt → discard
        commit_and_pr=lambda cfg, cwd, prompt: (_ for _ in ()).throw(AssertionError("kein Commit")),
    )
    assert run_once(cfg, "manuell", deps).status == "discarded"


def test_run_once_triage_receives_baseline_red(tmp_path):
    global parked, recorded, resets
    parked, recorded, resets = [], [], []
    from academy_auto.triage.rank import Pick
    cfg = _cfg(tmp_path)
    seen = {}

    def tp(cfg, cwd, baseline_red):
        seen["red"] = baseline_red
        return Pick("todo:b.ts:1", "b umsetzen", "grund")

    deps = base_deps(measure_gate=two_stage_measure(4, 1), triage_and_pick=tp)
    run_once(cfg, None, deps)  # Triage-Modus, Baseline rot
    assert seen["red"] is True


def test_run_once_commits_when_dry_run_flag_absent(tmp_path):
    global parked, recorded, resets
    parked, recorded, resets = [], [], []
    cfg = _cfg(tmp_path)
    report = run_once(cfg, "manuell", base_deps())
    assert report.status == "committed"


def test_run_once_green_change_commits_even_with_dry_run_flag_present(tmp_path):
    """Der Trockenlauf-Sonderfall entfällt: das dry_run_flag bleibt als Feld
    bestehen, hat aber keine Wirkung mehr — Sicherheitsnetz ist jetzt die
    Freigabe (park), nicht mehr ein Reset des Worktrees."""
    global parked, recorded, resets
    parked, recorded, resets = [], [], []
    from academy_auto.triage.rank import Pick
    dry = tmp_path / "academy-auto.dryrun"
    dry.write_text("")
    cfg = _cfg(tmp_path, dry_run_flag=dry)
    committed = []
    deps = base_deps(
        triage_and_pick=lambda cfg, cwd, baseline_red: Pick("todo:b.ts:1", "b umsetzen", "grund"),
        commit_and_pr=lambda cfg, cwd, prompt: committed.append(prompt) or True,
    )
    report = run_once(cfg, None, deps)
    assert report.status == "committed"
    assert committed == ["b umsetzen"]
    assert recorded == [("todo:b.ts:1", "committed")]
    assert resets == []  # kein Reset — der Branch-Stand bleibt liegen
    assert parked[0].has_change is True


def test_run_once_top_level_error_is_caught(tmp_path):
    global parked, recorded, resets
    parked, recorded, resets = [], [], []
    cfg = _cfg(tmp_path)
    deps = base_deps(prepare_worktree=lambda cfg: (_ for _ in ()).throw(RuntimeError("worktree kaputt")))
    report = run_once(cfg, "manuell", deps)
    assert report.status == "error"
    assert len(parked) == 1
    assert parked[0].outcome == "error"
    assert "kaputt" in parked[0].gate_note


def test_pause_flag_wins_over_dry_run(tmp_path):
    global parked, recorded, resets
    parked, recorded, resets = [], [], []
    pause = tmp_path / "p.pause"; pause.write_text("")
    dry = tmp_path / "d.dryrun"; dry.write_text("")
    cfg = _cfg(tmp_path, pause_flag=pause, dry_run_flag=dry)
    assert run_once(cfg, None, base_deps()).status == "paused"
    assert parked == []


def test_impl_failed_digest_contains_error_output(tmp_path):
    """Bei einem Nachtlauf ist der geparkte Datensatz die einzige Spur — die Fehlerausgabe muss rein."""
    global parked, recorded, resets
    parked, recorded, resets = [], [], []
    cfg = _cfg(tmp_path)
    deps = base_deps(
        implement_task=lambda cfg, cwd, prompt: RunOutcome(ok=False, output="claude: EPERM auf /irgendwo"),
    )
    report = run_once(cfg, "manuell", deps)
    assert report.status == "impl_failed"
    assert "EPERM auf /irgendwo" in parked[0].gate_note


def test_green_change_parks_has_change(tmp_path):
    from academy_auto.config import Config as _Config

    def _gate(total):
        # `ok=True` noetig: delta_decision() prueft seit dc27a586f (Timeout/
        # Crash-Haertung) after.ok, was im Brief-Snippet noch fehlte.
        return SimpleNamespace(total=total, passed=(total == 0), steps=[], ok=True)

    def _seq_gate(totals):
        it = iter(totals)
        return lambda cfg, cwd: _gate(next(it))

    def _deps(parked_list, **over):
        base = dict(
            prepare_worktree=lambda cfg: "/wt",
            quarantined=lambda cfg: [],
            awaiting_approval=lambda cfg: False,
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
            park=lambda cfg, rec: parked_list.append(rec),
        )
        base.update(over)
        return SimpleNamespace(**base)

    cfg = _Config.default()
    # Baseline rot (10), After grün-er (0) -> delta positiv, Change bereit
    parked_list = []
    deps = _deps(parked_list, measure_gate=_seq_gate([10, 0]))
    rep = run_once(cfg, None, deps)
    assert rep.status == "committed"
    assert len(parked_list) == 1
    assert isinstance(parked_list[0], PendingRecord)
    assert parked_list[0].has_change is True
    assert parked_list[0].tsc_delta == 10
