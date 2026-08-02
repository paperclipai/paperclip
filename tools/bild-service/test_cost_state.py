import os, tempfile
import cost_state

def setup_tmp():
    fd, path = tempfile.mkstemp(); os.close(fd); os.remove(path)
    cost_state.STATE_FILE = path
    return path

def test_increment_and_limit():
    setup_tmp()
    assert cost_state.remaining_today("2026-06-15") == cost_state.DAILY_IMAGE_LIMIT
    cost_state.record("2026-06-15", "medium")
    assert cost_state.remaining_today("2026-06-15") == cost_state.DAILY_IMAGE_LIMIT - 1

def test_new_day_resets():
    setup_tmp()
    cost_state.record("2026-06-15", "high")
    assert cost_state.remaining_today("2026-06-16") == cost_state.DAILY_IMAGE_LIMIT

def test_monthly_spent_sums_across_days():
    setup_tmp()
    cost_state.record("2026-06-15", "high")   # 0.17
    cost_state.record("2026-06-20", "medium") # 0.04
    cost_state.record("2026-07-01", "medium") # anderer Monat
    assert cost_state.monthly_spent("2026-06") == 0.21
    assert cost_state.monthly_spent("2026-07") == 0.04
    assert cost_state.monthly_spent("2026-05") == 0.0


def test_local_counter_is_separate_from_openai_counter():
    setup_tmp()
    cost_state.record_local("2026-08-02")
    assert cost_state.remaining_local_today("2026-08-02") == cost_state.DAILY_LOCAL_LIMIT - 1
    # Der OpenAI-Zaehler bleibt unberuehrt
    assert cost_state.remaining_today("2026-08-02") == cost_state.DAILY_IMAGE_LIMIT
    # ... und kostet nichts
    assert cost_state.monthly_spent("2026-08") == 0.0


def test_local_counter_resets_next_day():
    setup_tmp()
    cost_state.record_local("2026-08-02")
    assert cost_state.remaining_local_today("2026-08-03") == cost_state.DAILY_LOCAL_LIMIT


def test_pruning_keeps_jobs_key():
    path = setup_tmp()
    import job_state
    job_state.STATE_FILE = path
    job_state.add("issue-1", "prompt-1", "company-a", now=1000.0)
    # 40 Tage aufzeichnen -> Beschneidung greift
    for day in range(1, 41):
        cost_state.record("2026-03-%02d" % day, "medium")
    assert job_state.get("issue-1") is not None
    assert len([k for k in cost_state._load() if k.startswith("2026-")]) <= 31
