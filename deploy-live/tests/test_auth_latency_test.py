"""Tests for auth_latency_test.py helpers (no network, no real keys)."""
import os

import pytest

import auth_latency_test as alt


# ---------------------------------------------------------------------------
# Skip behavior — no keys configured
# ---------------------------------------------------------------------------


def test_builders_return_none_when_keys_missing(monkeypatch):
    """All seven builders return None when no env vars are set."""
    # Strip every relevant env var
    for var in ["OKX_API_KEY", "OKX_API_SECRET", "OKX_PASSPHRASE",
                "BYBIT_API_KEY", "BYBIT_API_SECRET",
                "MEXC_API_KEY", "MEXC_API_SECRET",
                "BLOFIN_API_KEY", "BLOFIN_API_SECRET", "BLOFIN_PASSPHRASE",
                "BINANCE_API_KEY", "BINANCE_API_SECRET",
                "GATEIO_API_KEY", "GATEIO_API_SECRET",
                "BITGET_API_KEY", "BITGET_API_SECRET", "BITGET_PASSPHRASE"]:
        monkeypatch.delenv(var, raising=False)

    assert alt.build_okx() is None
    assert alt.build_bybit() is None
    assert alt.build_mexc() is None
    assert alt.build_blofin() is None
    assert alt.build_binance() is None
    assert alt.build_gateio() is None
    assert alt.build_bitget() is None


def test_okx_builder_returns_none_when_only_partial_keys(monkeypatch):
    """OKX needs three creds; missing any one means skip."""
    monkeypatch.setenv("OKX_API_KEY", "x")
    monkeypatch.setenv("OKX_API_SECRET", "y")
    # No passphrase
    monkeypatch.delenv("OKX_PASSPHRASE", raising=False)
    assert alt.build_okx() is None


def test_okx_builder_returns_signed_request_when_all_keys_present(monkeypatch):
    monkeypatch.setenv("OKX_API_KEY", "test-key")
    monkeypatch.setenv("OKX_API_SECRET", "test-secret")
    monkeypatch.setenv("OKX_PASSPHRASE", "test-pass")
    req = alt.build_okx()
    assert req is not None
    method, url, headers, body = req
    assert method == "GET"
    assert "okx.com" in url
    assert headers["OK-ACCESS-KEY"] == "test-key"
    assert headers["OK-ACCESS-PASSPHRASE"] == "test-pass"
    assert "OK-ACCESS-SIGN" in headers
    assert "OK-ACCESS-TIMESTAMP" in headers


def test_binance_builder_returns_url_with_signature(monkeypatch):
    monkeypatch.setenv("BINANCE_API_KEY", "test-key")
    monkeypatch.setenv("BINANCE_API_SECRET", "test-secret")
    req = alt.build_binance()
    assert req is not None
    method, url, headers, _ = req
    assert method == "GET"
    assert "fapi.binance.com" in url
    # Binance puts the signature in the query string
    assert "signature=" in url
    assert "timestamp=" in url
    assert headers["X-MBX-APIKEY"] == "test-key"


def test_gateio_builder_returns_signed_headers(monkeypatch):
    monkeypatch.setenv("GATEIO_API_KEY", "k")
    monkeypatch.setenv("GATEIO_API_SECRET", "s")
    req = alt.build_gateio()
    assert req is not None
    method, url, headers, _ = req
    assert "gateio.ws" in url
    assert headers["KEY"] == "k"
    assert "SIGN" in headers
    assert "Timestamp" in headers


def test_bitget_builder_includes_passphrase(monkeypatch):
    monkeypatch.setenv("BITGET_API_KEY", "k")
    monkeypatch.setenv("BITGET_API_SECRET", "s")
    monkeypatch.setenv("BITGET_PASSPHRASE", "p")
    req = alt.build_bitget()
    assert req is not None
    _, _, headers, _ = req
    assert headers["ACCESS-KEY"] == "k"
    assert headers["ACCESS-PASSPHRASE"] == "p"
    assert "ACCESS-SIGN" in headers


# ---------------------------------------------------------------------------
# Stats helpers (re-using same shape as latency_test)
# ---------------------------------------------------------------------------


def test_summarize_empty():
    s = alt.summarize([])
    assert s["min"] == 0.0 and s["max"] == 0.0


def test_summarize_basic():
    s = alt.summarize([10.0, 50.0, 90.0])
    assert s["min"] == 10.0
    assert s["max"] == 90.0
    assert s["p50"] == 50.0


# ---------------------------------------------------------------------------
# Format table — auth-failure label distinct from timeout
# ---------------------------------------------------------------------------


def test_format_table_distinguishes_auth_failures_from_timeouts():
    results = {
        "OKX":   {"timings": [50.0, 60.0], "failures": ["auth_401"]},
        "Bybit": {"timings": [], "failures": ["timeout", "timeout"]},
    }
    out = alt.format_table(results, skipped=["Binance"])
    assert "OKX" in out
    assert "Bybit" in out
    assert "auth_401" in out
    assert "timeout" in out
    # Skipped section is rendered
    assert "Skipped" in out
    assert "Binance" in out


# ---------------------------------------------------------------------------
# Run() short-circuits when no exchange has credentials
# ---------------------------------------------------------------------------


def test_run_returns_empty_when_no_credentials_anywhere(monkeypatch):
    """If absolutely no exchange has API keys, run() returns empty results
    + the full list of skipped exchanges, without making any network calls."""
    # Strip every credential
    for var in ["OKX_API_KEY", "OKX_API_SECRET", "OKX_PASSPHRASE",
                "BYBIT_API_KEY", "BYBIT_API_SECRET",
                "MEXC_API_KEY", "MEXC_API_SECRET",
                "BLOFIN_API_KEY", "BLOFIN_API_SECRET", "BLOFIN_PASSPHRASE",
                "BINANCE_API_KEY", "BINANCE_API_SECRET",
                "GATEIO_API_KEY", "GATEIO_API_SECRET",
                "BITGET_API_KEY", "BITGET_API_SECRET", "BITGET_PASSPHRASE"]:
        monkeypatch.delenv(var, raising=False)

    import asyncio
    results, skipped = asyncio.run(alt.run(samples=1, timeout_s=1.0, sleep_s=0.0))
    assert results == {}
    assert set(skipped) == {"OKX", "Bybit", "MEXC", "BloFin"}


def test_run_with_candidates_lists_them_in_skipped(monkeypatch):
    for var in ["OKX_API_KEY", "OKX_API_SECRET", "OKX_PASSPHRASE",
                "BYBIT_API_KEY", "BYBIT_API_SECRET",
                "MEXC_API_KEY", "MEXC_API_SECRET",
                "BLOFIN_API_KEY", "BLOFIN_API_SECRET", "BLOFIN_PASSPHRASE",
                "BINANCE_API_KEY", "BINANCE_API_SECRET",
                "GATEIO_API_KEY", "GATEIO_API_SECRET",
                "BITGET_API_KEY", "BITGET_API_SECRET", "BITGET_PASSPHRASE"]:
        monkeypatch.delenv(var, raising=False)

    import asyncio
    _, skipped = asyncio.run(alt.run(
        samples=1, timeout_s=1.0, sleep_s=0.0, include_candidates=True
    ))
    assert {"Binance", "Gate.io", "Bitget"}.issubset(set(skipped))
