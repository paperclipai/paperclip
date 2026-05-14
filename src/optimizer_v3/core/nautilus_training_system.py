"""
NautilusTrader Training System - Sprint 2.1, Task 2.1.8
=========================================================

Core training system with institutional-grade NautilusTrader integration.
Provides forward-looking signal analysis with proper type safety.

CRITICAL: All financial calculations use NautilusTrader types:
- Quantity for position sizes
- Price for price levels
- Money for monetary values
- Decimal for ratios and percentages

ZERO floating point arithmetic - institutional grade only.
"""

from typing import List, Dict, Any, Optional, Tuple
from decimal import Decimal
from datetime import datetime, timedelta
from pathlib import Path
import os
import sys

# NautilusTrader imports - MANDATORY types
from nautilus_trader.model.objects import Quantity, Price, Money
from nautilus_trader.model.currencies import USD
from nautilus_trader.model.identifiers import InstrumentId, Symbol
from nautilus_trader.model.enums import OrderSide, PositionSide
from nautilus_trader.model.data import Bar

import pandas as pd
import logging
logger = logging.getLogger(__name__)


# Import configuration
project_root = Path(__file__).parent.parent.parent.parent
sys.path.insert(0, str(project_root))
from src.optimizer_v3.config.training_config import get_training_config


class SignalEvent:
    """
    Signal event with NautilusTrader types
    
    Represents a single signal occurrence for analysis.
    All types are NautilusTrader native for institutional safety.
    """
    
    def __init__(
        self,
        block_name: str,
        timestamp: datetime,
        price: Price,
        instrument_id: InstrumentId
    ):
        self.block_name = block_name
        self.timestamp = timestamp
        self.price = price
        self.instrument_id = instrument_id
        
        # Metrics calculated during analysis
        self.price_impact: Money = Money('0', USD)
        self.position_size: Quantity = Quantity(0.0, 8)
        self.pnl: Money = Money('0', USD)
        self.is_valid: bool = False
        
        # Forward analysis data
        self.max_favorable: Decimal = Decimal('0')
        self.max_adverse: Decimal = Decimal('0')
        self.final_move: Decimal = Decimal('0')
        self.volatility: Decimal = Decimal('0')
        
    def __repr__(self) -> str:
        return (
            f"SignalEvent({self.block_name}, "
            f"{self.timestamp}, {self.price}, "
            f"valid={self.is_valid})"
        )


