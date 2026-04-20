"""
real_trader.py — Live Convergence Arbitrage Bot
Deployed to: AWS Lightsail Singapore
Strategy: EU Main (convergence arbitrage across OKX, MEXC, Bybit, BloFin)
"""

# ---------------------------------------------------------------------------
# Imports
# ---------------------------------------------------------------------------
import asyncio
import aiohttp
import hashlib
import hmac
import json
import logging
import os
import signal
import time
import base64
import collections
import math
import statistics
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Any

# ---------------------------------------------------------------------------
# Logging setup
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger("real_trader")

# ---------------------------------------------------------------------------
# Telegram config
# ---------------------------------------------------------------------------
TELEGRAM_BOT_TOKEN: str = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID: str = os.environ.get("TELEGRAM_CHAT_ID", "")

# ---------------------------------------------------------------------------
# Mode
# ---------------------------------------------------------------------------
DRY_RUN: bool = os.environ.get("DRY_RUN", "true").lower() in ("1", "true", "yes")

# ---------------------------------------------------------------------------
# Exchange API keys
# ---------------------------------------------------------------------------
OKX_API_KEY: str = os.environ.get("OKX_API_KEY", "")
OKX_API_SECRET: str = os.environ.get("OKX_API_SECRET", "")
OKX_PASSPHRASE: str = os.environ.get("OKX_PASSPHRASE", "")

BYBIT_API_KEY: str = os.environ.get("BYBIT_API_KEY", "")
BYBIT_API_SECRET: str = os.environ.get("BYBIT_API_SECRET", "")

MEXC_API_KEY: str = os.environ.get("MEXC_API_KEY", "")
MEXC_API_SECRET: str = os.environ.get("MEXC_API_SECRET", "")

BLOFIN_API_KEY: str = os.environ.get("BLOFIN_API_KEY", "")
BLOFIN_API_SECRET: str = os.environ.get("BLOFIN_API_SECRET", "")
BLOFIN_PASSPHRASE: str = os.environ.get("BLOFIN_PASSPHRASE", "")

# ---------------------------------------------------------------------------
# EU Main strategy params
# ---------------------------------------------------------------------------
ENTRY_SPREAD_PCT: float = 0.90       # Minimum spread to enter a position
EXIT_SPREAD_PCT: float = 0.15        # Spread at which to exit
MAX_HOLD_MINUTES: int = 30           # Maximum time to hold a position
MOMENTUM_FILTER: bool = True         # Require momentum alignment on entry
MA_FILTER: bool = True               # Require MA alignment on entry
PAIR_PREFERENCE: bool = True         # Prefer pairs with historical convergence
MIN_VOLUME_USD: float = 50_000.0     # Minimum 24h volume in USD

# ---------------------------------------------------------------------------
# Position sizing
# ---------------------------------------------------------------------------
STARTING_CAPITAL: float = 200.0      # Total equity in USD
MAX_POSITION_USD: float = 25.0       # Max size per leg in USD
POSITION_SIZE_PCT: float = 0.125     # Fraction of capital per position
MAX_CONCURRENT: int = 3              # Max simultaneous open positions

# ---------------------------------------------------------------------------
# Risk management
# ---------------------------------------------------------------------------
KILL_SWITCH_DRAWDOWN_PCT: float = 10.0   # Drawdown % that triggers kill switch
COOLDOWN_AFTER_KILL_SEC: int = 3600      # Seconds to pause after kill switch
MAX_PER_EXCHANGE_PCT: float = 0.80       # Max allocation to a single exchange

# ---------------------------------------------------------------------------
# Execution params
# ---------------------------------------------------------------------------
ORDER_TIMEOUT_SEC: int = 5               # Seconds before cancelling unfilled order
BALANCE_REFRESH_SEC: int = 30            # How often to refresh balances
RECONCILE_INTERVAL_SEC: int = 300        # How often to reconcile positions
HEARTBEAT_INTERVAL_SEC: int = 60         # How often to send Telegram heartbeat

# ---------------------------------------------------------------------------
# Exchanges
# ---------------------------------------------------------------------------
EXCHANGES: List[str] = ["OKX", "MEXC", "Bybit", "BloFin"]

# ---------------------------------------------------------------------------
# Monitoring / polling params
# ---------------------------------------------------------------------------
POLL_INTERVAL: float = 3.0               # Default polling interval (seconds)
POLL_INTERVAL_FAST: float = 0.5          # Fast polling when position is open
POLL_INTERVAL_SLOW: float = 5.0          # Slow polling when market is quiet
MAX_SANE_SPREAD_PCT: float = 15.0        # Spreads above this are ignored (bad data)
STALE_PRICE_SECONDS: int = 30            # Price older than this is considered stale
MAX_OB_CALLS_PER_CYCLE: int = 60         # Rate-limit guard for order-book calls
OB_LEVELS_LIMIT: int = 20               # Order book depth to request
OB_EMPTY_CACHE_CYCLES: int = 10          # Cycles before evicting empty OB cache

# ---------------------------------------------------------------------------
# Breakout guard params
# ---------------------------------------------------------------------------
BREAKOUT_WINDOW: int = 20               # Candles to look back for breakout check
BREAKOUT_ATR_MULT: float = 2.0          # ATR multiplier to flag breakout
BREAKOUT_COOLDOWN_SEC: int = 300        # Seconds to avoid entry after breakout

# ---------------------------------------------------------------------------
# Dynamic exit params
# ---------------------------------------------------------------------------
DYNAMIC_EXIT_ENABLED: bool = True
DYNAMIC_EXIT_PROFIT_LOCK_PCT: float = 0.50  # Lock in 50% of peak profit on exit
DYNAMIC_EXIT_TRAIL_PCT: float = 0.10        # Trailing stop as fraction of spread

# ---------------------------------------------------------------------------
# Relative spread params
# ---------------------------------------------------------------------------
REL_SPREAD_WINDOW: int = 100            # Rolling window for relative spread calc
REL_SPREAD_ZSCORE_ENTRY: float = 1.5    # Z-score threshold for entry
REL_SPREAD_ZSCORE_EXIT: float = 0.0     # Z-score threshold for exit

# ---------------------------------------------------------------------------
# Entry pricing params (EWMA)
# ---------------------------------------------------------------------------
EWMA_SPAN: int = 20                     # EWMA span for mid-price smoothing
ENTRY_USE_EWMA: bool = True             # Use EWMA mid-price for entry decisions
ENTRY_LIMIT_OFFSET_PCT: float = 0.05    # Place limit orders this % inside the spread

# ---------------------------------------------------------------------------
# Aged position params
# ---------------------------------------------------------------------------
AGED_POSITION_WARN_MINUTES: int = 20    # Warn via Telegram after this many minutes
AGED_POSITION_FORCE_EXIT_MINUTES: int = 30  # Force-exit after this many minutes

# ---------------------------------------------------------------------------
# Fee model — taker fees (maker fees assumed 0 for now)
# ---------------------------------------------------------------------------
TAKER_FEE: Dict[str, float] = {
    "OKX": 0.00080,    # 0.08%
    "Bybit": 0.00100,  # 0.10%
    "MEXC": 0.00020,   # 0.02%
    "BloFin": 0.00060, # 0.06%
}

# ---------------------------------------------------------------------------
# Spot fee tiers (same 4 exchanges)
# ---------------------------------------------------------------------------
SPOT_FEE: Dict[str, float] = {
    "OKX": 0.00080,    # 0.08%
    "Bybit": 0.00100,  # 0.10%
    "MEXC": 0.00020,   # 0.02%
    "BloFin": 0.00060, # 0.06%
}

# ---------------------------------------------------------------------------
# Symbol config
# ---------------------------------------------------------------------------
SYMBOLS: List[str] = []              # Populated at startup via exchange API calls
MIN_EXCHANGES_PER_SYMBOL: int = 2    # Symbol must trade on at least this many exchanges

BLOCKED_SYMBOLS: set = set()         # Manually blocked symbols (e.g. illiquid, broken)

WHITELIST_SYMBOLS: set = set()       # If non-empty, only trade these symbols

