import json
import os
import tempfile
from pathlib import Path
import pytest
from state_store import open_db, init_schema
from migrate_to_sqlite import migrate

FIXTURES = Path(__file__).parent / "fixtures"


def test_migrate_clean_input(tmp_path):
    db = tmp_path / "out.db"
    init_schema(db)
    quarantine = tmp_path / "q.jsonl"
    summary = migrate(
        state_json_path=FIXTURES / "sample_state.json",
        trade_history_csv_path=FIXTURES / "sample_trade_history.csv",
        db_path=db,
        quarantine_path=quarantine,
    )
    assert summary["positions_migrated"] == 2  # 1 open + 1 closed
    assert summary["fills_migrated"] == 2
    assert summary["quarantined"] == 0

    conn = open_db(db)
    rows = conn.execute("SELECT symbol, status FROM positions ORDER BY id").fetchall()
    assert [(r["symbol"], r["status"]) for r in rows] == [
        ("ORDIUSDT", "open"), ("WIFUSDT", "closed"),
    ]
    conn.close()


def test_migrate_quarantines_malformed(tmp_path):
    db = tmp_path / "out.db"
    init_schema(db)
    quarantine = tmp_path / "q.jsonl"
    summary = migrate(
        state_json_path=FIXTURES / "malformed_state.json",
        trade_history_csv_path=FIXTURES / "malformed_trade_history.csv",
        db_path=db,
        quarantine_path=quarantine,
    )
    # 1 valid open + 1 valid closed = 2 positions; 0 valid fills
    assert summary["positions_migrated"] == 2
    assert summary["fills_migrated"] == 0
    # 1 bad open position + 1 bad fill + 1 bad closed = 3 quarantined
    assert summary["quarantined"] == 3
    lines = [json.loads(l) for l in quarantine.read_text().splitlines()]
    kinds = sorted(l["kind"] for l in lines)
    assert kinds == ["closed_position", "fill", "open_position"]


def test_migrate_raises_when_quarantine_exceeds_threshold(tmp_path):
    db = tmp_path / "out.db"
    init_schema(db)
    quarantine = tmp_path / "q.jsonl"
    with pytest.raises(SystemExit) as excinfo:
        migrate(
            state_json_path=FIXTURES / "malformed_state.json",
            trade_history_csv_path=FIXTURES / "malformed_trade_history.csv",
            db_path=db,
            quarantine_path=quarantine,
            quarantine_threshold_pct=10.0,  # 3 quarantined / 5 total = 60% > 10%
        )
    assert excinfo.value.code != 0


def test_migrate_succeeds_when_quarantine_under_threshold(tmp_path):
    db = tmp_path / "out.db"
    init_schema(db)
    quarantine = tmp_path / "q.jsonl"
    summary = migrate(
        state_json_path=FIXTURES / "sample_state.json",
        trade_history_csv_path=FIXTURES / "sample_trade_history.csv",
        db_path=db,
        quarantine_path=quarantine,
        quarantine_threshold_pct=5.0,
    )
    assert summary["quarantined"] == 0


import subprocess
import sys


def test_cli_dry_run_does_not_write_db(tmp_path):
    db = tmp_path / "out.db"
    init_schema(db)
    quarantine = tmp_path / "q.jsonl"
    r = subprocess.run(
        [sys.executable, "migrate_to_sqlite.py",
         "--state", str(FIXTURES / "sample_state.json"),
         "--csv", str(FIXTURES / "sample_trade_history.csv"),
         "--db", str(db),
         "--quarantine", str(quarantine),
         "--dry-run"],
        capture_output=True, text=True, cwd=Path(__file__).parent.parent,
    )
    assert r.returncode == 0, r.stderr
    conn = open_db(db)
    n = conn.execute("SELECT COUNT(*) FROM positions").fetchone()[0]
    conn.close()
    assert n == 0  # dry-run wrote nothing
