"""Tests for the TradeDiagnostic forensic record (Tier 1 fields).

Covers:
- Pure helpers: compute_short_slippage_usd, compute_long_slippage_usd,
  compute_funding_paid_usd
- Dataclass round-trip via _diag_to_dict / _diag_from_dict
- End-to-end: open_position records entry-side fields; close_position
  fills in exit-side fields including PnL decomposition and funding
- Backward compat: legacy state.json without "diagnostics" key loads cleanly
"""
import asyncio
import json
import os
import tempfile
import time
from datetime import datetime, timezone, timedelta

import pytest

from real_trader import (
    OrderResult, PriceQuote, Portfolio, RiskManager, TradeExecutor,
    TradeDiagnostic,
    compute_short_slippage_usd, compute_long_slippage_usd,
    compute_funding_paid_usd,
)


# ---------------------------------------------------------------------------
# Helper: pure math (no I/O)
# ---------------------------------------------------------------------------


def test_short_slippage_adverse():
    """Bot expected to sell at 1.000, sold at 0.998 → adverse 0.2%."""
    # size_usd=100, expected=1.000 → 100 contracts. Each contract worth 0.002 less.
    s = compute_short_slippage_usd(expected_price=1.000, fill_price=0.998, size_usd=100.0)
    assert s == pytest.approx(0.2)  # 100 contracts × $0.002 worse


def test_short_slippage_price_improvement():
    """Bot expected 1.000, sold at 1.001 → got better → negative slippage."""
    s = compute_short_slippage_usd(expected_price=1.000, fill_price=1.001, size_usd=100.0)
    assert s == pytest.approx(-0.1)


def test_long_slippage_adverse():
    """Bot expected to buy at 1.000, paid 1.002 → adverse 0.2%."""
    s = compute_long_slippage_usd(expected_price=1.000, fill_price=1.002, size_usd=100.0)
    assert s == pytest.approx(0.2)


def test_slippage_zero_for_invalid_inputs():
    assert compute_short_slippage_usd(0.0, 1.0, 100.0) == 0.0
    assert compute_short_slippage_usd(1.0, 0.0, 100.0) == 0.0
    assert compute_long_slippage_usd(-1.0, 1.0, 100.0) == 0.0


def test_funding_short_receives_when_positive_rate():
    """Convention: funding_rate > 0 → SHORT receives, LONG pays."""
    # 0.01% per 8h, $100 size, 8 hours held → 0.01 × 100 = $0.01
    s = compute_funding_paid_usd(0.0001, 100.0, 8.0, is_short=True)
    assert s == pytest.approx(-0.01)  # < 0 = received

    long = compute_funding_paid_usd(0.0001, 100.0, 8.0, is_short=False)
    assert long == pytest.approx(0.01)  # > 0 = paid


def test_funding_zero_for_no_hold():
    assert compute_funding_paid_usd(0.0001, 100.0, 0.0, is_short=True) == 0.0
    assert compute_funding_paid_usd(0.0001, 0.0, 8.0, is_short=False) == 0.0


def test_funding_proportional_to_hold_time():
    """30 minutes is 1/16 of an 8h interval."""
    s = compute_funding_paid_usd(0.0001, 100.0, 0.5, is_short=False)
    # 0.0001 × 100 × (0.5/8) = 0.000625
    assert s == pytest.approx(0.000625)


# ---------------------------------------------------------------------------
# Dataclass round-trip
# ---------------------------------------------------------------------------


def test_trade_diagnostic_serializes_round_trip():
    from real_trader import LiveTrader
    diag = TradeDiagnostic(
        position_id=42,
        decided_at_ms=1700000000000,
        detection_short_bid=1.010,
        detection_short_ask=1.011,
        detection_long_bid=1.000,
        detection_long_ask=1.001,
        detection_short_quote_age_ms=150,
        detection_long_quote_age_ms=200,
        detection_funding_short=0.0001,
        detection_funding_long=-0.00005,
        detection_short_healthy=True,
        detection_long_healthy=False,
        candidate_score=0.85,
        candidate_rank=2,
        n_competing_candidates=7,
        pair_recent_wins=3,
        pair_recent_losses=1,
        short_entry_slippage_usd=0.05,
        long_entry_slippage_usd=-0.02,
        exit_short_bid=1.005,
        exit_short_ask=1.006,
        exit_realized_spread_pct=0.04,
        short_exit_slippage_usd=0.03,
        long_exit_slippage_usd=0.01,
        short_pnl_usd=0.50,
        long_pnl_usd=-0.30,
        funding_paid_short_usd=-0.01,
        funding_paid_long_usd=0.01,
        hold_minutes=8.5,
    )
    d = LiveTrader._diag_to_dict(diag)
    assert d["position_id"] == 42
    assert d["candidate_rank"] == 2
    assert d["short_pnl_usd"] == 0.5

    diag2 = LiveTrader._diag_from_dict(d)
    assert diag2.position_id == 42
    assert diag2.detection_funding_short == pytest.approx(0.0001)
    assert diag2.detection_short_healthy is True
    assert diag2.detection_long_healthy is False
    assert diag2.short_pnl_usd == pytest.approx(0.5)
    assert diag2.hold_minutes == pytest.approx(8.5)


