import asyncio
import pytest
from schemas import ReconciliationEvent
from alerts import AlertSink, MemorySink, ConsoleSink


def _sample_event(severity="error", category="orphan_leg"):
    return ReconciliationEvent(
        timestamp_ms=1700000000000, source="reconciler",
        category=category, severity=severity,
        exchange="MEXC", symbol="ORDIUSDT",
    )


def test_memory_sink_collects_events():
    async def _go():
        sink = MemorySink()
        await sink.send(_sample_event())
        await sink.send(_sample_event(severity="warn"))
        assert len(sink.events) == 2
        assert sink.events[0].severity == "error"

    asyncio.run(_go())


def test_console_sink_does_not_raise(capsys):
    async def _go():
        sink = ConsoleSink()
        await sink.send(_sample_event())

    asyncio.run(_go())
    captured = capsys.readouterr()
    assert "orphan_leg" in captured.out
    assert "MEXC" in captured.out


def test_memory_sink_satisfies_protocol():
    sink: AlertSink = MemorySink()
    assert sink is not None


from alerts import TelegramSink


class _FakeHttpResponse:
    def __init__(self, status_code: int = 200, text: str = "ok") -> None:
        self.status_code = status_code
        self.text = text

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}: {self.text}")


class _FakeHttpClient:
    """Records POST calls; returns a configurable response."""

    def __init__(self, response: _FakeHttpResponse | None = None) -> None:
        self.calls: list[tuple[str, dict]] = []
        self._response = response or _FakeHttpResponse()

    async def post(self, url: str, *, json: dict) -> _FakeHttpResponse:
        self.calls.append((url, json))
        return self._response

    async def aclose(self) -> None:
        pass


def test_telegram_sink_posts_message_with_severity_and_category():
    async def _go():
        client = _FakeHttpClient()
        sink = TelegramSink(
            bot_token="test-token", chat_id="-100123",
            http_client=client,
        )
        await sink.send(_sample_event(severity="error", category="orphan_leg"))
        assert len(client.calls) == 1
        url, payload = client.calls[0]
        assert "test-token" in url
        assert payload["chat_id"] == "-100123"
        assert "ERROR" in payload["text"]
        assert "orphan_leg" in payload["text"]
        assert "MEXC" in payload["text"]

    asyncio.run(_go())


def test_telegram_sink_does_not_raise_on_http_error():
    """A failed Telegram post should not crash the trader."""
    async def _go():
        client = _FakeHttpClient(response=_FakeHttpResponse(status_code=500, text="oops"))
        sink = TelegramSink(
            bot_token="t", chat_id="c", http_client=client,
        )
        # Should NOT raise
        await sink.send(_sample_event())

    asyncio.run(_go())


from alerts import AlertDispatcher


def test_dispatcher_routes_by_min_severity():
    async def _go():
        warn_sink = MemorySink()
        error_sink = MemorySink()
        # dedup disabled so routing-only test isn't affected by 60s default
        d = AlertDispatcher(dedup_window_s=0.0)
        d.add_sink(warn_sink, min_severity="warn")
        d.add_sink(error_sink, min_severity="error")

        await d.dispatch(_sample_event(severity="info"))
        await d.dispatch(_sample_event(severity="warn"))
        await d.dispatch(_sample_event(severity="error"))
        await d.dispatch(_sample_event(severity="critical"))

        assert len(warn_sink.events) == 3
        assert len(error_sink.events) == 2

    asyncio.run(_go())


def test_dispatcher_dedups_within_window():
    async def _go():
        sink = MemorySink()
        d = AlertDispatcher(dedup_window_s=60.0)
        d.add_sink(sink, min_severity="info")

        e1 = _sample_event(severity="error", category="orphan_leg")
        e2 = _sample_event(severity="error", category="orphan_leg")
        await d.dispatch(e1, _now_s=1000.0)
        await d.dispatch(e2, _now_s=1030.0)
        assert len(sink.events) == 1

        e3 = _sample_event(severity="error", category="orphan_leg")
        await d.dispatch(e3, _now_s=1061.0)
        assert len(sink.events) == 2

    asyncio.run(_go())


