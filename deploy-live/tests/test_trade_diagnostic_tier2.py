"""Tests for Tier 2 latency fields on TradeDiagnostic.

Verifies that entry/exit timing windows and per-leg latencies are
captured during open_position and close_position.
"""
import asyncio
import time
from datetime import datetime, timezone, timedelta

import pytest

from real_trader import (
    OrderResult, PriceQuote, Portfolio, RiskManager, TradeExecutor,
)


class TimedMockExecutor:
    """Executor that simulates a fixed latency per call."""

    def __init__(self, name: str, *, fill_price: float, latency_ms: float):
        self.name = name
        self._fill_price = fill_price
        self._latency_ms = latency_ms
        self.healthy = True
        self.calls: list = []

    async def place_market_order(self, symbol, side, size_usd):
        t0 = time.time()
        self.calls.append({"symbol": symbol, "side": side})
        await asyncio.sleep(self._latency_ms / 1000.0)
        elapsed_ms = (time.time() - t0) * 1000
        return OrderResult(
            success=True,
            order_id=f"{self.name}-{len(self.calls)}",
            exchange=self.name,
            symbol=symbol,
            side=side,
            size_usd=size_usd,
            filled_usd=size_usd,
            fill_price=self._fill_price,
            fees_usd=size_usd * 0.0006,
            timestamp=time.time(),
            latency_ms=elapsed_ms,
        )


def _make_quote(exchange, *, bid, ask):
    return PriceQuote(
        exchange=exchange, symbol="ENJUSDT", bid=bid, ask=ask, mid=(bid + ask) / 2,
        volume_24h_usd=10_000_000.0, funding_rate=0.0001, instrument="PERP",
        timestamp=datetime.now(timezone.utc),
    )


def _make_te(executors):
    portfolio = Portfolio(starting_capital=1000.0, cash=1000.0)
    risk_mgr = RiskManager(portfolio=portfolio, executors=executors)
    return TradeExecutor(executors=executors, portfolio=portfolio, risk_mgr=risk_mgr)


def test_entry_latency_fields_populated():
    """open_position records entry_started_at_ms / entry_completed_at_ms /
    per-leg latency on the diagnostic."""
    async def _go():
        q_high = _make_quote("BloFin", bid=1.010, ask=1.011)
        q_low  = _make_quote("MEXC",   bid=1.000, ask=1.001)
        ex_short = TimedMockExecutor("BloFin", fill_price=1.0050, latency_ms=80)
        ex_long  = TimedMockExecutor("MEXC",   fill_price=1.0010, latency_ms=120)
        executors = {"BloFin": ex_short, "MEXC": ex_long}
        te = _make_te(executors)

        pos = await te.open_position(
            symbol="ENJUSDT", q_high=q_high, q_low=q_low,
            spread_pct=0.95, size_usd=20.0, session=None,
        )
        assert pos is not None
        diag = te.portfolio.diagnostics[pos.id]

        # Timing window present
        assert diag.entry_started_at_ms > 0
        assert diag.entry_completed_at_ms > diag.entry_started_at_ms
        # Span ~max(80, 120)ms = ~120ms (concurrent gather).  Allow generous
        # upper bound to account for test scheduler variance.
        span_ms = diag.entry_completed_at_ms - diag.entry_started_at_ms
        assert 100 <= span_ms < 500, f"unexpected span: {span_ms}ms"
        # Per-leg latency populated from each executor's measurement.
        # Lower bound is loose because test scheduling adds noise.
        assert diag.short_entry_latency_ms >= 70
        assert diag.long_entry_latency_ms  >= 110
        # Long was slower than short — diagnostics show that explicitly.
        assert diag.long_entry_latency_ms > diag.short_entry_latency_ms
    asyncio.run(_go())


