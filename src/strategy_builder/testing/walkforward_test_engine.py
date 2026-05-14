"""
Walkforward Test Engine
Implements candle-by-candle expanding window testing (Mode 1 & 2)
Reference: docs/v3/UI-UX/14_TESTING_MODES.md
"""

from enum import Enum
from typing import List, Optional, Dict, Any
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from src.strategy_builder.core.strategy_config_engine import StrategyConfig, DeferredExit


class WalkforwardMode(Enum):
    """Test execution modes"""
    MODE_1 = "historical_only"  # Run historical data and stop
    MODE_2 = "historical_plus_live"  # Run historical then wait for new candles


@dataclass
class PositionAdjustment:
    """Record of a TP/SL adjustment"""
    adjustment_type: str  # "TP1", "TP2", "TP3", "SL"
    old_value: float
    new_value: float
    candle_index: int
    timestamp: Optional[datetime] = None


@dataclass
class WalkforwardConfig:
    """Configuration for walkforward testing"""
    mode: WalkforwardMode = WalkforwardMode.MODE_1
    lookback_days: int = 180
    training_window_days: int = 0
    start_date: Optional[datetime] = None
    bar_timeframe: str = "15-MINUTE"
    

@dataclass
class WalkforwardResult:
    """Results from walkforward test"""
    total_positions: int = 0
    winning_positions: int = 0
    losing_positions: int = 0
    tp1_adjustments: int = 0
    tp2_adjustments: int = 0
    tp3_adjustments: int = 0
    sl_adjustments: int = 0
    total_pnl: float = 0.0
    win_rate: float = 0.0
    adjustments_per_position: float = 0.0
    test_duration_days: int = 0
    candles_processed: int = 0
    # Sprint 1.8 Task 1.8.63: Exit condition metrics
    exit_condition_triggers: int = 0
    partial_exit_count: int = 0
    exit_condition_pnl: float = 0.0
    metadata: Dict[str, Any] = field(default_factory=dict)