def test_diag_from_dict_tolerates_missing_fields():
    """Older state files without all fields should still load with defaults."""
    from real_trader import LiveTrader
    # Minimum viable dict (only position_id matters).
    d = {"position_id": 99}
    diag = LiveTrader._diag_from_dict(d)
    assert diag.position_id == 99
    assert diag.candidate_score == 0.0
    assert diag.detection_short_healthy is True


def test_diag_from_dict_ignores_unknown_extras():
    """Forward compat: unknown keys in dict (e.g. from a newer schema) don't crash."""
    from real_trader import LiveTrader
    d = {
        "position_id": 1,
        "decided_at_ms": 1000,
        "detection_short_bid": 1.0,
        "detection_short_ask": 1.001,
        "detection_long_bid": 1.0,
        "detection_long_ask": 1.001,
        "detection_short_quote_age_ms": 50,
        "detection_long_quote_age_ms": 50,
        "detection_funding_short": 0.0,
        "detection_funding_long": 0.0,
        "detection_short_healthy": True,
        "detection_long_healthy": True,
        # Future field that doesn't exist yet
        "future_field_42": "hello",
    }
    diag = LiveTrader._diag_from_dict(d)
    assert diag.position_id == 1
    assert not hasattr(diag, "future_field_42")


# ---------------------------------------------------------------------------
# End-to-end: open_position records the diagnostic
# ---------------------------------------------------------------------------


class MockExecutor:
    def __init__(self, name, *, fill_price, healthy=True):
        self.name = name
        self._fill_price = fill_price
        self.healthy = healthy
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


def _make_quote(exchange, *, bid, ask, funding_rate=0.0, age_seconds=0.0):
    ts = datetime.now(timezone.utc) - timedelta(seconds=age_seconds)
    return PriceQuote(
        exchange=exchange, symbol="ENJUSDT", bid=bid, ask=ask, mid=(bid + ask) / 2,
        volume_24h_usd=10_000_000.0, funding_rate=funding_rate, instrument="PERP",
        timestamp=ts,
    )


def _make_trade_executor(executors):
    portfolio = Portfolio(starting_capital=1000.0, cash=1000.0)
    risk_mgr = RiskManager(portfolio=portfolio, executors=executors)
    return TradeExecutor(executors=executors, portfolio=portfolio, risk_mgr=risk_mgr)


def test_open_position_records_entry_diagnostic():
    async def _go():
        # Detection sees positive spread; fills are clean.
        q_high = _make_quote("BloFin", bid=1.010, ask=1.011, funding_rate=0.0001, age_seconds=0.5)
        q_low  = _make_quote("MEXC",   bid=1.000, ask=1.001, funding_rate=-0.00005, age_seconds=1.0)
        ex_short = MockExecutor("BloFin", fill_price=1.0050, healthy=True)
        ex_long  = MockExecutor("MEXC",   fill_price=1.0010, healthy=False)
        executors = {"BloFin": ex_short, "MEXC": ex_long}
        te = _make_trade_executor(executors)

        pos = await te.open_position(
            symbol="ENJUSDT", q_high=q_high, q_low=q_low,
            spread_pct=0.95, size_usd=18.36, session=None,
            candidate_ctx={
                "score": 0.85, "rank": 2, "n_candidates": 7,
                "pair_recent_wins": 3, "pair_recent_losses": 1,
            },
        )

        assert pos is not None
        diag = te.portfolio.diagnostics[pos.id]

        # Detection snapshot
        assert diag.detection_short_bid == 1.010
        assert diag.detection_short_ask == 1.011
        assert diag.detection_long_bid == 1.000
        assert diag.detection_long_ask == 1.001
        # Quote age — at least 500ms for q_high (we set age_seconds=0.5)
        assert diag.detection_short_quote_age_ms >= 500
        assert diag.detection_long_quote_age_ms >= 1000
        # Funding rates from the quotes
        assert diag.detection_funding_short == pytest.approx(0.0001)
        assert diag.detection_funding_long == pytest.approx(-0.00005)
        # Health snapshot — long executor was unhealthy
        assert diag.detection_short_healthy is True
        assert diag.detection_long_healthy is False
        # Candidate context
        assert diag.candidate_score == pytest.approx(0.85)
        assert diag.candidate_rank == 2
        assert diag.n_competing_candidates == 7
        assert diag.pair_recent_wins == 3
        assert diag.pair_recent_losses == 1
        # Slippage: short expected 1.010, got 1.0050 → adverse 0.5%
        # short_slippage = (1.010 - 1.0050) × (18.36 / 1.010) ≈ 0.0909
        assert diag.short_entry_slippage_usd == pytest.approx(0.0909, abs=0.01)
        # Long: expected 1.001, paid 1.0010 → no slippage
        assert diag.long_entry_slippage_usd == pytest.approx(0.0, abs=0.001)
    asyncio.run(_go())


