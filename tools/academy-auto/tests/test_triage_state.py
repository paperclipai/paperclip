from academy_auto.triage.scan import Candidate
from academy_auto.triage.state import (
    load_state, save_state, record_outcome, is_quarantined, quarantined_keys, filter_candidates,
)


def _cand(key):
    return Candidate("todo", key, "a.ts", 1, "x", 10)


def test_load_missing_returns_empty(tmp_path):
    assert load_state(tmp_path / "nope.json") == {}


def test_load_corrupt_returns_empty(tmp_path):
    p = tmp_path / "s.json"
    p.write_text("{not json")
    assert load_state(p) == {}


def test_record_and_save_roundtrip(tmp_path):
    p = tmp_path / "s.json"
    state = {}
    record_outcome(state, "todo:a.ts:1", "discarded", now="2026-07-22")
    assert state["todo:a.ts:1"]["attempts"] == 1
    assert state["todo:a.ts:1"]["last_status"] == "discarded"
    record_outcome(state, "todo:a.ts:1", "discarded", now="2026-07-22")
    assert state["todo:a.ts:1"]["attempts"] == 2
    save_state(p, state)
    assert load_state(p) == state


def test_is_quarantined_after_two_fails():
    assert is_quarantined({"attempts": 2, "last_status": "discarded"}) is True
    assert is_quarantined({"attempts": 2, "last_status": "impl_failed"}) is True
    assert is_quarantined({"attempts": 1, "last_status": "discarded"}) is False
    assert is_quarantined({"attempts": 5, "last_status": "committed"}) is False


def test_filter_removes_done_and_quarantined():
    state = {
        "todo:done:1": {"attempts": 1, "last_status": "committed"},
        "todo:quar:1": {"attempts": 2, "last_status": "discarded"},
    }
    cands = [_cand("todo:done:1"), _cand("todo:quar:1"), _cand("todo:fresh:1")]
    kept = filter_candidates(state, cands)
    assert [c.key for c in kept] == ["todo:fresh:1"]


def test_quarantined_keys_lists_them():
    state = {
        "a": {"attempts": 2, "last_status": "discarded"},
        "b": {"attempts": 1, "last_status": "discarded"},
    }
    assert quarantined_keys(state) == ["a"]


def test_save_state_creates_missing_parent_dirs(tmp_path):
    from academy_auto.triage.state import save_state, load_state
    p = tmp_path / "neu" / "tief" / "state.json"
    save_state(p, {"k": {"attempts": 1, "last_status": "committed", "last_run": None}})
    assert load_state(p) == {"k": {"attempts": 1, "last_status": "committed", "last_run": None}}
