import time

from state_store import (
    open_db, init_schema, insert_position, insert_fill,
)
from invariants import check_all, Violation


def _seed_open_position(conn, symbol="ORDIUSDT", opened_at_ms=1, status="open"):
    return insert_position(
        conn, symbol=symbol, exchange_a="MEXC", exchange_b="BLOFIN",
        side_a="buy", side_b="sell",
        size_usd_a=25.0, size_usd_b=25.0,
        entry_spread_pct=0.012, status=status, opened_at_ms=opened_at_ms,
    )


def _seed_fill(conn, position_id, exchange="MEXC", leg="a",
               intent="entry", order_id="ord-1", side="buy",
               size_usd=25.0, fill_price=1.234, filled_at_ms=2):
    return insert_fill(
        conn, position_id=position_id, exchange=exchange, leg=leg,
        intent=intent, order_id=order_id, side=side,
        size_usd=size_usd, fill_price=fill_price, fees_usd=0.01,
        filled_at_ms=filled_at_ms, raw_response="{}",
    )


# Invariant 1

def test_invariant_open_position_has_two_entry_fills_violation(fresh_db):
    conn = open_db(fresh_db)
    pid = _seed_open_position(conn)
    _seed_fill(conn, pid, exchange="MEXC", leg="a", order_id="m-1")
    violations = check_all(conn)
    cats = [v.category for v in violations]
    assert "open_position_missing_legs" in cats
    conn.close()


def test_invariant_open_position_has_two_entry_fills_passes(fresh_db):
    conn = open_db(fresh_db)
    pid = _seed_open_position(conn)
    _seed_fill(conn, pid, exchange="MEXC", leg="a", order_id="m-1")
    _seed_fill(conn, pid, exchange="BLOFIN", leg="b", side="sell",
               order_id="b-1", filled_at_ms=3)
    violations = check_all(conn)
    cats = [v.category for v in violations]
    assert "open_position_missing_legs" not in cats
    conn.close()


# Invariant 2

def test_invariant_closed_position_missing_exit_fills(fresh_db):
    conn = open_db(fresh_db)
    pid = _seed_open_position(conn, status="closed")
    _seed_fill(conn, pid, exchange="MEXC", leg="a", intent="entry",
               order_id="m-1")
    _seed_fill(conn, pid, exchange="BLOFIN", leg="b", intent="entry",
               side="sell", order_id="b-1", filled_at_ms=3)
    violations = check_all(conn)
    cats = [v.category for v in violations]
    assert "closed_position_missing_exit_fills" in cats
    conn.close()


# Invariant 3

def test_invariant_fill_quality_via_constraint_already_enforced(fresh_db):
    """The schema's CHECK constraints already prevent zero values, so we just
    verify check_all() doesn't crash on a healthy DB."""
    conn = open_db(fresh_db)
    pid = _seed_open_position(conn)
    _seed_fill(conn, pid, exchange="MEXC", leg="a", order_id="m-1")
    _seed_fill(conn, pid, exchange="BLOFIN", leg="b", side="sell",
               order_id="b-1", filled_at_ms=3)
    violations = check_all(conn)
    bad_fill_violations = [v for v in violations if v.category == "fill_quality"]
    assert bad_fill_violations == []
    conn.close()


def test_invariant_no_overlapping_open_positions(fresh_db):
    """Invariant 4: no two open positions on same (symbol, exchange, side)."""
    conn = open_db(fresh_db)
    insert_position(
        conn, symbol="ORDIUSDT",
        exchange_a="MEXC", exchange_b="BLOFIN",
        side_a="buy", side_b="sell",
        size_usd_a=25.0, size_usd_b=25.0,
        entry_spread_pct=0.01, status="open", opened_at_ms=1,
    )
    insert_position(
        conn, symbol="ORDIUSDT",
        exchange_a="MEXC", exchange_b="OKX",
        side_a="buy", side_b="sell",  # same MEXC buy
        size_usd_a=25.0, size_usd_b=25.0,
        entry_spread_pct=0.01, status="open", opened_at_ms=2,
    )
    violations = check_all(conn)
    cats = [v.category for v in violations]
    assert "overlapping_open_positions" in cats
    conn.close()


