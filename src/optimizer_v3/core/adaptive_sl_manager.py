"""
Adaptive SL Manager - Adaptive Stop Loss v2.0

Updates SL each candle based on:
- Delay period (emergency SL during initial bars)
- ATR volatility
- Market structure
- Min/max constraints

CRITICAL: RISK MANAGEMENT - PROTECTS CAPITAL!

Author: BTC_Engine_v3
Date: February 2026
"""

import logging
from typing import Dict, List, Optional
from dataclasses import dataclass
from pathlib import Path

from nautilus_trader.model.data import Bar

import logging
logger = logging.getLogger(__name__)


# Wiring test logger - DETAILED parameter tracking
Path("logs/wiring-test").mkdir(parents=True, exist_ok=True)
wiring_logger = logging.getLogger('wiring_test')
wiring_logger.setLevel(logging.DEBUG)
if not wiring_logger.handlers:
    fh = logging.FileHandler('logs/wiring-test/wiring_test.log')
    fh.setLevel(logging.DEBUG)
    formatter = logging.Formatter('[%(asctime)s] %(levelname)s - %(message)s')
    fh.setFormatter(formatter)
    wiring_logger.addHandler(fh)


@dataclass
class AdaptiveSLResult:
    """Result of Adaptive SL calculation"""
    new_sl: float
    sl_mode: str  # 'EMERGENCY' or 'ADAPTIVE'
    atr_value: float
    sl_distance: float
    reason: str


