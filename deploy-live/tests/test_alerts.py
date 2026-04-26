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
