"""
TP/SL Calculator - Calculate Take Profit and Stop Loss Levels

Supports 3 modes:
1. Fibonacci: TP levels at Fib extensions (1.618, 2.618, 4.236)
2. Hybrid: Combination of Fib + market structure
3. Fixed: Fixed percentage targets

CRITICAL: RISK MANAGEMENT - ALL TRADES MUST HAVE SL!

Author: BTC_Engine_v3
Date: February 2026
"""

from typing import Dict, List, Optional
from dataclasses import dataclass

from nautilus_trader.model.data import Bar

import logging
logger = logging.getLogger(__name__)

@dataclass
class TPSLLevels:
    """TP/SL level calculation result"""
    stop_loss: float
    take_profit_1: float
    take_profit_2: float
    take_profit_3: float
    calculation_mode: str
    swing_high: Optional[float] = None
    swing_low: Optional[float] = None
    risk_reward_ratio: float = 0.0


class TPSLCalculator:
    """
    Calculate TP/SL levels for entries
    
    Modes:
    - Fibonacci: TP at 1.618, 2.618, 4.236 extensions
    - Hybrid: Fib + market structure
    - Fixed: Fixed % targets (configurable)
    """
    
    def __init__(self):
        """Initialize calculator"""
        pass
    
    def calculate_levels(
        self,
        entry_price: float,
        mode: str,
        lookback_bars: List[Bar],
        config: Dict,
        entry_side: str = 'LONG'
    ) -> TPSLLevels:
        """
        Calculate TP/SL levels
        
        Args:
            entry_price: Entry price
            mode: 'Fibonacci', 'Hybrid', or 'Fixed'
            lookback_bars: Historical bars for context
            config: User configuration with TP/SL parameters
            entry_side: 'LONG' or 'SHORT'
        
        Returns:
            TPSLLevels with SL and TP1/TP2/TP3
        
        Example:
            calc = TPSLCalculator()
            
            levels = calc.calculate_levels(
                entry_price=50000.0,
                mode='Fibonacci',
                lookback_bars=bars[-50:],
                config=config,
                entry_side='LONG'
            )
            
            # Returns:
            # TPSLLevels(
            #     stop_loss=49500.0,
            #     take_profit_1=50800.0,  # 1.618 Fib
            #     take_profit_2=51300.0,  # 2.618 Fib
            #     take_profit_3=52100.0,  # 4.236 Fib
            #     calculation_mode='Fibonacci',
            #     risk_reward_ratio=1.6
            # )
        """
        if mode == 'Fibonacci':
            return self._calculate_fibonacci_levels(
                entry_price,
                lookback_bars,
                entry_side,
                config  # WIRING FIX: Pass config to Fibonacci too!
            )
        elif mode == 'Hybrid':
            return self._calculate_hybrid_levels(
                entry_price,
                lookback_bars,
                config,
                entry_side
            )
        elif mode == 'Fixed':
            return self._calculate_fixed_levels(
                entry_price,
                config,
                entry_side
            )
        else:
            raise ValueError(f"Unknown TP/SL mode: {mode}")
    
    def _calculate_fibonacci_levels(
        self,
        entry_price: float,
        lookback_bars: List[Bar],
        entry_side: str,
        config: Optional[Dict] = None
    ) -> TPSLLevels:
        """
        Calculate Fibonacci-based TP/SL levels
        
        Logic:
        - Find recent swing high/low
        - SL below swing low (LONG) or above swing high (SHORT)
        - TP at Fibonacci extensions (1.618, 2.618, 4.236) of swing range
        
        WIRING FIX 2026-02-12: Now validates min_risk_reward from config
        """
        if not lookback_bars or len(lookback_bars) < 10:
            # Fallback to fixed % if not enough data
            return self._calculate_fixed_levels(
                entry_price,
                {'fixed_tp_percent': 2.0, 'fixed_sl_percent': 1.0},
                entry_side
            )
        
        # Find swing levels
        swing_high = max(float(bar.high) for bar in lookback_bars[-20:])
        swing_low = min(float(bar.low) for bar in lookback_bars[-20:])
        swing_range = swing_high - swing_low
        
        # ADAPTIVE SL v2.0 FIX: Check if Adaptive SL is enabled
        # If enabled, use emergency_sl_pct for initial SL (wide protection during delay)
        # If disabled, use swing-based SL (traditional Fibonacci logic)
        adaptive_sl_config = config.get('adaptive_sl', {}) if config else {}
        use_adaptive = adaptive_sl_config.get('enabled', False)
        
        # DEBUG: Log what we received
        import os
        log_dir = '/home/sirrus/projects/BTC_Engine_v3/logs/wiring-test'
        os.makedirs(log_dir, exist_ok=True)
        logger = logging.getLogger('tpsl_debug')
        if not logger.handlers:
            logger.setLevel(logging.DEBUG)
            fh = logging.FileHandler(os.path.join(log_dir, 'tpsl_calculator.log'), mode='a')
            fh.setFormatter(logging.Formatter('[%(asctime)s] %(message)s'))
            logger.addHandler(fh)
        
        logger.debug(f"FIBONACCI CALLED | config={bool(config)} | adaptive_config={bool(adaptive_sl_config)} | enabled={use_adaptive} | emergency_pct={adaptive_sl_config.get('emergency_sl_pct', 'MISSING')}")
        
        if entry_side == 'LONG':
            if use_adaptive:
                # ADAPTIVE MODE: Use emergency SL% for initial protection
                emergency_pct = adaptive_sl_config.get('emergency_sl_pct', 2.0) / 100.0
                stop_loss = entry_price * (1 - emergency_pct)
            else:
                # FIBONACCI MODE: SL below swing low
                stop_loss = swing_low * 0.999  # 0.1% buffer

            # TP at Fibonacci extensions (same for both modes)
            take_profit_1 = entry_price + (swing_range * 1.618)
            take_profit_2 = entry_price + (swing_range * 2.618)
            take_profit_3 = entry_price + (swing_range * 4.236)

        else:  # SHORT
            if use_adaptive:
                # ADAPTIVE MODE: Use emergency SL% for initial protection
                emergency_pct = adaptive_sl_config.get('emergency_sl_pct', 2.0) / 100.0
                stop_loss = entry_price * (1 + emergency_pct)
            else:
                # FIBONACCI MODE: SL above swing high
                stop_loss = swing_high * 1.001  # 0.1% buffer

            # TP at Fibonacci extensions (same for both modes)
            take_profit_1 = entry_price - (swing_range * 1.618)
            take_profit_2 = entry_price - (swing_range * 2.618)
            take_profit_3 = entry_price - (swing_range * 4.236)
        
        # Calculate risk/reward
        risk = abs(entry_price - stop_loss)
        reward = abs(take_profit_1 - entry_price)
        risk_reward_ratio = reward / risk if risk > 0 else 0
        
        # WIRING FIX: Validate min R:R ratio from config (if provided)
        if config:
            min_rr = config.get('min_risk_reward', 1.5)
            if risk_reward_ratio < min_rr and risk > 0:
                # Adjust TP1 to meet minimum R:R requirement
                if entry_side == 'LONG':
                    take_profit_1 = entry_price + (risk * min_rr)
                else:
                    take_profit_1 = entry_price - (risk * min_rr)
                
                # Recalculate R:R
                reward = abs(take_profit_1 - entry_price)
                risk_reward_ratio = reward / risk
        
        return TPSLLevels(
            stop_loss=stop_loss,
            take_profit_1=take_profit_1,
            take_profit_2=take_profit_2,
            take_profit_3=take_profit_3,
            calculation_mode='Fibonacci',
            swing_high=swing_high,
            swing_low=swing_low,
            risk_reward_ratio=risk_reward_ratio
        )
    
    def _calculate_hybrid_levels(
        self,
        entry_price: float,
        lookback_bars: List[Bar],
        config: Dict,
        entry_side: str
    ) -> TPSLLevels:
        """
        Calculate Hybrid TP/SL levels
        
        Combines:
        - Fibonacci extensions for TP
        - Market structure (recent high/low) for SL
        - ATR for buffer adjustments (ALWAYS active in Hybrid mode)
        
        WIRING FIX 2026-02-12: Now actually USES config parameters!
        - adaptive_sl.volatility_multiplier: How many ATR multiples for SL buffer
        - min_risk_reward: Minimum acceptable R:R ratio
        """
        # Start with Fibonacci calculation
        fib_levels = self._calculate_fibonacci_levels(
            entry_price,
            lookback_bars,
            entry_side
        )
        
        # CRITICAL FIX: Hybrid mode MUST differ from Fibonacci
        # Always apply ATR buffer adjustment in Hybrid mode (that's the point of Hybrid!)
        if len(lookback_bars) >= 14:
            atr = self._calculate_atr(lookback_bars[-14:])
            
            # WIRING FIX: Read volatility_multiplier from adaptive_sl config!
            adaptive_sl_config = config.get('adaptive_sl', {})
            atr_multiplier = adaptive_sl_config.get('volatility_multiplier', 1.2)  # From UI!
            
            # Add ATR buffer to SL (makes it wider/safer than pure Fibonacci)
            if entry_side == 'LONG':
                fib_levels.stop_loss -= (atr * atr_multiplier)
            else:
                fib_levels.stop_loss += (atr * atr_multiplier)
            
            # Also adjust TP levels slightly using ATR (makes them more realistic)
            tp_adjustment = atr * 0.5  # Half ATR adjustment for TP
            if entry_side == 'LONG':
                fib_levels.take_profit_1 += tp_adjustment
                fib_levels.take_profit_2 += tp_adjustment * 1.5
                fib_levels.take_profit_3 += tp_adjustment * 2.0
            else:
                fib_levels.take_profit_1 -= tp_adjustment
                fib_levels.take_profit_2 -= tp_adjustment * 1.5
                fib_levels.take_profit_3 -= tp_adjustment * 2.0
        
        # Recalculate risk/reward after adjustments
        risk = abs(entry_price - fib_levels.stop_loss)
        reward = abs(fib_levels.take_profit_1 - entry_price)
        fib_levels.risk_reward_ratio = reward / risk if risk > 0 else 0
        
        # WIRING FIX: Validate min R:R ratio from config!
        min_rr = config.get('min_risk_reward', 1.5)
        if fib_levels.risk_reward_ratio < min_rr and risk > 0:
            # Adjust TP1 to meet minimum R:R requirement
            if entry_side == 'LONG':
                fib_levels.take_profit_1 = entry_price + (risk * min_rr)
            else:
                fib_levels.take_profit_1 = entry_price - (risk * min_rr)
            
            # Recalculate R:R
            reward = abs(fib_levels.take_profit_1 - entry_price)
            fib_levels.risk_reward_ratio = reward / risk
        
        fib_levels.calculation_mode = 'Hybrid'
        return fib_levels
    
    def _calculate_fixed_levels(
        self,
        entry_price: float,
        config: Dict,
        entry_side: str
    ) -> TPSLLevels:
        """
        Calculate Fixed percentage TP/SL levels
        
        Uses configured percentages:
        - fixed_sl_percent: SL distance (default 1%)
        - fixed_tp_percent: TP distance (default 2%)
        """
        sl_percent = config.get('fixed_sl_percent', 1.0) / 100.0
        tp_percent = config.get('fixed_tp_percent', 2.0) / 100.0
        
        if entry_side == 'LONG':
            stop_loss = entry_price * (1 - sl_percent)
            take_profit_1 = entry_price * (1 + tp_percent)
            take_profit_2 = entry_price * (1 + tp_percent * 2)
            take_profit_3 = entry_price * (1 + tp_percent * 3)
        else:  # SHORT
            stop_loss = entry_price * (1 + sl_percent)
            take_profit_1 = entry_price * (1 - tp_percent)
            take_profit_2 = entry_price * (1 - tp_percent * 2)
            take_profit_3 = entry_price * (1 - tp_percent * 3)
        
        risk = abs(entry_price - stop_loss)
        reward = abs(take_profit_1 - entry_price)
        risk_reward_ratio = reward / risk if risk > 0 else 0
        
        return TPSLLevels(
            stop_loss=stop_loss,
            take_profit_1=take_profit_1,
            take_profit_2=take_profit_2,
            take_profit_3=take_profit_3,
            calculation_mode='Fixed',
            risk_reward_ratio=risk_reward_ratio
        )
    
    def _calculate_atr(self, bars: List[Bar], period: int = 14) -> float:
        """Calculate Average True Range"""
        if len(bars) < period:
            # Fallback to simple range
            return sum(float(bar.high) - float(bar.low) for bar in bars) / len(bars)
        
        true_ranges = []
        for i in range(1, len(bars)):
            high_low = float(bars[i].high) - float(bars[i].low)
            high_close = abs(float(bars[i].high) - float(bars[i-1].close))
            low_close = abs(float(bars[i].low) - float(bars[i-1].close))
            true_range = max(high_low, high_close, low_close)
            true_ranges.append(true_range)
        
        return sum(true_ranges[-period:]) / period


# Singleton instance
_tpsl_calculator = None

def get_tpsl_calculator() -> TPSLCalculator:
    """Get singleton TP/SL calculator"""
    global _tpsl_calculator
    if _tpsl_calculator is None:
        _tpsl_calculator = TPSLCalculator()
    return _tpsl_calculator