# ---------------------------------------------------------------------------
# Delisted / broken symbols to skip entirely
# ---------------------------------------------------------------------------
DELISTED_SYMBOLS: set = {
    "A2ZUSDT", "FORTHUSDT", "HOOKUSDT", "IDEXUSDT",
    "LRCUSDT", "NTRMUSDT", "RDNTUSDT", "SXPUSDT",
    "BIDUSDT", "DMCUSDT", "ZRCUSDT", "TANSSIUSDT",
    "SKATEUSDT", "REIUSDT", "FISUSDT", "VOXELUSDT",
    "42USDT", "COMMONUSDT", "CUDISUSDT", "EPTUSDT",
    "FLMUSDT", "PERPUSDT", "AIAUSDT", "OMGUSDT", "SLERUSDT",
    "KDAUSDT",
    "ULTIUSDT", "GEARUSDT", "VRAUSDT", "DAOUSDT", "CXTUSDT", "ELONUSDT",
    "RSS3USDT", "MEMEFIUSDT", "GHSTUSDT", "RIOUSDT", "SWEATUSDT",
    "SAHARAUSDT", "HMSTRUSDT", "YBUSDT", "BICOUSDT",
    "AEVOUSDT", "WOOUSDT", "SOPHUSDT",
    "CTSIUSDT", "XCHUSDT", "TAIUSDT", "DODOUSDT", "SDUSDT",
    "ALUUSDT", "SKYAIUSDT", "AINUSDT", "DGBUSDT", "NSUSDT", "OBTUSDT",
    "SFUNDUSDT", "SOLOUSDT", "NRNUSDT", "LITKEYUSDT",
    "ELXUSDT", "ODOSUSDT", "DMAILUSDT",
    "XDCUSDT", "SNTUSDT", "BLASTUSDT", "ZBCNUSDT", "TSTBSCUSDT",
    "HIGHUSDT",
    "RACAUSDT", "TELUSDT", "OORTUSDT", "CYCUSDT", "MDTUSDT",
    "THINKUSDT", "ACAUSDT", "MINAUSDT",
    "FRAGUSDT", "WNZUSDT", "RCADEUSDT", "UNITEUSDT", "MAJORUSDT",
    "KILOUSDT", "WOLFUSDT", "AZITUSDT", "BITCOINUSDT", "ARCUSDT",
    "GRIFFAINUSDT", "PIPPINUSDT", "HOUSEUSDT", "VTUSDT",
    "UTKUSDT",
    "RVVUSDT", "YALAUSDT", "VFYUSDT",
    "STGUSDT", "LTOUSDT",
    "DUSDT", "DATAUSDT", "FLOWUSDT",
    "CLVUSDT", "FOXYUSDT", "PSTAKEUSDT", "ICEUSDT", "UXLINKUSDT",
    "UROUSDT", "SNSUSDT",
    "XUSDT", "L3USDT", "COQUSDT", "YZYUSDT", "AVAILUSDT", "MILKUSDT",
    "OMUSDT", "COREUSDT", "PTBUSDT", "PRCLSUSDT", "TURTLEUSDT",
    "NKNUSDT", "XIONUSDT", "HEMIUSDT", "PROMPTUSDT", "SWARMSUSDT",
    "SOLVUSDT", "ZEREBROUSDT", "CAMPUSDT", "AGIUSDT", "GTCUSDT",
    "NFPUSDT", "PEAQUSDT", "GNOUSDT", "TRUUSDT", "BSUUSDT",
    "ALEOUSDT", "FWOGUSDT", "XNOUSDT", "UUSDT", "WMTXUSDT",
    "PSYOPANIMEUSDT", "CLAWNCHUSDT", "WARDUSDT", "FORTUSDT", "CATSTOCKUSDT",
    "DRIFTUSDT",
}

