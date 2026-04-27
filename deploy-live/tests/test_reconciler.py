import asyncio

import pytest
from reconciler import ExchangeFetcher, FakeExchange


def test_fake_exchange_satisfies_protocol():
    async def _go():
        fake = FakeExchange()
        fake.set_open_positions("MEXC", [
            {"symbol": "ORDIUSDT", "side": "buy", "size_usd": 25.0}
        ])
        fake.set_balance("MEXC", available_usd=49.5, locked_usd=0.5)
        fake.set_recent_fills("MEXC", [
            {"order_id": "m-1", "symbol": "ORDIUSDT", "side": "buy",
             "size_usd": 25.0, "fill_price": 1.234, "fees_usd": 0.01,
             "filled_at_ms": 1700000000500},
        ])

        # Protocol-style structural typing — FakeExchange is_a ExchangeFetcher
        fetcher: ExchangeFetcher = fake

        pos = await fetcher.get_open_positions("MEXC")
        assert len(pos) == 1
        assert pos[0]["symbol"] == "ORDIUSDT"

        bal = await fetcher.get_balance("MEXC")
        assert bal["available_usd"] == 49.5

        fills = await fetcher.get_recent_fills("MEXC", since_ms=0)
        assert len(fills) == 1
    asyncio.run(_go())


def test_fake_exchange_unreachable():
    async def _go():
        fake = FakeExchange()
        fake.set_unreachable("BLOFIN", error="connection refused")
        fetcher: ExchangeFetcher = fake
        with pytest.raises(ConnectionError):
            await fetcher.get_open_positions("BLOFIN")
        with pytest.raises(ConnectionError):
            await fetcher.get_balance("BLOFIN")
        with pytest.raises(ConnectionError):
            await fetcher.get_recent_fills("BLOFIN", since_ms=0)
    asyncio.run(_go())


def test_fake_exchange_get_recent_fills_filters_by_since():
    async def _go():
        fake = FakeExchange()
        fake.set_recent_fills("MEXC", [
            {"order_id": "o1", "filled_at_ms": 100},
            {"order_id": "o2", "filled_at_ms": 200},
            {"order_id": "o3", "filled_at_ms": 300},
        ])
        fetcher: ExchangeFetcher = fake
        fills = await fetcher.get_recent_fills("MEXC", since_ms=150)
        assert {f["order_id"] for f in fills} == {"o2", "o3"}
    asyncio.run(_go())


from state_store import (
    open_db, init_schema, insert_position, insert_fill, snapshot_balance,
    list_unresolved_recon_events,
)
from reconciler import reconcile_exchange


def _seed_position_with_fill(conn, exchange_b="BLOFIN"):
    pid = insert_position(
        conn, symbol="ORDIUSDT",
        exchange_a="MEXC", exchange_b=exchange_b,
        side_a="buy", side_b="sell",
        size_usd_a=25.0, size_usd_b=25.0,
        entry_spread_pct=0.012, status="open", opened_at_ms=1700000000000,
    )
    insert_fill(
        conn, position_id=pid, exchange="MEXC", leg="a", intent="entry",
        order_id="m-1", side="buy", size_usd=25.0, fill_price=1.234,
        fees_usd=0.01, filled_at_ms=1700000000500, raw_response="{}",
    )
    return pid


def test_reconcile_phantom_position(fresh_db):
    """Exchange has a position the bot doesn't know about."""
    conn = open_db(fresh_db)
    fake = FakeExchange()
    fake.set_open_positions("MEXC", [
        {"symbol": "PEPEUSDT", "side": "buy", "size_usd": 25.0}
    ])
    fake.set_balance("MEXC", available_usd=50.0)
    fake.set_recent_fills("MEXC", [])
    asyncio.run(reconcile_exchange(conn, fake, exchange="MEXC", since_ms=0))
    events = list_unresolved_recon_events(conn)
    cats = [e.category for e in events]
    assert "phantom_position" in cats
    conn.close()


def test_reconcile_orphan_leg(fresh_db):
    """state_store thinks position is open on BLOFIN; exchange shows nothing."""
    conn = open_db(fresh_db)
    _seed_position_with_fill(conn)
    fake = FakeExchange()
    fake.set_open_positions("BLOFIN", [])  # exchange shows no positions
    fake.set_balance("BLOFIN", available_usd=50.0)
    fake.set_recent_fills("BLOFIN", [])
    asyncio.run(reconcile_exchange(conn, fake, exchange="BLOFIN", since_ms=0))
    events = list_unresolved_recon_events(conn)
    cats = [e.category for e in events]
    assert "orphan_leg" in cats
    conn.close()


def test_reconcile_size_mismatch(fresh_db):
    """state_store has size 25; exchange shows size 12."""
    conn = open_db(fresh_db)
    _seed_position_with_fill(conn, exchange_b="BLOFIN")
    fake = FakeExchange()
    fake.set_open_positions("BLOFIN", [
        {"symbol": "ORDIUSDT", "side": "sell", "size_usd": 12.0},
    ])
    fake.set_balance("BLOFIN", available_usd=38.0)
    fake.set_recent_fills("BLOFIN", [])
    asyncio.run(reconcile_exchange(conn, fake, exchange="BLOFIN", since_ms=0))
    events = list_unresolved_recon_events(conn)
    cats = [e.category for e in events]
    assert "size_mismatch" in cats
    conn.close()


