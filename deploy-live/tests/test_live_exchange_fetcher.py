"""Tests for LiveExchangeFetcher.

All fetcher methods are now async. Tests use asyncio.run() to drive them,
matching the project's established pattern (pytest-asyncio is not installed).
No background_loop fixture is needed — the old sync/threadsafe bridge is gone.
"""
import asyncio
import pytest

from live_exchange_fetcher import LiveExchangeFetcher


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


class FakeExecutor:
    """Async stand-in for ExchangeExecutor with knobs for failure injection."""

    def __init__(self, *, balance=None, positions=None, raise_=None):
        self.balance = balance or {"available": 100.0, "locked": 0.0}
        self.positions = positions or []
        self.raise_ = raise_
        self.balance_calls = 0
        self.positions_calls = 0

    async def get_balance(self):
        self.balance_calls += 1
        if self.raise_:
            raise self.raise_
        return self.balance

    async def get_open_positions(self):
        self.positions_calls += 1
        if self.raise_:
            raise self.raise_
        return self.positions


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_get_balance_translates_keys():
    async def _go():
        ex = FakeExecutor(balance={"available": 175.5, "locked": 24.5})
        fetcher = LiveExchangeFetcher({"OKX": ex})
        bal = await fetcher.get_balance("OKX")
        assert bal == {"available_usd": 175.5, "locked_usd": 24.5}
        assert ex.balance_calls == 1
    asyncio.run(_go())


def test_get_open_positions_okx_normalizes():
    async def _go():
        ex = FakeExecutor(positions=[
            {"instId": "BTC-USDT-SWAP", "posSide": "long", "notionalUsd": "25.5"},
            {"instId": "ETH-USDT-SWAP", "posSide": "short", "notionalUsd": "12.0"},
        ])
        fetcher = LiveExchangeFetcher({"OKX": ex})
        pos = await fetcher.get_open_positions("OKX")
        assert pos == [
            {"symbol": "BTCUSDT", "side": "buy", "size_usd": 25.5},
            {"symbol": "ETHUSDT", "side": "sell", "size_usd": 12.0},
        ]
    asyncio.run(_go())


def test_get_open_positions_bybit_normalizes():
    async def _go():
        ex = FakeExecutor(positions=[
            {"symbol": "BTCUSDT", "side": "Buy", "positionValue": "30.0"},
        ])
        fetcher = LiveExchangeFetcher({"Bybit": ex})
        pos = await fetcher.get_open_positions("Bybit")
        assert pos == [{"symbol": "BTCUSDT", "side": "buy", "size_usd": 30.0}]
    asyncio.run(_go())


def test_get_open_positions_mexc_normalizes():
    async def _go():
        ex = FakeExecutor(positions=[
            {"symbol": "BTC_USDT", "positionType": 1, "positionValue": "20.0"},
            {"symbol": "ETH_USDT", "positionType": 2, "positionValue": "15.0"},
        ])
        fetcher = LiveExchangeFetcher({"MEXC": ex})
        pos = await fetcher.get_open_positions("MEXC")
        assert pos == [
            {"symbol": "BTCUSDT", "side": "buy", "size_usd": 20.0},
            {"symbol": "ETHUSDT", "side": "sell", "size_usd": 15.0},
        ]
    asyncio.run(_go())


def test_get_open_positions_blofin_normalizes():
    async def _go():
        ex = FakeExecutor(positions=[
            {"instId": "BTC-USDT", "positionSide": "short", "notionalUsd": "18.0"},
        ])
        fetcher = LiveExchangeFetcher({"BloFin": ex})
        pos = await fetcher.get_open_positions("BloFin")
        assert pos == [{"symbol": "BTCUSDT", "side": "sell", "size_usd": 18.0}]
    asyncio.run(_go())


def test_get_open_positions_skips_unparseable_rows():
    async def _go():
        ex = FakeExecutor(positions=[
            {"instId": "BTC-USDT-SWAP", "posSide": "long", "notionalUsd": "25.5"},
            {"instId": "BAD", "posSide": "sideways", "notionalUsd": "5"},  # invalid side
            {"instId": "ETH-USDT-SWAP", "posSide": "short", "notionalUsd": "0"},  # zero size
        ])
        fetcher = LiveExchangeFetcher({"OKX": ex})
        pos = await fetcher.get_open_positions("OKX")
        assert pos == [{"symbol": "BTCUSDT", "side": "buy", "size_usd": 25.5}]
    asyncio.run(_go())


