"""
Exit Hierarchy Evaluator - 3-Tier Exit System with RECHECK Validation

Evaluates exits in hierarchical order:
1. STRATEGY-level (highest priority)
2. BLOCK-level (medium priority)
3. SIGNAL-level (lowest priority)

First match wins.

RECHECK VALIDATION (INSTITUTIONAL-GRADE):
- Exits can require confirmation before triggering
- AT mode: Signal must be true at exact bar (fire_bar + bar_delay)
- WITHIN mode: Signal must re-fire within bar window

EXAMPLE (HOD Rejection v9):
Strategy exits:
  - BULLISH_BREAKER: 50% TP-aware
  - BULLISH_CROSS: 50% immediate

Block exits (hod):
  - AT_ASIA_50: 50% TP-aware
  - BULLISH: 0% TP-aware

Signal exits (BELOW_HOD):
  - VWAP_CROSS_UP: 15% TP-aware (with RECHECK within 5 bars)

If BULLISH_BREAKER fires → exit 50% (strategy level wins)
If none fire → check block level
If none fire → check signal level

Author: BTC_Engine_v3
Date: February 2026
"""

from typing import Dict, List, Any, Optional
from dataclasses import dataclass, field
from nautilus_trader.model.data import Bar

import logging
logger = logging.getLogger(__name__)

@dataclass
class PendingExitRecheck:
    """State for pending exit recheck validation"""
    exit_signal_name: str
    exit_cond: Any  # ExitCondition object
    first_fire_bar: int
    bar_delay: int
    timing_mode: str  # 'AT' or 'WITHIN'
    validation_mode: str  # 'SIGNAL', 'RECHECK', 'CONFIDENCE'
    reconfirmed: bool = False
    reconfirm_bar: Optional[int] = None


@dataclass
class ExitDecision:
    """Result of exit evaluation"""
    should_exit: bool
    percentage: float  # TP-aware percentage
    reason: str
    mode: str  # 'ABSOLUTE' or 'FLEXIBLE'
    binding_level: str  # 'STRATEGY', 'BLOCK', or 'SIGNAL'