def test_invariant_aged_open_position(fresh_db):
    """Invariant 5: open position older than max_hold_minutes + 5 (35 min)."""
    conn = open_db(fresh_db)
    too_old_ms = int(time.time() * 1000) - 36 * 60 * 1000
    insert_position(
        conn, symbol="STALEUSDT",
        exchange_a="MEXC", exchange_b="BLOFIN",
        side_a="buy", side_b="sell",
        size_usd_a=25.0, size_usd_b=25.0,
        entry_spread_pct=0.01, status="open", opened_at_ms=too_old_ms,
    )
    violations = check_all(conn)
    cats = [v.category for v in violations]
    assert "aged_open_position" in cats
    conn.close()


def test_invariant_aged_open_position_within_limit_passes(fresh_db):
    conn = open_db(fresh_db)
    fresh_ms = int(time.time() * 1000) - 5 * 60 * 1000  # 5 min old
    insert_position(
        conn, symbol="FRESHUSDT",
        exchange_a="MEXC", exchange_b="BLOFIN",
        side_a="buy", side_b="sell",
        size_usd_a=25.0, size_usd_b=25.0,
        entry_spread_pct=0.01, status="open", opened_at_ms=fresh_ms,
    )
    violations = check_all(conn)
    cats = [v.category for v in violations]
    assert "aged_open_position" not in cats
    conn.close()


def test_invariant_stuck_transition(fresh_db):
    """Invariant 6: position stuck in 'opening' or 'closing' for > 60s."""
    conn = open_db(fresh_db)
    stuck_ms = int(time.time() * 1000) - 120_000  # 2 minutes ago
    insert_position(
        conn, symbol="STUCKUSDT",
        exchange_a="MEXC", exchange_b="BLOFIN",
        side_a="buy", side_b="sell",
        size_usd_a=25.0, size_usd_b=25.0,
        entry_spread_pct=0.01, status="opening", opened_at_ms=stuck_ms,
    )
    violations = check_all(conn)
    cats = [v.category for v in violations]
    assert "stuck_transition" in cats
    conn.close()


from state_store import write_audit
from invariants import check_inmem_consistency


def test_invariant_audit_orphan_position_id(fresh_db):
    """Invariant 7: audit_log entry references a position that doesn't exist."""
    conn = open_db(fresh_db)
    pid = _seed_open_position(conn)
    write_audit(conn, timestamp_ms=1, event_type="entry_attempt",
                severity="info", message="ok", position_id=pid)
    try:
        conn.execute("PRAGMA foreign_keys=OFF")
        conn.execute(
            "INSERT INTO audit_log (timestamp, event_type, severity, position_id, message) "
            "VALUES (?, ?, ?, ?, ?)",
            (2, "x", "info", 99999, "orphan"),
        )
        conn.execute("PRAGMA foreign_keys=ON")
        violations = check_all(conn)
        cats = [v.category for v in violations]
        assert "audit_orphan_position_id" in cats
    finally:
        conn.close()


def test_invariant_fill_orphan_position_id(fresh_db):
    """Invariant 8: a fill row referencing a non-existent position."""
    conn = open_db(fresh_db)
    try:
        conn.execute("PRAGMA foreign_keys=OFF")
        conn.execute(
            """INSERT INTO fills
               (position_id, exchange, leg, intent, order_id, side,
                size_usd, fill_price, fees_usd, filled_at, raw_response)
               VALUES (99999, 'MEXC', 'a', 'entry', 'orphan-1', 'buy',
                       25.0, 1.0, 0.01, 1, '{}')"""
        )
        conn.execute("PRAGMA foreign_keys=ON")
        violations = check_all(conn)
        cats = [v.category for v in violations]
        assert "fill_orphan_position_id" in cats
    finally:
        conn.close()


def test_invariant_inmem_match_passes(fresh_db):
    """Invariant 9: in-memory count matches DB count."""
    conn = open_db(fresh_db)
    _seed_open_position(conn, symbol="A", opened_at_ms=1)
    _seed_open_position(conn, symbol="B", opened_at_ms=2)
    violations = check_inmem_consistency(conn, in_memory_open_count=2)
    assert violations == []
    conn.close()


