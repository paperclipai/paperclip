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

# Classes, functions, and main loop will be added in subsequent tasks.
