"""Alert dispatch for reconciliation events.

Sinks are pluggable (Protocol-based). Tests use MemorySink and ConsoleSink;
Plan 3 wires TelegramSink with the live trader's existing bot token.
"""
from __future__ import annotations

import logging
import time
from typing import Any, Optional, Protocol

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


_SEVERITY_LEVELS = {"info": 0, "warn": 1, "error": 2, "critical": 3}


class AlertDispatcher:
    """Routes ReconciliationEvents to registered sinks with severity routing
    and per-key deduplication.

    Dedup key: (category, exchange, symbol, position_id). Within `dedup_window_s`,
    a duplicate-key event is dropped. Sink failures are logged and don't
    stop other sinks from receiving.
    """

    def __init__(self, *, dedup_window_s: float = 60.0) -> None:
        self._dedup_window_s = dedup_window_s
        self._sinks: list[tuple[AlertSink, int]] = []  # (sink, min_severity_level)
        self._last_seen: dict[tuple, float] = {}

    def add_sink(self, sink: AlertSink, *, min_severity: str = "info") -> None:
        level = _SEVERITY_LEVELS[min_severity]
        self._sinks.append((sink, level))

    async def dispatch(
        self, event: ReconciliationEvent, *, _now_s: Optional[float] = None
    ) -> None:
        now_s = _now_s if _now_s is not None else time.time()
        key = (event.category, event.exchange, event.symbol, event.position_id)
        prev = self._last_seen.get(key)
        if prev is not None and (now_s - prev) < self._dedup_window_s:
            return
        self._last_seen[key] = now_s

        ev_level = _SEVERITY_LEVELS[event.severity]
        for sink, min_level in self._sinks:
            if ev_level < min_level:
                continue
            try:
                await sink.send(event)
            except Exception as e:  # noqa: BLE001
                log.warning("sink %r failed: %s", sink, e)
