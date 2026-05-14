"""
Bar Aggregator - Convert trades to OHLCV bars

Institutional-grade bar aggregation for NautilusTrader strategies.
Converts raw trade data into time-based OHLCV bars with proper
timestamp alignment and volume aggregation.
"""

import pandas as pd
import numpy as np
from pathlib import Path
from datetime import datetime, timedelta
from typing import Optional, Union, List
import gc
import os
from concurrent.futures import ProcessPoolExecutor, as_completed
from functools import partial

from ..config import RAW_DATA_DIR, TIMEFRAME_MAPPING, TIMEFRAMES

import logging
logger = logging.getLogger(__name__)

class BarAggregator:
    """
    Convert trade data to OHLCV bars
    
    Features:
    - Multiple timeframe support (5min, 15min, 1h, etc.)
    - Proper timestamp alignment
    - Volume aggregation (BTC and USDT)
    - Trade count per bar
    - Memory-efficient processing
    - Data validation
    
    Example:
        >>> agg = BarAggregator()
        >>> bars = agg.aggregate_month('trades', 2025, 12, '15min')
        >>> len(bars)
        2976  # 31 days * 24 hours * 4 (15min bars)
    """
    
    def __init__(self):
        """Initialize bar aggregator"""
        self.supported_timeframes = TIMEFRAMES
        self.timeframe_mapping = TIMEFRAME_MAPPING
        
    def aggregate_from_file(
        self,
        file_path: Union[str, Path],
        timeframe: str = '15min',
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None
    ) -> pd.DataFrame:
        """
        Aggregate trades from file into bars
        
        Args:
            file_path: Path to trades parquet file
            timeframe: Timeframe for bars ('5min', '15min', '1h', etc.)
            start_date: Optional start date filter
            end_date: Optional end date filter
        
        Returns:
            DataFrame with OHLCV bars
        
        Raises:
            ValueError: If timeframe not supported
            FileNotFoundError: If file not found
        
        Example:
            >>> agg = BarAggregator()
            >>> bars = agg.aggregate_from_file(
            ...     'data/raw/trades/BTC-USDT_trades_2025-12.parquet',
            ...     timeframe='15min'
            ... )
        """
        # Validate timeframe
        if timeframe not in self.supported_timeframes:
            raise ValueError(
                f"Timeframe '{timeframe}' not supported. "
                f"Supported: {self.supported_timeframes}"
            )
        
        # Check file exists
        file_path = Path(file_path)
        if not file_path.exists():
            raise FileNotFoundError(f"File not found: {file_path}")
        
        logger.info(f"📊 Aggregating {file_path.name} to {timeframe} bars...")
        
        # Load trades
        logger.info(f"   Loading trades...")
        df = pd.read_parquet(file_path)
        logger.info(f" ✅ ({len(df):,} trades)")
        
        # Prepare for aggregation
        bars = self._aggregate_trades(df, timeframe, start_date, end_date)
        
        logger.info(f"   Generated {len(bars):,} {timeframe} bars")
        
        # Validate output
        self._validate_bars(bars, timeframe)
        
        # Memory cleanup
        del df
        gc.collect()
        
        return bars
    
    def aggregate_month(
        self,
        data_type: str,
        year: int,
        month: int,
        timeframe: str = '15min'
    ) -> pd.DataFrame:
        """
        Aggregate a full month of data into bars
        
        Args:
            data_type: Data type ('trades')
            year: Year
            month: Month (1-12)
            timeframe: Timeframe for bars
        
        Returns:
            DataFrame with OHLCV bars
        
        Example:
            >>> agg = BarAggregator()
            >>> bars = agg.aggregate_month('trades', 2025, 12, '15min')
        """
        # Build file path
        month_str = f"{year}-{month:02d}"
        file_path = RAW_DATA_DIR / data_type / f"BTC-USDT_{data_type}_{month_str}.parquet"
        
        return self.aggregate_from_file(file_path, timeframe)
    
    def aggregate_date_range(
        self,
        data_type: str,
        start_date: datetime,
        end_date: datetime,
        timeframe: str = '15min',
        use_parallel: bool = True
    ) -> pd.DataFrame:
        """
        Aggregate data across multiple months (PARALLEL PROCESSING)
        
        Uses 98% of available CPUs (31 of 32 cores on production server)
        to process month files in parallel for massive speedup.
        
        Args:
            data_type: Data type ('trades')
            start_date: Start date
            end_date: End date
            timeframe: Timeframe for bars
            use_parallel: Use parallel processing (default: True)
        
        Returns:
            DataFrame with OHLCV bars spanning date range
        
        Example:
            >>> agg = BarAggregator()
            >>> bars = agg.aggregate_date_range(
            ...     'trades',
            ...     datetime(2025, 11, 1),
            ...     datetime(2025, 12, 31),
            ...     '15min'
            ... )
        """
        # Determine which months needed
        current = start_date.replace(day=1)
        end_month = end_date.replace(day=1)
        
        months_to_process = []
        while current <= end_month:
            months_to_process.append((current.year, current.month))
            # Next month
            if current.month == 12:
                current = current.replace(year=current.year + 1, month=1)
            else:
                current = current.replace(month=current.month + 1)
        
        # Use parallel processing if multiple months and enabled
        if use_parallel and len(months_to_process) > 1:
            all_bars = self._aggregate_months_parallel(
                data_type,
                months_to_process,
                timeframe
            )
        else:
            # Sequential processing (single month or parallel disabled)
            all_bars = []
            for year, month in months_to_process:
                try:
                    month_bars = self.aggregate_month(data_type, year, month, timeframe)
                    all_bars.append(month_bars)
                except FileNotFoundError:
                    logger.warning(f"⚠️  No data for {year}-{month:02d}")
        
        if not all_bars:
            raise ValueError(f"No data found for date range")
        
        # Concatenate all months
        bars = pd.concat(all_bars, ignore_index=True)
        
        # Filter to exact date range
        bars = bars[
            (bars['timestamp'] >= start_date) &
            (bars['timestamp'] <= end_date)
        ].copy()
        
        return bars
    
    def _aggregate_months_parallel(
        self,
        data_type: str,
        months: List[tuple],
        timeframe: str,
        progress_queue=None
    ) -> List[pd.DataFrame]:
        """
        Process multiple month files in parallel using 98% of available CPUs
        
        ENHANCED: Queue-based progress reporting for multiprocess stdout capture
        
        Args:
            data_type: Data type ('trades')
            months: List of (year, month) tuples
            timeframe: Timeframe for bars
            progress_queue: Optional Queue for progress messages from workers
        
        Returns:
            List of DataFrames (one per month)
        """
        # Calculate number of workers: 98% of available CPUs
        # Leave 1-2 cores for system (on 32-core: use 31 cores)
        total_cpus = os.cpu_count() or 4
        max_workers = max(1, int(total_cpus * 0.98))
        
        msg = f"   ⚡ Parallel processing: {len(months)} months using {max_workers}/{total_cpus} CPUs"
        logger.info(msg)
        if progress_queue:
            progress_queue.put(msg)
        
        # Create partial function with fixed arguments including queue
        process_func = partial(
            _process_single_month,
            data_type=data_type,
            timeframe=timeframe,
            progress_queue=progress_queue
        )
        
        results = []
        with ProcessPoolExecutor(max_workers=max_workers) as executor:
            # Submit all tasks
            future_to_month = {
                executor.submit(process_func, year, month): (year, month)
                for year, month in months
            }
            
            # Collect results as they complete
            for future in as_completed(future_to_month):
                year, month = future_to_month[future]
                try:
                    month_bars = future.result()
                    if month_bars is not None:
                        results.append((year, month, month_bars))
                except Exception as e:
                    error_msg = f"   ❌ Error processing {year}-{month:02d}: {e}"
                    logger.info(error_msg)
                    if progress_queue:
                        progress_queue.put(error_msg)
        
        # Sort by month order and extract DataFrames
        results.sort(key=lambda x: (x[0], x[1]))
        return [bars for _, _, bars in results]
    
    def _aggregate_trades(
        self,
        df: pd.DataFrame,
        timeframe: str,
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None
    ) -> pd.DataFrame:
        """
        Core aggregation logic
        
        Args:
            df: Trade data
            timeframe: Timeframe for bars
            start_date: Optional start date filter
            end_date: Optional end date filter
        
        Returns:
            DataFrame with OHLCV bars
        """
        logger.info(f"   Aggregating to {timeframe}...")
        
        # Convert timestamp to datetime
        # LakeAPI uses 'origin_time' column
        if 'origin_time' in df.columns:
            df['dt'] = pd.to_datetime(df['origin_time'])
        elif 'timestamp' in df.columns:
            df['dt'] = pd.to_datetime(df['timestamp'], unit='ms')
        elif 'datetime' in df.columns:
            df['dt'] = pd.to_datetime(df['datetime'])
        else:
            raise ValueError(f"No timestamp column found. Available columns: {df.columns.tolist()}")
        
        # Filter date range if specified
        if start_date:
            df = df[df['dt'] >= start_date].copy()
        if end_date:
            df = df[df['dt'] <= end_date].copy()
        
        # Set datetime as index for resampling
        df = df.set_index('dt')
        
        # Get pandas resample frequency
        freq = self.timeframe_mapping[timeframe]
        
        # Aggregate into OHLCV bars
        # Use label='left' to label bars with their start time
        # LakeAPI uses 'quantity' for volume (not 'size')
        volume_col = 'quantity' if 'quantity' in df.columns else 'size'
        
        bars = df.resample(freq, label='left', closed='left').agg({
            'price': ['first', 'max', 'min', 'last'],  # OHLC
            volume_col: 'sum',  # Total volume in BTC
        })
        
        # Flatten column names
        bars.columns = ['open', 'high', 'low', 'close', 'volume']
        
        # Add count of trades per bar
        trade_counts = df.resample(freq, label='left', closed='left').size()
        bars['trade_count'] = trade_counts
        
        # Calculate volume in USDT (volume * average price)
        bars['volume_usd'] = bars['volume'] * ((bars['open'] + bars['close']) / 2)
        
        # Remove bars with no trades (NaN values)
        bars = bars.dropna(subset=['open'])
        
        # Reset index to get timestamp as column
        bars = bars.reset_index()
        bars = bars.rename(columns={'dt': 'timestamp'})
        
        # Add bar metadata
        bars['timeframe'] = timeframe
        bars['symbol'] = 'BTC-USDT'
        
        # Reorder columns
        bars = bars[[
            'timestamp',
            'symbol',
            'timeframe',
            'open',
            'high',
            'low',
            'close',
            'volume',
            'volume_usd',
            'trade_count'
        ]]
        
        logger.info(" ✅")
        
        return bars
    
    def _validate_bars(self, bars: pd.DataFrame, timeframe: str):
        """
        Validate generated bars
        
        Args:
            bars: Generated bars
            timeframe: Timeframe used
        
        Raises:
            ValueError: If validation fails
        """
        logger.info(f"   Validating bars...")
        
        # Check required columns
        required_cols = ['timestamp', 'open', 'high', 'low', 'close', 'volume']
        missing = [col for col in required_cols if col not in bars.columns]
        if missing:
            raise ValueError(f"Missing columns: {missing}")
        
        # Check OHLC logic
        invalid_high = (bars['high'] < bars['low']).sum()
        if invalid_high > 0:
            raise ValueError(f"Found {invalid_high} bars with high < low")
        
        invalid_open = (bars['open'] > bars['high']).sum()
        if invalid_open > 0:
            raise ValueError(f"Found {invalid_open} bars with open > high")
        
        invalid_close = (bars['close'] > bars['high']).sum()
        if invalid_close > 0:
            raise ValueError(f"Found {invalid_close} bars with close > high")
        
        # Check for negative values
        if (bars['volume'] < 0).any():
            raise ValueError("Found negative volume")
        
        # Check for NaN values
        if bars[required_cols].isna().any().any():
            raise ValueError("Found NaN values in critical columns")
        
        # Check timestamp continuity
        # Allow some gaps (market closures, data issues)
        expected_minutes = {
            '5min': 5,
            '15min': 15,
            '30min': 30,
            '1h': 60,
            '2h': 120,
            '4h': 240,
            '6h': 360,
            '12h': 720,
            '1d': 1440
        }
        
        if timeframe in expected_minutes:
            bars_sorted = bars.sort_values('timestamp')
            time_diffs = bars_sorted['timestamp'].diff()
            expected_diff = pd.Timedelta(minutes=expected_minutes[timeframe])
            
            # Check for gaps > 2x expected (allow some flexibility)
            large_gaps = time_diffs[time_diffs > expected_diff * 2].count()
            if large_gaps > len(bars) * 0.01:  # More than 1% gaps
                logger.warning(f" ⚠️  {large_gaps} time gaps detected")
        
        logger.info(" ✅")
    
    def get_last_n_bars(
        self,
        data_type: str,
        n_bars: int,
        timeframe: str = '15min',
        end_date: Optional[datetime] = None
    ) -> pd.DataFrame:
        """
        Get last N bars up to specified date
        
        Useful for 1000-bar warmup for strategies
        
        Args:
            data_type: Data type ('trades')
            n_bars: Number of bars to retrieve
            timeframe: Timeframe for bars
            end_date: End date (default: today)
        
        Returns:
            DataFrame with last N bars
        
        Example:
            >>> agg = BarAggregator()
            >>> # Get last 1000 15min bars for warmup
            >>> bars = agg.get_last_n_bars('trades', 1000, '15min')
        """
        if end_date is None:
            end_date = datetime.now()
        
        # Estimate how many months back we need
        # Rough calculation: bars per day * days needed
        minutes_map = {
            '5min': 5, '15min': 15, '30min': 30,
            '1h': 60, '2h': 120, '4h': 240,
            '6h': 360, '12h': 720, '1d': 1440
        }
        
        minutes = minutes_map.get(timeframe, 15)
        bars_per_day = (24 * 60) / minutes
        days_needed = int((n_bars / bars_per_day) * 1.5)  # 50% buffer
        
        start_date = end_date - timedelta(days=days_needed)
        
        # Get bars for range
        bars = self.aggregate_date_range(
            data_type,
            start_date,
            end_date,
            timeframe
        )
        
        # Return last N bars
        return bars.tail(n_bars).copy()
    
    def save_bars(
        self,
        bars: pd.DataFrame,
        output_path: Union[str, Path],
        compression: str = 'snappy'
    ):
        """
        Save bars to parquet file
        
        Args:
            bars: Bar data
            output_path: Output file path
            compression: Compression method ('snappy', 'gzip', 'none')
        
        Example:
            >>> agg = BarAggregator()
            >>> bars = agg.aggregate_month('trades', 2025, 12, '15min')
            >>> agg.save_bars(
            ...     bars,
            ...     'data/bars/BTC-USDT_15min_2025-12.parquet'
            ... )
        """
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        
        bars.to_parquet(
            output_path,
            engine='pyarrow',
            compression=compression,
            index=False
        )
        
        file_size = output_path.stat().st_size / 1024 / 1024
        logger.info(f"💾 Saved {len(bars):,} bars to {output_path.name} ({file_size:.1f} MB)")


