"""
Block State Manager
Real-time execution state tracking for strategy signals
Tracks signal firing, timing windows, and strategy completion
Reference: docs/v3/UI-UX/21_BLOCK_STATE_MANAGER.md
"""

from typing import Dict, List, Optional, Any
from dataclasses import dataclass, field

from src.strategy_builder.core.strategy_config_engine import StrategyConfig


@dataclass
class SignalState:
    """State of an individual signal"""
    block_name: str
    signal_name: str
    fired: bool = False
    candle_index: Optional[int] = None
    timestamp: Optional[Any] = None


@dataclass
class ExitSignalState:
    """State of an exit condition signal - Sprint 1.8 Task 1.8.54"""
    exit_signal_name: str
    position_id: str
    fired: bool = False
    candle_index: Optional[int] = None
    timestamp: Optional[Any] = None
    exit_percentage: float = 0.0
    exit_mode: str = "ABSOLUTE"  # "ABSOLUTE" or "FLEXIBLE"


@dataclass
class BlockExecutionState:
    """Execution state of a block"""
    block_name: str
    logic: str  # "AND" or "OR"
    signals_fired: int
    signals_required: int
    complete: bool
    signal_states: List[SignalState] = field(default_factory=list)


@dataclass
class StrategyExecutionState:
    """Complete execution state of strategy"""
    strategy_name: str
    current_candle: int
    complete: bool
    block_states: List[BlockExecutionState] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)