def test_open_position_no_diagnostic_for_aborted_trade():
    """Bad-fill aborts must NOT leave a diagnostic in portfolio.diagnostics —
    the position_id was consumed but no LivePosition exists, and we don't
    want forensic records for trades that never committed."""
    async def _go():
        q_high = _make_quote("BloFin", bid=1.010, ask=1.011)
        q_low  = _make_quote("MEXC",   bid=1.000, ask=1.001)
        # Bad fills — short fills cheaper than long → realized spread negative
        ex_short = MockExecutor("BloFin", fill_price=0.9984)
        ex_long  = MockExecutor("MEXC",   fill_price=1.0000)
        executors = {"BloFin": ex_short, "MEXC": ex_long}
        te = _make_trade_executor(executors)

        result = await te.open_position(
            symbol="ENJUSDT", q_high=q_high, q_low=q_low,
            spread_pct=0.95, size_usd=18.36, session=None,
        )

        assert result is None
        assert te.portfolio.diagnostics == {}
    asyncio.run(_go())


def test_close_position_finalizes_exit_diagnostic():
    """After a position closes, the diagnostic must have exit-side fields,
    PnL decomposition, and funding paid populated."""
    async def _go():
        # Open a clean position
        q_high = _make_quote("BloFin", bid=1.010, ask=1.011, funding_rate=0.0001)
        q_low  = _make_quote("MEXC",   bid=1.000, ask=1.001, funding_rate=0.0001)
        ex_short = MockExecutor("BloFin", fill_price=1.0080)
        ex_long  = MockExecutor("MEXC",   fill_price=1.0010)
        executors = {"BloFin": ex_short, "MEXC": ex_long}
        te = _make_trade_executor(executors)

        pos = await te.open_position(
            symbol="ENJUSDT", q_high=q_high, q_low=q_low,
            spread_pct=0.69, size_usd=100.0, session=None,
        )
        assert pos is not None
        # Backdate entry to give a reasonable hold duration for funding calc
        pos.entry_time = datetime.now(timezone.utc) - timedelta(hours=2)

        # Now close it. Switch executor fill prices to converge.
        ex_short._fill_price = 1.0050
        ex_long._fill_price = 1.0040
        q_short_exit = _make_quote("BloFin", bid=1.0040, ask=1.0050)
        q_long_exit  = _make_quote("MEXC",   bid=1.0040, ask=1.0050)

        ok = await te.close_position(
            pos, current_spread=0.04, reason="convergence",
            q_short=q_short_exit, q_long=q_long_exit,
        )
        assert ok

        diag = te.portfolio.diagnostics[pos.id]
        # Hold minutes: ~2 hours
        assert 119.0 < diag.hold_minutes < 121.0
        # Exit bid/ask snapshot
        assert diag.exit_short_bid == 1.0040
        assert diag.exit_long_ask == 1.0050
        # Realized exit spread = (1.0050 - 1.0040)/1.0040 * 100 ≈ 0.0996%
        assert diag.exit_realized_spread_pct == pytest.approx(0.0996, abs=0.001)
        # Per-leg PnL: short was 1.0080 → 1.0050, made +0.30%/100 = $0.298
        assert diag.short_pnl_usd > 0
        # Long was 1.0010 → 1.0040, made +0.30%/100 = $0.299
        assert diag.long_pnl_usd > 0
        # Funding: 2h held, rate 0.0001 per 8h interval, requested $100 but
        # MAX_POSITION_USD clamps to $25. Expected magnitude: 0.0001 × 25 × (2/8)
        # short receives (negative), long pays (positive)
        assert diag.funding_paid_short_usd < 0
        assert diag.funding_paid_long_usd > 0
        assert abs(diag.funding_paid_short_usd) == pytest.approx(0.000625)
        assert abs(diag.funding_paid_long_usd) == pytest.approx(0.000625)
    asyncio.run(_go())


