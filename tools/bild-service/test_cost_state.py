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