def test_reconcile_balance_drift_warn(fresh_db):
    """Bot's last balance snapshot says 50; exchange now says 30 (40% drift)."""
    conn = open_db(fresh_db)
    snapshot_balance(conn, exchange="MEXC", asset="USDT",
                     available_usd=50.0, locked_usd=0.0, snapshot_at_ms=100)
    fake = FakeExchange()
    fake.set_open_positions("MEXC", [])
    fake.set_balance("MEXC", available_usd=30.0, locked_usd=0.0)
    fake.set_recent_fills("MEXC", [])
    asyncio.run(reconcile_exchange(conn, fake, exchange="MEXC", since_ms=0))
    events = list_unresolved_recon_events(conn)
    drift = [e for e in events if e.category == "balance_drift"]
    assert len(drift) == 1
    assert drift[0].severity == "warn"
    conn.close()


def test_reconcile_balance_drift_info_within_rounding(fresh_db):
    """Drift of $0.50 on a $50 balance is < $1 AND < 1% — info severity."""
    conn = open_db(fresh_db)
    snapshot_balance(conn, exchange="MEXC", asset="USDT",
                     available_usd=50.0, locked_usd=0.0, snapshot_at_ms=100)
    fake = FakeExchange()
    fake.set_open_positions("MEXC", [])
    fake.set_balance("MEXC", available_usd=49.5, locked_usd=0.0)
    fake.set_recent_fills("MEXC", [])
    asyncio.run(reconcile_exchange(conn, fake, exchange="MEXC", since_ms=0))
    events = list_unresolved_recon_events(conn)
    drift = [e for e in events if e.category == "balance_drift"]
    assert len(drift) == 1
    assert drift[0].severity == "info"
    conn.close()


def test_reconcile_unlinked_fill(fresh_db):
    """Exchange returned a fill we can't tie to any position in state_store."""
    conn = open_db(fresh_db)
    fake = FakeExchange()
    fake.set_open_positions("MEXC", [])
    fake.set_balance("MEXC", available_usd=50.0)
    fake.set_recent_fills("MEXC", [
        {"order_id": "stranger-1", "symbol": "WIFUSDT", "side": "buy",
         "size_usd": 25.0, "fill_price": 1.0, "fees_usd": 0.01,
         "filled_at_ms": 1700000000500},
    ])
    asyncio.run(reconcile_exchange(conn, fake, exchange="MEXC", since_ms=0))
    events = list_unresolved_recon_events(conn)
    cats = [e.category for e in events]
    assert "unlinked_fill" in cats
    conn.close()


def test_reconcile_clean_state_writes_no_events(fresh_db):
    """When state_store and exchange agree, no events are written."""
    conn = open_db(fresh_db)
    _seed_position_with_fill(conn, exchange_b="BLOFIN")
    snapshot_balance(conn, exchange="BLOFIN", asset="USDT",
                     available_usd=25.0, locked_usd=0.0, snapshot_at_ms=100)
    fake = FakeExchange()
    fake.set_open_positions("BLOFIN", [
        {"symbol": "ORDIUSDT", "side": "sell", "size_usd": 25.0},
    ])
    fake.set_balance("BLOFIN", available_usd=25.0, locked_usd=0.0)
    fake.set_recent_fills("BLOFIN", [])
    asyncio.run(reconcile_exchange(conn, fake, exchange="BLOFIN", since_ms=0))
    events = list_unresolved_recon_events(conn)
    assert events == []
    conn.close()


from state_store import get_exchange_health


def test_exchange_health_marked_ok_on_success(fresh_db):
    conn = open_db(fresh_db)
    fake = FakeExchange()
    fake.set_open_positions("MEXC", [])
    fake.set_balance("MEXC", available_usd=50.0)
    fake.set_recent_fills("MEXC", [])
    asyncio.run(reconcile_exchange(conn, fake, exchange="MEXC", since_ms=0))
    h = get_exchange_health(conn, "MEXC")
    assert h.status == "ok"
    assert h.consecutive_errors == 0
    assert h.last_ok_at_ms is not None
    conn.close()


def test_exchange_health_marked_degraded_on_first_failure(fresh_db):
    conn = open_db(fresh_db)
    fake = FakeExchange()
    fake.set_unreachable("BLOFIN", error="connection refused")
    asyncio.run(reconcile_exchange(conn, fake, exchange="BLOFIN", since_ms=0))
    h = get_exchange_health(conn, "BLOFIN")
    assert h.status == "degraded"
    assert h.consecutive_errors == 1
    conn.close()