# Module-level worker function for multiprocessing (must be picklable)
def _process_single_month(
    year: int,
    month: int,
    data_type: str,
    timeframe: str,
    progress_queue=None
) -> Optional[pd.DataFrame]:
    """
    Worker function to process a single month in parallel
    
    ENHANCED: Queue-based progress reporting to parent process
    
    Args:
        year: Year
        month: Month
        data_type: Data type ('trades')
        timeframe: Timeframe for bars
        progress_queue: Optional Queue for sending progress messages
    
    Returns:
        DataFrame with bars or None if file not found
    """
    # NOTE: Database fork handling now done via os.register_at_fork() in DatabaseManager
    # No manual cleanup needed here - fork handler automatically disposes engine in child processes
    
    try:
        # Send start message
        msg = f"📊 Aggregating BTC-USDT_trades_{year}-{month:02d}.parquet to {timeframe} bars..."
        logger.info(msg)
        if progress_queue:
            progress_queue.put(msg)
        
        # Note: We can't easily redirect the detailed progress from aggregate_month
        # because it uses print() statements. To fully capture, we'd need to
        # restructure to use logging or capture stdout in each worker.
        # For now, just send start/end messages.
        
        agg = BarAggregator()
        result = agg.aggregate_month(data_type, year, month, timeframe)
        
        # Send completion message
        if result is not None:
            completion_msg = f"   ✅ {year}-{month:02d}: {len(result):,} bars loaded"
            logger.info(completion_msg)
            if progress_queue:
                progress_queue.put(completion_msg)
        
        return result
        
    except FileNotFoundError:
        msg = f"   ⚠️  No data for {year}-{month:02d}"
        logger.info(msg)
        if progress_queue:
            progress_queue.put(msg)
        return None
    except Exception as e:
        msg = f"   ❌ Error processing {year}-{month:02d}: {e}"
        logger.info(msg)
        if progress_queue:
            progress_queue.put(msg)
        return None