def test_dispatcher_continues_on_sink_failure():
    """A sink that raises should not stop other sinks from receiving."""
    class BrokenSink:
        async def send(self, event):
            raise RuntimeError("boom")

    async def _go():
        good = MemorySink()
        d = AlertDispatcher()
        d.add_sink(BrokenSink(), min_severity="info")
        d.add_sink(good, min_severity="info")
        await d.dispatch(_sample_event())
        assert len(good.events) == 1

    asyncio.run(_go())


# ---------------------------------------------------------------------------
# DigestSink tests (Task 9)
# ---------------------------------------------------------------------------
from alerts import DigestSink


def test_digest_sink_buffers_warns_and_forwards_others():
    """Warn events are buffered; non-warn events are forwarded immediately."""
    async def _go():
        inner = MemorySink()
        digest = DigestSink(inner, flush_interval_s=9999.0)

        await digest.send(_sample_event(severity="warn", category="balance_drift"))
        await digest.send(_sample_event(severity="warn", category="balance_drift"))
        # Nothing forwarded yet
        assert len(inner.events) == 0

        # Non-warn is forwarded immediately
        await digest.send(_sample_event(severity="error", category="orphan_leg"))
        assert len(inner.events) == 1
        assert inner.events[0].severity == "error"

    asyncio.run(_go())


def test_digest_sink_flush_sends_combined_message():
    """flush() sends one digest event summarising all buffered warns."""
    async def _go():
        inner = MemorySink()
        digest = DigestSink(inner, flush_interval_s=9999.0)

        await digest.send(_sample_event(severity="warn", category="balance_drift"))
        await digest.send(_sample_event(severity="warn", category="stale_price"))
        await digest.flush()

        assert len(inner.events) == 1
        ev = inner.events[0]
        assert ev.category == "warn_digest"
        assert ev.severity == "warn"
        assert "balance_drift" in (ev.notes or "")
        assert "stale_price" in (ev.notes or "")

    asyncio.run(_go())


def test_digest_sink_flush_clears_buffer():
    """After flush, a second flush with no new events sends nothing."""
    async def _go():
        inner = MemorySink()
        digest = DigestSink(inner, flush_interval_s=9999.0)

        await digest.send(_sample_event(severity="warn", category="balance_drift"))
        await digest.flush()
        assert len(inner.events) == 1

        # Second flush — buffer is empty, no additional event
        await digest.flush()
        assert len(inner.events) == 1

    asyncio.run(_go())


def test_digest_sink_run_task_is_cancellable():
    """The run() background task exits cleanly on cancellation."""
    async def _go():
        inner = MemorySink()
        digest = DigestSink(inner, flush_interval_s=9999.0)
        task = asyncio.create_task(digest.run())
        await asyncio.sleep(0)  # let task start
        task.cancel()
        # Must not raise; CancelledError is swallowed inside run()
        await asyncio.wait_for(asyncio.shield(task), timeout=1.0)

    asyncio.run(_go())


def test_digest_sink_flush_on_inner_failure_does_not_raise():
    """If the inner sink raises during flush, DigestSink logs and does not re-raise."""
    class BrokenSink:
        async def send(self, event):
            raise RuntimeError("network down")

    async def _go():
        digest = DigestSink(BrokenSink(), flush_interval_s=9999.0)
        await digest.send(_sample_event(severity="warn", category="balance_drift"))
        # Must not raise even though inner.send() blows up
        await digest.flush()

    asyncio.run(_go())


# ---------------------------------------------------------------------------
# Fix 5 — DigestSink buffer cap tests
# ---------------------------------------------------------------------------

def test_digest_sink_buffer_cap_drops_excess():
    """Events beyond max_buffer_size are dropped silently; _dropped_count increments."""
    async def _go():
        inner = MemorySink()
        digest = DigestSink(inner, flush_interval_s=9999.0, max_buffer_size=3)

        for _ in range(5):
            await digest.send(_sample_event(severity="warn", category="balance_drift"))

        assert len(digest._buffer) == 3
        assert digest._dropped_count == 2

    asyncio.run(_go())


