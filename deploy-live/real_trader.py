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
BREAKOUT_LOOKBACK: int = 20             # Number of spread readings to track per symbol
BREAKOUT_WIDEN_RATIO: float = 0.70      # 70% of ticks widening triggers breakout
BREAKOUT_MIN_DRIFT_REL: float = 0.15    # Minimum drift as fraction of current spread
BREAKOUT_LOSS_MEMORY_HOURS: int = 6     # Hours to blacklist a symbol after breakout losses

# ---------------------------------------------------------------------------
# Dynamic exit params
# ---------------------------------------------------------------------------
DYNAMIC_EXIT_ENABLED: bool = True
DYNAMIC_EXIT_PROFIT_LOCK_PCT: float = 0.50  # Lock in 50% of peak profit on exit
DYNAMIC_EXIT_TRAIL_PCT: float = 0.10        # Trailing stop as fraction of spread
BASELINE_SPREAD_WINDOW: int = 60            # Rolling window for baseline spread calc

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
AGED_POSITION_THRESHOLD_MIN: float = 10.0   # Position is "aged" after this many minutes
AGED_POSITION_MAX_ALLOC_PCT: float = 0.30   # Max 30% equity in aged positions

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
# Rotating file log handler (module-level so early errors are captured)
# ---------------------------------------------------------------------------
try:
    from logging.handlers import RotatingFileHandler as _RFH
    _file_handler = _RFH(
        os.path.join(str(DATA_DIR), "real_trader.log"),
        maxBytes=10 * 1024 * 1024,  # 10 MB
        backupCount=5,
    )
    _file_handler.setFormatter(logging.Formatter(
        "%(asctime)s [%(levelname)s] %(message)s", datefmt="%Y-%m-%dT%H:%M:%S"
    ))
    log.addHandler(_file_handler)
except Exception:
    pass  # File logging best-effort; console logging still works

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
        now = datetime.now(timezone.utc)
        ts = now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"
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
                            "available": float(d.get("availBal", 0)),
                            "locked": float(d.get("frozenBal", 0)),
                        }
            self._mark_error("No USDT balance data")
            return {"available": 0.0, "locked": 0.0}
        except Exception as e:
            self._mark_error(str(e))
            return {"available": 0.0, "locked": 0.0}

    async def cancel_order(self, order_id: str, symbol: str) -> bool:
        base = symbol.replace("USDT", "")
        inst_id = f"{base}-USDT-SWAP"
        path = "/api/v5/trade/cancel-order"
        payload = {"instId": inst_id, "ordId": order_id}
        body = json.dumps(payload)
        headers = self._headers("POST", path, body)
        try:
            async with self.session.post(
                self.BASE_URL + path, headers=headers, data=body,
                timeout=aiohttp.ClientTimeout(total=ORDER_TIMEOUT_SEC),
            ) as resp:
                data = await resp.json()
            if data.get("code") == "0":
                self._mark_success()
                return True
            self._mark_error(data.get("msg", str(data)))
            return False
        except Exception as e:
            self._mark_error(str(e))
            return False

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
                            "available": float(c.get("availableToWithdraw", 0)),
                            "locked": float(c.get("locked", 0)),
                        }
            self._mark_error("No USDT balance data")
            return {"available": 0.0, "locked": 0.0}
        except Exception as e:
            self._mark_error(str(e))
            return {"available": 0.0, "locked": 0.0}

    async def cancel_order(self, order_id: str, symbol: str) -> bool:
        path = "/v5/order/cancel"
        payload = {"category": "linear", "symbol": symbol, "orderId": order_id}
        body = json.dumps(payload)
        ts = str(int(time.time() * 1000))
        headers = self._headers(ts, body)
        try:
            async with self.session.post(
                self.BASE_URL + path, headers=headers, data=body,
                timeout=aiohttp.ClientTimeout(total=ORDER_TIMEOUT_SEC),
            ) as resp:
                data = await resp.json()
            if data.get("retCode") == 0:
                self._mark_success()
                return True
            self._mark_error(data.get("retMsg", str(data)))
            return False
        except Exception as e:
            self._mark_error(str(e))
            return False

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
                        "available": float(a.get("availableBalance", 0)),
                        "locked": float(a.get("frozenBalance", 0)),
                    }
                elif isinstance(assets, dict):
                    self._mark_success()
                    return {
                        "available": float(assets.get("availableBalance", 0)),
                        "locked": float(assets.get("frozenBalance", 0)),
                    }
            self._mark_error("No USDT balance data")
            return {"available": 0.0, "locked": 0.0}
        except Exception as e:
            self._mark_error(str(e))
            return {"available": 0.0, "locked": 0.0}

    async def cancel_order(self, order_id: str, symbol: str) -> bool:
        base = symbol.replace("USDT", "")
        mexc_symbol = f"{base}_USDT"
        path = "/api/v1/private/order/cancel"
        params = {"symbol": mexc_symbol, "orderId": order_id}
        headers = self._headers(params.copy())
        body = json.dumps(params)
        try:
            async with self.session.post(
                self.BASE_URL + path, headers=headers, data=body,
                timeout=aiohttp.ClientTimeout(total=ORDER_TIMEOUT_SEC),
            ) as resp:
                data = await resp.json()
            if data.get("success"):
                self._mark_success()
                return True
            self._mark_error(data.get("message", str(data)))
            return False
        except Exception as e:
            self._mark_error(str(e))
            return False

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
        now = datetime.now(timezone.utc)
        ts = now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"
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
                                "available": float(d.get("availBal", 0)),
                                "locked": float(d.get("frozenBal", 0)),
                            }
                elif isinstance(bal_data, dict):
                    self._mark_success()
                    return {
                        "available": float(bal_data.get("availBal", 0)),
                        "locked": float(bal_data.get("frozenBal", 0)),
                    }
            self._mark_error("No balance data")
            return {"available": 0.0, "locked": 0.0}
        except Exception as e:
            self._mark_error(str(e))
            return {"available": 0.0, "locked": 0.0}

    async def cancel_order(self, order_id: str, symbol: str) -> bool:
        base = symbol.replace("USDT", "")
        inst_id = f"{base}-USDT"
        path = "/api/v1/trade/cancel-order"
        payload = {"instId": inst_id, "orderId": order_id}
        body = json.dumps(payload)
        headers = self._headers("POST", path, body)
        try:
            async with self.session.post(
                self.BASE_URL + path, headers=headers, data=body,
                timeout=aiohttp.ClientTimeout(total=ORDER_TIMEOUT_SEC),
            ) as resp:
                data = await resp.json()
            if data.get("code") == "0":
                self._mark_success()
                return True
            self._mark_error(data.get("msg", str(data)))
            return False
        except Exception as e:
            self._mark_error(str(e))
            return False

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


class DryRunExecutor(ExchangeExecutor):
    """Stub executor used in DRY_RUN mode when no real API keys are available.

    All trading calls are no-ops that log their intent.  Balance queries return
    a fixed simulated equity so the rest of the bot logic can exercise normally.
    """

    def __init__(self, name: str, session: aiohttp.ClientSession):
        super().__init__(name, api_key="dry", api_secret="dry", session=session)

    async def place_market_order(self, symbol: str, side: str, size_usd: float) -> "OrderResult":
        log.info(f"[DRY_RUN:{self.name}] place_market_order {side} {symbol} ${size_usd:.2f}")
        self._mark_success()
        return OrderResult(
            success=True,
            order_id=f"dryrun-{self.name}-{int(time.time() * 1000)}",
            exchange=self.name,
            symbol=symbol,
            side=side,
            size_usd=size_usd,
            filled_usd=size_usd,
            fill_price=0.0,
            fees_usd=size_usd * 0.001,
            timestamp=time.time(),
            latency_ms=0.0,
        )

    async def get_order_status(self, order_id: str, symbol: str) -> dict:
        return {"status": "filled", "filled_qty": 0.0, "fill_price": 0.0}

    async def cancel_order(self, order_id: str, symbol: str) -> bool:
        return True

    async def get_balance(self) -> Dict[str, float]:
        self._mark_success()
        return {"available": STARTING_CAPITAL / len(EXCHANGES), "locked": 0.0}

    async def get_open_positions(self) -> List[dict]:
        return []


