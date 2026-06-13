"""Tests for the bad-fill / asymmetric-fill safeguards in open_position.

Covers:
- A1: asymmetric-fill abort when one leg fills materially less than the other
- A2: Telegram alerts fire on both abort paths (bad-fill and asymmetric)
- A3: DRY_RUN_SLIPPAGE_BPS lets DRY_RUN exercise the bad-fill abort path
"""
import asyncio
import time
from datetime import datetime, timezone

import pytest

import real_trader
from real_trader import (
    OrderResult, PriceQuote, Portfolio, RiskManager, TradeExecutor,
)


# ---------------------------------------------------------------------------
# Test infrastructure (kept here so this file is self-contained)
# ---------------------------------------------------------------------------


class MockExecutor:
    """Scriptable executor that records calls."""

    def __init__(self, name: str, *, fill_price: float, filled_usd: float = -1.0):
        self.name = name
        self._fill_price = fill_price
        # filled_usd<0 means "fill exactly the requested size"
        self._filled_usd_override = filled_usd
        self.healthy = True
        self.calls: list[dict] = []

    async def place_market_order(self, symbol, side, size_usd):
        self.calls.append({"symbol": symbol, "side": side, "size_usd": size_usd})
        filled = self._filled_usd_override if self._filled_usd_override >= 0 else size_usd
        return OrderResult(
            success=True,
            order_id=f"{self.name}-{len(self.calls)}",
            exchange=self.name,
            symbol=symbol,
            side=side,
            size_usd=size_usd,
            filled_usd=filled,
            fill_price=self._fill_price,
            fees_usd=size_usd * 0.0006,
            timestamp=time.time(),
        )


def _make_quote(exchange, *, bid, ask):
    return PriceQuote(
        exchange=exchange, symbol="ENJUSDT", bid=bid, ask=ask, mid=(bid + ask) / 2,
        volume_24h_usd=10_000_000.0, funding_rate=0.0, instrument="PERP",
        timestamp=datetime.now(timezone.utc),
    )


def _make_te(executors):
    portfolio = Portfolio(starting_capital=1000.0, cash=1000.0)
    risk_mgr = RiskManager(portfolio=portfolio, executors=executors)
    return TradeExecutor(executors=executors, portfolio=portfolio, risk_mgr=risk_mgr)


# ---------------------------------------------------------------------------
# A1 — asymmetric-fill abort
# ---------------------------------------------------------------------------


def test_asymmetric_fill_aborts_when_legs_differ_materially():
    """Short fills $25, long fills $5 → 80% asymmetry → abort."""
    async def _go():
        q_high = _make_quote("BloFin", bid=1.010, ask=1.011)
        q_low  = _make_quote("MEXC",   bid=1.000, ask=1.001)
        ex_short = MockExecutor("BloFin", fill_price=1.0050, filled_usd=25.0)
        ex_long  = MockExecutor("MEXC",   fill_price=1.0010, filled_usd=5.0)
        executors = {"BloFin": ex_short, "MEXC": ex_long}
        te = _make_te(executors)

        result = await te.open_position(
            symbol="ENJUSDT", q_high=q_high, q_low=q_low,
            spread_pct=0.95, size_usd=25.0, session=None,
        )

        assert result is None  # aborted
        assert te.portfolio.diagnostics == {}  # no diagnostic for aborts
        assert len(te.portfolio.positions) == 0
        # Both executors got entry + emergency close
        assert len(ex_short.calls) == 2
        assert len(ex_long.calls) == 2
        assert ex_short.calls[1]["side"] == "buy"   # close the short
        assert ex_long.calls[1]["side"] == "sell"   # close the long
    asyncio.run(_go())


def test_symmetric_fills_within_tolerance_proceed():
    """Short $25, long $24 → 4% asymmetry < 5% tolerance → trade commits."""
    async def _go():
        q_high = _make_quote("BloFin", bid=1.010, ask=1.011)
        q_low  = _make_quote("MEXC",   bid=1.000, ask=1.001)
        ex_short = MockExecutor("BloFin", fill_price=1.0050, filled_usd=25.0)
        ex_long  = MockExecutor("MEXC",   fill_price=1.0010, filled_usd=24.0)
        executors = {"BloFin": ex_short, "MEXC": ex_long}
        te = _make_te(executors)

        result = await te.open_position(
            symbol="ENJUSDT", q_high=q_high, q_low=q_low,
            spread_pct=0.95, size_usd=25.0, session=None,
        )

        assert result is not None
        assert result.size_usd == 24.0  # min of the two
        assert len(te.portfolio.positions) == 1
        # No emergency close (only entry calls)
        assert len(ex_short.calls) == 1
        assert len(ex_long.calls) == 1
    asyncio.run(_go())


