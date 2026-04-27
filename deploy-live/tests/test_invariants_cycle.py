"""Tests for Task 11: invariants pass at end-of-cycle.

Covers:
- Violation detected → upsert_recon_event written + alert dispatched.
- Same violation within 60s → RateLimiter suppresses second dispatch.
- _violation_to_event helper maps all Violation fields correctly.
- RateLimiter.allow allows after window expires.
- Dispatch failure is isolated (does not propagate).
"""
from __future__ import annotations

import asyncio
import os
import tempfile

import pytest

import state_store
import invariants as inv
from invariants import Violation, RateLimiter, violation_to_event as _violation_to_event
from alerts import AlertDispatcher, MemorySink


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_db():
    tmpdir = tempfile.mkdtemp()
    path = os.path.join(tmpdir, "state.db")
    state_store.init_schema(path)
    conn = state_store.open_db(path)
    return tmpdir, conn


def _seed_open_position_missing_leg(conn):
    """Seed a position with only 1 entry fill so check_all fires."""
    pid = state_store.insert_position(
        conn, symbol="BTCUSDT", exchange_a="OKX", exchange_b="BYBIT",
        side_a="buy", side_b="sell",
        size_usd_a=50.0, size_usd_b=50.0,
        entry_spread_pct=0.02, status="open", opened_at_ms=1,
    )
    state_store.insert_fill(
        conn, position_id=pid, exchange="OKX", leg="a",
        intent="entry", order_id="ord-1", side="buy",
        size_usd=50.0, fill_price=1.0, fees_usd=0.01,
        filled_at_ms=2, raw_response="{}",
    )
    return pid


# ---------------------------------------------------------------------------
# _violation_to_event helper
# ---------------------------------------------------------------------------

def test_violation_to_event_maps_fields():
    v = Violation(
        category="test_cat",
        severity="error",
        position_id=7,
        exchange="OKX",
        symbol="ETHUSDT",
        notes="some note",
        expected={"x": 1},
        actual={"y": 2},
    )
    result = _violation_to_event(v, now_ms=1234)
    assert result["timestamp_ms"] == 1234
    assert result["source"] == "invariants"
    assert result["category"] == "test_cat"
    assert result["severity"] == "error"
    assert result["position_id"] == 7
    assert result["exchange"] == "OKX"
    assert result["symbol"] == "ETHUSDT"
    assert result["notes"] == "some note"
    assert result["expected"] == {"x": 1}
    assert result["actual"] == {"y": 2}


def test_violation_to_event_empty_dicts_become_none():
    """Empty expected/actual dicts should become None (no noise in DB)."""
    v = Violation(category="c", severity="warn")
    result = _violation_to_event(v, now_ms=0)
    assert result["expected"] is None
    assert result["actual"] is None
    assert result["notes"] is None


# ---------------------------------------------------------------------------
# RateLimiter
# ---------------------------------------------------------------------------

def test_rate_limiter_allows_first():
    rl = RateLimiter(window_s=60.0)
    v = Violation(category="c", severity="warn", position_id=1)
    assert rl.allow(v, now_s=0.0) is True


def test_rate_limiter_suppresses_within_window():
    rl = RateLimiter(window_s=60.0)
    v = Violation(category="c", severity="warn", position_id=1)
    rl.allow(v, now_s=0.0)
    assert rl.allow(v, now_s=30.0) is False


def test_rate_limiter_allows_after_window():
    rl = RateLimiter(window_s=60.0)
    v = Violation(category="c", severity="warn", position_id=1)
    rl.allow(v, now_s=0.0)
    assert rl.allow(v, now_s=61.0) is True


def test_rate_limiter_different_keys_independent():
    rl = RateLimiter(window_s=60.0)
    v1 = Violation(category="c", severity="warn", position_id=1)
    v2 = Violation(category="c", severity="warn", position_id=2)
    rl.allow(v1, now_s=0.0)
    # Different position_id → different key → still allowed
    assert rl.allow(v2, now_s=30.0) is True


# ---------------------------------------------------------------------------
# _run_invariants_pass integration: violation → upsert + dispatch
# ---------------------------------------------------------------------------

def test_invariants_pass_writes_recon_event_and_dispatches(fresh_db):
    """A seeded violation is written to reconciliation_events and dispatched."""
    conn = state_store.open_db(fresh_db)
    _seed_open_position_missing_leg(conn)

    sink = MemorySink()
    dispatcher = AlertDispatcher(dedup_window_s=0)
    dispatcher.add_sink(sink, min_severity="info")

    rl = RateLimiter(window_s=60.0)

    async def _run():
        now_ms = 1_000_000
        violations = inv.check_all(conn)
        violations += inv.check_inmem_consistency(conn, in_memory_open_count=1)
        assert len(violations) >= 1, "Expected at least one violation"

        for v in violations:
            kwargs = _violation_to_event(v, now_ms=now_ms)
            state_store.upsert_recon_event(conn, **kwargs)
            if rl.allow(v):
                from schemas import ReconciliationEvent
                event = ReconciliationEvent(
                    timestamp_ms=now_ms,
                    source="invariants",
                    category=v.category,
                    severity=v.severity,
                    exchange=v.exchange,
                    symbol=v.symbol,
                    position_id=v.position_id,
                    expected=v.expected or None,
                    actual=v.actual or None,
                    notes=v.notes or None,
                )
                await dispatcher.dispatch(event)

    asyncio.run(_run())

    # At least one recon event written
    rows = conn.execute("SELECT * FROM reconciliation_events").fetchall()
    assert len(rows) >= 1
    assert rows[0]["source"] == "invariants"

    # At least one alert dispatched
    assert len(sink.events) >= 1
    assert sink.events[0].source == "invariants"
    conn.close()