def create_executors(session: aiohttp.ClientSession) -> Dict[str, ExchangeExecutor]:
    """Factory: create exchange executors for all configured exchanges.

    In DRY_RUN mode with no API keys, falls back to DryRunExecutor stubs for
    all four exchanges so the bot can exercise the full startup / main-loop
    path without real credentials.
    """
    executors: Dict[str, ExchangeExecutor] = {}
    if OKX_API_KEY and OKX_API_SECRET:
        executors["OKX"] = OKXExecutor(OKX_API_KEY, OKX_API_SECRET, OKX_PASSPHRASE, session)
    if BYBIT_API_KEY and BYBIT_API_SECRET:
        executors["Bybit"] = BybitExecutor("Bybit", BYBIT_API_KEY, BYBIT_API_SECRET, session)
    if MEXC_API_KEY and MEXC_API_SECRET:
        executors["MEXC"] = MEXCExecutor("MEXC", MEXC_API_KEY, MEXC_API_SECRET, session)
    if BLOFIN_API_KEY and BLOFIN_API_SECRET:
        executors["BloFin"] = BloFinExecutor(BLOFIN_API_KEY, BLOFIN_API_SECRET, BLOFIN_PASSPHRASE, session)

    # In DRY_RUN mode with no real keys, create stub executors so the full
    # startup path (symbol discovery, main loop, state saving) can be verified.
    if not executors and DRY_RUN:
        log.warning("DRY_RUN mode: no API keys found — using DryRunExecutor stubs")
        for name in EXCHANGES:
            executors[name] = DryRunExecutor(name, session)

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
        self._tracked_symbols: List[str] = []

    def set_tracked_symbols(self, symbols: List[str]):
        """Set the list of symbols to subscribe to on WS feeds."""
        self._tracked_symbols = list(symbols)

    def _get_tracked_symbols(self) -> List[str]:
        return self._tracked_symbols

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
                    # Subscribe to all tracked symbols (not just BTCUSDT)
                    syms = [s for s in self._get_tracked_symbols() if s.endswith("USDT")]
                    if not syms:
                        syms = ["BTCUSDT"]
                    args = [f"tickers.{s}" for s in syms]
                    await ws.send_json({"op": "subscribe", "args": args})
                    log.info(f"{key} WS connected — subscribed to {len(args)} symbols")
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
                    # Subscribe to tickers for all tracked symbols
                    syms = [s for s in self._get_tracked_symbols() if s.endswith("USDT")]
                    if syms:
                        args = []
                        for s in syms:
                            base = s.replace("USDT", "")
                            args.append({"channel": "tickers", "instId": f"{base}-USDT-SWAP"})
                        await ws.send_json({"op": "subscribe", "args": args})
                    log.info(f"{key} WS connected — subscribed to {len(syms)} symbols")
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


# ===========================================================================
# Risk Manager
# ===========================================================================

class RiskManager:
    """Enforces all risk limits before and during trading."""

    def __init__(self, portfolio: Portfolio, executors: Dict[str, ExchangeExecutor]):
        self.portfolio = portfolio
        self.executors = executors
        self.kill_switch_active = False
        self.kill_switch_time: Optional[float] = None
        self.manual_stop = False
        self.reconciliation_paused = False
        self.balance_cache: Dict[str, Dict[str, float]] = {}
        self.last_balance_refresh = 0.0
        self.last_reconcile_time = 0.0

    async def refresh_balances(self):
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
        if self.manual_stop:
            return False, "manual_stop"
        if self.reconciliation_paused:
            return False, "reconciliation_mismatch — paused until resolved"
        if self.kill_switch_active:
            elapsed = time.time() - (self.kill_switch_time or 0)
            if elapsed < COOLDOWN_AFTER_KILL_SEC:
                return False, f"kill_switch_cooldown ({COOLDOWN_AFTER_KILL_SEC - elapsed:.0f}s remaining)"
            if self.portfolio.equity >= self.portfolio.starting_capital * 0.90:
                self.kill_switch_active = False
                log.info("Kill switch reset — equity recovered")
            else:
                return False, "kill_switch_equity_below_threshold"
        equity = self.portfolio.equity
        if equity < self.portfolio.starting_capital * (1 - KILL_SWITCH_DRAWDOWN_PCT / 100):
            return False, "drawdown_exceeded"
        return True, ""

    def can_open_position(self, exchange_short: str, exchange_long: str, size_usd: float) -> Tuple[bool, str]:
        can, reason = self.can_trade()
        if not can:
            return False, reason
        n_open = len(self.portfolio.open_positions)
        if n_open >= MAX_CONCURRENT:
            return False, f"max_positions ({n_open}/{MAX_CONCURRENT})"
        if size_usd > MAX_POSITION_USD:
            size_usd = MAX_POSITION_USD
        bal_short = self.get_available_balance(exchange_short)
        bal_long = self.get_available_balance(exchange_long)
        if bal_short < size_usd:
            return False, f"insufficient_balance_{exchange_short} (${bal_short:.2f})"
        if bal_long < size_usd:
            return False, f"insufficient_balance_{exchange_long} (${bal_long:.2f})"
        ex_short = self.executors.get(exchange_short)
        ex_long = self.executors.get(exchange_long)
        if ex_short and not ex_short.healthy:
            return False, f"exchange_unhealthy_{exchange_short}"
        if ex_long and not ex_long.healthy:
            return False, f"exchange_unhealthy_{exchange_long}"
        degraded_usd = sum(p.size_usd for p in self.portfolio.open_positions if p.status == "DEGRADED")
        if degraded_usd > self.portfolio.equity * 0.50:
            return False, "degraded_exposure_too_high"
        # Concentration check
        exposure_short = sum(p.size_usd for p in self.portfolio.open_positions
                            if p.exchange_short == exchange_short or p.exchange_long == exchange_short)
        max_conc = bal_short * MAX_PER_EXCHANGE_PCT
        if exposure_short + size_usd > max_conc:
            return False, f"concentration_{exchange_short}"
        exposure_long = sum(p.size_usd for p in self.portfolio.open_positions
                           if p.exchange_short == exchange_long or p.exchange_long == exchange_long)
        max_conc = bal_long * MAX_PER_EXCHANGE_PCT
        if exposure_long + size_usd > max_conc:
            return False, f"concentration_{exchange_long}"
        # Aged positions
        now = datetime.now(timezone.utc)
        aged = sum(p.size_usd for p in self.portfolio.open_positions
                   if (now - p.entry_time).total_seconds() / 60 > AGED_POSITION_THRESHOLD_MIN)
        if aged >= self.portfolio.equity * AGED_POSITION_MAX_ALLOC_PCT:
            return False, "aged_position_budget_full"
        return True, ""

    async def trigger_kill_switch(self, reason: str):
        self.kill_switch_active = True
        self.kill_switch_time = time.time()
        log.critical(f"KILL SWITCH ACTIVATED: {reason}")

    async def reconcile_positions(self, session: aiohttp.ClientSession):
        if time.time() - self.last_reconcile_time < RECONCILE_INTERVAL_SEC:
            return []
        self.last_reconcile_time = time.time()
        mismatches = []
        for ex_name, executor in self.executors.items():
            try:
                actual = await executor.get_open_positions()
                actual_symbols = {p["symbol"] for p in actual}
                bot_symbols = set()
                for p in self.portfolio.open_positions:
                    if p.exchange_short == ex_name:
                        bot_symbols.add(p.symbol)
                    if p.exchange_long == ex_name:
                        bot_symbols.add(p.symbol)
                orphaned = actual_symbols - bot_symbols
                missing = bot_symbols - actual_symbols
                if orphaned:
                    mismatches.append(f"{ex_name}: orphaned {orphaned}")
                if missing:
                    mismatches.append(f"{ex_name}: missing {missing}")
            except Exception as e:
                log.warning(f"Reconciliation failed for {ex_name}: {e}")
        if mismatches:
            log.warning(f"RECONCILIATION MISMATCH: {mismatches}")
            self.reconciliation_paused = True
            log.warning("Trading PAUSED due to reconciliation mismatch — resolve manually")
        else:
            if self.reconciliation_paused:
                log.info("Reconciliation clear — resuming trading")
            self.reconciliation_paused = False
        return mismatches


# ===========================================================================
# Trade Execution Engine
# ===========================================================================

