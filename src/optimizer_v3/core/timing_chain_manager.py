"""
Timing Chain Manager - Sequential Signal Constraints

Validates signals fire within time window of reference signal.

EXAMPLE (HOD Rejection v9):
Bar 100: HOD_REJECTION fires → record as reference
Bar 105: BELOW_HOD must fire within 12 bars (100-112) ✓
Bar 110: BEARISH must fire within 10 bars of BELOW_HOD (105-115) ✓

Sequential chain validation.

Author: BTC_Engine_v3
Date: February 2026
"""

from typing import Dict, List, Tuple


class TimingChainManager:
    """
    Manages sequential timing constraints
    
    TIMING CONSTRAINT = Reference-Based Window:
    - Signal A fires at bar N (reference)
    - Signal B must fire within X bars of Signal A
    - Window: bar N to bar N+X
    - Outside window: Signal B invalid
    
    Example Chain (HOD Rejection v9):
    1. HOD_REJECTION fires (bar 100) → reference
    2. BELOW_HOD fires (bar 105) → must be within 12 of HOD_REJECTION
       - Window: 100-112 ✓ Valid
    3. BEARISH fires (bar 110) → must be within 10 of BELOW_HOD
       - Window: 105-115 ✓ Valid
    """
    
    def validate_timing(
        self,
        fresh_signals: Dict[str, Dict],
        fired_history: Dict[str, int],
        bar_index: int
    ) -> Tuple[Dict[str, Dict], List[str]]:
        """
        Validate timing constraints for fresh signals
        
        Process:
        1. For each fresh signal, check if it has timing constraint
        2. If yes, find reference signal fire bar
        3. Validate current bar is within window
        4. If valid, add to valid_signals and update fired_history
        5. If invalid, add to violations
        
        Args:
            fresh_signals: Signals that fired this bar {id: data}
            fired_history: Historical fired signals {id: bar_index}
            bar_index: Current bar index
        
        Returns:
            (valid_signals, violations)
            - valid_signals: Dict of signals that passed timing validation
            - violations: List of violation messages
        
        Example:
            fresh_signals = {
                'hod::BELOW_HOD': {
                    'signal': 'BELOW_HOD',
                    'timing_constraint': {
                        'reference_signal': 'hod::HOD_REJECTION',
                        'max_candles': 12
                    }
                }
            }
            
            fired_history = {'hod::HOD_REJECTION': 100}
            bar_index = 105
            
            valid, violations = manager.validate_timing(
                fresh_signals,
                fired_history,
                bar_index
            )
            
            # Result:
            # valid = {'hod::BELOW_HOD': {...}}  (105 within 100-112)
            # violations = []
        """
        valid = {}
        violations = []
        
        for signal_id, signal_data in fresh_signals.items():
            # Check if signal has timing constraint
            timing = signal_data.get('timing_constraint')
            
            if not timing:
                # No constraint, always valid
                valid[signal_id] = signal_data
                fired_history[signal_id] = bar_index
                continue
            
            # Validate timing window
            reference = timing.get('reference_signal')
            max_candles = timing.get('max_candles')
            
            if not reference or max_candles is None:
                # Invalid constraint config, skip validation
                valid[signal_id] = signal_data
                fired_history[signal_id] = bar_index
                continue
            
            if reference not in fired_history:
                # Reference hasn't fired yet, signal invalid
                violations.append(
                    f"{signal_id} requires {reference} to fire first "
                    f"(reference not found in history)"
                )
                continue
            
            reference_bar = fired_history[reference]
            window_end = reference_bar + max_candles
            
            if bar_index <= window_end:
                # Within window ✓
                valid[signal_id] = signal_data
                fired_history[signal_id] = bar_index
            else:
                # Outside window ✗
                violations.append(
                    f"{signal_id} fired too late "
                    f"(bar {bar_index} > window end {window_end}). "
                    f"Required: within {max_candles} bars of {reference} (bar {reference_bar})"
                )
        
        return valid, violations
    
    def check_constraint_for_signal(
        self,
        signal_id: str,
        reference_signal: str,
        max_candles: int,
        fired_history: Dict[str, int],
        current_bar: int
    ) -> Tuple[bool, str]:
        """
        Check if specific signal meets timing constraint
        
        Utility method for manual constraint checking.
        
        Args:
            signal_id: Signal being checked
            reference_signal: Required reference signal
            max_candles: Maximum candles allowed between signals
            fired_history: Historical signal fires
            current_bar: Current bar index
        
        Returns:
            (is_valid, message)
        
        Example:
            valid, msg = manager.check_constraint_for_signal(
                'hod::BELOW_HOD',
                'hod::HOD_REJECTION',
                12,
                {'hod::HOD_REJECTION': 100},
                105
            )
            # Returns: (True, "Within window: bar 105 <= 112")
        """
        if reference_signal not in fired_history:
            return False, f"Reference signal {reference_signal} has not fired yet"
        
        reference_bar = fired_history[reference_signal]
        window_end = reference_bar + max_candles
        
        if current_bar <= window_end:
            bars_since = current_bar - reference_bar
            return True, (
                f"Within window: bar {current_bar} <= {window_end} "
                f"({bars_since}/{max_candles} bars after {reference_signal})"
            )
        else:
            bars_since = current_bar - reference_bar
            return False, (
                f"Outside window: bar {current_bar} > {window_end} "
                f"({bars_since}/{max_candles} bars after {reference_signal})"
            )
    
    def get_active_windows(
        self,
        fired_history: Dict[str, int],
        current_bar: int,
        max_window: int = 50
    ) -> Dict[str, Tuple[int, int]]:
        """
        Get currently active timing windows
        
        Useful for debugging - shows which reference signals
        are currently active and their window ranges.
        
        Args:
            fired_history: Historical signal fires
            current_bar: Current bar index
            max_window: Maximum window size to consider (default 50)
        
        Returns:
            Dict of {signal_id: (fire_bar, window_end)}
        
        Example:
            windows = manager.get_active_windows(fired_history, 105)
            # Returns: {
            #   'hod::HOD_REJECTION': (100, 150),
            #   'hod::BELOW_HOD': (105, 155)
            # }
        """
        active = {}
        
        for signal_id, fire_bar in fired_history.items():
            window_end = fire_bar + max_window
            
            if current_bar <= window_end:
                # Window still active
                active[signal_id] = (fire_bar, window_end)
        
        return active
    
    def reset(self):
        """
        Reset manager state
        
        Useful when starting new backtest or new strategy.
        (Note: fired_history is passed in, so this is mostly a placeholder)
        """
        pass  # State is managed externally via fired_history dict
