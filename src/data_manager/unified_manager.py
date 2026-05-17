"""
Unified Data Manager - Intelligent Data Source Routing

The brain of the data system. Automatically routes requests to:
- LakeAPI: Historical data (2024 + Dec 2025)
- Binance: Recent/current data (ongoing)
- Seamless combination for complete datasets

Features:
- Automatic source selection (smart routing)
- Gap detection and filling (startup + on-demand via verify_and_repair())
- 1000-bar warmup support
- Multi-timeframe support
- Caching for performance
- Error recovery with fallback

This is the ONLY interface strategies need to use!

Author: BTC_Engine_v3
Date: January 8, 2026

Gap detection / auto-repair added: 2026-05-02
  ROOT CAUSE NOTE (fast-download bug):
  The original backfill_december.py and daily_sync.py both fetched klines with
  `limit=1500` and NO startTime parameter.  Binance always returns the *latest*
  1500 bars when startTime is omitted, so pages 2-N of the pagination loop were
  identical to page 1.  The system stored only the most-recent window and
  silently skipped the offline period (Mar 12 – Apr 14 2026 ≈ 34 days).
  The download completed in seconds because only one real API call was made.

  Fix: _fetch_binance_range() now passes explicit startTime/endTime to every
  Binance klines request and paginates forward until the target window is
  completely covered.
"""

from pathlib import Path
from datetime import datetime, timedelta, timezone
from typing import Optional, List, Union, Dict, Tuple
import logging
import os
import re
import time as _time_mod
import threading
import pandas as pd
from enum import Enum

from .config import PROJECT_ROOT, RAW_DATA_DIR
from .processing.bar_aggregator import BarAggregator
from .binance.rest_client import BinanceRestClient

import logging
logger = logging.getLogger(__name__)


logger = logging.getLogger(__name__)

# Per-file write locks to prevent concurrent write races on the same parquet file.
# Key: absolute file path string → threading.Lock()
_parquet_write_locks: Dict[str, threading.Lock] = {}
_parquet_write_locks_mutex = threading.Lock()

# Binance API propagation buffer: after a candle closes, Binance takes 1–2 seconds
# to finalize and expose the bar via the REST API.  Using fetch_start = gap_start +
# bar_td *without* this buffer causes the repair cycle to fire before the bar is
# available, returning 0 bars and leaving the gap unrepaired until the next cycle.
BINANCE_PROPAGATION_BUFFER = timedelta(seconds=2)


def _get_parquet_lock(file_path: Path) -> threading.Lock:
    """Return (creating if needed) the per-file write lock for *file_path*."""
    key = str(file_path.resolve())
    with _parquet_write_locks_mutex:
        if key not in _parquet_write_locks:
            _parquet_write_locks[key] = threading.Lock()
        return _parquet_write_locks[key]


class DataSource(Enum):
    """Data source options"""
    LAKEAPI = "lakeapi"
    BINANCE = "binance"
    AUTO = "auto"