class TradeExecutor:
    """Handles opening and closing live positions with retry escalation."""

    def __init__(self, executors: Dict[str, ExchangeExecutor],
                 portfolio: Portfolio, risk_mgr: RiskManager):
        self.executors = executors
        self.portfolio = portfolio
        self.risk_mgr = risk_mgr
        self.order_audit_log: List[dict] = []

    def _log_order(self, result: OrderResult, action: str, position_id: int):
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
        if len(self.order_audit_log) > 1000:
            self.order_audit_log = self.order_audit_log[-1000:]

    async def open_position(self, symbol: str, q_high: PriceQuote, q_low: PriceQuote,
                            spread_pct: float, size_usd: float,
                            session: aiohttp.ClientSession) -> Optional[LivePosition]:
        size_usd = min(size_usd, MAX_POSITION_USD)
        ex_short = self.executors.get(q_high.exchange)
        ex_long = self.executors.get(q_low.exchange)
        if not ex_short or not ex_long:
            return None

        pos_id = self.portfolio.next_id
        self.portfolio.next_id += 1
        log.info(f"EXEC ENTRY #{pos_id} {symbol}: SHORT {q_high.exchange} / LONG {q_low.exchange} "
                 f"spread={spread_pct:.3f}% size=${size_usd:.2f}")

        result_short, result_long = await asyncio.gather(
            ex_short.place_market_order(symbol, "sell", size_usd),
            ex_long.place_market_order(symbol, "buy", size_usd),
        )
        self._log_order(result_short, "entry_short", pos_id)
        self._log_order(result_long, "entry_long", pos_id)

        # Both filled
        if result_short.success and result_long.success:
            actual_size = min(result_short.filled_usd, result_long.filled_usd)
            if actual_size < 5:
                log.warning(f"ENTRY #{pos_id} filled too small: ${actual_size:.2f}")
                await self._emergency_close_leg(ex_short, symbol, "buy", result_short.filled_usd, pos_id)
                await self._emergency_close_leg(ex_long, symbol, "sell", result_long.filled_usd, pos_id)
                return None
            # Use actual fill prices, or market quotes as fallback (DRY_RUN returns 0)
            fill_price_short = result_short.fill_price if result_short.fill_price > 0 else q_high.bid
            fill_price_long = result_long.fill_price if result_long.fill_price > 0 else q_low.ask
            pos = LivePosition(
                id=pos_id, symbol=symbol,
                exchange_short=q_high.exchange, exchange_long=q_low.exchange,
                instrument_short=q_high.instrument, instrument_long=q_low.instrument,
                entry_spread_pct=spread_pct,
                entry_price_short=fill_price_short,
                entry_price_long=fill_price_long,
                size_usd=actual_size,
                entry_time=datetime.now(timezone.utc),
                order_id_short=result_short.order_id,
                order_id_long=result_long.order_id,
                entry_fees_usd=result_short.fees_usd + result_long.fees_usd,
            )
            self.portfolio.positions.append(pos)
            self.portfolio.total_trades += 1
            log.info(f"OPEN #{pos_id} {symbol} spread={spread_pct:.3f}% size=${actual_size:.2f} "
                     f"latency={result_short.latency_ms:.0f}ms/{result_long.latency_ms:.0f}ms")
            return pos

        # One filled, one failed — emergency close
        if result_short.success and not result_long.success:
            log.warning(f"ENTRY #{pos_id} LEG FAILURE: short filled, long failed ({result_long.error})")
            await self._emergency_close_leg(ex_short, symbol, "buy", result_short.filled_usd, pos_id)
            return None
        if result_long.success and not result_short.success:
            log.warning(f"ENTRY #{pos_id} LEG FAILURE: long filled, short failed ({result_short.error})")
            await self._emergency_close_leg(ex_long, symbol, "sell", result_long.filled_usd, pos_id)
            return None

        # Both failed
        log.warning(f"ENTRY #{pos_id} BOTH FAILED: {result_short.error} / {result_long.error}")
        return None

    async def _emergency_close_leg(self, executor: ExchangeExecutor, symbol: str,
                                    side: str, size_usd: float, pos_id: int):
        for attempt in range(6):
            delay = [1, 2, 5, 10, 10, 10][attempt]
            result = await executor.place_market_order(symbol, side, size_usd)
            self._log_order(result, f"emergency_close_{attempt+1}", pos_id)
            if result.success:
                log.info(f"EMERGENCY CLOSE #{pos_id} succeeded on attempt {attempt+1}")
                return
            log.warning(f"EMERGENCY CLOSE #{pos_id} attempt {attempt+1} failed: {result.error}")
            await asyncio.sleep(delay)
        # After 6 fast retries failed, create a DEGRADED position so
        # retry_degraded_positions picks it up indefinitely (every 30s).
        log.critical(f"EMERGENCY CLOSE #{pos_id} FAILED after 6 attempts — creating DEGRADED position for retry")
        degraded_leg = "short" if side == "buy" else "long"
        fallback_pos = LivePosition(
            id=pos_id, symbol=symbol,
            exchange_short=executor.name if side == "buy" else "",
            exchange_long=executor.name if side == "sell" else "",
            instrument_short="PERP", instrument_long="PERP",
            entry_spread_pct=0.0, entry_price_short=0.0, entry_price_long=0.0,
            size_usd=size_usd,
            entry_time=datetime.now(timezone.utc),
            status="DEGRADED",
            degraded_leg=degraded_leg,
            close_retry_count=6,
            last_close_attempt=time.time(),
        )
        self.portfolio.positions.append(fallback_pos)

    async def close_position(self, pos: LivePosition, current_spread: float, reason: str,
                             q_short: Optional[PriceQuote] = None, q_long: Optional[PriceQuote] = None) -> bool:
        ex_short = self.executors.get(pos.exchange_short)
        ex_long = self.executors.get(pos.exchange_long)
        if not ex_short or not ex_long:
            return False

        pos.status = "CLOSING"
        log.info(f"EXEC EXIT #{pos.id} {pos.symbol}: reason={reason}")

        result_short, result_long = await asyncio.gather(
            ex_short.place_market_order(pos.symbol, "buy", pos.size_usd),
            ex_long.place_market_order(pos.symbol, "sell", pos.size_usd),
        )
        self._log_order(result_short, "exit_short", pos.id)
        self._log_order(result_long, "exit_long", pos.id)

        if result_short.success and result_long.success:
            # Use market quotes as fallback when fill_price is 0 (DRY_RUN)
            if result_short.fill_price <= 0 and q_short:
                result_short = OrderResult(
                    result_short.success, result_short.order_id, result_short.exchange,
                    result_short.symbol, result_short.side, result_short.size_usd,
                    result_short.filled_usd, q_short.ask, result_short.fees_usd,
                    result_short.timestamp, result_short.latency_ms, result_short.error)
            if result_long.fill_price <= 0 and q_long:
                result_long = OrderResult(
                    result_long.success, result_long.order_id, result_long.exchange,
                    result_long.symbol, result_long.side, result_long.size_usd,
                    result_long.filled_usd, q_long.bid, result_long.fees_usd,
                    result_long.timestamp, result_long.latency_ms, result_long.error)
            self._finalize_close(pos, result_short, result_long, current_spread, reason)
            return True

        # Handle partial failure — enter degraded state
        if not result_short.success:
            pos.status = "DEGRADED"
            pos.degraded_leg = "short"
            pos.close_retry_count = 1
            pos.last_close_attempt = time.time()
        if not result_long.success:
            pos.status = "DEGRADED"
            pos.degraded_leg = "long" if result_short.success else "both"
            pos.close_retry_count = 1
            pos.last_close_attempt = time.time()

        if result_short.success:
            pos.exit_price_short = result_short.fill_price
            pos.order_id_close_short = result_short.order_id
        if result_long.success:
            pos.exit_price_long = result_long.fill_price
            pos.order_id_close_long = result_long.order_id
        return False

    async def retry_degraded_positions(self):
        # TODO: Add limit order fallback when executors support it. For v1,
        # market order retry is sufficient with $25 position sizes.
        for pos in self.portfolio.open_positions:
            if pos.status != "DEGRADED":
                continue
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
                        log.info(f"RECOVERED short leg #{pos.id}")

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
                        log.info(f"RECOVERED long leg #{pos.id}")

            if not pos.degraded_leg:
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
        pos.status = "CLOSED"
        pos.exit_time = datetime.now(timezone.utc)
        pos.exit_spread_pct = current_spread
        pos.exit_price_short = result_short.fill_price
        pos.exit_price_long = result_long.fill_price
        pos.exit_fees_usd = result_short.fees_usd + result_long.fees_usd
        pos.exit_reason = reason

        if pos.entry_price_short > 0 and pos.entry_price_long > 0:
            short_pnl = (pos.entry_price_short - pos.exit_price_short) / pos.entry_price_short
            long_pnl = (pos.exit_price_long - pos.entry_price_long) / pos.entry_price_long
            pos.gross_pnl_usd = (short_pnl + long_pnl) * pos.size_usd
        pos.net_pnl_usd = pos.gross_pnl_usd - pos.entry_fees_usd - pos.exit_fees_usd

        self.portfolio.cash += pos.net_pnl_usd
        self.portfolio.total_pnl_usd += pos.net_pnl_usd
        if pos.net_pnl_usd > 0:
            self.portfolio.total_wins += 1
        self.portfolio.closed_positions.append(pos)
        self.portfolio.positions.remove(pos)

        equity = self.portfolio.equity
        if equity > self.portfolio.peak_equity:
            self.portfolio.peak_equity = equity
        dd = (self.portfolio.peak_equity - equity) / self.portfolio.peak_equity * 100
        if dd > self.portfolio.max_drawdown_pct:
            self.portfolio.max_drawdown_pct = dd

        log.info(f"CLOSE #{pos.id} {pos.symbol} reason={reason} "
                 f"pnl=${pos.net_pnl_usd:+.4f} equity=${equity:.2f}")