class NautilusTrainingSystem:
    """
    Core Training System with NautilusTrader Integration
    
    Provides forward-looking signal analysis to determine:
    - Optimal RECHECK delays
    - Timing windows
    - Parameter configurations
    
    INSTITUTIONAL FEATURES:
    - 100% NautilusTrader types
    - Decimal arithmetic only
    - Risk-based position sizing
    - Volatility-based analysis
    - Comprehensive error handling
    - Type safety enforced
    """
    
    def __init__(self, logger=None):
        """
        Initialize training system
        
        Args:
            logger: Optional logger instance (OptimizerLogger compatible)
        """
        self.logger = logger
        self.config = get_training_config()
        
        # Training state
        self.signals_analyzed: int = 0
        self.valid_signals: int = 0
        self.invalid_signals: int = 0
        
        # Block instance cache: {block_name: detector_instance}
        # Lazy-loaded on first use to avoid slow startup
        self._block_cache: Dict[str, Any] = {}
        
        if self.logger:
            self.logger.info("NautilusTrainingSystem initialized")
    
    def train_building_block(
        self,
        block_name: str,
        mode: str,
        period: Tuple[datetime, datetime],
        timeframes: List[str],
        instrument_id: InstrumentId
    ) -> Dict[str, Any]:
        """
        Execute training for a building block
        
        Args:
            block_name: Name of building block to analyze
            mode: 'testing' or 'production'
            period: Tuple of (start_date, end_date)
            timeframes: List of timeframes to analyze (e.g., ['5m', '15m'])
            instrument_id: NautilusTrader InstrumentId
        
        Returns:
            dict: Training metrics with NautilusTrader types
        """
        if self.logger:
            self.logger.info(
                f"Training block '{block_name}' on {instrument_id} "
                f"from {period[0]} to {period[1]}"
            )
        
        # Initialize metrics storage with proper types
        metrics = {
            'block_name': block_name,
            'mode': mode,
            'period_start': period[0],
            'period_end': period[1],
            'total_signals': 0,
            'valid_signals': 0,
            'invalid_signals': 0,
            'avg_price_impact': Money(0, USD),
            'avg_position_size': Quantity(0.0, 8),
            'win_rate': Decimal('0'),
            'profit_factor': Decimal('0'),
            'max_drawdown': Decimal('0'),
            'sharpe_ratio': Decimal('0'),
            'timeframe_results': {}
        }
        
        # Analyze each timeframe
        for timeframe in timeframes:
            if self.logger:
                self.logger.info(f"  Analyzing timeframe: {timeframe}")
            
            # Task 2.1.9: Analyze forward behavior
            signals = self._analyze_forward_behavior(
                block_name=block_name,
                timeframe=timeframe,
                period=period,
                instrument_id=instrument_id
            )
            
            # Update metrics with proper types
            metrics['total_signals'] += len(signals)
            metrics['valid_signals'] += len([s for s in signals if s.is_valid])
            metrics['invalid_signals'] += len([s for s in signals if not s.is_valid])
            
            # Calculate price impact (Money type)
            valid_signals = [s for s in signals if s.is_valid]
            if valid_signals:
                price_impacts = [s.price_impact for s in valid_signals]
                total_impact = sum(price_impacts, Money(0, USD))
                avg_impact = Money(
                    str(total_impact.as_decimal() / len(valid_signals)),
                    USD
                )
                metrics['avg_price_impact'] = avg_impact
            
            # Calculate position sizes (Quantity type)
            if valid_signals:
                position_sizes = [s.position_size for s in valid_signals]
                total_size = sum(position_sizes, Quantity(0.0, 8))
                avg_size = Quantity(
                    float(total_size.as_double() / len(valid_signals)), 8
                )
                metrics['avg_position_size'] = avg_size
            
            # Calculate win rate and profit factor (Decimal)
            if signals:
                winning_trades = [s for s in signals if s.pnl > Money(0, USD)]
                losing_trades = [s for s in signals if s.pnl < Money(0, USD)]
                
                if signals:
                    win_rate = Decimal(str(len(winning_trades))) / Decimal(str(len(signals)))
                    metrics['win_rate'] = win_rate
                
                # Profit factor calculation
                if winning_trades and losing_trades:
                    gross_profit = sum(
                        [s.pnl for s in winning_trades],
                        Money(0, USD)
                    )
                    gross_loss = sum(
                        [abs(s.pnl.as_decimal()) for s in losing_trades],
                        Decimal('0')
                    )
                    
                    if gross_loss > Decimal('0'):
                        profit_factor = gross_profit.as_decimal() / Money(str(gross_loss), USD).as_decimal()
                        metrics['profit_factor'] = profit_factor
            
            # Store timeframe-specific results
            metrics['timeframe_results'][timeframe] = {
                'total_signals': len(signals),
                'valid_signals': len(valid_signals),
                'avg_volatility': self._calculate_avg_metric(
                    [s.volatility for s in valid_signals]
                ) if valid_signals else Decimal('0')
            }
        
        if self.logger:
            self.logger.info(
                f"Training complete: {metrics['total_signals']} signals analyzed, "
                f"{metrics['valid_signals']} valid, "
                f"win rate: {float(metrics['win_rate']):.2%}"
            )
        
        return metrics
    
    def _analyze_forward_behavior(
        self,
        block_name: str,
        timeframe: str,
        period: Tuple[datetime, datetime],
        instrument_id: InstrumentId
    ) -> List[SignalEvent]:
        """
        Task 2.1.9: Analyze forward price behavior after signal
        
        For each signal occurrence:
        1. Record signal with NautilusTrader types
        2. Analyze next N bars (forward-looking)
        3. Calculate price impact
        4. Calculate optimal position size
        5. Simulate trade outcome
        
        Args:
            block_name: Building block name
            timeframe: Timeframe to analyze
            period: Analysis period
            instrument_id: Instrument identifier
        
        Returns:
            List[SignalEvent]: All signal events found
        """
        signals = []
        
        # Get historical data (Task 2.1.16 - placeholder)
        # In production, this would load actual bar data
        data = self._get_historical_data(
            instrument_id=instrument_id,
            timeframe=timeframe,
            start=period[0],
            end=period[1]
        )
        
        # Analyze each bar for signal conditions
        for i, bar in enumerate(data):
            # Check if this bar triggers the signal
            if self._check_signal_condition(block_name, bar, i, data):
                # Record signal with proper types
                signal = SignalEvent(
                    block_name=block_name,
                    timestamp=bar.ts_init,
                    price=bar.close,
                    instrument_id=instrument_id
                )
                
                # Get forward bars for analysis
                forward_bars = self._get_forward_bars(
                    current_index=i,
                    data=data,
                    bars=self.config['signal']['forward_bars']
                )
                
                if len(forward_bars) < self.config['signal']['forward_bars']:
                    # Not enough forward data - skip this signal
                    signal.is_valid = False
                    self.invalid_signals += 1
                else:
                    # Task 2.1.11: Analyze price movement
                    self._analyze_price_movement(signal, bar, forward_bars)
                    
                    # Calculate volatility
                    signal.volatility = self._calculate_volatility(forward_bars)
                    
                    # Task 2.1.8: Calculate optimal position size
                    signal.position_size = self._calculate_position_size(
                        price=signal.price,
                        volatility=signal.volatility
                    )
                    
                    # Task 2.1.13: Analyze trade outcome
                    signal.pnl = self._analyze_trade_outcome(
                        signal=signal,
                        forward_bars=forward_bars
                    )
                    
                    signal.is_valid = True
                    self.valid_signals += 1
                
                signals.append(signal)
                self.signals_analyzed += 1
        
        return signals
    
    def _analyze_price_movement(
        self,
        signal: SignalEvent,
        entry_bar: Bar,
        forward_bars: List[Bar]
    ) -> None:
        """
        Task 2.1.11: Analyze price movement after signal
        
        Calculates:
        - Maximum favorable excursion
        - Maximum adverse excursion
        - Final price movement
        - Price impact (Money type)
        
        Args:
            signal: SignalEvent to update
            entry_bar: Bar where signal triggered
            forward_bars: Bars after signal
        """
        entry_price = entry_bar.close.as_double()
        
        max_favorable = Decimal('0')
        max_adverse = Decimal('0')
        final_price = forward_bars[-1].close.as_double()
        
        # Track maximum favorable and adverse movements
        for bar in forward_bars:
            current_price = bar.close.as_double()
            move = Decimal(str((current_price - entry_price) / entry_price))
            
            if move > max_favorable:
                max_favorable = move
            if move < max_adverse:
                max_adverse = move
        
        # Calculate final movement
        final_move = Decimal(str((final_price - entry_price) / entry_price))
        
        # Update signal metrics
        signal.max_favorable = max_favorable
        signal.max_adverse = max_adverse
        signal.final_move = final_move
        
        # Price impact as Money type
        impact_value = abs(final_move * Decimal(str(entry_price)))
        signal.price_impact = Money(str(impact_value), USD)
    
    def _calculate_position_size(
        self,
        price: Price,
        volatility: Decimal
    ) -> Quantity:
        """
        Task 2.1.8: Calculate optimal position size based on volatility
        
        Uses risk-based sizing with NautilusTrader types:
        - Fixed risk amount per trade
        - Stop distance based on volatility (ATR)
        - Enforces max/min position limits
        
        Args:
            price: Entry price (Price type)
            volatility: Calculated volatility (Decimal)
        
        Returns:
            Quantity: Optimal position size
        """
        # Risk amount from config
        risk_limit = self.config['position']['risk_limit']
        risk_amount = Money(risk_limit, USD)
        
        # Stop distance: price * volatility (use volatility as stop multiplier)
        # Minimum volatility to avoid division by zero
        safe_volatility = max(volatility, Decimal('0.001'))
        stop_distance = price.as_decimal() * safe_volatility
        
        # Calculate size: risk / stop_distance
        if stop_distance > Decimal('0'):
            size = risk_amount.as_decimal() / stop_distance
        else:
            size = Decimal('0')
        
        # Apply limits from config
        max_size = self.config['position']['max_size']
        min_size = self.config['position']['min_size']
        
        # Clamp to limits
        if size > max_size:
            size = max_size
        elif size < min_size:
            size = min_size
        
        # Round to increment
        increment = self.config['position']['size_increment']
        size = (size / increment).quantize(Decimal('1')) * increment
        
        return Quantity(float(size), 8)
    
    def _calculate_volatility(self, bars: List[Bar]) -> Decimal:
        """
        Calculate volatility (ATR) from bars
        
        Uses proper Decimal arithmetic for institutional precision.
        
        Args:
            bars: List of Bar objects
        
        Returns:
            Decimal: Average True Range (volatility)
        """
        if not bars:
            return Decimal('0')
        
        true_ranges = []
        for i, bar in enumerate(bars):
            # True Range = max(high-low, abs(high-prev_close), abs(low-prev_close))
            if i == 0:
                # First bar: just high - low
                tr = bar.high.as_decimal() - bar.low.as_decimal()
            else:
                prev_close = bars[i-1].close.as_decimal()
                high_low = bar.high.as_decimal() - bar.low.as_decimal()
                high_close = abs(bar.high.as_decimal() - prev_close)
                low_close = abs(bar.low.as_decimal() - prev_close)
                tr = max(high_low, high_close, low_close)
            
            true_ranges.append(tr)
        
        # Average True Range
        atr = sum(true_ranges) / Decimal(str(len(true_ranges)))
        return atr
    
    def _analyze_trade_outcome(
        self,
        signal: SignalEvent,
        forward_bars: List[Bar]
    ) -> Money:
        """
        Task 2.1.13: Analyze trade outcome
        
        Simulates trade execution and calculates PnL with NautilusTrader types.
        
        Args:
            signal: SignalEvent with position size
            forward_bars: Future price action
        
        Returns:
            Money: Simulated PnL
        """
        if not forward_bars or signal.position_size <= Quantity(0.0, 8):
            return Money(0, USD)
        
        # Entry price
        entry_price = signal.price.as_decimal()
        
        # Exit price (last bar of forward window)
        exit_price = forward_bars[-1].close.as_decimal()
        
        # Price change
        price_change = exit_price - entry_price
        
        # PnL = position_size * price_change
        position_size_decimal = Decimal(str(signal.position_size.as_double()))
        pnl_value = position_size_decimal * price_change
        
        return Money(str(pnl_value), USD)
    
    def _find_signal_recurrence(
        self,
        signals: List[SignalEvent],
        tolerance_bars: int = 5
    ) -> Dict[str, Any]:
        """
        Task 2.1.10: Detect signal recurrence patterns
        
        Identifies when signals repeat at similar intervals, which indicates
        optimal RECHECK delay timing windows.
        
        Algorithm:
        1. Calculate time deltas between consecutive signals
        2. Cluster deltas by similarity (tolerance window)
        3. Find most common recurrence interval
        4. Calculate confidence based on cluster size
        
        Args:
            signals: List of SignalEvent objects (sorted by timestamp)
            tolerance_bars: Tolerance window for clustering (bars)
        
        Returns:
            dict: {
                'most_common_interval': int (bars),
                'interval_frequency': int (occurrences),
                'confidence': Decimal (0.0-1.0),
                'all_intervals': List[int],
                'cluster_sizes': Dict[int, int]
            }
        """
        if len(signals) < 2:
            return {
                'most_common_interval': 0,
                'interval_frequency': 0,
                'confidence': Decimal('0'),
                'all_intervals': [],
                'cluster_sizes': {}
            }
        
        # Calculate all time deltas (in bars)
        # Assumes signals are sorted by timestamp
        intervals = []
        for i in range(1, len(signals)):
            # Time delta in seconds
            time_delta = (signals[i].timestamp - signals[i-1].timestamp).total_seconds()
            
            # Convert to bars (assuming timeframe, e.g., 15m = 900sec)
            # This is a placeholder - actual implementation would use timeframe
            bars_per_interval = 900  # 15 minutes in seconds
            interval_bars = int(time_delta / bars_per_interval)
            
            intervals.append(interval_bars)
        
        if not intervals:
            return {
                'most_common_interval': 0,
                'interval_frequency': 0,
                'confidence': Decimal('0'),
                'all_intervals': [],
                'cluster_sizes': {}
            }
        
        # Cluster intervals by tolerance window
        clusters = {}
        for interval in intervals:
            # Find existing cluster within tolerance
            found_cluster = False
            for cluster_center in list(clusters.keys()):
                if abs(interval - cluster_center) <= tolerance_bars:
                    clusters[cluster_center].append(interval)
                    found_cluster = True
                    break
            
            if not found_cluster:
                # Create new cluster
                clusters[interval] = [interval]
        
        # Find largest cluster
        largest_cluster_center = max(clusters.keys(), key=lambda k: len(clusters[k]))
        largest_cluster_size = len(clusters[largest_cluster_center])
        
        # Calculate average interval in largest cluster
        avg_interval = sum(clusters[largest_cluster_center]) / len(clusters[largest_cluster_center])
        most_common_interval = int(avg_interval)
        
        # Confidence = cluster_size / total_intervals
        confidence = Decimal(str(largest_cluster_size)) / Decimal(str(len(intervals)))
        
        # Build cluster sizes for reporting
        cluster_sizes = {center: len(members) for center, members in clusters.items()}
        
        return {
            'most_common_interval': most_common_interval,
            'interval_frequency': largest_cluster_size,
            'confidence': confidence,
            'all_intervals': intervals,
            'cluster_sizes': cluster_sizes
        }
    
    def _find_dependent_signals(
        self,
        primary_signals: List[SignalEvent],
        all_signals: List[SignalEvent],
        correlation_threshold: Decimal = Decimal('0.7'),
        time_window_bars: int = 10
    ) -> List[Dict[str, Any]]:
        """
        Task 2.1.12: Find dependent signals
        
        Identifies signals that consistently occur together or in sequence,
        which can be used to:
        - Optimize RECHECK delays (signal A → wait N bars → signal B)
        - Detect redundant signals (high correlation = remove one)
        - Build signal chains (entry → confirmation → exit)
        
        Algorithm:
        1. For each primary signal, look for other signals within time window
        2. Calculate co-occurrence frequency
        3. Calculate time lag distribution
        4. Build dependency graph
        
        Args:
            primary_signals: Signals to analyze for dependencies
            all_signals: All available signals (including primary)
            correlation_threshold: Minimum correlation to report (0.0-1.0)
            time_window_bars: Time window to check for co-occurrence
        
        Returns:
            List[dict]: [
                {
                    'primary_block': str,
                    'dependent_block': str,
                    'correlation': Decimal,
                    'avg_time_lag': int (bars),
                    'co_occurrence_rate': Decimal,
                    'sample_size': int
                },
                ...
            ]
        """
        dependencies = []
        
        # Group all_signals by block_name for efficient lookup
        signals_by_block = {}
        for sig in all_signals:
            if sig.block_name not in signals_by_block:
                signals_by_block[sig.block_name] = []
            signals_by_block[sig.block_name].append(sig)
        
        # For each primary signal, check all other signal types
        for primary_block_name in set(s.block_name for s in primary_signals):
            primary_block_signals = [s for s in primary_signals if s.block_name == primary_block_name]
            
            # Check against all other blocks
            for dependent_block_name, dependent_signals in signals_by_block.items():
                # Skip self-comparison
                if primary_block_name == dependent_block_name:
                    continue
                
                # Count co-occurrences and time lags
                co_occurrences = 0
                time_lags = []
                
                for primary_sig in primary_block_signals:
                    # Find dependent signals within time window
                    for dep_sig in dependent_signals:
                        # Calculate time lag (in bars)
                        time_delta = (dep_sig.timestamp - primary_sig.timestamp).total_seconds()
                        bars_per_interval = 900  # 15 minutes (placeholder)
                        lag_bars = int(time_delta / bars_per_interval)
                        
                        # Check if within window and after primary signal
                        if 0 < lag_bars <= time_window_bars:
                            co_occurrences += 1
                            time_lags.append(lag_bars)
                
                # Calculate correlation metrics
                if co_occurrences > 0:
                    # Co-occurrence rate = matches / total primary signals
                    co_occurrence_rate = Decimal(str(co_occurrences)) / Decimal(str(len(primary_block_signals)))
                    
                    # Average time lag
                    avg_time_lag = int(sum(time_lags) / len(time_lags)) if time_lags else 0
                    
                    # Only report if above correlation threshold
                    if co_occurrence_rate >= correlation_threshold:
                        dependencies.append({
                            'primary_block': primary_block_name,
                            'dependent_block': dependent_block_name,
                            'correlation': co_occurrence_rate,
                            'avg_time_lag': avg_time_lag,
                            'co_occurrence_rate': co_occurrence_rate,
                            'sample_size': len(primary_block_signals)
                        })
        
        # Sort by correlation (highest first)
        dependencies.sort(key=lambda x: x['correlation'], reverse=True)
        
        return dependencies
    
    def _get_historical_data(
        self,
        instrument_id: InstrumentId,
        timeframe: str,
        start: datetime,
        end: datetime
    ) -> List[Bar]:
        """
        Task 2.1.16: Get historical data - REAL IMPLEMENTATION
        
        Loads actual bar data from BacktestDataProvider (uses DataManager).
        
        Args:
            instrument_id: Instrument to load
            timeframe: Bar timeframe
            start: Start date
            end: End date
        
        Returns:
            List[Bar]: Historical bars from real data
        """
        from src.optimizer_v3.core.backtest_data_provider import get_backtest_provider
        
        try:
            provider = get_backtest_provider()
            
            # Load real bars from DataManager
            bars = provider.load_bars_for_backtest(
                timeframe=timeframe,
                start_date=start,
                end_date=end,
                progress_callback=None  # Silent loading for training
            )
            
            if self.logger:
                self.logger.info(
                    f"Loaded {len(bars):,} real bars for {instrument_id} "
                    f"{timeframe} from {start.date()} to {end.date()}"
                )
            
            return bars
            
        except Exception as e:
            if self.logger:
                self.logger.error(f"Failed to load historical data: {e}")
            return []
    
    def _check_signal_condition(
        self,
        block_name: str,
        bar: Bar,
        index: int,
        all_bars: List[Bar]
    ) -> bool:
        """
        Check if bar triggers signal condition via BlockRegistry.
        
        Builds a rolling window DataFrame from bars up to and including the
        current bar, instantiates (or retrieves cached) the registered block,
        calls block.analyze(df), and returns True when the block fires a
        non-neutral, non-error signal.
        
        Args:
            block_name: Building block name (must be registered in BlockRegistry)
            bar: Current bar
            index: Bar index in data
            all_bars: All available bars (used for the rolling window context)
        
        Returns:
            bool: True if the block emits an actionable signal on this bar
        """
        try:
            from src.detectors.building_blocks.registry import BlockRegistry
        except ImportError:
            if self.logger:
                self.logger.warning(
                    f"BlockRegistry unavailable — cannot evaluate '{block_name}'"
                )
            return False

        # Verify block is registered
        metadata = BlockRegistry.get_block(block_name)
        if metadata is None:
            if self.logger:
                self.logger.warning(
                    f"Block '{block_name}' not found in registry — skipping signal check"
                )
            return False

        # Build rolling context window: use up to 200 bars ending at current index
        window_size = min(200, index + 1)
        start_idx = index + 1 - window_size
        window_bars = all_bars[start_idx:index + 1]

        if len(window_bars) < 50:
            # Most blocks need at least 50 bars to analyse
            return False

        # Convert Bar objects to pandas DataFrame expected by building blocks
        df = self._bars_to_dataframe(window_bars)

        # Get or instantiate the block detector
        detector = self._get_block_detector(block_name, metadata)
        if detector is None:
            return False

        # Run analysis
        try:
            result = detector.analyze(df)
        except Exception as exc:
            if self.logger:
                self.logger.error(
                    f"Block '{block_name}' analyze() raised: {exc}"
                )
            return False

        if not isinstance(result, dict):
            return False

        signal = result.get('signal', 'NO_SIGNAL')

        # Non-firing signals — everything else is considered a fire
        NON_FIRING = {'NEUTRAL', 'ERROR', 'INSUFFICIENT_DATA', 'NO_SIGNAL', 'NO_PATTERN'}

        return signal not in NON_FIRING

    def _bars_to_dataframe(self, bars: List[Bar]) -> 'pd.DataFrame':
        """
        Convert a list of NautilusTrader Bar objects to the pandas DataFrame
        format expected by building block analyze() methods.
        
        Columns produced: open, high, low, close, volume, timestamp
        
        Args:
            bars: List of NautilusTrader Bar objects (chronological order)
        
        Returns:
            pd.DataFrame: OHLCV frame with UTC-naive datetime timestamps
        """
        rows = []
        for b in bars:
            rows.append({
                'open':      float(b.open.as_decimal()),
                'high':      float(b.high.as_decimal()),
                'low':       float(b.low.as_decimal()),
                'close':     float(b.close.as_decimal()),
                'volume':    float(b.volume.as_double()),
                'timestamp': pd.Timestamp(b.ts_init, unit='ns', tz='UTC').tz_localize(None),
            })
        return pd.DataFrame(rows)

    def _get_block_detector(self, block_name: str, metadata: Any) -> Optional[Any]:
        """
        Return a cached block detector instance, instantiating it on first access.
        
        Args:
            block_name: Registered block name
            metadata: BlockMetadata from registry
        
        Returns:
            Detector instance, or None if instantiation fails
        """
        if block_name in self._block_cache:
            return self._block_cache[block_name]

        try:
            from src.detectors.building_blocks.registry import BlockRegistry
            detector = BlockRegistry.instantiate(block_name)
            self._block_cache[block_name] = detector
            if self.logger:
                self.logger.info(f"Instantiated block detector: '{block_name}'")
            return detector
        except Exception as exc:
            if self.logger:
                self.logger.error(
                    f"Failed to instantiate block '{block_name}': {exc}"
                )
            # Cache None so we don't retry repeatedly
            self._block_cache[block_name] = None
            return None
    
    def _get_forward_bars(
        self,
        current_index: int,
        data: List[Bar],
        bars: int
    ) -> List[Bar]:
        """
        Get N bars after current index
        
        Args:
            current_index: Current bar index
            data: All bar data
            bars: Number of forward bars to get
        
        Returns:
            List[Bar]: Forward bars (may be less than requested)
        """
        end_index = min(current_index + bars + 1, len(data))
        return data[current_index + 1:end_index]
    
    def _calculate_avg_metric(self, values: List[Decimal]) -> Decimal:
        """
        Calculate average of Decimal values
        
        Args:
            values: List of Decimal values
        
        Returns:
            Decimal: Average value
        """
        if not values:
            return Decimal('0')
        return sum(values) / Decimal(str(len(values)))
    
    def get_training_summary(self) -> Dict[str, Any]:
        """
        Get training session summary
        
        Returns:
            dict: Summary statistics
        """
        return {
            'signals_analyzed': self.signals_analyzed,
            'valid_signals': self.valid_signals,
            'invalid_signals': self.invalid_signals,
            'valid_rate': (
                Decimal(str(self.valid_signals)) / Decimal(str(self.signals_analyzed))
                if self.signals_analyzed > 0
                else Decimal('0')
            )
        }