def test_asymmetric_close_runs_concurrently():
    """The asymmetric-abort path uses asyncio.gather like the bad-fill path."""
    async def _go():
        # Both legs slow (100ms) so we can detect overlap in close phase
        q_high = _make_quote("BloFin", bid=1.010, ask=1.011)
        q_low  = _make_quote("MEXC",   bid=1.000, ask=1.001)

        class SlowMock(MockExecutor):
            async def place_market_order(self, symbol, side, size_usd):
                self.calls.append({"symbol": symbol, "side": side,
                                   "size_usd": size_usd, "started": time.monotonic()})
                await asyncio.sleep(0.10)
                self.calls[-1]["finished"] = time.monotonic()
                filled = self._filled_usd_override if self._filled_usd_override >= 0 else size_usd
                return OrderResult(
                    True, f"{self.name}-{len(self.calls)}", self.name, symbol, side,
                    size_usd, filled, self._fill_price, size_usd * 0.0006, time.time(),
                )

        ex_short = SlowMock("BloFin", fill_price=1.0050, filled_usd=25.0)
        ex_long  = SlowMock("MEXC",   fill_price=1.0010, filled_usd=5.0)
        executors = {"BloFin": ex_short, "MEXC": ex_long}
        te = _make_te(executors)

        await te.open_position(
            symbol="ENJUSDT", q_high=q_high, q_low=q_low,
            spread_pct=0.95, size_usd=25.0, session=None,
        )

        # Emergency close is calls[1] for each executor.  Verify they overlap.
        short_close_started  = ex_short.calls[1]["started"]
        short_close_finished = ex_short.calls[1]["finished"]
        long_close_started   = ex_long.calls[1]["started"]
        long_close_finished  = ex_long.calls[1]["finished"]
        assert short_close_started < long_close_finished
        assert long_close_started < short_close_finished
    asyncio.run(_go())


# ---------------------------------------------------------------------------
# A3 — DRY_RUN_SLIPPAGE_BPS exercises the bad-fill abort
# ---------------------------------------------------------------------------


def test_dry_run_slippage_simulation_triggers_bad_fill_abort(monkeypatch):
    """With DRY_RUN=true and DRY_RUN_SLIPPAGE_BPS=100 (1.00%), each leg's
    fill price is shifted enough that realized spread crosses zero, firing
    the bad-fill abort. Without simulation, DRY_RUN never exercises this
    path because the bid/ask fallback always shows a positive spread."""
    monkeypatch.setattr(real_trader, "DRY_RUN", True)
    monkeypatch.setattr(real_trader, "DRY_RUN_SLIPPAGE_BPS", 100.0)  # 1%

    async def _go():
        # Detection sees a +0.10% spread (just barely positive).
        q_high = _make_quote("BloFin", bid=1.0010, ask=1.0020)
        q_low  = _make_quote("MEXC",   bid=0.9990, ask=1.0000)
        # Executors return fill_price=0 so the fallback to bid/ask kicks in,
        # then the slippage simulation moves prices adversely:
        #   short: q_high.bid=1.0010 × (1 - 0.01) = 0.991
        #   long:  q_low.ask=1.0000 × (1 + 0.01) = 1.010
        # Realized spread = (0.991 - 1.010) / 1.010 * 100 = -1.88%  (negative!)
        ex_short = MockExecutor("BloFin", fill_price=0)
        ex_long  = MockExecutor("MEXC",   fill_price=0)
        executors = {"BloFin": ex_short, "MEXC": ex_long}
        te = _make_te(executors)

        result = await te.open_position(
            symbol="ENJUSDT", q_high=q_high, q_low=q_low,
            spread_pct=0.10, size_usd=25.0, session=None,
        )

        assert result is None  # aborted by bad-fill check
        assert len(te.portfolio.positions) == 0
        # Both executors got entry + emergency close
        assert len(ex_short.calls) == 2
        assert len(ex_long.calls) == 2
    asyncio.run(_go())


