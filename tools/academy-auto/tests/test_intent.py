from academy_auto.intent import Intent, write_intent, read_intent, clear_intent


def test_roundtrip(tmp_path):
    p = tmp_path / "intent.json"
    it = Intent(ts="2026-07-25T08:03:11", kind="direction",
                text="Login-Screen responsive", ref_run_ts="2026-07-25T02:00:03")
    write_intent(p, it)
    assert read_intent(p) == it


def test_clear_removes_file(tmp_path):
    p = tmp_path / "intent.json"
    write_intent(p, Intent(ts="t", kind="approve", text="", ref_run_ts="r"))
    clear_intent(p)
    assert read_intent(p) is None
    clear_intent(p)  # zweites Mal wirft nicht


def test_missing_returns_none(tmp_path):
    assert read_intent(tmp_path / "nope.json") is None
