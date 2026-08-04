import os
import tempfile

import job_state


def setup_tmp():
    fd, path = tempfile.mkstemp()
    os.close(fd)
    os.remove(path)
    job_state.STATE_FILE = path
    return path


def test_add_and_read_back():
    setup_tmp()
    job_state.add("issue-1", "prompt-1", "company-a", now=1000.0)
    jobs = job_state.all()
    assert list(jobs.keys()) == ["issue-1"]
    assert jobs["issue-1"]["prompt_id"] == "prompt-1"
    assert jobs["issue-1"]["company_id"] == "company-a"
    assert jobs["issue-1"]["attempts"] == 1


def test_survives_restart():
    path = setup_tmp()
    job_state.add("issue-1", "prompt-1", "company-a", now=1000.0)
    job_state.STATE_FILE = path          # simuliert Neustart: neu von Platte lesen
    assert job_state.get("issue-1")["prompt_id"] == "prompt-1"


def test_drop_removes_job():
    setup_tmp()
    job_state.add("issue-1", "prompt-1", "company-a", now=1000.0)
    job_state.drop("issue-1")
    assert job_state.all() == {}
    assert job_state.get("issue-1") is None


def test_drop_unknown_job_is_silent():
    setup_tmp()
    job_state.drop("gibtsnicht")
    assert job_state.all() == {}


def test_bump_attempt_increments_and_replaces_prompt_id():
    setup_tmp()
    job_state.add("issue-1", "prompt-1", "company-a", now=1000.0)
    n = job_state.bump_attempt("issue-1", "prompt-2", now=2000.0)
    assert n == 2
    job = job_state.get("issue-1")
    assert job["prompt_id"] == "prompt-2"
    assert job["submitted_at"] == 2000.0


def test_bump_attempt_updates_seed_when_given():
    setup_tmp()
    job_state.add("issue-1", "prompt-1", "company-a", now=1000.0, seed=111)
    job_state.bump_attempt("issue-1", "prompt-2", now=2000.0, seed=222)
    assert job_state.get("issue-1")["seed"] == 222


def test_bump_attempt_keeps_seed_when_not_given():
    setup_tmp()
    job_state.add("issue-1", "prompt-1", "company-a", now=1000.0, seed=111)
    job_state.bump_attempt("issue-1", "prompt-2", now=2000.0)
    assert job_state.get("issue-1")["seed"] == 111


def test_age_seconds():
    setup_tmp()
    job_state.add("issue-1", "prompt-1", "company-a", now=1000.0)
    assert job_state.age_seconds(job_state.get("issue-1"), now=1300.0) == 300.0


def test_jobs_do_not_disturb_cost_keys():
    path = setup_tmp()
    import cost_state
    cost_state.STATE_FILE = path
    cost_state.record("2026-08-02", "medium")
    job_state.add("issue-1", "prompt-1", "company-a", now=1000.0)
    assert cost_state.remaining_today("2026-08-02") == cost_state.DAILY_IMAGE_LIMIT - 1
    assert job_state.get("issue-1") is not None


# --- Fix round: Finding 1 — Unreachable-Zaehler muss auf der Platte leben,---
# --- weil launchd (StartInterval, kein KeepAlive) fuer jeden Zyklus einen ---
# --- frischen Prozess startet und Modul-Globals dabei verloren gehen.     ---

def test_unreachable_counters_default_to_zero_and_not_alerted():
    setup_tmp()
    assert job_state.unreachable_cycles() == 0
    assert job_state.is_unreachable_alerted() is False


def test_increment_unreachable_cycles_persists_and_returns_new_count():
    setup_tmp()
    assert job_state.increment_unreachable_cycles() == 1
    assert job_state.increment_unreachable_cycles() == 2
    assert job_state.unreachable_cycles() == 2


def test_set_unreachable_alerted_persists():
    setup_tmp()
    job_state.set_unreachable_alerted(True)
    assert job_state.is_unreachable_alerted() is True


def test_reset_unreachable_clears_both_fields():
    setup_tmp()
    job_state.increment_unreachable_cycles()
    job_state.increment_unreachable_cycles()
    job_state.set_unreachable_alerted(True)
    job_state.reset_unreachable()
    assert job_state.unreachable_cycles() == 0
    assert job_state.is_unreachable_alerted() is False


def test_unreachable_counter_survives_a_genuine_process_restart():
    """Das ist der eigentliche Beweis: launchd startet pro Zyklus einen
    komplett neuen Python-Prozess. Ein frischer 'import job_state' darf den
    Fortschritt nicht verlieren -- er muss ausschliesslich aus der Datei
    kommen, nicht aus Modul-Globals, die ein Reimport zuruecksetzen wuerde."""
    path = setup_tmp()
    job_state.increment_unreachable_cycles()
    job_state.increment_unreachable_cycles()
    job_state.increment_unreachable_cycles()

    import importlib
    reloaded = importlib.reload(job_state)
    reloaded.STATE_FILE = path   # das simulierte "neu von Platte lesen"

    assert reloaded.unreachable_cycles() == 3   # Fortschritt akkumuliert ueber den Neustart
    reloaded.increment_unreachable_cycles()
    assert reloaded.unreachable_cycles() == 4

    # Aufraeumen: globalen Modulzustand fuer nachfolgende Tests nicht verwirren
    job_state.STATE_FILE = path
    job_state.reset_unreachable()


def test_add_merkt_sich_die_quellbilder(tmp_path):
    job_state.STATE_FILE = str(tmp_path / "s.json")
    job_state.add("i1", "p1", "c1", now=1.0, sources=["a.png", "b.png"])
    assert job_state.get("i1")["sources"] == ["a.png", "b.png"]


def test_add_ohne_quellbilder_bleibt_leer(tmp_path):
    job_state.STATE_FILE = str(tmp_path / "s.json")
    job_state.add("i1", "p1", "c1", now=1.0)
    assert job_state.get("i1")["sources"] == []
