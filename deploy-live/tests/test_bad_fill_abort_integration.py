"""End-to-end integration test for the bad-fill abort path.

Drives TradeExecutor.open_position with mock ExchangeExecutor instances
that return crossed-book fills (SHORT cheaper than LONG), and asserts:

  * No LivePosition is added to the portfolio.
  * Both legs received an emergency-close order.
  * The audit log records the entry attempts AND the emergency closes.
  * Concurrent gather is used (close calls overlap, not sequential).

Reproduces trade #530 (ENJUSDT BloFin/MEXC) from the live trader.
"""
import asyncio
import time
from datetime import datetime, timezone

import pytest

from real_trader import (
    OrderResult, PriceQuote, Portfolio, RiskManager, TradeExecutor,
)


# ---------------------------------------------------------------------------
# Mock executor: scriptable place_market_order
# ---------------------------------------------------------------------------


class MockExecutor:
    """Records every place_market_order call and returns a scripted fill."""

    def __init__(self, name: str, *, fill_price: float, latency_s: float = 0.0):
        self.name = name
        self._fill_price = fill_price
        self._latency_s = latency_s
        self.calls: list[dict] = []
        # call timestamps (monotonic) — used to verify concurrency
        self.call_started_at: list[float] = []
        self.call_finished_at: list[float] = []

    async def place_market_order(self, symbol, side, size_usd) -> OrderResult:
        started = time.monotonic()
        self.call_started_at.append(started)
        self.calls.append({"symbol": symbol, "side": side, "size_usd": size_usd})
        if self._latency_s:
            await asyncio.sleep(self._latency_s)
        finished = time.monotonic()
        self.call_finished_at.append(finished)
        return OrderResult(
            success=True,
            order_id=f"{self.name}-{len(self.calls)}",
            exchange=self.name,
            symbol=symbol,
            side=side,
            size_usd=size_usd,
            filled_usd=size_usd,
            fill_price=self._fill_price,
            fees_usd=size_usd * 0.0006,  # 6bps taker
            timestamp=time.time(),
            latency_ms=self._latency_s * 1000,
        )


def _make_quote(exchange: str, bid: float, ask: float) -> PriceQuote:
    mid = (bid + ask) / 2
    return PriceQuote(
        exchange=exchange, symbol="ENJUSDT", bid=bid, ask=ask, mid=mid,
        volume_24h_usd=10_000_000.0, funding_rate=0.0, instrument="PERP",
        timestamp=datetime.now(timezone.utc),
    )


def _make_trade_executor(executors: dict, *, capital: float = 1000.0):
    portfolio = Portfolio(starting_capital=capital, cash=capital)
    risk_mgr = RiskManager(portfolio=portfolio, executors=executors)
    return TradeExecutor(executors=executors, portfolio=portfolio, risk_mgr=risk_mgr)


# ---------------------------------------------------------------------------
# Test 1 — bad-fill abort fires; no position is committed
# ---------------------------------------------------------------------------


def test_bad_fill_abort_blocks_position_commit():
    """Reproduces trade #530: SHORT fills at 0.9984, LONG at 1.0000.
    Realized spread = -0.16%. open_position must abort and not add to portfolio."""
    async def _go():
        # Detection sees positive spread (q_high.bid > q_low.ask)
        q_high = _make_quote("BloFin", bid=1.010, ask=1.011)
        q_low  = _make_quote("MEXC",   bid=1.000, ask=1.001)
        # But fills happen at crossed prices — short cheap, long expensive
        ex_short = MockExecutor("BloFin", fill_price=0.9984)
        ex_long  = MockExecutor("MEXC",   fill_price=1.0000)
        executors = {"BloFin": ex_short, "MEXC": ex_long}
        te = _make_trade_executor(executors)

        # Detection-time spread (lying about reality): 0.95% (above threshold)
        result = await te.open_position(
            symbol="ENJUSDT", q_high=q_high, q_low=q_low,
            spread_pct=0.95, size_usd=18.36, session=None,
        )

        # Abort: open_position returns None
        assert result is None
        # No position in portfolio
        assert len(te.portfolio.positions) == 0
        # total_trades NOT incremented
        assert te.portfolio.total_trades == 0
        # next_id WAS incremented (the abort path consumed an id; intentional)
        assert te.portfolio.next_id == 2
        # Each executor got TWO calls: the entry (sell/buy) and the emergency close (buy/sell)
        assert len(ex_short.calls) == 2
        assert len(ex_long.calls) == 2
        assert ex_short.calls[0]["side"] == "sell"   # entry short
        assert ex_short.calls[1]["side"] == "buy"    # emergency close
        assert ex_long.calls[0]["side"] == "buy"     # entry long
        assert ex_long.calls[1]["side"] == "sell"    # emergency close
        # Audit log captures all four orders
        actions = [a["action"] for a in te.order_audit_log]
        assert "entry_short" in actions
        assert "entry_long" in actions
        # _emergency_close_leg uses "emergency_close_<n>" naming
        assert any(a.startswith("emergency_close_") for a in actions)
    asyncio.run(_go())


