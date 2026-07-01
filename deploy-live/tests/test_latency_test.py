"""Tests for latency_test.py helpers (no network)."""
import asyncio

import pytest

from latency_test import summarize, format_table, measure_one, measure_exchange


# ---------------------------------------------------------------------------
# summarize()
# ---------------------------------------------------------------------------


def test_summarize_empty_returns_zeros():
    s = summarize([])
    assert s == {"min": 0.0, "p50": 0.0, "p95": 0.0, "max": 0.0, "mean": 0.0}


def test_summarize_single_sample():
    s = summarize([42.0])
    assert s == {"min": 42.0, "p50": 42.0, "p95": 42.0, "max": 42.0, "mean": 42.0}


def test_summarize_basic_distribution():
    """20 samples 10..200 in steps of 10."""
    s = summarize([float(x) for x in range(10, 210, 10)])
    assert s["min"] == 10.0
    assert s["max"] == 200.0
    assert s["p50"] == 105.0
    # p95 = nearest-rank with n=20: index = 20 * 0.95 - 1 = 18, so timings[18] = 190
    assert s["p95"] == 190.0
    assert s["mean"] == pytest.approx(105.0)


def test_summarize_unsorted_input():
    """Implementation must sort internally."""
    s = summarize([3.0, 1.0, 2.0])
    assert s["min"] == 1.0
    assert s["max"] == 3.0
    assert s["p50"] == 2.0


# ---------------------------------------------------------------------------
# format_table()
# ---------------------------------------------------------------------------


def test_format_table_renders_summary_line_per_exchange():
    results = {
        "OKX": {"timings": [50.0, 60.0, 70.0], "failures": []},
        "MEXC": {"timings": [100.0, 110.0], "failures": ["timeout"]},
    }
    out = format_table(results)
    assert "OKX" in out
    assert "MEXC" in out
    # Header row
    assert "Exchange" in out
    assert "Samples" in out
    assert "OK%" in out
    # MEXC has 1 failure → 67% OK
    assert "67%" in out
    # Failure label visible
    assert "timeout" in out


def test_format_table_handles_all_failed_exchange():
    results = {"BloFin": {"timings": [], "failures": ["timeout", "timeout", "ConnectionError"]}}
    out = format_table(results)
    assert "BloFin" in out
    assert "all failed" in out
    # Should show some of the failure types
    assert "timeout" in out


def test_format_table_handles_completely_empty():
    """A run that never made it to any sample (e.g., main() crashed early)."""
    results = {"OKX": {"timings": [], "failures": []}}
    out = format_table(results)
    assert "no samples" in out


# ---------------------------------------------------------------------------
# measure_one() — mock the session
# ---------------------------------------------------------------------------


class _FakeResponse:
    def __init__(self, status):
        self.status = status

    async def read(self):
        return b""

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


class _FakeSession:
    """Minimal aiohttp.ClientSession look-alike."""

    def __init__(self, *, status=200, raise_=None, sleep=0.0):
        self._status = status
        self._raise = raise_
        self._sleep = sleep

    def get(self, url, **kw):
        return self._do_get()

    def _do_get(self):
        sess = self

        class _Cm:
            async def __aenter__(self_inner):
                if sess._raise:
                    raise sess._raise
                if sess._sleep:
                    await asyncio.sleep(sess._sleep)
                return _FakeResponse(sess._status)

            async def __aexit__(self_inner, *a):
                return False

        return _Cm()


def test_measure_one_returns_latency_and_status_on_success():
    async def _go():
        sess = _FakeSession(status=200, sleep=0.05)  # 50ms
        ms, status = await measure_one(sess, "http://x", timeout_s=5.0)
        assert status == 200
        assert ms is not None
        # Should be at least the sleep duration; allow generous upper bound
        # for scheduler noise.
        assert 40.0 <= ms < 500.0
    asyncio.run(_go())


def test_measure_one_returns_none_on_timeout():
    async def _go():
        sess = _FakeSession(raise_=asyncio.TimeoutError())
        ms, label = await measure_one(sess, "http://x", timeout_s=1.0)
        assert ms is None
        assert label == "timeout"
    asyncio.run(_go())


def test_measure_one_classifies_aiohttp_client_error():
    """ClientError subclass should produce a labelled failure, not crash."""
    import aiohttp
    async def _go():
        sess = _FakeSession(raise_=aiohttp.ClientConnectionError("refused"))
        ms, label = await measure_one(sess, "http://x", timeout_s=1.0)
        assert ms is None
        assert "ClientConnectionError" in label
    asyncio.run(_go())


# ---------------------------------------------------------------------------
# measure_exchange() — orchestration
# ---------------------------------------------------------------------------


def test_measure_exchange_collects_timings_and_failures():
    """Two successes followed by a timeout — both lists populated correctly."""
    call_log = []

    class _MixedSession:
        def get(self, url, **kw):
            sess = self

            class _Cm:
                async def __aenter__(self_inner):
                    call_log.append(url)
                    if len(call_log) <= 2:
                        await asyncio.sleep(0.01)  # 10ms success
                        return _FakeResponse(200)
                    raise asyncio.TimeoutError()

                async def __aexit__(self_inner, *a):
                    return False

            return _Cm()

    async def _go():
        result = await measure_exchange(
            _MixedSession(), "OKX", "http://x", samples=3,
            timeout_s=5.0, sleep_s=0.0,
        )
        assert len(result["timings"]) == 2
        assert result["failures"] == ["timeout"]
        # All timings should be in a reasonable range
        assert all(5.0 <= t < 500.0 for t in result["timings"])
    asyncio.run(_go())


def test_measure_exchange_records_http_4xx_5xx_as_failure_with_latency():
    """An HTTP 503 has a real round-trip, but operationally we want it
    classified as a failure (the exchange isn't usable). Latency is NOT
    recorded in 'timings' — only successes go there. The failure label
    distinguishes 'http_503' from 'timeout'."""
    class _503Session:
        def get(self, url, **kw):
            class _Cm:
                async def __aenter__(self_inner):
                    await asyncio.sleep(0.01)
                    return _FakeResponse(503)

                async def __aexit__(self_inner, *a):
                    return False

            return _Cm()

    async def _go():
        result = await measure_exchange(
            _503Session(), "MEXC", "http://x", samples=3,
            timeout_s=5.0, sleep_s=0.0,
        )
        assert result["timings"] == []
        assert all(f.startswith("http_5") for f in result["failures"])
    asyncio.run(_go())
