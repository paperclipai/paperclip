"""Tests for shadow_writer.

Verifies that ShadowWriter mirrors writes correctly when enabled, no-ops
when disabled, and isolates failures so the trader's primary path is
never broken by a SQLite issue.
"""
import os
import tempfile
import sqlite3

import pytest

from shadow_writer import ShadowWriter
import state_store


@pytest.fixture
def shadow_db_path():
    """A temp file path; ShadowWriter will init_schema on it."""
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    os.remove(path)  # let ShadowWriter create + init the schema fresh
    yield path
    if os.path.exists(path):
        os.remove(path)


def test_shadow_writer_disabled_does_nothing(shadow_db_path):
    sw = ShadowWriter(enabled=False)
    assert sw.enabled is False
    assert sw.mirror_position_open(
        symbol="BTCUSDT", exchange_a="OKX", exchange_b="MEXC",
        side_a="buy", side_b="sell",
        size_usd_a=25.0, size_usd_b=25.0,
        entry_spread_pct=0.95, opened_at_ms=1000,
    ) is None
    assert sw.mirror_position_close(
        position_id=1, closed_at_ms=2000,
        exit_spread_pct=0.10, realized_pnl_usd=0.50,
    ) is False
    assert sw.mirror_fill(
        position_id=1, exchange="OKX", leg="a", intent="entry",
        order_id="x", side="buy", size_usd=25.0, fill_price=1.0,
        fees_usd=0.025, filled_at_ms=1500,
    ) is None
    sw.close()


def test_shadow_writer_enabled_creates_db(shadow_db_path):
    sw = ShadowWriter(enabled=True, db_path=shadow_db_path)
    assert sw.enabled is True
    assert os.path.exists(shadow_db_path)
    sw.close()


def test_shadow_writer_mirrors_position_open(shadow_db_path):
    sw = ShadowWriter(enabled=True, db_path=shadow_db_path)
    pid = sw.mirror_position_open(
        symbol="BTCUSDT", exchange_a="OKX", exchange_b="MEXC",
        side_a="buy", side_b="sell",
        size_usd_a=25.0, size_usd_b=25.0,
        entry_spread_pct=0.95, opened_at_ms=1000,
    )
    assert pid is not None and pid > 0
    # Read back via state_store directly.
    conn = state_store.open_db(shadow_db_path)
    pos = state_store.get_position(conn, pid)
    assert pos is not None
    assert pos.symbol == "BTCUSDT"
    assert pos.size_usd_a == 25.0
    assert pos.status == "open"
    assert pos.opened_at_ms == 1000
    conn.close()
    sw.close()


def test_shadow_writer_mirrors_position_close(shadow_db_path):
    sw = ShadowWriter(enabled=True, db_path=shadow_db_path)
    pid = sw.mirror_position_open(
        symbol="BTCUSDT", exchange_a="OKX", exchange_b="MEXC",
        side_a="buy", side_b="sell",
        size_usd_a=25.0, size_usd_b=25.0,
        entry_spread_pct=0.95, opened_at_ms=1000,
    )
    ok = sw.mirror_position_close(
        position_id=pid, closed_at_ms=2000,
        exit_spread_pct=0.10, realized_pnl_usd=0.50,
    )
    assert ok is True
    conn = state_store.open_db(shadow_db_path)
    pos = state_store.get_position(conn, pid)
    assert pos.status == "closed"
    assert pos.closed_at_ms == 2000
    assert pos.realized_pnl_usd == 0.50
    conn.close()
    sw.close()


