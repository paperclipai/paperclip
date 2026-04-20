# Live Trader EU Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `real_trader.py` — a live convergence arbitrage bot executing the EU Main strategy on OKX, MEXC, Bybit, and BloFin via raw API, deployed to AWS Lightsail Singapore.

**Architecture:** Single-file monolithic async bot (same pattern as `paper_trader.py`). Price feeds are copied from paper trader (read-only REST + WS). A new `ExchangeExecutor` class handles authenticated order placement via HMAC-SHA256 signing. The strategy engine (spread detection, filters, entry/exit) is ported from the EU Main shadow strategy. A `RiskManager` enforces hard limits. A Flask dashboard runs alongside.

**Tech Stack:** Python 3.11+, aiohttp (async HTTP/WS), Flask (dashboard), systemd (process management)

**Reference files:**
- Paper trader: `~/.paperclip/instances/default/workspaces/857e37f3-bfdc-423f-941e-95d33d9ebe17/deploy/paper_trader.py` (6952 lines)
- Paper dashboard: `~/.paperclip/instances/default/workspaces/857e37f3-bfdc-423f-941e-95d33d9ebe17/deploy/dashboard.py` (2987 lines)
- Design spec: `docs/superpowers/specs/2026-04-19-live-trader-eu-design.md`

**File structure:**
```
deploy-live/
  real_trader.py       # Main bot: config, data classes, price feeds, WS managers,
                       #   exchange executors, strategy engine, risk manager,
                       #   position tracker, telegram, main loop
  dashboard.py         # Flask dashboard: equity curve, positions, order log,
                       #   exchange balances, reconciliation, controls
  start.sh             # Launch bot + dashboard in parallel
  requirements.txt     # aiohttp, flask
  heartbeat.sh         # Watchdog cron script
  Dockerfile           # For Lightsail deployment
  .env.example         # Template for API keys
```

---

## Task 1: Project Scaffold & Configuration

**Files:**
- Create: `deploy-live/requirements.txt`
- Create: `deploy-live/.env.example`
- Create: `deploy-live/real_trader.py` (initial skeleton with config section)

- [ ] **Step 1: Create requirements.txt**

```
aiohttp>=3.9.0
flask>=3.0.0
```

- [ ] **Step 2: Create .env.example**

```bash
# Exchange API Keys (trade permission only, NO withdrawal)
OKX_API_KEY=
OKX_API_SECRET=
OKX_PASSPHRASE=

BYBIT_API_KEY=
BYBIT_API_SECRET=

MEXC_API_KEY=
MEXC_API_SECRET=

BLOFIN_API_KEY=
BLOFIN_API_SECRET=
BLOFIN_PASSPHRASE=

# Telegram
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# Dashboard
DASHBOARD_PASSWORD=changeme

# Mode
DRY_RUN=true
```

- [ ] **Step 3: Create real_trader.py with configuration block**

Copy the configuration section from `paper_trader.py` lines 1-420 and modify for live trading. Key changes:

```python
#!/usr/bin/env python3
"""
Real Trading Bot — Convergence Arbitrage (EU Main Strategy)
Live execution on OKX, MEXC, Bybit, BloFin via raw API.
All taker market orders. Sends live updates to Telegram.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import signal
import sys
import time
import urllib.parse
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional, Tuple

import aiohttp

log = logging.getLogger("real_trader")

# ═══════════════════════════════════════════════════════════════════════════
# CONFIGURATION
# ═══════════════════════════════════════════════════════════════════════════

BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")

# Mode
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() == "true"

# ── Exchange API Keys ──
OKX_API_KEY = os.environ.get("OKX_API_KEY", "")
OKX_API_SECRET = os.environ.get("OKX_API_SECRET", "")
OKX_PASSPHRASE = os.environ.get("OKX_PASSPHRASE", "")

BYBIT_API_KEY = os.environ.get("BYBIT_API_KEY", "")
BYBIT_API_SECRET = os.environ.get("BYBIT_API_SECRET", "")

MEXC_API_KEY = os.environ.get("MEXC_API_KEY", "")
MEXC_API_SECRET = os.environ.get("MEXC_API_SECRET", "")

BLOFIN_API_KEY = os.environ.get("BLOFIN_API_KEY", "")
BLOFIN_API_SECRET = os.environ.get("BLOFIN_API_SECRET", "")
BLOFIN_PASSPHRASE = os.environ.get("BLOFIN_PASSPHRASE", "")

# ── Strategy (EU Main) ──
ENTRY_SPREAD_PCT = 0.90
EXIT_SPREAD_PCT = 0.15
MAX_HOLD_MINUTES = 30
MOMENTUM_FILTER = True
MA_FILTER = True
PAIR_PREFERENCE = True
MIN_VOLUME_USD = 50_000
MIN_LOW_SIDE_VOLUME_USD = 50_000

# ── Position Sizing ──
STARTING_CAPITAL = 200           # $50 per exchange × 4
MAX_POSITION_USD = 25            # $25 per leg
POSITION_SIZE_PCT = 0.125        # 12.5% of equity per trade
MAX_CONCURRENT = 3               # Max 3 open positions

# ── Risk Management ──
KILL_SWITCH_DRAWDOWN_PCT = 10.0  # Halt at 10% drawdown
COOLDOWN_AFTER_KILL_SEC = 3600   # 1 hour cooldown
MAX_PER_EXCHANGE_PCT = 0.80      # Max 80% of exchange balance

# ── Execution ──
ORDER_TIMEOUT_SEC = 5            # Cancel if not filled in 5s
BALANCE_REFRESH_SEC = 30         # Cache exchange balances
RECONCILE_INTERVAL_SEC = 300     # Check actual positions every 5 min
HEARTBEAT_INTERVAL_SEC = 60      # Health check every 60s

# ── Exchanges ──
EXCHANGES = ["OKX", "MEXC", "Bybit", "BloFin"]
DISABLED_EXCHANGES: List[str] = []

# ── Monitoring ──
POLL_INTERVAL = 3
POLL_INTERVAL_FAST = 0.5
POLL_INTERVAL_SLOW = 5
MAX_SANE_SPREAD_PCT = 15.0
STALE_PRICE_SECONDS = 30
MAX_OB_CALLS_PER_CYCLE = 60
OB_LEVELS_LIMIT = 20
OB_EMPTY_CACHE_CYCLES = 10

# ── Breakout Guard ──
BREAKOUT_LOOKBACK = 8
BREAKOUT_WIDEN_RATIO = 0.70
BREAKOUT_MIN_DRIFT_REL = 0.15
BREAKOUT_LOSS_MEMORY_HOURS = 6
BLACKLIST_TIER1_TRADE_PCT = 0.75
BLACKLIST_TIER2_TRADE_PCT = 0.25
BLACKLIST_TIER3_TRADE_PCT = 0.12

# ── Dynamic Exit ──
DYNAMIC_EXIT_ENABLED = True
BASELINE_SPREAD_WINDOW = 100

# ── Relative Spread ──
RELATIVE_SPREAD_ENABLED = True
RELATIVE_SPREAD_MIN_READINGS = 30
RELATIVE_SPREAD_DEVIATION_PCT = 0.45
RELATIVE_SPREAD_WINDOW = 200

# ── Entry Pricing ──
ENTRY_MIN_TICKS = 1
ENTRY_SPREAD_EWMA_ALPHA = 0.4
ENTRY_SPREAD_HISTORY_LEN = 5

# ── Aged Positions ──
AGED_POSITION_MAX_ALLOC_PCT = 0.30
AGED_POSITION_THRESHOLD_MIN = 10.0

# ── Fee Model (taker) — same tiers as paper trader ──
TAKER_FEES = {
    "OKX": 0.0500, "Bybit": 0.0550, "MEXC": 0.0200, "BloFin": 0.0600,
}
SPOT_FEES = {
    "OKX": 0.1000, "Bybit": 0.1000, "MEXC": 0.0500, "BloFin": 0.1000,
}

# ── Symbols ──
SYMBOLS: List[str] = []
MIN_EXCHANGES_PER_SYMBOL = 2     # Only 4 exchanges, so lower threshold
BLOCKED_SYMBOLS = {"DRIFTUSDT"}
WHITELIST_SYMBOLS = {"SIRENUSDT", "RLSUSDT"}

# Copy DELISTED_SYMBOLS from paper_trader.py lines 426-496
DELISTED_SYMBOLS = {
    "A2ZUSDT", "FORTHUSDT", "HOOKUSDT", "IDEXUSDT",
    "LRCUSDT", "NTRMUSDT", "RDNTUSDT", "SXPUSDT",
    # ... (copy full set from paper_trader.py)
}

# ── Data Directory ──
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "data"))
os.makedirs(DATA_DIR, exist_ok=True)
```

- [ ] **Step 4: Commit**

```bash
git add deploy-live/
git commit -m "feat: scaffold live trader project with config"
```

---

## Task 2: Data Classes (OrderResult, LivePosition, Portfolio)

**Files:**
- Modify: `deploy-live/real_trader.py`

- [ ] **Step 1: Add PriceQuote dataclass**

Copy directly from `paper_trader.py` lines 633-643:

```python
@dataclass
class PriceQuote:
    exchange: str
    symbol: str
    bid: float
    ask: float
    mid: float
    volume_24h_usd: float
    funding_rate: float
    instrument: str = "PERP"
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
```

- [ ] **Step 2: Add OrderResult dataclass**

```python
@dataclass
class OrderResult:
    success: bool
    order_id: str
    exchange: str
    symbol: str
    side: str              # "buy" or "sell"
    size_usd: float        # requested
    filled_usd: float      # actual filled
    fill_price: float      # average fill price
    fees_usd: float        # actual fees charged
    timestamp: float
    latency_ms: float = 0.0  # round-trip time for order
    error: str = ""
```

- [ ] **Step 3: Add LivePosition dataclass**

```python
@dataclass
class LivePosition:
    id: int
    symbol: str
    exchange_short: str
    exchange_long: str
    instrument_short: str
    instrument_long: str
    entry_spread_pct: float
    entry_price_short: float
    entry_price_long: float
    size_usd: float
    entry_time: datetime
    # Real order tracking
    order_id_short: str = ""       # Exchange order ID for short leg
    order_id_long: str = ""        # Exchange order ID for long leg
    order_id_close_short: str = "" # Close order IDs
    order_id_close_long: str = ""
    # Status
    status: str = "OPEN"           # OPEN, CLOSING, CLOSED, DEGRADED
    degraded_leg: str = ""         # "short" or "long" if one leg stuck
    # Spread tracking
    peak_spread_pct: float = 0.0
    current_spread_pct: float = 0.0
    # Exit
    exit_time: Optional[datetime] = None
    exit_spread_pct: float = 0.0
    exit_price_short: float = 0.0
    exit_price_long: float = 0.0
    exit_reason: str = ""
    # P&L
    entry_fees_usd: float = 0.0
    exit_fees_usd: float = 0.0
    gross_pnl_usd: float = 0.0
    net_pnl_usd: float = 0.0
    # Telegram
    telegram_msg_id: Optional[int] = None
    # Retry tracking for degraded positions
    close_retry_count: int = 0
    last_close_attempt: Optional[float] = None
```

- [ ] **Step 4: Add Portfolio dataclass**

```python
@dataclass
class Portfolio:
    starting_capital: float
    cash: float
    positions: List[LivePosition] = field(default_factory=list)
    closed_positions: List[LivePosition] = field(default_factory=list)
    next_id: int = 1
    total_trades: int = 0
    total_wins: int = 0
    total_pnl_usd: float = 0.0
    peak_equity: float = 0.0
    max_drawdown_pct: float = 0.0

    @property
    def open_positions(self) -> List[LivePosition]:
        return [p for p in self.positions if p.status in ("OPEN", "CLOSING", "DEGRADED")]

    @property
    def equity(self) -> float:
        unrealized = sum(p.net_pnl_usd for p in self.open_positions)
        return self.cash + unrealized
```

- [ ] **Step 5: Commit**

```bash
git add deploy-live/real_trader.py
git commit -m "feat: add data classes for live trading"
```

---

## Task 3: Exchange Executors — Auth Signing

**Files:**
- Modify: `deploy-live/real_trader.py`

- [ ] **Step 1: Add base ExchangeExecutor class**

