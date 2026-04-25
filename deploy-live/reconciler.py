"""Reconciliation engine — diffs exchange truth against state_store.

This module does NOT import from real_trader. It depends only on:
  - state_store (Plan 1)
  - schemas (Plan 1)
  - an ExchangeFetcher Protocol (defined here)

Plan 3 wires a real ExchangeFetcher implementation that delegates to the
live trader's existing executor classes.
"""
from __future__ import annotations

from typing import Any, Protocol


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
