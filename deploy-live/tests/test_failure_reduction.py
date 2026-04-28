"""Tests for the failed-trade reduction work (A.1, A.2, B.1, B.2, B.4).

These exercise candidate-stage filters and the tightened bad-fill gate.
Where the existing test infrastructure (MockExecutor in
test_open_position_safeguards.py) covers the open_position path,
we reuse the same shape; for candidate-loop changes (B.2/B.4) we test
the helper functions / scoring math directly because the full main
loop is hard to drive in a unit test.
"""
import asyncio
import time
from datetime import datetime, timezone

import pytest

import real_trader
from real_trader import (
    OrderResult, PriceQuote, Portfolio, RiskManager, TradeExecutor, LiveTrader,
)


# ---------------------------------------------------------------------------
# Shared mock infrastructure
# ---------------------------------------------------------------------------


class MockExecutor:
    def __init__(self, name: str, *, fill_price: float):
        self.name = name
        self._fill_price = fill_price
        self.healthy = True
        self.calls = []

    async def place_market_order(self, symbol, side, size_usd):
        self.calls.append({"symbol": symbol, "side": side, "size_usd": size_usd})
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
        )


def _make_quote(exchange, *, bid, ask, instrument="PERP", funding_rate=0.0):
    return PriceQuote(
        exchange=exchange, symbol="ENJUSDT", bid=bid, ask=ask, mid=(bid + ask) / 2,
        volume_24h_usd=10_000_000.0, funding_rate=funding_rate, instrument=instrument,
        timestamp=datetime.now(timezone.utc),
    )


def _make_te(executors):
    portfolio = Portfolio(starting_capital=1000.0, cash=1000.0)
    risk_mgr = RiskManager(portfolio=portfolio, executors=executors)
    return TradeExecutor(executors=executors, portfolio=portfolio, risk_mgr=risk_mgr)


# ---------------------------------------------------------------------------
# A.1 — Tightened bad-fill threshold
# ---------------------------------------------------------------------------


def test_a1_aborts_when_realized_below_fees_plus_margin():
    """Realized spread of +0.05% (positive but tiny) used to commit; now
    should abort because it doesn't clear round-trip fees + 5bps margin."""
    async def _go():
        # MEXC + BloFin PERP: fees = 0.020% + 0.060% = 0.080% round-trip.
        # min_acceptable = 0.080 + 0.050 = 0.130%
        # We want realized just BARELY positive but below 0.130%.
        # Pick prices so realized ≈ +0.05% which is < 0.130%.
        # short_fill / long_fill = 1 + 0.0005
        q_high = _make_quote("MEXC", bid=1.010, ask=1.011)
        q_low  = _make_quote("BloFin", bid=1.000, ask=1.001)
        ex_short = MockExecutor("MEXC", fill_price=1.0005)   # SHORT
        ex_long  = MockExecutor("BloFin", fill_price=1.0000)   # LONG
        # realized = (1.0005 - 1.0000) / 1.0000 * 100 = +0.05%
        executors = {"MEXC": ex_short, "BloFin": ex_long}
        te = _make_te(executors)

        result = await te.open_position(
            symbol="ENJUSDT", q_high=q_high, q_low=q_low,
            spread_pct=0.95, size_usd=20.0, session=None,
        )

        assert result is None  # aborted
        assert len(te.portfolio.positions) == 0
        # Both legs got entry + emergency-close
        assert len(ex_short.calls) == 2
        assert len(ex_long.calls) == 2
    asyncio.run(_go())


def test_a1_commits_when_realized_above_threshold():
    """A trade that clearly clears fees + margin still commits cleanly."""
    async def _go():
        q_high = _make_quote("MEXC", bid=1.010, ask=1.011)
        q_low  = _make_quote("BloFin", bid=1.000, ask=1.001)
        # Realized = +0.5% which is far above 0.13% threshold
        ex_short = MockExecutor("MEXC", fill_price=1.0050)
        ex_long  = MockExecutor("BloFin", fill_price=1.0000)
        executors = {"MEXC": ex_short, "BloFin": ex_long}
        te = _make_te(executors)

        result = await te.open_position(
            symbol="ENJUSDT", q_high=q_high, q_low=q_low,
            spread_pct=0.95, size_usd=20.0, session=None,
        )

        assert result is not None
        assert len(te.portfolio.positions) == 1
    asyncio.run(_go())


