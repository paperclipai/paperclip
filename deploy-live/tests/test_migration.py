import os
import tempfile
from pathlib import Path
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