class UnifiedDataManager:
    """
    Unified data manager - One interface for all data needs
    
    Intelligent routing:
    - Historical (>30 days): LakeAPI (cached, complete)
    - Recent (<30 days): Binance (real-time, free)
    - Seamless: Combines both sources automatically
    
    Example:
        >>> manager = UnifiedDataManager()
        >>> 
        >>> # Get last 1000 bars (for strategy warmup)
        >>> bars = manager.get_bars(timeframe='15m', count=1000)
        >>> # Automatically uses: LakeAPI + Binance combined!
        >>> 
        >>> # Get specific date range
        >>> bars = manager.get_bars(
        ...     timeframe='15m',
        ...     start_date=datetime(2025, 11, 1),
        ...     end_date=datetime.now()
        ... )
        >>> # Uses optimal source for each part!
    """
    
    def __init__(self, mode='backtest', startup_gap_check: bool = False):
        """
        Initialize unified manager.

        Args:
            mode: 'backtest' (use local files) or 'live' (use API for recent
                  data).
            startup_gap_check: If True, run a lightweight 7-day continuity
                  check on startup and auto-repair any gaps found.  Defaults
                  to False so existing backtest code is unaffected.  Set to
                  True in live/paper-trading entry points.
        """
        self.lakeapi_dir = RAW_DATA_DIR  # Historical data (LakeAPI decommissioned, data remains)
        self.binance_dir = PROJECT_ROOT / "data" / "binance"
        self.mode = mode  # backtest vs live mode

        # Components
        self.bar_aggregator = BarAggregator()
        self.binance_client = None  # Lazy initialization
        
        # Thresholds
        self.binance_threshold_days = 30  # Use Binance for last 30 days
        
        logger.info(f"✅ Unified Data Manager initialized (Mode: {mode})")
        logger.info(f"   LakeAPI: {self.lakeapi_dir}")
        logger.info(f"   Binance: {self.binance_dir}")
        logger.info(f"   Auto-routing threshold: {self.binance_threshold_days} days")

        # Optional startup gap check (only in live/paper mode by default)
        if startup_gap_check:
            self.startup_check(auto_repair=True)
    
    def _get_binance_client(self) -> BinanceRestClient:
        """Lazy initialization of Binance client"""
        if self.binance_client is None:
            self.binance_client = BinanceRestClient()
        return self.binance_client

    def reset_client(self) -> None:
        """
        BUG C FIX: Discard the cached BinanceRestClient.

        Within a single DataUpdateThread run the manager reuses the same
        BinanceRestClient instance.  If the 15m download leaves the client in a
        degraded state (e.g. rate-limiter window, stale TCP keepalive), the 1h
        download silently fails through the same broken connection.

        Call this before each retry attempt so the next call to
        _get_binance_client() creates a fresh, uncontaminated instance.
        """
        if self.binance_client is not None:
            logger.debug("UnifiedDataManager.reset_client(): discarding cached BinanceRestClient")
        self.binance_client = None
    
    def _normalize_timeframe(self, timeframe: str) -> str:
        """
        Normalize timeframe format for BarAggregator
        
        Converts: '15m' → '15min', '1h' → '1h', etc.
        BarAggregator expects 'min' suffix, not 'm'
        
        Args:
            timeframe: Input timeframe ('15m', '1h', etc.)
        
        Returns:
            Normalized timeframe ('15min', '1h', etc.)
        """
        mapping = {
            '1m': '1min',
            '5m': '5min', 
            '15m': '15min',
            '30m': '30min'
        }
        return mapping.get(timeframe, timeframe)
    
    def _get_bars_from_local_files(
        self,
        timeframe: str,
        start_date: datetime,
        end_date: datetime
    ) -> pd.DataFrame:
        """
        NEW FUNCTION: Read bars from local Binance parquet files
        
        This is for BACKTEST MODE - reads pre-downloaded data.
        Does NOT call Binance API!
        
        Args:
            timeframe: Bar timeframe (e.g., '15m', '1h')
            start_date: Start date
            end_date: End date
        
        Returns:
            DataFrame with bars from local files
        """
        logger.info("   📂 Reading from local Binance parquet files...")
        
        try:
            # Determine which month folders to read
            current_month = start_date.replace(day=1)
            end_month = end_date.replace(day=1)
            
            all_bars = []
            
            while current_month <= end_month:
                # Build file path
                month_str = current_month.strftime('%Y-%m')
                month_folder = self.binance_dir / month_str
                file_path = month_folder / f"BTCUSDT_PERP_{timeframe}_{month_str}.parquet"
                
                if file_path.exists():
                    # Read parquet file
                    df_month = pd.read_parquet(file_path)
                    all_bars.append(df_month)
                    logger.info(f"   ✅ Read {len(df_month)} bars from {file_path.name}")
                else:
                    logger.warning(f"   ⚠️  File not found: {file_path.name}")
                
                # Next month
                if current_month.month == 12:
                    current_month = current_month.replace(year=current_month.year + 1, month=1)
                else:
                   current_month = current_month.replace(month=current_month.month + 1)
            
            if not all_bars:
                raise FileNotFoundError(f"No local Binance files found for {timeframe}")
            
            # Combine all months
            bars = pd.concat(all_bars, ignore_index=True)
            
            # Ensure timestamp is tz-aware UTC datetime so filtering is consistent
            # regardless of whether callers pass naive or tz-aware start/end dates.
            bars['timestamp'] = pd.to_datetime(bars['timestamp'], utc=True)
            if start_date.tzinfo is None:
                start_date = start_date.replace(tzinfo=timezone.utc)
            if end_date.tzinfo is None:
                end_date = end_date.replace(tzinfo=timezone.utc)

            # Filter to exact date range
            bars = bars[
                (bars['timestamp'] >= start_date) &
                (bars['timestamp'] <= end_date)
            ].copy()
            
            # Sort by timestamp
            bars = bars.sort_values('timestamp').reset_index(drop=True)
            
            logger.info(f"   ✅ Local files: {len(bars)} bars loaded")
            return bars
            
        except Exception as e:
            logger.error(f"   ❌ Local files error: {e}")
            raise
    
    def _determine_source(
        self,
        start_date: Optional[datetime],
        end_date: Optional[datetime]
    ) -> DataSource:
        """
        Determine optimal data source based on date range
        
        Logic:
        - If both dates > 30 days ago: LakeAPI only
        - If both dates < 30 days ago: Binance only
        - If spans both: Hybrid (combine sources)
        
        Args:
            start_date: Start date (None = auto)
            end_date: End date (None = now)
        
        Returns:
            Optimal data source
        """
        now = datetime.now(timezone.utc)
        threshold = now - timedelta(days=self.binance_threshold_days)

        # Normalize tz-naive incoming dates to UTC-aware for comparison
        if end_date is not None and end_date.tzinfo is None:
            end_date = end_date.replace(tzinfo=timezone.utc)
        if start_date is not None and start_date.tzinfo is None:
            start_date = start_date.replace(tzinfo=timezone.utc)

        # Default to now if not specified
        if end_date is None:
            end_date = now

        if start_date is None:
            # Requesting recent data
            return DataSource.BINANCE

        # Both in historical range
        if end_date < threshold:
            return DataSource.LAKEAPI
        
        # Both in recent range
        if start_date >= threshold:
            return DataSource.BINANCE
        
        # Spans both - need hybrid
        return DataSource.AUTO
    
    def get_bars(
        self,
        timeframe: str = '15m',
        count: Optional[int] = None,
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None,
        source: DataSource = DataSource.AUTO
    ) -> pd.DataFrame:
        """
        Get OHLCV bars (the main interface!)
        
        Args:
            timeframe: Bar timeframe ('1m', '5m', '15m', '1h', '4h', '1d')
            count: Number of bars (alternative to date range)
            start_date: Start date (optional)
            end_date: End date (optional, defaults to now)
            source: Force specific source (default: AUTO routing)
        
        Returns:
            DataFrame with OHLCV bars
        
        Examples:
            >>> # Get last 1000 bars (warmup)
            >>> bars = manager.get_bars('15m', count=1000)
            >>> 
            >>> # Get specific date range
            >>> bars = manager.get_bars(
            ...     '15m',
            ...     start_date=datetime(2025, 12, 1),
            ...     end_date=datetime(2025, 12, 31)
            ... )
            >>> 
            >>> # Force specific source
            >>> bars = manager.get_bars('15m', count=100, source=DataSource.BINANCE)
        """
        # Handle count-based request
        if count is not None and start_date is None:
            return self._get_bars_by_count(timeframe, count, end_date)
        
        # Handle date range request
        if start_date is not None or end_date is not None:
            return self._get_bars_by_range(timeframe, start_date, end_date, source)
        
        raise ValueError("Must specify either 'count' or 'start_date'")
    
    def _get_bars_by_count(
        self,
        timeframe: str,
        count: int,
        end_date: Optional[datetime] = None
    ) -> pd.DataFrame:
        """
        Get last N bars up to specified date
        
        Optimized for strategy warmup (typically 1000 bars)
        
        Args:
            timeframe: Bar timeframe
            count: Number of bars
            end_date: End date (defaults to now)
        
        Returns:
            DataFrame with last N bars
        """
        if end_date is None:
            end_date = datetime.now(timezone.utc)

        logger.info(f"📊 Getting last {count} {timeframe} bars...")
        
        # Estimate required date range
        timeframe_minutes = {
            '1m': 1, '5m': 5, '15m': 15, '30m': 30,
            '1h': 60, '4h': 240, '1d': 1440
        }
        
        minutes = timeframe_minutes.get(timeframe, 15)
        days_needed = int((count * minutes / (24 * 60)) * 1.5)  # 50% buffer
        
        start_date = end_date - timedelta(days=days_needed)
        
        # Get bars for estimated range
        bars = self._get_bars_by_range(timeframe, start_date, end_date, DataSource.AUTO)
        
        # Return last N bars
        if len(bars) >= count:
            result = bars.tail(count).copy()
            logger.info(f"✅ Returned {len(result)} bars")
            return result
        else:
            logger.warning(f"⚠️  Only {len(bars)} bars available (requested {count})")
            return bars
    
    def _get_bars_by_range(
        self,
        timeframe: str,
        start_date: Optional[datetime],
        end_date: Optional[datetime],
        source: DataSource
    ) -> pd.DataFrame:
        """
        Get bars for specific date range
        
        Implements smart routing logic
        
        Args:
            timeframe: Bar timeframe
            start_date: Start date
            end_date: End date
            source: Data source preference
        
        Returns:
            DataFrame with bars in date range
        """
        if end_date is None:
            end_date = datetime.now(timezone.utc)
        elif end_date.tzinfo is None:
            end_date = end_date.replace(tzinfo=timezone.utc)

        if start_date is None:
            start_date = end_date - timedelta(days=30)
        elif start_date.tzinfo is None:
            start_date = start_date.replace(tzinfo=timezone.utc)

        # Determine source if AUTO
        if source == DataSource.AUTO:
            source = self._determine_source(start_date, end_date)
        
        logger.info(f"📊 Source: {source.value} | Range: {start_date.date()} to {end_date.date()}")
        
        # Route to appropriate source
        if source == DataSource.LAKEAPI:
            return self._get_bars_lakeapi(timeframe, start_date, end_date)
        
        elif source == DataSource.BINANCE:
            return self._get_bars_binance(timeframe, start_date, end_date)
        
        else:  # AUTO - hybrid approach
            return self._get_bars_hybrid(timeframe, start_date, end_date)
    
    def _get_bars_lakeapi(
        self,
        timeframe: str,
        start_date: datetime,
        end_date: datetime
    ) -> pd.DataFrame:
        """
        Get bars from LakeAPI (historical data)
        
        Process:
        1. Load trades from parquet files
        2. Aggregate to requested timeframe
        3. Filter to date range
        
        Args:
            timeframe: Bar timeframe
            start_date: Start date
            end_date: End date
        
        Returns:
            DataFrame with bars
        """
        logger.info("   📂 Loading from LakeAPI...")
        
        try:
            # CRITICAL: Normalize timeframe format ('15m' → '15min')
            normalized_tf = self._normalize_timeframe(timeframe)
            
            # Use bar aggregator to process LakeAPI trades
            bars = self.bar_aggregator.aggregate_date_range(
                'trades',
                start_date,
                end_date,
                normalized_tf  # Use normalized timeframe!
            )
            
            logger.info(f"   ✅ LakeAPI: {len(bars)} bars loaded")
            return bars
            
        except Exception as e:
            logger.error(f"   ❌ LakeAPI error: {e}")
            
            # Fallback to Binance if LakeAPI fails
            logger.info("   🔄 Falling back to Binance...")
            return self._get_bars_binance(timeframe, start_date, end_date)
    
    def _get_bars_binance(
        self,
        timeframe: str,
        start_date: datetime,
        end_date: datetime
    ) -> pd.DataFrame:
        """
        Get bars from Binance (recent/current data) with pagination.
        
        Uses Binance's pre-computed klines (much faster!) with startTime
        pagination to overcome the 1,500-bar-per-request limit.
        
        Args:
            timeframe: Bar timeframe
            start_date: Start date
            end_date: End date
        
        Returns:
            DataFrame with bars covering the full requested range
        """
        logger.info("   🌐 Loading from Binance...")
        
        try:
            client = self._get_binance_client()
            
            # Convert tz-aware dates to millisecond epoch timestamps for Binance API
            start_ms = int(start_date.timestamp() * 1000)
            end_ms = int(end_date.timestamp() * 1000)

            # Floor start_ms to the timeframe boundary for coarse timeframes.
            # Binance API filters by openTime >= startTime, so a mid-bar
            # start_ms (e.g. 08:45 for 1d bars) would exclude the coarse bar
            # whose openTime is earlier (e.g. 00:00), causing it to be missing
            # from the response entirely.
            if timeframe == '1d':
                start_ms = int(start_date.replace(hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000)
            elif timeframe == '4h':
                start_ms = int(start_date.replace(hour=(start_date.hour // 4) * 4, minute=0, second=0, microsecond=0).timestamp() * 1000)
            elif timeframe == '1h':
                start_ms = int(start_date.replace(minute=0, second=0, microsecond=0).timestamp() * 1000)

            all_chunks = []
            current_start = start_ms
            max_limit = 1500  # Binance API maximum per request
            
            while current_start < end_ms:
                try:
                    chunk = client.get_klines(
                        interval=timeframe,
                        symbol='BTCUSDT',
                        limit=max_limit,
                        futures=True,
                        start_time=current_start,
                        end_time=end_ms,
                    )
                except Exception as api_exc:
                    logger.error(
                        "Binance API error at page boundary current_start=%d: %s",
                        current_start, api_exc,
                    )
                    if len(all_chunks) == 0:
                        raise
                    break

                if len(chunk) == 0:
                    break
                
                all_chunks.append(chunk)
                
                # If we got fewer bars than the limit, we've exhausted the range
                if len(chunk) < max_limit:
                    break
                
                # Advance startTime past the last bar's open_time for next page
                last_ts = chunk['timestamp'].iloc[-1]
                if pd.isna(last_ts):
                    logger.warning(
                        "NaT timestamp detected in Binance response at cursor=%d -- "
                        "terminating pagination to avoid infinite loop",
                        current_start,
                    )
                    break
                if last_ts.tzinfo is None:
                    last_ts = last_ts.tz_localize('utc')
                current_start = int(last_ts.timestamp() * 1000) + 1
            
            if len(all_chunks) == 0:
                logger.warning("   ⚠️ Binance returned no data for the requested range")
                return pd.DataFrame()
            
            bars = pd.concat(all_chunks, ignore_index=True)
            
            # Deduplicate at pagination boundaries (overlapping open_time + 1ms)
            bars = bars.drop_duplicates(subset=['timestamp'])
            
            # Filter to exact range — parse as tz-aware UTC so comparison with
            # tz-aware start_date_floored (set by BTCAAAAA-795) doesn't raise TypeError.
            # rest_client strips UTC with .dt.tz_localize(None); re-localize here.
            bars['timestamp'] = pd.to_datetime(bars['timestamp'], utc=True)

            # BTCAAAAA-25498: drop any NaT timestamps that may have leaked
            # through despite the per-page cursor guard (e.g. a corrupt
            # middle row in a chunk whose last_ts is valid).
            bars = bars[bars['timestamp'].notna()].copy()

            # INSTITUTIONAL: Don't filter by end_date too strictly!
            # Binance returns ALL available candles including current forming one
            # We want everything >= start_date (don't cut off recent data)
            #
            # FIX: Floor start_date to the timeframe boundary before filtering.
            # Coarse bars (1d, 4h, 1h) have open_time at the START of the period
            # (e.g. daily bar opens at 00:00 UTC). If start_date is an intraday
            # 15m timestamp (e.g. 08:45 UTC), filtering >= 08:45 would drop every
            # daily bar whose open_time is 00:00 UTC on the same day, yielding 0
            # bars even though the data was successfully fetched. Flooring to the
            # period boundary ensures we keep all bars that include start_date.
            if timeframe == '1d':
                start_date_floored = start_date.replace(hour=0, minute=0, second=0, microsecond=0)
            elif timeframe == '4h':
                start_date_floored = start_date.replace(hour=(start_date.hour // 4) * 4, minute=0, second=0, microsecond=0)
            elif timeframe == '1h':
                start_date_floored = start_date.replace(minute=0, second=0, microsecond=0)
            else:
                start_date_floored = start_date  # 15m and smaller: existing behaviour is correct
            # Ensure start_date_floored is tz-aware to match the UTC-aware timestamp column
            if start_date_floored.tzinfo is None:
                start_date_floored = start_date_floored.replace(tzinfo=timezone.utc)
            bars = bars[bars['timestamp'] >= start_date_floored].copy()
            
            logger.info(f"   ✅ Binance: {len(bars)} bars loaded")
            return bars
            
        except Exception as e:
            logger.error(f"   ❌ Binance error: {e}")
            
            # If Binance fails, try LakeAPI as fallback
            logger.info("   🔄 Falling back to LakeAPI...")
            return self._get_bars_lakeapi(timeframe, start_date, end_date)
    
    def _get_earliest_binance_date(self, timeframe: str) -> Optional[datetime]:
        """
        CRITICAL FIX: Dynamically detect earliest available Binance file
        
        Scans data/binance/ directory to find the absolute earliest timestamp
        in any downloaded Binance parquet file.
        
        Args:
            timeframe: Timeframe to check (e.g., '15m')
        
        Returns:
            Earliest datetime found in Binance files, or None if no files exist
        """
        try:
            if not self.binance_dir.exists():
                return None
            
            # Find all parquet files matching the timeframe
            binance_files = list(self.binance_dir.glob(f'**/BTCUSDT_PERP_{timeframe}_*.parquet'))
            
            if not binance_files:
                return None
            
            # Read first timestamp from each file and find the earliest
            earliest_timestamp = None
            
            for file in sorted(binance_files):  # Sort to process in order
                try:
                    df_temp = pd.read_parquet(file, columns=['timestamp'])
                    if len(df_temp) > 0:
                        file_start = pd.to_datetime(df_temp['timestamp'].iloc[0], utc=True)
                        if earliest_timestamp is None or file_start < earliest_timestamp:
                            earliest_timestamp = file_start
                            # Once we find the earliest file, we can break since files are sorted
                            break
                except Exception as e:
                    continue
            
            if earliest_timestamp:
                logger.info(f"   📅 Earliest Binance data: {earliest_timestamp.strftime('%Y-%m-%d %H:%M')}")
            
            return earliest_timestamp
            
        except Exception as e:
            logger.error(f"   ⚠️  Error detecting Binance files: {e}")
            return None
    
    def _get_bars_hybrid(
        self,
        timeframe: str,
        start_date: datetime,
        end_date: datetime
    ) -> pd.DataFrame:
        """
        Get bars from both sources (seamless combination!)
        
        Process:
        1. Historical part: LakeAPI
        2. Recent part: Binance local files
        3. Combine seamlessly
        
        CRITICAL FIX: Now uses ALL available Binance data (not just 30 days)!
        
        Args:
            timeframe: Bar timeframe
            start_date: Start date
            end_date: End date
        
        Returns:
            DataFrame with combined bars
        """
        logger.info("   🔀 Hybrid mode: Combining LakeAPI + Binance...")

        # Normalize tz-naive incoming dates to UTC-aware for comparisons below
        if start_date is not None and start_date.tzinfo is None:
            start_date = start_date.replace(tzinfo=timezone.utc)
        if end_date is not None and end_date.tzinfo is None:
            end_date = end_date.replace(tzinfo=timezone.utc)

        # CRITICAL FIX: Dynamically detect earliest Binance file instead of hardcoded 30 days!
        earliest_binance = self._get_earliest_binance_date(timeframe)

        if earliest_binance:
            # Use the ACTUAL earliest Binance date as threshold
            threshold = earliest_binance
            # Normalize to UTC-aware for comparison with start_date/end_date
            if threshold.tzinfo is None:
                threshold = threshold.replace(tzinfo=timezone.utc)
            logger.info(f"   ✅ Using ALL Binance data from {threshold.strftime('%Y-%m-%d')}")
        else:
            # Fallback to 30-day threshold if no Binance files found
            threshold = datetime.now(timezone.utc) - timedelta(days=self.binance_threshold_days)
            logger.warning(f"   ⚠️  No Binance files found, using {self.binance_threshold_days}-day threshold")
        
        all_bars = []
        
        # Part 1: Historical from LakeAPI
        if start_date < threshold:
            historical_end = min(threshold, end_date)
            logger.info(f"   📂 LakeAPI: {start_date.date()} to {historical_end.date()}")
            
            try:
                historical_bars = self._get_bars_lakeapi(
                    timeframe,
                    start_date,
                    historical_end
                )
                all_bars.append(historical_bars)
            except Exception as e:
                logger.error(f"   ⚠️  LakeAPI failed: {e}")
        
        # Part 2: Recent from Binance
        if end_date > threshold:
            recent_start = max(threshold, start_date)
            logger.info(f"   🌐 Binance: {recent_start.date()} to {end_date.date()}")
            
            try:
                # CRITICAL: Use local files in backtest mode, API in live mode
                if self.mode == 'backtest':
                    recent_bars = self._get_bars_from_local_files(
                        timeframe,
                        recent_start,
                        end_date
                    )
                else:
                    recent_bars = self._get_bars_binance(
                        timeframe,
                        recent_start,
                        end_date
                    )
                all_bars.append(recent_bars)
            except Exception as e:
                logger.error(f"   ⚠️  Binance failed: {e}")
        
        if not all_bars:
            raise ValueError("No data available from any source")
        
        # Combine results
        combined = pd.concat(all_bars, ignore_index=True)
        combined = combined.sort_values('timestamp').drop_duplicates(subset=['timestamp'], keep='last')
        
        logger.info(f"   ✅ Hybrid: {len(combined)} total bars")
        return combined
    
    def get_all_data_types_status(self) -> Dict[str, Dict]:
        """
        Check status of ALL data types
        
        Returns:
            Dict with status for each data type:
            {
                'trades': {
                    'start': datetime,
                    'end': datetime,
                    'gap_days': int,
                    'status': 'complete' | 'gap' | 'missing'
                },
                'funding': {...},
                'liquidations': {...},
                'open_interest': {...},
                'orderbook': {...}
            }
        """
        data_types = ['trades', 'funding', 'liquidations', 'open_interest', 'orderbook']
        status = {}
        
        for data_type in data_types:
            data_dir = self.lakeapi_dir / data_type
            if not data_dir.exists():
                status[data_type] = {
                    'status': 'missing',
                    'gap_days': 999,
                    'start': None,
                    'end': None
                }
                continue
            
            # Find last parquet file
            parquet_files = sorted(data_dir.glob(f'BTC-USDT_{data_type}_*.parquet'))
            if not parquet_files:
                status[data_type] = {
                    'status': 'missing',
                    'gap_days': 999,
                    'start': None,
                    'end': None
                }
                continue
            
            # Read actual last timestamp (same logic as trades)
            try:
                last_file = parquet_files[-1]
                first_file = parquet_files[0]
                
                # Get start date from first file
                first_date_str = first_file.stem.split('_')[-1]  # '2022-03'
                start_date = datetime.strptime(first_date_str, '%Y-%m')
                
                # Try possible timestamp column names for end date
                timestamp_cols = ['timestamp', 'origin_time', 'received_time', 'time']
                df = None
                end_date = None
                
                for col in timestamp_cols:
                    try:
                        df = pd.read_parquet(last_file, columns=[col])
                        if len(df) > 0:
                            end_date = pd.to_datetime(df[col].iloc[-1], utc=True)
                            break
                    except:
                        continue

                if end_date is None:
                    # Fallback to filename
                    last_date_str = last_file.stem.split('_')[-1]
                    year, month = map(int, last_date_str.split('-'))
                    from calendar import monthrange
                    last_day = monthrange(year, month)[1]
                    end_date = datetime(year, month, last_day, 23, 59, 59, tzinfo=timezone.utc)

                # Calculate gap FIRST
                gap_days = (datetime.now(timezone.utc) - end_date).days

                # INSTITUTIONAL: Check DOWNLOADED Binance files (not API!)
                # Read actual parquet files in data/binance/ directory
                if gap_days > 0 and self.binance_dir.exists():
                    try:
                        # Find all 15m parquet files in Binance directory
                        binance_files = list(self.binance_dir.glob('**/BTCUSDT_PERP_15m_*.parquet'))

                        if binance_files:
                            # Read ALL files and find absolute latest timestamp
                            latest_timestamp = None

                            for file in binance_files:
                                try:
                                    df_temp = pd.read_parquet(file, columns=['timestamp'])
                                    if len(df_temp) > 0:
                                        file_end = pd.to_datetime(df_temp['timestamp'].iloc[-1], utc=True)
                                        if latest_timestamp is None or file_end > latest_timestamp:
                                            latest_timestamp = file_end
                                except:
                                    continue

                            if latest_timestamp and latest_timestamp > end_date:
                                end_date = latest_timestamp
                                gap_days = (datetime.now(timezone.utc) - end_date).days
                                logger.info(f"   ✅ Downloaded Binance: last candle at {latest_timestamp} (gap: {gap_days}d)")
                    except Exception as e:
                        pass

                # For 15min futures, we need precision down to minutes
                # Calculate gap in minutes for more accurate detection
                gap_minutes = (datetime.now(timezone.utc) - end_date).total_seconds() / 60
                
                # CRITICAL FIX: Don't count CURRENT unclosed bar as missing!
                # For 15min bars: if gap is 0-15min, that's just the current forming bar
                # For 15min bars: if gap is 16-30min, we're missing 1 candle
                # For 15min bars: if gap is 31-45min, we're missing 2 candles
                # 
                # Formula: actual_missing_candles = (gap_minutes - timeframe_minutes) / timeframe_minutes
                # Example: gap=25min for 15min bars → (25-15)/15 = 0.66 → 0 complete candles missing
                # Example: gap=35min for 15min bars → (35-15)/15 = 1.33 → 1 complete candles missing
                
                timeframe_minutes = 15  # For 15min bars
                
                # Subtract current bar period to get TRUE gap
                # If result is negative or 0, we're up-to-date (current bar is forming)
                true_gap_minutes = max(0, gap_minutes - timeframe_minutes)
                
                status[data_type] = {
                    'start': start_date,
                    'end': end_date,
                    'gap_days': gap_days,
                    'gap_minutes': int(true_gap_minutes),  # Report TRUE gap (excluding current bar)
                    # FIX: threshold must be < timeframe_minutes (15), not <= 0.
                    # true_gap_minutes = max(0, gap_minutes - 15). During the 1–14
                    # minutes while the next candle is forming, true_gap_minutes is
                    # 1–14 (> 0), but int(true_gap_minutes / 15) == 0 means zero
                    # complete bars are missing — data is current. The old <= 0
                    # threshold incorrectly flagged these as DATA GAPS.
                    'status': 'complete' if true_gap_minutes < timeframe_minutes else 'gap'
                }
                
            except Exception as e:
                logger.error(f"Error checking {data_type}: {e}")
                status[data_type] = {
                    'status': 'error',
                    'gap_days': 999,
                    'start': None,
                    'end': None,
                    'error': str(e)
                }
        
        return status
    
    def get_available_date_range(self, timeframe: str = '15m') -> Dict[str, datetime]:
        """
        Get available date range across all sources
        
        Args:
            timeframe: Timeframe to check
        
        Returns:
            Dict with earliest and latest available dates
        """
        # Check LakeAPI (historical data in parquet files)
        lakeapi_start = None
        lakeapi_end = None
        
        trades_dir = self.lakeapi_dir / 'trades'
        if trades_dir.exists():
            # Find earliest and latest parquet files
            parquet_files = sorted(trades_dir.glob('BTC-USDT_trades_*.parquet'))
            if parquet_files:
                # Extract start date from first filename
                first_file = parquet_files[0].stem.split('_')[-1]  # '2024-01'
                lakeapi_start = datetime.strptime(first_file, '%Y-%m')
                
                # CRITICAL: Read ACTUAL last timestamp from the parquet file, not filename!
                import pandas as pd
                try:
                    last_parquet = parquet_files[-1]
                    # Try possible timestamp column names
                    timestamp_cols = ['timestamp', 'origin_time', 'received_time']
                    df = None
                    
                    for col in timestamp_cols:
                        try:
                            df = pd.read_parquet(last_parquet, columns=[col])
                            if len(df) > 0:
                                lakeapi_end = pd.to_datetime(df[col].iloc[-1], utc=True)
                                break
                        except:
                            continue
                    
                    if df is None or len(df) == 0:
                        raise Exception("Could not read timestamp from any column")
                        
                except Exception as e:
                    logger.warning(f"Warning: Could not read last timestamp from {last_parquet}: {e}")
                    # Fallback to filename
                    last_file = parquet_files[-1].stem.split('_')[-1]
                    year, month = map(int, last_file.split('-'))
                    from calendar import monthrange
                    last_day = monthrange(year, month)[1]
                    lakeapi_end = datetime(year, month, last_day, 23, 59, 59)
        
        # Check Binance (assumed to be current)
        binance_end = datetime.now(timezone.utc)
        binance_start = binance_end - timedelta(days=30)  # Typical availability
        
        # Combine
        earliest = lakeapi_start if lakeapi_start else binance_start
        latest = binance_end
        
        return {
            'earliest': earliest,
            'latest': latest,
            'lakeapi_range': (lakeapi_start, lakeapi_end) if lakeapi_start else None,
            'binance_range': (binance_start, binance_end)
        }

    def get_last_bar_timestamp(self, timeframe: str = '15m') -> Optional[datetime]:
        """
        Return the timestamp of the most recent bar stored on disk for
        *timeframe*, or ``None`` if no local Binance parquet files exist.

        This is a lightweight read: only the ``timestamp`` column of the
        chronologically latest monthly parquet file is loaded so the call
        adds minimal I/O overhead to the runtime update cycle.

        Used by :class:`_RuntimeCandleUpdateThread` (RC4b fix) to anchor the
        scan window at the last known bar rather than at ``session_start_time``
        — which can be *after* ``last_bar_on_disk`` and would therefore clip
        the very bars that need filling.

        Args:
            timeframe: Timeframe to check (e.g. ``'15m'``, ``'1h'``).

        Returns:
            Timezone-naive UTC ``datetime`` of the last stored bar, or ``None``.
            Intentionally tz-naive to match on-disk parquet convention.
            Callers that pass this result into a comparison-path function must
            either rely on that function's entry-point normalization or add
            ``.replace(tzinfo=timezone.utc)`` themselves.
        """
        import pandas as pd

        pattern = f'**/BTCUSDT_PERP_{timeframe}_*.parquet'
        all_files = sorted(self.binance_dir.glob(pattern))
        if not all_files:
            return None

        # Walk from newest to oldest until we find a readable file with rows.
        for fp in reversed(all_files):
            try:
                df = pd.read_parquet(fp, columns=['timestamp'])
                if df.empty:
                    continue
                df['timestamp'] = pd.to_datetime(df['timestamp'])
                last_ts = df['timestamp'].max()
                if pd.isna(last_ts):
                    continue
                result = last_ts.to_pydatetime()
                # Strip timezone info to stay consistent with the rest of the codebase
                if result.tzinfo is not None:
                    result = result.replace(tzinfo=None)
                return result
            except Exception as exc:
                logger.warning(f"   [get_last_bar_timestamp/{timeframe}] could not read {fp.name}: {exc}")
                continue

        return None

    def post_ingest_sanity_check(
        self,
        timeframe: str,
        expected_last_ts: datetime,
        tolerance_s: float = 5.0,
    ) -> None:
        """
        P3 (BTCAAAAA-995): Assert the most recent on-disk bar is within
        *tolerance_s* seconds of *expected_last_ts*.

        Raises RuntimeError when the delta exceeds the threshold so callers
        catch silent truncation (API returning 0 bars, cursor logic stopping
        early, wrong end_ts rounding, etc.).

        Args:
            timeframe:       Timeframe to check (e.g. '15m', '1h').
            expected_last_ts: The bar timestamp we expect to be last on disk.
                              Pass tz-naive UTC or tz-aware; both are handled.
            tolerance_s:     Allowed deviation in seconds (default 5 s).
        """
        actual = self.get_last_bar_timestamp(timeframe)
        if actual is None:
            raise RuntimeError(
                f"post_ingest_sanity_check/{timeframe}: no bars found on disk."
            )

        # Normalise both sides to tz-naive for comparison
        if isinstance(expected_last_ts, pd.Timestamp):
            exp = expected_last_ts.to_pydatetime()
        else:
            exp = expected_last_ts
        if exp.tzinfo is not None:
            exp = exp.replace(tzinfo=None)

        delta_s = abs((actual - exp).total_seconds())
        if delta_s > tolerance_s:
            raise RuntimeError(
                f"post_ingest_sanity_check/{timeframe}: "
                f"last_stored={actual} expected={exp} "
                f"delta={delta_s:.1f}s > {tolerance_s}s threshold. "
                "Possible partial ingest or wrong end_ts."
            )
        logger.info(
            "post_ingest_sanity_check/%s OK: last=%s expected=%s delta=%.3fs",
            timeframe, actual, exp, delta_s,
        )

    # =========================================================================
    # GAP DETECTION & AUTO-REPAIR  (added 2026-05-02)
    # =========================================================================

    def detect_gaps_in_binance_files(
        self,
        timeframe: str = '15m',
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None,
        tolerance_multiplier: float = 1.5,
    ) -> List[Dict]:
        """
        Scan stored Binance parquet files for continuity gaps.

        A gap is any interval between consecutive timestamps that exceeds
        ``tolerance_multiplier * expected_bar_duration``.

        Args:
            timeframe: Bar timeframe to inspect (e.g. '15m', '1h').
            start_date: Only report gaps after this date (None = all).
            end_date:   Only report gaps before this date (None = now).
            tolerance_multiplier: How many multiples of the bar period count
                as a gap (default 1.5 → any jump > 22.5 min for 15m bars).

        Returns:
            List of gap dicts::

                {
                    'gap_start': datetime,   # last good bar before the gap
                    'gap_end':   datetime,   # first bar after the gap
                    'duration':  timedelta,
                    'missing_bars': int,     # estimated count
                    'timeframe': str,
                }
        """
        # Normalize caller datetimes — accept both naive (assumed UTC) and aware
        if start_date is not None and start_date.tzinfo is None:
            start_date = start_date.replace(tzinfo=timezone.utc)
        if end_date is not None and end_date.tzinfo is None:
            end_date = end_date.replace(tzinfo=timezone.utc)

        tf_minutes = {
            '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30,
            '1h': 60, '2h': 120, '4h': 240, '6h': 360, '12h': 720, '1d': 1440,
        }
        if timeframe not in tf_minutes:
            raise ValueError(f"Unknown timeframe '{timeframe}'. Known: {list(tf_minutes)}")

        bar_minutes = tf_minutes[timeframe]
        expected_delta = timedelta(minutes=bar_minutes)
        gap_threshold = expected_delta * tolerance_multiplier

        # Load all matching parquet files
        pattern = f'**/BTCUSDT_PERP_{timeframe}_*.parquet'
        all_files = sorted(self.binance_dir.glob(pattern))
        if not all_files:
            logger.warning(f"   ⚠️  No Binance parquet files found for {timeframe}")
            return []

        # RC3 PERF FIX: Skip files whose month is entirely outside [start_date, end_date].
        # File names encode the month as YYYY-MM (e.g. BTCUSDT_PERP_15m_2026-03.parquet).
        # Skipping out-of-range files eliminates the dominant I/O cost when the runtime
        # window is only 2 hours but the data directory spans many months.
        _month_re = re.compile(r'(\d{4}-\d{2})\.parquet$')

        def _file_in_range(fp: Path) -> bool:
            """Return True if this month-file could contain rows in [start_date, end_date]."""
            if start_date is None and end_date is None:
                return True
            m = _month_re.search(fp.name)
            if not m:
                return True  # unknown naming — keep to be safe
            try:
                from calendar import monthrange
                year, month = int(m.group(1)[:4]), int(m.group(1)[5:])
                file_month_start = datetime(year, month, 1, tzinfo=timezone.utc)
                last_day = monthrange(year, month)[1]
                file_month_end = datetime(year, month, last_day, 23, 59, 59, tzinfo=timezone.utc)
                if start_date is not None and file_month_end < start_date:
                    return False
                if end_date is not None and file_month_start > end_date:
                    return False
            except Exception:
                pass
            return True

        files = [f for f in all_files if _file_in_range(f)]
        if not files:
            # No files in range → no gaps to report
            return []

        t0_load = _time_mod.monotonic()
        frames = []
        for f in files:
            try:
                df = pd.read_parquet(f, columns=['timestamp'])
                df['timestamp'] = pd.to_datetime(df['timestamp'], utc=True)
                frames.append(df)
            except Exception as exc:
                logger.warning(f"   ⚠️  Could not read {f.name}: {exc}")

        if not frames:
            return []

        logger.info(f"   [detect_gaps/{timeframe}] loaded {len(files)} file(s) in {_time_mod.monotonic() - t0_load:.2f}s")

        combined = pd.concat(frames, ignore_index=True)
        combined = combined.sort_values('timestamp').drop_duplicates(
            subset=['timestamp'], keep='last'
        ).reset_index(drop=True)

        # Optional date filter
        if start_date:
            combined = combined[combined['timestamp'] >= start_date]
        if end_date:
            combined = combined[combined['timestamp'] <= end_date]
        combined = combined.reset_index(drop=True)

        if len(combined) == 0:
            return []

        diffs = combined['timestamp'].diff().dropna()
        gap_indices = diffs[diffs > gap_threshold].index

        gaps = []
        for idx in gap_indices:
            gap_start = combined.loc[idx - 1, 'timestamp']
            gap_end = combined.loc[idx, 'timestamp']
            duration = gap_end - gap_start
            missing = max(0, int(duration.total_seconds() / (bar_minutes * 60)) - 1)
            gaps.append({
                'gap_start': gap_start,
                'gap_end': gap_end,
                'duration': duration,
                'missing_bars': missing,
                'timeframe': timeframe,
            })

        # ------------------------------------------------------------------
        # Trailing-edge gap detection (BTCAAAAA-115)
        # diff() only detects gaps *between* existing rows; it never catches
        # the case where the last bar on disk is stale relative to end_date.
        # We compute the last CLOSED bar boundary and compare it to the last
        # stored timestamp.
        # ------------------------------------------------------------------
        if end_date is not None and len(combined) >= 1:
            last_bar_ts = combined['timestamp'].max()
            if isinstance(last_bar_ts, pd.Timestamp):
                last_bar_ts = last_bar_ts.to_pydatetime()

            # Floor end_date to the last fully-closed bar boundary.
            # e.g. for 15m: truncate minutes to :00/:15/:30/:45
            def _floor_to_bar(dt: datetime, minutes: int) -> datetime:
                return dt - timedelta(
                    minutes=dt.minute % minutes,
                    seconds=dt.second,
                    microseconds=dt.microsecond,
                )

            last_closed = _floor_to_bar(end_date, bar_minutes)

            # If end_date is exactly on a bar boundary the bar at that
            # timestamp is still forming — step back one bar so we only
            # reference closed candles.
            if last_closed >= end_date:
                last_closed = last_closed - expected_delta

            # Allow 10% clock-skew slop before calling it a trailing gap
            slop = expected_delta * 0.9
            if last_closed > last_bar_ts + slop:
                trailing_missing = max(
                    1,
                    int((last_closed - last_bar_ts).total_seconds() / (bar_minutes * 60)),
                )
                gaps.append({
                    'gap_start': last_bar_ts,
                    # open-ended: fetch window runs from last_bar_ts+1bar up to
                    # and including last_closed
                    'gap_end': last_closed + expected_delta,
                    'duration': last_closed - last_bar_ts,
                    'missing_bars': trailing_missing,
                    'timeframe': timeframe,
                })

        return gaps

    def _fetch_binance_range(
        self,
        timeframe: str,
        start_ts: datetime,
        end_ts: datetime,
        symbol: str = 'BTCUSDT',
        futures: bool = True,
        batch_size: int = 1500,
    ) -> pd.DataFrame:
        """
        Fetch klines from Binance API for an *explicit* time window.

        ROOT CAUSE FIX: Always passes ``startTime`` and ``endTime`` to every
        API request.  The original code omitted startTime, causing Binance to
        always return the *latest* 1500 bars regardless of what window was
        requested – that is why missing months appeared to download instantly.

        Args:
            timeframe:  Binance interval string (e.g. '15m', '1h').
            start_ts:   Inclusive window start.
            end_ts:     Inclusive window end.
            symbol:     Binance symbol (default BTCUSDT).
            futures:    Use futures endpoint (default True).
            batch_size: Candles per request (Binance max = 1500).

        Returns:
            Combined DataFrame for the full window, deduplicated and sorted.
        """
        client = self._get_binance_client()
        endpoint = '/fapi/v1/klines' if futures else '/api/v3/klines'
        base_url = client.futures_base if futures else client.spot_base

        import requests as _requests
        import time as _time

        tf_minutes = {
            '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30,
            '1h': 60, '2h': 120, '4h': 240, '6h': 360, '12h': 720, '1d': 1440,
        }
        bar_td = timedelta(minutes=tf_minutes.get(timeframe, 15))

        # Normalize to tz-naive so cursor/filter comparisons against the tz-naive
        # batch['timestamp'] series (which strips tz at line 1257) never raise
        # "Invalid comparison between dtype=datetime64[ns] and Timestamp".
        # _to_ms_utc re-attaches UTC before the actual API ms conversion below.
        if start_ts.tzinfo is not None:
            start_ts = start_ts.replace(tzinfo=None)
        if end_ts.tzinfo is not None:
            end_ts = end_ts.replace(tzinfo=None)

        all_frames: List[pd.DataFrame] = []
        cursor = start_ts

        # RC1b FIX (BTCAAAAA-167): All timestamps in parquet are stored as
        # naive UTC (tz marker stripped after download).  Python's
        # datetime.timestamp() interprets naive datetimes as *local* time.
        # On machines set to CEST (UTC+2) this sends startTime 2 hours too
        # early, causing Binance to return bars that are already on disk and
        # producing "+0 new" even after a successful 3-bar fetch.
        # Fix: attach UTC tzinfo before calling .timestamp() so Python
        # converts correctly regardless of the machine's local timezone.
        def _to_ms_utc(dt: datetime) -> int:
            return int(dt.replace(tzinfo=timezone.utc).timestamp() * 1000)

        while cursor <= end_ts:
            params = {
                'symbol': symbol,
                'interval': timeframe,
                'startTime': _to_ms_utc(cursor),
                # Ensure endTime >= startTime + 1 bar so Binance returns data even for single-bar windows
                'endTime': _to_ms_utc(max(end_ts, cursor + bar_td)),
                'limit': batch_size,
            }

            try:
                client._check_rate_limit()
                resp = _requests.get(
                    f"{base_url}{endpoint}", params=params, timeout=15
                )
                resp.raise_for_status()
                raw = resp.json()
            except Exception as exc:
                logger.error("Binance API error fetching %s %s-%s: %s",
                             timeframe, cursor, end_ts, exc)
                break

            if not raw or not isinstance(raw, list):
                if isinstance(raw, dict) and "code" in raw:
                    logger.error(
                        "Binance API error response: code=%s msg=%s",
                        raw.get("code"), raw.get("msg"),
                    )
                elif not isinstance(raw, list):
                    logger.warning(
                        "Binance returned non-list response type=%s -- aborting page",
                        type(raw).__name__,
                    )
                break

            batch = pd.DataFrame(raw, columns=[
                'open_time', 'open', 'high', 'low', 'close', 'volume',
                'close_time', 'quote_volume', 'trades', 'taker_buy_base',
                'taker_buy_quote', 'ignore',
            ])
            batch['timestamp'] = pd.to_datetime(batch['open_time'], unit='ms', utc=True).dt.tz_localize(None)
            for col in ('open', 'high', 'low', 'close', 'volume', 'quote_volume'):
                batch[col] = batch[col].astype(float)
            batch['trades'] = batch['trades'].astype(int)
            batch = batch.rename(columns={
                'quote_volume': 'volume_usd',
                'trades': 'trade_count',
            })
            batch['symbol'] = symbol
            batch['timeframe'] = timeframe
            batch = batch[[
                'timestamp', 'open', 'high', 'low', 'close',
                'volume', 'volume_usd', 'trade_count', 'symbol', 'timeframe',
            ]]

            all_frames.append(batch)

            # Advance cursor past the last returned candle
            last_ts = batch['timestamp'].iloc[-1]
            if pd.isna(last_ts):
                logger.warning(
                    "NaT timestamp in Binance kline response at cursor=%s -- "
                    "terminating pagination loop",
                    cursor,
                )
                break
            cursor = last_ts + bar_td

            # If the batch is smaller than requested we've reached the end
            if len(raw) < batch_size:
                break

            _time.sleep(0.1)  # be polite to the API

        if not all_frames:
            return pd.DataFrame()

        result = pd.concat(all_frames, ignore_index=True)
        result = result.sort_values('timestamp').drop_duplicates(
            subset=['timestamp'], keep='last'
        ).reset_index(drop=True)

        # Fix 3: Clamp result to the explicitly requested window so that bars
        # Binance returns slightly outside [start_ts, end_ts] (due to alignment
        # or batch overlap) can never produce "+0 new" from spurious out-of-window bars.
        #
        # start_ts may include BINANCE_PROPAGATION_BUFFER (+2 s) to ensure the
        # API returns a finalized bar, but Binance bar timestamps are always on
        # exact bar-open boundaries (e.g. 06:15:00.000).  Comparing >=start_ts
        # with the 2-s buffer would discard the bar at 06:15:00.
        # Fix: floor start_ts to the nearest whole second and subtract one extra
        # second so any sub-second API offset is absorbed without widening the
        # window more than necessary.
        filter_start = pd.Timestamp(start_ts).floor('s') - pd.Timedelta(seconds=3)
        filter_end = pd.Timestamp(end_ts)
        result = result[
            (result['timestamp'] >= filter_start) & (result['timestamp'] <= filter_end)
        ].reset_index(drop=True)

        return result

    def _save_binance_bars(
        self,
        df: pd.DataFrame,
        timeframe: str,
    ) -> None:
        """
        Merge new bars into the correct monthly Binance parquet files.

        Existing data in each month file is read, merged with ``df``,
        deduplicated, sorted, and written back atomically.

        Args:
            df:         DataFrame with new bars (must have 'timestamp' column).
                        Timestamps may be tz-aware or tz-naive; tz info is
                        stripped before writing to preserve the intentional
                        tz-naive UTC on-disk convention.
            timeframe:  Timeframe string used in the filename (e.g. '15m').
        """
        if df.empty:
            return

        df = df.copy()
        df['timestamp'] = pd.to_datetime(df['timestamp'])

        # Group new bars by month
        df['_ym'] = df['timestamp'].dt.to_period('M')
        for period, group in df.groupby('_ym'):
            month_str = str(period)  # e.g. '2026-03'
            month_dir = self.binance_dir / month_str
            month_dir.mkdir(parents=True, exist_ok=True)
            file_path = month_dir / f"BTCUSDT_PERP_{timeframe}_{month_str}.parquet"

            group = group.drop(columns=['_ym'])

            # Bug 5 fix: assert no cross-month bars are written to this file.
            expected_period = period
            cross_month = group[group['timestamp'].dt.to_period('M') != expected_period]
            if not cross_month.empty:
                logger.error(
                    "Cross-month bars detected for %s: %d bars have wrong month (%s). "
                    "Run scripts/fix_month_boundary_parquet.py to repair existing files.",
                    file_path.name, len(cross_month),
                    cross_month['timestamp'].dt.to_period('M').unique().tolist(),
                )
                raise ValueError(
                    f"Attempted to write {len(cross_month)} cross-month bars into {file_path.name}. "
                    "This would contaminate the file. Aborting write."
                )

            # Bug 2 fix: serialize concurrent writers on the same file with a lock.
            # RC3 FIX: the lock now covers ONLY the read-merge-write sequence.
            # The post-write read-back verification is done OUTSIDE the lock so
            # that other threads are not blocked during the (slow) verification read.
            t0_lock = _time_mod.monotonic()
            file_lock = _get_parquet_lock(file_path)
            with file_lock:
                t_lock_acquired = _time_mod.monotonic()
                if file_path.exists():
                    try:
                        existing = pd.read_parquet(file_path)
                        existing['timestamp'] = pd.to_datetime(existing['timestamp'])
                        n_existing = len(existing)

                        # RC1b FIX (BTCAAAAA-167): Normalize timestamp dtypes
                        # before concat to prevent +0 new after a successful
                        # fetch.  Two root causes:
                        #   1. existing parquet has datetime64[ns] (old pyarrow
                        #      default) while group has datetime64[us] (pandas
                        #      2.0+ default).  drop_duplicates() comparing
                        #      ns vs us values can miss matches when the
                        #      nanosecond bits differ.
                        #   2. group timestamps may be tz-aware (UTC from
                        #      pd.to_datetime(..., utc=True)) while existing is
                        #      tz-naive, producing a mixed-tz Series where
                        #      equality never matches.
                        # Solution: strip tz from group if present, then cast
                        # both sides to datetime64[us] before concat so
                        # drop_duplicates works on identical dtypes/values.
                        group = group.copy()
                        if group['timestamp'].dt.tz is not None:
                            group['timestamp'] = group['timestamp'].dt.tz_localize(None)
                        if existing['timestamp'].dt.tz is not None:
                            existing['timestamp'] = existing['timestamp'].dt.tz_localize(None)
                        existing['timestamp'] = existing['timestamp'].astype('datetime64[us]')
                        group['timestamp'] = group['timestamp'].astype('datetime64[us]')

                        merged = pd.concat([existing, group], ignore_index=True)
                    except Exception as exc:
                        logger.warning("Could not read %s for merge: %s – overwriting", file_path, exc)
                        n_existing = 0
                        merged = group
                else:
                    n_existing = 0
                    # Ensure new-file group also has tz stripped and us dtype.
                    group = group.copy()
                    if group['timestamp'].dt.tz is not None:
                        group['timestamp'] = group['timestamp'].dt.tz_localize(None)
                    group['timestamp'] = group['timestamp'].astype('datetime64[us]')
                    merged = group

                merged = merged.sort_values('timestamp').drop_duplicates(
                    subset=['timestamp'], keep='last'
                ).reset_index(drop=True)

                # Bug 2 fix: atomic write via temp file + os.replace (POSIX atomic).
                tmp_path = file_path.with_suffix('.parquet.tmp')
                merged.to_parquet(tmp_path, compression='snappy', index=False)
                os.replace(tmp_path, file_path)

                # Bug 3 fix: log delta (+N new) not just total.
                n_new = len(merged) - n_existing
                t_lock_released = _time_mod.monotonic()
                logger.info(f"      Saved {len(merged)} bars (+{n_new} new) → {file_path.name} "
                    f"(lock_wait={t_lock_acquired - t0_lock:.2f}s, "
                    f"write={t_lock_released - t_lock_acquired:.2f}s)")

            # Bug 4 fix: read-back verification — done OUTSIDE the lock so other
            # threads can acquire it immediately after the write completes.
            # RC3 FIX: moved from inside the lock to reduce lock contention.
            verify_df = pd.read_parquet(file_path)
            if len(verify_df) != len(merged):
                raise RuntimeError(
                    f"Write FAILED for {file_path.name}: "
                    f"wrote {len(merged)} bars but disk has {len(verify_df)}"
                )
            verify_last = pd.to_datetime(verify_df['timestamp']).max()
            merged_last = pd.to_datetime(merged['timestamp']).max()
            if verify_last != merged_last:
                raise RuntimeError(
                    f"Write FAILED for {file_path.name}: "
                    f"last timestamp mismatch — expected {merged_last}, got {verify_last}"
                )
            logger.info(f"      Verified {len(verify_df)} bars on disk, last={verify_last}")

    def run_gap_report(
        self,
        timeframes: Optional[List[str]] = None,
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None,
    ) -> Dict[str, List[Dict]]:
        """
        Produce a structured gap report for all requested timeframes.

        Args:
            timeframes: List of timeframes to check (default: ['15m', '1h']).
            start_date: Only check gaps after this date.
            end_date:   Only check gaps before this date.

        Returns:
            Dict mapping timeframe → list of gap dicts (see detect_gaps_in_binance_files).
        """
        if timeframes is None:
            timeframes = ['15m', '1h', '1d']

        report: Dict[str, List[Dict]] = {}

        logger.info("\n" + "=" * 60)
        logger.info("GAP DETECTION REPORT")
        logger.info(f"Timeframes: {', '.join(timeframes)}")
        logger.info(f"Start filter: {start_date or 'none'}")
        logger.info(f"End filter:   {end_date or 'none'}")
        logger.info("=" * 60)

        for tf in timeframes:
            gaps = self.detect_gaps_in_binance_files(tf, start_date, end_date)
            report[tf] = gaps

            if gaps:
                total_missing = sum(g['missing_bars'] for g in gaps)
                logger.info(f"\n[{tf}] {len(gaps)} gap(s) found, ~{total_missing} missing bars:")
                for g in gaps:
                    logger.info(f"   {g['gap_start']} → {g['gap_end']} "
                        f"({g['duration']}, ~{g['missing_bars']} bars)")
            else:
                logger.info(f"\n[{tf}] No gaps detected — data is continuous.")

        logger.info("\n" + "=" * 60)
        return report

    def verify_and_repair(
        self,
        timeframes: Optional[List[str]] = None,
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None,
        dry_run: bool = False,
        symbol: str = 'BTCUSDT',
        futures: bool = True,
        binance_api_horizon_days: int = 90,
    ) -> Dict[str, Dict]:
        """
        Detect gaps in stored Binance OHLCV data and repair them automatically.

        This is the primary data-quality entry point.  Call it on startup to
        ensure the data layer is healthy before strategies run, or call it
        on-demand after a suspected outage.

        Repair strategy
        ---------------
        * Gaps within Binance API horizon (≤ ``binance_api_horizon_days`` old):
          fetched from Binance via :meth:`_fetch_binance_range` (uses explicit
          startTime/endTime — the root-cause fix).
        * Gaps older than the Binance API horizon: logged as un-repairable via
          Binance; LakeAPI backfill must be triggered separately.

        Args:
            timeframes:  Timeframes to check (default ['15m', '1h']).
            start_date:  Restrict gap search to dates after this (default: 90
                         days ago to match the Binance API window).
            end_date:    Restrict gap search to dates before this (default: now).
            dry_run:     If True, detect and report gaps but do NOT fetch or
                         save any data.
            symbol:      Binance symbol (default 'BTCUSDT').
            futures:     Use Binance Futures endpoint (default True).
            binance_api_horizon_days: Gaps older than this many days cannot be
                         repaired from Binance and are flagged for manual action.

        Returns:
            Dict keyed by timeframe with repair summary::

                {
                    '15m': {
                        'gaps_found': int,
                        'gaps_repaired': int,
                        'gaps_too_old': int,
                        'bars_fetched': int,
                        'errors': [str, ...],
                    },
                    ...
                }

        Example::

            >>> manager = UnifiedDataManager(mode='live')
            >>> report = manager.verify_and_repair()
            >>> # Run on startup:
            >>> manager.verify_and_repair(dry_run=True)  # just report
            >>> manager.verify_and_repair()               # repair
        """
        if timeframes is None:
            timeframes = ['15m', '1h', '1d']
        if end_date is None:
            end_date = datetime.now(timezone.utc)
        elif end_date.tzinfo is None:
            end_date = end_date.replace(tzinfo=timezone.utc)
        if start_date is None:
            start_date = end_date - timedelta(days=binance_api_horizon_days)
        elif start_date.tzinfo is None:
            start_date = start_date.replace(tzinfo=timezone.utc)

        horizon_cutoff = datetime.now(timezone.utc) - timedelta(days=binance_api_horizon_days)

        t0_total = _time_mod.monotonic()
        logger.info("\n" + "=" * 60)
        logger.info("VERIFY AND REPAIR — DATA INTEGRITY CHECK")
        logger.info(f"Mode: {'DRY RUN (no writes)' if dry_run else 'LIVE REPAIR'}")
        logger.info(f"Scope: {start_date.date()} → {end_date.date()}")
        logger.info(f"Timeframes: {', '.join(timeframes)}")
        logger.info(f"Binance API horizon: {binance_api_horizon_days} days")
        logger.info("=" * 60)

        summary: Dict[str, Dict] = {}

        for tf in timeframes:
            t0_tf = _time_mod.monotonic()
            logger.info(f"\n--- Checking {tf} ---")

            tf_minutes = {
                '1m': 1, '5m': 5, '15m': 15, '30m': 30,
                '1h': 60, '4h': 240, '1d': 1440,
            }
            bar_td = timedelta(minutes=tf_minutes.get(tf, 15))

            t0_detect = _time_mod.monotonic()
            gaps = self.detect_gaps_in_binance_files(
                tf, start_date=start_date, end_date=end_date
            )
            logger.info(f"   [timing] detect_gaps/{tf}: {_time_mod.monotonic() - t0_detect:.2f}s")

            tf_summary: Dict = {
                'gaps_found': len(gaps),
                'gaps_repaired': 0,
                'gaps_too_old': 0,
                'bars_fetched': 0,
                'errors': [],
            }

            if not gaps:
                logger.info(f"   ✅ No gaps found — {tf} data is continuous in range.")
            else:
                total_missing = sum(g['missing_bars'] for g in gaps)
                logger.info(f"   Found {len(gaps)} gap(s), ~{total_missing} missing bars total.")

            for gap in gaps:
                gap_start: datetime = gap['gap_start']
                gap_end: datetime = gap['gap_end']
                missing: int = gap['missing_bars']

                # Normalize gap dates to UTC-aware to match horizon_cutoff
                if gap_start.tzinfo is None:
                    gap_start = gap_start.replace(tzinfo=timezone.utc)
                if gap_end.tzinfo is None:
                    gap_end = gap_end.replace(tzinfo=timezone.utc)

                logger.info(f"   Gap: {gap_start} → {gap_end} "
                    f"(~{missing} bars, duration {gap['duration']})")

                # Determine if gap is within Binance API range
                if gap_start < horizon_cutoff:
                    msg = (
                        f"Gap starting {gap_start} is older than {binance_api_horizon_days}d "
                        "Binance horizon — cannot auto-repair from Binance. "
                        "Consider LakeAPI backfill."
                    )
                    logger.warning(f"   ⚠️  {msg}")
                    logger.warning(msg)
                    tf_summary['gaps_too_old'] += 1
                    continue

                if dry_run:
                    logger.info(f"   [DRY RUN] Would fetch {gap_start} → {gap_end}")
                    continue

                # Fetch from Binance with explicit startTime/endTime
                logger.info(f"   🌐 Fetching from Binance ({gap_start} → {gap_end}) ...")
                try:
                    # fetch_start: one bar after the last-good bar (gap_start)
                    # fetch_end:   one bar before the first-bar-after-gap (gap_end)
                    # For single-missing-bar gaps: fetch_end = gap_end - bar_td
                    # == gap_start + bar_td, so fetch_start == fetch_end (same bar).
                    # Accept this — _fetch_binance_range handles the 1-bar window.
                    #
                    # NOTE: BINANCE_PROPAGATION_BUFFER is NOT added to fetch_start.
                    # The scheduler fires 0.2s after the boundary so the API call
                    # is already naturally delayed.  Adding +2 s to startTime causes
                    # Binance to see startTime=07:45:02 for a bar that opens at
                    # 07:45:00 — Binance returns nothing because startTime is past
                    # the bar open.  The filter_start guard in _fetch_binance_range
                    # handles any sub-second edge cases on the result side.
                    fetch_start = gap_start + bar_td
                    fetch_end = gap_end - bar_td

                    if fetch_end < fetch_start:
                        # Degenerate case: gap spans less than one bar period.
                        logger.warning(f"   ⚠️  Gap smaller than one bar period — skipping.")
                        continue

                    t0_fetch = _time_mod.monotonic()
                    new_bars = self._fetch_binance_range(
                        timeframe=tf,
                        start_ts=fetch_start,
                        end_ts=fetch_end,
                        symbol=symbol,
                        futures=futures,
                    )
                    logger.info(f"   [timing] fetch/{tf}: {_time_mod.monotonic() - t0_fetch:.2f}s")

                    if new_bars.empty:
                        # For trailing-edge gaps (fetch_start within the last 2 bar
                        # periods), the bar may not yet be finalized by Binance.
                        # Poll every 2 seconds for up to 20 seconds before giving up.
                        # Historical gaps are not retried — their data is either present
                        # or absent and retrying won't help.
                        age_seconds = (datetime.now(timezone.utc) - fetch_start).total_seconds()
                        is_trailing_edge = age_seconds <= (2 * bar_td.total_seconds())

                        if is_trailing_edge:
                            MAX_RETRIES = 10
                            RETRY_INTERVAL_S = 2
                            logger.info(
                                f"   [propagation] bar not yet available — "
                                f"polling every {RETRY_INTERVAL_S}s (max {MAX_RETRIES} retries)"
                            )
                            for retry_n in range(MAX_RETRIES):
                                _time_mod.sleep(RETRY_INTERVAL_S)
                                new_bars = self._fetch_binance_range(
                                    timeframe=tf,
                                    start_ts=fetch_start,
                                    end_ts=fetch_end,
                                    symbol=symbol,
                                    futures=futures,
                                )
                                if not new_bars.empty:
                                    elapsed = (retry_n + 1) * RETRY_INTERVAL_S
                                    logger.info(
                                        f"   [propagation] bar available after "
                                        f"{elapsed}s ({retry_n + 1} retries)"
                                    )
                                    break
                            else:
                                msg = (
                                    f"Bar not available after "
                                    f"{MAX_RETRIES * RETRY_INTERVAL_S}s: "
                                    f"{tf} {fetch_start}"
                                )
                                logger.warning(f"   ⚠️  {msg}")
                                tf_summary['errors'].append(msg)
                                continue
                        else:
                            msg = f"Binance returned no data for {tf} {fetch_start}→{fetch_end}"
                            logger.warning(f"   ⚠️  {msg}")
                            tf_summary['errors'].append(msg)
                            continue

                    logger.info(f"   ✅ Fetched {len(new_bars)} bars.")
                    t0_save = _time_mod.monotonic()
                    self._save_binance_bars(new_bars, tf)
                    logger.info(f"   [timing] save/{tf}: {_time_mod.monotonic() - t0_save:.2f}s")

                    tf_summary['gaps_repaired'] += 1
                    tf_summary['bars_fetched'] += len(new_bars)

                except Exception as exc:
                    msg = f"Error repairing {tf} gap {gap_start}→{gap_end}: {exc}"
                    logger.error(f"   ❌ {msg}")
                    logger.error(msg)
                    tf_summary['errors'].append(msg)

            # P3 post-ingest sanity check (BTCAAAAA-997): verify data is complete
            # through end_date by checking the last stored bar is no more than 5s
            # older than the last expected complete bar boundary.  We check one
            # direction only (too short, not too new) because the catalog may
            # legitimately extend past the repair window.
            if not dry_run:
                last_stored = self.get_last_bar_timestamp(tf)
                if last_stored is not None:
                    end_naive = end_date.replace(tzinfo=None) if end_date.tzinfo is not None else end_date
                    epoch = datetime(1970, 1, 1)
                    bar_secs = bar_td.total_seconds()
                    elapsed_s = (end_naive - epoch).total_seconds()
                    # Last complete bar: the bar that opened at floor(end_date, bar_td)
                    # minus one bar_td (the current bar may still be open).
                    expected_last_ts = epoch + timedelta(
                        seconds=(int(elapsed_s // bar_secs) - 1) * bar_secs
                    )
                    # Warn only if last_stored is older than expected (data too short).
                    # If last_stored >= expected_last_ts the catalog extends past end_date — OK.
                    deficit_s = (expected_last_ts - last_stored).total_seconds()
                    if deficit_s > 5:
                        msg = (
                            f"Post-ingest sanity FAILED for {tf}: "
                            f"last_stored={last_stored} expected≥{expected_last_ts} "
                            f"(data is {deficit_s:.1f}s short)"
                        )
                        logger.warning(f"   ⚠️  {msg}")
                        tf_summary['errors'].append(msg)
                    else:
                        logger.info(
                            f"   ✅ Sanity OK — last stored {last_stored} "
                            f"covers through expected {expected_last_ts}"
                        )

            summary[tf] = tf_summary
            logger.info(f"   [timing] total/{tf}: {_time_mod.monotonic() - t0_tf:.2f}s")

        # Final summary
        logger.info("\n" + "=" * 60)
        logger.info(f"REPAIR SUMMARY (total wall-clock: {_time_mod.monotonic() - t0_total:.2f}s)")
        logger.info("=" * 60)
        for tf, s in summary.items():
            status = "✅" if s['gaps_found'] == 0 or s['gaps_repaired'] == s['gaps_found'] - s['gaps_too_old'] else "⚠️"
            logger.info(f"{status} {tf}: "
                f"{s['gaps_found']} gap(s) found | "
                f"{s['gaps_repaired']} repaired | "
                f"{s['gaps_too_old']} too old | "
                f"{s['bars_fetched']} bars fetched")
            for err in s['errors']:
                logger.error(f"   ❌ {err}")
        logger.info("=" * 60 + "\n")

        return summary

    def startup_check(
        self,
        timeframes: Optional[List[str]] = None,
        auto_repair: bool = True,
        lookback_days: int = 7,
    ) -> Dict[str, Dict]:
        """
        Lightweight startup continuity check (fast path for live trading).

        Checks only the last ``lookback_days`` days so startup stays fast.
        If gaps are found and ``auto_repair=True``, triggers
        :meth:`verify_and_repair` for that window.

        Args:
            timeframes:    Timeframes to check (default ['15m', '1h']).
            auto_repair:   Automatically repair any detected gaps.
            lookback_days: How many days back to check (default 7).

        Returns:
            Same structure as :meth:`verify_and_repair`.
        """
        if timeframes is None:
            timeframes = ['15m', '1h', '1d']

        start_date = (datetime.now(timezone.utc) - timedelta(days=lookback_days)).replace(tzinfo=None)
        end_date = datetime.now(timezone.utc).replace(tzinfo=None)
        logger.info(f"\n🔍 Startup continuity check (last {lookback_days} days)...")

        # Quick gap scan — pass end_date so trailing-edge gaps (last bar on disk
        # vs. now) are included in the detection window.
        all_clean = True
        for tf in timeframes:
            gaps = self.detect_gaps_in_binance_files(tf, start_date=start_date, end_date=end_date)
            if gaps:
                all_clean = False
                logger.warning(f"   ⚠️  {tf}: {len(gaps)} gap(s) detected in last {lookback_days} days.")

        if all_clean:
            logger.info(f"   ✅ All timeframes clean for last {lookback_days} days.")
            return {tf: {'gaps_found': 0, 'gaps_repaired': 0,
                         'gaps_too_old': 0, 'bars_fetched': 0, 'errors': []}
                    for tf in timeframes}

        if auto_repair:
            return self.verify_and_repair(
                timeframes=timeframes,
                start_date=start_date,
                end_date=end_date,
            )
        else:
            return self.run_gap_report(timeframes=timeframes, start_date=start_date, end_date=end_date)


# Convenience function
def get_bars(
    timeframe: str = '15m',
    count: Optional[int] = None,
    start_date: Optional[datetime] = None,
    end_date: Optional[datetime] = None
) -> pd.DataFrame:
    """
    Convenience function to get bars
    
    Args:
        timeframe: Bar timeframe
        count: Number of bars (for warmup)
        start_date: Start date (for range)
        end_date: End date (for range)
    
    Returns:
        DataFrame with bars
    
    Example:
        >>> # Quick warmup for strategy
        >>> bars = get_bars('15m', count=1000)
        >>> 
        >>> # Specific date range
        >>> bars = get_bars('15m', start_date=datetime(2025, 12, 1))
    """
    manager = UnifiedDataManager()
    return manager.get_bars(timeframe, count, start_date, end_date)
