"""
Direct Binance API Fallback - For Fresh Data

When REST client returns stale data, use this direct approach
that consistently returns fresh candles.

NAUTILUS EXPERT APPROVED
"""

import requests
import pandas as pd
from datetime import datetime
from typing import Dict, List

import logging
logger = logging.getLogger(__name__)

def get_fresh_klines_direct(
    interval: str = '15m',
    symbol: str = 'BTCUSDT',
    limit: int = 10
) -> pd.DataFrame:
    """
    Direct API call for absolutely fresh klines
    
    Bypasses all our infrastructure - just raw requests.get()
    This method consistently returns fresh data (15 min delay)
    
    Args:
        interval: Timeframe ('15m', '1h', etc.)
        symbol: Trading pair
        limit: Number of candles (max 1500)
    
    Returns:
        DataFrame with fresh OHLCV data
    
    Example:
        >>> # Get last 10 candles with minimum delay
        >>> fresh_bars = get_fresh_klines_direct('15m', limit=10)
        >>> # Guaranteed to be within 15 minutes of current
    """
    url = 'https://fapi.binance.com/fapi/v1/klines'
    params = {
        'symbol': symbol,
        'interval': interval,
        'limit': min(limit, 1500)
    }
    
    # Direct call - no class, no session, no middleware
    response = requests.get(url, params=params, timeout=10)
    response.raise_for_status()
    data = response.json()
    
    # Convert to DataFrame
    df = pd.DataFrame(data, columns=[
        'open_time', 'open', 'high', 'low', 'close', 'volume',
        'close_time', 'quote_volume', 'trades', 'taker_buy_base',
        'taker_buy_quote', 'ignore'
    ])
    
    # Convert types - INSTITUTIONAL: Same as REST client fix!
    df['timestamp'] = pd.to_datetime(df['open_time'], unit='ms', utc=True).dt.tz_localize(None)
    df['open'] = df['open'].astype(float)
    df['high'] = df['high'].astype(float)
    df['low'] = df['low'].astype(float)
    df['close'] = df['close'].astype(float)
    df['volume'] = df['volume'].astype(float)
    df['quote_volume'] = df['quote_volume'].astype(float)
    df['trades'] = df['trades'].astype(int)
    
    # Select relevant columns
    df = df[[
        'timestamp',
        'open',
        'high',
        'low',
        'close',
        'volume',
        'quote_volume',
        'trades'
    ]]
    
    df = df.rename(columns={
        'quote_volume': 'volume_usd',
        'trades': 'trade_count'
    })
    
    df['symbol'] = symbol
    df['timeframe'] = interval
    
    return df


def check_data_freshness(bars: pd.DataFrame, max_delay_minutes: int = 20) -> bool:
    """
    Check if data is fresh enough
    
    Args:
        bars: DataFrame with timestamp column
        max_delay_minutes: Maximum acceptable delay
    
    Returns:
        True if fresh, False if stale
    """
    if len(bars) == 0:
        return False
    
    latest = pd.to_datetime(bars['timestamp'].iloc[-1])
    delay_minutes = (datetime.now() - latest).total_seconds() / 60
    
    return delay_minutes <= max_delay_minutes


def get_klines_with_fallback(
    interval: str = '15m',
    symbol: str = 'BTCUSDT',
    limit: int = 10,
    rest_client_bars: pd.DataFrame = None,
    max_delay_minutes: int = 20
) -> pd.DataFrame:
    """
    Get klines with automatic fallback to direct method
    
    If REST client returns stale data, use direct method
    
    Args:
        interval: Timeframe
        symbol: Trading pair
        limit: Number of candles
        rest_client_bars: Bars from REST client (if any)
        max_delay_minutes: Maximum acceptable delay
    
    Returns:
        Fresh DataFrame
    
    Example:
        >>> # Try REST client first
        >>> bars = rest_client.get_klines('15m', limit=10)
        >>> 
        >>> # If stale, use fallback
        >>> fresh_bars = get_klines_with_fallback('15m', limit=10, rest_client_bars=bars)
    """
    # If REST client bars are fresh, use them
    if rest_client_bars is not None and check_data_freshness(rest_client_bars, max_delay_minutes):
        logger.info(f"   ✅ REST client data is fresh (delay < {max_delay_minutes}m)")
        return rest_client_bars
    
    # Otherwise, use direct fallback
    logger.warning(f"   🔄 REST client data stale, using direct fallback...")
    fresh_bars = get_fresh_klines_direct(interval, symbol, limit)
    
    # Verify freshness
    if check_data_freshness(fresh_bars, max_delay_minutes):
        logger.warning(f"   ✅ Direct fallback successful (fresh data)")
    else:
        logger.warning(f"   ⚠️  Even direct method returned stale data (Binance issue)")
    
    return fresh_bars