def test_exchange_health_marked_down_after_three_failures(fresh_db):
    conn = open_db(fresh_db)
    fake = FakeExchange()
    fake.set_unreachable("BLOFIN", error="timeout")
    for _ in range(3):
        asyncio.run(reconcile_exchange(conn, fake, exchange="BLOFIN", since_ms=0))
    h = get_exchange_health(conn, "BLOFIN")
    assert h.status == "down"
    assert h.consecutive_errors == 3
    # The 3rd failure should have written a critical event
    events = list_unresolved_recon_events(conn, min_severity="critical")
    assert any(e.category == "exchange_unreachable" for e in events)
    conn.close()


def test_unchecked_exchange_event_emitted_on_unreachable(fresh_db):
    """When an exchange is unreachable, the diff checks are silently skipped.
    The reconciler emits an info-severity unchecked_exchange event so the
    gap is visible to operators monitoring for outages-that-mask-issues."""
    conn = open_db(fresh_db)
    fake = FakeExchange()
    fake.set_unreachable("BLOFIN", error="connection refused")
    asyncio.run(reconcile_exchange(conn, fake, exchange="BLOFIN", since_ms=0))
    events = list_unresolved_recon_events(conn, min_severity="info")
    cats = [e.category for e in events]
    assert "exchange_unreachable" in cats
    assert "unchecked_exchange" in cats
    unchecked = next(e for e in events if e.category == "unchecked_exchange")
    assert unchecked.severity == "info"
    assert unchecked.exchange == "BLOFIN"
    conn.close()


def test_exchange_health_recovers_after_failure(fresh_db):
    conn = open_db(fresh_db)
    fake = FakeExchange()
    fake.set_unreachable("BLOFIN", error="timeout")
    asyncio.run(reconcile_exchange(conn, fake, exchange="BLOFIN", since_ms=0))
    # Now exchange comes back
    fake._unreachable.pop("BLOFIN")
    fake.set_open_positions("BLOFIN", [])
    fake.set_balance("BLOFIN", available_usd=50.0)
    fake.set_recent_fills("BLOFIN", [])
    asyncio.run(reconcile_exchange(conn, fake, exchange="BLOFIN", since_ms=0))
    h = get_exchange_health(conn, "BLOFIN")
    assert h.status == "ok"
    assert h.consecutive_errors == 0
    conn.close()


from reconciler import start_periodic_sweep


def test_periodic_sweep_runs_reconcile_for_each_exchange(fresh_db):
    async def _go():
        conn = open_db(fresh_db)
        fake = FakeExchange()
        for ex in ("MEXC", "BLOFIN", "OKX", "BYBIT"):
            fake.set_open_positions(ex, [])
            fake.set_balance(ex, available_usd=50.0)
            fake.set_recent_fills(ex, [])

        task = start_periodic_sweep(
            conn, fake, exchanges=["MEXC", "BLOFIN", "OKX", "BYBIT"],
            interval_s=0.05,
        )
        await asyncio.sleep(0.18)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

        for ex in ("MEXC", "BLOFIN", "OKX", "BYBIT"):
            h = get_exchange_health(conn, ex)
            assert h is not None
            assert h.status == "ok"
        conn.close()

    asyncio.run(_go())


def test_periodic_sweep_survives_one_exchange_failure(fresh_db):
    async def _go():
        conn = open_db(fresh_db)
        fake = FakeExchange()
        fake.set_open_positions("MEXC", [])
        fake.set_balance("MEXC", available_usd=50.0)
        fake.set_recent_fills("MEXC", [])
        fake.set_unreachable("BLOFIN", error="conn reset")

        task = start_periodic_sweep(
            conn, fake, exchanges=["MEXC", "BLOFIN"], interval_s=0.05,
        )
        await asyncio.sleep(0.18)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

        assert get_exchange_health(conn, "MEXC").status == "ok"
        assert get_exchange_health(conn, "BLOFIN").status == "down"
        conn.close()

    asyncio.run(_go())


from reconciler import schedule_per_trade_reconcile


def test_per_trade_reconcile_runs_async(fresh_db):
    async def _go():
        conn = open_db(fresh_db)
        fake = FakeExchange()
        fake.set_open_positions("MEXC", [
            {"symbol": "ORDIUSDT", "side": "buy", "size_usd": 25.0},
        ])
        fake.set_balance("MEXC", available_usd=25.0)
        fake.set_recent_fills("MEXC", [])

        task = schedule_per_trade_reconcile(
            conn, fake, exchange="MEXC", symbol="ORDIUSDT",
        )
        await asyncio.wait_for(task, timeout=2.0)
        assert get_exchange_health(conn, "MEXC").status == "ok"
        conn.close()

    asyncio.run(_go())


def test_per_trade_reconcile_does_not_raise_on_failure(fresh_db):
    """Even if the reconcile call fails internally, the helper completes cleanly."""
    async def _go():
        conn = open_db(fresh_db)
        fake = FakeExchange()
        fake.set_unreachable("BLOFIN", error="timeout")

        task = schedule_per_trade_reconcile(
            conn, fake, exchange="BLOFIN", symbol="ORDIUSDT",
        )
        await asyncio.wait_for(task, timeout=2.0)
        assert get_exchange_health(conn, "BLOFIN").status == "degraded"
        conn.close()

    asyncio.run(_go())