class BlockStateManager:
    """
    Manages real-time execution state for strategy
    Tracks signal firing, timing windows, and completion
    """
    
    def __init__(self, config: StrategyConfig):
        """
        Initialize state manager with strategy config
        
        Args:
            config: Strategy configuration
        """
        self.config = config
        self.current_candle = 0
        
        # Initialize signal states
        self.signal_states: Dict[str, SignalState] = {}
        self._initialize_signal_states()
        
        # Track timing windows
        self.timing_windows: Dict[str, Dict[str, Any]] = {}
        
        # Sprint 1.8 Task 1.8.55: Track exit condition state per position
        self.exit_signal_states: Dict[str, ExitSignalState] = {}
        
    def _initialize_signal_states(self):
        """Initialize all signal states to unfired"""
        for block in self.config.blocks:
            for signal in block.signals:
                key = f"{block.name}::{signal.name}"
                self.signal_states[key] = SignalState(
                    block_name=block.name,
                    signal_name=signal.name,
                    fired=False,
                    candle_index=None
                )
                
    def signal_fired(
        self,
        block_name: str,
        signal_name: str,
        candle_index: int
    ):
        """
        Record that a signal has fired
        
        Args:
            block_name: Name of the block
            signal_name: Name of the signal
            candle_index: Candle index when signal fired
        """
        key = f"{block_name}::{signal_name}"
        
        if key in self.signal_states:
            self.signal_states[key].fired = True
            self.signal_states[key].candle_index = candle_index
            
            # Update timing windows for dependent signals
            self._update_timing_windows(block_name, signal_name, candle_index)
            
    def get_signal_state(
        self,
        block_name: str,
        signal_name: str
    ) -> Optional[SignalState]:
        """
        Get current state of a signal
        
        Args:
            block_name: Name of the block
            signal_name: Name of the signal
            
        Returns:
            SignalState or None if not found
        """
        key = f"{block_name}::{signal_name}"
        return self.signal_states.get(key)
        
    def _update_timing_windows(
        self,
        block_name: str,
        signal_name: str,
        candle_index: int
    ):
        """
        Update timing windows when a signal fires
        
        Args:
            block_name: Block name
            signal_name: Signal name
            candle_index: Candle when signal fired
        """
        # Find block
        block = next((b for b in self.config.blocks if b.name == block_name), None)
        if not block:
            return
            
        # Update windows for signals that reference this signal
        for signal in block.signals:
            if signal.timing_constraint and signal.timing_constraint.reference == signal_name:
                window_key = f"{block_name}::{signal.name}"
                self.timing_windows[window_key] = {
                    'reference_signal': signal_name,
                    'max_candles': signal.timing_constraint.max_candles,
                    'start_candle': candle_index
                }
                
    def get_timing_window(
        self,
        block_name: str,
        signal_name: str
    ) -> Optional[Dict[str, Any]]:
        """
        Get timing window for a signal
        
        Args:
            block_name: Block name
            signal_name: Signal name
            
        Returns:
            Timing window dict or None
        """
        key = f"{block_name}::{signal_name}"
        return self.timing_windows.get(key)
        
    def is_timing_valid(
        self,
        block_name: str,
        signal_name: str,
        candle_index: int
    ) -> bool:
        """
        Check if signal firing at candle is within timing window
        
        Args:
            block_name: Block name
            signal_name: Signal name
            candle_index: Candle to check
            
        Returns:
            True if within window or no constraint, False otherwise
        """
        window = self.get_timing_window(block_name, signal_name)
        
        if not window:
            # No timing constraint = always valid
            return True
            
        # Check if within max candles
        candles_since_reference = candle_index - window['start_candle']
        return candles_since_reference <= window['max_candles']
        
    def check_and_reset_if_needed(self, candle_index: int):
        """
        Check timing constraints and reset if any violated
        
        Args:
            candle_index: Current candle index
        """
        for window_key, window in list(self.timing_windows.items()):
            block_name, signal_name = window_key.split('::')
            
            # Check if signal has fired
            signal_state = self.get_signal_state(block_name, signal_name)
            if signal_state and signal_state.fired:
                continue  # Already fired, no need to check
                
            # Check if window expired
            candles_since_reference = candle_index - window['start_candle']
            if candles_since_reference > window['max_candles']:
                # Window expired, reset strategy
                self.reset()
                break
                
    def is_strategy_complete(self) -> bool:
        """
        Check if all strategy requirements are met
        
        Returns:
            True if strategy is complete, False otherwise
        """
        for block in self.config.blocks:
            if not self._is_block_complete(block.name):
                return False
        return True
        
    def _is_block_complete(self, block_name: str) -> bool:
        """
        Check if a block's requirements are met
        
        Args:
            block_name: Name of block to check
            
        Returns:
            True if block complete, False otherwise
        """
        block = next((b for b in self.config.blocks if b.name == block_name), None)
        if not block:
            return False
            
        if block.logic == "OR":
            # OR: At least one signal must fire
            return any(
                self.get_signal_state(block_name, sig.name).fired
                for sig in block.signals
            )
        else:  # AND
            # AND: All signals with AND logic must fire
            and_signals = [sig for sig in block.signals if sig.logic == "AND"]
            return all(
                self.get_signal_state(block_name, sig.name).fired
                for sig in and_signals
            )
            
    def exit_signal_fired(
        self,
        exit_signal_name: str,
        position_id: str,
        candle_index: int,
        exit_percentage: float,
        exit_mode: str = "ABSOLUTE"
    ):
        """
        Record that an exit signal has fired - Sprint 1.8 Task 1.8.56
        
        Args:
            exit_signal_name: Name of the exit signal
            position_id: ID of the position
            candle_index: Candle index when exit signal fired
            exit_percentage: Percentage of position to exit (0.0-1.0)
            exit_mode: "ABSOLUTE" or "FLEXIBLE"
        """
        key = f"{position_id}::{exit_signal_name}"
        
        self.exit_signal_states[key] = ExitSignalState(
            exit_signal_name=exit_signal_name,
            position_id=position_id,
            fired=True,
            candle_index=candle_index,
            exit_percentage=exit_percentage,
            exit_mode=exit_mode
        )
    
    def is_exit_condition_met(
        self,
        exit_signal_name: str,
        position_id: str
    ) -> bool:
        """
        Check if exit condition should execute - Sprint 1.8 Task 1.8.57
        
        Args:
            exit_signal_name: Name of the exit signal
            position_id: ID of the position
            
        Returns:
            True if exit condition met and should execute
        """
        key = f"{position_id}::{exit_signal_name}"
        
        if key not in self.exit_signal_states:
            return False
        
        exit_state = self.exit_signal_states[key]
        
        # Exit condition met if signal has fired
        # NOTE: FLEXIBLE mode deferred exit logic handled in walkforward engine
        return exit_state.fired
    
    def reset(self):
        """Reset all signal states and timing windows"""
        # Reset all signal states
        for state in self.signal_states.values():
            state.fired = False
            state.candle_index = None
            state.timestamp = None
            
        # Clear timing windows
        self.timing_windows.clear()
        
        # Sprint 1.8: Clear exit signal states
        self.exit_signal_states.clear()
        
    def get_execution_state(self) -> StrategyExecutionState:
        """
        Get complete execution state snapshot
        
        Returns:
            StrategyExecutionState with current state
        """
        block_states = []
        
        for block in self.config.blocks:
            # Count fired signals
            signals_fired = sum(
                1 for sig in block.signals
                if self.get_signal_state(block.name, sig.name).fired
            )
            
            # Count required signals
            if block.logic == "OR":
                signals_required = 1  # Only need one
            else:  # AND
                signals_required = sum(
                    1 for sig in block.signals if sig.logic == "AND"
                )
                
            # Get signal states
            signal_states = [
                self.get_signal_state(block.name, sig.name)
                for sig in block.signals
            ]
            
            block_state = BlockExecutionState(
                block_name=block.name,
                logic=block.logic,
                signals_fired=signals_fired,
                signals_required=signals_required,
                complete=self._is_block_complete(block.name),
                signal_states=signal_states
            )
            block_states.append(block_state)
            
        return StrategyExecutionState(
            strategy_name=self.config.name,
            current_candle=self.current_candle,
            complete=self.is_strategy_complete(),
            block_states=block_states
        )
        
    def on_candle(self, candle_index: int):
        """
        Called when a new candle arrives
        
        Args:
            candle_index: Index of the new candle
        """
        self.current_candle = candle_index
        
        # Check timing constraints
        self.check_and_reset_if_needed(candle_index)
