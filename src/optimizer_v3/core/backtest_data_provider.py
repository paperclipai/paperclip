"""
Backtest Data Provider - Real Data Integration

Provides clean interface to DataManager for backtest execution.
Handles data loading, validation, and error recovery.

CRITICAL: NO HARDCODED DATA - ALL FROM DataManager!

Sprint 2.0.1 Task 2.0.1.2 - BacktestDataProvider Class
Author: BTC_Engine_v3
Date: 2026-02-06
"""

from typing import Optional, List, Callable, Dict
from datetime import datetime
import threading

from nautilus_trader.model.data import Bar
from src.data_manager.unified_manager import UnifiedDataManager
from src.data_manager.nautilus_loader import NautilusDataLoader

import logging
logger = logging.getLogger(__name__)

class BacktestDataProvider:
    """
    Data provider for backtesting (Mode 1 & Mode 2)
    
    Features:
    - Loads bars from DataManager
    - Converts to NautilusTrader format
    - Progress tracking
    - Error recovery
    - Thread-safe operations
    - Caching for repeated requests
    
    Usage:
        provider = BacktestDataProvider()
        bars = provider.load_bars_for_backtest(
            timeframe='15m',
            start_date=datetime(2025, 12, 1),
            end_date=datetime(2025, 12, 31),
            progress_callback=lambda c, t, m: print(f"{c}/{t}: {m}")
        )
    """
    
    def __init__(self):
        """Initialize data provider"""
        self.unified_manager = UnifiedDataManager()
        self.nautilus_loader = NautilusDataLoader()
        self._lock = threading.Lock()
        self._cache = {}  # Cache for repeated requests
    
    def load_bars_for_backtest(
        self,
        timeframe: str,
        start_date: datetime,
        end_date: datetime,
        progress_callback: Optional[Callable[[int, int, str], None]] = None
    ) -> List[Bar]:
        """
        Load bars for backtesting with progress updates
        
        INSTITUTIONAL: Thread-safe, error-handled, progress-tracked
        
        Args:
            timeframe: Bar timeframe (e.g., '15m')
            start_date: Backtest start date
            end_date: Backtest end date
            progress_callback: Called with (current, total, message)
        
        Returns:
            List of NautilusTrader Bar objects (chronological order)
        
        Raises:
            ValueError: If no data available or invalid parameters
            RuntimeError: If loading fails
        
        Example:
            bars = provider.load_bars_for_backtest(
                timeframe='15m',
                start_date=datetime(2025, 12, 1),
                end_date=datetime(2025, 12, 31)
            )
            # Returns: [Bar(...), Bar(...), ...]  # ~3000 bars for 31 days
        """
        with self._lock:
            # Validate parameters
            if not timeframe:
                raise ValueError("Timeframe cannot be empty")
            if start_date >= end_date:
                raise ValueError(f"Start date {start_date} must be before end date {end_date}")
            
            # Check cache first
            cache_key = f"{timeframe}_{start_date}_{end_date}"
            if cache_key in self._cache:
                if progress_callback:
                    cached_bars = self._cache[cache_key]
                    progress_callback(len(cached_bars), len(cached_bars), 
                                    f"Loaded {len(cached_bars)} bars from cache")
                return self._cache[cache_key]
            
            try:
                # Progress: Starting
                if progress_callback:
                    progress_callback(0, 100, "Loading historical data from DataManager...")
                
                # Load bars using NautilusDataLoader
                bars = self.nautilus_loader.load_bars(
                    start=start_date,
                    end=end_date,
                    timeframe=timeframe
                )
                
                # Validate result
                if not bars or len(bars) == 0:
                    raise ValueError(
                        f"No data available for {timeframe} from "
                        f"{start_date.date()} to {end_date.date()}\n"
                        f"Check DataManager availability."
                    )
                
                # Verify chronological order
                for i in range(len(bars) - 1):
                    if bars[i].ts_event >= bars[i+1].ts_event:
                        raise RuntimeError(
                            f"Bars not in chronological order at index {i}:\n"
                            f"  Bar {i}: {bars[i].ts_event}\n"
                            f"  Bar {i+1}: {bars[i+1].ts_event}"
                        )
                
                # Progress: Complete
                if progress_callback:
                    progress_callback(100, 100, 
                                    f"✅ Loaded {len(bars):,} real bars from DataManager")
                
                # Cache result
                self._cache[cache_key] = bars
                
                return bars
                
            except Exception as e:
                error_msg = f"Failed to load bars: {str(e)}"
                if progress_callback:
                    progress_callback(0, 100, f"❌ ERROR: {error_msg}")
                raise RuntimeError(error_msg) from e
    
    def get_available_range(self, timeframe: str = '15m') -> Dict:
        """
        Get available data range for timeframe
        
        Args:
            timeframe: Bar timeframe
        
        Returns:
            Dict with 'earliest' and 'latest' datetimes
        
        Example:
            range_info = provider.get_available_range('15m')
            # Returns: {'earliest': datetime(2024, 1, 1), 
            #           'latest': datetime(2026, 2, 5)}
        """
        return self.unified_manager.get_available_date_range(timeframe)
    
    def validate_date_range(
        self,
        timeframe: str,
        start_date: datetime,
        end_date: datetime
    ) -> tuple[bool, str]:
        """
        Validate if requested date range is available
        
        Args:
            timeframe: Bar timeframe
            start_date: Requested start
            end_date: Requested end
        
        Returns:
            (is_valid, message)
        
        Example:
            valid, msg = provider.validate_date_range(
                '15m',
                datetime(2025, 12, 1),
                datetime(2025, 12, 31)
            )
            if not valid:
                logger.info(f"Invalid: {msg}")
        """
        available = self.get_available_range(timeframe)
        
        if start_date < available['earliest']:
            return False, (
                f"Start date {start_date.date()} before earliest available "
                f"{available['earliest'].date()}"
            )
        
        if end_date > available['latest']:
            return False, (
                f"End date {end_date.date()} after latest available "
                f"{available['latest'].date()}"
            )
        
        if start_date >= end_date:
            return False, "Start date must be before end date"
        
        # Calculate expected bar count (rough estimate)
        days = (end_date - start_date).days
        bars_per_day = (24 * 60) // 15  # 15m bars per day = 96
        expected_bars = days * bars_per_day
        
        return True, f"Valid range: ~{expected_bars:,} bars expected"
    
    def clear_cache(self):
        """Clear cached data (call when memory constrained)"""
        with self._lock:
            cleared = len(self._cache)
            self._cache.clear()
            return cleared


# Singleton instance for system-wide use
_backtest_provider = None

def get_backtest_provider() -> BacktestDataProvider:
    """
    Get singleton backtest data provider
    
    Returns:
        BacktestDataProvider instance
    
    Usage:
        provider = get_backtest_provider()
        bars = provider.load_bars_for_backtest(...)
    """
    global _backtest_provider
    if _backtest_provider is None:
        _backtest_provider = BacktestDataProvider()
    return _backtest_provider