class AdaptiveSLManager:
    """
    Manages Adaptive SL v2.0
    
    Features:
    - Emergency SL during delay period
    - ATR-based SL calculation post-delay
    - Min/max constraints
    - Trailing logic
    """
    
    def __init__(self):
        """Initialize Adaptive SL manager"""
        pass
    
    def update_sl(
        self,
        position_entry_price: float,
        current_bar: Bar,
        bars_since_entry: int,
        lookback_bars: List[Bar],
        config: Dict,
        entry_side: str = 'LONG',
        best_price: Optional[float] = None,
        old_sl: Optional[float] = None
    ) -> AdaptiveSLResult:
        """
        Calculate new SL level with TRUE TRAILING logic

        Args:
            position_entry_price: Entry price of position
            current_bar: Current candle
            bars_since_entry: Bars since entry
            lookback_bars: Historical bars for ATR
            config: Adaptive SL configuration
            entry_side: 'LONG' or 'SHORT'
        
        Returns:
            AdaptiveSLResult with new SL level
        
        Example:
            manager = AdaptiveSLManager()
            
            result = manager.update_sl(
                position_entry_price=50000.0,
                current_bar=bar,
                bars_since_entry=5,
                lookback_bars=bars[-20:],
                config={
                    'delay_bars': 10,
                    'emergency_sl_percent': 1.0,
                    'vol_lookback': 20,
                    'vol_multi': 15,  # 1.5x ATR
                    'min_sl': 5,      # 0.5%
                    'max_sl': 20      # 2.0%
                },
                entry_side='LONG'
            )
            
            logger.info(f"New SL: {result.new_sl}")
            logger.info(f"Mode: {result.sl_mode}")  # EMERGENCY or ADAPTIVE)
        """
        # CRITICAL FIX: Use correct config key names from UI
        # UI sends: delay_bars (correct), but also check 'delay_period' for backwards compat
        delay_bars = config.get('delay_bars', config.get('delay_period', 10))
        
        if bars_since_entry < delay_bars:
            # Use emergency SL during delay
            result = self._calculate_emergency_sl(
                position_entry_price,
                config,
                bars_since_entry,
                entry_side
            )
        else:
            # Use adaptive SL post-delay
            result = self._calculate_adaptive_sl(
                position_entry_price,
                current_bar,
                lookback_bars,
                config,
                entry_side,
                best_price,
                old_sl
            )
        
        # WIRING TEST: Log detailed SL calculation
        vol_lb = config.get('volatility_lookback', config.get('vol_lookback', 20))
        vol_multi = config.get('volatility_multiplier', config.get('vol_multi', 1.2))
        min_sl = config.get('min_sl_pct', config.get('min_sl', 0.7))
        max_sl = config.get('max_sl_pct', config.get('max_sl', 2.0))
        
        # Count this as a trade for logging (static counter would be better but this works)
        wiring_logger.debug(f"TRADE #X | Bar {bars_since_entry} | Config: vol_lb={vol_lb}, vol_multi={vol_multi}, min={min_sl}, max={max_sl}")
        wiring_logger.debug(f"  OLD SL: ${position_entry_price:.2f} → NEW SL: ${result.new_sl:.2f} | Mode: {result.sl_mode} | ATR: ${result.atr_value:.2f} | Distance: ${result.sl_distance:.2f}")
        
        return result
    
    def _calculate_emergency_sl(
        self,
        entry_price: float,
        config: Dict,
        bars_since_entry: int,
        entry_side: str
    ) -> AdaptiveSLResult:
        """
        Calculate emergency SL during delay period
        
        Emergency SL:
        - Fixed % from entry
        - Tighter than normal (protects initial risk)
        - Eases out as delay progresses
        """
        # CRITICAL FIX: Use correct config key names from UI
        # UI sends: emergency_sl_pct (not emergency_sl_percent)
        emergency_sl_pct = config.get('emergency_sl_pct', config.get('emergency_sl_percent', 1.0))
        # CRITICAL FIX 2026-02-14: UI sends integer percent (1, 2, 3), must convert to decimal
        # OLD BUG: Both branches divided by 100, so 1% became 0.01%!
        emergency_sl_percent = emergency_sl_pct / 100.0  # Always convert: 1 → 0.01, 2 → 0.02
        
        if entry_side == 'LONG':
            emergency_sl = entry_price * (1 - emergency_sl_percent)
        else:
            emergency_sl = entry_price * (1 + emergency_sl_percent)
        
        sl_distance = abs(entry_price - emergency_sl)
        
        return AdaptiveSLResult(
            new_sl=emergency_sl,
            sl_mode='EMERGENCY',
            atr_value=0.0,
            sl_distance=sl_distance,
            reason=f"Emergency SL (bar {bars_since_entry} of delay)"
        )
    
    def _calculate_adaptive_sl(
        self,
        entry_price: float,
        current_bar: Bar,
        lookback_bars: List[Bar],
        config: Dict,
        entry_side: str,
        best_price: Optional[float] = None,
        old_sl: Optional[float] = None
    ) -> AdaptiveSLResult:
        """
        Calculate adaptive SL based on ATR
        
        Adaptive SL Logic:
        - Calculate ATR over vol_lookback period
        - SL distance = ATR × vol_multi
        - Apply min/max constraints
        - Trail with price
        
        INSTITUTIONAL FIX: Read config values with CORRECT key names
        (UI sends 'volatility_lookback' not 'vol_lookback')
        """
        # CRITICAL FIX: Use correct config key names from UI
        # UI sends: volatility_lookback, volatility_multiplier, min_sl_pct, max_sl_pct
        vol_lookback = config.get('volatility_lookback', config.get('vol_lookback', 20))
        vol_multi = config.get('volatility_multiplier', config.get('vol_multi', 15) / 10.0)
        
        # INSTITUTIONAL FIX: Proper unit conversion (avoid double division!)
        # NEW format: min_sl_pct = 0.7 (meaning 0.7%) →  divide by 100 → 0.007
        # OLD format: min_sl = 5 (legacy) → divide by 1000 → 0.005
        if 'min_sl_pct' in config:
            # NEW format - UI sends percentage (0.7 = 0.7%)
            min_sl_percent = config['min_sl_pct'] / 100.0
            max_sl_percent = config['max_sl_pct'] / 100.0
        else:
            # OLD format - legacy values
            min_sl_percent = config.get('min_sl', 5) / 1000.0
            max_sl_percent = config.get('max_sl', 20) / 1000.0
        
        # Calculate ATR
        # CRITICAL FIX: Pass vol_lookback as period (was hardcoded to 14!)
        atr = self._calculate_atr(lookback_bars[-vol_lookback:], period=vol_lookback)
        
        # Calculate SL distance
        sl_distance = atr * vol_multi
        
        # Apply min/max constraints
        min_distance = entry_price * min_sl_percent
        max_distance = entry_price * max_sl_percent
        
        sl_distance = max(sl_distance, min_distance)
        sl_distance = min(sl_distance, max_distance)
        
        # CRITICAL FIX 2026-02-14: TRUE TRAILING LOGIC
        # Calculate SL from BEST price (not current price!)
        # This creates a TRUE trailing stop that locks in profits
        
        # Use best_price if provided (multicore path), otherwise current (single-core fallback)
        reference_price = best_price if best_price is not None else float(current_bar.close)
        
        if entry_side == 'LONG':
            # Trail below BEST price achieved (not current!)
            new_sl = reference_price - sl_distance
            
            # PREVENT WIDENING: SL can only move UP (tighter)
            if old_sl is not None:
                new_sl = max(new_sl, old_sl)  # Never move SL down (looser)
            
            # Only cap if trade is in LOSS
            if reference_price < entry_price:
                # Trade is losing - keep SL below entry
                new_sl = min(new_sl, entry_price * 0.998)
            # Otherwise: Let SL trail freely to protect profit
            
        else:  # SHORT
            # Trail above BEST price achieved (lowest for SHORT = most profit)
            new_sl = reference_price + sl_distance
            
            # PREVENT WIDENING: SL can only move DOWN (tighter)
            if old_sl is not None:
                new_sl = min(new_sl, old_sl)  # Never move SL up (looser)
            
            # Only cap if trade is in LOSS
            if reference_price > entry_price:
                # Trade is losing - keep SL above entry
                new_sl = max(new_sl, entry_price * 1.002)
            # Otherwise: Let SL trail freely to protect profit
        
        return AdaptiveSLResult(
            new_sl=new_sl,
            sl_mode='ADAPTIVE',
            atr_value=atr,
            sl_distance=sl_distance,
            reason=f"Adaptive (ATR={atr:.2f}, multi={vol_multi:.1f}x)"
        )
    
    def _calculate_atr(self, bars: List[Bar], period: int = 14) -> float:
        """Calculate Average True Range"""
        if len(bars) < 2:
            return 0.0
        
        true_ranges = []
        for i in range(1, len(bars)):
            high_low = float(bars[i].high) - float(bars[i].low)
            high_close = abs(float(bars[i].high) - float(bars[i-1].close))
            low_close = abs(float(bars[i].low) - float(bars[i-1].close))
            true_range = max(high_low, high_close, low_close)
            true_ranges.append(true_range)
        
        period = min(period, len(true_ranges))
        return sum(true_ranges[-period:]) / period


# Singleton instance
_adaptive_sl_manager = None

def get_adaptive_sl_manager() -> AdaptiveSLManager:
    """Get singleton Adaptive SL manager"""
    global _adaptive_sl_manager
    if _adaptive_sl_manager is None:
        _adaptive_sl_manager = AdaptiveSLManager()
    return _adaptive_sl_manager