def test_get_recent_fills_returns_empty_for_now():
    """Documented limitation; reconciler unlinked_fill check no-ops in production."""
    async def _go():
        ex = FakeExecutor()
        fetcher = LiveExchangeFetcher({"OKX": ex})
        assert await fetcher.get_recent_fills("OKX", since_ms=0) == []
    asyncio.run(_go())


# ---------------------------------------------------------------------------
# Failure paths
# ---------------------------------------------------------------------------


def test_unknown_exchange_raises_connection_error():
    async def _go():
        fetcher = LiveExchangeFetcher({})
        with pytest.raises(ConnectionError):
            await fetcher.get_balance("OKX")
    asyncio.run(_go())


def test_executor_timeout_translates_to_connection_error():
    async def _go():
        ex = FakeExecutor(raise_=asyncio.TimeoutError())
        fetcher = LiveExchangeFetcher({"OKX": ex})
        with pytest.raises(ConnectionError):
            await fetcher.get_balance("OKX")
    asyncio.run(_go())


def test_executor_oserror_translates_to_connection_error():
    async def _go():
        ex = FakeExecutor(raise_=OSError("network unreachable"))
        fetcher = LiveExchangeFetcher({"OKX": ex})
        with pytest.raises(ConnectionError):
            await fetcher.get_open_positions("OKX")
    asyncio.run(_go())


def test_executor_programming_error_propagates():
    """KeyError isn't a network error; it should not be wrapped as ConnectionError."""
    async def _go():
        ex = FakeExecutor(raise_=KeyError("missing config"))
        fetcher = LiveExchangeFetcher({"OKX": ex})
        with pytest.raises(KeyError):
            await fetcher.get_balance("OKX")
    asyncio.run(_go())


def test_no_normalizer_for_unknown_exchange_returns_empty():
    async def _go():
        ex = FakeExecutor(positions=[{"foo": "bar"}])
        fetcher = LiveExchangeFetcher({"WeirdEx": ex})
        # The fetcher will call the executor (unknown exchanges still get queried)
        # but normalize will return empty since there's no registered normalizer.
        pos = await fetcher.get_open_positions("WeirdEx")
        assert pos == []
        assert ex.positions_calls == 1
    asyncio.run(_go())


# ---------------------------------------------------------------------------
# Production wiring shape: no deadlock when fetcher runs on same loop
# ---------------------------------------------------------------------------


def test_production_wiring_no_deadlock_same_loop():
    """Regression: the old sync+run_coroutine_threadsafe design deadlocked when
    fetcher methods were called from within the trader's asyncio loop (the same
    loop that runs the reconciler). This test constructs the fetcher without a
    loop arg, calls its async methods directly on the running loop, and asserts
    the whole cycle completes within 1s — proving no deadlock.

    This test would hang indefinitely under the old sync bridge.
    """
    import tempfile
    import os
    from state_store import open_db, init_schema, get_exchange_health
    from reconciler import reconcile_exchange

    async def _go():
        ex = FakeExecutor(
            balance={"available": 1000.0, "locked": 0.0},
            positions=[
                {"instId": "BTC-USDT-SWAP", "posSide": "long", "notionalUsd": "100.0"},
            ],
        )
        fetcher = LiveExchangeFetcher({"OKX": ex})

        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "state.db")
            init_schema(db_path)
            conn = open_db(db_path)

            # Run a full reconcile cycle on the SAME asyncio loop — this is exactly
            # the production path that deadlocked with the old sync bridge.
            await asyncio.wait_for(
                reconcile_exchange(conn, fetcher, exchange="OKX", since_ms=0),
                timeout=1.0,
            )

            health = get_exchange_health(conn, "OKX")
            assert health is not None
            assert health.status == "ok"
            conn.close()

    asyncio.run(_go())
