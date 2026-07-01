"""Tests for the /api/diagnostics dashboard route."""
import json
import os
import tempfile

import pytest

# Import dashboard module — Flask app is at module scope.
import dashboard


@pytest.fixture
def client(monkeypatch):
    """Flask test client with a temp DATA_DIR and disabled auth."""
    td = tempfile.TemporaryDirectory()
    monkeypatch.setattr(dashboard, "DATA_DIR", td.name)

    # Bypass basic-auth for tests.
    def noop_auth(f):
        return f
    monkeypatch.setattr(dashboard, "check_auth", noop_auth)
    # Force-rebuild the route binding by re-decorating — easier to just
    # set DASHBOARD_PASSWORD to empty and pass matching credentials.
    monkeypatch.setattr(dashboard, "DASHBOARD_PASSWORD", "test")

    dashboard.app.config["TESTING"] = True
    c = dashboard.app.test_client()
    yield c, td.name
    td.cleanup()


def _auth_headers():
    # Basic auth: "user:test" -> base64("user:test")
    import base64
    return {"Authorization": "Basic " + base64.b64encode(b"user:test").decode()}


def _write_state(data_dir, state):
    with open(os.path.join(data_dir, "real_state.json"), "w") as f:
        json.dump(state, f)


# ---------------------------------------------------------------------------
# Empty / missing state
# ---------------------------------------------------------------------------


def test_diagnostics_returns_empty_when_state_missing(client):
    c, _ = client
    r = c.get("/api/diagnostics", headers=_auth_headers())
    assert r.status_code == 200
    d = r.get_json()
    assert d["summary"] == {}
    assert d["trades"] == []


def test_diagnostics_returns_empty_when_no_diagnostics_in_state(client):
    c, td = client
    _write_state(td, {
        "closed_positions": [
            {"id": 1, "symbol": "X", "net_pnl_usd": 0.5},
        ],
        # No "diagnostics" key — older state file
    })
    r = c.get("/api/diagnostics", headers=_auth_headers())
    d = r.get_json()
    assert d["trades"] == []
    assert d["summary"]["n_trades_with_diagnostics"] == 0


# ---------------------------------------------------------------------------
# Joined view — basic shape
# ---------------------------------------------------------------------------


def test_diagnostics_joins_position_with_diagnostic(client):
    c, td = client
    _write_state(td, {
        "closed_positions": [{
            "id": 530, "symbol": "ENJUSDT",
            "exchange_short": "BloFin", "exchange_long": "MEXC",
            "entry_time": "2026-04-24T14:06:00Z",
            "net_pnl_usd": -0.03,
            "realized_entry_spread_pct": -0.16,
            "exit_reason": "dynamic_exit",
        }],
        "diagnostics": {
            "530": {
                "position_id": 530,
                "short_pnl_usd": -0.05,
                "long_pnl_usd": 0.02,
                "short_entry_slippage_usd": 0.092,
                "long_entry_slippage_usd": 0.0,
                "short_exit_slippage_usd": 0.0,
                "long_exit_slippage_usd": 0.0,
                "funding_paid_short_usd": 0.0,
                "funding_paid_long_usd": 0.0,
                "hold_minutes": 0.13,
                "detection_short_quote_age_ms": 250,
                "detection_long_quote_age_ms": 100,
                "exit_realized_spread_pct": 0.04,
                "candidate_score": 0.85,
                "candidate_rank": 1,
            },
        },
    })

    r = c.get("/api/diagnostics", headers=_auth_headers())
    d = r.get_json()
    assert len(d["trades"]) == 1
    t = d["trades"][0]
    assert t["id"] == 530
    assert t["symbol"] == "ENJUSDT"
    assert t["net_pnl_usd"] == pytest.approx(-0.03)
    assert t["short_pnl_usd"] == pytest.approx(-0.05)
    assert t["long_pnl_usd"] == pytest.approx(0.02)
    assert t["entry_slippage_usd"] == pytest.approx(0.092)  # sum of legs
    assert t["max_quote_age_ms"] == 250                     # max of legs
    assert t["realized_entry_spread_pct"] == pytest.approx(-0.16)


# ---------------------------------------------------------------------------
# Summary aggregates
# ---------------------------------------------------------------------------


