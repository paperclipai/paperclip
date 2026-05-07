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


from state_store import insert_fill, list_fills_for_position, list_recent_fills


def _sample_fill(position_id, **overrides):
    base = dict(
        position_id=position_id, exchange="MEXC", leg="a", intent="entry",
        order_id="ord-1", side="buy",
        size_usd=25.0, fill_price=1.234, fees_usd=0.01,
        filled_at_ms=1700000000500, raw_response='{"x":1}',
    )
    base.update(overrides)
    return base


def test_insert_fill_links_to_position(fresh_db):
    conn = open_db(fresh_db)
    pid = insert_position(conn, **_sample_position(status="open"))
    fid = insert_fill(conn, **_sample_fill(pid))
    assert fid > 0
    fills = list_fills_for_position(conn, pid)
    assert len(fills) == 1
    assert fills[0].order_id == "ord-1"
    conn.close()


def test_insert_fill_rejects_duplicate_exchange_order(fresh_db):
    conn = open_db(fresh_db)
    pid = insert_position(conn, **_sample_position(status="open"))
    insert_fill(conn, **_sample_fill(pid))
    with pytest.raises(sqlite3.IntegrityError):
        insert_fill(conn, **_sample_fill(pid))
    conn.close()


def test_list_recent_fills_filters_by_timestamp(fresh_db):
    conn = open_db(fresh_db)
    pid = insert_position(conn, **_sample_position(status="open"))
    insert_fill(conn, **_sample_fill(pid, order_id="o1", filled_at_ms=100))
    insert_fill(conn, **_sample_fill(pid, order_id="o2", filled_at_ms=200))
    insert_fill(conn, **_sample_fill(pid, order_id="o3", filled_at_ms=300))
    recent = list_recent_fills(conn, exchange="MEXC", since_ms=150)
    assert {f.order_id for f in recent} == {"o2", "o3"}
    conn.close()


from state_store import write_audit, list_audit_for_position, list_audit_recent


def test_write_audit_round_trips(fresh_db):
    conn = open_db(fresh_db)
    write_audit(conn, timestamp_ms=1, event_type="entry_attempt",
                severity="info", message="hi")
    rows = list_audit_recent(conn, since_ms=0, limit=10)
    assert len(rows) == 1
    assert rows[0].message == "hi"
    assert rows[0].id is not None
    assert rows[0].id > 0
    conn.close()


def test_audit_filters_by_position(fresh_db):
    conn = open_db(fresh_db)
    pid = insert_position(conn, **_sample_position(status="open"))
    write_audit(conn, timestamp_ms=1, event_type="entry_attempt",
                severity="info", message="for-pos", position_id=pid)
    write_audit(conn, timestamp_ms=2, event_type="heartbeat",
                severity="info", message="other")
    rows = list_audit_for_position(conn, pid)
    assert len(rows) == 1
    assert rows[0].message == "for-pos"
    conn.close()


def test_audit_serializes_details_dict(fresh_db):
    conn = open_db(fresh_db)
    write_audit(conn, timestamp_ms=1, event_type="x",
                severity="warn", message="m", details={"k": "v"})
    rows = list_audit_recent(conn, since_ms=0, limit=10)
    assert rows[0].details == {"k": "v"}
    conn.close()


from state_store import (
    snapshot_balance, latest_balance,
    upsert_exchange_health, get_exchange_health,
)



def test_balance_snapshot_and_latest(fresh_db):
    conn = open_db(fresh_db)
    snapshot_balance(conn, exchange="MEXC", asset="USDT",
                     available_usd=50.0, locked_usd=0.0, snapshot_at_ms=100)
    snapshot_balance(conn, exchange="MEXC", asset="USDT",
                     available_usd=49.5, locked_usd=0.5, snapshot_at_ms=200)
    snap = latest_balance(conn, exchange="MEXC")
    assert snap.snapshot_at_ms == 200
    assert snap.available_usd == 49.5
    conn.close()


def test_latest_balance_returns_none_for_missing(fresh_db):
    conn = open_db(fresh_db)
    assert latest_balance(conn, exchange="OKX") is None
    conn.close()


def test_exchange_health_upsert(fresh_db):
    conn = open_db(fresh_db)
    upsert_exchange_health(conn, exchange="MEXC", status="ok",
                           last_ok_at_ms=100, consecutive_errors=0)
    h = get_exchange_health(conn, "MEXC")
    assert h.status == "ok"
    upsert_exchange_health(conn, exchange="MEXC", status="degraded",
                           last_error_at_ms=200, last_error_msg="timeout",
                           consecutive_errors=2)
    h = get_exchange_health(conn, "MEXC")
    assert h.status == "degraded"
    assert h.consecutive_errors == 2
    conn.close()


from state_store import (
    write_recon_event, list_unresolved_recon_events,
    resolve_recon_event, upsert_recon_event,
)


