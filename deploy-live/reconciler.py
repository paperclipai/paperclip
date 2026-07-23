"""Reconciliation engine — diffs exchange truth against state_store.

This module does NOT import from real_trader. It depends only on:
  - state_store (Plan 1)
  - schemas (Plan 1)
  - an ExchangeFetcher Protocol (defined here)

Plan 3 wires a real ExchangeFetcher implementation that delegates to the
live trader's existing executor classes.
"""
from __future__ import annotations

import asyncio
import sqlite3
import time
from typing import Any, Optional, Protocol

from state_store import (
    list_open_positions, list_recent_fills,
    snapshot_balance, write_recon_event,
    upsert_exchange_health, get_exchange_health,
)


class ExchangeFetcher(Protocol):
    """Read-only access to an exchange's authoritative state.

    Each method may raise ConnectionError if the exchange is unreachable.
    Implementations must NOT mutate state.
    """

    def get_open_positions(self, exchange: str) -> list[dict[str, Any]]:
        """Return open positions on the named exchange.

        Each dict has at least: symbol, side, size_usd.
        """
        ...

    def get_recent_fills(self, exchange: str, *, since_ms: int) -> list[dict[str, Any]]:
        """Return fills with filled_at_ms >= since_ms.

        Each dict has at least: order_id, symbol, side, size_usd, fill_price,
        fees_usd, filled_at_ms.
        """
        ...

    def get_balance(self, exchange: str) -> dict[str, Any]:
        """Return {available_usd, locked_usd} for the named exchange."""
        ...


class FakeExchange:
    """Test fixture implementing ExchangeFetcher.

    Use the `set_*` methods to script per-exchange responses, then pass the
    instance wherever an ExchangeFetcher is expected.
    """

    def __init__(self) -> None:
        self._positions: dict[str, list[dict[str, Any]]] = {}
        self._fills: dict[str, list[dict[str, Any]]] = {}
        self._balances: dict[str, dict[str, Any]] = {}
        self._unreachable: dict[str, str] = {}

    def set_open_positions(self, exchange: str, positions: list[dict[str, Any]]) -> None:
        self._positions[exchange] = positions

    def set_recent_fills(self, exchange: str, fills: list[dict[str, Any]]) -> None:
        self._fills[exchange] = fills

    def set_balance(self, exchange: str, *, available_usd: float, locked_usd: float = 0.0) -> None:
        self._balances[exchange] = {"available_usd": available_usd, "locked_usd": locked_usd}

    def set_unreachable(self, exchange: str, *, error: str) -> None:
        self._unreachable[exchange] = error

    def _check_reachable(self, exchange: str) -> None:
        if exchange in self._unreachable:
            raise ConnectionError(self._unreachable[exchange])

    def get_open_positions(self, exchange: str) -> list[dict[str, Any]]:
        self._check_reachable(exchange)
        return list(self._positions.get(exchange, []))

    def get_recent_fills(self, exchange: str, *, since_ms: int) -> list[dict[str, Any]]:
        self._check_reachable(exchange)
        return [f for f in self._fills.get(exchange, []) if f.get("filled_at_ms", 0) >= since_ms]

    def get_balance(self, exchange: str) -> dict[str, Any]:
        self._check_reachable(exchange)
        return dict(self._balances.get(exchange, {"available_usd": 0.0, "locked_usd": 0.0}))


_BALANCE_DRIFT_USD_THRESHOLD = 1.0  # within ±$1 = info
_BALANCE_DRIFT_PCT_THRESHOLD = 1.0  # within 1% = info; otherwise warn
_HEALTH_DOWN_THRESHOLD = 3  # consecutive errors before status flips to 'down'