def test_exit_latency_fields_populated():
    """close_position records exit_started_at_ms / exit_completed_at_ms /
    per-leg exit latency on the diagnostic."""
    async def _go():
        q_high = _make_quote("BloFin", bid=1.010, ask=1.011)
        q_low  = _make_quote("MEXC",   bid=1.000, ask=1.001)
        ex_short = TimedMockExecutor("BloFin", fill_price=1.0080, latency_ms=50)
        ex_long  = TimedMockExecutor("MEXC",   fill_price=1.0010, latency_ms=70)
        executors = {"BloFin": ex_short, "MEXC": ex_long}
        te = _make_te(executors)

        pos = await te.open_position(
            symbol="ENJUSDT", q_high=q_high, q_low=q_low,
            spread_pct=0.69, size_usd=20.0, session=None,
        )
        assert pos is not None
        # Backdate so close is logically distinct from entry timestamp.
        pos.entry_time = datetime.now(timezone.utc) - timedelta(minutes=1)

        # Slightly different exit latencies to verify per-leg capture.
        ex_short._latency_ms = 200
        ex_long._latency_ms = 150
        ex_short._fill_price = 1.0050
        ex_long._fill_price = 1.0040
        q_short_exit = _make_quote("BloFin", bid=1.0040, ask=1.0050)
        q_long_exit  = _make_quote("MEXC",   bid=1.0040, ask=1.0050)

        await te.close_position(
            pos, current_spread=0.04, reason="convergence",
            q_short=q_short_exit, q_long=q_long_exit,
        )

        diag = te.portfolio.diagnostics[pos.id]
        assert diag.exit_started_at_ms > 0
        assert diag.exit_completed_at_ms > diag.exit_started_at_ms
        # Span at least the slower leg's latency
        exit_span = diag.exit_completed_at_ms - diag.exit_started_at_ms
        assert exit_span >= 180, f"unexpected exit span: {exit_span}ms"
        assert diag.short_exit_latency_ms >= 180
        assert diag.long_exit_latency_ms >= 130
        # Short was slower on exit (we reversed which one is slower)
        assert diag.short_exit_latency_ms > diag.long_exit_latency_ms
    asyncio.run(_go())


def test_decision_to_send_overhead_visible():
    """decided_at_ms vs entry_started_at_ms exposes any scheduling delay
    between bot's decision and the actual order dispatch."""
    async def _go():
        q_high = _make_quote("BloFin", bid=1.010, ask=1.011)
        q_low  = _make_quote("MEXC",   bid=1.000, ask=1.001)
        ex_short = TimedMockExecutor("BloFin", fill_price=1.0050, latency_ms=10)
        ex_long  = TimedMockExecutor("MEXC",   fill_price=1.0010, latency_ms=10)
        executors = {"BloFin": ex_short, "MEXC": ex_long}
        te = _make_te(executors)

        pos = await te.open_position(
            symbol="ENJUSDT", q_high=q_high, q_low=q_low,
            spread_pct=0.95, size_usd=20.0, session=None,
        )
        diag = te.portfolio.diagnostics[pos.id]

        # decided_at and entry_started_at are very close in this test
        # (no real scheduling). Just verify the relationship: decided
        # comes first, then started.
        assert diag.decided_at_ms <= diag.entry_started_at_ms
        # The two should be within a few ms — verifies decision overhead
        # is bounded for normal operation.
        decision_overhead_ms = diag.entry_started_at_ms - diag.decided_at_ms
        assert decision_overhead_ms < 500
    asyncio.run(_go())


def test_exit_latency_zero_for_recovered_path():
    """The DEGRADED-recovery close path doesn't pass through close_position;
    it calls _finalize_close directly with synthesized OrderResults that have
    latency_ms=0. The diagnostic exit-latency fields stay at their defaults
    in that case (just verifying we don't crash)."""
    async def _go():
        q_high = _make_quote("BloFin", bid=1.010, ask=1.011)
        q_low  = _make_quote("MEXC",   bid=1.000, ask=1.001)
        ex_short = TimedMockExecutor("BloFin", fill_price=1.0050, latency_ms=10)
        ex_long  = TimedMockExecutor("MEXC",   fill_price=1.0010, latency_ms=10)
        executors = {"BloFin": ex_short, "MEXC": ex_long}
        te = _make_te(executors)

        pos = await te.open_position(
            symbol="ENJUSDT", q_high=q_high, q_low=q_low,
            spread_pct=0.95, size_usd=20.0, session=None,
        )
        # Simulate the recovered path: call _finalize_close directly
        r_short = OrderResult(True, "ok", "BloFin", "ENJUSDT", "buy",
                              pos.size_usd, pos.size_usd, 1.005, 0.0, time.time())
        r_long = OrderResult(True, "ok", "MEXC", "ENJUSDT", "sell",
                             pos.size_usd, pos.size_usd, 1.004, 0.0, time.time())
        te._finalize_close(pos, r_short, r_long, current_spread=0.04, reason="recovered")

        diag = te.portfolio.diagnostics[pos.id]
        # Exit latency fields remain at defaults (recovered path doesn't
        # populate them).  This is intentional and documented; just verify
        # we didn't crash on missing data.
        assert diag.exit_started_at_ms == 0
        assert diag.exit_completed_at_ms == 0
    asyncio.run(_go())