def test_write_recon_event_round_trips(fresh_db):
    conn = open_db(fresh_db)
    eid = write_recon_event(
        conn, timestamp_ms=1, source="reconciler",
        category="orphan_leg", severity="error",
        exchange="MEXC", symbol="ORDIUSDT",
        expected={"size": 25}, actual={"size": 0},
    )
    assert eid > 0
    events = list_unresolved_recon_events(conn)
    assert len(events) == 1
    e = events[0]
    assert e.expected == {"size": 25}
    assert e.actual == {"size": 0}
    assert e.resolution == "unresolved"
    assert e.id == eid
    conn.close()


def test_resolve_recon_event(fresh_db):
    conn = open_db(fresh_db)
    eid = write_recon_event(
        conn, timestamp_ms=1, source="invariants",
        category="size_mismatch", severity="warn",
    )
    resolve_recon_event(conn, eid, resolution="manual", notes="closed by user")
    events = list_unresolved_recon_events(conn)
    assert len(events) == 0
    conn.close()


def test_list_unresolved_filters_by_severity(fresh_db):
    conn = open_db(fresh_db)
    write_recon_event(conn, timestamp_ms=1, source="reconciler",
                      category="balance_drift", severity="info")
    write_recon_event(conn, timestamp_ms=2, source="reconciler",
                      category="orphan_leg", severity="error")
    errs = list_unresolved_recon_events(conn, min_severity="error")
    assert len(errs) == 1
    assert errs[0].category == "orphan_leg"
    conn.close()


def test_upsert_recon_event_inserts_new(fresh_db):
    conn = open_db(fresh_db)
    eid, was_insert = upsert_recon_event(
        conn, timestamp_ms=1000, source="reconciler",
        category="orphan_leg", severity="error",
        exchange="MEXC", symbol="ORDIUSDT",
    )
    assert was_insert is True
    assert eid > 0
    row = conn.execute(
        "SELECT repeat_count, last_seen_ms FROM reconciliation_events WHERE id=?", (eid,)
    ).fetchone()
    assert row["repeat_count"] == 1
    assert row["last_seen_ms"] == 1000
    conn.close()


def test_upsert_recon_event_dedups_unresolved(fresh_db):
    conn = open_db(fresh_db)
    eid1, was_insert1 = upsert_recon_event(
        conn, timestamp_ms=1000, source="reconciler",
        category="orphan_leg", severity="error",
        exchange="MEXC", symbol="ORDIUSDT",
    )
    eid2, was_insert2 = upsert_recon_event(
        conn, timestamp_ms=2000, source="reconciler",
        category="orphan_leg", severity="error",
        exchange="MEXC", symbol="ORDIUSDT",
    )
    eid3, was_insert3 = upsert_recon_event(
        conn, timestamp_ms=3000, source="reconciler",
        category="orphan_leg", severity="error",
        exchange="MEXC", symbol="ORDIUSDT",
    )
    assert was_insert1 is True
    assert was_insert2 is False
    assert was_insert3 is False
    assert eid1 == eid2 == eid3
    row = conn.execute(
        "SELECT repeat_count, last_seen_ms, timestamp FROM reconciliation_events WHERE id=?",
        (eid1,),
    ).fetchone()
    assert row["repeat_count"] == 3
    assert row["last_seen_ms"] == 3000
    assert row["timestamp"] == 1000  # original first-seen preserved
    # Only one row in DB total.
    count = conn.execute(
        "SELECT COUNT(*) FROM reconciliation_events"
    ).fetchone()[0]
    assert count == 1
    conn.close()


def test_upsert_recon_event_after_resolution_reinserts(fresh_db):
    conn = open_db(fresh_db)
    eid1, _ = upsert_recon_event(
        conn, timestamp_ms=1000, source="reconciler",
        category="orphan_leg", severity="error",
        exchange="MEXC", symbol="ORDIUSDT",
    )
    resolve_recon_event(conn, eid1, resolution="manual")
    eid2, was_insert2 = upsert_recon_event(
        conn, timestamp_ms=2000, source="reconciler",
        category="orphan_leg", severity="error",
        exchange="MEXC", symbol="ORDIUSDT",
    )
    assert was_insert2 is True
    assert eid2 != eid1
    count = conn.execute("SELECT COUNT(*) FROM reconciliation_events").fetchone()[0]
    assert count == 2
    conn.close()


def test_upsert_recon_event_escalates_severity(fresh_db):
    conn = open_db(fresh_db)
    eid, _ = upsert_recon_event(
        conn, timestamp_ms=1000, source="reconciler",
        category="exchange_unreachable", severity="error", exchange="BLOFIN",
    )
    upsert_recon_event(
        conn, timestamp_ms=2000, source="reconciler",
        category="exchange_unreachable", severity="critical", exchange="BLOFIN",
    )
    row = conn.execute(
        "SELECT severity FROM reconciliation_events WHERE id=?", (eid,)
    ).fetchone()
    assert row["severity"] == "critical"
    conn.close()