# Convenience aliases used throughout strategy and Telegram code
BOT_TOKEN = TELEGRAM_BOT_TOKEN
CHAT_ID = TELEGRAM_CHAT_ID


# ===========================================================================
# Task 7: LiveTrader — Strategy Engine
# ===========================================================================

class LiveTrader:
    """Core strategy engine for live convergence arbitrage."""

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
        # Spread tracking
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
        self.data_dir = str(DATA_DIR)
        self.state_path = os.path.join(str(DATA_DIR), "real_state.json")
        self._load_state()

    # -- Canonical pair key --
    @staticmethod
    def _pair_key(symbol: str, ex_a: str, inst_a: str, ex_b: str, inst_b: str) -> str:
        a = f"{ex_a}|{inst_a}"
        b = f"{ex_b}|{inst_b}"
        pair = tuple(sorted([a, b]))
        return f"{symbol}:{pair[0]}:{pair[1]}"

    # -- Fee calculation --
    @staticmethod
    def compute_fees(ex_short: str, ex_long: str,
                     inst_short: str = "PERP", inst_long: str = "PERP") -> float:
        """Compute total round-trip taker fees for a pair of legs."""
        fee_map_short = SPOT_FEE if inst_short == "SPOT" else TAKER_FEE
        fee_map_long = SPOT_FEE if inst_long == "SPOT" else TAKER_FEE
        fee_short = fee_map_short.get(ex_short, 0.001)
        fee_long = fee_map_long.get(ex_long, 0.001)
        return fee_short + fee_long

    # -- Breakout guard --
    def update_symbol_spread(self, symbol: str, spread_pct: float):
        """Track the maximum spread seen for a symbol each tick."""
        readings = self.symbol_spread_readings.setdefault(symbol, [])
        if readings and len(readings) <= len(self.price_cache):
            readings[-1] = max(readings[-1], spread_pct)
        else:
            readings.append(spread_pct)
        if len(readings) > BREAKOUT_LOOKBACK:
            readings.pop(0)

    def is_breakout(self, symbol: str) -> bool:
        """Detect if a symbol is in a breakout pattern."""
        # Layer 1: Time-based blacklist
        bl_until = self.symbol_blacklist.get(symbol, 0)
        if bl_until > time.time():
            return True

        readings = self.symbol_spread_readings.get(symbol, [])
        if len(readings) < 3:
            return False

        # Layer 2: Gradual widening pattern
        if len(readings) >= 4:
            widenings = sum(1 for i in range(1, len(readings)) if readings[i] > readings[i - 1])
            ratio = widenings / (len(readings) - 1)
            drift = readings[-1] - readings[0]
            min_drift = readings[-1] * BREAKOUT_MIN_DRIFT_REL if readings[-1] > 0 else 0.15
            if ratio >= BREAKOUT_WIDEN_RATIO and drift >= min_drift:
                return True

        # Layer 3: Rapid spike
        recent = readings[-3:]
        if recent[0] > 0:
            spike_ratio = recent[-1] / recent[0]
            if spike_ratio >= 1.80 and recent[-1] > 2.0:
                return True

        return False

    # -- Symbol blacklist --
    def check_symbol_blacklist(self, symbol: str) -> bool:
        """Returns True if symbol is currently blacklisted."""
        bl_until = self.symbol_blacklist.get(symbol, 0)
        return bl_until > time.time()

    def update_symbol_blacklist(self, symbol: str, pnl_pct: float):
        """Blacklist a symbol after a loss exceeding threshold."""
        if pnl_pct < -0.10:  # Lost more than 0.10%
            self.symbol_blacklist[symbol] = time.time() + BREAKOUT_LOSS_MEMORY_HOURS * 3600
            log.info(f"BLACKLIST {symbol} for {BREAKOUT_LOSS_MEMORY_HOURS}h (pnl={pnl_pct:.3f}%)")

    # -- Dynamic exit threshold --
    def get_dynamic_exit_threshold(self, pair_key: str) -> float:
        """Return dynamic exit threshold based on rolling baseline spread."""
        if not DYNAMIC_EXIT_ENABLED:
            return EXIT_SPREAD_PCT
        bl = self.baseline_spreads.get(pair_key, [])
        if len(bl) < 10:
            return EXIT_SPREAD_PCT
        baseline = sum(bl) / len(bl)
        # Exit when spread drops below baseline (mean reversion target)
        return max(EXIT_SPREAD_PCT, baseline * 0.5)

    # -- Rolling spread baseline update --
    def update_baseline_spreads(self, pair_key: str, spread_pct: float) -> float:
        """Update rolling baseline spread and return current baseline."""
        if pair_key not in self.baseline_spreads:
            self.baseline_spreads[pair_key] = []
        bl = self.baseline_spreads[pair_key]
        bl.append(spread_pct)
        if len(bl) > BASELINE_SPREAD_WINDOW:
            bl.pop(0)
        return sum(bl) / len(bl) if bl else EXIT_SPREAD_PCT

    # -- Orderbook depth fetcher --
    async def fetch_orderbook_levels(self, session: aiohttp.ClientSession,
                                     exchange: str, symbol: str,
                                     instrument: str) -> Tuple[list, list]:
        """Fetch L2 orderbook levels. Checks WS cache first, falls back to REST.
        Returns (bids, asks) where each is [(price, usd_value), ...]."""
        # Try WS cache first
        ws_bids, ws_asks = _ob_ws.get_orderbook(exchange, symbol, instrument)
        if ws_bids is not None and ws_asks is not None:
            return ws_bids, ws_asks

        # Check empty cache to avoid repeated calls
        cache_key = f"{exchange}|{symbol}|{instrument}"
        if self.ob_empty_cache.get(cache_key, 0) > 0:
            self.ob_empty_cache[cache_key] -= 1
            return [], []

        # Fallback to REST
        try:
            base = symbol.replace("USDT", "")
            lim = OB_LEVELS_LIMIT

            if exchange == "OKX":
                if instrument == "PERP":
                    inst_id = f"{base}-USDT-SWAP"
                else:
                    inst_id = f"{base}-USDT"
                url = f"https://www.okx.com/api/v5/market/books?instId={inst_id}&sz={lim}"
            elif exchange == "Bybit":
                cat = "linear" if instrument == "PERP" else "spot"
                url = f"https://api.bybit.com/v5/market/orderbook?category={cat}&symbol={symbol}&limit={lim}"
            elif exchange == "MEXC":
                if instrument == "PERP":
                    url = f"https://contract.mexc.com/api/v1/contract/depth/{base}_USDT?limit={lim}"
                else:
                    url = f"https://api.mexc.com/api/v3/depth?symbol={symbol}&limit={lim}"
            elif exchange == "BloFin":
                if instrument == "PERP":
                    inst_id = f"{base}-USDT"
                    url = f"https://openapi.blofin.com/api/v1/market/books?instId={inst_id}&sz={lim}"
                else:
                    return [], []
            else:
                return [], []

            data = await _get(session, url, timeout=5)
            if not data:
                self.ob_empty_cache[cache_key] = OB_EMPTY_CACHE_CYCLES
                return [], []

            # Parse bids/asks based on exchange format
            bids_raw = []
            asks_raw = []

            if exchange == "Bybit":
                bids_raw = data.get("result", {}).get("b", [])
                asks_raw = data.get("result", {}).get("a", [])
            elif exchange == "OKX":
                book = data.get("data", [{}])[0] if data.get("data") else {}
                bids_raw = book.get("bids", [])
                asks_raw = book.get("asks", [])
            elif exchange == "MEXC" and instrument == "PERP":
                book = data.get("data", {})
                bids_raw = book.get("bids", [])
                asks_raw = book.get("asks", [])
            elif exchange == "BloFin":
                book = data.get("data", [{}])[0] if data.get("data") else {}
                bids_raw = book.get("bids", [])
                asks_raw = book.get("asks", [])
            else:
                bids_raw = data.get("bids", [])
                asks_raw = data.get("asks", [])

            def parse_levels(raw):
                levels = []
                for entry in raw:
                    try:
                        if isinstance(entry, dict):
                            px = float(entry.get('p', entry.get('price', 0)))
                            qty = float(entry.get('s', entry.get('size', entry.get('qty', 0))))
                        elif isinstance(entry, (list, tuple)) and len(entry) >= 2:
                            px = float(entry[0])
                            qty = float(entry[1])
                        else:
                            continue
                        if px > 0 and qty > 0:
                            levels.append((px, px * qty))
                    except (ValueError, TypeError):
                        continue
                return levels

            bids = parse_levels(bids_raw)
            asks = parse_levels(asks_raw)

            if not bids and not asks:
                self.ob_empty_cache[cache_key] = OB_EMPTY_CACHE_CYCLES

            return bids, asks
        except Exception:
            return [], []

    # -- State persistence --
    def _pos_to_dict(self, pos: LivePosition) -> dict:
        """Serialize a LivePosition to a JSON-safe dict."""
        return {
            "id": pos.id, "symbol": pos.symbol, "status": pos.status,
            "exchange_short": pos.exchange_short, "exchange_long": pos.exchange_long,
            "instrument_short": pos.instrument_short, "instrument_long": pos.instrument_long,
            "entry_spread_pct": round(pos.entry_spread_pct, 4),
            "current_spread_pct": round(pos.current_spread_pct, 4),
            "peak_spread_pct": round(pos.peak_spread_pct, 4),
            "entry_price_short": pos.entry_price_short,
            "entry_price_long": pos.entry_price_long,
            "size_usd": round(pos.size_usd, 2),
            "entry_fees_usd": round(pos.entry_fees_usd, 4),
            "exit_fees_usd": round(pos.exit_fees_usd, 4),
            "gross_pnl_usd": round(pos.gross_pnl_usd, 4),
            "net_pnl_usd": round(pos.net_pnl_usd, 4),
            "entry_time": pos.entry_time.isoformat() if pos.entry_time else None,
            "exit_time": pos.exit_time.isoformat() if pos.exit_time else None,
            "exit_spread_pct": round(pos.exit_spread_pct, 4),
            "exit_price_short": pos.exit_price_short,
            "exit_price_long": pos.exit_price_long,
            "exit_reason": pos.exit_reason,
            "order_id_short": pos.order_id_short,
            "order_id_long": pos.order_id_long,
            "order_id_close_short": pos.order_id_close_short,
            "order_id_close_long": pos.order_id_close_long,
            "degraded_leg": pos.degraded_leg,
            "close_retry_count": pos.close_retry_count,
            "telegram_msg_id": pos.telegram_msg_id,
        }

    def _pos_from_dict(self, d: dict) -> LivePosition:
        """Deserialize a dict back to a LivePosition."""
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
            order_id_close_short=d.get("order_id_close_short", ""),
            order_id_close_long=d.get("order_id_close_long", ""),
            status=d.get("status", "OPEN"),
            degraded_leg=d.get("degraded_leg", ""),
            peak_spread_pct=d.get("peak_spread_pct", 0),
            current_spread_pct=d.get("current_spread_pct", 0),
            exit_time=exit_time,
            exit_spread_pct=d.get("exit_spread_pct", 0),
            exit_price_short=d.get("exit_price_short", 0),
            exit_price_long=d.get("exit_price_long", 0),
            exit_reason=d.get("exit_reason", ""),
            entry_fees_usd=d.get("entry_fees_usd", 0),
            exit_fees_usd=d.get("exit_fees_usd", 0),
            gross_pnl_usd=d.get("gross_pnl_usd", 0),
            net_pnl_usd=d.get("net_pnl_usd", 0),
            telegram_msg_id=d.get("telegram_msg_id"),
            close_retry_count=d.get("close_retry_count", 0),
        )

    def _save_state(self):
        """Persist full trader state to JSON."""
        p = self.portfolio
        state = {
            "cash": p.cash,
            "next_id": p.next_id,
            "total_trades": p.total_trades,
            "total_wins": p.total_wins,
            "total_pnl_usd": p.total_pnl_usd,
            "peak_equity": p.peak_equity,
            "max_drawdown_pct": p.max_drawdown_pct,
            "pair_stats": self.pair_stats,
            "equity_history": self.equity_history[-10000:],
            "open_positions": [self._pos_to_dict(pos) for pos in p.positions],
            "closed_positions": [self._pos_to_dict(pos) for pos in p.closed_positions[-200:]],
            "symbol_blacklist": {s: t for s, t in self.symbol_blacklist.items() if t > time.time()},
            "balance_cache": self.risk_mgr.balance_cache,
            "order_audit_log": self.trade_executor.order_audit_log[-200:],
            "dry_run": DRY_RUN,
            "kill_switch": self.risk_mgr.kill_switch_active,
            "saved_at": datetime.now(timezone.utc).isoformat(),
        }
        try:
            tmp = self.state_path + ".tmp"
            with open(tmp, "w") as f:
                json.dump(state, f)
            os.replace(tmp, self.state_path)
        except Exception as e:
            log.warning(f"Failed to save state: {e}")

    def _load_state(self):
        """Load trader state from JSON (survive restarts)."""
        try:
            with open(self.state_path, "r") as f:
                state = json.load(f)
            p = self.portfolio
            p.cash = state.get("cash", p.cash)
            p.next_id = state.get("next_id", p.next_id)
            p.total_trades = state.get("total_trades", 0)
            p.total_wins = state.get("total_wins", 0)
            p.total_pnl_usd = state.get("total_pnl_usd", 0.0)
            p.peak_equity = state.get("peak_equity", p.peak_equity)
            p.max_drawdown_pct = state.get("max_drawdown_pct", 0.0)
            self.pair_stats = state.get("pair_stats", {})
            self.equity_history = state.get("equity_history", [])
            self.symbol_blacklist = state.get("symbol_blacklist", {})
            # Restore open positions
            for d in state.get("open_positions", []):
                try:
                    pos = self._pos_from_dict(d)
                    if pos.status in ("OPEN", "CLOSING", "DEGRADED"):
                        p.positions.append(pos)
                except Exception as e:
                    log.warning(f"Failed to restore position {d.get('id')}: {e}")
            # Restore recent closed positions
            for d in state.get("closed_positions", []):
                try:
                    pos = self._pos_from_dict(d)
                    p.closed_positions.append(pos)
                except Exception:
                    pass
            log.info(f"State loaded: equity=${p.equity:.2f} trades={p.total_trades} "
                     f"open={len(p.open_positions)} pnl=${p.total_pnl_usd:+.2f}")
        except FileNotFoundError:
            log.info("No saved state found — starting fresh")
        except (json.JSONDecodeError, Exception) as e:
            log.warning(f"Failed to load state: {e} — starting fresh")

    # -- Helper: positions for symbol --
    def positions_for_symbol(self, symbol: str) -> int:
        return sum(1 for p in self.portfolio.open_positions if p.symbol == symbol)

    # -- Helper: check kill switch --
    def check_kill_switch(self) -> bool:
        """Returns True if trading should be halted due to drawdown."""
        p = self.portfolio
        if p.peak_equity > 0:
            dd = (p.peak_equity - p.equity) / p.peak_equity * 100
            if dd >= KILL_SWITCH_DRAWDOWN_PCT:
                return True
        return False


