# DATA MANAGER CONFIGURATION
# Institutional-Grade Configuration with Secure Credential Management

from pathlib import Path
import os
from dotenv import load_dotenv

import logging
logger = logging.getLogger(__name__)


# Load environment variables from .env file
load_dotenv()

# ============================================================================
# PATHS
# ============================================================================

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
DATA_ROOT = PROJECT_ROOT / "data"
RAW_DATA_DIR = DATA_ROOT / "raw"
CATALOG_DIR = DATA_ROOT / "catalog"

# Ensure critical directories exist
RAW_DATA_DIR.mkdir(parents=True, exist_ok=True)
CATALOG_DIR.mkdir(parents=True, exist_ok=True)

# ============================================================================
# LAKEAPI CONFIGURATION (SECURE - NEVER HARDCODE!)
# ============================================================================

LAKEAPI_KEY = os.getenv('LAKEAPI_KEY')
LAKEAPI_SECRET = os.getenv('LAKEAPI_SECRET')
LAKEAPI_REGION = os.getenv('LAKEAPI_REGION', 'eu-west-1')
LAKEAPI_LIMIT_GB = int(os.getenv('LAKEAPI_LIMIT_GB', '300'))
LAKEAPI_WARNING_GB = int(LAKEAPI_LIMIT_GB * 0.93)  # 93% of limit (280GB)

# Cache directory for LakeAPI downloads
LAKE_CACHE_DIR = PROJECT_ROOT / "scripts" / "LakeAPI" / ".lake_cache"
LAKE_CACHE_DIR.mkdir(parents=True, exist_ok=True)

# Store credential validation for later (validated when LakeAPIClient is created)
CREDENTIALS_AVAILABLE = bool(LAKEAPI_KEY and LAKEAPI_SECRET)

if not CREDENTIALS_AVAILABLE:
    import warnings
    warnings.warn(
        "⚠️  LakeAPI credentials not found in .env file!\n"
        "   You won't be able to download data until credentials are configured.\n"
        "   Create .env in project root with:\n"
        "     LAKEAPI_KEY=your_access_key_here\n"
        "     LAKEAPI_SECRET=your_secret_key_here\n"
        "\n"
        "   NEVER commit .env to git! It's already in .gitignore",
        UserWarning
    )

# ============================================================================
# MULTICORE CONFIGURATION
# ============================================================================

import multiprocessing

TOTAL_CORES = multiprocessing.cpu_count()
SYSTEM_RESERVED_CORES = 2
_raw = os.getenv('MULTICORE_WORKERS', '').strip()
NUM_CORES = min(int(_raw) if _raw.isdigit() else (TOTAL_CORES - SYSTEM_RESERVED_CORES), 30)

logger.info(f"⚙️  Multicore Config: Using {NUM_CORES} cores (Total: {TOTAL_CORES}, Reserved: {SYSTEM_RESERVED_CORES})")

# ============================================================================
# TIMEFRAMES
# ============================================================================

TIMEFRAMES = ['5min', '15min', '30min', '1h', '2h', '4h', '6h', '12h', '1d']
PRIMARY_TIMEFRAME = '15min'  # Most common for building blocks

# Timeframe to pandas resample mapping
TIMEFRAME_MAPPING = {
    '5min': '5T',
    '15min': '15T',
    '30min': '30T',
    '1h': '1H',
    '2h': '2H',
    '4h': '4H',
    '6h': '6H',
    '12h': '12H',
    '1d': '1D'
}

# ============================================================================
# DATA TYPES
# ============================================================================

DATA_TYPES = ['trades', 'liquidations', 'funding', 'open_interest', 'orderbook']

# Data type to LakeAPI table mapping
LAKEAPI_TABLE_MAPPING = {
    'trades': 'trades',  # Note: plural form!
    'liquidations': 'liquidations',
    'funding': 'funding',
    'open_interest': 'open_interest',
    'orderbook': 'book'  # Note: singular form!
}

# Exchange and symbol per data type
# CRITICAL: Futures data uses BINANCE_FUTURES and BTC-USDT-PERP!
LAKEAPI_EXCHANGE_MAPPING = {
    'trades': 'BINANCE',
    'orderbook': 'BINANCE',
    'liquidations': 'BINANCE_FUTURES',  # Futures exchange!
    'funding': 'BINANCE_FUTURES',  # Futures exchange!
    'open_interest': 'BINANCE_FUTURES'  # Futures exchange!
}

LAKEAPI_SYMBOL_MAPPING = {
    'trades': 'BTC-USDT',
    'orderbook': 'BTC-USDT',
    'liquidations': 'BTC-USDT-PERP',  # Perpetual symbol!
    'funding': 'BTC-USDT-PERP',  # Perpetual symbol!
    'open_interest': 'BTC-USDT-PERP'  # Perpetual symbol!
}

# ============================================================================
# VALIDATION CONFIGURATION
# ============================================================================

# Price sanity checks (BTC)
MIN_PRICE = 1000  # Minimum reasonable BTC price
MAX_PRICE = 500000  # Maximum reasonable BTC price (safety check)

# Volume sanity checks
MIN_VOLUME = 0.0  # Minimum volume (exclusive)
MAX_VOLUME = 10000.0  # Maximum single order volume (BTC)

# Time gap detection (multiples of expected interval)
MAX_TIME_GAP_MULTIPLIER = 2.0  # Flag gaps > 2x expected interval

# ============================================================================
# USAGE TRACKING
# ============================================================================

USAGE_TRACKING_FILE = RAW_DATA_DIR / ".lakeapi_usage.json"

# ============================================================================
# MONITORING & ALERTS
# ============================================================================

ENABLE_ALERTS = os.getenv('ENABLE_ALERTS', 'true').lower() == 'true'
ALERT_EMAIL = os.getenv('ALERT_EMAIL', '')

# ============================================================================
# PERFORMANCE TUNING
# ============================================================================

# Chunk sizes for large file processing
PARQUET_CHUNK_SIZE = 100000  # Rows per chunk
CSV_CHUNK_SIZE = 50000  # Rows per chunk

# Memory management
MEMORY_LIMIT_GB = int(os.getenv('MEMORY_LIMIT_GB', '16'))  # Per worker

# ============================================================================
# LOGGING
# ============================================================================

LOG_LEVEL = os.getenv('LOG_LEVEL', 'INFO')
LOG_DIR = PROJECT_ROOT / "logs"
LOG_DIR.mkdir(exist_ok=True)

# ============================================================================
# CONFIGURATION SUMMARY
# ============================================================================

def print_config_summary():
    """Print configuration summary"""
    logger.info("\n" + "="*80)
    logger.info("DATA MANAGER CONFIGURATION")
    logger.info("="*80)
    logger.info(f"Project Root: {PROJECT_ROOT}")
    logger.info(f"Data Directory: {RAW_DATA_DIR}")
    logger.info(f"Catalog Directory: {CATALOG_DIR}")
    logger.info(f"LakeAPI Limit: {LAKEAPI_LIMIT_GB}GB (Warning: {LAKEAPI_WARNING_GB}GB)")
    logger.info(f"Multicore Workers: {NUM_CORES} cores")
    logger.info(f"Timeframes: {', '.join(TIMEFRAMES)}")
    logger.info(f"Data Types: {', '.join(DATA_TYPES)}")
    logger.info(f"Alerts Enabled: {ENABLE_ALERTS}")
    logger.info("="*80 + "\n")

if __name__ == "__main__":
    print_config_summary()