# ---------------------------------------------------------------------------
# Persistence backward compat
# ---------------------------------------------------------------------------


def test_load_state_without_diagnostics_key_succeeds():
    """A state.json from before this commit (no 'diagnostics' key) must load
    without crashing; portfolio.diagnostics ends up as empty dict."""
    from real_trader import LiveTrader
    legacy = {
        "cash": 100.0, "next_id": 5, "total_trades": 0, "total_wins": 0,
        "total_pnl_usd": 0.0, "peak_equity": 100.0, "max_drawdown_pct": 0.0,
        "open_positions": [], "closed_positions": [],
        "pair_stats": {}, "equity_history": [], "symbol_blacklist": {},
    }
    with tempfile.TemporaryDirectory() as td:
        path = os.path.join(td, "real_state.json")
        with open(path, "w") as f:
            json.dump(legacy, f)
        # Use minimal trader instance just to drive _load_state.
        # We don't need full init; we set up the portfolio + state_path manually.
        trader = LiveTrader.__new__(LiveTrader)
        trader.state_path = path
        trader.portfolio = Portfolio(starting_capital=100.0, cash=100.0)
        trader.pair_stats = {}
        trader.equity_history = []
        trader.symbol_blacklist = {}
        trader.risk_mgr = type("RM", (), {"balance_cache": {}})()  # stub
        trader._load_state()
        assert trader.portfolio.diagnostics == {}


def test_save_state_prunes_orphaned_diagnostics():
    """Diagnostics for positions not in open or recent-closed should be pruned
    to keep the state file bounded."""
    from real_trader import LiveTrader
    portfolio = Portfolio(starting_capital=100.0, cash=100.0)
    # Add 3 diagnostics, only 1 of which has a corresponding position
    portfolio.diagnostics[1] = TradeDiagnostic(
        position_id=1, decided_at_ms=0,
        detection_short_bid=0, detection_short_ask=0,
        detection_long_bid=0, detection_long_ask=0,
        detection_short_quote_age_ms=0, detection_long_quote_age_ms=0,
        detection_funding_short=0, detection_funding_long=0,
        detection_short_healthy=True, detection_long_healthy=True,
    )
    portfolio.diagnostics[2] = TradeDiagnostic(
        position_id=2, decided_at_ms=0,
        detection_short_bid=0, detection_short_ask=0,
        detection_long_bid=0, detection_long_ask=0,
        detection_short_quote_age_ms=0, detection_long_quote_age_ms=0,
        detection_funding_short=0, detection_funding_long=0,
        detection_short_healthy=True, detection_long_healthy=True,
    )
    portfolio.diagnostics[3] = TradeDiagnostic(
        position_id=3, decided_at_ms=0,
        detection_short_bid=0, detection_short_ask=0,
        detection_long_bid=0, detection_long_ask=0,
        detection_short_quote_age_ms=0, detection_long_quote_age_ms=0,
        detection_funding_short=0, detection_funding_long=0,
        detection_short_healthy=True, detection_long_healthy=True,
    )
    # Add only position 1 to portfolio (positions 2 and 3 are orphans)
    from real_trader import LivePosition
    portfolio.positions.append(LivePosition(
        id=1, symbol="X", exchange_short="A", exchange_long="B",
        instrument_short="PERP", instrument_long="PERP",
        entry_spread_pct=1.0, entry_price_short=1.0, entry_price_long=1.0,
        size_usd=10.0, entry_time=datetime.now(timezone.utc),
    ))

    with tempfile.TemporaryDirectory() as td:
        path = os.path.join(td, "real_state.json")
        trader = LiveTrader.__new__(LiveTrader)
        trader.state_path = path
        trader.portfolio = portfolio
        trader.pair_stats = {}
        trader.equity_history = []
        trader.symbol_blacklist = {}
        trader.risk_mgr = type("RM", (), {"balance_cache": {}, "kill_switch_active": False})()
        trader.trade_executor = type("TE", (), {"order_audit_log": []})()
        trader._save_state()

        # Reload and check
        with open(path) as f:
            saved = json.load(f)
        # Only diag 1 should remain (position 1 is in positions)
        assert set(saved["diagnostics"].keys()) == {"1"}