# ===========================================================================
# Task 8: Telegram Integration
# ===========================================================================

async def send_telegram(session: aiohttp.ClientSession, text: str,
                        reply_to: Optional[int] = None) -> Optional[int]:
    """Send a Telegram message. Returns message_id on success."""
    if not BOT_TOKEN or not CHAT_ID:
        return None
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    payload = {
        "chat_id": CHAT_ID,
        "text": text,
        "parse_mode": "Markdown",
        "disable_web_page_preview": True,
    }
    if reply_to:
        payload["reply_to_message_id"] = reply_to
    try:
        async with session.post(url, json=payload,
                                timeout=aiohttp.ClientTimeout(total=10)) as resp:
            if resp.status == 200:
                data = await resp.json()
                return data.get("result", {}).get("message_id")
    except Exception:
        pass
    return None


def exchange_link(exchange: str, symbol: str, instrument: str = "PERP") -> str:
    """Return a Markdown hyperlink to the exchange's trading page."""
    base = symbol.replace("USDT", "")
    pair = symbol
    if instrument == "SPOT":
        urls = {
            "OKX": f"https://www.okx.com/trade-spot/{base.lower()}-usdt",
            "Bybit": f"https://www.bybit.com/en/trade/spot/{pair}",
            "MEXC": f"https://www.mexc.com/exchange/{base}_USDT",
            "BloFin": f"https://blofin.com/spot/{base}-USDT",
        }
    else:
        urls = {
            "OKX": f"https://www.okx.com/trade-futures/{pair.lower()}",
            "Bybit": f"https://www.bybit.com/trade/usdt/{pair}",
            "MEXC": f"https://futures.mexc.com/exchange/{pair}",
            "BloFin": f"https://blofin.com/futures/{base}-USDT",
        }
    url = urls.get(exchange, "")
    return f"[{exchange}]({url})" if url else exchange


