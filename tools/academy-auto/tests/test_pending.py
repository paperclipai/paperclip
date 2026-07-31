from pathlib import Path
from academy_auto.pending import PendingRecord, write_pending, read_pending


def _rec():
    return PendingRecord(
        run_ts="2026-07-25T02:00:03", outcome="committed", task="Jest-Typen",
        reason="17x impact", gate_note="Delta grün (658→12)", branch_sha="abc123",
        has_change=True, tsc_delta=646, quarantined=["tsc:foo:1:TS2593"],
    )


def test_roundtrip(tmp_path):
    p = tmp_path / "pending.json"
    write_pending(p, _rec())
    got = read_pending(p)
    assert got == _rec()


def test_missing_file_returns_none(tmp_path):
    assert read_pending(tmp_path / "nope.json") is None


def test_broken_json_returns_none(tmp_path):
    p = tmp_path / "pending.json"
    p.write_text("{ this is not json")
    assert read_pending(p) is None