def reconcile_exchange(
    conn: sqlite3.Connection,
    fetcher: ExchangeFetcher,
    *,
    exchange: str,
    since_ms: int,
    symbol_filter: Optional[str] = None,
) -> None:
    """Diff one exchange's authoritative state against state_store.

    Writes one ReconciliationEvent per discrepancy. Does NOT raise on
    individual diff categories — only on unrecoverable fetcher failures.
    Updates exchange_health based on fetcher reachability. Snapshots the
    fresh balance.

    Diff categories written:
      - phantom_position    (exchange has it, state_store doesn't)
      - orphan_leg          (state_store has it, exchange doesn't)
      - size_mismatch       (sizes differ)
      - unlinked_fill       (recent exchange fill not in state_store)
      - balance_drift       (balance disagreement)
    """
    now_ms = int(time.time() * 1000)
    try:
        ex_positions = fetcher.get_open_positions(exchange)
        ex_fills = fetcher.get_recent_fills(exchange, since_ms=since_ms)
        ex_balance = fetcher.get_balance(exchange)
    except ConnectionError as e:
        prior = get_exchange_health(conn, exchange)
        consecutive = (prior.consecutive_errors + 1) if prior else 1
        new_status = "down" if consecutive >= _HEALTH_DOWN_THRESHOLD else "degraded"
        upsert_exchange_health(
            conn, exchange=exchange, status=new_status,
            last_error_at_ms=now_ms, last_error_msg=str(e),
            consecutive_errors=consecutive,
        )
        severity = "critical" if consecutive >= _HEALTH_DOWN_THRESHOLD else "error"
        write_recon_event(
            conn, timestamp_ms=now_ms, source="reconciler",
            category="exchange_unreachable", severity=severity,
            exchange=exchange, notes=str(e),
            actual={"consecutive_errors": consecutive},
        )
        return

    snapshot_balance(
        conn, exchange=exchange, asset="USDT",
        available_usd=float(ex_balance.get("available_usd", 0.0)),
        locked_usd=float(ex_balance.get("locked_usd", 0.0)),
        snapshot_at_ms=now_ms,
    )
    upsert_exchange_health(
        conn, exchange=exchange, status="ok",
        last_ok_at_ms=now_ms, consecutive_errors=0,
    )

    sp_positions = list_open_positions(conn)

    def _matches_exchange(p, ex_name: str) -> bool:
        return p.exchange_a == ex_name or p.exchange_b == ex_name

    sp_for_exchange = [
        p for p in sp_positions
        if _matches_exchange(p, exchange)
        and (symbol_filter is None or p.symbol == symbol_filter)
    ]

    # Build (symbol, side, size) sets for diff
    sp_index: dict[tuple[str, str], tuple[int, float]] = {}
    for p in sp_for_exchange:
        if p.exchange_a == exchange:
            sp_index[(p.symbol, p.side_a)] = (p.id, p.size_usd_a)
        else:
            sp_index[(p.symbol, p.side_b)] = (p.id, p.size_usd_b)

    ex_index: dict[tuple[str, str], float] = {
        (p["symbol"], p["side"]): float(p["size_usd"])
        for p in ex_positions
        if symbol_filter is None or p["symbol"] == symbol_filter
    }

    # Phantom: in exchange, not in state_store
    for key, ex_size in ex_index.items():
        if key not in sp_index:
            write_recon_event(
                conn, timestamp_ms=now_ms, source="reconciler",
                category="phantom_position", severity="error",
                exchange=exchange, symbol=key[0],
                expected={"present": False},
                actual={"present": True, "side": key[1], "size_usd": ex_size},
            )

    # Orphan / size mismatch
    for key, (pid, sp_size) in sp_index.items():
        if key not in ex_index:
            write_recon_event(
                conn, timestamp_ms=now_ms, source="reconciler",
                category="orphan_leg", severity="error",
                exchange=exchange, symbol=key[0], position_id=pid,
                expected={"side": key[1], "size_usd": sp_size},
                actual={"present": False},
            )
        else:
            ex_size = ex_index[key]
            if abs(ex_size - sp_size) > 0.01:
                write_recon_event(
                    conn, timestamp_ms=now_ms, source="reconciler",
                    category="size_mismatch", severity="warn",
                    exchange=exchange, symbol=key[0], position_id=pid,
                    expected={"size_usd": sp_size},
                    actual={"size_usd": ex_size},
                )

    # Unlinked fills
    sp_recent = list_recent_fills(conn, exchange=exchange, since_ms=since_ms)
    sp_order_ids = {f.order_id for f in sp_recent}
    for f in ex_fills:
        if str(f.get("order_id", "")) not in sp_order_ids:
            write_recon_event(
                conn, timestamp_ms=now_ms, source="reconciler",
                category="unlinked_fill", severity="warn",
                exchange=exchange, symbol=str(f.get("symbol", "")),
                actual={"order_id": f.get("order_id"), "size_usd": f.get("size_usd")},
            )

    # Balance drift
    rows = conn.execute(
        "SELECT * FROM balances WHERE exchange=? AND asset='USDT' "
        "ORDER BY snapshot_at DESC LIMIT 2",
        (exchange,),
    ).fetchall()
    if len(rows) >= 2:
        prev_total = rows[1]["available_usd"] + rows[1]["locked_usd"]
        cur_total = rows[0]["available_usd"] + rows[0]["locked_usd"]
        drift_usd = cur_total - prev_total
        drift_pct = abs(drift_usd) / prev_total * 100 if prev_total > 0 else 0.0
        within_dollar = abs(drift_usd) <= _BALANCE_DRIFT_USD_THRESHOLD
        within_pct = drift_pct <= _BALANCE_DRIFT_PCT_THRESHOLD
        # Always emit a balance_drift event so callers can audit; severity reflects materiality
        severity = "info" if (within_dollar and within_pct) else "warn"
        if abs(drift_usd) > 0.001:  # don't emit pure-zero drift events
            write_recon_event(
                conn, timestamp_ms=now_ms, source="reconciler",
                category="balance_drift", severity=severity,
                exchange=exchange,
                expected={"total_usd": prev_total},
                actual={"total_usd": cur_total, "drift_usd": drift_usd, "drift_pct": drift_pct},
            )


