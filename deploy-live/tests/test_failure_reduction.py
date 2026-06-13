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


# ---------------------------------------------------------------------------
# B.1 — Spread-momentum filter
# ---------------------------------------------------------------------------


def _trader_with_history(pair_key, history):
    """Build a minimal LiveTrader instance with a seeded baseline_spreads."""
    t = LiveTrader.__new__(LiveTrader)
    t.baseline_spreads = {pair_key: list(history)}
    return t


def test_b1_returns_false_when_history_too_short():
    """With fewer than SPREAD_MOMENTUM_LOOKBACK prior samples, no opinion —
    don't filter the candidate."""
    t = _trader_with_history("PK", [0.5, 0.6])  # only 2 prior, need 5
    # Last value is current_spread which we'd be checking against; pretend
    # update_baseline_spreads was just called.
    assert t.is_spread_widening("PK", 0.7) is False


def test_b1_returns_false_when_pair_unseen():
    """Pair with no history returns False (don't filter)."""
    t = _trader_with_history("PK", [])
    assert t.is_spread_widening("UNSEEN", 1.5) is False


def test_b1_detects_widening_polyxusdt_pattern():
    """The POLYXUSDT pattern: spread went 0.5 → 1.0 → 1.5 → 2.0 → 2.5 → 2.8.
    Every reading is a new high. Bot should refuse to enter."""
    history = [0.5, 1.0, 1.5, 2.0, 2.5, 2.8]
    t = _trader_with_history("PK", history)
    # Imagine update_baseline_spreads was just called with 2.8; bl[-1]=2.8
    # We're checking whether current=2.8 looks like widening vs prior 5.
    assert t.is_spread_widening("PK", 2.8) is True


def test_b1_allows_entry_after_peak_when_spread_narrowing():
    """Spread peaked at 3.0% then came back down. Current value 2.0% is
    below the recent max → not widening → entry allowed."""
    # Last entry is 2.0 (the current spread the helper compares against)
    history = [1.5, 2.5, 3.0, 2.5, 2.2, 2.0]
    t = _trader_with_history("PK", history)
    assert t.is_spread_widening("PK", 2.0) is False


def test_b1_hysteresis_treats_within_one_pct_of_max_as_widening():
    """Tiny pullback from peak is still 'effectively at peak'. Within 1%
    of recent max counts as widening to avoid flapping in/out."""
    # Recent max is 3.0. Current is 2.985 (within 1% = 2.97).
    history = [1.0, 2.0, 3.0, 2.95, 2.97, 2.985]
    t = _trader_with_history("PK", history)
    # Prior 5 = [1.0, 2.0, 3.0, 2.95, 2.97]. Max=3.0. 0.99 × 3.0 = 2.97.
    # current=2.985 >= 2.97 → still widening (hysteresis kicks in).
    assert t.is_spread_widening("PK", 2.985) is True


def test_b1_clear_pullback_below_threshold_allows_entry():
    """Once pullback exceeds the hysteresis band, entry is allowed."""
    # Recent max 3.0; threshold 2.97; current 2.5 is well below.
    history = [1.0, 2.0, 3.0, 2.8, 2.6, 2.5]
    t = _trader_with_history("PK", history)
    assert t.is_spread_widening("PK", 2.5) is False


def test_b1_constants_exist_and_are_sane():
    assert real_trader.SPREAD_MOMENTUM_LOOKBACK >= 3
    assert 0.5 < real_trader.SPREAD_WIDENING_THRESHOLD <= 1.0