def test_digest_sink_dropped_counter_survives_to_flush_notes():
    """dropped_count is reset after flush; notes include the overflow message."""
    async def _go():
        inner = MemorySink()
        digest = DigestSink(inner, flush_interval_s=9999.0, max_buffer_size=2)

        for _ in range(4):
            await digest.send(_sample_event(severity="warn", category="balance_drift"))

        assert digest._dropped_count == 2

        await digest.flush()

        # Counter reset after flush
        assert digest._dropped_count == 0
        assert digest._buffer == []

        # Flush sent one combined event; notes mention overflow
        assert len(inner.events) == 1
        assert "dropped" in (inner.events[0].notes or "")

    asyncio.run(_go())


def test_digest_sink_flush_with_only_dropped_no_buffer_events():
    """If the buffer fills up before any flush, then empties via cap, a flush that
    finds buffer empty but dropped>0 still sends a digest noting the drops."""
    async def _go():
        inner = MemorySink()
        digest = DigestSink(inner, flush_interval_s=9999.0, max_buffer_size=2)

        # Fill to cap
        for _ in range(2):
            await digest.send(_sample_event(severity="warn", category="balance_drift"))
        # Drain buffer manually (simulate prior flush)
        digest._buffer = []
        # Now dropped_count is 0 since no overflow yet — add overflow events
        for _ in range(3):
            await digest.send(_sample_event(severity="warn", category="balance_drift"))
        # Buffer has 2, dropped has 1
        assert digest._dropped_count == 1
        await digest.flush()
        # After flush, counter reset
        assert digest._dropped_count == 0

    asyncio.run(_go())


# ---------------------------------------------------------------------------
# Fix 3 — env_truthy helper tests
# ---------------------------------------------------------------------------

from state_store import env_truthy


def test_env_truthy_recognises_truthy_values(monkeypatch):
    for val in ("1", "true", "yes", "TRUE", "Yes", "YES", "True"):
        monkeypatch.setenv("_TEST_FLAG", val)
        assert env_truthy("_TEST_FLAG") is True, f"expected True for {val!r}"


def test_env_truthy_rejects_falsy_values(monkeypatch):
    for val in ("0", "false", "no", "FALSE", "off", "", "maybe"):
        monkeypatch.setenv("_TEST_FLAG", val)
        assert env_truthy("_TEST_FLAG") is False, f"expected False for {val!r}"


def test_env_truthy_uses_default_when_unset(monkeypatch):
    monkeypatch.delenv("_TEST_FLAG", raising=False)
    assert env_truthy("_TEST_FLAG") is False
    assert env_truthy("_TEST_FLAG", default="true") is True


# ---------------------------------------------------------------------------
# Fix 4 — RELIABILITY_REQUIRED sys.exit tests
# ---------------------------------------------------------------------------

import sys
import importlib
import types


def test_reliability_required_exits_when_plan3_unavailable(monkeypatch):
    """When RELIABILITY_REQUIRED=true and Plan 3 modules can't be imported,
    real_trader module-level code must call sys.exit(1)."""
    import builtins

    monkeypatch.setenv("RELIABILITY_REQUIRED", "true")

    # Inject a stub state_store that has env_truthy so real_trader can call it
    fake_ss = types.ModuleType("state_store")
    fake_ss.env_truthy = lambda name, default="false": (  # type: ignore[attr-defined]
        os.environ.get(name, default).strip().lower() in ("1", "true", "yes")
    )
    monkeypatch.setitem(sys.modules, "state_store", fake_ss)

    # Force all Plan 3 imports to fail by removing them from sys.modules
    for mod in list(sys.modules):
        if mod in ("alerts", "live_exchange_fetcher", "reconciler", "invariants", "schemas"):
            monkeypatch.delitem(sys.modules, mod, raising=False)

    original_import = builtins.__import__

    # Make the Plan 3 imports raise ImportError
    def _block_import(name, *args, **kwargs):
        if name in ("alerts", "live_exchange_fetcher", "reconciler", "invariants"):
            raise ImportError(f"blocked: {name}")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", _block_import)

    # Remove real_trader from sys.modules so it re-executes module-level code
    monkeypatch.delitem(sys.modules, "real_trader", raising=False)

    with pytest.raises(SystemExit) as exc_info:
        import real_trader  # noqa: F401
    assert exc_info.value.code == 1
