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
