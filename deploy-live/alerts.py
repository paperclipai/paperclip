"""Alert dispatch for reconciliation events.

Sinks are pluggable (Protocol-based). Tests use MemorySink and ConsoleSink;
Plan 3 wires TelegramSink with the live trader's existing bot token.
"""
from __future__ import annotations

from typing import Protocol

from schemas import ReconciliationEvent


class AlertSink(Protocol):
    """An async destination for alert events."""

    async def send(self, event: ReconciliationEvent) -> None:
        ...


class MemorySink:
    """Captures events in-memory. Use in tests to assert dispatch behavior."""

    def __init__(self) -> None:
        self.events: list[ReconciliationEvent] = []

    async def send(self, event: ReconciliationEvent) -> None:
        self.events.append(event)


class ConsoleSink:
    """Prints events to stdout. Useful for local debugging / smoke runs."""

    async def send(self, event: ReconciliationEvent) -> None:
        print(
            f"[ALERT {event.severity.upper()}] "
            f"{event.category} @ {event.exchange or '-'}:{event.symbol or '-'} "
            f"(source={event.source}, ts={event.timestamp_ms})"
        )