def start_periodic_sweep(
    conn: sqlite3.Connection,
    fetcher: ExchangeFetcher,
    *,
    exchanges: list[str],
    interval_s: float = 300.0,
) -> asyncio.Task:
    """Spawn a background task that reconciles each exchange every `interval_s`.

    The task runs forever until cancelled. Callers should `task.cancel()` and
    `await task` at shutdown. A single exchange failure does not stop the loop.
    """
    async def _loop() -> None:
        while True:
            for exchange in exchanges:
                try:
                    reconcile_exchange(conn, fetcher, exchange=exchange, since_ms=0)
                except Exception as e:  # noqa: BLE001
                    write_recon_event(
                        conn, timestamp_ms=int(time.time() * 1000),
                        source="reconciler", category="reconciler_internal_error",
                        severity="error", exchange=exchange, notes=str(e),
                    )
            await asyncio.sleep(interval_s)

    return asyncio.create_task(_loop())


def schedule_per_trade_reconcile(
    conn: sqlite3.Connection,
    fetcher: ExchangeFetcher,
    *,
    exchange: str,
    symbol: str,
) -> asyncio.Task:
    """Fire-and-forget reconcile of one (exchange, symbol) after an order placement.

    Returns the asyncio.Task so callers can await it in tests; in production
    they typically just discard it. Internal failures are caught and surfaced
    as reconciliation_events rather than propagated as exceptions.
    """
    async def _go() -> None:
        try:
            reconcile_exchange(
                conn, fetcher, exchange=exchange, since_ms=0,
                symbol_filter=symbol,
            )
        except Exception as e:  # noqa: BLE001
            write_recon_event(
                conn, timestamp_ms=int(time.time() * 1000),
                source="reconciler", category="reconciler_internal_error",
                severity="error", exchange=exchange, symbol=symbol, notes=str(e),
            )

    return asyncio.create_task(_go())
