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


import logging
from typing import Any, Optional

log = logging.getLogger(__name__)

_SEVERITY_EMOJI = {
    "info": "ℹ️", "warn": "⚠️", "error": "🔴", "critical": "🚨",
}


class TelegramSink:
    """Posts alerts to a Telegram chat via the bot HTTP API.

    Failures (network, non-200 response) are logged but do not raise — a
    Telegram outage must not crash the trader. Pass a custom `http_client`
    in tests to avoid real network calls; in production, leave None to
    construct a default httpx.AsyncClient on first use.
    """

    def __init__(
        self,
        *,
        bot_token: str,
        chat_id: str,
        http_client: Optional[Any] = None,
    ) -> None:
        self._bot_token = bot_token
        self._chat_id = chat_id
        self._http_client = http_client

    async def send(self, event: ReconciliationEvent) -> None:
        url = f"https://api.telegram.org/bot{self._bot_token}/sendMessage"
        emoji = _SEVERITY_EMOJI.get(event.severity, "")
        text = (
            f"{emoji} {event.severity.upper()} — {event.category}\n"
            f"Exchange: {event.exchange or '-'}\n"
            f"Symbol: {event.symbol or '-'}\n"
            f"Source: {event.source}\n"
            f"Timestamp: {event.timestamp_ms}"
        )
        if event.notes:
            text += f"\nNotes: {event.notes}"
        payload = {"chat_id": self._chat_id, "text": text}
        try:
            client = self._http_client
            if client is None:
                import httpx  # type: ignore[import-not-found]
                client = httpx.AsyncClient(timeout=5.0)
                self._http_client = client
            r = await client.post(url, json=payload)
            r.raise_for_status()
        except Exception as e:  # noqa: BLE001
            log.warning("TelegramSink.send failed: %s", e)
