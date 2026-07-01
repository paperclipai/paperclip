"""Tests for the realized-entry-spread guard added in real_trader.py.

Covers:
1. The pure helper compute_realized_entry_spread_pct.
2. The LivePosition.realized_entry_spread_pct field's persistence
   round-trip via _pos_to_dict / _pos_from_dict.

The full open_position bad-fill abort path is not unit-tested here
(would require mocking the executor + portfolio + risk manager), but
the serialization round-trip + math check together pin down the
behavior the guard depends on.
"""
import pytest


def test_realized_spread_positive_when_short_above_long():
    """Normal convergence trade: short fill is higher than long fill."""
    from real_trader import compute_realized_entry_spread_pct
    # SHORT at 1.005, LONG at 1.000 → +0.5% realized spread (good fill)
    assert compute_realized_entry_spread_pct(1.005, 1.000) == pytest.approx(0.5)


def test_realized_spread_negative_when_short_below_long():
    """Bug case: orders crossed, SHORT filled cheaper than LONG."""
    from real_trader import compute_realized_entry_spread_pct
    # SHORT at 0.998, LONG at 1.000 → -0.2% realized
    assert compute_realized_entry_spread_pct(0.998, 1.000) == pytest.approx(-0.2)


def test_realized_spread_matches_screenshot_trade_530():
    """Reproduce the -0.16% from the dashboard screenshot.

    For trade 530 (ENJUSDT BloFin/MEXC) the dashboard showed -0.16%.
    Pick prices that yield the same result so we have a regression peg.
    """
    from real_trader import compute_realized_entry_spread_pct
    # Concrete prices that give exactly -0.16%
    # short=0.99840 long=1.00000 → -0.16%
    assert compute_realized_entry_spread_pct(0.9984, 1.0000) == pytest.approx(-0.16)


def test_realized_spread_zero_when_long_price_invalid():
    """Degenerate input — return 0.0 rather than fabricate / divide-by-zero."""
    from real_trader import compute_realized_entry_spread_pct
    assert compute_realized_entry_spread_pct(1.0, 0.0) == 0.0
    assert compute_realized_entry_spread_pct(1.0, -1.0) == 0.0


def test_realized_spread_zero_when_prices_equal():
    """Equal prices = 0% spread; not negative."""
    from real_trader import compute_realized_entry_spread_pct
    assert compute_realized_entry_spread_pct(1.234, 1.234) == 0.0


def test_live_position_round_trip_preserves_realized_spread():
    """_pos_to_dict and _pos_from_dict must round-trip the new field."""
    from datetime import datetime, timezone
    from real_trader import LivePosition, LiveTrader

    pos = LivePosition(
        id=999, symbol="TESTUSDT",
        exchange_short="BloFin", exchange_long="MEXC",
        instrument_short="PERP", instrument_long="PERP",
        entry_spread_pct=0.95,
        entry_price_short=0.9984,
        entry_price_long=1.0000,
        realized_entry_spread_pct=-0.16,
        size_usd=18.36,
        entry_time=datetime(2026, 4, 24, 14, 6, 8, tzinfo=timezone.utc),
    )
    # _pos_to_dict and _pos_from_dict are bound methods; build a minimal
    # caller. They don't touch self other than as a namespace, so we can
    # invoke via an unbound-style call.
    d = LiveTrader._pos_to_dict(None, pos)
    assert d["realized_entry_spread_pct"] == pytest.approx(-0.16)

    pos2 = LiveTrader._pos_from_dict(None, d)
    assert pos2.realized_entry_spread_pct == pytest.approx(-0.16)
    assert pos2.entry_spread_pct == pytest.approx(0.95)
    assert pos2.entry_price_short == pytest.approx(0.9984)
    assert pos2.entry_price_long == pytest.approx(1.0000)


def test_live_position_loads_legacy_state_without_field():
    """Loading a state.json from before this commit must not crash; the
    missing realized_entry_spread_pct should default to 0.0."""
    from real_trader import LiveTrader

    legacy = {
        "id": 1, "symbol": "OLDUSDT", "status": "CLOSED",
        "exchange_short": "MEXC", "exchange_long": "BloFin",
        "instrument_short": "PERP", "instrument_long": "PERP",
        "entry_spread_pct": 0.95,
        "entry_price_short": 1.005,
        "entry_price_long": 1.000,
        "size_usd": 18.36,
        "entry_time": "2026-04-20T10:00:00+00:00",
        # NOTE: no realized_entry_spread_pct
    }
    pos = LiveTrader._pos_from_dict(None, legacy)
    assert pos.realized_entry_spread_pct == 0.0
    assert pos.entry_spread_pct == pytest.approx(0.95)