def aggregate_and_save_month(
    data_type: str,
    year: int,
    month: int,
    timeframes: Optional[List[str]] = None,
    output_dir: Optional[Path] = None
):
    """
    Convenience function to aggregate and save multiple timeframes
    
    Args:
        data_type: Data type ('trades')
        year: Year
        month: Month
        timeframes: List of timeframes (default: main trading timeframes)
        output_dir: Output directory (default: data/bars/)
    
    Example:
        >>> # Generate all main timeframes for December 2025
        >>> aggregate_and_save_month('trades', 2025, 12)
    """
    if timeframes is None:
        timeframes = ['5min', '15min', '30min', '1h', '4h', '1d']
    
    if output_dir is None:
        output_dir = RAW_DATA_DIR.parent / 'bars'
    
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    
    agg = BarAggregator()
    month_str = f"{year}-{month:02d}"
    
    logger.info(f"\n{'='*60}")
    logger.info(f"AGGREGATING {month_str} - {len(timeframes)} TIMEFRAMES")
    logger.info(f"{'='*60}\n")
    
    for tf in timeframes:
        try:
            bars = agg.aggregate_month(data_type, year, month, tf)
            
            output_file = output_dir / f"BTC-USDT_{tf}_{month_str}.parquet"
            agg.save_bars(bars, output_file)
            
        except Exception as e:
            logger.error(f"❌ Error aggregating {tf}: {e}")
    
    logger.info(f"\n{'='*60}")
    logger.info(f"AGGREGATION COMPLETE")
    logger.info(f"{'='*60}\n")
