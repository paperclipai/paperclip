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
