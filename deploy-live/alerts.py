"""Alert dispatch for reconciliation events.

Sinks are pluggable (Protocol-based). Tests use MemorySink and ConsoleSink;
Plan 3 wires TelegramSink with the live trader's existing bot token.
"""
from __future__ import annotations

import asyncio
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


class DigestSink:
    """Batches 'warn'-severity events and flushes them to an inner sink periodically.

    Events at any severity other than 'warn' are forwarded immediately.
    Warn events are accumulated and flushed as a single combined message every
    `flush_interval_s` seconds (default 3600 — hourly).

    Usage:
        inner = TelegramSink(...)
        digest = DigestSink(inner, flush_interval_s=3600)
        digest_task = asyncio.create_task(digest.run())
        dispatcher.add_sink(digest, min_severity="warn")
        # at shutdown:
        digest_task.cancel()
        await digest.flush()
    """

    DIGEST_SEVERITY = "warn"

    def __init__(self, inner: Any, *, flush_interval_s: float = 3600.0,
                 max_buffer_size: int = 200) -> None:
        self._inner = inner
        self._flush_interval_s = flush_interval_s
        self._max_buffer_size = max_buffer_size
        self._buffer: list[ReconciliationEvent] = []
        self._dropped_count: int = 0

    async def send(self, event: ReconciliationEvent) -> None:
        if event.severity == self.DIGEST_SEVERITY:
            if len(self._buffer) >= self._max_buffer_size:
                self._dropped_count += 1
                return
            self._buffer.append(event)
        else:
            await self._inner.send(event)

    async def flush(self) -> None:
        """Send all buffered warn events as a single digest, then clear the buffer."""
        events, self._buffer = self._buffer, []
        dropped, self._dropped_count = self._dropped_count, 0
        if not events and not dropped:
            return
        # Build a combined synthetic event carrying a summary in notes.
        # Cap displayed lines and total message size to stay under Telegram's 4096-char limit.
        summary_lines = [
            f"[{e.category}@{e.exchange or '-'}:{e.symbol or '-'}]"
            for e in events[:50]
        ]
        notes_parts = [f"{len(events)} warn(s) in last digest window: " + ", ".join(summary_lines)]
        if len(events) > 50:
            notes_parts.append(f"... and {len(events) - 50} more")
        if dropped:
            notes_parts.append(
                f"({dropped} additional warn(s) dropped due to buffer overflow)"
            )
        notes = "; ".join(notes_parts)[:3500]
        digest_event = ReconciliationEvent(
            timestamp_ms=int(time.time() * 1000),
            source="reconciler",
            category="warn_digest",
            severity="warn",
            notes=notes,
        )
        try:
            await self._inner.send(digest_event)
        except Exception as e:  # noqa: BLE001
            log.warning("DigestSink.flush inner send failed: %s", e)

    async def run(self) -> None:
        """Background task: flush buffered warns every flush_interval_s seconds.

        Call asyncio.create_task(digest.run()) at startup and cancel the
        returned task at shutdown (followed by a final await digest.flush()).
        """
        try:
            while True:
                await asyncio.sleep(self._flush_interval_s)
                await self.flush()
        except asyncio.CancelledError:
            pass


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