def test_upsert_recon_event_never_downgrades_severity(fresh_db):
    """Regression: prior implementation used a CASE WHEN that overwrote
    severity whenever the new severity was 'error' or 'critical', which
    silently downgraded existing 'critical' rows to 'error' on a less
    severe repeat. Verify each direction stays at the maximum severity
    seen for that key."""
    conn = open_db(fresh_db)
    eid, _ = upsert_recon_event(
        conn, timestamp_ms=1000, source="reconciler",
        category="exchange_unreachable", severity="critical", exchange="BLOFIN",
    )
    # Lower-severity repeats must NOT downgrade.
    for low_sev in ("error", "warn", "info"):
        upsert_recon_event(
            conn, timestamp_ms=2000, source="reconciler",
            category="exchange_unreachable", severity=low_sev, exchange="BLOFIN",
        )
        row = conn.execute(
            "SELECT severity FROM reconciliation_events WHERE id=?", (eid,)
        ).fetchone()
        assert row["severity"] == "critical", (
            f"downgraded by {low_sev}: severity={row['severity']}"
        )
    conn.close()


def test_upsert_recon_event_escalates_warn_to_error(fresh_db):
    conn = open_db(fresh_db)
    eid, _ = upsert_recon_event(
        conn, timestamp_ms=1000, source="reconciler",
        category="balance_drift", severity="warn", exchange="MEXC",
    )
    upsert_recon_event(
        conn, timestamp_ms=2000, source="reconciler",
        category="balance_drift", severity="error", exchange="MEXC",
    )
    row = conn.execute(
        "SELECT severity FROM reconciliation_events WHERE id=?", (eid,)
    ).fetchone()
    assert row["severity"] == "error"
    conn.close()


def test_upsert_recon_event_escalates_info_to_warn(fresh_db):
    """Asymmetry fix: info should escalate to warn (prior CASE statement
    silently kept info because 'warn' was not in the escalation set)."""
    conn = open_db(fresh_db)
    eid, _ = upsert_recon_event(
        conn, timestamp_ms=1000, source="reconciler",
        category="balance_drift", severity="info", exchange="MEXC",
    )
    upsert_recon_event(
        conn, timestamp_ms=2000, source="reconciler",
        category="balance_drift", severity="warn", exchange="MEXC",
    )
    row = conn.execute(
        "SELECT severity FROM reconciliation_events WHERE id=?", (eid,)
    ).fetchone()
    assert row["severity"] == "warn"
    conn.close()


def test_upsert_recon_event_distinct_keys_inserts_separately(fresh_db):
    """orphan_leg on MEXC vs orphan_leg on BLOFIN are different conditions."""
    conn = open_db(fresh_db)
    eid1, ins1 = upsert_recon_event(
        conn, timestamp_ms=1000, source="reconciler",
        category="orphan_leg", severity="error", exchange="MEXC",
    )
    eid2, ins2 = upsert_recon_event(
        conn, timestamp_ms=1000, source="reconciler",
        category="orphan_leg", severity="error", exchange="BLOFIN",
    )
    assert ins1 is True and ins2 is True
    assert eid1 != eid2


from state_store import transaction


def test_transaction_commits_on_success(fresh_db):
    conn = open_db(fresh_db)
    with transaction(conn):
        insert_position(conn, **_sample_position(symbol="A", opened_at_ms=1))
        insert_position(conn, **_sample_position(symbol="B", opened_at_ms=2))
    rows = conn.execute("SELECT symbol FROM positions ORDER BY id").fetchall()
    assert {r["symbol"] for r in rows} == {"A", "B"}
    conn.close()


def test_transaction_rolls_back_on_exception(fresh_db):
    conn = open_db(fresh_db)
    with pytest.raises(RuntimeError):
        with transaction(conn):
            insert_position(conn, **_sample_position(symbol="A", opened_at_ms=1))
            raise RuntimeError("boom")
    rows = conn.execute("SELECT symbol FROM positions").fetchall()
    assert len(rows) == 0  # rolled back; nothing committed
    conn.close()


import asyncio
from state_store import AsyncStateStore


def test_async_writer_serializes_writes(fresh_db):
    async def _go():
        store = AsyncStateStore(fresh_db)
        await store.start()
        try:
            # Two concurrent writers, both should succeed without contention
            async def w(symbol, t):
                return await store.insert_position(
                    symbol=symbol, exchange_a="MEXC", exchange_b="BLOFIN",
                    side_a="buy", side_b="sell",
                    size_usd_a=25.0, size_usd_b=25.0,
                    entry_spread_pct=0.01, status="opening", opened_at_ms=t,
                )
            ids = await asyncio.gather(w("A", 1), w("B", 2), w("C", 3))
            assert len(set(ids)) == 3
            opens = await store.list_open_positions()
            assert {p.symbol for p in opens} == {"A", "B", "C"}
        finally:
            await store.stop()

    asyncio.run(_go())