def format_live_open_msg(pos: LivePosition, portfolio: Portfolio) -> str:
    """Format a Telegram notification for an opened position."""
    short_link = exchange_link(pos.exchange_short, pos.symbol, pos.instrument_short)
    long_link = exchange_link(pos.exchange_long, pos.symbol, pos.instrument_long)
    mode = "DRY RUN" if DRY_RUN else "LIVE"
    lines = [
        f"*[{mode}] OPEN #{pos.id}* `{pos.symbol}`",
        f"SHORT {short_link} ({pos.instrument_short}) @ ${pos.entry_price_short:.4f}",
        f"LONG {long_link} ({pos.instrument_long}) @ ${pos.entry_price_long:.4f}",
        f"Spread: *{pos.entry_spread_pct:.3f}%*  |  Size: ${pos.size_usd:.2f}",
        f"Fees: ${pos.entry_fees_usd:.4f}",
        f"Open: {len(portfolio.open_positions)}/{MAX_CONCURRENT}  |  Equity: ${portfolio.equity:.2f}",
    ]
    return "\n".join(lines)


def format_live_close_msg(pos: LivePosition, portfolio: Portfolio) -> str:
    """Format a Telegram notification for a closed position."""
    hold_min = 0.0
    if pos.exit_time and pos.entry_time:
        hold_min = (pos.exit_time - pos.entry_time).total_seconds() / 60
    pnl_emoji = "+" if pos.net_pnl_usd >= 0 else ""
    mode = "DRY RUN" if DRY_RUN else "LIVE"
    wr = (portfolio.total_wins / portfolio.total_trades * 100) if portfolio.total_trades > 0 else 0
    lines = [
        f"*[{mode}] CLOSE #{pos.id}* `{pos.symbol}`  ({pos.exit_reason})",
        f"Entry spread: {pos.entry_spread_pct:.3f}%  ->  Exit: {pos.exit_spread_pct:.3f}%",
        f"P&L: *{pnl_emoji}${pos.net_pnl_usd:.4f}*  (gross ${pos.gross_pnl_usd:.4f})",
        f"Fees: ${pos.entry_fees_usd + pos.exit_fees_usd:.4f}  |  Hold: {hold_min:.1f}m",
        f"Equity: ${portfolio.equity:.2f}  |  Total P&L: ${portfolio.total_pnl_usd:+.2f}",
        f"Trades: {portfolio.total_trades}  |  WR: {wr:.1f}%  |  DD: {portfolio.max_drawdown_pct:.2f}%",
    ]
    return "\n".join(lines)


def _toggle_dry_run():
    """Toggle the global DRY_RUN flag."""
    global DRY_RUN
    DRY_RUN = not DRY_RUN


class TelegramCommandListener:
    """Polls Telegram for bot commands and dispatches them."""

    def __init__(self, trader: LiveTrader):
        self.trader = trader
        self.last_update_id = 0

    async def poll_commands(self, session: aiohttp.ClientSession):
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
        trader = self.trader
        portfolio = trader.portfolio

        if text == "/status":
            n_open = len(portfolio.open_positions)
            equity = portfolio.equity
            wr = (portfolio.total_wins / portfolio.total_trades * 100) if portfolio.total_trades > 0 else 0
            pos_lines = []
            for p in portfolio.open_positions:
                hold_min = (datetime.now(timezone.utc) - p.entry_time).total_seconds() / 60
                pos_lines.append(
                    f"  #{p.id} `{p.symbol}` {p.exchange_short}/{p.exchange_long} "
                    f"spread={p.current_spread_pct:.3f}% hold={hold_min:.1f}m pnl=${p.net_pnl_usd:+.4f}"
                )
            mode = "DRY RUN" if DRY_RUN else "LIVE"
            msg = (
                f"*[{mode}] Status*\n"
                f"Equity: ${equity:.2f}  |  P&L: ${portfolio.total_pnl_usd:+.2f}\n"
                f"Open: {n_open}/{MAX_CONCURRENT}  |  Trades: {portfolio.total_trades}  |  WR: {wr:.1f}%\n"
                f"DD: {portfolio.max_drawdown_pct:.2f}%  |  Running: {trader.running}\n"
            )
            if pos_lines:
                msg += "*Positions:*\n" + "\n".join(pos_lines)
            else:
                msg += "No open positions"
            await send_telegram(session, msg)

        elif text == "/stop":
            trader.running = False
            await send_telegram(session, "*STOP received* — shutting down after current cycle")

        elif text == "/start":
            trader.running = True
            trader.risk_mgr.manual_stop = False
            await send_telegram(session, "*START received* — trading resumed")

        elif text == "/dryrun":
            _toggle_dry_run()
            mode = "ON" if DRY_RUN else "OFF"
            await send_telegram(session, f"*DRY RUN toggled {mode}*")

        elif text == "/balance":
            lines = ["*Exchange Balances:*"]
            for ex_name, executor in trader.executors.items():
                try:
                    bal = await executor.get_balance()
                    avail = bal.get("available", 0)
                    frozen = bal.get("locked", 0)
                    health = "OK" if executor.healthy else "DEGRADED"
                    lines.append(f"  {ex_name}: ${avail:.2f} avail / ${frozen:.2f} frozen [{health}]")
                except Exception as e:
                    lines.append(f"  {ex_name}: ERROR ({e})")
            await send_telegram(session, "\n".join(lines))


# ===========================================================================
# Task 9: Main Loop
# ===========================================================================

