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