# ---------------------------------------------------------------------------
# Test 2 — good fills: position is committed normally
# ---------------------------------------------------------------------------


def test_good_fill_commits_position_with_realized_spread_persisted():
    """Sanity: when fills are clean, the position is committed and the new
    realized_entry_spread_pct field is populated correctly."""
    async def _go():
        q_high = _make_quote("BloFin", bid=1.010, ask=1.011)
        q_low  = _make_quote("MEXC",   bid=1.000, ask=1.001)
        # Clean fills: short at 1.0050 (better than detection), long at 1.0000
        ex_short = MockExecutor("BloFin", fill_price=1.0050)
        ex_long  = MockExecutor("MEXC",   fill_price=1.0000)
        executors = {"BloFin": ex_short, "MEXC": ex_long}
        te = _make_trade_executor(executors)

        result = await te.open_position(
            symbol="ENJUSDT", q_high=q_high, q_low=q_low,
            spread_pct=0.95, size_usd=18.36, session=None,
        )

        assert result is not None
        assert result.realized_entry_spread_pct == pytest.approx(0.5)  # +0.5%
        assert result.entry_spread_pct == pytest.approx(0.95)  # detection-time
        assert len(te.portfolio.positions) == 1
        assert te.portfolio.total_trades == 1
        # Only one place_market_order call per executor (no emergency close)
        assert len(ex_short.calls) == 1
        assert len(ex_long.calls) == 1
    asyncio.run(_go())


# ---------------------------------------------------------------------------
# Test 3 — concurrency proof: two legs close in parallel, not sequentially
# ---------------------------------------------------------------------------


def test_emergency_close_runs_concurrently():
    """The two _emergency_close_leg calls in the bad-fill abort path must
    use asyncio.gather, not sequential await. Wall-clock time of the abort
    should be ~max(leg_latency), not ~sum."""
    async def _go():
        q_high = _make_quote("BloFin", bid=1.010, ask=1.011)
        q_low  = _make_quote("MEXC",   bid=1.000, ask=1.001)
        # Each executor sleeps 100ms per place_market_order. The abort
        # involves 2 entry orders + 2 emergency-close orders. Entry orders
        # are ALREADY concurrent (asyncio.gather, line 2339) — that's not
        # what we're checking here. We're checking the emergency-close phase.
        ex_short = MockExecutor("BloFin", fill_price=0.9984, latency_s=0.10)
        ex_long  = MockExecutor("MEXC",   fill_price=1.0000, latency_s=0.10)
        executors = {"BloFin": ex_short, "MEXC": ex_long}
        te = _make_trade_executor(executors)

        await te.open_position(
            symbol="ENJUSDT", q_high=q_high, q_low=q_low,
            spread_pct=0.95, size_usd=18.36, session=None,
        )

        # Emergency-close call timestamps. Each executor's calls[1] is the
        # emergency close. Verify the two close-start times overlap by
        # checking that one started before the other finished.
        short_close_start  = ex_short.call_started_at[1]
        short_close_finish = ex_short.call_finished_at[1]
        long_close_start   = ex_long.call_started_at[1]
        long_close_finish  = ex_long.call_finished_at[1]

        # Concurrent: each starts before the other finishes.
        assert short_close_start < long_close_finish
        assert long_close_start < short_close_finish
    asyncio.run(_go())