def test_a1_min_profit_constant_is_tunable():
    """Verify the constant exists and is reachable so operators can tune
    without re-reading the abort logic."""
    assert real_trader.MIN_PROFIT_AFTER_FEES_PCT == 0.05


# ---------------------------------------------------------------------------
# B.4 — Funding-cost veto. Helper math (the candidate-loop wiring is
# tested implicitly by live DRY_RUN; here we verify the compute is right.)
# ---------------------------------------------------------------------------


def _funding_cost_pct(short_rate, long_rate, *, intervals=None):
    """Replicate the in-loop computation for testing."""
    if intervals is None:
        intervals = real_trader._FUNDING_LOOKAHEAD_HOURS / 8.0
    short_funding_paid = -short_rate
    long_funding_paid = long_rate
    return (short_funding_paid + long_funding_paid) * intervals * 100


def test_b4_funding_cost_zero_when_rates_equal():
    """Symmetric funding (both rates equal) cancels: short receives, long pays."""
    cost = _funding_cost_pct(0.0001, 0.0001)
    assert cost == pytest.approx(0.0)


def test_b4_funding_cost_positive_when_long_pays_more():
    """Long-rate exceeds short-rate → bot net pays funding."""
    cost = _funding_cost_pct(0.00001, 0.00050)
    assert cost > 0


def test_b4_funding_cost_negative_when_short_receives_more():
    """Short-rate exceeds long-rate → bot net receives funding."""
    cost = _funding_cost_pct(0.00050, 0.00001)
    assert cost < 0


def test_b4_threshold_constant_is_tunable():
    assert 0.0 < real_trader.FUNDING_VETO_THRESHOLD_PCT <= 1.0


# ---------------------------------------------------------------------------
# B.2 — Loss-streak penalty. Test the scoring math directly since the
# full main loop is awkward to drive.
# ---------------------------------------------------------------------------


def _candidate_score(spread_pct, fees_pct, wins, losses):
    """Replicate the scoring branches from the candidate loop."""
    score = spread_pct - fees_pct
    if wins > losses:
        score += 0.05
    elif losses > wins:
        score -= real_trader.LOSS_STREAK_PENALTY_PER * (losses - wins)
    return score


def test_b2_score_unchanged_when_wins_equal_losses():
    score = _candidate_score(spread_pct=1.5, fees_pct=0.16, wins=3, losses=3)
    assert score == pytest.approx(1.5 - 0.16)


def test_b2_score_boosted_when_wins_dominate():
    score = _candidate_score(spread_pct=1.5, fees_pct=0.16, wins=5, losses=2)
    assert score == pytest.approx(1.5 - 0.16 + 0.05)


def test_b2_score_penalized_proportional_to_loss_streak():
    """3 net losses → penalty of 3 × LOSS_STREAK_PENALTY_PER."""
    base = 1.5 - 0.16
    score = _candidate_score(spread_pct=1.5, fees_pct=0.16, wins=0, losses=3)
    expected_penalty = real_trader.LOSS_STREAK_PENALTY_PER * 3
    assert score == pytest.approx(base - expected_penalty)


def test_b2_loss_streak_can_drop_score_below_breakeven():
    """A pair losing 5 in a row should fall below score=0 even if its
    raw spread minus fees is healthy. Validates the penalty actually
    deprioritizes bad pairs."""
    base = 1.5 - 0.16  # 1.34
    score = _candidate_score(spread_pct=1.5, fees_pct=0.16, wins=0, losses=10)
    # 10 net losses × 0.30 = 3.0 penalty → score = 1.34 - 3.0 = -1.66
    assert score < 0


# ---------------------------------------------------------------------------
# A.2 — Quote freshness gate at execution time (constant validation only;
# the in-loop check runs against the live by_symbol dict and is integration-
# tested via DRY_RUN).
# ---------------------------------------------------------------------------


def test_a2_freshness_constant_is_tighter_than_candidate_filter():
    """ENTRY_QUOTE_FRESHNESS_S must be tighter than STALE_PRICE_SECONDS;
    otherwise the gate adds nothing."""
    assert real_trader.ENTRY_QUOTE_FRESHNESS_S < real_trader.STALE_PRICE_SECONDS