```python
class ExchangeExecutor:
    """Base class for authenticated exchange API calls."""

    def __init__(self, name: str, api_key: str, api_secret: str, session: aiohttp.ClientSession):
        self.name = name
        self.api_key = api_key
        self.api_secret = api_secret
        self.session = session
        self.healthy = True
        self.last_success_time = time.time()
        self.last_error = ""

    def _mark_success(self):
        self.healthy = True
        self.last_success_time = time.time()
        self.last_error = ""

    def _mark_error(self, error: str):
        self.last_error = error
        if time.time() - self.last_success_time > 30:
            self.healthy = False

    async def place_market_order(self, symbol: str, side: str, size_usd: float) -> OrderResult:
        raise NotImplementedError

    async def get_order_status(self, order_id: str, symbol: str) -> dict:
        raise NotImplementedError

    async def cancel_order(self, order_id: str, symbol: str) -> bool:
        raise NotImplementedError

    async def get_balance(self) -> Dict[str, float]:
        """Returns {"available": float, "locked": float}"""
        raise NotImplementedError

    async def get_open_positions(self) -> List[dict]:
        raise NotImplementedError
```

- [ ] **Step 2: Add OKX executor with HMAC signing**

```python
class OKXExecutor(ExchangeExecutor):
    """OKX API — HMAC-SHA256 with base64, requires passphrase."""

    BASE_URL = "https://www.okx.com"

    def __init__(self, api_key: str, api_secret: str, passphrase: str, session: aiohttp.ClientSession):
        super().__init__("OKX", api_key, api_secret, session)
        self.passphrase = passphrase

    def _sign(self, timestamp: str, method: str, path: str, body: str = "") -> str:
        message = timestamp + method.upper() + path + body
        signature = hmac.new(
            self.api_secret.encode(), message.encode(), hashlib.sha256
        ).digest()
        return base64.b64encode(signature).decode()

    def _headers(self, method: str, path: str, body: str = "") -> dict:
        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + \
                    f"{datetime.now(timezone.utc).microsecond // 1000:03d}Z"
        return {
            "OK-ACCESS-KEY": self.api_key,
            "OK-ACCESS-SIGN": self._sign(timestamp, method, path, body),
            "OK-ACCESS-TIMESTAMP": timestamp,
            "OK-ACCESS-PASSPHRASE": self.passphrase,
            "Content-Type": "application/json",
        }

    async def place_market_order(self, symbol: str, side: str, size_usd: float) -> OrderResult:
        t0 = time.time()
        base = symbol.replace("USDT", "")
        inst_id = f"{base}-USDT-SWAP"
        path = "/api/v5/trade/order"

        # OKX uses contract size — need to convert USD to contracts
        # For most USDT-M perps, 1 contract = varies by asset
        # Use sz in USDT with tgtCcy="quote_ccy"
        body = json.dumps({
            "instId": inst_id,
            "tdMode": "cross",    # cross margin
            "side": side,         # "buy" or "sell"
            "ordType": "market",
            "sz": str(size_usd),
            "tgtCcy": "quote_ccy",  # size in USDT
        })

        if DRY_RUN:
            log.info(f"[DRY_RUN] OKX {side} {symbol} ${size_usd:.2f}")
            return OrderResult(
                success=True, order_id=f"dry_{int(time.time()*1000)}",
                exchange="OKX", symbol=symbol, side=side,
                size_usd=size_usd, filled_usd=size_usd, fill_price=0.0,
                fees_usd=0.0, timestamp=time.time(),
                latency_ms=(time.time() - t0) * 1000,
            )

        headers = self._headers("POST", path, body)
        try:
            async with self.session.post(
                self.BASE_URL + path, headers=headers, data=body,
                timeout=aiohttp.ClientTimeout(total=ORDER_TIMEOUT_SEC)
            ) as resp:
                data = await resp.json()
                latency = (time.time() - t0) * 1000

                if data.get("code") == "0" and data.get("data"):
                    order_data = data["data"][0]
                    order_id = order_data.get("ordId", "")
                    self._mark_success()

                    # Poll for fill details
                    fill = await self._wait_for_fill(order_id, inst_id)

                    return OrderResult(
                        success=True, order_id=order_id,
                        exchange="OKX", symbol=symbol, side=side,
                        size_usd=size_usd,
                        filled_usd=fill.get("filled_usd", size_usd),
                        fill_price=fill.get("fill_price", 0.0),
                        fees_usd=fill.get("fees_usd", 0.0),
                        timestamp=time.time(), latency_ms=latency,
                    )
                else:
                    error = data.get("msg", str(data))
                    self._mark_error(error)
                    return OrderResult(
                        success=False, order_id="", exchange="OKX",
                        symbol=symbol, side=side, size_usd=size_usd,
                        filled_usd=0, fill_price=0, fees_usd=0,
                        timestamp=time.time(), latency_ms=latency, error=error,
                    )
        except Exception as e:
            self._mark_error(str(e))
            return OrderResult(
                success=False, order_id="", exchange="OKX",
                symbol=symbol, side=side, size_usd=size_usd,
                filled_usd=0, fill_price=0, fees_usd=0,
                timestamp=time.time(), latency_ms=(time.time() - t0) * 1000,
                error=str(e),
            )

    async def _wait_for_fill(self, order_id: str, inst_id: str, max_wait: float = 3.0) -> dict:
        """Poll order status until filled or timeout."""
        deadline = time.time() + max_wait
        while time.time() < deadline:
            path = f"/api/v5/trade/order?ordId={order_id}&instId={inst_id}"
            headers = self._headers("GET", path)
            try:
                async with self.session.get(
                    self.BASE_URL + path, headers=headers,
                    timeout=aiohttp.ClientTimeout(total=2)
                ) as resp:
                    data = await resp.json()
                    if data.get("code") == "0" and data.get("data"):
                        order = data["data"][0]
                        state = order.get("state", "")
                        if state == "filled":
                            avg_px = float(order.get("avgPx", 0) or 0)
                            fill_sz = float(order.get("accFillSz", 0) or 0)
                            fee = abs(float(order.get("fee", 0) or 0))
                            return {
                                "fill_price": avg_px,
                                "filled_usd": fill_sz * avg_px if avg_px > 0 else 0,
                                "fees_usd": fee,
                            }
                        elif state in ("canceled", "cancelled"):
                            return {}
            except Exception:
                pass
            await asyncio.sleep(0.3)
        return {}

    async def get_balance(self) -> Dict[str, float]:
        path = "/api/v5/account/balance?ccy=USDT"
        headers = self._headers("GET", path)
        try:
            async with self.session.get(
                self.BASE_URL + path, headers=headers,
                timeout=aiohttp.ClientTimeout(total=5)
            ) as resp:
                data = await resp.json()
                if data.get("code") == "0" and data.get("data"):
                    details = data["data"][0].get("details", [])
                    for d in details:
                        if d.get("ccy") == "USDT":
                            self._mark_success()
                            return {
                                "available": float(d.get("availBal", 0) or 0),
                                "locked": float(d.get("frozenBal", 0) or 0),
                            }
        except Exception as e:
            self._mark_error(str(e))
        return {"available": 0, "locked": 0}

    async def get_open_positions(self) -> List[dict]:
        path = "/api/v5/account/positions?instType=SWAP"
        headers = self._headers("GET", path)
        try:
            async with self.session.get(
                self.BASE_URL + path, headers=headers,
                timeout=aiohttp.ClientTimeout(total=5)
            ) as resp:
                data = await resp.json()
                if data.get("code") == "0":
                    self._mark_success()
                    positions = []
                    for p in data.get("data", []):
                        pos_amt = float(p.get("pos", 0) or 0)
                        if pos_amt == 0:
                            continue
                        inst_id = p.get("instId", "")
                        base = inst_id.split("-")[0] if "-" in inst_id else inst_id
                        positions.append({
                            "symbol": base + "USDT",
                            "side": "long" if pos_amt > 0 else "short",
                            "size": abs(pos_amt),
                            "notional_usd": abs(float(p.get("notionalUsd", 0) or 0)),
                            "unrealized_pnl": float(p.get("upl", 0) or 0),
                        })
                    return positions
        except Exception as e:
            self._mark_error(str(e))
        return []
```

- [ ] **Step 3: Add Bybit executor**

```python
class BybitExecutor(ExchangeExecutor):
    """Bybit API — HMAC-SHA256 of timestamp+api_key+recv_window+params."""

    BASE_URL = "https://api.bybit.com"
    RECV_WINDOW = "5000"

    def _sign(self, timestamp: str, params: str) -> str:
        message = timestamp + self.api_key + self.RECV_WINDOW + params
        return hmac.new(
            self.api_secret.encode(), message.encode(), hashlib.sha256
        ).hexdigest()

    def _headers(self, timestamp: str, params: str) -> dict:
        return {
            "X-BAPI-API-KEY": self.api_key,
            "X-BAPI-SIGN": self._sign(timestamp, params),
            "X-BAPI-TIMESTAMP": timestamp,
            "X-BAPI-RECV-WINDOW": self.RECV_WINDOW,
            "Content-Type": "application/json",
        }

    async def place_market_order(self, symbol: str, side: str, size_usd: float) -> OrderResult:
        t0 = time.time()
        timestamp = str(int(time.time() * 1000))

        body = json.dumps({
            "category": "linear",
            "symbol": symbol,
            "side": "Buy" if side == "buy" else "Sell",
            "orderType": "Market",
            "qty": str(size_usd),         # Bybit linear: qty in USDT for market orders
            "marketUnit": "quoteCoin",     # Size in USDT
        })

        if DRY_RUN:
            log.info(f"[DRY_RUN] Bybit {side} {symbol} ${size_usd:.2f}")
            return OrderResult(
                success=True, order_id=f"dry_{int(time.time()*1000)}",
                exchange="Bybit", symbol=symbol, side=side,
                size_usd=size_usd, filled_usd=size_usd, fill_price=0.0,
                fees_usd=0.0, timestamp=time.time(),
                latency_ms=(time.time() - t0) * 1000,
            )

        headers = self._headers(timestamp, body)
        try:
            async with self.session.post(
                self.BASE_URL + "/v5/order/create", headers=headers, data=body,
                timeout=aiohttp.ClientTimeout(total=ORDER_TIMEOUT_SEC)
            ) as resp:
                data = await resp.json()
                latency = (time.time() - t0) * 1000

                if data.get("retCode") == 0:
                    result = data.get("result", {})
                    order_id = result.get("orderId", "")
                    self._mark_success()

                    fill = await self._wait_for_fill(order_id, symbol)
                    return OrderResult(
                        success=True, order_id=order_id,
                        exchange="Bybit", symbol=symbol, side=side,
                        size_usd=size_usd,
                        filled_usd=fill.get("filled_usd", size_usd),
                        fill_price=fill.get("fill_price", 0.0),
                        fees_usd=fill.get("fees_usd", 0.0),
                        timestamp=time.time(), latency_ms=latency,
                    )
                else:
                    error = data.get("retMsg", str(data))
                    self._mark_error(error)
                    return OrderResult(
                        success=False, order_id="", exchange="Bybit",
                        symbol=symbol, side=side, size_usd=size_usd,
                        filled_usd=0, fill_price=0, fees_usd=0,
                        timestamp=time.time(), latency_ms=latency, error=error,
                    )
        except Exception as e:
            self._mark_error(str(e))
            return OrderResult(
                success=False, order_id="", exchange="Bybit",
                symbol=symbol, side=side, size_usd=size_usd,
                filled_usd=0, fill_price=0, fees_usd=0,
                timestamp=time.time(), latency_ms=(time.time() - t0) * 1000,
                error=str(e),
            )

    async def _wait_for_fill(self, order_id: str, symbol: str, max_wait: float = 3.0) -> dict:
        deadline = time.time() + max_wait
        while time.time() < deadline:
            timestamp = str(int(time.time() * 1000))
            params = f"category=linear&orderId={order_id}&symbol={symbol}"
            headers = self._headers(timestamp, params)
            try:
                async with self.session.get(
                    self.BASE_URL + f"/v5/order/realtime?{params}", headers=headers,
                    timeout=aiohttp.ClientTimeout(total=2)
                ) as resp:
                    data = await resp.json()
                    if data.get("retCode") == 0:
                        orders = data.get("result", {}).get("list", [])
                        if orders:
                            order = orders[0]
                            status = order.get("orderStatus", "")
                            if status == "Filled":
                                avg_px = float(order.get("avgPrice", 0) or 0)
                                cum_value = float(order.get("cumExecValue", 0) or 0)
                                cum_fee = float(order.get("cumExecFee", 0) or 0)
                                return {
                                    "fill_price": avg_px,
                                    "filled_usd": cum_value,
                                    "fees_usd": abs(cum_fee),
                                }
                            elif status in ("Cancelled", "Rejected"):
                                return {}
            except Exception:
                pass
            await asyncio.sleep(0.3)
        return {}

    async def get_balance(self) -> Dict[str, float]:
        timestamp = str(int(time.time() * 1000))
        params = "accountType=UNIFIED&coin=USDT"
        headers = self._headers(timestamp, params)
        try:
            async with self.session.get(
                self.BASE_URL + f"/v5/account/wallet-balance?{params}", headers=headers,
                timeout=aiohttp.ClientTimeout(total=5)
            ) as resp:
                data = await resp.json()
                if data.get("retCode") == 0:
                    self._mark_success()
                    accounts = data.get("result", {}).get("list", [])
                    for acct in accounts:
                        for coin in acct.get("coin", []):
                            if coin.get("coin") == "USDT":
                                return {
                                    "available": float(coin.get("availableToWithdraw", 0) or 0),
                                    "locked": float(coin.get("locked", 0) or 0),
                                }
        except Exception as e:
            self._mark_error(str(e))
        return {"available": 0, "locked": 0}

    async def get_open_positions(self) -> List[dict]:
        timestamp = str(int(time.time() * 1000))
        params = "category=linear&settleCoin=USDT"
        headers = self._headers(timestamp, params)
        try:
            async with self.session.get(
                self.BASE_URL + f"/v5/position/list?{params}", headers=headers,
                timeout=aiohttp.ClientTimeout(total=5)
            ) as resp:
                data = await resp.json()
                if data.get("retCode") == 0:
                    self._mark_success()
                    positions = []
                    for p in data.get("result", {}).get("list", []):
                        size = float(p.get("size", 0) or 0)
                        if size == 0:
                            continue
                        positions.append({
                            "symbol": p.get("symbol", ""),
                            "side": p.get("side", "").lower(),
                            "size": size,
                            "notional_usd": float(p.get("positionValue", 0) or 0),
                            "unrealized_pnl": float(p.get("unrealisedPnl", 0) or 0),
                        })
                    return positions
        except Exception as e:
            self._mark_error(str(e))
        return []
```