async def main():
    """Main entry point — full trading loop with entry/exit scanning."""
    log_dir = str(DATA_DIR)

    mode = "DRY RUN" if DRY_RUN else "LIVE"
    log.info(f"=== Real Trader starting [{mode}] ===")
    log.info(f"Capital=${STARTING_CAPITAL} MaxPos=${MAX_CONCURRENT} "
             f"Entry={ENTRY_SPREAD_PCT}% Exit={EXIT_SPREAD_PCT}%")

    # -- Create aiohttp session --
    connector = aiohttp.TCPConnector(limit=100, ttl_dns_cache=300)
    session = aiohttp.ClientSession(connector=connector)

    try:
        # -- Create executors --
        executors = create_executors(session)
        if not executors:
            log.critical("No exchange executors configured — check API keys")
            await session.close()
            return
        log.info(f"Executors created: {list(executors.keys())}")

        # -- Test auth on all exchanges --
        for ex_name, executor in executors.items():
            try:
                bal = await executor.get_balance()
                avail = bal.get("available", 0)
                log.info(f"AUTH OK {ex_name}: ${avail:.2f} available")
            except Exception as e:
                log.warning(f"AUTH FAILED {ex_name}: {e}")

        # -- Create LiveTrader + TelegramCommandListener --
        trader = LiveTrader(executors)
        tg_listener = TelegramCommandListener(trader)

        # -- Discover symbols --
        symbols = await discover_symbols(session)
        trader.symbols_set = set(symbols)
        log.info(f"Discovered {len(symbols)} symbols across {len(executors)} exchanges")

        # -- Reconcile positions on startup --
        mismatches = await trader.risk_mgr.reconcile_positions(session)
        if mismatches:
            log.warning(f"Startup reconciliation: {mismatches}")

        # -- Refresh balances --
        await trader.risk_mgr.refresh_balances()

        # -- Start WS feeds --
        _exchange_ws.set_tracked_symbols(symbols)
        await _exchange_ws.start(session)
        await _ob_ws.start(session)
        _ob_ws.update_active_symbols(trader.symbols_set)

        # -- Refresh funding rates --
        await refresh_funding_rates(session)

        # -- Send startup Telegram --
        n_open = len(trader.portfolio.open_positions)
        startup_msg = (
            f"*Real Trader Started [{mode}]*\n"
            f"Exchanges: {', '.join(executors.keys())}\n"
            f"Symbols: {len(symbols)}\n"
            f"Equity: ${trader.portfolio.equity:.2f}\n"
            f"Open positions: {n_open}\n"
            f"Entry: {ENTRY_SPREAD_PCT}%  Exit: {EXIT_SPREAD_PCT}%"
        )
        await send_telegram(session, startup_msg)

        # -- Signal handlers for graceful shutdown --
        loop = asyncio.get_running_loop()

        def _signal_handler(sig):
            log.info(f"Received signal {sig} — initiating graceful shutdown")
            trader.running = False

        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, _signal_handler, sig)

        # -- Timing trackers --
        last_tg_poll = 0.0
        last_state_save = time.time()
        last_status_log = time.time()
        last_tg_status = time.time()
        last_funding_refresh = time.time()
        last_symbol_refresh = time.time()
        last_equity_append = 0.0
        heartbeat_path = os.path.join(log_dir, "heartbeat")

        # ============================
        # MAIN LOOP
        # ============================
        log.info("Entering main loop")
        while trader.running:
            cycle_start = time.time()
            try:
                # -- Heartbeat --
                try:
                    with open(heartbeat_path, "w") as f:
                        f.write(str(int(time.time())))
                except Exception:
                    pass

                # -- Poll Telegram commands every 5s --
                if time.time() - last_tg_poll >= 5:
                    await tg_listener.poll_commands(session)
                    last_tg_poll = time.time()

                # -- Refresh balances --
                await trader.risk_mgr.refresh_balances()

                # -- Retry degraded positions --
                await trader.trade_executor.retry_degraded_positions()

                # -- Refresh funding rates every 5 min --
                if time.time() - last_funding_refresh >= 300:
                    await refresh_funding_rates(session)
                    last_funding_refresh = time.time()

                # -- Refresh symbols every 30 min --
                if time.time() - last_symbol_refresh >= 1800:
                    new_symbols = await discover_symbols(session)
                    if new_symbols:
                        trader.symbols_set = set(new_symbols)
                        _ob_ws.update_active_symbols(trader.symbols_set)
                        _exchange_ws.set_tracked_symbols(new_symbols)
                        log.info(f"Symbol refresh: {len(new_symbols)} symbols")
                    last_symbol_refresh = time.time()

                # -- Fetch prices from all exchanges --
                fetch_results = await asyncio.gather(
                    *[f(session, trader.symbols_set) for f in BATCH_FETCHERS],
                    return_exceptions=True,
                )

                # Build price cache: symbol -> [PriceQuote, ...]
                by_symbol: Dict[str, List[PriceQuote]] = {}
                for result in fetch_results:
                    if isinstance(result, Exception):
                        continue
                    for q in result:
                        if q.symbol in trader.symbols_set and q.mid > 0:
                            by_symbol.setdefault(q.symbol, []).append(q)
                trader.price_cache = by_symbol

                # Track last quote time per exchange
                for quotes in by_symbol.values():
                    for q in quotes:
                        trader.last_quote_time[q.exchange] = time.time()

                # ---- CHECK EXITS on open positions ----
                for pos in list(trader.portfolio.open_positions):
                    if pos.status == "DEGRADED":
                        continue
                    quotes = by_symbol.get(pos.symbol, [])
                    if not quotes:
                        continue

                    # Find current prices for the short and long exchanges
                    q_short = None
                    q_long = None
                    for q in quotes:
                        if q.exchange == pos.exchange_short and q.instrument == pos.instrument_short:
                            q_short = q
                        if q.exchange == pos.exchange_long and q.instrument == pos.instrument_long:
                            q_long = q

                    if not q_short or not q_long:
                        continue

                    # Current spread: short_bid - long_ask (what we'd get exiting now)
                    if q_long.ask > 0:
                        current_spread = (q_short.bid - q_long.ask) / q_long.ask * 100
                    else:
                        continue

                    pos.current_spread_pct = current_spread
                    if current_spread > pos.peak_spread_pct:
                        pos.peak_spread_pct = current_spread

                    # Update unrealized P&L from current market prices
                    if pos.entry_price_short > 0 and pos.entry_price_long > 0:
                        short_pnl = (pos.entry_price_short - q_short.ask) / pos.entry_price_short
                        long_pnl = (q_long.bid - pos.entry_price_long) / pos.entry_price_long
                        pos.net_pnl_usd = (short_pnl + long_pnl) * pos.size_usd - pos.entry_fees_usd

                    # Update baseline
                    pair_key = trader._pair_key(pos.symbol, pos.exchange_short,
                                                pos.instrument_short, pos.exchange_long,
                                                pos.instrument_long)
                    trader.update_baseline_spreads(pair_key, current_spread)

                    # -- Exit conditions --
                    hold_minutes = (datetime.now(timezone.utc) - pos.entry_time).total_seconds() / 60
                    exit_reason = ""

                    # 1) Convergence exit
                    exit_threshold = trader.get_dynamic_exit_threshold(pair_key)
                    if current_spread <= exit_threshold:
                        exit_reason = "convergence"

                    # 2) Timeout exit
                    if not exit_reason and hold_minutes >= AGED_POSITION_FORCE_EXIT_MINUTES:
                        exit_reason = "timeout"

                    # 3) Dynamic exit (trailing stop on profit)
                    if not exit_reason and DYNAMIC_EXIT_ENABLED and pos.peak_spread_pct > pos.entry_spread_pct * 0.5:
                        profit_from_peak = pos.peak_spread_pct - current_spread
                        trail_trigger = pos.peak_spread_pct * DYNAMIC_EXIT_TRAIL_PCT
                        if profit_from_peak > trail_trigger and current_spread < pos.entry_spread_pct * DYNAMIC_EXIT_PROFIT_LOCK_PCT:
                            exit_reason = "dynamic_exit"

                    # 4) Aged position warning (Telegram only, no exit)
                    if not exit_reason and hold_minutes >= AGED_POSITION_WARN_MINUTES:
                        # Just log, don't exit yet
                        pass

                    if exit_reason:
                        success = await trader.trade_executor.close_position(
                            pos, current_spread, exit_reason,
                            q_short=q_short, q_long=q_long
                        )
                        if success:
                            # Update blacklist if loss
                            if pos.net_pnl_usd < 0 and pos.size_usd > 0:
                                pnl_pct = pos.net_pnl_usd / pos.size_usd * 100
                                trader.update_symbol_blacklist(pos.symbol, pnl_pct)
                            # Update pair stats
                            if pair_key not in trader.pair_stats:
                                trader.pair_stats[pair_key] = {"wins": 0, "losses": 0, "total_pnl": 0.0}
                            stats = trader.pair_stats[pair_key]
                            stats["total_pnl"] += pos.net_pnl_usd
                            if pos.net_pnl_usd > 0:
                                stats["wins"] += 1
                            else:
                                stats["losses"] += 1
                            # Send Telegram close notification
                            close_msg = format_live_close_msg(pos, trader.portfolio)
                            await send_telegram(session, close_msg, reply_to=pos.telegram_msg_id)

                # ---- CHECK KILL SWITCH ----
                if trader.check_kill_switch():
                    log.critical("KILL SWITCH — drawdown limit exceeded")
                    await trader.risk_mgr.trigger_kill_switch("drawdown_exceeded")
                    await send_telegram(session, "*KILL SWITCH ACTIVATED* — drawdown limit exceeded")
                    # Close all open positions immediately
                    for pos in list(trader.portfolio.open_positions):
                        await trader.trade_executor.close_position(pos, 0.0, "kill_switch")

                # ---- SCAN FOR ENTRY CANDIDATES ----
                can_trade, trade_reason = trader.risk_mgr.can_trade()
                candidates = []

                if can_trade and len(trader.portfolio.open_positions) < MAX_CONCURRENT:
                    for symbol, quotes in by_symbol.items():
                        if len(quotes) < 2:
                            continue
                        if symbol in DELISTED_SYMBOLS or symbol in BLOCKED_SYMBOLS:
                            continue
                        if trader.check_symbol_blacklist(symbol):
                            continue
                        if trader.positions_for_symbol(symbol) >= 1:
                            continue

                        # Check all pair combinations
                        for i in range(len(quotes)):
                            for j in range(len(quotes)):
                                if i == j:
                                    continue
                                q_high = quotes[i]
                                q_low = quotes[j]

                                # Skip if same exchange+instrument
                                if q_high.exchange == q_low.exchange and q_high.instrument == q_low.instrument:
                                    continue

                                # Skip disabled exchanges
                                if q_high.exchange in DISABLED_EXCHANGES or q_low.exchange in DISABLED_EXCHANGES:
                                    continue

                                # Spread: (high_ask - low_bid) / low_bid
                                # For entry: we sell at bid on high, buy at ask on low
                                if q_low.ask <= 0:
                                    continue
                                spread_pct = (q_high.bid - q_low.ask) / q_low.ask * 100

                                # Sanity check
                                if spread_pct > MAX_SANE_SPREAD_PCT or spread_pct < 0:
                                    continue

                                # Update spread tracking
                                pair_key = trader._pair_key(symbol, q_high.exchange,
                                                            q_high.instrument, q_low.exchange,
                                                            q_low.instrument)
                                trader.update_symbol_spread(symbol, spread_pct)
                                trader.update_baseline_spreads(pair_key, spread_pct)

                                # Compute fees
                                fees_pct = trader.compute_fees(
                                    q_high.exchange, q_low.exchange,
                                    q_high.instrument, q_low.instrument
                                ) * 100  # Convert to pct

                                # Entry threshold: spread must exceed fees + minimum profit
                                effective_threshold = max(ENTRY_SPREAD_PCT, fees_pct * 2.5)
                                if spread_pct < effective_threshold:
                                    continue

                                # Volume filter
                                min_vol = max(q_high.volume_24h_usd, q_low.volume_24h_usd)
                                if min_vol < MIN_VOLUME_USD:
                                    continue

                                # Breakout guard
                                if trader.is_breakout(symbol):
                                    continue

                                # Stale price filter
                                now_ts = time.time()
                                if (now_ts - q_high.timestamp.timestamp() > STALE_PRICE_SECONDS or
                                        now_ts - q_low.timestamp.timestamp() > STALE_PRICE_SECONDS):
                                    continue

                                # Check risk limits
                                size_usd = min(
                                    trader.portfolio.equity * POSITION_SIZE_PCT,
                                    MAX_POSITION_USD,
                                )
                                can_open, open_reason = trader.risk_mgr.can_open_position(
                                    q_high.exchange, q_low.exchange, size_usd
                                )
                                if not can_open:
                                    continue

                                # Score candidate by spread minus fees
                                score = spread_pct - fees_pct
                                # Pair preference: boost pairs with good history
                                ps = trader.pair_stats.get(pair_key, {})
                                if ps.get("wins", 0) > ps.get("losses", 0):
                                    score += 0.05  # Small boost for historically good pairs

                                candidates.append({
                                    "symbol": symbol,
                                    "q_high": q_high,
                                    "q_low": q_low,
                                    "spread_pct": spread_pct,
                                    "fees_pct": fees_pct,
                                    "size_usd": size_usd,
                                    "score": score,
                                    "pair_key": pair_key,
                                })

                # ---- EXECUTE TOP CANDIDATES ----
                if candidates:
                    candidates.sort(key=lambda c: c["score"], reverse=True)
                    # Deduplicate by symbol (only one entry per symbol)
                    seen_symbols = set()
                    for cand in candidates:
                        if cand["symbol"] in seen_symbols:
                            continue
                        if len(trader.portfolio.open_positions) >= MAX_CONCURRENT:
                            break

                        seen_symbols.add(cand["symbol"])
                        log.info(
                            f"CANDIDATE {cand['symbol']} "
                            f"{cand['q_high'].exchange}/{cand['q_high'].instrument} -> "
                            f"{cand['q_low'].exchange}/{cand['q_low'].instrument} "
                            f"spread={cand['spread_pct']:.3f}% fees={cand['fees_pct']:.3f}% "
                            f"score={cand['score']:.3f}"
                        )

                        pos = await trader.trade_executor.open_position(
                            cand["symbol"], cand["q_high"], cand["q_low"],
                            cand["spread_pct"], cand["size_usd"], session,
                        )
                        if pos:
                            open_msg = format_live_open_msg(pos, trader.portfolio)
                            msg_id = await send_telegram(session, open_msg)
                            pos.telegram_msg_id = msg_id

                # ---- RECONCILIATION ----
                mismatches = await trader.risk_mgr.reconcile_positions(session)
                if mismatches:
                    await send_telegram(session,
                                        f"*RECONCILIATION ALERT*\n{chr(10).join(mismatches)}")

                # ---- SAVE STATE every 30s ----
                if time.time() - last_state_save >= 30:
                    trader._save_state()
                    last_state_save = time.time()

                # ---- STATUS LOG every 5 min ----
                if time.time() - last_status_log >= 300:
                    p = trader.portfolio
                    n_open = len(p.open_positions)
                    log.info(
                        f"STATUS equity=${p.equity:.2f} pnl=${p.total_pnl_usd:+.2f} "
                        f"open={n_open} trades={p.total_trades} "
                        f"wins={p.total_wins} dd={p.max_drawdown_pct:.2f}%"
                    )
                    last_status_log = time.time()

                # ---- TELEGRAM STATUS every 30 min ----
                if time.time() - last_tg_status >= 1800:
                    p = trader.portfolio
                    n_open = len(p.open_positions)
                    wr = (p.total_wins / p.total_trades * 100) if p.total_trades > 0 else 0
                    status_msg = (
                        f"*Heartbeat [{mode}]*\n"
                        f"Equity: ${p.equity:.2f}  |  P&L: ${p.total_pnl_usd:+.2f}\n"
                        f"Open: {n_open}/{MAX_CONCURRENT}  |  Trades: {p.total_trades}  |  WR: {wr:.1f}%\n"
                        f"DD: {p.max_drawdown_pct:.2f}%  |  Prices: {len(by_symbol)} symbols"
                    )
                    await send_telegram(session, status_msg)
                    last_tg_status = time.time()

                # ---- EQUITY HISTORY (throttled to every 30s) ----
                if time.time() - last_equity_append >= 30:
                    now = datetime.now(timezone.utc)
                    trader.equity_history.append({
                        "t": now.isoformat(),
                        "v": round(trader.portfolio.equity, 2),
                    })
                    if len(trader.equity_history) > 10000:
                        trader.equity_history = trader.equity_history[-10000:]
                    last_equity_append = time.time()

                # Update peak equity
                equity = trader.portfolio.equity
                if equity > trader.portfolio.peak_equity:
                    trader.portfolio.peak_equity = equity

            except Exception as e:
                log.error(f"Main loop error: {e}", exc_info=True)

            # ---- ADAPTIVE SLEEP ----
            cycle_time = time.time() - cycle_start
            if trader.portfolio.open_positions:
                sleep_time = max(0, POLL_INTERVAL_FAST - cycle_time)
            else:
                sleep_time = max(0, POLL_INTERVAL_SLOW - cycle_time)
            if sleep_time > 0:
                await asyncio.sleep(sleep_time)

        # ============================
        # GRACEFUL SHUTDOWN
        # ============================
        log.info("Graceful shutdown initiated")
        await send_telegram(session, "*Shutting down...* Closing all positions")

        # Close all open positions
        for pos in list(trader.portfolio.open_positions):
            if pos.status == "CLOSED":
                continue
            log.info(f"Shutdown: closing #{pos.id} {pos.symbol}")
            success = await trader.trade_executor.close_position(pos, 0.0, "shutdown")
            if success:
                close_msg = format_live_close_msg(pos, trader.portfolio)
                await send_telegram(session, close_msg, reply_to=pos.telegram_msg_id)

        # Save final state
        trader._save_state()

        # Stop WS feeds
        await _exchange_ws.stop()
        await _ob_ws.stop()

        # Final Telegram
        p = trader.portfolio
        final_msg = (
            f"*Real Trader Stopped*\n"
            f"Final equity: ${p.equity:.2f}\n"
            f"Total P&L: ${p.total_pnl_usd:+.2f}\n"
            f"Trades: {p.total_trades}  |  DD: {p.max_drawdown_pct:.2f}%"
        )
        await send_telegram(session, final_msg)
        log.info("Shutdown complete")

    finally:
        await session.close()


if __name__ == "__main__":
    asyncio.run(main())
