"""Tests for LiveExchangeFetcher.

Spins up a real asyncio loop on a background thread and verifies that
the fetcher's sync API correctly bridges into the loop and back, including
ConnectionError translation when executors fail.
"""
import asyncio
import threading
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


@pytest.fixture
def background_loop():
    """A real asyncio loop running on a background thread for the test's lifetime."""
    loop = asyncio.new_event_loop()
    ready = threading.Event()

    def _run():
        asyncio.set_event_loop(loop)
        ready.set()
        loop.run_forever()

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    ready.wait(timeout=2)
    yield loop
    loop.call_soon_threadsafe(loop.stop)
    t.join(timeout=2)
    loop.close()


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_get_balance_translates_keys(background_loop):
    ex = FakeExecutor(balance={"available": 175.5, "locked": 24.5})
    fetcher = LiveExchangeFetcher({"OKX": ex}, loop=background_loop)
    bal = fetcher.get_balance("OKX")
    assert bal == {"available_usd": 175.5, "locked_usd": 24.5}
    assert ex.balance_calls == 1


def test_get_open_positions_okx_normalizes(background_loop):
    ex = FakeExecutor(positions=[
        {"instId": "BTC-USDT-SWAP", "posSide": "long", "notionalUsd": "25.5"},
        {"instId": "ETH-USDT-SWAP", "posSide": "short", "notionalUsd": "12.0"},
    ])
    fetcher = LiveExchangeFetcher({"OKX": ex}, loop=background_loop)
    pos = fetcher.get_open_positions("OKX")
    assert pos == [
        {"symbol": "BTCUSDT", "side": "buy", "size_usd": 25.5},
        {"symbol": "ETHUSDT", "side": "sell", "size_usd": 12.0},
    ]


def test_get_open_positions_bybit_normalizes(background_loop):
    ex = FakeExecutor(positions=[
        {"symbol": "BTCUSDT", "side": "Buy", "positionValue": "30.0"},
    ])
    fetcher = LiveExchangeFetcher({"Bybit": ex}, loop=background_loop)
    pos = fetcher.get_open_positions("Bybit")
    assert pos == [{"symbol": "BTCUSDT", "side": "buy", "size_usd": 30.0}]


def test_get_open_positions_mexc_normalizes(background_loop):
    ex = FakeExecutor(positions=[
        {"symbol": "BTC_USDT", "positionType": 1, "positionValue": "20.0"},
        {"symbol": "ETH_USDT", "positionType": 2, "positionValue": "15.0"},
    ])
    fetcher = LiveExchangeFetcher({"MEXC": ex}, loop=background_loop)
    pos = fetcher.get_open_positions("MEXC")
    assert pos == [
        {"symbol": "BTCUSDT", "side": "buy", "size_usd": 20.0},
        {"symbol": "ETHUSDT", "side": "sell", "size_usd": 15.0},
    ]


def test_get_open_positions_blofin_normalizes(background_loop):
    ex = FakeExecutor(positions=[
        {"instId": "BTC-USDT", "positionSide": "short", "notionalUsd": "18.0"},
    ])
    fetcher = LiveExchangeFetcher({"BloFin": ex}, loop=background_loop)
    pos = fetcher.get_open_positions("BloFin")
    assert pos == [{"symbol": "BTCUSDT", "side": "sell", "size_usd": 18.0}]


def test_get_open_positions_skips_unparseable_rows(background_loop):
    ex = FakeExecutor(positions=[
        {"instId": "BTC-USDT-SWAP", "posSide": "long", "notionalUsd": "25.5"},
        {"instId": "BAD", "posSide": "sideways", "notionalUsd": "5"},  # invalid side
        {"instId": "ETH-USDT-SWAP", "posSide": "short", "notionalUsd": "0"},  # zero size
    ])
    fetcher = LiveExchangeFetcher({"OKX": ex}, loop=background_loop)
    pos = fetcher.get_open_positions("OKX")
    assert pos == [{"symbol": "BTCUSDT", "side": "buy", "size_usd": 25.5}]


def test_get_recent_fills_returns_empty_for_now(background_loop):
    """Documented limitation; reconciler unlinked_fill check no-ops in production."""
    ex = FakeExecutor()
    fetcher = LiveExchangeFetcher({"OKX": ex}, loop=background_loop)
    assert fetcher.get_recent_fills("OKX", since_ms=0) == []


# ---------------------------------------------------------------------------
# Failure paths
# ---------------------------------------------------------------------------


def test_unknown_exchange_raises_connection_error(background_loop):
    fetcher = LiveExchangeFetcher({}, loop=background_loop)
    with pytest.raises(ConnectionError):
        fetcher.get_balance("OKX")


def test_executor_timeout_translates_to_connection_error(background_loop):
    ex = FakeExecutor(raise_=asyncio.TimeoutError())
    fetcher = LiveExchangeFetcher({"OKX": ex}, loop=background_loop)
    with pytest.raises(ConnectionError):
        fetcher.get_balance("OKX")


def test_executor_oserror_translates_to_connection_error(background_loop):
    ex = FakeExecutor(raise_=OSError("network unreachable"))
    fetcher = LiveExchangeFetcher({"OKX": ex}, loop=background_loop)
    with pytest.raises(ConnectionError):
        fetcher.get_open_positions("OKX")


def test_executor_programming_error_propagates(background_loop):
    """KeyError isn't a network error; it should not be wrapped as ConnectionError."""
    ex = FakeExecutor(raise_=KeyError("missing config"))
    fetcher = LiveExchangeFetcher({"OKX": ex}, loop=background_loop)
    with pytest.raises(KeyError):
        fetcher.get_balance("OKX")


def test_no_normalizer_for_unknown_exchange_returns_empty(background_loop):
    ex = FakeExecutor(positions=[{"foo": "bar"}])
    fetcher = LiveExchangeFetcher({"WeirdEx": ex}, loop=background_loop)
    # The fetcher will call the executor (unknown exchanges still get queried)
    # but normalize will return empty since there's no registered normalizer.
    pos = fetcher.get_open_positions("WeirdEx")
    assert pos == []
    assert ex.positions_calls == 1
