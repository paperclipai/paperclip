"""
Institutional Signal Evaluator - Production-Grade Trade Decision Engine

VALIDATED FROM: HOD Rejection v9 Strategy (Real Production)

Features:
- Multi-level RECHECK validation
- Sequential TIMING constraints
- 3-tier EXIT hierarchy
- TP-aware exit calculations
- Single trade management
- Bar-by-bar state transitions

Author: BTC_Engine_v3
Date: February 2026
"""

from typing import List, Dict, Optional, Any, Tuple
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
import pandas as pd

from nautilus_trader.model.data import Bar
from nautilus_trader.model.objects import Price, Quantity
from src.detectors.building_blocks.registry import BlockRegistry

import logging
logger = logging.getLogger(__name__)

@dataclass
class SignalEvaluationResult:
    """Result of signal evaluation for current bar"""
    confluence_score: int
    signals_fired: List[str]
    recheck_confirmations: List[str]
    should_enter: bool
    should_exit: bool
    exit_percentage: float
    exit_reason: str
    timing_violations: List[str]
    bar_index: int
    timestamp: datetime
    direction_check_passed: bool = True
    direction_check_reason: str = ""


@dataclass
class RecheckState:
    """
    State for pending recheck validation
    
    ENHANCED: Institutional-grade flexibility
    - reference_type: PARENT (from parent recheck) or SIGNAL (from original signal)
    - timing_mode: AT (check at bar X) or WITHIN (must re-fire within X bars)
    - signal_fire_bar: Tracks original signal bar through nested chains
    """
    signal_name: str
    block_name: str
    original_condition: Dict[str, Any]  # Condition to re-validate
    fire_bar: int  # Bar when THIS recheck was queued
    bar_delay: int  # Bars to wait before validation
    validation_mode: str  # 'SIGNAL', 'RECHECK', 'CONFIDENCE'
    
    # INSTITUTIONAL ENHANCEMENTS
    reference_type: str = 'PARENT'  # 'PARENT' or 'SIGNAL'
    timing_mode: str = 'AT'  # 'AT' or 'WITHIN'
    signal_fire_bar: Optional[int] = None  # Original signal bar (for SIGNAL reference)
    window_validated: bool = False  # For WITHIN mode tracking
    
    nested_rechecks: List['RecheckState'] = field(default_factory=list)
    parent_recheck: Optional['RecheckState'] = None


@dataclass
class TimingConstraint:
    """Timing constraint for signal"""
    signal_name: str
    reference_signal: str
    max_candles: int
    reference_fire_bar: Optional[int] = None


@dataclass
class ExitCondition:
    """Exit condition configuration"""
    signal_name: str
    percentage: float  # 0.0-1.0
    mode: str  # 'ABSOLUTE', 'FLEXIBLE'
    binding_level: str  # 'STRATEGY', 'BLOCK', 'SIGNAL'
    recheck_config: Optional[Dict] = None


@dataclass
class TradeState:
    """Current trade state (single trade)
    
    INSTITUTIONAL-GRADE SIGNAL TRACKING:
    - entry_signals: Which signals fired for this trade entry
    - Used to enforce signal-level exit binding
    """
    entry_bar: int
    entry_price: Price
    entry_side: str  # 'LONG', 'SHORT'
    entry_signals: List[str] = field(default_factory=list)  # CRITICAL: Track entry signals!
    remaining_position: float = 1.0  # 1.0 = 100%
    tp_hits: List[str] = field(default_factory=list)  # ['TP1', 'TP2']
    best_price: Optional[float] = None # Lowest for SHORT, highest for LONG (for trailing SL)