- [ ] **Step 4: Add MEXC executor**

```python
class MEXCExecutor(ExchangeExecutor):
    """MEXC API — HMAC-SHA256 of query string, timestamp in params."""

    BASE_URL = "https://contract.mexc.com"

    def _sign(self, params: str) -> str:
        return hmac.new(
            self.api_secret.encode(), params.encode(), hashlib.sha256
        ).hexdigest()

    async def place_market_order(self, symbol: str, side: str, size_usd: float) -> OrderResult:
        t0 = time.time()
        base = symbol.replace("USDT", "")

        if DRY_RUN:
            log.info(f"[DRY_RUN] MEXC {side} {symbol} ${size_usd:.2f}")
            return OrderResult(
                success=True, order_id=f"dry_{int(time.time()*1000)}",
                exchange="MEXC", symbol=symbol, side=side,
                size_usd=size_usd, filled_usd=size_usd, fill_price=0.0,
                fees_usd=0.0, timestamp=time.time(),
                latency_ms=(time.time() - t0) * 1000,
            )

        # MEXC futures uses contract-based sizing
        # open_type: 1=isolated, 2=cross
        # side: 1=open long, 2=close short, 3=open short, 4=close long
        if side == "buy":
            mexc_side = 1  # open long
        else:
            mexc_side = 3  # open short

        timestamp = str(int(time.time() * 1000))
        request_params = {
            "symbol": f"{base}_USDT",
            "side": mexc_side,
            "type": 5,           # market order
            "vol": size_usd,     # volume in USDT for market orders
            "openType": 2,       # cross margin
            "timestamp": timestamp,
        }
        query = urllib.parse.urlencode(sorted(request_params.items()))
        signature = self._sign(query)

        headers = {
            "ApiKey": self.api_key,
            "Signature": signature,
            "Request-Time": timestamp,
            "Content-Type": "application/json",
        }

        try:
            async with self.session.post(
                self.BASE_URL + "/api/v1/private/order/submit",
                headers=headers,
                json={**request_params, "signature": signature},
                timeout=aiohttp.ClientTimeout(total=ORDER_TIMEOUT_SEC)
            ) as resp:
                data = await resp.json()
                latency = (time.time() - t0) * 1000

                if data.get("success") and data.get("data"):
                    order_id = str(data["data"])
                    self._mark_success()
                    fill = await self._wait_for_fill(order_id, f"{base}_USDT")
                    return OrderResult(
                        success=True, order_id=order_id,
                        exchange="MEXC", symbol=symbol, side=side,
                        size_usd=size_usd,
                        filled_usd=fill.get("filled_usd", size_usd),
                        fill_price=fill.get("fill_price", 0.0),
                        fees_usd=fill.get("fees_usd", 0.0),
                        timestamp=time.time(), latency_ms=latency,
                    )
                else:
                    error = data.get("message", str(data))
                    self._mark_error(error)
                    return OrderResult(
                        success=False, order_id="", exchange="MEXC",
                        symbol=symbol, side=side, size_usd=size_usd,
                        filled_usd=0, fill_price=0, fees_usd=0,
                        timestamp=time.time(), latency_ms=latency, error=error,
                    )
        except Exception as e:
            self._mark_error(str(e))
            return OrderResult(
                success=False, order_id="", exchange="MEXC",
                symbol=symbol, side=side, size_usd=size_usd,
                filled_usd=0, fill_price=0, fees_usd=0,
                timestamp=time.time(), latency_ms=(time.time() - t0) * 1000,
                error=str(e),
            )

    async def _wait_for_fill(self, order_id: str, contract: str, max_wait: float = 3.0) -> dict:
        deadline = time.time() + max_wait
        while time.time() < deadline:
            timestamp = str(int(time.time() * 1000))
            params = f"order_id={order_id}&symbol={contract}&timestamp={timestamp}"
            signature = self._sign(params)
            headers = {
                "ApiKey": self.api_key,
                "Signature": signature,
                "Request-Time": timestamp,
            }
            try:
                async with self.session.get(
                    self.BASE_URL + f"/api/v1/private/order/get/{order_id}",
                    headers=headers,
                    timeout=aiohttp.ClientTimeout(total=2)
                ) as resp:
                    data = await resp.json()
                    if data.get("success") and data.get("data"):
                        order = data["data"]
                        state = order.get("state", 0)
                        if state == 3:  # fully filled
                            avg_px = float(order.get("dealAvgPrice", 0) or 0)
                            deal_vol = float(order.get("dealVol", 0) or 0)
                            return {
                                "fill_price": avg_px,
                                "filled_usd": deal_vol * avg_px if avg_px > 0 else 0,
                                "fees_usd": 0,  # MEXC doesn't return fees in order query
                            }
            except Exception:
                pass
            await asyncio.sleep(0.3)
        return {}

    async def get_balance(self) -> Dict[str, float]:
        timestamp = str(int(time.time() * 1000))
        params = f"currency=USDT&timestamp={timestamp}"
        signature = self._sign(params)
        headers = {
            "ApiKey": self.api_key,
            "Signature": signature,
            "Request-Time": timestamp,
        }
        try:
            async with self.session.get(
                self.BASE_URL + f"/api/v1/private/account/assets?{params}",
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=5)
            ) as resp:
                data = await resp.json()
                if data.get("success") and data.get("data"):
                    self._mark_success()
                    for asset in data["data"]:
                        if asset.get("currency") == "USDT":
                            return {
                                "available": float(asset.get("availableBalance", 0) or 0),
                                "locked": float(asset.get("frozenBalance", 0) or 0),
                            }
        except Exception as e:
            self._mark_error(str(e))
        return {"available": 0, "locked": 0}

    async def get_open_positions(self) -> List[dict]:
        timestamp = str(int(time.time() * 1000))
        params = f"timestamp={timestamp}"
        signature = self._sign(params)
        headers = {
            "ApiKey": self.api_key,
            "Signature": signature,
            "Request-Time": timestamp,
        }
        try:
            async with self.session.get(
                self.BASE_URL + f"/api/v1/private/position/open_positions?{params}",
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=5)
            ) as resp:
                data = await resp.json()
                if data.get("success"):
                    self._mark_success()
                    positions = []
                    for p in data.get("data", []):
                        vol = float(p.get("holdVol", 0) or 0)
                        if vol == 0:
                            continue
                        sym = p.get("symbol", "").replace("_", "")
                        positions.append({
                            "symbol": sym,
                            "side": "long" if p.get("positionType") == 1 else "short",
                            "size": vol,
                            "notional_usd": float(p.get("holdVol", 0) or 0) * float(p.get("openAvgPrice", 0) or 0),
                            "unrealized_pnl": float(p.get("unrealisedPnl", 0) or 0),
                        })
                    return positions
        except Exception as e:
            self._mark_error(str(e))
        return []
```

- [ ] **Step 5: Add BloFin executor**

```python
class BloFinExecutor(ExchangeExecutor):
    """BloFin API — HMAC-SHA256 similar to OKX, requires passphrase."""

    BASE_URL = "https://openapi.blofin.com"

    def __init__(self, api_key: str, api_secret: str, passphrase: str, session: aiohttp.ClientSession):
        super().__init__("BloFin", api_key, api_secret, session)
        self.passphrase = passphrase

    def _sign(self, timestamp: str, method: str, path: str, body: str = "") -> str:
        message = timestamp + method.upper() + path + body
        signature = hmac.new(
            self.api_secret.encode(), message.encode(), hashlib.sha256
        ).digest()
        return base64.b64encode(signature).decode()

    def _headers(self, method: str, path: str, body: str = "") -> dict:
        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + \
                    f"{datetime.now(timezone.utc).microsecond // 1000:03d}Z"
        return {
            "ACCESS-KEY": self.api_key,
            "ACCESS-SIGN": self._sign(timestamp, method, path, body),
            "ACCESS-TIMESTAMP": timestamp,
            "ACCESS-PASSPHRASE": self.passphrase,
            "Content-Type": "application/json",
        }

    async def place_market_order(self, symbol: str, side: str, size_usd: float) -> OrderResult:
        t0 = time.time()
        base = symbol.replace("USDT", "")
        inst_id = f"{base}-USDT"
        path = "/api/v1/trade/order"

        body = json.dumps({
            "instId": inst_id,
            "marginMode": "cross",
            "side": side,
            "orderType": "market",
            "size": str(size_usd),
            "sizeType": "quoteCoin",
        })

        if DRY_RUN:
            log.info(f"[DRY_RUN] BloFin {side} {symbol} ${size_usd:.2f}")
            return OrderResult(
                success=True, order_id=f"dry_{int(time.time()*1000)}",
                exchange="BloFin", symbol=symbol, side=side,
                size_usd=size_usd, filled_usd=size_usd, fill_price=0.0,
                fees_usd=0.0, timestamp=time.time(),
                latency_ms=(time.time() - t0) * 1000,
            )

        headers = self._headers("POST", path, body)
        try:
            async with self.session.post(
                self.BASE_URL + path, headers=headers, data=body,
                timeout=aiohttp.ClientTimeout(total=ORDER_TIMEOUT_SEC)
            ) as resp:
                data = await resp.json()
                latency = (time.time() - t0) * 1000

                if data.get("code") == "0" and data.get("data"):
                    order_data = data["data"][0] if isinstance(data["data"], list) else data["data"]
                    order_id = order_data.get("orderId", "")
                    self._mark_success()
                    fill = await self._wait_for_fill(order_id, inst_id)
                    return OrderResult(
                        success=True, order_id=order_id,
                        exchange="BloFin", symbol=symbol, side=side,
                        size_usd=size_usd,
                        filled_usd=fill.get("filled_usd", size_usd),
                        fill_price=fill.get("fill_price", 0.0),
                        fees_usd=fill.get("fees_usd", 0.0),
                        timestamp=time.time(), latency_ms=latency,
                    )
                else:
                    error = data.get("msg", str(data))
                    self._mark_error(error)
                    return OrderResult(
                        success=False, order_id="", exchange="BloFin",
                        symbol=symbol, side=side, size_usd=size_usd,
                        filled_usd=0, fill_price=0, fees_usd=0,
                        timestamp=time.time(), latency_ms=latency, error=error,
                    )
        except Exception as e:
            self._mark_error(str(e))
            return OrderResult(
                success=False, order_id="", exchange="BloFin",
                symbol=symbol, side=side, size_usd=size_usd,
                filled_usd=0, fill_price=0, fees_usd=0,
                timestamp=time.time(), latency_ms=(time.time() - t0) * 1000,
                error=str(e),
            )

    async def _wait_for_fill(self, order_id: str, inst_id: str, max_wait: float = 3.0) -> dict:
        deadline = time.time() + max_wait
        while time.time() < deadline:
            path = f"/api/v1/trade/order?orderId={order_id}&instId={inst_id}"
            headers = self._headers("GET", path)
            try:
                async with self.session.get(
                    self.BASE_URL + path, headers=headers,
                    timeout=aiohttp.ClientTimeout(total=2)
                ) as resp:
                    data = await resp.json()
                    if data.get("code") == "0" and data.get("data"):
                        orders = data["data"] if isinstance(data["data"], list) else [data["data"]]
                        if orders:
                            order = orders[0]
                            state = order.get("state", "")
                            if state == "filled":
                                avg_px = float(order.get("avgPrice", 0) or 0)
                                filled = float(order.get("accFillSize", 0) or 0)
                                fee = abs(float(order.get("fee", 0) or 0))
                                return {
                                    "fill_price": avg_px,
                                    "filled_usd": filled * avg_px if avg_px > 0 else 0,
                                    "fees_usd": fee,
                                }
            except Exception:
                pass
            await asyncio.sleep(0.3)
        return {}

    async def get_balance(self) -> Dict[str, float]:
        path = "/api/v1/account/balance"
        headers = self._headers("GET", path)
        try:
            async with self.session.get(
                self.BASE_URL + path, headers=headers,
                timeout=aiohttp.ClientTimeout(total=5)
            ) as resp:
                data = await resp.json()
                if data.get("code") == "0" and data.get("data"):
                    self._mark_success()
                    for d in data["data"]:
                        if d.get("ccy") == "USDT":
                            return {
                                "available": float(d.get("availBal", 0) or 0),
                                "locked": float(d.get("frozenBal", 0) or 0),
                            }
        except Exception as e:
            self._mark_error(str(e))
        return {"available": 0, "locked": 0}

    async def get_open_positions(self) -> List[dict]:
        path = "/api/v1/account/positions"
        headers = self._headers("GET", path)
        try:
            async with self.session.get(
                self.BASE_URL + path, headers=headers,
                timeout=aiohttp.ClientTimeout(total=5)
            ) as resp:
                data = await resp.json()
                if data.get("code") == "0":
                    self._mark_success()
                    positions = []
                    for p in data.get("data", []):
                        pos_amt = float(p.get("positions", 0) or 0)
                        if pos_amt == 0:
                            continue
                        inst_id = p.get("instId", "")
                        sym = inst_id.replace("-", "")
                        positions.append({
                            "symbol": sym,
                            "side": p.get("positionSide", "").lower(),
                            "size": abs(pos_amt),
                            "notional_usd": abs(float(p.get("notionalUsd", 0) or 0)),
                            "unrealized_pnl": float(p.get("upl", 0) or 0),
                        })
                    return positions
        except Exception as e:
            self._mark_error(str(e))
        return []
```