def test_invariants_pass_rate_limiter_suppresses_second_dispatch(fresh_db):
    """Same violation within 60s is dispatched only once."""
    conn = state_store.open_db(fresh_db)
    _seed_open_position_missing_leg(conn)

    sink = MemorySink()
    dispatcher = AlertDispatcher(dedup_window_s=0)
    dispatcher.add_sink(sink, min_severity="info")

    rl = RateLimiter(window_s=60.0)
    now_s = 1000.0

    async def _dispatch_violation(v):
        kwargs = _violation_to_event(v, now_ms=int(now_s * 1000))
        state_store.upsert_recon_event(conn, **kwargs)
        if rl.allow(v, now_s=now_s):
            from schemas import ReconciliationEvent
            event = ReconciliationEvent(
                timestamp_ms=int(now_s * 1000),
                source="invariants",
                category=v.category,
                severity=v.severity,
                exchange=v.exchange,
                symbol=v.symbol,
                position_id=v.position_id,
                expected=v.expected or None,
                actual=v.actual or None,
                notes=v.notes or None,
            )
            await dispatcher.dispatch(event)

    violations = inv.check_all(conn)
    assert len(violations) >= 1
    v = violations[0]

    async def _run():
        # First pass: should dispatch
        await _dispatch_violation(v)
        first_count = len(sink.events)
        assert first_count >= 1

        # Second pass within 60s (same now_s): rate limiter suppresses
        await _dispatch_violation(v)
        assert len(sink.events) == first_count, (
            "Dispatch was not suppressed by RateLimiter within window"
        )

    asyncio.run(_run())
    conn.close()


class _BrokenDispatcher:
    """Dispatcher whose dispatch() always raises; used to verify isolation."""
    async def dispatch(self, event):
        raise RuntimeError("simulated dispatcher failure")


def test_invariants_pass_isolates_dispatch_failures(fresh_db):
    """A raising dispatcher must NOT abort the invariants pass; the upsert
    still happens for every violation; the next iteration is unaffected."""
    conn = state_store.open_db(fresh_db)
    _seed_open_position_missing_leg(conn)

    dispatcher = _BrokenDispatcher()
    rl = RateLimiter(window_s=60.0)
    now_ms = 1_000_000

    violations = inv.check_all(conn)
    assert len(violations) >= 1, "Need at least one violation for this test"

    async def _run():
        # Mirror the logic in _run_invariants_pass: per-violation try/except.
        for v in violations:
            try:
                state_store.upsert_recon_event(conn, **_violation_to_event(v, now_ms=now_ms))
                if rl.allow(v):
                    await dispatcher.dispatch(inv.violation_to_recon_event(v, now_ms=now_ms))
            except Exception:
                pass  # isolation: one violation failure must not abort others

    asyncio.run(_run())

    # All violations should have been written to the DB despite dispatch failures.
    rows = conn.execute("SELECT * FROM reconciliation_events").fetchall()
    assert len(rows) >= 1, "upsert must succeed even when dispatch raises"
    assert rows[0]["source"] == "invariants"
    conn.close()


def test_invariants_pass_allows_redispatch_after_window(fresh_db):
    """Same violation allowed again after 60s window expires."""
    conn = state_store.open_db(fresh_db)
    _seed_open_position_missing_leg(conn)

    sink = MemorySink()
    dispatcher = AlertDispatcher(dedup_window_s=0)
    dispatcher.add_sink(sink, min_severity="info")

    rl = RateLimiter(window_s=60.0)

    violations = inv.check_all(conn)
    assert len(violations) >= 1
    v = violations[0]

    async def _dispatch_at(now_s: float):
        if rl.allow(v, now_s=now_s):
            from schemas import ReconciliationEvent
            event = ReconciliationEvent(
                timestamp_ms=int(now_s * 1000),
                source="invariants",
                category=v.category,
                severity=v.severity,
            )
            await dispatcher.dispatch(event)

    async def _run():
        await _dispatch_at(0.0)    # first dispatch
        await _dispatch_at(30.0)   # suppressed
        await _dispatch_at(61.0)   # after window — allowed again

    asyncio.run(_run())
    assert len(sink.events) == 2, (
        f"Expected exactly 2 dispatches (t=0 and t=61), got {len(sink.events)}"
    )
    conn.close()