def test_invariant_inmem_match_violation(fresh_db):
    conn = open_db(fresh_db)
    _seed_open_position(conn, symbol="A", opened_at_ms=1)
    _seed_open_position(conn, symbol="B", opened_at_ms=2)
    violations = check_inmem_consistency(conn, in_memory_open_count=5)
    cats = [v.category for v in violations]
    assert "inmem_db_count_mismatch" in cats
    conn.close()


from state_store import (
    snapshot_balance, write_recon_event, upsert_exchange_health,
)


def test_invariant_exposure_exceeds_balance(fresh_db):
    """Invariant 10: per-exchange open size > available + locked."""
    conn = open_db(fresh_db)
    insert_position(
        conn, symbol="OVERUSDT", exchange_a="MEXC", exchange_b="BLOFIN",
        side_a="buy", side_b="sell", size_usd_a=25.0, size_usd_b=25.0,
        entry_spread_pct=0.01, status="open", opened_at_ms=1,
    )
    snapshot_balance(conn, exchange="MEXC", asset="USDT",
                     available_usd=10.0, locked_usd=0.0, snapshot_at_ms=2)
    violations = check_all(conn)
    cats = [v.category for v in violations]
    assert "exposure_exceeds_balance" in cats
    conn.close()


def test_invariant_unresolved_recon_event_too_old(fresh_db):
    """Invariant 11: unresolved recon_event older than 30 min."""
    conn = open_db(fresh_db)
    too_old_ms = int(time.time() * 1000) - 31 * 60 * 1000
    write_recon_event(
        conn, timestamp_ms=too_old_ms, source="reconciler",
        category="orphan_leg", severity="error",
        exchange="MEXC", symbol="OLDUSDT",
    )
    violations = check_all(conn)
    cats = [v.category for v in violations]
    assert "stale_unresolved_recon_event" in cats
    conn.close()


def test_invariant_exchange_health_stale_ok_status(fresh_db):
    """Invariant 12: exchange marked 'ok' but no last_ok_at_ms in last 5 min."""
    conn = open_db(fresh_db)
    stale_ms = int(time.time() * 1000) - 6 * 60 * 1000
    upsert_exchange_health(
        conn, exchange="OKX", status="ok",
        last_ok_at_ms=stale_ms, consecutive_errors=0,
    )
    violations = check_all(conn)
    cats = [v.category for v in violations]
    assert "stale_ok_exchange_health" in cats
    conn.close()


def test_invariant_exchange_health_stale_ok_status_passes_when_fresh(fresh_db):
    conn = open_db(fresh_db)
    fresh_ms = int(time.time() * 1000) - 60 * 1000  # 1 min ago
    upsert_exchange_health(
        conn, exchange="OKX", status="ok",
        last_ok_at_ms=fresh_ms, consecutive_errors=0,
    )
    violations = check_all(conn)
    cats = [v.category for v in violations]
    assert "stale_ok_exchange_health" not in cats
    conn.close()


from invariants import RateLimiter


def test_rate_limiter_suppresses_repeat_within_window():
    rl = RateLimiter(window_s=60.0)
    v = Violation(category="orphan_leg", severity="error", position_id=42)
    assert rl.allow(v, now_s=1000.0) is True
    assert rl.allow(v, now_s=1030.0) is False  # within window
    assert rl.allow(v, now_s=1061.0) is True  # window expired


def test_rate_limiter_allows_different_categories_independently():
    rl = RateLimiter(window_s=60.0)
    v1 = Violation(category="orphan_leg", severity="error", position_id=42)
    v2 = Violation(category="size_mismatch", severity="warn", position_id=42)
    v3 = Violation(category="orphan_leg", severity="error", position_id=43)
    assert rl.allow(v1, now_s=1000.0) is True
    assert rl.allow(v2, now_s=1000.0) is True  # different category
    assert rl.allow(v3, now_s=1000.0) is True  # different position_id