- [ ] **Step 6: Add executor factory function**

```python
def create_executors(session: aiohttp.ClientSession) -> Dict[str, ExchangeExecutor]:
    """Create executor instances for all configured exchanges."""
    executors = {}

    if OKX_API_KEY and OKX_API_SECRET:
        executors["OKX"] = OKXExecutor(OKX_API_KEY, OKX_API_SECRET, OKX_PASSPHRASE, session)
    if BYBIT_API_KEY and BYBIT_API_SECRET:
        executors["Bybit"] = BybitExecutor("Bybit", BYBIT_API_KEY, BYBIT_API_SECRET, session)
    if MEXC_API_KEY and MEXC_API_SECRET:
        executors["MEXC"] = MEXCExecutor("MEXC", MEXC_API_KEY, MEXC_API_SECRET, session)
    if BLOFIN_API_KEY and BLOFIN_API_SECRET:
        executors["BloFin"] = BloFinExecutor(BLOFIN_API_KEY, BLOFIN_API_SECRET, BLOFIN_PASSPHRASE, session)

    return executors
```

- [ ] **Step 7: Commit**

```bash
git add deploy-live/real_trader.py
git commit -m "feat: add exchange executors with HMAC auth for OKX, Bybit, MEXC, BloFin"
```

---

## Task 4: Price Feeds (WS + REST Batch Fetchers)

**Files:**
- Modify: `deploy-live/real_trader.py`

- [ ] **Step 1: Copy helper functions from paper trader**

Copy these from `paper_trader.py`:
- `_get()` async helper (around line 463-496) — HTTP GET with retry
- `PriceQuote` dataclass (already added in Task 2)

```python
async def _get(session, url, timeout=8):
    """GET with timeout, returns parsed JSON or None."""
    try:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=timeout)) as resp:
            if resp.status == 200:
                return await resp.json()
    except Exception:
        pass
    return None
```

- [ ] **Step 2: Copy batch fetchers for OKX, Bybit, MEXC, BloFin**

Copy these functions from `paper_trader.py` (they are read-only public API, no auth needed):
- `fetch_okx_perp()` and `fetch_okx_spot()`
- `fetch_bybit_perp()` and `fetch_bybit_spot()`
- `fetch_mexc_perp()` and `fetch_mexc_spot()`
- `fetch_blofin_perp()`

These are around lines 1642-2280 in paper_trader.py. Copy them exactly — they fetch ticker data from public endpoints.

Set BATCH_FETCHERS to only include these 4 exchanges (7 fetchers total):

```python
BATCH_FETCHERS = [
    fetch_okx_perp, fetch_okx_spot,
    fetch_bybit_perp, fetch_bybit_spot,
    fetch_mexc_perp, fetch_mexc_spot,
    fetch_blofin_perp,
]
```

- [ ] **Step 3: Copy websocket managers**

Copy from `paper_trader.py`:
- `ExchangeWSManager` class (line 889-1168) — handles Bybit, OKX, Bitget WS feeds
- `OrderbookWSManager` class (line 1170-1640) — handles L2 orderbook WS feeds

Modify `ExchangeWSManager.__init__` to only include OKX, Bybit, MEXC (BloFin WS is not used in the paper trader — it uses REST only). Remove Binance, Gate.io, Bitget, KuCoin, BingX from the WS manager subscriptions.

Note: `BinanceWSManager` is NOT needed since Binance is not in the EU exchange list.

- [ ] **Step 4: Copy symbol discovery function**

Copy the `discover_symbols()` function from paper_trader.py (around line 5566-5640) that queries all exchanges for available USDT pairs and finds symbols listed on 2+ exchanges.

Modify `MIN_EXCHANGES_PER_SYMBOL = 2` (was 3) since we only have 4 exchanges.

- [ ] **Step 5: Copy funding rate fetcher**

Copy `fetch_all_funding_rates()` and `get_funding_rate()` from paper_trader.py (around lines 2100-2247). Only include OKX, Bybit, MEXC, BloFin rate fetchers.

- [ ] **Step 6: Commit**

```bash
git add deploy-live/real_trader.py
git commit -m "feat: add price feeds — REST batch fetchers + WS managers for 4 exchanges"
```

---

## Task 5: Risk Manager

**Files:**
- Modify: `deploy-live/real_trader.py`

- [ ] **Step 1: Add RiskManager class**

```python
class RiskManager:
    """Enforces all risk limits before and during trading."""

    def __init__(self, portfolio: Portfolio, executors: Dict[str, ExchangeExecutor]):
        self.portfolio = portfolio
        self.executors = executors
        self.kill_switch_active = False
        self.kill_switch_time: Optional[float] = None
        self.manual_stop = False
        self.balance_cache: Dict[str, Dict[str, float]] = {}  # exchange -> {available, locked}
        self.last_balance_refresh = 0.0
        self.last_reconcile_time = 0.0
        self.degraded_positions: List[LivePosition] = []

    async def refresh_balances(self):
        """Refresh cached balances from all exchanges."""
        if time.time() - self.last_balance_refresh < BALANCE_REFRESH_SEC:
            return
        results = await asyncio.gather(
            *[ex.get_balance() for ex in self.executors.values()],
            return_exceptions=True
        )
        for ex_name, result in zip(self.executors.keys(), results):
            if isinstance(result, Exception):
                log.warning(f"Balance refresh failed for {ex_name}: {result}")
                continue
            self.balance_cache[ex_name] = result
        self.last_balance_refresh = time.time()

    def get_available_balance(self, exchange: str) -> float:
        return self.balance_cache.get(exchange, {}).get("available", 0.0)

    def can_trade(self) -> Tuple[bool, str]:
        """Check if trading is allowed. Returns (allowed, reason)."""
        if self.manual_stop:
            return False, "manual_stop"

        if self.kill_switch_active:
            elapsed = time.time() - (self.kill_switch_time or 0)
            if elapsed < COOLDOWN_AFTER_KILL_SEC:
                remaining = COOLDOWN_AFTER_KILL_SEC - elapsed
                return False, f"kill_switch_cooldown ({remaining:.0f}s remaining)"
            # Cooldown expired — check if equity recovered
            if self.portfolio.equity >= self.portfolio.starting_capital * 0.90:
                self.kill_switch_active = False
                log.info("Kill switch reset — equity recovered above threshold")
            else:
                return False, "kill_switch_equity_below_threshold"

        # Drawdown check
        equity = self.portfolio.equity
        if equity < self.portfolio.starting_capital * (1 - KILL_SWITCH_DRAWDOWN_PCT / 100):
            return False, "drawdown_exceeded"

        return True, ""

    def can_open_position(self, exchange_short: str, exchange_long: str, size_usd: float) -> Tuple[bool, str]:
        """Check if a specific position can be opened."""
        can, reason = self.can_trade()
        if not can:
            return False, reason

        # Position count
        n_open = len(self.portfolio.open_positions)
        if n_open >= MAX_CONCURRENT:
            return False, f"max_positions ({n_open}/{MAX_CONCURRENT})"

        # Size cap
        if size_usd > MAX_POSITION_USD:
            size_usd = MAX_POSITION_USD

        # Balance check
        bal_short = self.get_available_balance(exchange_short)
        bal_long = self.get_available_balance(exchange_long)
        if bal_short < size_usd:
            return False, f"insufficient_balance_{exchange_short} (${bal_short:.2f})"
        if bal_long < size_usd:
            return False, f"insufficient_balance_{exchange_long} (${bal_long:.2f})"

        # Exchange health
        ex_short = self.executors.get(exchange_short)
        ex_long = self.executors.get(exchange_long)
        if ex_short and not ex_short.healthy:
            return False, f"exchange_unhealthy_{exchange_short}"
        if ex_long and not ex_long.healthy:
            return False, f"exchange_unhealthy_{exchange_long}"

        # Degraded exposure check
        degraded_usd = sum(p.size_usd for p in self.portfolio.open_positions if p.status == "DEGRADED")
        if degraded_usd > self.portfolio.equity * 0.50:
            return False, f"degraded_exposure_too_high (${degraded_usd:.2f})"

        # Concentration limit
        exposure_short = sum(p.size_usd for p in self.portfolio.open_positions
                            if p.exchange_short == exchange_short or p.exchange_long == exchange_short)
        exposure_long = sum(p.size_usd for p in self.portfolio.open_positions
                           if p.exchange_short == exchange_long or p.exchange_long == exchange_long)
        max_per_ex = bal_short * MAX_PER_EXCHANGE_PCT
        if exposure_short + size_usd > max_per_ex:
            return False, f"concentration_{exchange_short}"
        max_per_ex = bal_long * MAX_PER_EXCHANGE_PCT
        if exposure_long + size_usd > max_per_ex:
            return False, f"concentration_{exchange_long}"

        # Aged position check
        now = datetime.now(timezone.utc)
        aged_exposure = sum(
            p.size_usd for p in self.portfolio.open_positions
            if (now - p.entry_time).total_seconds() / 60 > AGED_POSITION_THRESHOLD_MIN
        )
        if aged_exposure >= self.portfolio.equity * AGED_POSITION_MAX_ALLOC_PCT:
            return False, "aged_position_budget_full"

        return True, ""

    async def trigger_kill_switch(self, reason: str):
        """Activate kill switch — close all positions."""
        self.kill_switch_active = True
        self.kill_switch_time = time.time()
        log.critical(f"KILL SWITCH ACTIVATED: {reason}")

    async def reconcile_positions(self, session: aiohttp.ClientSession):
        """Compare bot state with actual exchange positions."""
        if time.time() - self.last_reconcile_time < RECONCILE_INTERVAL_SEC:
            return []

        self.last_reconcile_time = time.time()
        mismatches = []

        for ex_name, executor in self.executors.items():
            try:
                actual_positions = await executor.get_open_positions()
                # Compare with bot's tracked positions on this exchange
                bot_positions = [
                    p for p in self.portfolio.open_positions
                    if p.exchange_short == ex_name or p.exchange_long == ex_name
                ]

                actual_symbols = {p["symbol"] for p in actual_positions}
                bot_symbols = set()
                for p in bot_positions:
                    if p.exchange_short == ex_name:
                        bot_symbols.add(p.symbol)
                    if p.exchange_long == ex_name:
                        bot_symbols.add(p.symbol)

                orphaned = actual_symbols - bot_symbols
                missing = bot_symbols - actual_symbols

                if orphaned:
                    mismatches.append(f"{ex_name}: orphaned positions {orphaned}")
                if missing:
                    mismatches.append(f"{ex_name}: missing positions {missing}")

            except Exception as e:
                log.warning(f"Reconciliation failed for {ex_name}: {e}")

        if mismatches:
            log.warning(f"RECONCILIATION MISMATCH: {mismatches}")

        return mismatches
```

