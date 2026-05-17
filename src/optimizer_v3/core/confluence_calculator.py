"""
Confluence Calculator - Signal Confluence Scoring

Calculates total confluence points from fired signals.

EXAMPLE (HOD Rejection v9):
Signals:
  - HOD_REJECTION (AND): 25 pts ✓ fired
  - BELOW_HOD (AND): 30 pts ✓ fired (triple confirmed)
  - BEARISH (AND): 20 pts ✓ fired
  - BEARISH_CROSS (OR): 15 pts ✗ not fired
  - BEARISH_DIVERGENCE (OR): 10 pts ✗ not fired
  - BEARISH_SWEEP (OR): 10 pts ✗ not fired

Total: 75 pts (25 + 30 + 20)
Threshold: 40 pts
Decision: ENTER (75 >= 40)

Author: BTC_Engine_v3
Date: February 2026
"""

from typing import List, Dict, Any


class ConfluenceCalculator:
    """
    Calculates confluence scores with scaling
    
    CONFLUENCE = Weighted Signal Sum:
    - Each signal has weight (points)
    - AND signals: Required (must fire for entry)
    - OR signals: Bonus points (optional)
    - RECHECK bonus: +20% for confirmed signals
    
    Example Calculation:
    1. Base weights from signals that fired
    2. Apply RECHECK bonuses (if applicable)
    3. Sum total points
    4. Compare to threshold
    """
    
    def calculate(
        self,
        strategy_config: Any,
        fired_signals: List[str]
    ) -> int:
        """
        Calculate total confluence points
        
        Process:
        1. Iterate through all blocks in strategy
        2. For each signal in block:
           - If signal fired, add its weight
           - If signal has RECHECK confirmations, add bonus
        3. Sum all weights
        
        Args:
            strategy_config: Strategy configuration
            fired_signals: List of signal IDs that fired
        
        Returns:
            Total confluence points
        
        Example:
            calculator = ConfluenceCalculator()
            
            fired_signals = [
                'hod::HOD_REJECTION',
                'hod::BELOW_HOD',
                'hod::BELOW_HOD::CONFIRMED_1X',  # Recheck #1
                'hod::BELOW_HOD::CONFIRMED_2X',  # Recheck #2
                'hod::BELOW_HOD::CONFIRMED_3X',  # Recheck #3
                'hod::BEARISH'
            ]
            
            score = calculator.calculate(strategy_config, fired_signals)
            # Returns: 75 pts
            #   HOD_REJECTION: 25
            #   BELOW_HOD: 30 (base) × 1.2 (triple confirmed) = 36
            #   BEARISH: 20
            #   Total: 25 + 36 + 20 = 81 pts (rounded to 81)
        """
        total = 0
        
        for block in strategy_config.blocks:
            for signal in block.signals:
                signal_id = f"{block.name}::{signal.name}"
                
                if signal_id in fired_signals:
                    # Base weight
                    weight = getattr(signal, 'weight', 10)
                    # CRITICAL: Defensive check - if weight is explicitly None, use default
                    if weight is None:
                        weight = 10

                    # Apply RECHECK bonuses
                    bonus_multiplier = self._calculate_recheck_bonus(
                        signal_id,
                        fired_signals
                    )
                    # CRITICAL: Defensive check - if bonus calc returns None, use 1.0
                    if bonus_multiplier is None:
                        bonus_multiplier = 1.0

                    # Final weighted score
                    weighted_score = int(weight * bonus_multiplier)
                    total += weighted_score
        
        return total
    
    def _calculate_recheck_bonus(
        self,
        signal_id: str,
        fired_signals: List[str]
    ) -> float:
        """
        Calculate RECHECK bonus multiplier
        
        Bonus Structure:
        - No confirmations: 1.0x (base)
        - 1 confirmation: 1.05x (+5%)
        - 2 confirmations: 1.10x (+10%)
        - 3+ confirmations: 1.20x (+20%)
        
        Args:
            signal_id: Signal to check
            fired_signals: All fired signals
        
        Returns:
            Multiplier (1.0 to 1.2)
        
        Example:
            signal_id = 'hod::BELOW_HOD'
            fired_signals = [
                'hod::BELOW_HOD',
                'hod::BELOW_HOD::CONFIRMED_1X',
                'hod::BELOW_HOD::CONFIRMED_2X',
                'hod::BELOW_HOD::CONFIRMED_3X'
            ]
            
            bonus = calculator._calculate_recheck_bonus(signal_id, fired_signals)
            # Returns: 1.20 (3 confirmations = +20%)
        """
        # Count confirmations for this signal
        confirmations = 0
        
        for fired in fired_signals:
            if fired.startswith(f"{signal_id}::CONFIRMED"):
                confirmations += 1
        
        # Apply bonus based on confirmation count
        if confirmations == 0:
            return 1.0  # No bonus
        elif confirmations == 1:
            return 1.05  # +5% bonus
        elif confirmations == 2:
            return 1.10  # +10% bonus
        else:  # 3+
            return 1.20  # +20% bonus
    
    def check_required_signals(
        self,
        strategy_config: Any,
        fired_signals: List[str]
    ) -> bool:
        """
        Check if all required (AND) signals in AND blocks fired
        
        Per AND/OR logic design (docs/strategy-builder/06_AND_OR_LOGIC_SYSTEM.md):
        - AND blocks: All AND-logic signals in the block must fire
        - OR blocks: No signals required (optional boosters)
        
        Only signals in AND-logic blocks with AND-logic are required.
        Signals in OR blocks are optional regardless of signal-level logic.
        
        BTCAAAAA-24644: Fixed to respect block-level logic — previously
        required ALL AND signals across ALL blocks including OR blocks.
        
        Args:
            strategy_config: Strategy configuration
            fired_signals: List of fired signals
        
        Returns:
            True if all required signals present, False otherwise
        
        Example:
            required_ok = calculator.check_required_signals(
                strategy_config,
                ['hod::HOD_REJECTION', 'hod::BEARISH']
            )
            # Returns: False (missing hod::BELOW_HOD which is AND in AND block)
        """
        for block in strategy_config.blocks:
            block_logic = getattr(block, 'logic', 'AND')
            # Skip OR blocks — their signals are optional per AND/OR architecture
            if block_logic == 'OR':
                continue
            
            for signal in block.signals:
                signal_logic = getattr(signal, 'logic', 'OR')
                if signal_logic == 'AND':
                    signal_id = f"{block.name}::{signal.name}"
                    if signal_id not in fired_signals:
                        return False
        
        return True  # All required signals present
        
    def get_signal_breakdown(
        self,
        strategy_config: Any,
        fired_signals: List[str]
    ) -> Dict[str, int]:
        """
        Get breakdown of points by signal
        
        Useful for debugging - shows contribution of each signal.
        
        Args:
            strategy_config: Strategy configuration
            fired_signals: Fired signals
        
        Returns:
            Dict of {signal_id: points}
        
        Example:
            breakdown = calculator.get_signal_breakdown(
                strategy_config,
                fired_signals
            )
            # Returns: {
            #   'hod::HOD_REJECTION': 25,
            #   'hod::BELOW_HOD': 36,  # (30 × 1.2)
            #   'hod::BEARISH': 20
            # }
        """
        breakdown = {}
        
        for block in strategy_config.blocks:
            for signal in block.signals:
                signal_id = f"{block.name}::{signal.name}"
                
                if signal_id in fired_signals:
                    weight = getattr(signal, 'weight', 10)
                    # CRITICAL: Defensive check - if weight is None, use default
                    if weight is None:
                        weight = 10
                    
                    bonus = self._calculate_recheck_bonus(signal_id, fired_signals)
                    # CRITICAL: Defensive check - if bonus is None, use 1.0
                    if bonus is None:
                        bonus = 1.0
                    
                    points = int(weight * bonus)

                    breakdown[signal_id] = points
        
        return breakdown
