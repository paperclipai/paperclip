"""Shadow writer: mirror file-based state writes into SQLite.

Used during the Plan 3 shadow-mode rollout (env var SHADOW_SQLITE=true).
The bot keeps writing its file-based state authoritatively; this writer
mirrors each mutation into SQLite so the new reconciler + invariants
can run against a parallel store, and so we can compare counts before
flipping USE_SQLITE_STATE=true.

Failure isolation: every mirror_* method catches and logs any exception.
A failure here must NEVER break the trader's primary write path. After
cutover (USE_SQLITE_STATE=true), this module's writes become redundant
and the module is removed in Plan 3 task 22 (decommission).
"""
from __future__ import annotations

import json
import logging
import sqlite3
import time
from typing import Any, Optional

import state_store

log = logging.getLogger("shadow_writer")


class ShadowWriter:
    """Mirror writes from the file-based state path into SQLite.

    Methods are sync. The trader's existing file-write call sites are
    synchronous; this module follows the same pattern for drop-in use.
    """

    def __init__(self, *, enabled: bool, db_path: Optional[str] = None):
        self._enabled = enabled
        self._db_path = db_path
        self._conn: Optional[sqlite3.Connection] = None
        if self._enabled:
            if not db_path:
                raise ValueError("ShadowWriter enabled but db_path is empty")
            try:
                state_store.init_schema(db_path)
                self._conn = state_store.open_db(db_path)
            except Exception as e:  # noqa: BLE001
                log.error("shadow writer init failed; disabling: %s", e)
                self._enabled = False
                self._conn = None

    @property
    def enabled(self) -> bool:
        return self._enabled and self._conn is not None

    def close(self) -> None:
        if self._conn is not None:
            try:
                self._conn.close()
            except Exception:  # noqa: BLE001
                pass
            self._conn = None

    # ------------------------------------------------------------------
    # Mirror operations. Each isolates failures so a SQLite issue
    # never propagates back into the trader's primary path.
    # ------------------------------------------------------------------

    def mirror_position_open(
        self, *,
        symbol: str,
        exchange_a: str, exchange_b: str,
        side_a: str, side_b: str,
        size_usd_a: float, size_usd_b: float,
        entry_spread_pct: float,
        opened_at_ms: Optional[int] = None,
        status: str = "open",
    ) -> Optional[int]:
        """Mirror a new open position. Returns the SQLite row id, or None on failure/disabled."""
        if not self.enabled:
            return None
        try:
            return state_store.insert_position(
                self._conn,
                symbol=symbol,
                exchange_a=exchange_a, exchange_b=exchange_b,
                side_a=side_a, side_b=side_b,
                size_usd_a=size_usd_a, size_usd_b=size_usd_b,
                entry_spread_pct=entry_spread_pct,
                status=status,
                opened_at_ms=opened_at_ms or int(time.time() * 1000),
            )
        except Exception as e:  # noqa: BLE001
            log.error("shadow mirror_position_open failed: %s", e)
            return None

    def mirror_position_close(
        self, *,
        position_id: int,
        closed_at_ms: Optional[int] = None,
        exit_spread_pct: float,
        realized_pnl_usd: float,
    ) -> bool:
        if not self.enabled:
            return False
        try:
            state_store.close_position(
                self._conn, position_id,
                closed_at_ms=closed_at_ms or int(time.time() * 1000),
                exit_spread_pct=exit_spread_pct,
                realized_pnl_usd=realized_pnl_usd,
            )
            return True
        except Exception as e:  # noqa: BLE001
            log.error("shadow mirror_position_close failed (pid=%s): %s", position_id, e)
            return False

    def mirror_fill(
        self, *,
        position_id: int,
        exchange: str, leg: str, intent: str,
        order_id: str, side: str,
        size_usd: float, fill_price: float, fees_usd: float,
        filled_at_ms: Optional[int] = None,
        raw_response: Any = "",
    ) -> Optional[int]:
        if not self.enabled:
            return None
        try:
            raw_str = (
                raw_response if isinstance(raw_response, str)
                else json.dumps(raw_response)
            )
            return state_store.insert_fill(
                self._conn,
                position_id=position_id,
                exchange=exchange, leg=leg, intent=intent,
                order_id=order_id, side=side,
                size_usd=size_usd, fill_price=fill_price, fees_usd=fees_usd,
                filled_at_ms=filled_at_ms or int(time.time() * 1000),
                raw_response=raw_str,
            )
        except Exception as e:  # noqa: BLE001
            log.error("shadow mirror_fill failed (pid=%s ord=%s): %s",
                      position_id, order_id, e)
            return None

    def mirror_audit(
        self, *,
        event_type: str, severity: str, message: str,
        position_id: Optional[int] = None,
        exchange: Optional[str] = None,
        symbol: Optional[str] = None,
        details: Optional[dict] = None,
        timestamp_ms: Optional[int] = None,
    ) -> Optional[int]:
        if not self.enabled:
            return None
        try:
            return state_store.write_audit(
                self._conn,
                timestamp_ms=timestamp_ms or int(time.time() * 1000),
                event_type=event_type, severity=severity, message=message,
                position_id=position_id, exchange=exchange, symbol=symbol,
                details=details,
            )
        except Exception as e:  # noqa: BLE001
            log.error("shadow mirror_audit failed: %s", e)
            return None
