import sqlite3
import pytest
from state_store import open_db, init_schema

def test_init_schema_creates_all_tables(fresh_db):
    conn = open_db(fresh_db)
    cur = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    )
    tables = {row[0] for row in cur}
    assert tables >= {
        "positions", "fills", "audit_log",
        "balances", "exchange_health", "reconciliation_events",
    }
    conn.close()

def test_open_db_enables_foreign_keys(fresh_db):
    conn = open_db(fresh_db)
    cur = conn.execute("PRAGMA foreign_keys")
    assert cur.fetchone()[0] == 1
    conn.close()

def test_open_db_uses_wal_mode(fresh_db):
    conn = open_db(fresh_db)
    cur = conn.execute("PRAGMA journal_mode")
    assert cur.fetchone()[0].lower() == "wal"
    conn.close()


def test_open_db_synchronous_normal(fresh_db):
    conn = open_db(fresh_db)
    # PRAGMA synchronous returns 1 for NORMAL
    assert conn.execute("PRAGMA synchronous").fetchone()[0] == 1
    conn.close()


def test_position_status_check_rejects_bogus_value(fresh_db):
    conn = open_db(fresh_db)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            """INSERT INTO positions
               (symbol, exchange_a, exchange_b, side_a, side_b,
                size_usd_a, size_usd_b, entry_spread_pct, status, opened_at)
               VALUES ('X', 'MEXC', 'BLOFIN', 'buy', 'sell',
                       25, 25, 0.01, 'bogus', 1)"""
        )
    conn.close()


def test_position_side_check_rejects_bogus_value(fresh_db):
    conn = open_db(fresh_db)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            """INSERT INTO positions
               (symbol, exchange_a, exchange_b, side_a, side_b,
                size_usd_a, size_usd_b, entry_spread_pct, status, opened_at)
               VALUES ('X', 'MEXC', 'BLOFIN', 'long', 'sell',
                       25, 25, 0.01, 'open', 1)"""
        )
    conn.close()


def test_recon_event_resolution_check_rejects_bogus_value(fresh_db):
    conn = open_db(fresh_db)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            """INSERT INTO reconciliation_events
               (timestamp, source, category, severity, resolution)
               VALUES (1, 'reconciler', 'orphan_leg', 'error', 'bogus')"""
        )
    conn.close()


from schemas import PositionRecord
from state_store import (
    insert_position, get_position, update_position_status,
    close_position, list_open_positions,
)


def _sample_position(**overrides):
    base = dict(
        symbol="ORDIUSDT", exchange_a="MEXC", exchange_b="BLOFIN",
        side_a="buy", side_b="sell",
        size_usd_a=25.0, size_usd_b=25.0,
        entry_spread_pct=0.012,
        status="opening", opened_at_ms=1700000000000,
    )
    base.update(overrides)
    return base


def test_insert_position_returns_id_and_round_trips(fresh_db):
    conn = open_db(fresh_db)
    pid = insert_position(conn, **_sample_position())
    assert pid > 0
    rec = get_position(conn, pid)
    assert isinstance(rec, PositionRecord)
    assert rec.symbol == "ORDIUSDT"
    assert rec.status == "opening"
    conn.close()


def test_update_position_status(fresh_db):
    conn = open_db(fresh_db)
    pid = insert_position(conn, **_sample_position())
    update_position_status(conn, pid, "open")
    assert get_position(conn, pid).status == "open"
    conn.close()


def test_close_position_records_exit(fresh_db):
    conn = open_db(fresh_db)
    pid = insert_position(conn, **_sample_position(status="open"))
    close_position(conn, pid, closed_at_ms=1700000060000,
                   exit_spread_pct=0.0014, realized_pnl_usd=0.42)
    rec = get_position(conn, pid)
    assert rec.status == "closed"
    assert rec.closed_at_ms == 1700000060000
    assert rec.exit_spread_pct == 0.0014
    assert rec.realized_pnl_usd == 0.42
    conn.close()


def test_list_open_positions_filters_by_status(fresh_db):
    conn = open_db(fresh_db)
    pid_open = insert_position(conn, **_sample_position(
        symbol="A", opened_at_ms=1, status="open"))
    insert_position(conn, **_sample_position(
        symbol="B", opened_at_ms=2, status="closed"))
    insert_position(conn, **_sample_position(
        symbol="C", opened_at_ms=3, status="opening"))
    open_ids = {p.id for p in list_open_positions(conn)}
    assert pid_open in open_ids
    assert len(open_ids) == 2  # 'open' and 'opening' both count
    conn.close()


def test_get_position_returns_none_for_missing(fresh_db):
    conn = open_db(fresh_db)
    assert get_position(conn, 999) is None
    conn.close()
