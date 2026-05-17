"""
RECHECK Validator - Multi-Level Signal Confirmation

Validates signals remain true after delay period.

EXAMPLE (BELOW_HOD from HOD Rejection v9):
- Bar 105: BELOW_HOD fires (price < HOD)
- Bar 108: Recheck #1 - is price still < HOD?
- Bar 110: Recheck #2 - is recheck #1 still valid?
- Bar 115: Recheck #3 - is original signal still valid?

Author: BTC_Engine_v3
Date: February 2026
"""

from typing import List, Dict, Any
from nautilus_trader.model.data import Bar

import logging
logger = logging.getLogger(__name__)

class RecheckValidator:
    """
    Validates pending recheck confirmations
    
    ENHANCED RECHECK SYSTEM:
    
    REFERENCE TYPES:
    - PARENT: Recheck relative to parent recheck fire bar
      Example: Recheck #2 at bar 2 after Recheck #1
    - SIGNAL: Recheck relative to ORIGINAL signal fire bar
      Example: Recheck of signal at bar 5 after original signal
    
    TIMING MODES:
    - AT: Validate condition AT bar X (or later)
      Example: "Check if price still < HOD at bar 108"
    - WITHIN: Signal must RE-FIRE within X bars
      Example: "HOD_REJECTION must re-fire within 20 bars"
    
    CRITICAL FIX: Preserves signal_fire_bar through nested chains
    """
    
    def validate_pending(
        self,
        pending_rechecks: List['RecheckState'],
        bar: Bar,
        bar_index: int,
        lookback: List[Bar],
        building_blocks: Dict[str, Any]
    ) -> List[str]:
        """
        Validate all pending rechecks due at current bar
        
        ENHANCED: Supports both AT and WITHIN timing modes
        
        Args:
            pending_rechecks: List of pending validations
            bar: Current bar
            bar_index: Current bar index
            lookback: Historical bars
            building_blocks: Instantiated blocks for re-evaluation
        
        Returns:
            List of confirmed signal IDs
        """
        confirmed = []
        still_pending = []
        
        for recheck in pending_rechecks:
            # Determine reference bar based on reference_type
            if recheck.reference_type == 'SIGNAL':
                # Relative to ORIGINAL signal
                reference_bar = recheck.signal_fire_bar or recheck.fire_bar
            else:  # 'PARENT'
                # Relative to parent recheck (or signal if no parent)
                reference_bar = recheck.fire_bar
            
            # CRITICAL: Defensive checks for None values
            if reference_bar is None:
                logger.info(f"Warning: Recheck {recheck.signal_name} has no reference bar, skipping")
                continue
            
            if recheck.bar_delay is None:
                logger.info(f"Warning: Recheck {recheck.signal_name} has no bar_delay, skipping")
                continue
            
            # Apply timing mode
            if recheck.timing_mode == 'AT':
                # AT mode: Check condition at bar X (or later)
                if bar_index >= reference_bar + recheck.bar_delay:
                    is_valid = self._validate_recheck_condition(
                        recheck,
                        bar,
                        lookback,
                        building_blocks
                    )
                    
                    if is_valid:
                        confirmed.append(recheck.signal_name)
                        
                        # Queue nested rechecks with correct reference
                        for nested in recheck.nested_rechecks:
                            if nested.reference_type == 'PARENT':
                                nested.fire_bar = bar_index  # Current bar
                            else:  # 'SIGNAL'
                                nested.fire_bar = recheck.signal_fire_bar or recheck.fire_bar
                            
                            # Preserve original signal fire bar
                            nested.signal_fire_bar = recheck.signal_fire_bar or recheck.fire_bar
                            
                            # CRITICAL: Ensure fire_bar is never None
                            if nested.fire_bar is None:
                                logger.info(f"Warning: Nested recheck {nested.signal_name} has None fire_bar, using current bar {bar_index}")
                                nested.fire_bar = bar_index
                            
                            still_pending.append(nested)
                else:
                    # Not yet time
                    still_pending.append(recheck)
            
            elif recheck.timing_mode == 'WITHIN':
                # WITHIN mode: Signal must re-fire within window
                window_start = reference_bar
                window_end = reference_bar + recheck.bar_delay
                
                # CRITICAL: Double-check window_end is valid (defensive)
                if window_end is None or window_start is None:
                    logger.info(f"Warning: Recheck {recheck.signal_name} has invalid window bounds, skipping")
                    continue
                
                if bar_index < window_start:
                    # Before window starts
                    still_pending.append(recheck)
                
                elif window_start <= bar_index <= window_end:
                    # Inside window - check if signal re-fires
                    if not recheck.window_validated:
                        is_valid = self._check_signal_refires(
                            recheck,
                            bar,
                            lookback,
                            building_blocks
                        )
                        
                        if is_valid:
                            # Signal re-fired! Confirmed
                            confirmed.append(recheck.signal_name)
                            recheck.window_validated = True
                            
                            # Queue nested rechecks
                            for nested in recheck.nested_rechecks:
                                if nested.reference_type == 'PARENT':
                                    nested.fire_bar = bar_index
                                else:
                                    nested.fire_bar = recheck.signal_fire_bar or recheck.fire_bar
                                
                                nested.signal_fire_bar = recheck.signal_fire_bar or recheck.fire_bar
                                
                                # CRITICAL: Ensure fire_bar is never None
                                if nested.fire_bar is None:
                                    logger.info(f"Warning: Nested recheck {nested.signal_name} has None fire_bar (WITHIN mode), using current bar {bar_index}")
                                    nested.fire_bar = bar_index
                                
                                still_pending.append(nested)
                        else:
                            # Still waiting for re-fire
                            still_pending.append(recheck)
                    # else: Already validated, don't check again
                
                else:  # bar_index > window_end
                    # Past window without re-fire - invalidated
                    pass  # Don't add to confirmed or still_pending
        
        # Update pending list (in place)
        pending_rechecks.clear()
        pending_rechecks.extend(still_pending)
        
        return confirmed
    
    def _validate_recheck_condition(
        self,
        recheck: 'RecheckState',
        bar: Bar,
        lookback: List[Bar],
        building_blocks: Dict
    ) -> bool:
        """
        Validate if recheck condition still holds
        
        Validation Modes:
        - SIGNAL: Re-evaluate building block signal
        - RECHECK: Validate parent recheck still holds
        - CONFIDENCE: Check confidence threshold still met
        """
        if recheck.validation_mode == 'SIGNAL':
            return self._validate_signal_mode(recheck, bar, lookback, building_blocks)
        elif recheck.validation_mode == 'RECHECK':
            return self._validate_recheck_mode(recheck, bar, lookback)
        elif recheck.validation_mode == 'CONFIDENCE':
            return self._validate_confidence_mode(recheck, bar, lookback)
        
        return False
    
    def _validate_signal_mode(
        self,
        recheck: 'RecheckState',
        bar: Bar,
        lookback: List[Bar],
        building_blocks: Dict
    ) -> bool:
        """
        SIGNAL mode: Re-evaluate building block
        
        Example: BELOW_HOD
        - Original: price < HOD at bar 105
        - Recheck: is price still < HOD at bar 108?
        """
        block = building_blocks.get(recheck.block_name)
        
        if not block:
            return False
        
        try:
            # Re-evaluate block
            result = block.analyze(lookback + [bar])
            
            # Check if same signal still fires
            original_signal = recheck.original_condition.get('signal_type')
            current_signal = result.get('signal')
            
            return current_signal == original_signal
            
        except Exception as e:
            # Log error but don't crash
            logger.error(f"Error validating SIGNAL mode for {recheck.block_name}: {e}")
            return False
    
    def _validate_recheck_mode(
        self,
        recheck: 'RecheckState',
        bar: Bar,
        lookback: List[Bar]
    ) -> bool:
        """
        RECHECK mode: Validate parent recheck still holds
        
        Example: RECHECK of RECHECK
        - Parent recheck validated at bar 108
        - Child recheck validates parent still true at bar 110
        """
        if not recheck.parent_recheck:
            return False
        
        # Check if parent condition still holds
        # For now, we assume parent is valid if it was confirmed
        # More sophisticated implementation would re-validate parent
        return True
    
    def _validate_confidence_mode(
        self,
        recheck: 'RecheckState',
        bar: Bar,
        lookback: List[Bar]
    ) -> bool:
        """
        CONFIDENCE mode: Check confidence threshold
        
        Example: High confidence signal
        - Original: 95% confidence
        - Recheck: confidence still >= 90%?
        """
        original_confidence = recheck.original_condition.get('metadata', {}).get('confidence', 0)
        
        # For now, we assume confidence persists
        # More sophisticated implementation would recalculate
        return original_confidence >= 90
    
    def _check_signal_refires(
        self,
        recheck: 'RecheckState',
        bar: Bar,
        lookback: List[Bar],
        building_blocks: Dict
    ) -> bool:
        """
        WITHIN mode: Check if signal re-fires this bar
        
        Example: HOD_REJECTION within 20 bars
        - Window: bars 100-120
        - Check each bar if HOD_REJECTION fires again
        - First re-fire confirms signal
        """
        block = building_blocks.get(recheck.block_name)
        
        if not block:
            return False
        
        try:
            # Evaluate block for current bar
            result = block.analyze(lookback + [bar])
            
            # Check if same signal fires
            original_signal = recheck.original_condition.get('signal_type')
            current_signal = result.get('signal')
            
            return current_signal == original_signal
            
        except Exception as e:
            # Log error but don't crash
            logger.error(f"Error checking signal re-fire for {recheck.block_name}: {e}")
            return False
