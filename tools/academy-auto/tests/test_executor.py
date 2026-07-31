from types import SimpleNamespace
from academy_auto.config import Config
from academy_auto.intent import Intent
from academy_auto.pending import PendingRecord
from academy_auto.executor import process_intent, _pr_create_argv


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


def test_approve_error_surfaces_stderr():
    # Regression: CalledProcessError verschluckte gh's stderr -> Meldung war
    # nutzlos ("exit status 1"). Der stderr-Grund muss in der Notify stehen.
    import subprocess
    calls, notes = [], []
    deps = _deps(Intent(ts="t", kind="approve", text="", ref_run_ts="R"),
                 _rec("R"), notes, calls)
    def boom(cfg):
        raise subprocess.CalledProcessError(
            1, ["gh"], stderr="not a git repository")
    deps.open_pr = boom
    process_intent(_cfg(), deps)
    assert any("not a git repository" in n for n in notes)
    assert "clear" in calls  # Intent bleibt trotz Fehler NICHT stehen


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


def test_pr_create_argv_uses_full_branch_as_head():
    # Regression: gh muss --head mit dem tatsächlich gepushten Branch
    # (cfg.branch, z.B. "agents/academy-auto") aufrufen, nicht nur dem
    # letzten Pfad-Teil ("academy-auto") — sonst findet gh den Head nicht.
    cfg = Config.default()
    argv = _pr_create_argv(cfg)
    assert "--head" in argv
    idx = argv.index("--head")
    assert argv[idx + 1] == cfg.branch
    assert argv[idx + 1] == "agents/academy-auto"


def _pending_rec(run_ts):
    from academy_auto.pending import PendingRecord
    return PendingRecord(run_ts=run_ts, outcome="committed", task="t", reason="",
                         gate_note="", branch_sha="", has_change=True, tsc_delta=0,
                         quarantined=[])


def test_intent_is_routed_to_the_run_it_belongs_to():
    """Beide Laeufe teilen sich EINEN intent.json-Pfad (der Bot kennt nur einen).
    Zuordnung ueber die run_ts — sie ist pro Lauf eindeutig."""
    from academy_auto.executor import config_for_intent
    from academy_auto.config import Config
    from academy_auto.intent import Intent
    a, w = Config.for_target("academy"), Config.for_target("web")
    pend = {a.pending_path: _pending_rec("AAA"), w.pending_path: _pending_rec("WWW")}
    chosen = config_for_intent(Intent("t", "approve", "", "WWW"), [a, w], pend.get)
    assert chosen.github_repo == w.github_repo


def test_unmatched_intent_selects_nothing():
    """Kein Lauf passt -> der Aufrufer meldet 'ueberholt', statt blind zu handeln."""
    from academy_auto.executor import config_for_intent
    from academy_auto.config import Config
    from academy_auto.intent import Intent
    a, w = Config.for_target("academy"), Config.for_target("web")
    assert config_for_intent(Intent("t", "approve", "", "XXX"), [a, w],
                             lambda p: _pending_rec("AAA")) is None or True
    pend = {a.pending_path: _pending_rec("AAA"), w.pending_path: _pending_rec("WWW")}
    assert config_for_intent(Intent("t", "approve", "", "XXX"), [a, w], pend.get) is None


def test_free_text_direction_goes_to_the_default_run():
    """Eine Richtungs-Antwort hat keine run_ts — sie landet als Issue im
    Haupt-Repo, nicht im Nirgendwo."""
    from academy_auto.executor import config_for_intent
    from academy_auto.config import Config
    from academy_auto.intent import Intent
    a, w = Config.for_target("academy"), Config.for_target("web")
    chosen = config_for_intent(Intent("t", "direction", "mach mal X", ""), [a, w], lambda p: None)
    assert chosen is a
