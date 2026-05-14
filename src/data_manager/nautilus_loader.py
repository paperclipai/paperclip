"""
NautilusTrader Data Loader - Seamless Integration

Provides NautilusTrader-compatible data loading using our unified manager.
Converts our data format to NautilusTrader's expected format.

This makes our data system fully compatible with NautilusTrader strategies!

Features:
- Load bars for backtesting
- Load bars for live/paper trading
- 1000-bar warmup support
- Proper timestamp handling
- NautilusTrader Bar format
- Instrument configuration

Author: BTC_Engine_v3
Date: January 8, 2026
"""

from datetime import datetime, timedelta
from typing import Optional, List
from pathlib import Path
import pandas as pd

from nautilus_trader.model.data import Bar, BarSpecification, BarType
from nautilus_trader.model.identifiers import InstrumentId, Symbol, Venue
from nautilus_trader.model.enums import BarAggregation, PriceType
from nautilus_trader.core.datetime import dt_to_unix_nanos
from nautilus_trader.model.objects import Price, Quantity

from .unified_manager import UnifiedDataManager

import logging
logger = logging.getLogger(__name__)

class NautilusDataLoader:
    """
    Data loader for NautilusTrader
    
    Converts our data to NautilusTrader format seamlessly
    
    Example:
        >>> loader = NautilusDataLoader()
        >>> 
        >>> # For backtesting
        >>> bars = loader.load_bars(
        ...     start=datetime(2025, 12, 1),
        ...     end=datetime(2025, 12, 31),
        ...     bar_type='15-MINUTE-BID'
        ... )
        >>> 
        >>> # For live trading warmup
        >>> bars = loader.load_warmup_bars(count=1000)
    """
    
    def __init__(
        self,
        instrument_id: Optional[InstrumentId] = None,
        venue: str = 'BINANCE'
    ):
        """
        Initialize NautilusTrader data loader
        
        Args:
            instrument_id: Instrument to load data for
            venue: Venue name (default: BINANCE)
        """
        self.manager = UnifiedDataManager()
        
        # Default instrument: BTC-USDT perpetual futures
        if instrument_id is None:
            self.instrument_id = InstrumentId(
                Symbol('BTC-USDT-PERP'),
                Venue(venue)
            )
        else:
            self.instrument_id = instrument_id
        
        logger.info(f"✅ NautilusTrader Data Loader initialized")
        logger.info(f"   Instrument: {self.instrument_id}")
    
    def load_bars(
        self,
        start: datetime,
        end: datetime,
        bar_type: str = '15-MINUTE-BID',
        timeframe: Optional[str] = None
    ) -> List[Bar]:
        """
        Load bars for backtesting
        
        Args:
            start: Start date
            end: End date
            bar_type: NautilusTrader bar type string
            timeframe: Override timeframe (e.g., '15m')
        
        Returns:
            List of NautilusTrader Bar objects
        
        Example:
            >>> bars = loader.load_bars(
            ...     start=datetime(2025, 12, 1),
            ...     end=datetime(2025, 12, 31),
            ...     bar_type='15-MINUTE-BID'
            ... )
        """
        # Parse bar type if not overridden
        if timeframe is None:
            timeframe = self._parse_timeframe(bar_type)
        
        logger.info(f"📊 Loading bars for NautilusTrader...")
        logger.info(f"   Timeframe: {timeframe}")
        logger.info(f"   Range: {start} to {end}")
        
        # Load from unified manager
        df = self.manager.get_bars(
            timeframe=timeframe,
            start_date=start,
            end_date=end
        )
        
        # Convert to NautilusTrader format
        nautilus_bars = self._convert_to_nautilus_bars(df, bar_type)
        
        logger.info(f"✅ Loaded {len(nautilus_bars)} bars for NautilusTrader")
        
        return nautilus_bars
    
    def load_warmup_bars(
        self,
        count: int = 1000,
        bar_type: str = '15-MINUTE-BID',
        timeframe: Optional[str] = None,
        end_date: Optional[datetime] = None
    ) -> List[Bar]:
        """
        Load warmup bars for live/paper trading
        
        This is THE critical function for strategy initialization!
        Gets last N bars for full context before live trading.
        
        Args:
            count: Number of bars (typically 1000)
            bar_type: NautilusTrader bar type string
            timeframe: Override timeframe
            end_date: End date (default: now)
        
        Returns:
            List of last N NautilusTrader Bar objects
        
        Example:
            >>> # Strategy initialization
            >>> bars = loader.load_warmup_bars(count=1000)
            >>> # Strategy now has 1000 bars of context!
        """
        # Parse bar type if not overridden
        if timeframe is None:
            timeframe = self._parse_timeframe(bar_type)
        
        logger.info(f"🔥 Loading {count}-bar warmup for strategy...")
        logger.info(f"   Timeframe: {timeframe}")
        
        # Load from unified manager
        df = self.manager.get_bars(
            timeframe=timeframe,
            count=count,
            end_date=end_date
        )
        
        # Convert to NautilusTrader format
        nautilus_bars = self._convert_to_nautilus_bars(df, bar_type)
        
        logger.info(f"✅ Warmup complete: {len(nautilus_bars)} bars ready")
        
        return nautilus_bars
    
    def _parse_timeframe(self, bar_type: str) -> str:
        """
        Parse NautilusTrader bar type to our timeframe format
        
        Args:
            bar_type: NautilusTrader format (e.g., '15-MINUTE-BID')
        
        Returns:
            Our format (e.g., '15m')
        """
        # NautilusTrader format: '15-MINUTE-BID', '1-HOUR-MID', etc.
        parts = bar_type.split('-')
        
        if len(parts) < 2:
            return '15m'  # Default
        
        value = int(parts[0])
        unit = parts[1].upper()
        
        # Convert to our format
        mapping = {
            'MINUTE': 'm',
            'HOUR': 'h',
            'DAY': 'd'
        }
        
        unit_short = mapping.get(unit, 'm')
        
        return f"{value}{unit_short}"
    
    def _convert_to_nautilus_bars(
        self,
        df: pd.DataFrame,
        bar_type_str: str
    ) -> List[Bar]:
        """
        Convert our DataFrame to NautilusTrader Bar objects
        
        Args:
            df: Our bar DataFrame
            bar_type_str: NautilusTrader bar type string
        
        Returns:
            List of NautilusTrader Bar objects
        """
        # Parse bar specification
        timeframe = self._parse_timeframe(bar_type_str)
        aggregation = self._get_bar_aggregation(timeframe)
        
        # Create BarType
        bar_spec = BarSpecification(
            step=int(timeframe.rstrip('mhd')),
            aggregation=aggregation,
            price_type=PriceType.LAST
        )
        
        bar_type = BarType(
            instrument_id=self.instrument_id,
            bar_spec=bar_spec
        )
        
        # Convert each row to Bar
        bars = []
        
        for idx, row in df.iterrows():
            try:
                # Convert timestamp to nanoseconds
                ts_event = dt_to_unix_nanos(pd.to_datetime(row['timestamp']))
                ts_init = ts_event  # For historical data, init = event
                
                # Create Price objects (8 decimal precision for BTC)
                open_price = Price(row['open'], precision=8)
                high_price = Price(row['high'], precision=8)
                low_price = Price(row['low'], precision=8)
                close_price = Price(row['close'], precision=8)
                
                # Create Quantity object (8 decimal precision)
                volume = Quantity(row['volume'], precision=8)
                
                # Create Bar
                bar = Bar(
                    bar_type=bar_type,
                    open=open_price,
                    high=high_price,
                    low=low_price,
                    close=close_price,
                    volume=volume,
                    ts_event=ts_event,
                    ts_init=ts_init
                )
                
                bars.append(bar)
                
            except Exception as e:
                logger.warning(f"⚠️  Skipping bar at {row.get('timestamp')}: {e}")
                continue
        
        return bars
    
    def _get_bar_aggregation(self, timeframe: str) -> BarAggregation:
        """
        Convert timeframe to NautilusTrader BarAggregation
        
        Args:
            timeframe: Our format (e.g., '15m')
        
        Returns:
            NautilusTrader BarAggregation enum
        """
        unit = timeframe[-1].lower()
        
        if unit == 'm':
            return BarAggregation.MINUTE
        elif unit == 'h':
            return BarAggregation.HOUR
        elif unit == 'd':
            return BarAggregation.DAY
        else:
            return BarAggregation.MINUTE  # Default
    
    def get_available_range(self) -> dict:
        """
        Get available data range
        
        Returns:
            Dict with earliest and latest available dates
        """
        return self.manager.get_available_date_range()


# Convenience function for quick use
def load_bars_for_backtest(
    start: datetime,
    end: datetime,
    timeframe: str = '15m'
) -> List[Bar]:
    """
    Quick function to load bars for backtesting
    
    Args:
        start: Start date
        end: End date
        timeframe: Timeframe
    
    Returns:
        List of NautilusTrader bars
    
    Example:
        >>> bars = load_bars_for_backtest(
        ...     start=datetime(2025, 12, 1),
        ...     end=datetime(2025, 12, 31),
        ...     timeframe='15m'
        ... )
    """
    loader = NautilusDataLoader()
    return loader.load_bars(start, end, timeframe=timeframe)


def load_warmup_bars(count: int = 1000, timeframe: str = '15m') -> List[Bar]:
    """
    Quick function to load warmup bars
    
    Args:
        count: Number of bars
        timeframe: Timeframe
    
    Returns:
        List of last N NautilusTrader bars
    
    Example:
        >>> # Strategy initialization
        >>> bars = load_warmup_bars(count=1000, timeframe='15m')
    """
    loader = NautilusDataLoader()
    return loader.load_warmup_bars(count, timeframe=timeframe)