class ExitHierarchyEvaluator:
    """
    Evaluates 3-tier exit hierarchy with RECHECK validation
    
    Evaluation Order:
    1. Strategy-level (all trades)
    2. Block-level (specific block)
    3. Signal-level (specific signal)
    
    First match wins.
    
    TP-AWARE CALCULATION:
    - Exit percentages apply to REMAINING position
    - Example: Original 100% → TP1 30% → Remaining 70%
      - Exit requests 50% → Actual: 50% of 70% = 35%
    
    RECHECK VALIDATION:
    - Exits can require confirmation before triggering
    - AT mode: Signal must be true at exact bar (fire_bar + bar_delay)
    - WITHIN mode: Signal must re-fire within bar window
    - Pending rechecks tracked in self.pending_exit_rechecks
    """
    
    def __init__(self):
        """Initialize exit hierarchy evaluator with recheck state tracking"""
        self.pending_exit_rechecks: Dict[str, PendingExitRecheck] = {}
    
    def evaluate(
        self,
        bar: Bar,
        bar_index: int,
        lookback: List[Bar],
        exit_conditions: Dict[str, List['ExitCondition']],
        current_trade: 'TradeState',
        building_blocks: Dict[str, Any]
    ) -> ExitDecision:
        """
        Evaluate ALL exit conditions and ACCUMULATE percentages
        
        CRITICAL: Multiple exits can fire on same bar!
        - User configures 25% exit on Strategy level
        - User configures 10% exit on Block level  
        - User configures 15% exit on Signal level
        - ALL fire on bar 150 → Total: 50% exit
        
        Process:
        1. Check ALL STRATEGY-level exits → accumulate
        2. Check ALL BLOCK-level exits → accumulate
        3. Check ALL SIGNAL-level exits → accumulate
        4. Return accumulated percentage across ALL levels
        
        Args:
            bar: Current bar
            bar_index: Current bar index
            lookback: Historical bars
            exit_conditions: Organized by level
            current_trade: Current trade state
            building_blocks: Blocks for signal evaluation
        
        Returns:
            ExitDecision with accumulated percentage from ALL firing exits
        """
        accumulated_percentage = 0.0
        fired_reasons = []
        
        # TIER 1: Strategy-level exits - CHECK ALL, ACCUMULATE
        for exit_cond in exit_conditions.get('STRATEGY', []):
            if self._check_exit_signal(exit_cond, bar, bar_index, lookback, building_blocks):
                exit_pct = self._calculate_tp_aware_percentage(
                    exit_cond.percentage,
                    exit_cond.mode,
                    current_trade
                )
                accumulated_percentage += exit_pct
                fired_reasons.append(f"STRATEGY: {exit_cond.signal_name} ({exit_pct*100:.1f}%)")
        
        # TIER 2: Block-level exits - CHECK ALL, ACCUMULATE
        for block_name, exits in exit_conditions.get('BLOCK', {}).items():
            for exit_cond in exits:
                if self._check_exit_signal(exit_cond, bar, bar_index, lookback, building_blocks):
                    exit_pct = self._calculate_tp_aware_percentage(
                        exit_cond.percentage,
                        exit_cond.mode,
                        current_trade
                    )
                    accumulated_percentage += exit_pct
                    fired_reasons.append(f"BLOCK({block_name}): {exit_cond.signal_name} ({exit_pct*100:.1f}%)")
        
        # TIER 3: Signal-level exits - CHECK ALL (with binding), ACCUMULATE
        # INSTITUTIONAL-GRADE SIGNAL BINDING ENFORCEMENT
        
        # DEBUG LOGGING (comprehensive)
        import logging
        import os
        log_dir = '/home/sirrus/projects/BTC_Engine_v3/logs/wiring-test'
        os.makedirs(log_dir, exist_ok=True)
        
        binding_logger = logging.getLogger('binding_debug')
        if not binding_logger.handlers:
            binding_logger.setLevel(logging.DEBUG)
            fh = logging.FileHandler(os.path.join(log_dir, 'signal_binding.log'), mode='w')
            fh.setFormatter(logging.Formatter('[%(asctime)s] %(message)s'))
            binding_logger.addHandler(fh)
        
        # Log trade entry signals (ONCE per trade check)
        if bar_index < 200:  # Only log first 200 bars
            binding_logger.debug(f"\n=== BAR {bar_index}: CHECKING SIGNAL-LEVEL EXITS ===")
            binding_logger.debug(f"Trade entry_signals: {current_trade.entry_signals}")
            binding_logger.debug(f"Available signal-level exits: {list(exit_conditions.get('SIGNAL', {}).keys())}")
        
        for signal_id, exits in exit_conditions.get('SIGNAL', {}).items():
            # CRITICAL FIX: Compare FULL signal_id, not just signal name!
            # signal_id = "asia_session_50_percent::BELOW_ASIA_50"
            # entry_signals = ["asia_session_50_percent::AT_ASIA_50", "asia_session_50_percent::BELOW_ASIA_50"]
            # Must match FULL ID for binding to work!
            
            # DEBUG: Log binding check
            if bar_index < 200:
                binding_logger.debug(f"\nChecking exit for signal_id: {signal_id}")
                binding_logger.debug(f"  Binding check: '{signal_id}' in {current_trade.entry_signals}?")
                binding_logger.debug(f"  Result: {signal_id in current_trade.entry_signals}")
            
            if signal_id not in current_trade.entry_signals:
                if bar_index < 200:
                    binding_logger.debug(f"  ❌ SKIPPED - signal not in entry signals")
                continue  # Skip - this exit not bound to entry signals
            
            if bar_index < 200:
                binding_logger.debug(f"  ✅ PASSED binding check - checking exit condition")
            
            for exit_cond in exits:
                if self._check_exit_signal(exit_cond, bar, bar_index, lookback, building_blocks):
                    exit_pct = self._calculate_tp_aware_percentage(
                        exit_cond.percentage,
                        exit_cond.mode,
                        current_trade
                    )
                    accumulated_percentage += exit_pct
                    fired_reasons.append(f"SIGNAL({signal_id}): {exit_cond.signal_name} ({exit_pct*100:.1f}%)")
        
        # Return accumulated result
        if accumulated_percentage > 0:
            # Cap at 100% remaining (can't exit more than exists)
            accumulated_percentage = min(accumulated_percentage, current_trade.remaining_position)
            
            return ExitDecision(
                should_exit=True,
                percentage=accumulated_percentage,
                reason=" + ".join(fired_reasons),
                mode='ACCUMULATED',  # Multiple exits accumulated
                binding_level='MULTIPLE' if len(fired_reasons) > 1 else fired_reasons[0].split(':')[0]
            )
        else:
            # No exits triggered
            return ExitDecision(
                should_exit=False,
                percentage=0.0,
                reason='',
                mode='',
                binding_level=''
            )
    
    def _check_exit_signal(
        self,
        exit_cond: 'ExitCondition',
        bar: Bar,
        bar_index: int,
        lookback: List[Bar],
        building_blocks: Dict
    ) -> bool:
        """
        Check if exit signal fired with RECHECK validation
        
        RECHECK VALIDATION (INSTITUTIONAL-GRADE):
        If exit condition has recheck enabled:
        1. Signal must fire initially → record as pending
        2. Must re-fire within specified bar window
        3. Only then is exit valid
        
        Two Modes:
        - AT: Signal must be true AT exact bar (fire_bar + bar_delay)
        - WITHIN: Signal must re-fire WITHIN window (0 to bar_delay bars)
        
        Example (WITHIN mode):
            Exit: ABOVE_ASIA_50 with RECHECK (WITHIN 5 bars)
            Bar 100: ABOVE_ASIA_50 fires → record as pending
            Bar 101-104: Check if re-fires → if yes, VALID!
            Bar 106+: Window expired → INVALID
        
        Example (AT mode):
            Exit: ABOVE_ASIA_50 with RECHECK (AT 5 bars)
            Bar 100: ABOVE_ASIA_50 fires → record as pending
            Bar 105: Check if still true → if yes, VALID!
            Bar 106+: Not checked (AT mode only checks exact bar)
        
        Args:
            exit_cond: Exit condition to check
            bar: Current bar
            bar_index: Current bar index
            lookback: Historical bars
            building_blocks: Instantiated blocks
        
        Returns:
            True if exit signal fired AND recheck valid (if required)
        """
        import pandas as pd
        import logging
        import os
        
        # DEBUG LOGGER
        log_dir = '/home/sirrus/projects/BTC_Engine_v3/logs/wiring-test'
        os.makedirs(log_dir, exist_ok=True)
        
        exit_logger = logging.getLogger('exit_debug')
        if not exit_logger.handlers:
            exit_logger.setLevel(logging.DEBUG)
            fh = logging.FileHandler(os.path.join(log_dir, 'exit_conditions.log'), mode='w')
            fh.setFormatter(logging.Formatter('[%(asctime)s] %(message)s'))
            exit_logger.addHandler(fh)
        
        exit_signal_name = exit_cond.signal_name
        recheck_config = exit_cond.recheck_config
        
        # Check if signal is currently firing
        signal_firing_now = self._signal_currently_firing(
            exit_signal_name,
            bar,
            lookback,
            building_blocks,
            bar_index,
            exit_logger
        )
        
        # BRANCH 1: RECHECK DISABLED (simple immediate exit)
        # CRITICAL FIX: Handle None, dict, AND object formats
        if not recheck_config:
            # No recheck - simple check
            if signal_firing_now:
                exit_logger.info(f"🎯 EXIT (no recheck): {exit_signal_name} at bar {bar_index}")
            return signal_firing_now
        
        # recheck_config exists - check if enabled (handle dict vs object)
        if isinstance(recheck_config, dict):
            recheck_enabled = recheck_config.get('enabled', False)
            bar_delay = recheck_config.get('bar_delay', 5)
            timing_mode = recheck_config.get('timing_mode', 'AT')
            validation_mode = recheck_config.get('validation_mode', 'SIGNAL')
        else:
            # Object format (RecheckConfig dataclass)
            recheck_enabled = getattr(recheck_config, 'enabled', False)
            bar_delay = getattr(recheck_config, 'bar_delay', 5)
            timing_mode = getattr(recheck_config, 'timing_mode', 'AT')
            validation_mode = getattr(recheck_config, 'validation_mode', 'SIGNAL')
        
        if not recheck_enabled:
            # Recheck disabled - simple check
            if signal_firing_now:
                exit_logger.info(f"🎯 EXIT (no recheck): {exit_signal_name} at bar {bar_index}")
            return signal_firing_now
        
        # BRANCH 2: RECHECK ENABLED (validation required)
        
        # Create unique key for this pending recheck (signal name only, not bar_index!)
        # CRITICAL FIX: Use signal name only so multiple bars check SAME pending recheck
        recheck_key = exit_signal_name
        
        if signal_firing_now:
            # Signal fired! Check if already pending or new
            if recheck_key not in self.pending_exit_rechecks:
                # NEW SIGNAL FIRE - Record as pending
                self.pending_exit_rechecks[recheck_key] = PendingExitRecheck(
                    exit_signal_name=exit_signal_name,
                    exit_cond=exit_cond,
                    first_fire_bar=bar_index,
                    bar_delay=bar_delay,
                    timing_mode=timing_mode,
                    validation_mode=validation_mode,
                    reconfirmed=False
                )
                exit_logger.info(
                    f"📝 EXIT RECHECK PENDING: {exit_signal_name} at bar {bar_index} "
                    f"(mode: {timing_mode}, delay: {bar_delay})"
                )
                return False  # Not valid yet - need confirmation
            else:
                # ALREADY PENDING - Check if this is reconfirmation
                pending = self.pending_exit_rechecks[recheck_key]
                bars_since_first = bar_index - pending.first_fire_bar
                
                # CRITICAL: Use PENDING timing_mode, not freshly read one!
                if pending.timing_mode == 'WITHIN':
                    # WITHIN mode: Re-fire within window validates
                    if bars_since_first <= pending.bar_delay:
                        # RECONFIRMED! Exit valid!
                        pending.reconfirmed = True
                        pending.reconfirm_bar = bar_index
                        exit_logger.info(
                            f"✅ EXIT RECHECK CONFIRMED (WITHIN): {exit_signal_name} "
                            f"(first: bar {pending.first_fire_bar}, reconfirm: bar {bar_index}, "
                            f"window: {bar_delay} bars)"
                        )
                        # Cleanup pending
                        del self.pending_exit_rechecks[recheck_key]
                        return True  # VALID EXIT!
                    else:
                        # Window expired - cleanup
                        exit_logger.warning(
                            f"❌ EXIT RECHECK EXPIRED: {exit_signal_name} "
                            f"(bars since: {bars_since_first} > window: {bar_delay})"
                        )
                        del self.pending_exit_rechecks[recheck_key]
                        return False
                
                elif pending.timing_mode == 'AT':
                    # AT mode: Must be true AT exact bar
                    if bars_since_first == pending.bar_delay:
                        # AT EXACT BAR! Exit valid!
                        pending.reconfirmed = True
                        pending.reconfirm_bar = bar_index
                        exit_logger.info(
                            f"✅ EXIT RECHECK CONFIRMED (AT): {exit_signal_name} "
                            f"at bar {bar_index} (delay: {bar_delay})"
                        )
                        # Cleanup pending
                        del self.pending_exit_rechecks[recheck_key]
                        return True  # VALID EXIT!
                    else:
                        # Not at exact bar - keep waiting
                        return False
        
        else:
            # Signal NOT firing now
            # Check if pending recheck should expire
            if recheck_key in self.pending_exit_rechecks:
                pending = self.pending_exit_rechecks[recheck_key]
                bars_since_first = bar_index - pending.first_fire_bar
                
                # CRITICAL: Use PENDING timing_mode!
                if pending.timing_mode == 'WITHIN':
                    # WITHIN mode: Check if window expired
                    if bars_since_first > pending.bar_delay:
                        exit_logger.warning(
                            f"❌ EXIT RECHECK WINDOW EXPIRED: {exit_signal_name} "
                            f"(bars since: {bars_since_first} > window: {bar_delay})"
                        )
                        del self.pending_exit_rechecks[recheck_key]
                
                elif pending.timing_mode == 'AT':
                    # AT mode: Signal must fire AT exact bar
                    if bars_since_first == pending.bar_delay:
                        # AT exact bar but signal NOT true → invalid
                        exit_logger.warning(
                            f"❌ EXIT RECHECK FAILED (AT): {exit_signal_name} "
                            f"not true at bar {bar_index} (expected at bar {pending.first_fire_bar + pending.bar_delay})"
                        )
                        del self.pending_exit_rechecks[recheck_key]
                    elif bars_since_first > pending.bar_delay:
                        # Past exact bar → cleanup
                        del self.pending_exit_rechecks[recheck_key]
        
        return False
    
    def _signal_currently_firing(
        self,
        exit_signal_name: str,
        bar: Bar,
        lookback: List[Bar],
        building_blocks: Dict,
        bar_index: int = 0,
        exit_logger = None
    ) -> bool:
        """
        Check if signal is currently firing (helper method)
        
        Separated from _check_exit_signal() for cleaner recheck logic.
        
        Args:
            exit_signal_name: Signal to check
            bar: Current bar
            lookback: Historical bars
            building_blocks: Instantiated blocks
            bar_index: Current bar index (for logging)
            exit_logger: Logger instance (optional)
        
        Returns:
            True if signal firing now, False otherwise
        """
        import pandas as pd
        # CRITICAL FIX: Convert List[Bar] to DataFrame
        bars = lookback + [bar]
        
        if not bars:
            return False
        
        df = pd.DataFrame({
            'timestamp': [pd.Timestamp(b.ts_event, unit='ns') for b in bars],
            'open': [float(b.open) for b in bars],
            'high': [float(b.high) for b in bars],
            'low': [float(b.low) for b in bars],
            'close': [float(b.close) for b in bars],
            'volume': [float(b.volume) for b in bars]
        })
        
        # Check all building blocks for exit signal
        for block_name, block_instance in building_blocks.items():
            try:
                # CRITICAL FIX: Pass DataFrame, NOT List[Bar]!
                result = block_instance.analyze(df)
                
                if result and result.get('signal') == exit_signal_name:
                    # FOUND IT!
                    if exit_logger and bar_index < 100:
                        exit_logger.debug(
                            f"Signal {exit_signal_name} firing from {block_name} at bar {bar_index}"
                        )
                    return True
                    
            except Exception as e:
                # Log error but don't crash
                if exit_logger:
                    exit_logger.error(f"ERROR checking {exit_signal_name} in {block_name}: {e}")
                continue
        
        return False
    
    def reset(self):
        """Reset evaluator state for new backtest"""
        self.pending_exit_rechecks.clear()
    
    def _calculate_tp_aware_percentage(
        self,
        requested_pct: float,
        mode: str,
        current_trade: 'TradeState'
    ) -> float:
        """
        Calculate TP-aware exit percentage
        
        TP-AWARE = Exit applies to REMAINING position
        
        Two Modes:
        1. ABSOLUTE: Percentage of ORIGINAL position
           - Example: Exit 50% ABSOLUTE → always 50% of original
           - Used for hard exits (stop loss, etc.)
        
        2. FLEXIBLE (TP-aware): Percentage of REMAINING position
           - Example: Exit 50% FLEXIBLE → 50% of remaining
           - Original: 100%
           - TP1 hit (30%): Remaining = 70%
           - Exit 50% FLEXIBLE: 50% of 70% = 35% of original
        
        Args:
            requested_pct: Requested exit percentage (0.0-1.0)
            mode: 'ABSOLUTE' or 'FLEXIBLE'
            current_trade: Current trade state
        
        Returns:
            Actual percentage to exit (0.0-1.0)
        
        Example (FLEXIBLE/TP-aware):
            Original: 100%
            TP hits: [30%, 20%]  # Total 50% exited
            Remaining: 50%
            Exit requests: 50% FLEXIBLE
            Actual: 50% × 50% = 25% of original
        
        Example (ABSOLUTE):
            Original: 100%
            TP hits: [30%, 20%]  # Total 50% exited
            Remaining: 50%
            Exit requests: 50% ABSOLUTE
            Actual: 50% of original (but capped at 50% remaining)
        """
        if mode == 'ABSOLUTE':
            # Absolute percentage of original position
            # But capped at remaining position
            return min(requested_pct, current_trade.remaining_position)
        
        else:  # 'FLEXIBLE' (TP-aware default)
            # Percentage of remaining position
            return requested_pct * current_trade.remaining_position
    
    def check_specific_exit(
        self,
        exit_signal_name: str,
        bar: Bar,
        lookback: List[Bar],
        building_blocks: Dict[str, Any]
    ) -> bool:
        """
        Check if specific exit signal has fired
        
        Utility method for manual exit checking.
        
        Args:
            exit_signal_name: Signal to check (e.g., 'VWAP_CROSS_UP')
            bar: Current bar
            lookback: Historical bars
            building_blocks: Instantiated blocks
        
        Returns:
            True if signal fired
        
        Example:
            fired = evaluator.check_specific_exit(
                'VWAP_CROSS_UP',
                current_bar,
                lookback_bars,
                blocks
            )
        """
        for block_name, block_instance in building_blocks.items():
            try:
                result = block_instance.analyze(lookback + [bar])
                
                if result.get('signal') == exit_signal_name:
                    return True
                    
            except Exception as e:
                logger.error(f"Error checking {exit_signal_name} in {block_name}: {e}")
                continue
        
        return False
    
    def get_exit_priority_order(
        self,
        exit_conditions: Dict[str, Any]
    ) -> List[str]:
        """
        Get list of exit conditions in priority order
        
        Useful for debugging - shows evaluation order.
        
        Args:
            exit_conditions: Organized exit conditions
        
        Returns:
            List of exit condition identifiers in priority order
        
        Example:
            order = evaluator.get_exit_priority_order(exits)
            # Returns: [
            #   'STRATEGY:BULLISH_BREAKER',
            #   'STRATEGY:BULLISH_CROSS',
            #   'BLOCK(hod):AT_ASIA_50',
            #   'BLOCK(hod):BULLISH',
            #   'SIGNAL(hod::BELOW_HOD):VWAP_CROSS_UP'
            # ]
        """
        priority_order = []
        
        # Strategy-level (highest priority)
        for exit_cond in exit_conditions.get('STRATEGY', []):
            priority_order.append(f"STRATEGY:{exit_cond.signal_name}")
        
        # Block-level
        for block_name, exits in exit_conditions.get('BLOCK', {}).items():
            for exit_cond in exits:
                priority_order.append(f"BLOCK({block_name}):{exit_cond.signal_name}")
        
        # Signal-level (lowest priority)
        for signal_id, exits in exit_conditions.get('SIGNAL', {}).items():
            for exit_cond in exits:
                priority_order.append(f"SIGNAL({signal_id}):{exit_cond.signal_name}")
        
        return priority_order
