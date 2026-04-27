"""Concrete ExchangeFetcher implementation for the live trader.

Adapts the bot's existing async ExchangeExecutor classes into the
async ExchangeFetcher Protocol the reconciler expects. All methods are
async and call executor methods directly with ``await`` — there is no
thread bridging, no ``run_coroutine_threadsafe``, and no blocking
``future.result()`` calls.

Wiring contract (for Plan 3 Task 10):

    fetcher = LiveExchangeFetcher(executors)
    # Inside the trader's asyncio loop, await fetcher methods directly:
    await fetcher.get_open_positions(exchange)
    await fetcher.get_balance(exchange)

Known limitations:

- ``get_recent_fills`` returns an empty list. None of the existing
  executors expose a list-recent-fills endpoint; the reconciler's
  ``unlinked_fill`` detection is therefore inactive in production
  until per-exchange fill endpoints are added in a follow-up plan.
  Other reconciler categories (orphan_leg, phantom_position,
  size_mismatch, balance_drift) work fully.

- Per-exchange position normalizers map observed response shapes from
  real_trader.py's get_open_positions methods. Field names not observed
  are not invented; the fetcher prefers to drop a position whose size
  cannot be parsed (logged at debug) rather than coerce it to zero
  (which would manifest as a phantom_position on the bot side).
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

log = logging.getLogger("live_exchange_fetcher")


class LiveExchangeFetcher:
    """Async ExchangeFetcher backed by async ExchangeExecutor instances.

    All methods are async and must be awaited from within the trader's
    asyncio loop. There is no thread bridging — calling from a worker
    thread is not supported and will deadlock.
    """

    def __init__(
        self,
        executors: dict[str, Any],
        *,
        timeout_s: float = 10.0,
    ):
        # executors keys are the executor.name strings as used by real_trader
        # ("OKX", "MEXC", "Bybit", "BloFin"). Reconciler addresses exchanges
        # via the same string identifiers.
        self._executors = executors
        self._timeout_s = timeout_s

    def _executor(self, exchange: str):
        ex = self._executors.get(exchange)
        if ex is None:
            raise ConnectionError(
                f"no executor registered for exchange={exchange!r}"
            )
        return ex

    async def get_open_positions(self, exchange: str) -> list[dict[str, Any]]:
        ex = self._executor(exchange)
        try:
            raw = await asyncio.wait_for(
                ex.get_open_positions(), timeout=self._timeout_s
            )
        except asyncio.TimeoutError as e:
            raise ConnectionError(f"timeout after {self._timeout_s}s") from e
        except Exception as e:  # noqa: BLE001
            if _looks_like_network_error(e):
                raise ConnectionError(str(e)) from e
            raise
        return list(_normalize_positions(exchange, raw or []))

    async def get_recent_fills(
        self, exchange: str, *, since_ms: int
    ) -> list[dict[str, Any]]:
        # See module docstring: deferred until per-exchange fill endpoints
        # are added. Returning empty causes the reconciler's unlinked_fill
        # check to no-op for live use; tests still cover the path via FakeExchange.
        return []

    async def get_balance(self, exchange: str) -> dict[str, Any]:
        ex = self._executor(exchange)
        try:
            raw = await asyncio.wait_for(
                ex.get_balance(), timeout=self._timeout_s
            )
        except asyncio.TimeoutError as e:
            raise ConnectionError(f"timeout after {self._timeout_s}s") from e
        except Exception as e:  # noqa: BLE001
            if _looks_like_network_error(e):
                raise ConnectionError(str(e)) from e
            raise
        raw = raw or {}
        return {
            "available_usd": float(raw.get("available", 0.0) or 0.0),
            "locked_usd": float(raw.get("locked", 0.0) or 0.0),
        }


def _looks_like_network_error(e: Exception) -> bool:
    """Heuristic: aiohttp ClientError + asyncio TimeoutError translate to ConnectionError."""
    name = type(e).__name__
    if isinstance(e, (asyncio.TimeoutError, OSError)):
        return True
    return name.startswith("Client") or "Timeout" in name or "Network" in name


# ---------------------------------------------------------------------------
# Per-exchange position normalizers
# ---------------------------------------------------------------------------


def _normalize_positions(exchange: str, raw: list[dict]) -> list[dict[str, Any]]:
    if not raw:
        return []
    norm = _NORMALIZERS.get(exchange)
    if norm is None:
        log.warning(
            "no position normalizer for exchange=%s; reconciler will see no positions",
            exchange,
        )
        return []
    out: list[dict[str, Any]] = []
    for r in raw:
        try:
            n = norm(r)
        except Exception as e:  # noqa: BLE001
            log.debug("skipping unparseable %s position %r: %s", exchange, r, e)
            continue
        if n is not None:
            out.append(n)
    return out


def _strip_dash(s: str) -> str:
    return s.replace("-", "")


def _strip_swap(s: str) -> str:
    """OKX uses 'BTC-USDT-SWAP'; bot uses 'BTCUSDT'."""
    return s.replace("-USDT-SWAP", "USDT").replace("-SWAP", "")


def _norm_okx(p: dict) -> Optional[dict]:
    pos_side = str(p.get("posSide", "")).lower()
    if pos_side == "long":
        side = "buy"
    elif pos_side == "short":
        side = "sell"
    else:
        return None
    notional = float(p.get("notionalUsd", 0) or 0)
    if notional <= 0:
        return None
    # Order matters: _strip_swap expects the original "-USDT-SWAP" suffix.
    return {
        "symbol": _strip_dash(_strip_swap(str(p.get("instId", "")))),
        "side": side,
        "size_usd": notional,
    }


def _norm_bybit(p: dict) -> Optional[dict]:
    side_raw = str(p.get("side", "")).lower()
    if side_raw not in ("buy", "sell"):
        return None
    value = float(p.get("positionValue", 0) or 0)
    if value <= 0:
        return None
    return {
        "symbol": str(p.get("symbol", "")),
        "side": side_raw,
        "size_usd": value,
    }


def _norm_mexc(p: dict) -> Optional[dict]:
    # MEXC contract API: positionType 1=long, 2=short
    pt = p.get("positionType")
    if pt == 1:
        side = "buy"
    elif pt == 2:
        side = "sell"
    else:
        return None
    value = float(p.get("positionValue", 0) or 0)
    if value <= 0:
        # Fall back to avg_price * hold_vol if positionValue absent.
        avg = float(p.get("holdAvgPrice", 0) or 0)
        vol = float(p.get("holdVol", 0) or 0)
        value = avg * vol
    if value <= 0:
        return None
    sym = str(p.get("symbol", "")).replace("_", "")
    return {"symbol": sym, "side": side, "size_usd": value}


def _norm_blofin(p: dict) -> Optional[dict]:
    pos_side = str(p.get("positionSide", "")).lower()
    if pos_side == "long":
        side = "buy"
    elif pos_side == "short":
        side = "sell"
    else:
        positions = float(p.get("positions", 0) or 0)
        if positions > 0:
            side = "buy"
        elif positions < 0:
            side = "sell"
        else:
            return None
    value = float(p.get("notionalUsd", 0) or 0) or float(p.get("positionValue", 0) or 0)
    if value <= 0:
        return None
    return {
        "symbol": _strip_dash(str(p.get("instId", ""))),
        "side": side,
        "size_usd": value,
    }


_NORMALIZERS = {
    "OKX": _norm_okx,
    "Bybit": _norm_bybit,
    "BYBIT": _norm_bybit,
    "MEXC": _norm_mexc,
    "BloFin": _norm_blofin,
    "BLOFIN": _norm_blofin,
}