class WalkforwardTestEngine:
    """
    Walkforward testing engine with expanding window
    Processes candles one-by-one from lookback_days to present
    
    Mode 1: Historical only - processes past data and stops
    Mode 2: Historical + Live - processes past data then waits for new candles
    """
    
    def __init__(self, config: Optional[WalkforwardConfig] = None):
        """
        Initialize walkforward test engine
        
        Args:
            config: Test configuration (defaults to Mode 1, 180 days)
        """
        self.config = config or WalkforwardConfig()
        self.adjustments: List[PositionAdjustment] = []
        self.positions: List[Dict[str, Any]] = []
        self.current_candle_index = 0
        
        # Sprint 1.8 Task 1.8.58: Track deferred exits for FLEXIBLE mode
        self.deferred_exits: Dict[str, DeferredExit] = {}
        
    def run(self, strategy_config: StrategyConfig) -> WalkforwardResult:
        """
        Run walkforward test on strategy
        
        Args:
            strategy_config: Strategy configuration to test
            
        Returns:
            WalkforwardResult with comprehensive statistics
        """
        # Calculate date range
        total_lookback = self._calculate_total_lookback()
        start_date = self.config.start_date or (datetime.now() - timedelta(days=total_lookback))
        end_date = datetime.now()
        
        # Initialize result
        result = WalkforwardResult()
        result.test_duration_days = (end_date - start_date).days
        
        # Simulate candle-by-candle processing
        result.candles_processed = self._simulate_candles(
            strategy_config,
            start_date,
            end_date
        )
        
        # Calculate statistics from tracked data
        result = self._calculate_statistics(result)
        
        # Mode 2: Would continue waiting for new candles
        if self.config.mode == WalkforwardMode.MODE_2:
            result.metadata['mode'] = 'live_continuation'
            result.metadata['waiting_for_new_candles'] = True
        else:
            result.metadata['mode'] = 'historical_complete'
            
        return result
        
    def _calculate_total_lookback(self) -> int:
        """
        Calculate total lookback including training window
        
        Returns:
            Total days to look back
        """
        return self.config.lookback_days + self.config.training_window_days
        
    def _simulate_candles(
        self,
        strategy_config: StrategyConfig,
        start_date: datetime,
        end_date: datetime
    ) -> int:
        """
        Simulate candle-by-candle processing with expanding window
        
        Args:
            strategy_config: Strategy to test
            start_date: Start date for testing
            end_date: End date for testing
            
        Returns:
            Number of candles processed
        """
        candles_processed = 0
        
        # Calculate expected candles based on timeframe
        # For 15-minute bars: 4 per hour * 24 hours = 96 per day
        days = (end_date - start_date).days
        expected_candles = days * 96  # Approximate for 15-minute bars
        
        # Simulate processing (in production, would process real data)
        for i in range(expected_candles):
            self.current_candle_index = i
            
            # Would process strategy logic here
            # For now, simulate some positions and adjustments
            if i % 100 == 0:  # Simulate position every 100 candles
                self._simulate_position()
                
        candles_processed = expected_candles
        return candles_processed
        
    def _simulate_position(self):
        """Simulate a position with potential adjustments"""
        position = {
            'entry_candle': self.current_candle_index,
            'entry_price': 50000.0,  # Mock price
            'adjustments': []
        }
        
        # Simulate some TP/SL adjustments
        if self.current_candle_index % 3 == 0:
            self._track_adjustment(PositionAdjustment(
                adjustment_type="TP1",
                old_value=51000.0,
                new_value=51500.0,
                candle_index=self.current_candle_index
            ))
            
        if self.current_candle_index % 5 == 0:
            self._track_adjustment(PositionAdjustment(
                adjustment_type="SL",
                old_value=49000.0,
                new_value=49500.0,
                candle_index=self.current_candle_index
            ))
            
        self.positions.append(position)
        
    def _track_adjustment(self, adjustment: PositionAdjustment):
        """
        Track a TP/SL adjustment
        
        Args:
            adjustment: Adjustment to track
        """
        self.adjustments.append(adjustment)
        
    def _calculate_statistics(self, result: WalkforwardResult) -> WalkforwardResult:
        """
        Calculate final statistics from tracked data
        
        Args:
            result: Result object to populate
            
        Returns:
            Updated result with statistics
        """
        # Count positions
        result.total_positions = len(self.positions)
        
        # Simulate win/loss (in production, would be calculated from actual trades)
        result.winning_positions = int(result.total_positions * 0.6)  # Mock 60% win rate
        result.losing_positions = result.total_positions - result.winning_positions
        
        # Count adjustments by type
        for adj in self.adjustments:
            if adj.adjustment_type == "TP1":
                result.tp1_adjustments += 1
            elif adj.adjustment_type == "TP2":
                result.tp2_adjustments += 1
            elif adj.adjustment_type == "TP3":
                result.tp3_adjustments += 1
            elif adj.adjustment_type == "SL":
                result.sl_adjustments += 1
                
        # Calculate derived metrics
        if result.total_positions > 0:
            result.win_rate = result.winning_positions / result.total_positions
            total_adjustments = (result.tp1_adjustments + result.tp2_adjustments +
                                result.tp3_adjustments + result.sl_adjustments)
            result.adjustments_per_position = total_adjustments / result.total_positions
            
        # Mock PnL (in production, would be calculated from actual trades)
        result.total_pnl = result.winning_positions * 100.0 - result.losing_positions * 50.0
        
        return result
        
    def _process_exit_conditions(self, bar: Any, bar_index: int) -> None:
        """
        Process exit conditions with intelligent mode support - Sprint 1.8 Task 1.8.59
        
        Args:
            bar: Current bar data (pd.Series or similar)
            bar_index: Current bar index
        """
        # Check deferred exits first
        self._check_deferred_exits(bar, bar_index)
        
        # Process exit conditions for open positions
        # NOTE: In production, would iterate through actual open positions
        # and check exit conditions from strategy config
        pass
    
    def _handle_exit_trigger(
        self,
        position: Dict[str, Any],
        exit_condition: Any,
        bar: Any,
        bar_index: int
    ) -> None:
        """
        Handle exit trigger with ABSOLUTE/FLEXIBLE mode logic - Sprint 1.8 Task 1.8.60
        
        Args:
            position: Position to potentially exit
            exit_condition: Exit condition that triggered
            bar: Current bar data
            bar_index: Current bar index
        """
        if exit_condition.exit_mode == "ABSOLUTE":
            # ABSOLUTE: Execute partial exit immediately
            self._execute_partial_exit(
                position,
                exit_condition.percentage,
                f"EXIT_{exit_condition.signal_name}"
            )
        else:
            # FLEXIBLE: Check TP proximity, defer if appropriate
            # NOTE: In production, would calculate:
            # - Distance to nearest TP
            # - Price direction
            # - Whether to defer or execute
            # For now, placeholder for FLEXIBLE logic
            position_id = position.get('position_id', 'mock_pos_id')
            deferred_exit = DeferredExit(
                exit_condition=exit_condition,
                position_id=position_id,
                trigger_bar=bar_index,
                trigger_price=float(bar.get('close', 50000.0)) if hasattr(bar, 'get') else 50000.0,
                nearest_tp=51000.0,  # Mock TP price
                nearest_tp_name="TP1",
                peak_price_toward_tp=50000.0
            )
            self.deferred_exits[position_id] = deferred_exit
    
    def _check_deferred_exits(self, bar: Any, bar_index: int) -> None:
        """
        Check if deferred exits should be resolved (TP hit or reversal) - Sprint 1.8 Task 1.8.61
        
        Args:
            bar: Current bar data
            bar_index: Current bar index
        """
        for position_id, deferred_exit in list(self.deferred_exits.items()):
            current_price = float(bar.get('close', 50000.0)) if hasattr(bar, 'get') else 50000.0
            
            # Check if TP hit
            tp_hit = current_price >= deferred_exit.nearest_tp
            
            # Check for reversal
            reversal_threshold = deferred_exit.exit_condition.reversal_trigger
            peak_price = deferred_exit.peak_price_toward_tp
            reversal = (peak_price - current_price) / peak_price > reversal_threshold
            
            if tp_hit:
                # TP hit - remove deferred exit (TP takes precedence)
                del self.deferred_exits[position_id]
            elif reversal:
                # Reversal detected - execute deferred exit
                position = next((p for p in self.positions if p.get('position_id') == position_id), None)
                if position:
                    self._execute_partial_exit(
                        position,
                        deferred_exit.exit_condition.percentage,
                        f"EXIT_{deferred_exit.exit_condition.signal_name}"
                    )
                del self.deferred_exits[position_id]
            else:
                # Update peak price if moving toward TP
                if current_price > peak_price:
                    deferred_exit.peak_price_toward_tp = current_price
    
    def _execute_partial_exit(
        self,
        position: Dict[str, Any],
        percentage: float,
        exit_type: str
    ) -> None:
        """
        Execute partial position closure - Sprint 1.8 Task 1.8.62
        
        Args:
            position: Position to partially close
            percentage: Percentage to close (0.0-1.0)
            exit_type: Type of exit (e.g., "EXIT_HOD_REJECTION")
        """
        # Track as adjustment
        adjustment = PositionAdjustment(
            adjustment_type=exit_type,
            old_value=position.get('size', 1.0),
            new_value=position.get('size', 1.0) * (1.0 - percentage),
            candle_index=self.current_candle_index
        )
        self._track_adjustment(adjustment)
        
        # Update position size
        if 'size' in position:
            position['size'] *= (1.0 - percentage)
    
    def get_adjustment_report(self) -> Dict[str, Any]:
        """
        Get detailed adjustment report - Sprint 1.8 Task 1.8.64 updated
        
        Returns:
            Dictionary with adjustment statistics per position
        """
        # Count EXIT_CONDITION adjustments
        exit_condition_count = sum(
            1 for a in self.adjustments 
            if a.adjustment_type.startswith("EXIT_")
        )
        
        report = {
            'total_adjustments': len(self.adjustments),
            'by_type': {
                'TP1': sum(1 for a in self.adjustments if a.adjustment_type == "TP1"),
                'TP2': sum(1 for a in self.adjustments if a.adjustment_type == "TP2"),
                'TP3': sum(1 for a in self.adjustments if a.adjustment_type == "TP3"),
                'SL': sum(1 for a in self.adjustments if a.adjustment_type == "SL"),
                'EXIT_CONDITION': exit_condition_count,  # Sprint 1.8 Task 1.8.64
            },
            'positions': len(self.positions),
            'avg_adjustments_per_position': (
                len(self.adjustments) / len(self.positions) if self.positions else 0
            ),
            # Sprint 1.8 Task 1.8.64: Exit condition details
            'exit_conditions': {
                'total_triggers': exit_condition_count,
                'by_condition_name': {},  # Would be populated with actual condition names
                'partial_exits': exit_condition_count,
                'deferred_exits': len(self.deferred_exits)
            }
        }
        return report
        
    def reset(self):
        """Reset engine state for new test"""
        self.adjustments = []
        self.positions = []
        self.current_candle_index = 0