- [ ] **Step 2: Commit**

```bash
git add deploy-live/real_trader.py
git commit -m "feat: add risk manager with kill switch, balance checks, reconciliation"
```

---

## Task 6: Trade Execution Engine

**Files:**
- Modify: `deploy-live/real_trader.py`

- [ ] **Step 1: Add TradeExecutor class**

```python
class TradeExecutor:
    """Handles the full lifecycle of opening and closing live positions."""

    def __init__(self, executors: Dict[str, ExchangeExecutor],
                 portfolio: Portfolio, risk_mgr: RiskManager):
        self.executors = executors
        self.portfolio = portfolio
        self.risk_mgr = risk_mgr
        self.order_audit_log: List[dict] = []  # Full audit trail

    def _log_order(self, result: OrderResult, action: str, position_id: int):
        """Record every order in audit log."""
        self.order_audit_log.append({
            "timestamp": result.timestamp,
            "action": action,
            "position_id": position_id,
            "exchange": result.exchange,
            "symbol": result.symbol,
            "side": result.side,
            "size_usd": result.size_usd,
            "filled_usd": result.filled_usd,
            "fill_price": result.fill_price,
            "fees_usd": result.fees_usd,
            "order_id": result.order_id,
            "latency_ms": result.latency_ms,
            "success": result.success,
            "error": result.error,
            "dry_run": DRY_RUN,
        })
        # Keep audit log bounded (last 1000 orders)
        if len(self.order_audit_log) > 1000:
            self.order_audit_log = self.order_audit_log[-1000:]

    async def open_position(self, symbol: str, q_high: PriceQuote, q_low: PriceQuote,
                            spread_pct: float, size_usd: float,
                            session: aiohttp.ClientSession) -> Optional[LivePosition]:
        """Execute entry: place both legs simultaneously, handle failures."""
        # Cap size
        size_usd = min(size_usd, MAX_POSITION_USD)

        ex_short = self.executors.get(q_high.exchange)
        ex_long = self.executors.get(q_low.exchange)
        if not ex_short or not ex_long:
            return None

        pos_id = self.portfolio.next_id
        self.portfolio.next_id += 1

        log.info(f"EXEC ENTRY #{pos_id} {symbol}: SHORT {q_high.exchange} / LONG {q_low.exchange} "
                 f"spread={spread_pct:.3f}% size=${size_usd:.2f}")

        # Place both legs simultaneously
        result_short, result_long = await asyncio.gather(
            ex_short.place_market_order(symbol, "sell", size_usd),
            ex_long.place_market_order(symbol, "buy", size_usd),
        )

        self._log_order(result_short, "entry_short", pos_id)
        self._log_order(result_long, "entry_long", pos_id)

        # Case A: Both filled
        if result_short.success and result_long.success:
            # Match sizes if different fills
            actual_size = min(result_short.filled_usd, result_long.filled_usd)
            if actual_size < 5:
                log.warning(f"ENTRY #{pos_id} filled too small: ${actual_size:.2f}")
                # Close both legs
                await self._emergency_close_leg(ex_short, symbol, "buy", result_short.filled_usd, pos_id)
                await self._emergency_close_leg(ex_long, symbol, "sell", result_long.filled_usd, pos_id)
                return None

            pos = LivePosition(
                id=pos_id, symbol=symbol,
                exchange_short=q_high.exchange, exchange_long=q_low.exchange,
                instrument_short=q_high.instrument, instrument_long=q_low.instrument,
                entry_spread_pct=spread_pct,
                entry_price_short=result_short.fill_price,
                entry_price_long=result_long.fill_price,
                size_usd=actual_size,
                entry_time=datetime.now(timezone.utc),
                order_id_short=result_short.order_id,
                order_id_long=result_long.order_id,
                entry_fees_usd=result_short.fees_usd + result_long.fees_usd,
            )
            self.portfolio.positions.append(pos)
            self.portfolio.total_trades += 1
            log.info(f"OPEN #{pos_id} {symbol} {q_high.exchange}/{q_low.exchange} "
                     f"spread={spread_pct:.3f}% size=${actual_size:.2f} "
                     f"short@{result_short.fill_price:.6f} long@{result_long.fill_price:.6f} "
                     f"latency={result_short.latency_ms:.0f}ms/{result_long.latency_ms:.0f}ms")
            return pos

        # Case B: One filled, one failed — emergency close the filled leg
        if result_short.success and not result_long.success:
            log.warning(f"ENTRY #{pos_id} LEG FAILURE: short filled, long failed ({result_long.error})")
            await self._emergency_close_leg(ex_short, symbol, "buy", result_short.filled_usd, pos_id)
            return None

        if result_long.success and not result_short.success:
            log.warning(f"ENTRY #{pos_id} LEG FAILURE: long filled, short failed ({result_short.error})")
            await self._emergency_close_leg(ex_long, symbol, "sell", result_long.filled_usd, pos_id)
            return None

        # Case D: Both failed
        log.warning(f"ENTRY #{pos_id} BOTH LEGS FAILED: short={result_short.error} long={result_long.error}")
        return None

    async def _emergency_close_leg(self, executor: ExchangeExecutor, symbol: str,
                                    side: str, size_usd: float, pos_id: int):
        """Close a single leg that was left open due to the other leg failing."""
        for attempt in range(6):
            delay = [1, 2, 5, 10, 10, 10][attempt]
            result = await executor.place_market_order(symbol, side, size_usd)
            self._log_order(result, f"emergency_close_attempt_{attempt+1}", pos_id)
            if result.success:
                log.info(f"EMERGENCY CLOSE #{pos_id} succeeded on attempt {attempt+1}")
                return
            log.warning(f"EMERGENCY CLOSE #{pos_id} attempt {attempt+1} failed: {result.error}")
            await asyncio.sleep(delay)
        log.critical(f"EMERGENCY CLOSE #{pos_id} FAILED after 6 attempts — DEGRADED STATE")

    async def close_position(self, pos: LivePosition,
                             current_spread: float, reason: str) -> bool:
        """Execute exit: close both legs, handle failures with retry escalation."""
        ex_short = self.executors.get(pos.exchange_short)
        ex_long = self.executors.get(pos.exchange_long)
        if not ex_short or not ex_long:
            return False

        pos.status = "CLOSING"
        log.info(f"EXEC EXIT #{pos.id} {pos.symbol}: reason={reason} spread={current_spread:.3f}%")

        # Close both legs: buy back short, sell long
        result_short, result_long = await asyncio.gather(
            ex_short.place_market_order(pos.symbol, "buy", pos.size_usd),
            ex_long.place_market_order(pos.symbol, "sell", pos.size_usd),
        )

        self._log_order(result_short, "exit_short", pos.id)
        self._log_order(result_long, "exit_long", pos.id)

        short_closed = result_short.success
        long_closed = result_long.success

        if short_closed and long_closed:
            # Both closed — calculate P&L
            self._finalize_close(pos, result_short, result_long, current_spread, reason)
            return True

        # One or both legs failed — enter retry escalation
        if not short_closed:
            pos.status = "DEGRADED"
            pos.degraded_leg = "short"
            pos.close_retry_count = 1
            pos.last_close_attempt = time.time()
            log.warning(f"EXIT #{pos.id} short leg failed: {result_short.error} — DEGRADED")

        if not long_closed:
            pos.status = "DEGRADED"
            pos.degraded_leg = "long" if short_closed else "both"
            pos.close_retry_count = 1
            pos.last_close_attempt = time.time()
            log.warning(f"EXIT #{pos.id} long leg failed: {result_long.error} — DEGRADED")

        # Store partial results for when the other leg eventually closes
        if short_closed:
            pos.exit_price_short = result_short.fill_price
            pos.order_id_close_short = result_short.order_id
        if long_closed:
            pos.exit_price_long = result_long.fill_price
            pos.order_id_close_long = result_long.order_id

        return False

    async def retry_degraded_positions(self):
        """Retry closing degraded positions on every cycle."""
        for pos in self.portfolio.open_positions:
            if pos.status != "DEGRADED":
                continue

            # Retry schedule: 1s, 2s, 5s, then every 30s
            elapsed = time.time() - (pos.last_close_attempt or 0)
            if pos.close_retry_count <= 3:
                delay = [1, 2, 5][pos.close_retry_count - 1]
            elif pos.close_retry_count <= 6:
                delay = 10
            else:
                delay = 30

            if elapsed < delay:
                continue

            pos.close_retry_count += 1
            pos.last_close_attempt = time.time()

            if pos.degraded_leg in ("short", "both"):
                ex = self.executors.get(pos.exchange_short)
                if ex:
                    result = await ex.place_market_order(pos.symbol, "buy", pos.size_usd)
                    self._log_order(result, f"retry_close_short_{pos.close_retry_count}", pos.id)
                    if result.success:
                        pos.exit_price_short = result.fill_price
                        pos.order_id_close_short = result.order_id
                        if pos.degraded_leg == "short":
                            pos.degraded_leg = ""
                        elif pos.degraded_leg == "both":
                            pos.degraded_leg = "long"
                        log.info(f"RECOVERED short leg #{pos.id} on retry {pos.close_retry_count}")

            if pos.degraded_leg in ("long", "both"):
                ex = self.executors.get(pos.exchange_long)
                if ex:
                    result = await ex.place_market_order(pos.symbol, "sell", pos.size_usd)
                    self._log_order(result, f"retry_close_long_{pos.close_retry_count}", pos.id)
                    if result.success:
                        pos.exit_price_long = result.fill_price
                        pos.order_id_close_long = result.order_id
                        if pos.degraded_leg == "long":
                            pos.degraded_leg = ""
                        elif pos.degraded_leg == "both":
                            pos.degraded_leg = "short"
                        log.info(f"RECOVERED long leg #{pos.id} on retry {pos.close_retry_count}")

            # If both legs now closed, finalize
            if not pos.degraded_leg:
                # Build fake OrderResults from stored prices
                r_short = OrderResult(True, pos.order_id_close_short, pos.exchange_short,
                                      pos.symbol, "buy", pos.size_usd, pos.size_usd,
                                      pos.exit_price_short, 0.0, time.time())
                r_long = OrderResult(True, pos.order_id_close_long, pos.exchange_long,
                                     pos.symbol, "sell", pos.size_usd, pos.size_usd,
                                     pos.exit_price_long, 0.0, time.time())
                self._finalize_close(pos, r_short, r_long, 0.0, "recovered")

    def _finalize_close(self, pos: LivePosition,
                        result_short: OrderResult, result_long: OrderResult,
                        current_spread: float, reason: str):
        """Calculate P&L and move position to closed."""
        pos.status = "CLOSED"
        pos.exit_time = datetime.now(timezone.utc)
        pos.exit_spread_pct = current_spread
        pos.exit_price_short = result_short.fill_price
        pos.exit_price_long = result_long.fill_price
        pos.exit_fees_usd = result_short.fees_usd + result_long.fees_usd
        pos.exit_reason = reason

        # P&L calculation from actual fill prices
        # Short: sold at entry, bought back at exit
        # Long: bought at entry, sold at exit
        if pos.entry_price_short > 0 and pos.entry_price_long > 0:
            short_pnl = (pos.entry_price_short - pos.exit_price_short) / pos.entry_price_short
            long_pnl = (pos.exit_price_long - pos.entry_price_long) / pos.entry_price_long
            pos.gross_pnl_usd = (short_pnl + long_pnl) * pos.size_usd
        else:
            pos.gross_pnl_usd = 0.0

        pos.net_pnl_usd = pos.gross_pnl_usd - pos.entry_fees_usd - pos.exit_fees_usd

        # Update portfolio
        self.portfolio.cash += pos.net_pnl_usd
        self.portfolio.total_pnl_usd += pos.net_pnl_usd
        if pos.net_pnl_usd > 0:
            self.portfolio.total_wins += 1
        self.portfolio.closed_positions.append(pos)
        self.portfolio.positions.remove(pos)

        # Drawdown tracking
        equity = self.portfolio.equity
        if equity > self.portfolio.peak_equity:
            self.portfolio.peak_equity = equity
        dd = (self.portfolio.peak_equity - equity) / self.portfolio.peak_equity * 100
        if dd > self.portfolio.max_drawdown_pct:
            self.portfolio.max_drawdown_pct = dd

        log.info(f"CLOSE #{pos.id} {pos.symbol} reason={reason} "
                 f"pnl=${pos.net_pnl_usd:+.4f} gross=${pos.gross_pnl_usd:+.4f} "
                 f"fees=${pos.entry_fees_usd + pos.exit_fees_usd:.4f} "
                 f"dur={(pos.exit_time - pos.entry_time).total_seconds() / 60:.1f}m "
                 f"equity=${equity:.2f}")
```