def test_dry_run_slippage_zero_preserves_legacy_behavior(monkeypatch):
    """With DRY_RUN_SLIPPAGE_BPS=0, the trade commits cleanly using bid/ask
    fallback prices — confirming we haven't accidentally broken existing
    DRY_RUN flows for users who don't opt into the simulation."""
    monkeypatch.setattr(real_trader, "DRY_RUN", True)
    monkeypatch.setattr(real_trader, "DRY_RUN_SLIPPAGE_BPS", 0.0)

    async def _go():
        q_high = _make_quote("BloFin", bid=1.0100, ask=1.0110)
        q_low  = _make_quote("MEXC",   bid=1.0000, ask=1.0010)
        ex_short = MockExecutor("BloFin", fill_price=0)
        ex_long  = MockExecutor("MEXC",   fill_price=0)
        executors = {"BloFin": ex_short, "MEXC": ex_long}
        te = _make_te(executors)

        result = await te.open_position(
            symbol="ENJUSDT", q_high=q_high, q_low=q_low,
            spread_pct=0.95, size_usd=25.0, session=None,
        )

        assert result is not None  # commits
        assert result.entry_price_short == pytest.approx(1.0100)  # = q_high.bid
        assert result.entry_price_long == pytest.approx(1.0010)   # = q_low.ask
    asyncio.run(_go())


# ---------------------------------------------------------------------------
# A2 — Telegram alerting on both abort paths (smoke check)
# ---------------------------------------------------------------------------


def test_bad_fill_abort_attempts_telegram_alert(monkeypatch):
    """When session is provided, send_telegram is called from the abort path."""
    sent: list[str] = []

    async def fake_send(_session, text, **_kwargs):
        sent.append(text)
        return None

    monkeypatch.setattr(real_trader, "send_telegram", fake_send)

    async def _go():
        q_high = _make_quote("BloFin", bid=1.010, ask=1.011)
        q_low  = _make_quote("MEXC",   bid=1.000, ask=1.001)
        ex_short = MockExecutor("BloFin", fill_price=0.9984)  # crossed
        ex_long  = MockExecutor("MEXC",   fill_price=1.0000)
        executors = {"BloFin": ex_short, "MEXC": ex_long}
        te = _make_te(executors)

        # Pass a fake session (any non-None value); send_telegram is mocked.
        await te.open_position(
            symbol="ENJUSDT", q_high=q_high, q_low=q_low,
            spread_pct=0.95, size_usd=18.36, session=object(),
        )
        assert any("BAD-FILL ABORT" in s for s in sent)
    asyncio.run(_go())


def test_asymmetric_abort_attempts_telegram_alert(monkeypatch):
    sent: list[str] = []

    async def fake_send(_session, text, **_kwargs):
        sent.append(text)
        return None

    monkeypatch.setattr(real_trader, "send_telegram", fake_send)

    async def _go():
        q_high = _make_quote("BloFin", bid=1.010, ask=1.011)
        q_low  = _make_quote("MEXC",   bid=1.000, ask=1.001)
        ex_short = MockExecutor("BloFin", fill_price=1.0050, filled_usd=25.0)
        ex_long  = MockExecutor("MEXC",   fill_price=1.0010, filled_usd=5.0)
        executors = {"BloFin": ex_short, "MEXC": ex_long}
        te = _make_te(executors)

        await te.open_position(
            symbol="ENJUSDT", q_high=q_high, q_low=q_low,
            spread_pct=0.95, size_usd=25.0, session=object(),
        )
        assert any("ASYMMETRIC FILL" in s for s in sent)
    asyncio.run(_go())


def test_telegram_failure_does_not_block_abort(monkeypatch):
    """If send_telegram raises, the abort still completes and emergency
    closes still run."""
    async def failing_send(*_args, **_kwargs):
        raise RuntimeError("telegram down")

    monkeypatch.setattr(real_trader, "send_telegram", failing_send)

    async def _go():
        q_high = _make_quote("BloFin", bid=1.010, ask=1.011)
        q_low  = _make_quote("MEXC",   bid=1.000, ask=1.001)
        ex_short = MockExecutor("BloFin", fill_price=0.9984)
        ex_long  = MockExecutor("MEXC",   fill_price=1.0000)
        executors = {"BloFin": ex_short, "MEXC": ex_long}
        te = _make_te(executors)

        result = await te.open_position(
            symbol="ENJUSDT", q_high=q_high, q_low=q_low,
            spread_pct=0.95, size_usd=18.36, session=object(),
        )
        assert result is None
        # Emergency closes still ran despite Telegram failure
        assert len(ex_short.calls) == 2
        assert len(ex_long.calls) == 2
    asyncio.run(_go())
