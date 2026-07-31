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