- [ ] **Step 2: Commit**

```bash
git add deploy-live/real_trader.py
git commit -m "feat: add trade executor with entry/exit/retry/degraded handling"
```

---

## Task 7: Strategy Engine (Spread Detection + Filters)

**Files:**
- Modify: `deploy-live/real_trader.py`

- [ ] **Step 1: Add LiveTrader class with strategy logic**

This is the main trading class. Copy the spread detection and filtering logic from `PaperTrader` in paper_trader.py, but replace `open_position()` / `close_position()` calls with `TradeExecutor` calls.

Key methods to copy from PaperTrader (paper_trader.py lines 2469-4800):
- `__init__()` — state tracking (spread caches, baselines, blacklists)
- `_pair_key()` — canonical pair key generation
- `compute_fees()` — fee calculation per exchange pair
- `is_breakout()` — breakout guard logic
- `check_blacklist()` / `update_blacklist()` — symbol blacklisting
- `get_dynamic_exit_threshold()` — dynamic exit baseline
- `update_baseline_spreads()` — rolling spread baseline
- `fetch_orderbook_levels()` — OB data for depth checks
- `walk_orderbook()` — OB level walk-through
- `format_open_msg()` / `format_close_msg()` — Telegram message formatting

The `open_position()` and `close_position()` methods are NOT copied — those are paper-only. Instead, the main loop calls `TradeExecutor.open_position()` and `TradeExecutor.close_position()`.

```python
class LiveTrader:
    def __init__(self, executors: Dict[str, ExchangeExecutor]):
        self.executors = executors
        self.portfolio = Portfolio(
            starting_capital=STARTING_CAPITAL,
            cash=STARTING_CAPITAL,
            peak_equity=STARTING_CAPITAL,
        )
        self.risk_mgr = RiskManager(self.portfolio, executors)
        self.trade_executor = TradeExecutor(executors, self.portfolio, self.risk_mgr)
        self.running = True
        self.symbols_set: set = set()
        self.price_cache: Dict[str, List[PriceQuote]] = {}
        # Spread tracking (copied from PaperTrader)
        self.confirm_counts: Dict[str, int] = {}
        self.prev_spreads: Dict[str, float] = {}
        self.spread_tick_history: Dict[str, List[float]] = {}
        self.baseline_spreads: Dict[str, List[float]] = {}
        self.entry_baselines: Dict[str, List[float]] = {}
        self.last_quote_time: Dict[str, float] = {}
        self.pair_stats: Dict[str, dict] = {}
        self.symbol_spread_readings: Dict[str, List[float]] = {}
        self.symbol_blacklist: Dict[str, float] = {}
        self.ob_empty_cache: Dict[str, int] = {}
        self.equity_history: List[dict] = []
        # State persistence
        self.data_dir = DATA_DIR
        self.state_path = os.path.join(DATA_DIR, "real_state.json")
        self._load_state()

    # Copy these methods from PaperTrader in paper_trader.py:
    # _pair_key, compute_fees, is_breakout, check_symbol_blacklist,
    # update_symbol_blacklist, get_dynamic_exit_threshold,
    # update_baseline_spreads, fetch_orderbook_levels, walk_orderbook,
    # _incremental_fill (static method)

    # Modify format_open_msg and format_close_msg to say "LIVE TRADE" instead of "PAPER TRADE"

    def _save_state(self):
        """Persist portfolio state to disk."""
        state = {
            "cash": self.portfolio.cash,
            "next_id": self.portfolio.next_id,
            "total_trades": self.portfolio.total_trades,
            "total_wins": self.portfolio.total_wins,
            "total_pnl_usd": self.portfolio.total_pnl_usd,
            "peak_equity": self.portfolio.peak_equity,
            "max_drawdown_pct": self.portfolio.max_drawdown_pct,
            "equity_history": self.equity_history[-2000:],
            "open_positions": [self._pos_to_dict(p) for p in self.portfolio.open_positions],
            "closed_positions": [self._pos_to_dict(p) for p in self.portfolio.closed_positions[-500:]],
            "order_audit_log": self.trade_executor.order_audit_log[-200:],
            "balance_cache": self.risk_mgr.balance_cache,
        }
        tmp = self.state_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(state, f)
        os.replace(tmp, self.state_path)

    def _load_state(self):
        try:
            with open(self.state_path) as f:
                d = json.load(f)
            self.portfolio.cash = d.get("cash", STARTING_CAPITAL)
            self.portfolio.next_id = d.get("next_id", 1)
            self.portfolio.total_trades = d.get("total_trades", 0)
            self.portfolio.total_wins = d.get("total_wins", 0)
            self.portfolio.total_pnl_usd = d.get("total_pnl_usd", 0.0)
            self.portfolio.peak_equity = d.get("peak_equity", STARTING_CAPITAL)
            self.portfolio.max_drawdown_pct = d.get("max_drawdown_pct", 0.0)
            self.equity_history = d.get("equity_history", [])
            for pd in d.get("open_positions", []):
                pos = self._pos_from_dict(pd)
                if pos:
                    self.portfolio.positions.append(pos)
            for pd in d.get("closed_positions", []):
                pos = self._pos_from_dict(pd)
                if pos:
                    pos.status = "CLOSED"
                    self.portfolio.closed_positions.append(pos)
            self.trade_executor.order_audit_log = d.get("order_audit_log", [])
            self.risk_mgr.balance_cache = d.get("balance_cache", {})
            log.info(f"State loaded: equity=${self.portfolio.equity:,.2f} "
                     f"open={len(self.portfolio.open_positions)} "
                     f"closed={len(self.portfolio.closed_positions)}")
        except (FileNotFoundError, json.JSONDecodeError):
            log.info(f"Starting fresh: equity=${STARTING_CAPITAL:,.2f}")

    def _pos_to_dict(self, p: LivePosition) -> dict:
        return {
            "id": p.id, "symbol": p.symbol,
            "exchange_short": p.exchange_short, "exchange_long": p.exchange_long,
            "instrument_short": p.instrument_short, "instrument_long": p.instrument_long,
            "entry_spread_pct": p.entry_spread_pct,
            "entry_price_short": p.entry_price_short, "entry_price_long": p.entry_price_long,
            "size_usd": p.size_usd,
            "entry_time": p.entry_time.isoformat() if p.entry_time else None,
            "order_id_short": p.order_id_short, "order_id_long": p.order_id_long,
            "order_id_close_short": p.order_id_close_short,
            "order_id_close_long": p.order_id_close_long,
            "status": p.status, "degraded_leg": p.degraded_leg,
            "exit_time": p.exit_time.isoformat() if p.exit_time else None,
            "exit_spread_pct": p.exit_spread_pct,
            "exit_price_short": p.exit_price_short, "exit_price_long": p.exit_price_long,
            "exit_reason": p.exit_reason,
            "entry_fees_usd": p.entry_fees_usd, "exit_fees_usd": p.exit_fees_usd,
            "gross_pnl_usd": p.gross_pnl_usd, "net_pnl_usd": p.net_pnl_usd,
            "close_retry_count": p.close_retry_count,
        }

    def _pos_from_dict(self, d: dict) -> Optional[LivePosition]:
        try:
            entry_time = datetime.fromisoformat(d["entry_time"]) if d.get("entry_time") else datetime.now(timezone.utc)
            exit_time = datetime.fromisoformat(d["exit_time"]) if d.get("exit_time") else None
            return LivePosition(
                id=d["id"], symbol=d["symbol"],
                exchange_short=d["exchange_short"], exchange_long=d["exchange_long"],
                instrument_short=d.get("instrument_short", "PERP"),
                instrument_long=d.get("instrument_long", "PERP"),
                entry_spread_pct=d.get("entry_spread_pct", 0),
                entry_price_short=d.get("entry_price_short", 0),
                entry_price_long=d.get("entry_price_long", 0),
                size_usd=d.get("size_usd", 0),
                entry_time=entry_time,
                order_id_short=d.get("order_id_short", ""),
                order_id_long=d.get("order_id_long", ""),
                status=d.get("status", "OPEN"),
                degraded_leg=d.get("degraded_leg", ""),
                exit_time=exit_time,
                exit_price_short=d.get("exit_price_short", 0),
                exit_price_long=d.get("exit_price_long", 0),
                exit_reason=d.get("exit_reason", ""),
                entry_fees_usd=d.get("entry_fees_usd", 0),
                exit_fees_usd=d.get("exit_fees_usd", 0),
                gross_pnl_usd=d.get("gross_pnl_usd", 0),
                net_pnl_usd=d.get("net_pnl_usd", 0),
                close_retry_count=d.get("close_retry_count", 0),
            )
        except (KeyError, ValueError) as e:
            log.warning(f"Failed to load position: {e}")
            return None
```

- [ ] **Step 2: Commit**

```bash
git add deploy-live/real_trader.py
git commit -m "feat: add LiveTrader class with strategy engine and state persistence"
```

---

## Task 8: Telegram Integration

**Files:**
- Modify: `deploy-live/real_trader.py`

- [ ] **Step 1: Copy send_telegram and exchange_link from paper trader**

Copy from paper_trader.py lines 2416-2462. Identical code.

- [ ] **Step 2: Add Telegram command listener**

```python
class TelegramCommandListener:
    """Listens for incoming Telegram commands and dispatches actions."""

    def __init__(self, trader: LiveTrader):
        self.trader = trader
        self.last_update_id = 0

    async def poll_commands(self, session: aiohttp.ClientSession):
        """Check for new Telegram messages (non-blocking, called every few seconds)."""
        if not BOT_TOKEN:
            return
        url = f"https://api.telegram.org/bot{BOT_TOKEN}/getUpdates"
        params = {"offset": self.last_update_id + 1, "timeout": 0, "limit": 10}
        try:
            async with session.get(url, params=params,
                                   timeout=aiohttp.ClientTimeout(total=3)) as resp:
                if resp.status != 200:
                    return
                data = await resp.json()
                for update in data.get("result", []):
                    self.last_update_id = update["update_id"]
                    msg = update.get("message", {})
                    text = msg.get("text", "").strip().lower()
                    chat_id = str(msg.get("chat", {}).get("id", ""))
                    if chat_id != CHAT_ID:
                        continue
                    await self._handle_command(text, session)
        except Exception:
            pass

    async def _handle_command(self, text: str, session: aiohttp.ClientSession):
        if text == "/status":
            p = self.trader.portfolio
            n_open = len(p.open_positions)
            dd = p.max_drawdown_pct
            msg = (
                f"📊 *LIVE STATUS*\n\n"
                f"Equity: *${p.equity:,.2f}*\n"
                f"Cash: ${p.cash:,.2f}\n"
                f"Open: {n_open}/{MAX_CONCURRENT}\n"
                f"Closed: {len(p.closed_positions)}\n"
                f"P&L: ${p.total_pnl_usd:+.2f}\n"
                f"Win rate: {p.total_wins}/{p.total_trades}\n"
                f"Drawdown: {dd:.2f}%\n"
                f"Kill switch: {'🔴 ACTIVE' if self.trader.risk_mgr.kill_switch_active else '🟢 OFF'}\n"
                f"DRY RUN: {'YES' if DRY_RUN else 'NO'}"
            )
            await send_telegram(session, msg)

        elif text == "/stop":
            self.trader.risk_mgr.manual_stop = True
            await send_telegram(session, "🛑 *MANUAL STOP* — trading halted, closing all positions")
            # Close all open positions
            for pos in list(self.trader.portfolio.open_positions):
                await self.trader.trade_executor.close_position(pos, 0.0, "manual_stop")

        elif text == "/start":
            self.trader.risk_mgr.manual_stop = False
            await send_telegram(session, "🟢 *TRADING RESUMED*")

        elif text == "/dryrun":
            global DRY_RUN
            DRY_RUN = not DRY_RUN
            await send_telegram(session, f"DRY RUN: {'ON' if DRY_RUN else '⚠️ OFF — LIVE ORDERS ENABLED'}")

        elif text == "/balance":
            await self.trader.risk_mgr.refresh_balances()
            lines = ["💰 *EXCHANGE BALANCES*\n"]
            for ex_name, bal in self.trader.risk_mgr.balance_cache.items():
                ex = self.trader.executors.get(ex_name)
                health = "●" if ex and ex.healthy else "⚠"
                lines.append(f"{health} {ex_name}: ${bal.get('available', 0):,.2f} avail / ${bal.get('locked', 0):,.2f} locked")
            await send_telegram(session, "\n".join(lines))
```