# ---------------------------------------------------------------------------
# Data directory
# ---------------------------------------------------------------------------
DATA_DIR: Path = Path(os.environ.get("DATA_DIR", "/tmp/real_trader_data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------
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
    latency_ms: float = 0.0
    error: str = ""


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
    order_id_short: str = ""
    order_id_long: str = ""
    order_id_close_short: str = ""
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


# ---------------------------------------------------------------------------
# Exchange Executors — authenticated API calls with HMAC signing
# ---------------------------------------------------------------------------
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
        raise NotImplementedError

    async def get_open_positions(self) -> List[dict]:
        raise NotImplementedError


class OKXExecutor(ExchangeExecutor):
    """OKX exchange executor with HMAC-SHA256 + base64 signing."""

    BASE_URL = "https://www.okx.com"

    def __init__(self, api_key: str, api_secret: str, passphrase: str, session: aiohttp.ClientSession):
        super().__init__("OKX", api_key, api_secret, session)
        self.passphrase = passphrase

    def _sign(self, timestamp: str, method: str, path: str, body: str = "") -> str:
        message = timestamp + method + path + body
        mac = hmac.new(
            self.api_secret.encode("utf-8"),
            message.encode("utf-8"),
            hashlib.sha256,
        )
        return base64.b64encode(mac.digest()).decode("utf-8")

    def _headers(self, method: str, path: str, body: str = "") -> dict:
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + \
             f"{datetime.now(timezone.utc).microsecond // 1000:03d}Z"
        sign = self._sign(ts, method, path, body)
        return {
            "OK-ACCESS-KEY": self.api_key,
            "OK-ACCESS-SIGN": sign,
            "OK-ACCESS-TIMESTAMP": ts,
            "OK-ACCESS-PASSPHRASE": self.passphrase,
            "Content-Type": "application/json",
        }

    async def place_market_order(self, symbol: str, side: str, size_usd: float) -> OrderResult:
        t0 = time.time()
        # Build instrument id: e.g. BTCUSDT -> BTC-USDT-SWAP
        base = symbol.replace("USDT", "")
        inst_id = f"{base}-USDT-SWAP"

        if DRY_RUN:
            log.info(f"[DRY_RUN] OKX place_market_order {side} {inst_id} ${size_usd:.2f}")
            return OrderResult(
                success=True, order_id="dry-run-okx", exchange="OKX",
                symbol=symbol, side=side, size_usd=size_usd,
                filled_usd=size_usd, fill_price=0.0, fees_usd=0.0,
                timestamp=time.time(), latency_ms=(time.time() - t0) * 1000,
            )

        path = "/api/v5/trade/order"
        payload = {
            "instId": inst_id,
            "tdMode": "cross",
            "side": side.lower(),
            "ordType": "market",
            "sz": str(size_usd),
            "tgtCcy": "quote_ccy",
        }
        body = json.dumps(payload)
        headers = self._headers("POST", path, body)
        try:
            async with self.session.post(
                self.BASE_URL + path, headers=headers, data=body,
                timeout=aiohttp.ClientTimeout(total=ORDER_TIMEOUT_SEC),
            ) as resp:
                data = await resp.json()
            if data.get("code") != "0":
                err = data.get("msg", str(data))
                self._mark_error(err)
                return OrderResult(
                    success=False, order_id="", exchange="OKX",
                    symbol=symbol, side=side, size_usd=size_usd,
                    filled_usd=0.0, fill_price=0.0, fees_usd=0.0,
                    timestamp=time.time(), latency_ms=(time.time() - t0) * 1000,
                    error=err,
                )
            order_id = data["data"][0]["ordId"]
            fill = await self._wait_for_fill(order_id, inst_id)
            self._mark_success()
            return OrderResult(
                success=True, order_id=order_id, exchange="OKX",
                symbol=symbol, side=side, size_usd=size_usd,
                filled_usd=float(fill.get("fillSz", size_usd)),
                fill_price=float(fill.get("avgPx", 0)),
                fees_usd=abs(float(fill.get("fee", 0))),
                timestamp=time.time(), latency_ms=(time.time() - t0) * 1000,
            )
        except Exception as e:
            self._mark_error(str(e))
            return OrderResult(
                success=False, order_id="", exchange="OKX",
                symbol=symbol, side=side, size_usd=size_usd,
                filled_usd=0.0, fill_price=0.0, fees_usd=0.0,
                timestamp=time.time(), latency_ms=(time.time() - t0) * 1000,
                error=str(e),
            )

    async def _wait_for_fill(self, order_id: str, inst_id: str, timeout: float = 3.0) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            path = f"/api/v5/trade/order?ordId={order_id}&instId={inst_id}"
            headers = self._headers("GET", path)
            async with self.session.get(
                self.BASE_URL + path, headers=headers,
                timeout=aiohttp.ClientTimeout(total=ORDER_TIMEOUT_SEC),
            ) as resp:
                data = await resp.json()
            if data.get("code") == "0" and data.get("data"):
                order = data["data"][0]
                if order.get("state") == "filled":
                    return order
            await asyncio.sleep(0.3)
        return {}

    async def get_balance(self) -> Dict[str, float]:
        path = "/api/v5/account/balance?ccy=USDT"
        headers = self._headers("GET", path)
        try:
            async with self.session.get(
                self.BASE_URL + path, headers=headers,
                timeout=aiohttp.ClientTimeout(total=ORDER_TIMEOUT_SEC),
            ) as resp:
                data = await resp.json()
            if data.get("code") == "0" and data.get("data"):
                details = data["data"][0].get("details", [])
                for d in details:
                    if d.get("ccy") == "USDT":
                        self._mark_success()
                        return {
                            "availBal": float(d.get("availBal", 0)),
                            "frozenBal": float(d.get("frozenBal", 0)),
                        }
            self._mark_error("No USDT balance data")
            return {"availBal": 0.0, "frozenBal": 0.0}
        except Exception as e:
            self._mark_error(str(e))
            return {"availBal": 0.0, "frozenBal": 0.0}

    async def get_open_positions(self) -> List[dict]:
        path = "/api/v5/account/positions?instType=SWAP"
        headers = self._headers("GET", path)
        try:
            async with self.session.get(
                self.BASE_URL + path, headers=headers,
                timeout=aiohttp.ClientTimeout(total=ORDER_TIMEOUT_SEC),
            ) as resp:
                data = await resp.json()
            if data.get("code") == "0" and data.get("data"):
                self._mark_success()
                return data["data"]
            return []
        except Exception as e:
            self._mark_error(str(e))
            return []


class BybitExecutor(ExchangeExecutor):
    """Bybit exchange executor with HMAC-SHA256 signing."""

    BASE_URL = "https://api.bybit.com"
    RECV_WINDOW = "5000"

    def __init__(self, name: str, api_key: str, api_secret: str, session: aiohttp.ClientSession):
        super().__init__(name, api_key, api_secret, session)

    def _sign(self, timestamp: str, params: str) -> str:
        message = timestamp + self.api_key + self.RECV_WINDOW + params
        return hmac.new(
            self.api_secret.encode("utf-8"),
            message.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()

    def _headers(self, timestamp: str, params: str) -> dict:
        sign = self._sign(timestamp, params)
        return {
            "X-BAPI-API-KEY": self.api_key,
            "X-BAPI-SIGN": sign,
            "X-BAPI-TIMESTAMP": timestamp,
            "X-BAPI-RECV-WINDOW": self.RECV_WINDOW,
            "Content-Type": "application/json",
        }

    async def place_market_order(self, symbol: str, side: str, size_usd: float) -> OrderResult:
        t0 = time.time()

        if DRY_RUN:
            log.info(f"[DRY_RUN] Bybit place_market_order {side} {symbol} ${size_usd:.2f}")
            return OrderResult(
                success=True, order_id="dry-run-bybit", exchange="Bybit",
                symbol=symbol, side=side, size_usd=size_usd,
                filled_usd=size_usd, fill_price=0.0, fees_usd=0.0,
                timestamp=time.time(), latency_ms=(time.time() - t0) * 1000,
            )

        path = "/v5/order/create"
        payload = {
            "category": "linear",
            "symbol": symbol,
            "side": "Buy" if side.lower() == "buy" else "Sell",
            "orderType": "Market",
            "qty": str(size_usd),
            "marketUnit": "quoteCoin",
        }
        body = json.dumps(payload)
        ts = str(int(time.time() * 1000))
        headers = self._headers(ts, body)
        try:
            async with self.session.post(
                self.BASE_URL + path, headers=headers, data=body,
                timeout=aiohttp.ClientTimeout(total=ORDER_TIMEOUT_SEC),
            ) as resp:
                data = await resp.json()
            if data.get("retCode") != 0:
                err = data.get("retMsg", str(data))
                self._mark_error(err)
                return OrderResult(
                    success=False, order_id="", exchange="Bybit",
                    symbol=symbol, side=side, size_usd=size_usd,
                    filled_usd=0.0, fill_price=0.0, fees_usd=0.0,
                    timestamp=time.time(), latency_ms=(time.time() - t0) * 1000,
                    error=err,
                )
            order_id = data["result"]["orderId"]
            fill = await self._wait_for_fill(order_id, symbol)
            self._mark_success()
            return OrderResult(
                success=True, order_id=order_id, exchange="Bybit",
                symbol=symbol, side=side, size_usd=size_usd,
                filled_usd=float(fill.get("cumExecValue", size_usd)),
                fill_price=float(fill.get("avgPrice", 0)),
                fees_usd=abs(float(fill.get("cumExecFee", 0))),
                timestamp=time.time(), latency_ms=(time.time() - t0) * 1000,
            )
        except Exception as e:
            self._mark_error(str(e))
            return OrderResult(
                success=False, order_id="", exchange="Bybit",
                symbol=symbol, side=side, size_usd=size_usd,
                filled_usd=0.0, fill_price=0.0, fees_usd=0.0,
                timestamp=time.time(), latency_ms=(time.time() - t0) * 1000,
                error=str(e),
            )

    async def _wait_for_fill(self, order_id: str, symbol: str, timeout: float = 3.0) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            path = f"/v5/order/realtime?category=linear&orderId={order_id}&symbol={symbol}"
            ts = str(int(time.time() * 1000))
            headers = self._headers(ts, "")
            async with self.session.get(
                self.BASE_URL + path, headers=headers,
                timeout=aiohttp.ClientTimeout(total=ORDER_TIMEOUT_SEC),
            ) as resp:
                data = await resp.json()
            if data.get("retCode") == 0 and data.get("result", {}).get("list"):
                order = data["result"]["list"][0]
                if order.get("orderStatus") == "Filled":
                    return order
            await asyncio.sleep(0.3)
        return {}

    async def get_balance(self) -> Dict[str, float]:
        path = "/v5/account/wallet-balance?accountType=UNIFIED&coin=USDT"
        ts = str(int(time.time() * 1000))
        headers = self._headers(ts, "")
        try:
            async with self.session.get(
                self.BASE_URL + path, headers=headers,
                timeout=aiohttp.ClientTimeout(total=ORDER_TIMEOUT_SEC),
            ) as resp:
                data = await resp.json()
            if data.get("retCode") == 0 and data.get("result", {}).get("list"):
                coins = data["result"]["list"][0].get("coin", [])
                for c in coins:
                    if c.get("coin") == "USDT":
                        self._mark_success()
                        return {
                            "availBal": float(c.get("availableToWithdraw", 0)),
                            "frozenBal": float(c.get("locked", 0)),
                        }
            self._mark_error("No USDT balance data")
            return {"availBal": 0.0, "frozenBal": 0.0}
        except Exception as e:
            self._mark_error(str(e))
            return {"availBal": 0.0, "frozenBal": 0.0}

    async def get_open_positions(self) -> List[dict]:
        path = "/v5/position/list?category=linear&settleCoin=USDT"
        ts = str(int(time.time() * 1000))
        headers = self._headers(ts, "")
        try:
            async with self.session.get(
                self.BASE_URL + path, headers=headers,
                timeout=aiohttp.ClientTimeout(total=ORDER_TIMEOUT_SEC),
            ) as resp:
                data = await resp.json()
            if data.get("retCode") == 0 and data.get("result", {}).get("list"):
                self._mark_success()
                return data["result"]["list"]
            return []
        except Exception as e:
            self._mark_error(str(e))
            return []


class MEXCExecutor(ExchangeExecutor):
    """MEXC exchange executor with HMAC-SHA256 signing of query string."""

    BASE_URL = "https://contract.mexc.com"

    def __init__(self, name: str, api_key: str, api_secret: str, session: aiohttp.ClientSession):
        super().__init__(name, api_key, api_secret, session)

    def _sign(self, params: dict) -> str:
        sorted_params = "&".join(f"{k}={v}" for k, v in sorted(params.items()))
        return hmac.new(
            self.api_secret.encode("utf-8"),
            sorted_params.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()

    def _headers(self, params: dict) -> dict:
        ts = str(int(time.time() * 1000))
        params["timestamp"] = ts
        signature = self._sign(params)
        return {
            "ApiKey": self.api_key,
            "Signature": signature,
            "Request-Time": ts,
            "Content-Type": "application/json",
        }

    async def place_market_order(self, symbol: str, side: str, size_usd: float) -> OrderResult:
        t0 = time.time()
        # MEXC futures symbol format: BASE_USDT
        base = symbol.replace("USDT", "")
        mexc_symbol = f"{base}_USDT"

        if DRY_RUN:
            log.info(f"[DRY_RUN] MEXC place_market_order {side} {mexc_symbol} ${size_usd:.2f}")
            return OrderResult(
                success=True, order_id="dry-run-mexc", exchange="MEXC",
                symbol=symbol, side=side, size_usd=size_usd,
                filled_usd=size_usd, fill_price=0.0, fees_usd=0.0,
                timestamp=time.time(), latency_ms=(time.time() - t0) * 1000,
            )

        path = "/api/v1/private/order/submit"
        # side: 1=open long, 2=close long, 3=open short, 4=close short
        mexc_side = 1 if side.lower() == "buy" else 3
        params = {
            "symbol": mexc_symbol,
            "side": str(mexc_side),
            "type": "5",  # market order
            "vol": str(size_usd),
            "openType": "2",  # cross margin
        }
        headers = self._headers(params.copy())
        body = json.dumps(params)
        try:
            async with self.session.post(
                self.BASE_URL + path, headers=headers, data=body,
                timeout=aiohttp.ClientTimeout(total=ORDER_TIMEOUT_SEC),
            ) as resp:
                data = await resp.json()
            if not data.get("success"):
                err = data.get("message", str(data))
                self._mark_error(err)
                return OrderResult(
                    success=False, order_id="", exchange="MEXC",
                    symbol=symbol, side=side, size_usd=size_usd,
                    filled_usd=0.0, fill_price=0.0, fees_usd=0.0,
                    timestamp=time.time(), latency_ms=(time.time() - t0) * 1000,
                    error=err,
                )
            order_id = str(data.get("data", ""))
            fill = await self._wait_for_fill(order_id, mexc_symbol)
            self._mark_success()
            return OrderResult(
                success=True, order_id=order_id, exchange="MEXC",
                symbol=symbol, side=side, size_usd=size_usd,
                filled_usd=float(fill.get("dealVol", size_usd)),
                fill_price=float(fill.get("dealAvgPrice", 0)),
                fees_usd=abs(float(fill.get("takerFee", 0))),
                timestamp=time.time(), latency_ms=(time.time() - t0) * 1000,
            )
        except Exception as e:
            self._mark_error(str(e))
            return OrderResult(
                success=False, order_id="", exchange="MEXC",
                symbol=symbol, side=side, size_usd=size_usd,
                filled_usd=0.0, fill_price=0.0, fees_usd=0.0,
                timestamp=time.time(), latency_ms=(time.time() - t0) * 1000,
                error=str(e),
            )

    async def _wait_for_fill(self, order_id: str, mexc_symbol: str, timeout: float = 3.0) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            path = f"/api/v1/private/order/get/{order_id}"
            params: dict = {}
            headers = self._headers(params)
            async with self.session.get(
                self.BASE_URL + path, headers=headers,
                timeout=aiohttp.ClientTimeout(total=ORDER_TIMEOUT_SEC),
            ) as resp:
                data = await resp.json()
            if data.get("success") and data.get("data"):
                order = data["data"]
                if order.get("state") == 3:  # filled
                    return order
            await asyncio.sleep(0.3)
        return {}

    async def get_balance(self) -> Dict[str, float]:
        path = "/api/v1/private/account/assets?currency=USDT"
        params: dict = {}
        headers = self._headers(params)
        try:
            async with self.session.get(
                self.BASE_URL + path, headers=headers,
                timeout=aiohttp.ClientTimeout(total=ORDER_TIMEOUT_SEC),
            ) as resp:
                data = await resp.json()
            if data.get("success") and data.get("data"):
                assets = data["data"]
                if isinstance(assets, list) and assets:
                    a = assets[0]
                    self._mark_success()
                    return {
                        "availBal": float(a.get("availableBalance", 0)),
                        "frozenBal": float(a.get("frozenBalance", 0)),
                    }
                elif isinstance(assets, dict):
                    self._mark_success()
                    return {
                        "availBal": float(assets.get("availableBalance", 0)),
                        "frozenBal": float(assets.get("frozenBalance", 0)),
                    }
            self._mark_error("No USDT balance data")
            return {"availBal": 0.0, "frozenBal": 0.0}
        except Exception as e:
            self._mark_error(str(e))
            return {"availBal": 0.0, "frozenBal": 0.0}

    async def get_open_positions(self) -> List[dict]:
        path = "/api/v1/private/position/open_positions"
        params: dict = {}
        headers = self._headers(params)
        try:
            async with self.session.get(
                self.BASE_URL + path, headers=headers,
                timeout=aiohttp.ClientTimeout(total=ORDER_TIMEOUT_SEC),
            ) as resp:
                data = await resp.json()
            if data.get("success") and data.get("data"):
                self._mark_success()
                return data["data"]
            return []
        except Exception as e:
            self._mark_error(str(e))
            return []


class BloFinExecutor(ExchangeExecutor):
    """BloFin exchange executor with HMAC-SHA256 + base64 signing (OKX-style)."""

    BASE_URL = "https://openapi.blofin.com"

    def __init__(self, api_key: str, api_secret: str, passphrase: str, session: aiohttp.ClientSession):
        super().__init__("BloFin", api_key, api_secret, session)
        self.passphrase = passphrase

    def _sign(self, timestamp: str, method: str, path: str, body: str = "") -> str:
        message = timestamp + method + path + body
        mac = hmac.new(
            self.api_secret.encode("utf-8"),
            message.encode("utf-8"),
            hashlib.sha256,
        )
        return base64.b64encode(mac.digest()).decode("utf-8")

    def _headers(self, method: str, path: str, body: str = "") -> dict:
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + \
             f"{datetime.now(timezone.utc).microsecond // 1000:03d}Z"
        sign = self._sign(ts, method, path, body)
        return {
            "ACCESS-KEY": self.api_key,
            "ACCESS-SIGN": sign,
            "ACCESS-TIMESTAMP": ts,
            "ACCESS-PASSPHRASE": self.passphrase,
            "Content-Type": "application/json",
        }

    async def place_market_order(self, symbol: str, side: str, size_usd: float) -> OrderResult:
        t0 = time.time()
        # BloFin instrument format: BASE-USDT
        base = symbol.replace("USDT", "")
        inst_id = f"{base}-USDT"

        if DRY_RUN:
            log.info(f"[DRY_RUN] BloFin place_market_order {side} {inst_id} ${size_usd:.2f}")
            return OrderResult(
                success=True, order_id="dry-run-blofin", exchange="BloFin",
                symbol=symbol, side=side, size_usd=size_usd,
                filled_usd=size_usd, fill_price=0.0, fees_usd=0.0,
                timestamp=time.time(), latency_ms=(time.time() - t0) * 1000,
            )

        path = "/api/v1/trade/order"
        payload = {
            "instId": inst_id,
            "marginMode": "cross",
            "side": side.lower(),
            "orderType": "market",
            "size": str(size_usd),
            "sizeType": "quoteCoin",
        }
        body = json.dumps(payload)
        headers = self._headers("POST", path, body)
        try:
            async with self.session.post(
                self.BASE_URL + path, headers=headers, data=body,
                timeout=aiohttp.ClientTimeout(total=ORDER_TIMEOUT_SEC),
            ) as resp:
                data = await resp.json()
            if data.get("code") != "0":
                err = data.get("msg", str(data))
                self._mark_error(err)
                return OrderResult(
                    success=False, order_id="", exchange="BloFin",
                    symbol=symbol, side=side, size_usd=size_usd,
                    filled_usd=0.0, fill_price=0.0, fees_usd=0.0,
                    timestamp=time.time(), latency_ms=(time.time() - t0) * 1000,
                    error=err,
                )
            order_id = data["data"]["orderId"]
            fill = await self._wait_for_fill(order_id, inst_id)
            self._mark_success()
            return OrderResult(
                success=True, order_id=order_id, exchange="BloFin",
                symbol=symbol, side=side, size_usd=size_usd,
                filled_usd=float(fill.get("fillSz", size_usd)),
                fill_price=float(fill.get("avgPx", 0)),
                fees_usd=abs(float(fill.get("fee", 0))),
                timestamp=time.time(), latency_ms=(time.time() - t0) * 1000,
            )
        except Exception as e:
            self._mark_error(str(e))
            return OrderResult(
                success=False, order_id="", exchange="BloFin",
                symbol=symbol, side=side, size_usd=size_usd,
                filled_usd=0.0, fill_price=0.0, fees_usd=0.0,
                timestamp=time.time(), latency_ms=(time.time() - t0) * 1000,
                error=str(e),
            )

    async def _wait_for_fill(self, order_id: str, inst_id: str, timeout: float = 3.0) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            path = f"/api/v1/trade/order?orderId={order_id}&instId={inst_id}"
            headers = self._headers("GET", path)
            async with self.session.get(
                self.BASE_URL + path, headers=headers,
                timeout=aiohttp.ClientTimeout(total=ORDER_TIMEOUT_SEC),
            ) as resp:
                data = await resp.json()
            if data.get("code") == "0" and data.get("data"):
                order = data["data"]
                if isinstance(order, list):
                    order = order[0]
                if order.get("state") == "filled":
                    return order
            await asyncio.sleep(0.3)
        return {}

    async def get_balance(self) -> Dict[str, float]:
        path = "/api/v1/account/balance"
        headers = self._headers("GET", path)
        try:
            async with self.session.get(
                self.BASE_URL + path, headers=headers,
                timeout=aiohttp.ClientTimeout(total=ORDER_TIMEOUT_SEC),
            ) as resp:
                data = await resp.json()
            if data.get("code") == "0" and data.get("data"):
                bal_data = data["data"]
                if isinstance(bal_data, list):
                    for d in bal_data:
                        if d.get("ccy") == "USDT":
                            self._mark_success()
                            return {
                                "availBal": float(d.get("availBal", 0)),
                                "frozenBal": float(d.get("frozenBal", 0)),
                            }
                elif isinstance(bal_data, dict):
                    self._mark_success()
                    return {
                        "availBal": float(bal_data.get("availBal", 0)),
                        "frozenBal": float(bal_data.get("frozenBal", 0)),
                    }
            self._mark_error("No balance data")
            return {"availBal": 0.0, "frozenBal": 0.0}
        except Exception as e:
            self._mark_error(str(e))
            return {"availBal": 0.0, "frozenBal": 0.0}

    async def get_open_positions(self) -> List[dict]:
        path = "/api/v1/account/positions"
        headers = self._headers("GET", path)
        try:
            async with self.session.get(
                self.BASE_URL + path, headers=headers,
                timeout=aiohttp.ClientTimeout(total=ORDER_TIMEOUT_SEC),
            ) as resp:
                data = await resp.json()
            if data.get("code") == "0" and data.get("data"):
                self._mark_success()
                return data["data"]
            return []
        except Exception as e:
            self._mark_error(str(e))
            return []


def create_executors(session: aiohttp.ClientSession) -> Dict[str, ExchangeExecutor]:
    """Factory: create exchange executors for all configured exchanges."""
    executors: Dict[str, ExchangeExecutor] = {}
    if OKX_API_KEY and OKX_API_SECRET:
        executors["OKX"] = OKXExecutor(OKX_API_KEY, OKX_API_SECRET, OKX_PASSPHRASE, session)
    if BYBIT_API_KEY and BYBIT_API_SECRET:
        executors["Bybit"] = BybitExecutor("Bybit", BYBIT_API_KEY, BYBIT_API_SECRET, session)
    if MEXC_API_KEY and MEXC_API_SECRET:
        executors["MEXC"] = MEXCExecutor("MEXC", MEXC_API_KEY, MEXC_API_SECRET, session)
    if BLOFIN_API_KEY and BLOFIN_API_SECRET:
        executors["BloFin"] = BloFinExecutor(BLOFIN_API_KEY, BLOFIN_API_SECRET, BLOFIN_PASSPHRASE, session)
    return executors


# ---------------------------------------------------------------------------
# Disabled exchanges (togglable at runtime)
# ---------------------------------------------------------------------------
DISABLED_EXCHANGES: List[str] = []


# ---------------------------------------------------------------------------
# HTTP helper
# ---------------------------------------------------------------------------
async def _get(session, url, timeout=8):
    """Async HTTP GET with timeout — returns parsed JSON or None."""
    try:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=timeout)) as r:
            if r.status != 200:
                return None
            return await r.json()
    except Exception:
        return None


# ===========================================================================
# Exchange WS Manager — real-time ticker feeds (OKX, Bybit)
# ===========================================================================

class ExchangeWSManager:
    """Manages persistent websocket connections for real-time bid/ask tickers."""

    def __init__(self):
        self.cache: Dict[str, Dict[str, dict]] = {}  # "Bybit_PERP" -> {symbol -> {bid, ask, ts}}
        self._tasks = []
        self._session = None
        self._running = False
        self._connected: Dict[str, bool] = {}
        self._vol_cache: Dict[str, Dict[str, float]] = {}

    async def start(self, session: aiohttp.ClientSession):
        self._session = session
        self._running = True
        ws_runners = [
            ("Bybit_PERP", self._run_bybit_perp_ws),
            ("OKX_PERP", self._run_okx_perp_ws),
        ]
        for key, coro in ws_runners:
            self.cache[key] = {}
            self._connected[key] = False
            self._vol_cache[key] = {}
            self._tasks.append(asyncio.create_task(coro()))
        # Periodic volume refresh (WS doesn't include volume)
        self._tasks.append(asyncio.create_task(self._refresh_volumes()))
        log.info("Multi-exchange WS manager started")

    async def stop(self):
        self._running = False
        for t in self._tasks:
            t.cancel()
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass

    def _update(self, key: str, sym: str, bid: float, ask: float):
        if bid > 0 and ask > 0:
            self.cache.setdefault(key, {})[sym] = {"bid": bid, "ask": ask, "ts": time.time()}

    def is_connected(self, exchange: str, instrument: str = "PERP") -> bool:
        key = f"{exchange}_{instrument}"
        return self._connected.get(key, False) and len(self.cache.get(key, {})) > 10

    def get_quotes(self, exchange: str, instrument: str, symbols_set) -> List[PriceQuote]:
        key = f"{exchange}_{instrument}"
        quotes = []
        stale_cutoff = time.time() - 10
        for sym, d in self.cache.get(key, {}).items():
            if symbols_set and sym not in symbols_set:
                continue
            if d["ts"] < stale_cutoff or d["bid"] <= 0 or d["ask"] <= 0:
                continue
            mid = (d["bid"] + d["ask"]) / 2
            vol = self._vol_cache.get(key, {}).get(sym, 0)
            fr = get_funding_rate(exchange, sym) if instrument == "PERP" else 0
            quotes.append(PriceQuote(exchange=exchange, symbol=sym, bid=d["bid"], ask=d["ask"],
                                     mid=mid, volume_24h_usd=vol, funding_rate=fr, instrument=instrument))
        return quotes

    async def _refresh_volumes(self):
        """Refresh 24h volumes via REST every 5 min for WS-connected exchanges."""
        while self._running:
            try:
                # Bybit perp
                data = await _get(self._session, "https://api.bybit.com/v5/market/tickers?category=linear")
                if data and data.get("retCode") == 0:
                    for t in data.get("result", {}).get("list", []):
                        sym = t.get("symbol", "")
                        if sym.endswith("USDT"):
                            self._vol_cache.setdefault("Bybit_PERP", {})[sym] = float(t.get("turnover24h", 0))
                # OKX perp
                data = await _get(self._session, "https://www.okx.com/api/v5/market/tickers?instType=SWAP")
                if data and data.get("code") == "0":
                    for t in data.get("data", []):
                        inst = t.get("instId", "")
                        if inst.endswith("-USDT-SWAP"):
                            sym = inst.replace("-", "").replace("SWAP", "")
                            self._vol_cache.setdefault("OKX_PERP", {})[sym] = float(t.get("volCcy24h", 0))
            except Exception as e:
                log.debug(f"Exchange WS volume refresh error: {e}")
            await asyncio.sleep(300)

    async def _run_bybit_perp_ws(self):
        """Bybit linear — subscribe to allTickers topic for real-time bid/ask."""
        key = "Bybit_PERP"
        delay = 1
        while self._running:
            try:
                url = "wss://stream.bybit.com/v5/public/linear"
                async with self._session.ws_connect(url, heartbeat=20, timeout=30) as ws:
                    self._connected[key] = True
                    delay = 1
                    await ws.send_json({"op": "subscribe", "args": ["tickers.BTCUSDT"]})
                    log.info(f"{key} WS connected")
                    async for msg in ws:
                        if not self._running:
                            break
                        if msg.type == aiohttp.WSMsgType.TEXT:
                            try:
                                d = json.loads(msg.data)
                                topic = d.get("topic", "")
                                if topic.startswith("tickers."):
                                    data = d.get("data", {})
                                    sym = data.get("symbol", "")
                                    if sym.endswith("USDT"):
                                        bid = float(data.get("bid1Price", 0) or 0)
                                        ask = float(data.get("ask1Price", 0) or 0)
                                        self._update(key, sym, bid, ask)
                            except Exception:
                                pass
                        elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                            break
            except Exception as e:
                log.warning(f"{key} WS error: {e}, reconnect in {delay}s")
            finally:
                self._connected[key] = False
            if self._running:
                await asyncio.sleep(delay)
                delay = min(delay * 2, 30)

    async def _run_okx_perp_ws(self):
        """OKX perpetual swaps — subscribe to all SWAP tickers."""
        key = "OKX_PERP"
        delay = 1
        while self._running:
            try:
                url = "wss://ws.okx.com:8443/ws/v5/public"
                async with self._session.ws_connect(url, heartbeat=20, timeout=30) as ws:
                    self._connected[key] = True
                    delay = 1
                    log.info(f"{key} WS connected")
                    async for msg in ws:
                        if not self._running:
                            break
                        if msg.type == aiohttp.WSMsgType.TEXT:
                            try:
                                d = json.loads(msg.data)
                                if d.get("arg", {}).get("channel") == "tickers":
                                    for item in d.get("data", []):
                                        inst_id = item.get("instId", "")
                                        if inst_id.endswith("-USDT-SWAP"):
                                            sym = inst_id.replace("-", "").replace("SWAP", "")
                                            bid = float(item.get("bidPx", 0) or 0)
                                            ask = float(item.get("askPx", 0) or 0)
                                            self._update(key, sym, bid, ask)
                            except Exception:
                                pass
                        elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                            break
            except Exception as e:
                log.warning(f"{key} WS error: {e}, reconnect in {delay}s")
            finally:
                self._connected[key] = False
            if self._running:
                await asyncio.sleep(delay)
                delay = min(delay * 2, 30)

    async def subscribe_symbols(self, symbols: List[str]):
        """Subscribe to specific symbols on OKX and Bybit (which need per-symbol subs)."""
        for key, cache in self.cache.items():
            if not self._connected.get(key):
                continue
            # Note: subscription happens via the WS connection tasks


_exchange_ws = ExchangeWSManager()


# ===========================================================================
# Orderbook WS Manager — real-time L2 depth (OKX, Bybit)
# ===========================================================================

OB_WS_MAX_SYMBOLS = 40          # Track top N symbols across all exchanges
OB_WS_STALE_SECONDS = 5         # Consider OB data stale after 5s
OB_WS_LEVELS = 20               # Keep 20 levels per side (matches OB_LEVELS_LIMIT)


class OrderbookWSManager:
    """Maintains real-time L2 orderbook depth via WebSocket for top symbols.
    Dynamically subscribes to the most active candidates to eliminate REST OB calls.
    Falls back to REST for symbols not in the active set."""

    def __init__(self):
        self.cache: Dict[str, Dict[str, dict]] = {}
        self._tasks: list = []
        self._session: Optional[aiohttp.ClientSession] = None
        self._running = False
        self._connected: Dict[str, bool] = {}
        self._subscribed: Dict[str, set] = {}
        self._active_symbols: set = set()
        self._sub_lock = asyncio.Lock()
        self.hits = 0
        self.misses = 0

    async def start(self, session: aiohttp.ClientSession):
        self._session = session
        self._running = True
        runners = [
            ("Bybit_PERP", self._run_bybit_perp_ob),
            ("Bybit_SPOT", self._run_bybit_spot_ob),
            ("OKX_PERP", self._run_okx_ob),
        ]
        for key, coro in runners:
            self.cache[key] = {}
            self._connected[key] = False
            self._subscribed[key] = set()
            self._tasks.append(asyncio.create_task(coro()))
        log.info(f"Orderbook WS manager started — tracking top {OB_WS_MAX_SYMBOLS} symbols")

    async def stop(self):
        self._running = False
        for t in self._tasks:
            t.cancel()
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass

    def update_active_symbols(self, symbols: set):
        """Called by main loop to update which symbols should be tracked."""
        self._active_symbols = set(list(symbols)[:OB_WS_MAX_SYMBOLS])

    def get_orderbook(self, exchange: str, symbol: str, instrument: str):
        """Get cached L2 orderbook levels. Returns (bids, asks) or (None, None) if not cached/stale."""
        key = f"{exchange}_{instrument}"
        data = self.cache.get(key, {}).get(symbol)
        if not data:
            self.misses += 1
            return None, None
        if time.time() - data["ts"] > OB_WS_STALE_SECONDS:
            self.misses += 1
            return None, None
        self.hits += 1
        return data["bids"], data["asks"]

    def _store(self, key: str, symbol: str, bids_raw: list, asks_raw: list):
        """Parse and store orderbook levels in normalized format [(price, usd), ...]."""
        bids = []
        asks = []
        for entry in bids_raw:
            try:
                if isinstance(entry, (list, tuple)) and len(entry) >= 2:
                    px, qty = float(entry[0]), float(entry[1])
                elif isinstance(entry, dict):
                    px = float(entry.get('p', entry.get('price', 0)))
                    qty = float(entry.get('s', entry.get('size', entry.get('qty', 0))))
                else:
                    continue
                if px > 0 and qty > 0:
                    bids.append((px, px * qty))
            except (ValueError, TypeError):
                continue
        for entry in asks_raw:
            try:
                if isinstance(entry, (list, tuple)) and len(entry) >= 2:
                    px, qty = float(entry[0]), float(entry[1])
                elif isinstance(entry, dict):
                    px = float(entry.get('p', entry.get('price', 0)))
                    qty = float(entry.get('s', entry.get('size', entry.get('qty', 0))))
                else:
                    continue
                if px > 0 and qty > 0:
                    asks.append((px, px * qty))
            except (ValueError, TypeError):
                continue
        if bids and asks:
            self.cache.setdefault(key, {})[symbol] = {
                "bids": bids, "asks": asks, "ts": time.time()
            }

    # -- Bybit Perp: orderbook.25 topic per symbol --
    async def _run_bybit_perp_ob(self):
        key = "Bybit_PERP"
        delay = 1
        while self._running:
            try:
                while not self._active_symbols and self._running:
                    await asyncio.sleep(5)
                syms = [s for s in self._active_symbols if s.endswith("USDT")]
                if not syms:
                    await asyncio.sleep(5)
                    continue
                url = "wss://stream.bybit.com/v5/public/linear"
                async with self._session.ws_connect(url, heartbeat=20, timeout=30) as ws:
                    self._connected[key] = True
                    delay = 1
                    args = [f"orderbook.25.{s}" for s in syms[:40]]
                    await ws.send_json({"op": "subscribe", "args": args})
                    self._subscribed[key] = set(syms)
                    log.info(f"{key} OB WS connected — {len(syms)} symbols")
                    async for msg in ws:
                        if not self._running:
                            break
                        if msg.type == aiohttp.WSMsgType.TEXT:
                            try:
                                d = json.loads(msg.data)
                                topic = d.get("topic", "")
                                if topic.startswith("orderbook.25."):
                                    sym = topic.split(".")[-1]
                                    data = d.get("data", {})
                                    ob_type = d.get("type", "")
                                    if ob_type == "snapshot":
                                        self._store(key, sym, data.get("b", []), data.get("a", []))
                                    elif ob_type == "delta":
                                        existing = self.cache.get(key, {}).get(sym)
                                        if existing:
                                            self._apply_bybit_delta(key, sym, data)
                            except Exception:
                                pass
                        elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                            break
            except Exception as e:
                log.warning(f"{key} OB WS error: {e}, reconnect in {delay}s")
            finally:
                self._connected[key] = False
            if self._running:
                await asyncio.sleep(delay)
                delay = min(delay * 2, 30)

    async def _run_bybit_spot_ob(self):
        key = "Bybit_SPOT"
        delay = 1
        while self._running:
            try:
                while not self._active_symbols and self._running:
                    await asyncio.sleep(5)
                syms = [s for s in self._active_symbols if s.endswith("USDT")]
                if not syms:
                    await asyncio.sleep(5)
                    continue
                url = "wss://stream.bybit.com/v5/public/spot"
                async with self._session.ws_connect(url, heartbeat=20, timeout=30) as ws:
                    self._connected[key] = True
                    delay = 1
                    args = [f"orderbook.25.{s}" for s in syms[:40]]
                    await ws.send_json({"op": "subscribe", "args": args})
                    self._subscribed[key] = set(syms)
                    log.info(f"{key} OB WS connected — {len(syms)} symbols")
                    async for msg in ws:
                        if not self._running:
                            break
                        if msg.type == aiohttp.WSMsgType.TEXT:
                            try:
                                d = json.loads(msg.data)
                                topic = d.get("topic", "")
                                if topic.startswith("orderbook.25."):
                                    sym = topic.split(".")[-1]
                                    data = d.get("data", {})
                                    ob_type = d.get("type", "")
                                    if ob_type == "snapshot":
                                        self._store(key, sym, data.get("b", []), data.get("a", []))
                                    elif ob_type == "delta":
                                        existing = self.cache.get(key, {}).get(sym)
                                        if existing:
                                            self._apply_bybit_delta(key, sym, data)
                            except Exception:
                                pass
                        elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                            break
            except Exception as e:
                log.warning(f"{key} OB WS error: {e}, reconnect in {delay}s")
            finally:
                self._connected[key] = False
            if self._running:
                await asyncio.sleep(delay)
                delay = min(delay * 2, 30)

    def _apply_bybit_delta(self, key: str, sym: str, data: dict):
        """Apply Bybit delta updates to cached orderbook."""
        existing = self.cache.get(key, {}).get(sym)
        if not existing:
            return
        for side, side_key in [("b", "bids"), ("a", "asks")]:
            updates = data.get(side, [])
            if not updates:
                continue
            current = {px: usd for px, usd in existing[side_key]}
            for entry in updates:
                try:
                    px = float(entry[0])
                    qty = float(entry[1])
                    if qty == 0:
                        current.pop(px, None)
                    else:
                        current[px] = px * qty
                except (ValueError, IndexError):
                    continue
            if side_key == "bids":
                existing[side_key] = sorted(current.items(), key=lambda x: -x[0])
            else:
                existing[side_key] = sorted(current.items(), key=lambda x: x[0])
        existing["ts"] = time.time()

    # -- OKX: books channel per instrument --
    async def _run_okx_ob(self):
        key = "OKX_PERP"
        delay = 1
        while self._running:
            try:
                while not self._active_symbols and self._running:
                    await asyncio.sleep(5)
                syms = [s for s in self._active_symbols if s.endswith("USDT")]
                if not syms:
                    await asyncio.sleep(5)
                    continue
                url = "wss://ws.okx.com:8443/ws/v5/public"
                async with self._session.ws_connect(url, heartbeat=20, timeout=30) as ws:
                    self._connected[key] = True
                    delay = 1
                    args = []
                    for s in syms[:40]:
                        base = s.replace("USDT", "")
                        args.append({"channel": "books5", "instId": f"{base}-USDT-SWAP"})
                    await ws.send_json({"op": "subscribe", "args": args})
                    self._subscribed[key] = set(syms)
                    log.info(f"{key} OB WS connected — {len(syms)} symbols")
                    async for msg in ws:
                        if not self._running:
                            break
                        if msg.type == aiohttp.WSMsgType.TEXT:
                            try:
                                d = json.loads(msg.data)
                                arg = d.get("arg", {})
                                if arg.get("channel") in ("books5", "books"):
                                    inst_id = arg.get("instId", "")
                                    if inst_id.endswith("-USDT-SWAP"):
                                        sym = inst_id.replace("-", "").replace("SWAP", "")
                                        for item in d.get("data", []):
                                            self._store(key, sym, item.get("bids", []), item.get("asks", []))
                            except Exception:
                                pass
                        elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                            break
            except Exception as e:
                log.warning(f"{key} OB WS error: {e}, reconnect in {delay}s")
            finally:
                self._connected[key] = False
            if self._running:
                await asyncio.sleep(delay)
                delay = min(delay * 2, 30)


_ob_ws = OrderbookWSManager()


# ===========================================================================
# REST Batch Fetchers — 1 API call per exchange fetches ALL tickers
# ===========================================================================

async def fetch_okx_perp(session, symbols_set) -> List[PriceQuote]:
    """OKX swaps — use WS cache if connected, else fall back to REST."""
    if _exchange_ws.is_connected("OKX", "PERP"):
        return _exchange_ws.get_quotes("OKX", "PERP", symbols_set)
    quotes = []
    data = await _get(session, "https://www.okx.com/api/v5/market/tickers?instType=SWAP")
    if not data or data.get("code") != "0":
        return quotes
    for t in data.get("data", []):
        inst_id = t.get("instId", "")  # BTC-USDT-SWAP
        if not inst_id.endswith("-USDT-SWAP"):
            continue
        sym = inst_id.replace("-", "").replace("SWAP", "")  # BTCUSDT
        bid = float(t.get("bidPx", 0))
        ask = float(t.get("askPx", 0))
        last = float(t.get("last", 0))
        if bid == 0: bid = last
        if ask == 0: ask = last
        if bid <= 0 or ask <= 0:
            continue
        mid = (bid + ask) / 2
        vol = float(t.get("volCcy24h", 0))
        quotes.append(PriceQuote(exchange="OKX", symbol=sym, bid=bid, ask=ask, mid=mid,
                                 volume_24h_usd=vol, funding_rate=0))
    return quotes


async def fetch_okx_spot(session, symbols_set) -> List[PriceQuote]:
    """OKX spot — single call returns ALL tickers."""
    quotes = []
    data = await _get(session, "https://www.okx.com/api/v5/market/tickers?instType=SPOT")
    if not data or data.get("code") != "0":
        return quotes
    for t in data.get("data", []):
        inst_id = t.get("instId", "")  # BTC-USDT
        if not inst_id.endswith("-USDT"):
            continue
        sym = inst_id.replace("-", "")  # BTCUSDT
        if sym not in symbols_set:
            continue
        bid = float(t.get("bidPx", 0))
        ask = float(t.get("askPx", 0))
        last = float(t.get("last", 0))
        if bid == 0: bid = last
        if ask == 0: ask = last
        if bid <= 0 or ask <= 0:
            continue
        mid = (bid + ask) / 2
        vol = float(t.get("volCcy24h", 0))
        quotes.append(PriceQuote(exchange="OKX", symbol=sym, bid=bid, ask=ask, mid=mid,
                                 volume_24h_usd=vol, funding_rate=0, instrument="SPOT"))
    return quotes


async def fetch_bybit_perp(session, symbols_set) -> List[PriceQuote]:
    """Bybit linear — use WS cache if connected, else fall back to REST."""
    if _exchange_ws.is_connected("Bybit", "PERP"):
        return _exchange_ws.get_quotes("Bybit", "PERP", symbols_set)
    quotes = []
    data = await _get(session, "https://api.bybit.com/v5/market/tickers?category=linear")
    if not data or data.get("retCode") != 0:
        return quotes
    for t in data.get("result", {}).get("list", []):
        sym = t.get("symbol", "")
        if not sym.endswith("USDT"):
            continue
        bid = float(t.get("bid1Price", 0))
        ask = float(t.get("ask1Price", 0))
        if bid <= 0 or ask <= 0:
            continue
        mid = (bid + ask) / 2
        vol = float(t.get("turnover24h", 0))
        fr = float(t.get("fundingRate", 0))
        quotes.append(PriceQuote(exchange="Bybit", symbol=sym, bid=bid, ask=ask, mid=mid,
                                 volume_24h_usd=vol, funding_rate=fr))
    return quotes


async def fetch_bybit_spot(session, symbols_set) -> List[PriceQuote]:
    """Bybit spot — single call returns ALL tickers."""
    quotes = []
    data = await _get(session, "https://api.bybit.com/v5/market/tickers?category=spot")
    if not data or data.get("retCode") != 0:
        return quotes
    for t in data.get("result", {}).get("list", []):
        sym = t.get("symbol", "")
        if not sym.endswith("USDT") or sym not in symbols_set:
            continue
        bid = float(t.get("bid1Price", 0))
        ask = float(t.get("ask1Price", 0))
        if bid <= 0 or ask <= 0:
            continue
        mid = (bid + ask) / 2
        vol = float(t.get("turnover24h", 0))
        quotes.append(PriceQuote(exchange="Bybit", symbol=sym, bid=bid, ask=ask, mid=mid,
                                 volume_24h_usd=vol, funding_rate=0, instrument="SPOT"))
    return quotes


async def fetch_mexc_perp(session, symbols_set) -> List[PriceQuote]:
    """MEXC futures — single call returns ALL tickers."""
    quotes = []
    data = await _get(session, "https://contract.mexc.com/api/v1/contract/ticker")
    if not data or not data.get("success"):
        return quotes
    for t in data.get("data", []):
        sym_raw = t.get("symbol", "")
        sym = sym_raw.replace("_", "")
        if not sym.endswith("USDT"):
            continue
        bid = float(t.get("bid1", 0))
        ask = float(t.get("ask1", 0))
        last = float(t.get("lastPrice", 0))
        if bid == 0: bid = last
        if ask == 0: ask = last
        if bid <= 0 or ask <= 0:
            continue
        mid = (bid + ask) / 2
        fr = float(t.get("fundingRate", 0))
        vol = float(t.get("volume24", 0))
        quotes.append(PriceQuote(exchange="MEXC", symbol=sym, bid=bid, ask=ask, mid=mid,
                                 volume_24h_usd=vol, funding_rate=fr))
    return quotes


async def fetch_mexc_spot(session, symbols_set) -> List[PriceQuote]:
    """MEXC spot — 24hr ticker has bid/ask + volume."""
    quotes = []
    data = await _get(session, "https://api.mexc.com/api/v3/ticker/24hr", timeout=12)
    if not data or not isinstance(data, list):
        return quotes
    for t in data:
        sym = t.get("symbol", "")
        if not sym.endswith("USDT") or sym not in symbols_set:
            continue
        bid = float(t.get("bidPrice", 0))
        ask = float(t.get("askPrice", 0))
        if bid <= 0 or ask <= 0:
            continue
        mid = (bid + ask) / 2
        vol = float(t.get("quoteVolume", 0))
        quotes.append(PriceQuote(exchange="MEXC", symbol=sym, bid=bid, ask=ask, mid=mid,
                                 volume_24h_usd=vol, funding_rate=0, instrument="SPOT"))
    return quotes


async def fetch_blofin_perp(session, symbols_set) -> List[PriceQuote]:
    """BloFin perpetual swaps — single call returns all tickers."""
    quotes = []
    data = await _get(session, "https://openapi.blofin.com/api/v1/market/tickers")
    if not data or data.get("code") != "0":
        return quotes
    for t in data.get("data", []):
        inst_id = t.get("instId", "")  # BTC-USDT
        if not inst_id.endswith("-USDT"):
            continue
        sym = inst_id.replace("-", "")  # BTCUSDT
        if symbols_set and sym not in symbols_set:
            continue
        bid = float(t.get("bidPrice", 0))
        ask = float(t.get("askPrice", 0))
        last = float(t.get("last", 0))
        if bid == 0: bid = last
        if ask == 0: ask = last
        if bid <= 0 or ask <= 0:
            continue
        mid = (bid + ask) / 2
        vol_base = float(t.get("volCurrency24h", 0))
        vol_usd = vol_base * last
        quotes.append(PriceQuote(exchange="BloFin", symbol=sym, bid=bid, ask=ask, mid=mid,
                                 volume_24h_usd=vol_usd, funding_rate=0))
    return quotes


# ===========================================================================
# Funding Rate Cache — fetch live rates for our 4 exchanges every 5 minutes
# ===========================================================================

_funding_cache: Dict[str, Dict[str, float]] = {}  # exchange -> {symbol -> rate}
_funding_cache_ts: float = 0


async def refresh_funding_rates(session):
    """Fetch current funding rates from all 4 exchanges in parallel."""
    global _funding_cache, _funding_cache_ts
    cache = {}

    async def _bybit_fr():
        data = await _get(session, "https://api.bybit.com/v5/market/tickers?category=linear")
        rates = {}
        if data and data.get("retCode") == 0:
            for t in data.get("result", {}).get("list", []):
                sym = t.get("symbol", "")
                if sym.endswith("USDT"):
                    rates[sym] = float(t.get("fundingRate", 0))
        return "Bybit", rates

    async def _okx_fr():
        data = await _get(session, "https://www.okx.com/api/v5/public/funding-rate")
        rates = {}
        if data and data.get("code") == "0":
            for t in data.get("data", []):
                inst = t.get("instId", "")
                if inst.endswith("-USDT-SWAP"):
                    sym = inst.replace("-", "").replace("SWAP", "")
                    rates[sym] = float(t.get("fundingRate", 0)) * 100
        return "OKX", rates

    async def _mexc_fr():
        data = await _get(session, "https://contract.mexc.com/api/v1/contract/ticker")
        rates = {}
        if data and data.get("success"):
            for t in data.get("data", []):
                sym = t.get("symbol", "").replace("_", "")
                if sym.endswith("USDT"):
                    rates[sym] = float(t.get("fundingRate", 0))
        return "MEXC", rates

    async def _blofin_fr():
        rates = {}
        data = await _get(session, "https://openapi.blofin.com/api/v1/market/funding-rate")
        if data and data.get("code") == "0":
            for t in data.get("data", []):
                inst_id = t.get("instId", "")
                if inst_id.endswith("-USDT"):
                    sym = inst_id.replace("-", "")
                    rates[sym] = float(t.get("fundingRate", 0))
        return "BloFin", rates

    results = await asyncio.gather(
        _bybit_fr(), _okx_fr(), _mexc_fr(), _blofin_fr(),
        return_exceptions=True
    )
    for r in results:
        if isinstance(r, Exception):
            continue
        exchange, rates = r
        if rates:
            cache[exchange] = rates

    _funding_cache = cache
    _funding_cache_ts = time.time()
    total = sum(len(v) for v in cache.values())
    log.info(f"Funding rates refreshed: {total} symbols across {len(cache)} exchanges")


def get_funding_rate(exchange: str, symbol: str) -> float:
    """Get cached funding rate for a symbol on an exchange."""
    return _funding_cache.get(exchange, {}).get(symbol, 0.0)


# ===========================================================================
# BATCH_FETCHERS registry — all REST fetcher functions
# ===========================================================================

BATCH_FETCHERS = [
    fetch_okx_perp, fetch_okx_spot,
    fetch_bybit_perp, fetch_bybit_spot,
    fetch_mexc_perp, fetch_mexc_spot,
    fetch_blofin_perp,
]


# ===========================================================================
# Symbol Discovery — find USDT symbols listed on 2+ of our exchanges
# ===========================================================================

async def discover_symbols(session) -> List[str]:
    """Discover all symbols on MIN_EXCHANGES_PER_SYMBOL+ exchanges by doing one batch fetch."""
    results = await asyncio.gather(
        *[f(session, set()) for f in BATCH_FETCHERS],  # empty set = fetch all USDT
        return_exceptions=True
    )
    # Count unique exchange+instrument per symbol
    sym_sources: Dict[str, set] = collections.defaultdict(set)
    for result in results:
        if isinstance(result, Exception):
            continue
        for q in result:
            sym_sources[q.symbol].add(f"{q.exchange}|{q.instrument}")

    # Keep symbols with 2+ unique sources, excluding delisted assets
    symbols = sorted([s for s, sources in sym_sources.items()
                     if len(sources) >= MIN_EXCHANGES_PER_SYMBOL
                     and s not in DELISTED_SYMBOLS
                     and s not in BLOCKED_SYMBOLS])
    return symbols


# Classes, functions, and main loop will be added in subsequent tasks.