def test_shadow_writer_mirrors_fill_linked_to_position(shadow_db_path):
    sw = ShadowWriter(enabled=True, db_path=shadow_db_path)
    pid = sw.mirror_position_open(
        symbol="BTCUSDT", exchange_a="OKX", exchange_b="MEXC",
        side_a="buy", side_b="sell",
        size_usd_a=25.0, size_usd_b=25.0,
        entry_spread_pct=0.95, opened_at_ms=1000,
    )
    fid = sw.mirror_fill(
        position_id=pid, exchange="OKX", leg="a", intent="entry",
        order_id="okx-1", side="buy", size_usd=25.0, fill_price=42000.0,
        fees_usd=0.025, filled_at_ms=1500,
        raw_response={"ordId": "okx-1", "fillPx": "42000"},
    )
    assert fid is not None
    conn = state_store.open_db(shadow_db_path)
    fills = state_store.list_fills_for_position(conn, pid)
    assert len(fills) == 1
    assert fills[0].exchange == "OKX"
    assert fills[0].order_id == "okx-1"
    conn.close()
    sw.close()


def test_shadow_writer_mirrors_audit(shadow_db_path):
    sw = ShadowWriter(enabled=True, db_path=shadow_db_path)
    aid = sw.mirror_audit(
        event_type="entry_attempt", severity="info",
        message="opening BTCUSDT", exchange="OKX", symbol="BTCUSDT",
        details={"spread_pct": 0.95},
        timestamp_ms=1000,
    )
    assert aid is not None
    conn = state_store.open_db(shadow_db_path)
    rows = conn.execute(
        "SELECT * FROM audit_log WHERE id=?", (aid,)
    ).fetchall()
    assert len(rows) == 1
    assert rows[0]["event_type"] == "entry_attempt"
    assert rows[0]["severity"] == "info"
    conn.close()
    sw.close()


def test_shadow_writer_failure_is_isolated(shadow_db_path):
    """If the underlying SQLite write blows up, the mirror returns None
    rather than raising — the trader's primary path must continue."""
    sw = ShadowWriter(enabled=True, db_path=shadow_db_path)
    # Force a failure by closing the connection out from under the writer.
    sw._conn.close()
    # Now any mirror_* call would normally raise sqlite3.ProgrammingError.
    result = sw.mirror_position_open(
        symbol="BTCUSDT", exchange_a="OKX", exchange_b="MEXC",
        side_a="buy", side_b="sell",
        size_usd_a=25.0, size_usd_b=25.0,
        entry_spread_pct=0.95, opened_at_ms=1000,
    )
    assert result is None  # failure absorbed, not raised
    sw.close()


def test_shadow_writer_init_failure_disables_safely():
    """If init_schema fails (e.g. unwritable path), shadow writer becomes a no-op."""
    sw = ShadowWriter(enabled=True, db_path="/nonexistent/dir/state.db")
    assert sw.enabled is False
    # All mirror methods quietly no-op.
    assert sw.mirror_position_open(
        symbol="BTCUSDT", exchange_a="OKX", exchange_b="MEXC",
        side_a="buy", side_b="sell",
        size_usd_a=25.0, size_usd_b=25.0,
        entry_spread_pct=0.95, opened_at_ms=1000,
    ) is None


def test_shadow_writer_serializes_dict_raw_response(shadow_db_path):
    """Raw-response dicts get JSON-serialized before storage."""
    sw = ShadowWriter(enabled=True, db_path=shadow_db_path)
    pid = sw.mirror_position_open(
        symbol="BTCUSDT", exchange_a="OKX", exchange_b="MEXC",
        side_a="buy", side_b="sell",
        size_usd_a=25.0, size_usd_b=25.0,
        entry_spread_pct=0.95, opened_at_ms=1000,
    )
    sw.mirror_fill(
        position_id=pid, exchange="OKX", leg="a", intent="entry",
        order_id="okx-2", side="buy", size_usd=25.0, fill_price=42000.0,
        fees_usd=0.025, filled_at_ms=1500,
        raw_response={"ordId": "okx-2", "nested": {"key": "value"}},
    )
    conn = state_store.open_db(shadow_db_path)
    rows = conn.execute(
        "SELECT raw_response FROM fills WHERE order_id=?", ("okx-2",)
    ).fetchall()
    assert len(rows) == 1
    import json
    parsed = json.loads(rows[0]["raw_response"])
    assert parsed["nested"]["key"] == "value"
    conn.close()
    sw.close()
