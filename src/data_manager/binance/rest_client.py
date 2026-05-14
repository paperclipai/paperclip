"""
Binance REST API Client - Real-time market data (FREE!)

Provides direct access to Binance for:
- Recent trades (< 48 hours)
- Candlestick data (OHLCV bars)
- Funding rates (perpetual futures)
- Orderbook snapshots
- Current prices

Advantages over LakeAPI:
- FREE (no costs, no limits)
- Real-time (zero lag)
- Higher rate limits (1200 req/min)
- Perfect for live/paper trading
"""

import requests
import pandas as pd
from datetime import datetime, timedelta, timezone
from typing import Optional, List, Dict, Union
import time
from pathlib import Path

import logging
logger = logging.getLogger(__name__)

# Binance API endpoints (no authentication needed for market data!)
BINANCE_SPOT_BASE = "https://api.binance.com"
BINANCE_FUTURES_BASE = "https://fapi.binance.com"


class BinanceRestClient:
    """
    Binance REST API client for real-time market data
    
    Features:
    - No authentication needed for market data
    - FREE & unlimited access
    - Rate limits: 1200 requests/minute (generous!)
    - Zero lag data
    - Perfect for live trading
    
    Example:
        >>> client = BinanceRestClient()
        >>> # Get last 1000 recent trades (last ~5-10 minutes)
        >>> trades = client.get_recent_trades(limit=1000)
        >>> # Get 15min candles for last 24 hours
        >>> candles = client.get_klines('15m', hours=24)
    """
    
    def __init__(self, use_testnet: bool = False):
        """
        Initialize Binance REST client
        
        Args:
            use_testnet: Use testnet instead of production (for testing)
        """
        self.spot_base = BINANCE_SPOT_BASE
        self.futures_base = BINANCE_FUTURES_BASE
        self.use_testnet = use_testnet
        
        # Rate limiting
        self.request_count = 0
        self.window_start = time.time()
        self.max_requests_per_minute = 1200
        
        logger.info(f"✅ Binance REST client initialized")
        logger.info(f"   Mode: {'Testnet' if use_testnet else 'Production'}")
        logger.info(f"   Rate limit: {self.max_requests_per_minute} req/min")
    
    def _check_rate_limit(self):
        """Check and enforce rate limiting"""
        current_time = time.time()
        
        # Reset counter every minute
        if current_time - self.window_start > 60:
            self.request_count = 0
            self.window_start = current_time
        
        # If approaching limit, wait
        if self.request_count >= self.max_requests_per_minute - 10:
            sleep_time = 60 - (current_time - self.window_start)
            if sleep_time > 0:
                logger.info(f"⏳ Rate limit approaching, waiting {sleep_time:.1f}s...")
                time.sleep(sleep_time)
                self.request_count = 0
                self.window_start = time.time()
        
        self.request_count += 1
    
    def _request(self, endpoint: str, params: Optional[Dict] = None, futures: bool = False) -> Dict:
        """
        Make API request with rate limiting
        
        INSTITUTIONAL: Force fresh connection every time!
        No session reuse, no connection pooling, no caching
        
        Args:
            endpoint: API endpoint
            params: Query parameters
            futures: Use futures API (default: spot)
        
        Returns:
            Response JSON
        """
        self._check_rate_limit()
        
        base_url = self.futures_base if futures else self.spot_base
        url = f"{base_url}{endpoint}"
        
        try:
            # INSTITUTIONAL: SIMPLEST POSSIBLE - just like direct test that works
            response = requests.get(url, params=params, timeout=10)
            response.raise_for_status()
            return response.json()
            
        except requests.exceptions.RequestException as e:
            logger.error(f"❌ Binance API error: {e}")
            raise
    
    def get_recent_trades(
        self,
        symbol: str = 'BTCUSDT',
        limit: int = 1000
    ) -> pd.DataFrame:
        """
        Get recent trades (most recent trades, typically last 5-10 minutes)
        
        Args:
            symbol: Trading pair (default: BTCUSDT)
            limit: Number of trades (max 1000)
        
        Returns:
            DataFrame with columns: [timestamp, price, quantity, side]
        
        Example:
            >>> client = BinanceRestClient()
            >>> trades = client.get_recent_trades(limit=1000)
            >>> len(trades)
            1000  # Last 1000 trades (~5-10 minutes)
        
        Note:
            This is perfect for real-time monitoring but limited to ~10 min history
        """
        logger.info(f"📥 Fetching {limit} recent trades from Binance...")
        
        response = self._request(
            '/api/v3/trades',
            params={'symbol': symbol, 'limit': min(limit, 1000)}
        )
        
        # Convert to DataFrame
        df = pd.DataFrame(response)
        
        # Rename columns
        df = df.rename(columns={
            'time': 'timestamp',
            'price': 'price',
            'qty': 'quantity',
            'isBuyerMaker': 'is_sell'
        })
        
        # Convert types
        df['timestamp'] = pd.to_datetime(df['timestamp'], unit='ms', utc=True)
        df['price'] = df['price'].astype(float)
        df['quantity'] = df['quantity'].astype(float)
        df['side'] = df['is_sell'].apply(lambda x: 'sell' if x else 'buy')
        
        # Select relevant columns
        df = df[['timestamp', 'price', 'quantity', 'side']]
        
        logger.info(f"✅ Received {len(df)} trades")
        logger.info(f"   Time range: {df['timestamp'].min()} to {df['timestamp'].max()}")
        
        return df
    
    def get_historical_trades(
        self,
        symbol: str = 'BTCUSDT',
        hours: int = 24,
        batch_size: int = 1000
    ) -> pd.DataFrame:
        """
        Get historical trades for last N hours (paginated requests)
        
        Args:
            symbol: Trading pair
            hours: Hours of history (max ~48-72 hours typically available)
            batch_size: Trades per request (max 1000)
        
        Returns:
            DataFrame with all trades in time range
        
        Example:
            >>> # Get last 24 hours of trades
            >>> trades = client.get_historical_trades(hours=24)
        
        Note:
            This uses multiple API calls to get more history
            Binance keeps ~48-72 hours of trade history accessible
        """
        logger.info(f"📥 Fetching last {hours} hours of trades...")
        
        all_trades = []
        from_id = None
        target_time = datetime.now(timezone.utc) - timedelta(hours=hours)
        
        while True:
            params = {'symbol': symbol, 'limit': batch_size}
            if from_id:
                params['fromId'] = from_id
            
            response = self._request('/api/v3/historicalTrades', params)
            
            if not response:
                break
            
            df_batch = pd.DataFrame(response)
            df_batch['timestamp'] = pd.to_datetime(df_batch['time'], unit='ms', utc=True)

            # Check if we've gone back far enough
            if df_batch['timestamp'].min() < target_time:
                df_batch = df_batch[df_batch['timestamp'] >= target_time]
                all_trades.append(df_batch)
                break
            
            all_trades.append(df_batch)
            from_id = response[0]['id']  # Get oldest trade ID for next batch
            
            logger.info(f"   Fetched batch: {len(df_batch)} trades, oldest: {df_batch['timestamp'].min()}")
          
            # Safety check
            if len(all_trades) > 100:  # Max 100 batches = 100k trades
                logger.warning("⚠️  Hit safety limit (100 batches)")
                break
        
        if not all_trades:
            raise ValueError("No trades found")
        
        # Combine all batches
        df = pd.concat(all_trades, ignore_index=True)
        
        # Process columns
        df = df.rename(columns={
            'time': 'timestamp_ms',
            'price': 'price',
            'qty': 'quantity',
            'isBuyerMaker': 'is_sell'
        })
        
        df['price'] = df['price'].astype(float)
        df['quantity'] = df['quantity'].astype(float)
        df['side'] = df['is_sell'].apply(lambda x: 'sell' if x else 'buy')
        
        df = df[['timestamp', 'price', 'quantity', 'side']].sort_values('timestamp')
        
        logger.info(f"✅ Total trades: {len(df):,}")
        logger.info(f"   Time span: {df['timestamp'].min()} to {df['timestamp'].max()}")
        
        return df
    
    def get_klines(
        self,
        interval: str = '15m',
        symbol: str = 'BTCUSDT',
        limit: int = 1000,
        hours: Optional[int] = None,
        futures: bool = False,
        start_time: Optional[int] = None,
        end_time: Optional[int] = None,
    ) -> pd.DataFrame:
        """
        Get candlestick/kline data with AUTOMATIC FALLBACK to direct method
        
        INSTITUTIONAL: If initial request returns stale data (>20 min delay),
        automatically uses direct fallback for fresh data.
        
        Args:
            interval: Timeframe ('1m', '5m', '15m', '1h', '4h', '1d')
            symbol: Trading pair (BTCUSDT for futures perpetuals)
            limit: Number of candles (max 1500)
            hours: Alternative: specify hours of history
            futures: Use futures API (default: False for spot)
            start_time: Start time in milliseconds since epoch (overrides hours)
            end_time: End time in milliseconds since epoch (overrides hours)
        
        Returns:
            DataFrame with OHLCV data (guaranteed fresh < 20 min)
        
        Example:
            >>> # Automatically gets fresh data
            >>> candles = client.get_klines('15m', limit=1000, futures=True)
            >>> # If stale, uses direct fallback automatically
            >>> # Pagination with explicit start/end time (millisecond epoch)
            >>> candles = client.get_klines('15m', limit=1500, futures=True,
            ...     start_time=1735689600000, end_time=1735776000000)
        
        Note:
            For futures trading, fresh data is CRITICAL!
            This method ensures maximum freshness.
        """
        params = {'symbol': symbol, 'interval': interval, 'limit': min(limit, 1500)}
        
        if start_time is not None:
            params['startTime'] = start_time
            if end_time is not None:
                params['endTime'] = end_time
        elif hours:
            end_time_calc = datetime.now(timezone.utc)
            start_time_calc = end_time_calc - timedelta(hours=hours)
            params['startTime'] = int(start_time_calc.timestamp() * 1000)
            params['endTime'] = int(end_time_calc.timestamp() * 1000)
        
        endpoint = '/fapi/v1/klines' if futures else '/api/v3/klines'
        source = 'Binance Futures' if futures else 'Binance Spot'
        
        logger.info(f"📊 Fetching {interval} candles from {source}...")
        
        response = self._request(endpoint, params, futures=futures)

        # BTCAAAAA-25416: validate response is a list before DataFrame construction.
        # Binance may return a dict error payload on 200 for some error scenarios
        # (e.g. invalid symbol).  Treating a dict as a row would produce NaT/NaN.
        if not isinstance(response, list):
            if isinstance(response, dict) and "code" in response:
                logger.error(
                    "Binance klines API error: code=%s msg=%s",
                    response.get("code"), response.get("msg"),
                )
            else:
                logger.error(
                    "Binance klines returned unexpected type=%s: %s",
                    type(response).__name__, str(response)[:200],
                )
            return pd.DataFrame()

        # Convert to DataFrame
        df = pd.DataFrame(response, columns=[
            'open_time', 'open', 'high', 'low', 'close', 'volume',
            'close_time', 'quote_volume', 'trades', 'taker_buy_base',
            'taker_buy_quote', 'ignore'
        ])
        
        # Convert types - INSTITUTIONAL: Use exact same method as direct test!
        df['timestamp'] = pd.to_datetime(df['open_time'], unit='ms', utc=True).dt.tz_localize(None)
        df['open'] = df['open'].astype(float)
        df['high'] = df['high'].astype(float)
        df['low'] = df['low'].astype(float)
        df['close'] = df['close'].astype(float)
        df['volume'] = df['volume'].astype(float)
        df['quote_volume'] = df['quote_volume'].astype(float)
        df['trades'] = df['trades'].astype(int)
        
        # Select and rename columns
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
        
        logger.info(f"✅ Received {len(df)} candles")
        logger.info(f"   Time range: {df['timestamp'].min()} to {df['timestamp'].max()}")
        
        # INSTITUTIONAL: Check freshness and use fallback if stale
        if len(df) > 0 and start_time is None:
            latest = pd.to_datetime(df['timestamp'].iloc[-1])
            # timestamps are now UTC-naive; strip tzinfo for comparison so the
            # delay calculation is correct regardless of machine timezone.
            delay_minutes = (datetime.now(timezone.utc).replace(tzinfo=None) - latest).total_seconds() / 60

            # Per-interval stale thresholds — avoids false-positive stale warnings
            # for low-frequency bars (e.g. 1d) that are naturally hours old.
            _stale_thresholds = {"1m": 2, "5m": 6, "15m": 20, "1h": 65, "4h": 260, "1d": 1500}
            stale_threshold = _stale_thresholds.get(interval, 20)

            # If delay > threshold, use direct fallback
            if delay_minutes > stale_threshold:
                logger.warning(f"   ⚠️  Data stale ({delay_minutes:.0f} min delay)")
                logger.warning(f"   🔄 Using direct fallback for fresh data...")
                
                # Import and use direct fallback
                from .direct_fallback import get_fresh_klines_direct
                df_fresh = get_fresh_klines_direct(interval, symbol, limit)
                
                # Check if fallback is fresher
                if len(df_fresh) > 0:
                    fresh_latest = pd.to_datetime(df_fresh['timestamp'].iloc[-1], utc=True)
                    fresh_delay = (datetime.now(timezone.utc) - fresh_latest).total_seconds() / 60
                    
                    if fresh_delay < delay_minutes:
                        logger.info(f"   ✅ Fallback successful: {delay_minutes:.0f}m → {fresh_delay:.0f}m")
                        return df_fresh
                    else:
                        logger.warning(f"   ⚠️  Fallback also stale (Binance API issue)")
            else:
                logger.info(f"   ✅ Data fresh ({delay_minutes:.1f} min delay)")
        
        return df
    
    def get_funding_rate(
        self,
        symbol: str = 'BTCUSDT'
    ) -> Dict:
        """
        Get current funding rate for perpetual futures
        
        Args:
            symbol: Futures symbol
        
        Returns:
            Dict with funding rate info
        
        Example:
            >>> funding = client.get_funding_rate()
            >>> print(f"Current rate: {funding['fundingRate']}")
        """
        logger.info(f"💰 Fetching funding rate for {symbol}...")
        
        response = self._request(
            '/fapi/v1/premiumIndex',
            params={'symbol': symbol},
            futures=True
        )
        
        logger.info(f"✅ Funding rate: {float(response['lastFundingRate']):.6f}%")
        
        return {
            'symbol': response['symbol'],
            'funding_rate': float(response['lastFundingRate']),
            'funding_time': pd.to_datetime(response['nextFundingTime'], unit='ms'),
            'index_price': float(response['indexPrice']),
            'mark_price': float(response['markPrice'])
        }
    
    def get_funding_history(
        self,
        symbol: str = 'BTCUSDT',
        hours: int = 24
    ) -> pd.DataFrame:
        """
        Get historical funding rates
        
        Args:
            symbol: Futures symbol
            hours: Hours of history
        
        Returns:
            DataFrame with funding rate history
        """
        start_time = datetime.now(timezone.utc) - timedelta(hours=hours)
        
        response = self._request(
            '/fapi/v1/fundingRate',
            params={
                'symbol': symbol,
                'startTime': int(start_time.timestamp() * 1000),
                'limit': 1000
            },
            futures=True
        )
        
        df = pd.DataFrame(response)
        df['fundingTime'] = pd.to_datetime(df['fundingTime'], unit='ms')
        df['fundingRate'] = df['fundingRate'].astype(float)
        
        df = df.rename(columns={
            'fundingTime': 'timestamp',
            'fundingRate': 'funding_rate'
        })
        
        logger.info(f"✅ Received {len(df)} funding rate records")
        
        return df[['timestamp', 'symbol', 'funding_rate']]
    
    def get_orderbook(
        self,
        symbol: str = 'BTCUSDT',
        depth: int = 20
    ) -> Dict:
        """
        Get current orderbook snapshot
        
        Args:
            symbol: Trading pair
            depth: Number of levels (5, 10, 20, 50, 100, 500, 1000, 5000)
        
        Returns:
            Dict with bids and asks
        
        Example:
            >>> book = client.get_orderbook(depth=20)
            >>> best_bid = book['bids'][0]
            >>> best_ask = book['asks'][0]
        """
        response = self._request(
            '/api/v3/depth',
            params={'symbol': symbol, 'limit': depth}
        )
        
        bids_df = pd.DataFrame(response['bids'], columns=['price', 'quantity'])
        asks_df = pd.DataFrame(response['asks'], columns=['price', 'quantity'])
        
        bids_df['price'] = bids_df['price'].astype(float)
        bids_df['quantity'] = bids_df['quantity'].astype(float)
        asks_df['price'] = asks_df['price'].astype(float)
        asks_df['quantity'] = asks_df['quantity'].astype(float)
        
        return {
            'symbol': symbol,
            'timestamp': datetime.now(timezone.utc),
            'bids': bids_df,
            'asks': asks_df,
            'best_bid': float(response['bids'][0][0]),
            'best_ask': float(response['asks'][0][0]),
            'spread': float(response['asks'][0][0]) - float(response['bids'][0][0])
        }
    
    def get_ticker(
        self,
        symbol: str = 'BTCUSDT'
    ) -> Dict:
        """
        Get 24hr ticker statistics
        
        Args:
            symbol: Trading pair
        
        Returns:
            Dict with price, volume, and change statistics
        """
        response = self._request(
            '/api/v3/ticker/24hr',
            params={'symbol': symbol}
        )
        
        return {
            'symbol': response['symbol'],
            'price': float(response['lastPrice']),
            'change_24h': float(response['priceChange']),
            'change_percent_24h': float(response['priceChangePercent']),
            'high_24h': float(response['highPrice']),
            'low_24h': float(response['lowPrice']),
            'volume_24h': float(response['volume']),
            'quote_volume_24h': float(response['quoteVolume']),
            'trades_24h': int(response['count'])
        }


# Convenience functions
def get_recent_bars(
    timeframe: str = '15m',
    hours: int = 24,
    symbol: str = 'BTCUSDT'
) -> pd.DataFrame:
    """
    Quick function to get recent bars
    
    Args:
        timeframe: Bar timeframe ('1m', '5m', '15m', '1h', etc.)
        hours: Hours of history
        symbol: Trading pair
    
    Returns:
        DataFrame with OHLCV bars
    
    Example:
        >>> # Quick way to get last 24h of 15min bars
        >>> bars = get_recent_bars('15m', hours=24)
    """
    client = BinanceRestClient()
    return client.get_klines(timeframe, symbol=symbol, hours=hours)


def get_current_price(symbol: str = 'BTCUSDT') -> float:
    """
    Quick function to get current price
    
    Args:
        symbol: Trading pair
    
    Returns:
        Current price
    
    Example:
        >>> price = get_current_price()
        >>> print(f"BTC: ${price:,.2f}")
    """
    client = BinanceRestClient()
    ticker = client.get_ticker(symbol)
    return ticker['price']