- [ ] **Step 3: Add formatted trade notification messages**

```python
def format_live_open_msg(pos: LivePosition, portfolio: Portfolio) -> str:
    return (
        f"🟢 *LIVE TRADE #{pos.id} OPENED*\n\n"
        f"*{pos.symbol}*\n"
        f"SHORT {pos.exchange_short} @ ${pos.entry_price_short:.6f} (${pos.size_usd:.2f})\n"
        f"LONG  {pos.exchange_long} @ ${pos.entry_price_long:.6f} (${pos.size_usd:.2f})\n"
        f"Spread: {pos.entry_spread_pct:.3f}%\n"
        f"Fees: ${pos.entry_fees_usd:.4f}\n"
        f"Orders: `{pos.order_id_short}` / `{pos.order_id_long}`\n"
        f"Open: {len(portfolio.open_positions)}/{MAX_CONCURRENT} | "
        f"Equity: ${portfolio.equity:,.2f}"
    )


def format_live_close_msg(pos: LivePosition, portfolio: Portfolio) -> str:
    duration = ""
    if pos.exit_time and pos.entry_time:
        dur_s = (pos.exit_time - pos.entry_time).total_seconds()
        duration = f"{dur_s / 60:.1f}m"
    emoji = "🟢" if pos.net_pnl_usd > 0 else "🔴"
    return (
        f"{emoji} *LIVE TRADE #{pos.id} CLOSED* ({pos.exit_reason})\n\n"
        f"*{pos.symbol}* | Duration: {duration}\n"
        f"P&L: *${pos.net_pnl_usd:+.4f}* (gross ${pos.gross_pnl_usd:+.4f})\n"
        f"Fees: ${pos.entry_fees_usd + pos.exit_fees_usd:.4f}\n"
        f"Exit spread: {pos.exit_spread_pct:.3f}%\n"
        f"Equity: ${portfolio.equity:,.2f} | "
        f"Drawdown: {portfolio.max_drawdown_pct:.2f}%"
    )
```

- [ ] **Step 4: Commit**

```bash
git add deploy-live/real_trader.py
git commit -m "feat: add Telegram alerts, commands (/status /stop /start /dryrun /balance)"
```

---

## Task 9: Main Loop

**Files:**
- Modify: `deploy-live/real_trader.py`

- [ ] **Step 1: Add main loop**

This is the core async loop. Structure mirrors paper_trader.py `main()` (line 5566+) but replaces simulated fills with real execution.

```python
async def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
        handlers=[
            logging.StreamHandler(),
            logging.handlers.RotatingFileHandler(
                os.path.join(DATA_DIR, "real_trader.log"),
                maxBytes=50_000_000, backupCount=3
            ),
        ]
    )

    log.info("=" * 60)
    log.info("REAL TRADER EU — Starting")
    log.info(f"DRY_RUN: {DRY_RUN}")
    log.info(f"Exchanges: {EXCHANGES}")
    log.info(f"Starting capital: ${STARTING_CAPITAL}")
    log.info(f"Max position: ${MAX_POSITION_USD}")
    log.info(f"Max concurrent: {MAX_CONCURRENT}")
    log.info(f"Kill switch: {KILL_SWITCH_DRAWDOWN_PCT}% drawdown")
    log.info("=" * 60)

    async with aiohttp.ClientSession() as session:
        # Create exchange executors
        executors = create_executors(session)
        if not executors:
            log.critical("No exchange executors configured — check API keys")
            await send_telegram(session, "🚨 *STARTUP FAILED* — no API keys configured")
            return

        log.info(f"Executors ready: {list(executors.keys())}")

        # Test auth on all exchanges
        for name, ex in executors.items():
            bal = await ex.get_balance()
            if bal["available"] > 0 or bal["locked"] > 0:
                log.info(f"  ✓ {name}: ${bal['available']:.2f} available, ${bal['locked']:.2f} locked")
            else:
                log.warning(f"  ⚠ {name}: balance query returned $0 — check API keys/permissions")

        # Create trader
        trader = LiveTrader(executors)
        cmd_listener = TelegramCommandListener(trader)

        # Discover symbols
        log.info("Discovering symbols...")
        # Call symbol discovery (copied from paper trader)
        # This populates SYMBOLS list
        await discover_symbols(session)
        trader.symbols_set = set(SYMBOLS)
        log.info(f"Discovered {len(SYMBOLS)} symbols across {len(executors)} exchanges")

        # Reconcile positions on startup
        mismatches = await trader.risk_mgr.reconcile_positions(session)
        if mismatches:
            log.warning(f"Startup reconciliation found mismatches: {mismatches}")
            await send_telegram(session, f"⚠️ *STARTUP RECONCILIATION*\n{chr(10).join(mismatches)}")

        # Refresh balances
        await trader.risk_mgr.refresh_balances()

        # Start websocket feeds
        # (Initialize WS managers for price feeds — same as paper trader)

        # Startup notification
        mode = "DRY RUN 🟡" if DRY_RUN else "LIVE 🔴"
        await send_telegram(session, (
            f"🟢 *Real Trader Online* ({mode})\n\n"
            f"Exchanges: {', '.join(executors.keys())}\n"
            f"Equity: ${trader.portfolio.equity:,.2f}\n"
            f"Open positions: {len(trader.portfolio.open_positions)}\n"
            f"Symbols: {len(SYMBOLS)}"
        ))

        # Signal handlers
        def shutdown(sig, frame):
            log.info(f"Received signal {sig}, shutting down...")
            trader.running = False
        signal.signal(signal.SIGINT, shutdown)
        signal.signal(signal.SIGTERM, shutdown)

        # ═══════════════════════════════════════════════════════
        # MAIN LOOP
        # ═══════════════════════════════════════════════════════
        cycle = 0
        last_status = time.time()
        last_state_save = time.time()
        last_heartbeat = time.time()
        last_cmd_poll = time.time()

        while trader.running:
            cycle += 1
            cycle_start = time.time()

            try:
                # ── Heartbeat ──
                if time.time() - last_heartbeat >= HEARTBEAT_INTERVAL_SEC:
                    with open(os.path.join(DATA_DIR, "heartbeat"), "w") as f:
                        f.write(str(time.time()))
                    last_heartbeat = time.time()

                # ── Poll Telegram commands ──
                if time.time() - last_cmd_poll >= 5:
                    await cmd_listener.poll_commands(session)
                    last_cmd_poll = time.time()

                # ── Refresh balances ──
                await trader.risk_mgr.refresh_balances()

                # ── Retry degraded positions ──
                await trader.trade_executor.retry_degraded_positions()

                # ── Fetch prices from all exchanges ──
                # (Same batch fetch pattern as paper_trader.py main loop)
                all_prices = {}
                results = await asyncio.gather(
                    *[f(session, trader.symbols_set) for f in BATCH_FETCHERS],
                    return_exceptions=True
                )
                for r in results:
                    if isinstance(r, Exception):
                        continue
                    for q in r:
                        all_prices.setdefault(q.symbol, []).append(q)
                trader.price_cache = all_prices

                # ── Check exits on open positions ──
                now = datetime.now(timezone.utc)
                for pos in list(trader.portfolio.open_positions):
                    if pos.status in ("CLOSING", "DEGRADED"):
                        continue
                    quotes = all_prices.get(pos.symbol, [])
                    q_short = next((q for q in quotes if q.exchange == pos.exchange_short), None)
                    q_long = next((q for q in quotes if q.exchange == pos.exchange_long), None)
                    if not q_short or not q_long:
                        continue

                    current_spread = (q_short.mid / q_long.mid - 1) * 100 if q_long.mid > 0 else 0
                    pos.current_spread_pct = current_spread
                    if current_spread > pos.peak_spread_pct:
                        pos.peak_spread_pct = current_spread

                    # Update unrealized P&L
                    if pos.entry_price_short > 0 and pos.entry_price_long > 0:
                        short_pnl = (pos.entry_price_short - q_short.mid) / pos.entry_price_short
                        long_pnl = (q_long.mid - pos.entry_price_long) / pos.entry_price_long
                        pos.net_pnl_usd = (short_pnl + long_pnl) * pos.size_usd - pos.entry_fees_usd

                    # Exit conditions
                    reason = ""
                    duration_min = (now - pos.entry_time).total_seconds() / 60

                    if current_spread <= EXIT_SPREAD_PCT:
                        reason = "convergence"
                    elif duration_min >= MAX_HOLD_MINUTES:
                        reason = "timeout"
                    elif DYNAMIC_EXIT_ENABLED:
                        pair_key = trader._pair_key(
                            pos.symbol, pos.exchange_short, pos.instrument_short,
                            pos.exchange_long, pos.instrument_long)
                        dynamic_exit = trader.get_dynamic_exit_threshold(pair_key)
                        if dynamic_exit > 0 and current_spread <= dynamic_exit:
                            reason = "dynamic_exit"

                    if reason:
                        closed = await trader.trade_executor.close_position(pos, current_spread, reason)
                        if closed:
                            msg = format_live_close_msg(pos, trader.portfolio)
                            await send_telegram(session, msg)

                # ── Check for kill switch ──
                can_trade, block_reason = trader.risk_mgr.can_trade()
                if not can_trade and "drawdown" in block_reason and not trader.risk_mgr.kill_switch_active:
                    await trader.risk_mgr.trigger_kill_switch(block_reason)
                    # Close all positions
                    for pos in list(trader.portfolio.open_positions):
                        await trader.trade_executor.close_position(pos, 0.0, "kill_switch")
                    await send_telegram(session, (
                        f"🔴 *KILL SWITCH ACTIVATED*\n\n"
                        f"Reason: {block_reason}\n"
                        f"Equity: ${trader.portfolio.equity:,.2f}\n"
                        f"Cooldown: {COOLDOWN_AFTER_KILL_SEC // 60} minutes"
                    ))

                # ── Scan for entry candidates ──
                if can_trade:
                    entry_candidates = []
                    for symbol, quotes in all_prices.items():
                        if symbol in BLOCKED_SYMBOLS or symbol in DELISTED_SYMBOLS:
                            continue
                        if trader.check_symbol_blacklist(symbol):
                            continue

                        # Compare all exchange pairs
                        for i in range(len(quotes)):
                            for j in range(i + 1, len(quotes)):
                                q_a, q_b = quotes[i], quotes[j]
                                if q_a.exchange in DISABLED_EXCHANGES or q_b.exchange in DISABLED_EXCHANGES:
                                    continue
                                if q_a.exchange not in executors or q_b.exchange not in executors:
                                    continue

                                # Determine high/low
                                if q_a.mid > q_b.mid:
                                    q_high, q_low = q_a, q_b
                                else:
                                    q_high, q_low = q_b, q_a

                                if q_low.mid <= 0:
                                    continue
                                spread = (q_high.mid / q_low.mid - 1) * 100

                                if spread < ENTRY_SPREAD_PCT or spread > MAX_SANE_SPREAD_PCT:
                                    continue

                                # Volume check
                                min_vol = min(q_high.volume_24h_usd, q_low.volume_24h_usd)
                                if min_vol < MIN_VOLUME_USD:
                                    continue

                                # Fee check — spread must cover roundtrip fees
                                pair_key = trader._pair_key(symbol, q_high.exchange, q_high.instrument,
                                                           q_low.exchange, q_low.instrument)
                                fees = trader.compute_fees(q_high.exchange, q_low.exchange,
                                                          q_high.instrument, q_low.instrument)
                                net_spread = spread - fees * 2
                                if net_spread < 0.10:
                                    continue

                                # Risk check for this specific pair
                                can_open, open_reason = trader.risk_mgr.can_open_position(
                                    q_high.exchange, q_low.exchange, MAX_POSITION_USD)
                                if not can_open:
                                    continue

                                # Breakout guard
                                if trader.is_breakout(symbol):
                                    continue

                                entry_candidates.append({
                                    "symbol": symbol,
                                    "q_high": q_high,
                                    "q_low": q_low,
                                    "spread_pct": spread,
                                    "net_spread": net_spread,
                                    "pair_key": pair_key,
                                    "min_vol": min_vol,
                                })

                    # Sort by net spread descending — best opportunities first
                    entry_candidates.sort(key=lambda c: c["net_spread"], reverse=True)

                    # Execute top candidates (up to available position slots)
                    for cand in entry_candidates:
                        if len(trader.portfolio.open_positions) >= MAX_CONCURRENT:
                            break

                        # OB depth check
                        ob_result = await asyncio.gather(
                            trader.fetch_orderbook_levels(session, cand["q_high"].exchange,
                                                         cand["symbol"], cand["q_high"].instrument),
                            trader.fetch_orderbook_levels(session, cand["q_low"].exchange,
                                                         cand["symbol"], cand["q_low"].instrument),
                        )
                        short_bids = sum(usd for _, usd in (ob_result[0][0] if ob_result[0] else []))
                        long_asks = sum(usd for _, usd in (ob_result[1][1] if ob_result[1] else []))
                        ob_size = min(short_bids, long_asks)
                        if ob_size < MAX_POSITION_USD:
                            continue

                        size = min(MAX_POSITION_USD, ob_size * 0.20)
                        if size < 5:
                            continue

                        pos = await trader.trade_executor.open_position(
                            cand["symbol"], cand["q_high"], cand["q_low"],
                            cand["spread_pct"], size, session
                        )
                        if pos:
                            msg = format_live_open_msg(pos, trader.portfolio)
                            await send_telegram(session, msg)

                # ── Reconciliation ──
                mismatches = await trader.risk_mgr.reconcile_positions(session)
                if mismatches:
                    await send_telegram(session, f"⚠️ *RECONCILIATION MISMATCH*\n{chr(10).join(mismatches)}")

                # ── Save state ──
                if time.time() - last_state_save >= 30:
                    trader._save_state()
                    last_state_save = time.time()

                # ── Status log ──
                if time.time() - last_status >= 300:
                    equity = trader.portfolio.equity
                    log.info(f"Status: equity=${equity:,.2f} open={len(trader.portfolio.open_positions)} "
                             f"closed={len(trader.portfolio.closed_positions)} "
                             f"pnl=${trader.portfolio.total_pnl_usd:+.2f} "
                             f"wr={trader.portfolio.total_wins}/{trader.portfolio.total_trades} "
                             f"kill={'ON' if trader.risk_mgr.kill_switch_active else 'off'} "
                             f"dry_run={DRY_RUN}")
                    last_status = time.time()

                    # Telegram status every 30 min
                    if cycle % (600 // POLL_INTERVAL) == 0:
                        await cmd_listener._handle_command("/status", session)

                # ── Equity history ──
                trader.equity_history.append({
                    "t": datetime.now(timezone.utc).isoformat(),
                    "v": trader.portfolio.equity,
                })
                if len(trader.equity_history) > 10000:
                    trader.equity_history = trader.equity_history[-5000:]

            except Exception as e:
                log.exception(f"Main loop error: {e}")
                await asyncio.sleep(5)
                continue

            # Adaptive sleep
            elapsed = time.time() - cycle_start
            has_open = len(trader.portfolio.open_positions) > 0
            sleep_time = POLL_INTERVAL_FAST if has_open else POLL_INTERVAL
            sleep_time = max(0, sleep_time - elapsed)
            await asyncio.sleep(sleep_time)

        # ── Graceful shutdown ──
        log.info("Shutting down — closing all positions...")
        for pos in list(trader.portfolio.open_positions):
            if pos.status != "CLOSED":
                await trader.trade_executor.close_position(pos, 0.0, "shutdown")
        trader._save_state()
        await send_telegram(session, "🔴 *Real Trader shutting down*")
        log.info("Shutdown complete")


if __name__ == "__main__":
    asyncio.run(main())
```