def test_diagnostics_summary_aggregates_correctly(client):
    c, td = client
    _write_state(td, {
        "closed_positions": [
            {"id": 1, "symbol": "A", "realized_entry_spread_pct": 0.5,
             "net_pnl_usd": 1.0, "exit_reason": "convergence"},
            {"id": 2, "symbol": "B", "realized_entry_spread_pct": -0.16,
             "net_pnl_usd": -0.03, "exit_reason": "dynamic_exit"},
            {"id": 3, "symbol": "C", "realized_entry_spread_pct": 0.3,
             "net_pnl_usd": 0.5, "exit_reason": "convergence"},
        ],
        "diagnostics": {
            "1": {
                "short_entry_slippage_usd": 0.05,
                "long_entry_slippage_usd": 0.05,
                "short_exit_slippage_usd": 0.01,
                "long_exit_slippage_usd": 0.01,
                "funding_paid_short_usd": -0.01,
                "funding_paid_long_usd": 0.01,
                "detection_short_quote_age_ms": 200,
                "detection_long_quote_age_ms": 300,
                "short_pnl_usd": 0.6,
                "long_pnl_usd": 0.4,
            },
            "2": {  # Trade #530-style: stale quote, negative realized, asymmetric PnL
                "short_entry_slippage_usd": 0.10,
                "long_entry_slippage_usd": 0.0,
                "short_exit_slippage_usd": 0.0,
                "long_exit_slippage_usd": 0.0,
                "funding_paid_short_usd": 0.0,
                "funding_paid_long_usd": 0.0,
                "detection_short_quote_age_ms": 6000,  # stale (> 5s)
                "detection_long_quote_age_ms": 100,
                "short_pnl_usd": -0.05,
                "long_pnl_usd": 0.02,                  # opposite sign = asymmetric
            },
            "3": {
                "short_entry_slippage_usd": 0.0,
                "long_entry_slippage_usd": 0.0,
                "short_exit_slippage_usd": 0.0,
                "long_exit_slippage_usd": 0.0,
                "funding_paid_short_usd": 0.0,
                "funding_paid_long_usd": 0.0,
                "detection_short_quote_age_ms": 50,
                "detection_long_quote_age_ms": 50,
                "short_pnl_usd": 0.25,
                "long_pnl_usd": 0.25,                  # same sign = symmetric
            },
        },
    })

    r = c.get("/api/diagnostics", headers=_auth_headers())
    s = r.get_json()["summary"]
    assert s["n_trades_with_diagnostics"] == 3
    # Sum of all legs across all trades:
    # entry: 0.05+0.05+0.10+0+0+0 = 0.20
    assert s["total_entry_slippage_usd"] == pytest.approx(0.20)
    # exit: 0.01+0.01+0+0+0+0 = 0.02
    assert s["total_exit_slippage_usd"] == pytest.approx(0.02)
    # funding: -0.01+0.01+0+0+0+0 = 0
    assert s["total_funding_paid_usd"] == pytest.approx(0.0)
    # Trade #2 has 6000ms quote age (only one)
    assert s["stale_quote_count"] == 1
    # Trade #2 has negative realized_entry (-0.16)
    assert s["negative_realized_entry_count"] == 1
    # Trade #2 has opposite-sign per-leg PnL (-0.05 vs +0.02)
    assert s["asymmetric_pnl_count"] == 1


# ---------------------------------------------------------------------------
# Skipping behavior
# ---------------------------------------------------------------------------


def test_diagnostics_skips_positions_without_diagnostic(client):
    """Trades that closed before the diagnostic feature shipped should not
    be rendered as half-empty rows; they're omitted entirely."""
    c, td = client
    _write_state(td, {
        "closed_positions": [
            {"id": 1, "symbol": "OLD", "net_pnl_usd": 0.5},
            {"id": 2, "symbol": "NEW", "net_pnl_usd": 0.3},
        ],
        "diagnostics": {
            "2": {
                "short_pnl_usd": 0.15, "long_pnl_usd": 0.15,
                "short_entry_slippage_usd": 0,
                "long_entry_slippage_usd": 0,
                "short_exit_slippage_usd": 0,
                "long_exit_slippage_usd": 0,
                "funding_paid_short_usd": 0,
                "funding_paid_long_usd": 0,
                "detection_short_quote_age_ms": 0,
                "detection_long_quote_age_ms": 0,
            },
        },
    })

    r = c.get("/api/diagnostics", headers=_auth_headers())
    d = r.get_json()
    assert len(d["trades"]) == 1
    assert d["trades"][0]["symbol"] == "NEW"


def test_diagnostics_orders_most_recent_first(client):
    """Closed positions are typically appended in close-time order; the
    route reverses to put most recent first — matches the existing dashboard
    convention for closed positions."""
    c, td = client
    _write_state(td, {
        "closed_positions": [
            {"id": 1, "symbol": "FIRST", "net_pnl_usd": 0},
            {"id": 2, "symbol": "MIDDLE", "net_pnl_usd": 0},
            {"id": 3, "symbol": "LAST", "net_pnl_usd": 0},
        ],
        "diagnostics": {
            str(i): {
                "short_pnl_usd": 0, "long_pnl_usd": 0,
                "short_entry_slippage_usd": 0, "long_entry_slippage_usd": 0,
                "short_exit_slippage_usd": 0, "long_exit_slippage_usd": 0,
                "funding_paid_short_usd": 0, "funding_paid_long_usd": 0,
                "detection_short_quote_age_ms": 0, "detection_long_quote_age_ms": 0,
            } for i in (1, 2, 3)
        },
    })

    r = c.get("/api/diagnostics", headers=_auth_headers())
    symbols = [t["symbol"] for t in r.get_json()["trades"]]
    assert symbols == ["LAST", "MIDDLE", "FIRST"]
