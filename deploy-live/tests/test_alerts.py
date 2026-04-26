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