- [ ] **Step 2: Commit**

```bash
git add deploy-live/real_trader.py
git commit -m "feat: add main loop with entry/exit scanning, risk checks, graceful shutdown"
```

---

## Task 10: Dashboard

**Files:**
- Create: `deploy-live/dashboard.py`

- [ ] **Step 1: Create dashboard.py**

Port the paper trader dashboard (deploy/dashboard.py, 2987 lines) with these modifications:

- Read state from `data/real_state.json` instead of `portfolio_state.json`
- Add "Exchange Balances" panel showing per-exchange available/locked USDT + health status
- Add "Order Audit Log" panel showing last 100 orders with exchange ID, fill details, latency
- Add "Reconciliation Status" showing last check time and match/mismatch
- Add kill switch controls: Stop/Start buttons, DRY_RUN toggle, drawdown bar
- Change all "Paper" labels to "Live"
- Add HTTP basic auth using `DASHBOARD_PASSWORD` env var
- Change title to "Paperclip Trader — LIVE (EU)"
- Serve on port 8080

The dashboard structure follows the same pattern as the paper trader dashboard:
- Single Flask app
- Single HTML page with embedded CSS + JS
- lightweight-charts for equity curve
- Auto-refresh via `setInterval` polling `/api/state`
- `/api/state` endpoint reads `real_state.json` from disk

Key endpoint:
```python
@app.route("/api/state")
def api_state():
    state = json.load(open(os.path.join(DATA_DIR, "real_state.json")))
    return jsonify(state)
```

Add basic auth:
```python
from functools import wraps
from flask import request, Response

DASHBOARD_PASSWORD = os.environ.get("DASHBOARD_PASSWORD", "changeme")

def check_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        auth = request.authorization
        if not auth or auth.password != DASHBOARD_PASSWORD:
            return Response("Unauthorized", 401,
                           {"WWW-Authenticate": 'Basic realm="Login Required"'})
        return f(*args, **kwargs)
    return decorated
```

- [ ] **Step 2: Commit**

```bash
git add deploy-live/dashboard.py
git commit -m "feat: add live trading dashboard with auth, balances, audit log, controls"
```

---

## Task 11: Deployment Files

**Files:**
- Create: `deploy-live/start.sh`
- Create: `deploy-live/heartbeat.sh`
- Create: `deploy-live/Dockerfile`

- [ ] **Step 1: Create start.sh**

```bash
#!/bin/bash
# Start real_trader + dashboard in parallel
set -e

echo "Starting Real Trading Bot + Dashboard..."

mkdir -p /app/data

# Start dashboard
python -u dashboard.py &
DASH_PID=$!

# Start trader
python -u real_trader.py &
TRADER_PID=$!

# Wait for either to exit
wait -n $DASH_PID $TRADER_PID

echo "Process exited, shutting down..."
kill $DASH_PID $TRADER_PID 2>/dev/null
wait
exit 1
```

- [ ] **Step 2: Create heartbeat.sh**

```bash
#!/bin/bash
# Heartbeat watchdog — run via crontab every 2 minutes
# */2 * * * * /app/heartbeat.sh

HEARTBEAT_FILE="/app/data/heartbeat"
BOT_TOKEN="${TELEGRAM_BOT_TOKEN}"
CHAT_ID="${TELEGRAM_CHAT_ID}"
MAX_AGE=180  # 3 minutes

if [ ! -f "$HEARTBEAT_FILE" ]; then
    curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
        -d "chat_id=${CHAT_ID}" \
        -d "text=🚨 REAL TRADER HEARTBEAT MISSING — bot may be crashed" \
        -d "parse_mode=Markdown" > /dev/null
    exit 1
fi

LAST=$(cat "$HEARTBEAT_FILE")
NOW=$(date +%s)
AGE=$(echo "$NOW - $LAST" | bc)

if [ "$AGE" -gt "$MAX_AGE" ]; then
    curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
        -d "chat_id=${CHAT_ID}" \
        -d "text=🚨 REAL TRADER HEARTBEAT STALE (${AGE}s) — bot may be stuck" \
        -d "parse_mode=Markdown" > /dev/null
fi
```

- [ ] **Step 3: Create Dockerfile**

```dockerfile
FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY real_trader.py dashboard.py start.sh heartbeat.sh ./
RUN chmod +x start.sh heartbeat.sh

# Install bc for heartbeat script
RUN apt-get update && apt-get install -y --no-install-recommends bc cron curl && rm -rf /var/lib/apt/lists/*

# Set up heartbeat cron
RUN echo "*/2 * * * * /app/heartbeat.sh >> /var/log/heartbeat.log 2>&1" | crontab -

EXPOSE 8080

CMD ["./start.sh"]
```

- [ ] **Step 4: Make scripts executable and commit**

```bash
chmod +x deploy-live/start.sh deploy-live/heartbeat.sh
git add deploy-live/
git commit -m "feat: add deployment files — start.sh, heartbeat.sh, Dockerfile"
```

---

## Task 12: Integration Test — DRY_RUN End-to-End

**Files:**
- Modify: `deploy-live/real_trader.py` (if needed)

- [ ] **Step 1: Run the bot locally in DRY_RUN mode**

```bash
cd deploy-live
export DRY_RUN=true
export TELEGRAM_BOT_TOKEN=""
export TELEGRAM_CHAT_ID=""
# No exchange keys needed for DRY_RUN — executors will log but not be created
python real_trader.py
```

Expected: Bot starts, discovers symbols, enters main loop, logs spread detection and DRY_RUN order messages. No real orders placed. Verify:
- Symbols are discovered from public APIs
- Price feeds work (quotes logged)
- Spread detection finds candidates
- DRY_RUN entries are logged
- State file is created in `data/`
- Heartbeat file is written
- Graceful shutdown on Ctrl+C

- [ ] **Step 2: Fix any startup errors**

Address any import errors, missing functions, or logic bugs discovered during the dry run.

- [ ] **Step 3: Commit fixes**

```bash
git add deploy-live/
git commit -m "fix: address issues found during DRY_RUN integration test"
```

---

## Task 13: Auth Integration Test with Real API Keys

**Files:**
- No code changes — testing only

- [ ] **Step 1: Set up API keys on one exchange (start with Bybit)**

```bash
export BYBIT_API_KEY="your_key"
export BYBIT_API_SECRET="your_secret"
export DRY_RUN=true
```

- [ ] **Step 2: Run and verify auth works**

```bash
python real_trader.py
```

Verify in logs:
- `✓ Bybit: $XX.XX available` appears (balance query succeeded)
- No auth errors
- DRY_RUN orders still log correctly

- [ ] **Step 3: Repeat for OKX, MEXC, BloFin**

Set keys for each exchange one at a time, verify balance query succeeds.

- [ ] **Step 4: Test with DRY_RUN=false on testnet (if available)**

Bybit and OKX have testnets. If possible, place a real $1 test order on testnet to verify order flow end-to-end before going live.

---

## Task 14: AWS Lightsail Deployment

- [ ] **Step 1: Create Lightsail instance**

```bash
# Via AWS console or CLI:
# Region: ap-southeast-1 (Singapore)
# Plan: $5/mo (1 vCPU, 1GB RAM)
# OS: Ubuntu 22.04
```

- [ ] **Step 2: Set up the instance**

```bash
ssh ubuntu@<lightsail-ip>

# Install Python
sudo apt update && sudo apt install -y python3-pip python3-venv

# Create app directory
sudo mkdir -p /app/data
sudo chown ubuntu:ubuntu /app /app/data

# Copy files
scp deploy-live/* ubuntu@<lightsail-ip>:/app/

# Install deps
cd /app
pip3 install -r requirements.txt

# Create .env with API keys
nano /app/.env
chmod 600 /app/.env
```

- [ ] **Step 3: Create systemd service**

```bash
sudo tee /etc/systemd/system/real-trader.service << 'EOF'
[Unit]
Description=Real Trading Bot (EU)
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/app
EnvironmentFile=/app/.env
ExecStart=/usr/bin/python3 -u /app/real_trader.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/real-dashboard.service << 'EOF'
[Unit]
Description=Real Trading Dashboard
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/app
EnvironmentFile=/app/.env
ExecStart=/usr/bin/python3 -u /app/dashboard.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable real-trader real-dashboard
sudo systemctl start real-trader real-dashboard
```

- [ ] **Step 4: Set up heartbeat cron**

```bash
# Add to crontab
(crontab -l 2>/dev/null; echo "*/2 * * * * /app/heartbeat.sh >> /var/log/heartbeat.log 2>&1") | crontab -
```

- [ ] **Step 5: Verify deployment**

```bash
sudo journalctl -u real-trader -f  # Watch bot logs
curl http://localhost:8080/         # Dashboard responds
```

- [ ] **Step 6: Open firewall for dashboard**

```bash
# In Lightsail console: Networking → add port 8080
# Access dashboard at http://<lightsail-ip>:8080
```

---

## Post-Implementation Checklist

- [ ] Bot runs in DRY_RUN mode for at least 24 hours with all 4 exchange keys
- [ ] All Telegram notifications arrive correctly
- [ ] Dashboard loads and shows real-time state
- [ ] Heartbeat watchdog fires test alert (temporarily break the bot)
- [ ] Balance reconciliation runs without mismatches
- [ ] /stop and /start Telegram commands work
- [ ] Graceful shutdown preserves state
- [ ] State loads correctly after restart
- [ ] Flip DRY_RUN=false and place first real $25 trade