class InstitutionalSignalEvaluator:
    """
    Production-grade signal evaluation engine
    
    CRITICAL FEATURES:
    1. Multi-level RECHECK validation (up to 3 deep)
    2. Sequential TIMING constraints
    3. 3-tier EXIT hierarchy
    4. TP-aware exit calculations
    5. Single trade management
    
    Example Flow (HOD Rejection v9):
    
    Bar 100: HOD_REJECTION fires
      └─ Record timing reference
    
    Bar 105: BELOW_HOD fires (within 12 bars ✓)
      ├─ Queue RECHECK in 3 bars
      └─ Record timing reference
    
    Bar 108: RECHECK BELOW_HOD (3 bars later)
      ├─ Validate: price still < HOD? 
      ├─ If YES: Confirm signal
      │    └─ Queue nested RECHECK in 2 bars
      └─ If NO: Invalidate signal
    
    Bar 110: RECHECK of RECHECK (2 bars after first recheck)
      ├─ Validate: first recheck still valid?
      └─ Queue next nested RECHECK in 5 bars
    
    Bar 110: BEARISH fires (within 10 bars of BELOW_HOD ✓)
      └─ All required signals confirmed
    
    Bar 110: Calculate confluence
      ├─ HOD_REJECTION: 25 pts
      ├─ BELOW_HOD (triple confirmed): 30 pts
      ├─ BEARISH: 20 pts
      └─ Total: 75 pts >= 40 threshold → ENTER
    
    Bar 150: VWAP_CROSS_UP fires (exit signal)
      ├─ Check 3-tier hierarchy
      ├─ Signal-level exit: 15% TP-aware
      ├─ Calculate: 15% of remaining position
      └─ Exit 15% of position
    """
    
    def __init__(self, strategy_config: Any):
        """
        Initialize institutional signal evaluator
        
        Args:
            strategy_config: StrategyConfig with blocks, signals, exits
        """
        self.strategy_config = strategy_config

        # BTCAAAAA-736 build sentinel — proves post-ad3b0b1 code is running.
        # If this line appears in the log, the hasattr-guard fix and the
        # reference/reference_signal key fix are both active.
        logger.warning(
            "InstitutionalSignalEvaluator INIT — "
            "BTCAAAAA-685 fix ACTIVE "
            "(hasattr guards patched, reference/reference_signal both read). "
            "Signals will be diagnosed; check BTCAAAAA-736 log for fired-but-filtered entries."
        )

        # Building blocks (instantiated from registry)
        self.building_blocks = self._instantiate_building_blocks()

        # State management
        self.pending_rechecks: List[RecheckState] = []
        self.timing_constraints: Dict[str, TimingConstraint] = {}
        self.fired_signals: Dict[str, int] = {}  # signal_name → fire_bar
        self.current_trade: Optional[TradeState] = None

        # BTCAAAAA-736 signal diagnostic counter
        self._diag_signals_fired_total: int = 0
        self._diag_signals_filtered_total: int = 0

        # Direction consistency check: when enabled, signals that fire for entry
        # must be directionally consistent with the strategy_type (Bullish/Bearish).
        self.direction_check_enabled = True
        
        # Exit conditions (organized by level)
        self.exit_conditions = self._organize_exit_conditions()
        
        # Components - NOW ACTIVE!
        from src.optimizer_v3.core.recheck_validator import RecheckValidator
        from src.optimizer_v3.core.timing_chain_manager import TimingChainManager
        from src.optimizer_v3.core.exit_hierarchy_evaluator import ExitHierarchyEvaluator
        from src.optimizer_v3.core.confluence_calculator import ConfluenceCalculator
        from src.optimizer_v3.core.signal_evaluator_logger import get_logger
        
        self.recheck_validator = RecheckValidator()
        self.timing_manager = TimingChainManager()
        self.exit_evaluator = ExitHierarchyEvaluator()
        self.confluence_calc = ConfluenceCalculator()
        
        # Debug logger
        self.logger = get_logger()
        
        # Log strategy configuration
        self._log_strategy_config()
    
    def _instantiate_building_blocks(self) -> Dict[str, Any]:
        """
        Instantiate building blocks from registry
        
        INSTITUTIONAL-GRADE EFFICIENCY:
        - Loads blocks for ENTRY signals (from strategy_config.blocks)
        - Loads blocks for EXIT signals (from exit_conditions)
        - Auto-discovers which blocks can provide required signals
        - Deduplicates to load each block only once
        
        Returns:
            Dict of {block_name: block_instance}
        """
        blocks = {}
        blocks_to_load = set()  # Deduplicated set of block names
        
        # STEP 1: Add blocks from ENTRY configuration (existing logic)
        for block_config in self.strategy_config.blocks:
            blocks_to_load.add(block_config.name)
        
        # STEP 2: Add blocks for EXIT signals (NEW - institutional fix)
        required_exit_signals = self._get_required_exit_signals()
        
        if required_exit_signals:
            # For each exit signal, find which blocks can provide it
            for signal_name in required_exit_signals:
                blocks_for_signal = BlockRegistry.get_blocks_for_signal(signal_name)
                
                if blocks_for_signal:
                    # Add first capable block (BlockRegistry returns most reliable first)
                    blocks_to_load.add(blocks_for_signal[0])
        
        # STEP 3: Build parameters map from block configs
        block_params = {}
        for block_config in self.strategy_config.blocks:
            params = getattr(block_config, 'parameters', None) or {}
            block_params[block_config.name] = params
        
        # STEP 4: Instantiate all required blocks (deduplicated)
        if not callable(getattr(BlockRegistry, 'instantiate', None)):
            logger.error(
                f"BlockRegistry.instantiate is not callable "
                f"(type={type(BlockRegistry.instantiate).__name__})"
            )
        for block_name in blocks_to_load:
            # Extract tunable parameters for this block
            params = block_params.get(block_name, {})
            try:
                # Instantiate block from registry
                block_instance = BlockRegistry.instantiate(
                    block_name,
                    timeframe='15m',  # System designed for 15m
                    **params
                )
                
                if block_instance:
                    blocks[block_name] = block_instance
            except (ValueError, TypeError) as e:
                logger.warning(
                    f"Skipping block '{block_name}': instantiation failed - {e}"
                )
        
        return blocks
    
    def _get_required_exit_signals(self) -> List[str]:
        """
        Extract all exit signal names from strategy configuration
        
        INSTITUTIONAL-GRADE AUTO-DISCOVERY:
        Scans all 3 tiers of exit conditions to find required signals.
        
        Returns:
            List of unique signal names used in exit conditions
            
        Example:
            Strategy exits: BULLISH_CROSS, BULLISH
            Block exits: OVERSOLD
            Signal exits: BULLISH_DIVERGENCE
            
            Returns: ['BULLISH_CROSS', 'BULLISH', 'OVERSOLD', 'BULLISH_DIVERGENCE']
        """
        exit_signals = set()
        
        # Strategy-level exit conditions
        # DictWrapper returns None for missing/null keys; (getattr or []) guards against that.
        for exit_cond in (getattr(self.strategy_config, 'exit_conditions', None) or []):
            exit_signals.add(exit_cond.signal_name)
        
        # Block-level and Signal-level exit conditions
        for block in self.strategy_config.blocks:
            # Block-level exits (DictWrapper returns None for missing keys; None is falsy)
            if block.exit_conditions:
                for exit_cond in block.exit_conditions:
                    exit_signals.add(exit_cond.signal_name)

            # Signal-level exits
            for signal in block.signals:
                if signal.exit_conditions:
                    for exit_cond in signal.exit_conditions:
                        exit_signals.add(exit_cond.signal_name)
        
        return list(exit_signals)
    
    def _organize_exit_conditions(self) -> Dict[str, Any]:
        """
        Organize exit conditions by binding level
        
        Returns:
            Dict of {level: [ExitCondition]}
        """
        exits = {
            'STRATEGY': [],
            'BLOCK': {},  # {block_name: [ExitCondition]}
            'SIGNAL': {}  # {signal_name: [ExitCondition]}
        }
        
        # Strategy-level exits
        # DictWrapper returns None for missing/null keys; (getattr or []) guards against that.
        for exit_cond in (getattr(self.strategy_config, 'exit_conditions', None) or []):
                exits['STRATEGY'].append(ExitCondition(
                    signal_name=exit_cond.signal_name,
                    percentage=exit_cond.percentage,
                    mode=exit_cond.exit_mode,  # FIX: use exit_mode not mode
                    binding_level='STRATEGY',
                    recheck_config=self._extract_recheck_config(exit_cond)
                ))
        
        # Block and Signal-level exits
        for block in self.strategy_config.blocks:
            # Block-level exits (DictWrapper returns None for missing keys; None is falsy)
            if block.exit_conditions:
                exits['BLOCK'][block.name] = [
                    ExitCondition(
                        signal_name=ec.signal_name,
                        percentage=ec.percentage,
                        mode=ec.exit_mode,
                        binding_level='BLOCK',
                        recheck_config=self._extract_recheck_config(ec)
                    )
                    for ec in block.exit_conditions
                ]

            # Signal-level exits
            for signal in block.signals:
                if signal.exit_conditions:
                    signal_id = f"{block.name}::{signal.name}"
                    exits['SIGNAL'][signal_id] = [
                        ExitCondition(
                            signal_name=ec.signal_name,
                            percentage=ec.percentage,
                            mode=ec.exit_mode,
                            binding_level='SIGNAL',
                            recheck_config=self._extract_recheck_config(ec)
                        )
                        for ec in signal.exit_conditions
                    ]
        
        return exits
    
    def _extract_recheck_config(self, exit_cond: Any) -> Optional[Dict]:
        """
        Extract recheck configuration from exit condition (dict or object)
        
        CRITICAL FIX: Config data can be dict (from JSONB) or object (from ORM).
        Must handle both formats without breaking TP/SL systems.
        
        Args:
            exit_cond: Exit condition as dict or object
        
        Returns:
            Recheck config dict or None
        """
        # Try dict access first (JSONB format from database)
        if isinstance(exit_cond, dict):
            return exit_cond.get('recheck_config') or exit_cond.get('recheck')
        
        # Try object access (ORM format)
        return getattr(exit_cond, 'recheck_config', None) or getattr(exit_cond, 'recheck', None)
    
    def evaluate_bar(
        self,
        bar: Bar,
        bar_index: int,
        lookback_bars: List[Bar],
        total_bars: int = 0
    ) -> SignalEvaluationResult:
        """
        Evaluate signals for current bar - CORE EVALUATION LOOP
        
        Process:
        1. Process pending rechecks (validate confirmations)
        2. Evaluate building blocks (fresh signals)
        3. Apply timing constraints (sequential chain)
        4. Queue new rechecks (schedule validations)
        5. Calculate confluence (scaled points)
        6. If in trade: evaluate exits (3-tier hierarchy)
        7. If not in trade: check entry (confluence threshold)
        
        Args:
            bar: Current bar
            bar_index: Index in sequence
            lookback_bars: Historical bars for context
            total_bars: Total bars in backtest (for logging)
        
        Returns:
            SignalEvaluationResult with decision
        """
        # DEBUG LOG: Only log bars where signals fire or decisions happen
        # Don't log every bar - would create enormous files
        log_this_bar = False
        
        # STEP 1: Process pending rechecks
        confirmed_signals = []
        if self.recheck_validator:
            confirmed_signals = self.recheck_validator.validate_pending(
                self.pending_rechecks,
                bar,
                bar_index,
                lookback_bars,
                self.building_blocks
            )
        
        # STEP 2: Evaluate fresh signals from building blocks
        fresh_signals = self._evaluate_building_blocks(bar, lookback_bars, bar_index)
        
        # STEP 3: Apply timing constraints
        valid_signals = fresh_signals
        violations = []
        if self.timing_manager:
            valid_signals, violations = self.timing_manager.validate_timing(
                fresh_signals,
                self.fired_signals,
                bar_index
            )
            
        
        # STEP 4: Queue rechecks for valid signals
        new_rechecks = self._queue_rechecks(valid_signals, bar_index, bar)
        self.pending_rechecks.extend(new_rechecks)
        
        # STEP 5: Calculate confluence
        # CRITICAL FIX: Include recently-fired timing reference signals
        # For timing-constrained strategies, signals fire on different bars
        # but should count together if timing constraint is satisfied
        all_signals = list(valid_signals.keys()) + confirmed_signals
        
        # Add timing reference signals that are still "active"
        timing_ref_signals = self._get_active_timing_references(
            valid_signals,
            bar_index
        )
        
        all_signals.extend(timing_ref_signals)
        
        # Remove duplicates
        all_signals = list(set(all_signals))
        
        confluence = 0
        breakdown = {}
        if self.confluence_calc and all_signals:
            confluence = self.confluence_calc.calculate(
                self.strategy_config,
                all_signals
            )
            breakdown = self.confluence_calc.get_signal_breakdown(
                self.strategy_config,
                all_signals
            )
        
        # DEBUG LOG: Confluence calculation
        min_confluence = getattr(self.strategy_config, 'confluence_threshold', 40)
        if min_confluence is None:
            min_confluence = 40
        
        if total_bars > 0 and all_signals:
            self.logger.log_confluence_calc(all_signals, breakdown, confluence, min_confluence)
        
        # STEP 6: If in trade, check exits
        if self.current_trade:
            exit_decision = None
            if self.exit_evaluator:
                exit_decision = self.exit_evaluator.evaluate(
                    bar,
                    bar_index,
                    lookback_bars,
                    self.exit_conditions,
                    self.current_trade,
                    self.building_blocks
                )
            
            if exit_decision and exit_decision.should_exit:
                if total_bars > 0:
                    self.logger.log_exit_decision(True, exit_decision.reason, exit_decision.percentage)
                
                return SignalEvaluationResult(
                    confluence_score=confluence,
                    signals_fired=list(valid_signals.keys()),
                    recheck_confirmations=confirmed_signals,
                    should_enter=False,  # Already in trade
                    should_exit=True,
                    exit_percentage=exit_decision.percentage,
                    exit_reason=exit_decision.reason,
                    timing_violations=violations,
                    bar_index=bar_index,
                    timestamp=bar.ts_event,
                    direction_check_passed=True,
                    direction_check_reason=''
                )
        
        # STEP 7: Check entry decision
        # BTCAAAAA-7364: Verify all required (AND) signals are present before allowing entry
        # BTCAAAAA-24644: R5 — make AND-gate configurable (default False = confluence-only gating)
        # When require_all_and_signals is False, skip the strict all-AND check
        # to avoid zero-trades vectors from timing/recheck chains filtering required signals.
        require_all = getattr(self.strategy_config, 'require_all_and_signals', False)
        required_ok = True
        if require_all and self.confluence_calc:
            required_ok = self.confluence_calc.check_required_signals(
                self.strategy_config,
                all_signals
            )
        should_enter = required_ok and confluence >= min_confluence

        # Direction consistency check: reject entry if signals conflict with strategy_type
        direction_ok = True
        direction_reason = ''
        if should_enter and self.direction_check_enabled:
            direction_ok, direction_reason = self._check_direction_consistency(all_signals)
            if not direction_ok:
                should_enter = False
                logger.warning("DIRECTION CHECK: %s", direction_reason)
            elif total_bars > 0 and all_signals:
                logger.info("DIRECTION CHECK: passed (signals consistent with %s)",
                            getattr(self.strategy_config, "strategy_type", "Bullish"))

        # BTCAAAAA-736 diagnostic: log totals at last bar so the user can see in UI output
        if total_bars > 0 and bar_index == total_bars - 1:
            logger.warning(
                "BTCAAAAA-736 DIAG SUMMARY at last bar: "
                "accepted_configured_signals=%d, "
                "filtered_nonconfigured_signals=%d. "
                "If accepted=0 and filtered>0, signal name mismatch in strategy config. "
                "If both=0, building blocks returned no non-neutral signals on real data.",
                self._diag_signals_fired_total,
                self._diag_signals_filtered_total,
            )

        # DEBUG LOG: Entry decision (ONLY log if entry allowed OR signals actually fired)
        # Don't pollute logs with "NO ENTRY (Confluence: 0)" spam
        if total_bars > 0 and all_signals:  # Only log when signals actually fired
            reason = ""
            if not required_ok:
                reason = "Required (AND) signals missing"
            elif confluence < min_confluence:
                reason = f"Confluence too low ({confluence} < {min_confluence})"

            self.logger.log_entry_decision(should_enter, confluence, reason)
        
        return SignalEvaluationResult(
            confluence_score=confluence,
            signals_fired=list(valid_signals.keys()),
            recheck_confirmations=confirmed_signals,
            should_enter=should_enter,
            should_exit=False,
            exit_percentage=0.0,
            exit_reason='',
            timing_violations=violations,
            bar_index=bar_index,
            timestamp=bar.ts_event,
            direction_check_passed=direction_ok,
            direction_check_reason=direction_reason
        )
    
    def _evaluate_building_blocks(
        self,
        bar: Bar,
        lookback: List[Bar],
        bar_index: int = 0
    ) -> Dict[str, Dict]:
        """
        Evaluate all building blocks for current bar
        
        CRITICAL FIX: Only process signals configured in strategy!
        Building blocks can return many signals, but strategy only uses subset.
        Unconfigured signals should be filtered out (not evaluated).
        
        Returns:
            Dict of {signal_id: signal_data}
        """
        fired = {}
        
        # CRITICAL FIX: Convert List[Bar] to DataFrame for building blocks
        df = self._bars_to_dataframe(lookback + [bar])
        
        # DEBUG: Log DataFrame size for first few bars
        if bar_index < 5:
            logger.debug(f"[DEBUG] Bar {bar_index}: lookback has {len(lookback)} bars, DataFrame has {len(df)} rows")
        
        # CRITICAL FIX: Skip building blocks during warm-up period (< 50 bars)
        # This is the TRAINING period - indicators need historical context
        # Building blocks require minimum 50 bars for analysis
        if len(lookback) < 50:
            # Return empty dict - no signals during warm-up
            return {}
        
        for block_name, block_instance in self.building_blocks.items():
            # CRITICAL FIX: Check if block instance is valid before calling
            if block_instance is None:
                if bar_index > 0:
                    error_msg = f"Block instance is None for {block_name} - skipping"
                    self.logger.log_error("_evaluate_building_blocks", error_msg)
                continue
            
            # CRITICAL FIX: Check if analyze method exists
            if not hasattr(block_instance, 'analyze') or block_instance.analyze is None:
                if bar_index > 0:
                    error_msg = f"Block {block_name} missing analyze() method - skipping"
                    self.logger.log_error("_evaluate_building_blocks", error_msg)
                continue
                
            try:
                # Call building block's analyze method with DataFrame
                result = block_instance.analyze(df)
                
                # Check if signal fired
                if result and result.get('signal') and result['signal'] != 'NO_SIGNAL':
                    signal_name = result['signal']
                    
                    # CRITICAL FIX: Only process signals that exist in strategy config
                    # Building blocks can fire many signals (e.g., ABOVE_ASIA_50, AT_ASIA_50, BELOW_ASIA_50)
                    # But user only configured subset - filter to configured signals only!
                    if not self._signal_exists_in_config(block_name, signal_name):
                        # BTCAAAAA-736 diagnostic: count filtered signals so we can distinguish
                        # "block fires but signal name mismatch" from "block never fires at all"
                        if signal_name not in ('NEUTRAL', 'INSUFFICIENT_DATA', 'ERROR',
                                               'NO_SIGNAL', 'NO_ASIA_DATA', 'NO_SWEEP',
                                               'NO_DATA'):
                            self._diag_signals_filtered_total += 1
                            logger.debug(
                                "BTCAAAAA-736 DIAG: %s::%s fired but NOT in strategy config "
                                "(total filtered=%d)",
                                block_name, signal_name, self._diag_signals_filtered_total,
                            )
                        continue
                    
                    # Signal IS configured → process it
                    signal_id = f"{block_name}::{signal_name}"
                    
                    # CRITICAL FIX: Inject timing constraint metadata from config
                    # TimingChainManager expects this data in signal_data
                    timing_constraint = self._get_timing_constraint_for_signal(
                        block_name,
                        signal_name
                    )
                    if timing_constraint:
                        result['timing_constraint'] = timing_constraint
                    
                    fired[signal_id] = result

                    # Record signal fire bar
                    self.fired_signals[signal_id] = len(lookback)  # Current index

                    # BTCAAAAA-736 diagnostic: count accepted configured signals
                    self._diag_signals_fired_total += 1
                    logger.info(
                        "BTCAAAAA-736 DIAG: %s::%s ACCEPTED (bar=%d, total_fired=%d)",
                        block_name, signal_name, bar_index, self._diag_signals_fired_total,
                    )

                    # DEBUG LOG: Only log when signal FIRES (not every bar)
                    if bar_index > 0:
                        self.logger.log_building_block_eval(block_name, result)
                    
            except Exception as e:
                # Log error with detailed diagnostics
                import traceback
                error_detail = (
                    f"Error evaluating {block_name}: {e}\n"
                    f"  Block instance type: {type(block_instance)}\n"
                    f"  Has analyze attr: {hasattr(block_instance, 'analyze')}\n"
                    f"  Analyze value: {getattr(block_instance, 'analyze', 'MISSING')}\n"
                    f"  Traceback: {traceback.format_exc()}"
                )
                logger.info(error_detail)
                if bar_index > 0:
                   self.logger.log_error("_evaluate_building_blocks", f"{block_name}: {e}")
                continue
        
        return fired
    
    def _queue_rechecks(
        self,
        signals: Dict[str, Dict],
        bar_index: int,
        bar: Bar
    ) -> List[RecheckState]:
        """
        Queue rechecks for signals that have recheck config
        
        Returns:
            List of RecheckState objects to add to pending
        """
        rechecks = []
        
        for signal_id, signal_data in signals.items():
            # Check if signal has recheck config
            recheck_config = signal_data.get('recheck_config')
            
            if recheck_config and recheck_config.get('enabled'):
                # Create recheck state
                recheck = RecheckState(
                    signal_name=signal_id,
                    block_name=signal_id.split('::')[0],
                    original_condition={
                        'price': float(bar.close),
                        'signal_type': signal_data.get('signal'),
                        'metadata': signal_data.get('metadata', {})
                    },
                    fire_bar=bar_index,
                    bar_delay=recheck_config.get('bar_delay', 0),
                    validation_mode=recheck_config.get('validation_mode', 'SIGNAL'),
                    reference_type=recheck_config.get('reference_type', 'PARENT'),
                    timing_mode=recheck_config.get('timing_mode', 'AT'),
                    signal_fire_bar=bar_index
                )
                
                # Add nested rechecks if configured
                if 'recheck_chain' in recheck_config:
                    self._add_nested_rechecks(
                        recheck,
                        recheck_config['recheck_chain'],
                        bar_index
                    )
                
                rechecks.append(recheck)
        
        return rechecks
    
    def _add_nested_rechecks(
        self,
        parent_recheck: RecheckState,
        chain_config: List[Dict],
        bar_index: int
    ):
        """Add nested rechecks to parent"""
        for nested_config in chain_config:
            nested = RecheckState(
                signal_name=parent_recheck.signal_name,
                block_name=parent_recheck.block_name,
                original_condition=parent_recheck.original_condition,
                fire_bar=bar_index,
                bar_delay=nested_config.get('bar_delay', 0),
                validation_mode=nested_config.get('validation_mode', 'RECHECK'),
                reference_type=nested_config.get('reference_type', 'PARENT'),
                timing_mode=nested_config.get('timing_mode', 'AT'),
                signal_fire_bar=bar_index,
                parent_recheck=parent_recheck
            )
            parent_recheck.nested_rechecks.append(nested)
    
    def enter_trade(
        self,
        bar: Bar,
        bar_index: int,
        side: str,
        signals_fired: List[str] = None
    ):
        """
        Record trade entry with signals that fired
        
        INSTITUTIONAL-GRADE SIGNAL TRACKING:
        Captures which signals fired for this trade entry.
        Used by exit_hierarchy_evaluator to enforce signal-level binding.
        
        Args:
            bar: Entry bar
            bar_index: Bar index
            side: 'LONG' or 'SHORT'
            signals_fired: List of signal IDs that fired for entry
                          (e.g., ['asia_session_50_percent::AT_ASIA_50'])
        """
        self.current_trade = TradeState(
            entry_bar=bar_index,
            entry_price=Price(float(bar.close), 2),
            entry_side=side,
            entry_signals=signals_fired if signals_fired else []
        )

        # P1.3 PRODUCTION PRICE RANGE WARNING (BTCAAAAA-991)
        # Warn (not raise) so a mismatch is visible in logs without halting execution.
        _ep = float(self.current_trade.entry_price)
        _lo = float(bar.low)
        _hi = float(bar.high)
        if not (_lo <= _ep <= _hi):
            logger.warning(
                "PRICE RANGE WARNING: entry_price=%.2f is outside bar H/L "
                "[%.2f, %.2f] at bar_index=%d. Entry bar and price bar mismatch.",
                _ep, _lo, _hi, bar_index,
            )

    def exit_trade(
        self,
        percentage: float
    ):
        """Execute partial or full exit"""
        if self.current_trade:
            self.current_trade.remaining_position -= percentage
            
            if self.current_trade.remaining_position <= 0.01:  # Effectively zero
                self.current_trade = None  # Trade fully closed
    
    def _bars_to_dataframe(self, bars: List[Bar]) -> pd.DataFrame:
        """
        Convert List[Bar] to DataFrame for building block analysis
        
        CRITICAL: Building blocks expect DataFrame with these columns:
        - timestamp (as regular column, NOT index!)
        - open, high, low, close, volume
        
        Args:
            bars: List of NautilusTrader Bar objects
        
        Returns:
            DataFrame with columns: timestamp, open, high, low, close, volume
        """
        if not bars:
            return pd.DataFrame()
        
        data = {
            'timestamp': [pd.Timestamp(bar.ts_event, unit='ns') for bar in bars],
            'open': [float(bar.open) for bar in bars],
            'high': [float(bar.high) for bar in bars],
            'low': [float(bar.low) for bar in bars],
            'close': [float(bar.close) for bar in bars],
            'volume': [float(bar.volume) for bar in bars]
        }
        
        df = pd.DataFrame(data)
        # DO NOT set timestamp as index - building blocks need it as a column!
        # df = df.set_index('timestamp')  # ← REMOVED - was breaking building blocks
        
        return df
    
    def _log_strategy_config(self):
        """Log loaded strategy configuration"""
        try:
            strategy_name = getattr(self.strategy_config, 'name', 'Unknown')
            blocks = getattr(self.strategy_config, 'blocks', [])
            
            # Extract all signals
            all_signals = []
            blocks_list = []
            for block in blocks:
                block_dict = {
                    'name': getattr(block, 'name', 'Unknown'),
                    'signals': []
                }
                
                block_signals = getattr(block, 'signals', [])
                for signal in block_signals:
                    signal_dict = {
                        'name': getattr(signal, 'name', 'Unknown'),
                        'logic': getattr(signal, 'logic', 'OR'),
                        'weight': getattr(signal, 'weight', 10)
                    }
                    block_dict['signals'].append(signal_dict)
                    all_signals.append(signal_dict)
                
                blocks_list.append(block_dict)
            
            self.logger.log_strategy_loaded(strategy_name, blocks_list, all_signals)
        except Exception as e:
            self.logger.log_error("_log_strategy_config", str(e))
    
    def _signal_exists_in_config(
        self,
        block_name: str,
        signal_name: str
    ) -> bool:
        """
        Check if signal exists in strategy configuration (ENTRY or EXIT)
        
        INSTITUTIONAL-GRADE EFFICIENCY:
        - Check ENTRY signals (for confluence calculation)
        - Check EXIT conditions (for exit hierarchy)
        - If block referenced in EITHER, instantiate it ONCE
        - All signals from that block become available
        
        Args:
            block_name: Building block name
            signal_name: Signal name (e.g., 'AT_ASIA_50', 'ABOVE_ASIA_50')
        
        Returns:
            True if signal is configured in ENTRY or EXIT, False otherwise
        
        Example:
            Strategy ENTRY: AT_ASIA_50, BELOW_ASIA_50
            Strategy EXIT: ABOVE_ASIA_50
            
            Block instantiated: asia_session_50_percent (used in entry/exit)
            Available signals: AT_ASIA_50, BELOW_ASIA_50, ABOVE_ASIA_50 ✅
            
            _signal_exists_in_config('asia_session_50_percent', 'ABOVE_ASIA_50')
            → Returns: True (found in EXIT conditions!)
        """
        # STEP 1: Check ENTRY signals (existing logic)
        for block in self.strategy_config.blocks:
            if block.name == block_name:
                # Check entry signals
                for signal_config in block.signals:
                    if signal_config.name == signal_name:
                        return True  # Signal configured for ENTRY
        
        # STEP 2: Check EXIT conditions (NEW - efficiency optimization)
        # DictWrapper returns None for missing/null keys and hasattr() never raises AttributeError
        # on DictWrapper, so we must use (getattr(...) or []) to safely iterate.
        # Strategy-level exits
        for exit_cond in (getattr(self.strategy_config, 'exit_conditions', None) or []):
            if exit_cond.signal_name == signal_name:
                return True  # Signal configured for EXIT (strategy-level)

        # Block-level exits
        for block in self.strategy_config.blocks:
            if block.name == block_name:
                for exit_cond in (getattr(block, 'exit_conditions', None) or []):
                    if exit_cond.signal_name == signal_name:
                        return True  # Signal configured for EXIT (block-level)

                # Signal-level exits
                for signal_config in block.signals:
                    for exit_cond in (getattr(signal_config, 'exit_conditions', None) or []):
                        if exit_cond.signal_name == signal_name:
                            return True  # Signal configured for EXIT (signal-level)
        
        return False  # Signal NOT configured anywhere
    
    def _get_active_timing_references(
        self,
        current_signals: Dict[str, Dict],
        bar_index: int
    ) -> List[str]:
        """
        Get timing reference signals that should still count in confluence
        
        CRITICAL FIX: For timing-constrained strategies with mutually exclusive signals.
        When BELOW_ASIA_50 fires, check if AT_ASIA_50 fired within window.
        If yes, include AT_ASIA_50 in confluence (even though it fired earlier).
        
        Args:
            current_signals: Signals firing on THIS bar
            bar_index: Current bar index
        
        Returns:
            List of reference signal IDs to include in confluence
        
        Example:
            Bar 100: AT_ASIA_50 fires → recorded in self.fired_signals
            Bar 103: BELOW_ASIA_50 fires (has timing: within 5 of AT_ASIA_50)
              → Check: AT_ASIA_50 fired at bar 100 (3 bars ago < 5) ✓
              → Return: ['asia_session_50_percent::AT_ASIA_50']
              → Confluence counts BOTH signals → 20 pts → ENTRY!
        """
        active_refs = []
        
        for signal_id, signal_data in current_signals.items():
            # Check if THIS signal has a timing constraint
            timing_constraint = signal_data.get('timing_constraint')
            
            if timing_constraint:
                ref_signal = timing_constraint.get('reference_signal')
                max_candles = timing_constraint.get('max_candles', 0)
                
                if ref_signal and max_candles > 0:
                    # Check if reference signal fired recently
                    if ref_signal in self.fired_signals:
                        ref_fire_bar = self.fired_signals[ref_signal]
                        bars_ago = bar_index - ref_fire_bar
                        
                        # If reference fired within window, include it!
                        if 0 <= bars_ago <= max_candles:
                            active_refs.append(ref_signal)
        
        return active_refs
    
    def _get_timing_constraint_for_signal(
        self,
        block_name: str,
        signal_name: str
    ) -> Optional[Dict[str, Any]]:
        """
        Get timing constraint metadata for signal from strategy config
        
        CRITICAL FIX: TimingChainManager expects timing_constraint IN signal_data
        This method extracts it from strategy config and formats for injection.
        
        Args:
            block_name: Building block name
            signal_name: Signal name (e.g., 'BELOW_ASIA_50')
        
        Returns:
            Dict with timing constraint data or None
            {
                'reference_signal': 'block::SIGNAL_NAME',
                'max_candles': 5
            }
        
        Example:
            Strategy config has:
              signals:
                - name: BELOW_ASIA_50
                  timing_constraint:
                    reference_signal: AT_ASIA_50
                    max_candles: 5
            
            Returns:
              {
                  'reference_signal': 'asia_session_50_percent::AT_ASIA_50',
                  'max_candles': 5
              }
        """
        # Find block in config
        for block in self.strategy_config.blocks:
            if block.name == block_name:
                # Find signal in block
                for signal_config in block.signals:
                    if signal_config.name == signal_name:
                        # Check if signal has timing constraint
                        if hasattr(signal_config, 'timing_constraint') and signal_config.timing_constraint:
                            constraint = signal_config.timing_constraint
                            
                            # CRITICAL FIX: constraint can be dict OR object
                            # Also handle both 'reference' (config key) and 'reference_signal' (legacy)
                            if isinstance(constraint, dict):
                                ref_signal = (constraint.get('reference_signal')
                                              or constraint.get('reference'))
                                max_candles = constraint.get('max_candles', 0)
                            else:
                                # It's an object - use getattr
                                ref_signal = (getattr(constraint, 'reference_signal', None)
                                              or getattr(constraint, 'reference', None))
                                max_candles = getattr(constraint, 'max_candles', 0)
                            
                            if ref_signal:
                                # CRITICAL FIX: Don't double-prefix if already has block name
                                # Config stores just signal name: "AT_ASIA_50"
                                # NOT "asia_session_50_percent::AT_ASIA_50"
                                # So ONLY add block prefix if not already present
                                if '::' in ref_signal:
                                    # Already has block prefix (shouldn't happen, but handle it)
                                    full_ref_signal = ref_signal
                                else:
                                    # Just signal name - add block prefix
                                    full_ref_signal = f"{block_name}::{ref_signal}"
                                
                                return {
                                    'reference_signal': full_ref_signal,
                                    'max_candles': max_candles
                                }
        
        return None
    
    def reset(self):
        """Reset evaluator state for new backtest"""
        self.pending_rechecks.clear()
        self.timing_constraints.clear()
        self.fired_signals.clear()
        self.current_trade = None

    @staticmethod
    def _get_signal_direction(signal_id: str) -> str:
        """
        Determine directional bias of a signal from its signal ID.

        Args:
            signal_id: Signal ID in format 'block_name::SIGNAL_NAME'

        Returns:
            'BULLISH', 'BEARISH', or 'NEUTRAL'
        """
        if '::' not in signal_id:
            return 'NEUTRAL'

        block_name, signal_name = signal_id.split('::', 1)
        signal_upper = signal_name.upper()

        # Check signal name for explicit directional markers
        if 'BULLISH' in signal_upper or '_BOUNCE' in signal_upper or 'ABOVE_' in signal_upper:
            return 'BULLISH'
        if 'BEARISH' in signal_upper or '_BREAK' in signal_upper or 'BELOW_' in signal_upper or 'REJECTION' in signal_upper:
            return 'BEARISH'

        # Fall back to block-level direction from registry
        try:
            from src.detectors.building_blocks.registry import BlockRegistry
            meta = BlockRegistry.get_block(block_name)
            if meta and meta.direction in ('BULLISH', 'BEARISH'):
                return meta.direction
        except Exception:
            pass

        return 'NEUTRAL'

    def _check_direction_consistency(self, signal_ids: list) -> tuple:
        """
        Check accumulated signals are directionally consistent with strategy_type.

        Args:
            signal_ids: List of signal IDs in 'block_name::SIGNAL_NAME' format

        Returns:
            Tuple of (is_consistent: bool, reason: str or None)
        """
        strategy_type = getattr(self.strategy_config, 'strategy_type', 'Bullish')
        expected_direction = 'BULLISH' if strategy_type == 'Bullish' else 'BEARISH'

        if not signal_ids:
            return True, None

        bullish_count = 0
        bearish_count = 0
        neutral_count = 0

        for sid in signal_ids:
            direction = self._get_signal_direction(sid)
            if direction == 'BULLISH':
                bullish_count += 1
            elif direction == 'BEARISH':
                bearish_count += 1
            else:
                neutral_count += 1

        total_directional = bullish_count + bearish_count

        # If no directional signals at all, allow entry (no information to judge)
        if total_directional == 0:
            return True, None

        # If expected BULLISH but dominant signals are BEARISH → reject
        if expected_direction == 'BULLISH' and bearish_count > bullish_count:
            return False, (
                f"Direction mismatch: strategy_type={strategy_type} but "
                f"signals are {bearish_count}B / {bullish_count}L / {neutral_count}N"
            )

        # If expected BEARISH but dominant signals are BULLISH → reject
        if expected_direction == 'BEARISH' and bullish_count > bearish_count:
            return False, (
                f"Direction mismatch: strategy_type={strategy_type} but "
                f"signals are {bullish_count}L / {bearish_count}B / {neutral_count}N"
            )

        return True, None
