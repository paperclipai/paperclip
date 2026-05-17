"""
Intelligent Signal Mapping for Building Blocks
==============================================

Maps building blocks to their appropriate signals based on strategy type.

This module solves the critical problem of adding ALL signals indiscriminately.
For example, liquidity_sweep has BULLISH_SWEEP, BEARISH_SWEEP, ERROR, NEUTRAL, etc.
A Bearish strategy should ONLY get BEARISH_SWEEP.

Author: Optimizer v3 Team  
Date: 2026-01-22
Sprint: 1.6 (Critical Fix - Intelligent Signal Selection)
"""

from typing import Dict, List, Optional

import logging
logger = logging.getLogger(__name__)

# Signal mapping by block name and strategy type
# =============================================
# Format: {
#     'block_name': {
#         'Bullish': ['SIGNAL1', 'SIGNAL2'],
#         'Bearish': ['SIGNAL3', 'SIGNAL4'],
#         'Neutral': ['SIGNAL5']  # Works for both
#     }
# }

SIGNAL_MAPPING: Dict[str, Dict[str, List[str]]] = {
    # SMC/ICT Blocks
    'liquidity_sweep': {
        'Bullish': ['BULLISH_SWEEP'],
        'Bearish': ['BEARISH_SWEEP'],
        'Neutral': []  # None - this is directional only
    },
    
    'order_block': {
        'Bullish': ['BULLISH_OB'],
        'Bearish': ['BEARISH_OB'],
        'Neutral': []
    },
    
    'fair_value_gap': {
        'Bullish': ['BULLISH_FVG'],
        'Bearish': ['BEARISH_FVG'],
        'Neutral': []
    },
    
    'breaker_block': {
        'Bullish': ['BULLISH_BREAKER'],
        'Bearish': ['BEARISH_BREAKER'],
        'Neutral': []
    },
    
    # Pattern Blocks
    'm_pattern': {
        'Bullish': [],  # M-pattern is bearish only
        'Bearish': ['M_PATTERN_DETECTED', 'BEARISH_BREAKDOWN'],
        'Neutral': []
    },
    
    'w_pattern': {
        'Bullish': ['W_PATTERN_DETECTED', 'BULLISH_BREAKOUT'],
        'Bearish': [],  # W-pattern is bullish only
        'Neutral': []
    },
    
    'head_shoulders': {
        'Bullish': [],  # Head & shoulders is bearish
        'Bearish': ['HEAD_SHOULDERS_DETECTED', 'BEARISH_BREAKDOWN'],
        'Neutral': []
    },
    
    'inverse_head_shoulders': {
        'Bullish': ['INVERSE_HEAD_SHOULDERS', 'BULLISH_BREAKOUT'],
        'Bearish': [],  # Inverse is bullish
        'Neutral': []
    },
    
    'engulfing_candle': {
        'Bullish': ['BULLISH_ENGULFING'],
        'Bearish': ['BEARISH_ENGULFING'],
        'Neutral': []
    },
    
    # Oscillator Blocks
    'rsi': {
        'Bullish': ['OVERSOLD'],  # RSI oversold for bullish
        'Bearish': ['OVERBOUGHT'],  # RSI overbought for bearish
        'Neutral': []
    },
    
    'rsi_divergence': {
        'Bullish': ['BULLISH_DIVERGENCE'],
        'Bearish': ['BEARISH_DIVERGENCE', 'OVERBOUGHT'],
        'Neutral': []
    },
    
    'stochastic': {
        'Bullish': ['OVERSOLD', 'BULLISH_CROSS'],
        'Bearish': ['OVERBOUGHT', 'BEARISH_CROSS'],
        'Neutral': []
    },
    
    'stochastic_rsi': {
        'Bullish': ['OVERSOLD', 'BULLISH_CROSS'],
        'Bearish': ['OVERBOUGHT', 'BEARISH_CROSS'],
        'Neutral': []
    },
    
    'macd': {
        'Bullish': ['BULLISH_CROSS', 'BULLISH_DIVERGENCE'],
        'Bearish': ['BEARISH_CROSS', 'BEARISH_DIVERGENCE'],
        'Neutral': []
    },
    
    # Trend Blocks (mostly neutral - work for both directions)
    'ema_200_trend': {
        'Bullish': ['ABOVE_EMA'],
        'Bearish': ['BELOW_EMA'],
        'Neutral': []
    },
    
    'ema_50_trend': {
        'Bullish': ['ABOVE_EMA'],
        'Bearish': ['BELOW_EMA'],
        'Neutral': []
    },
    
    'sma_cross': {
        'Bullish': ['BULLISH_CROSS'],
        'Bearish': ['BEARISH_CROSS'],
        'Neutral': []
    },
    
    'adx': {
        'Bullish': ['STRONG_TREND'],  # ADX is neutral - just confirms strength
        'Bearish': ['STRONG_TREND'],
        'Neutral': ['STRONG_TREND']
    },
    
    'supertrend': {
        'Bullish': ['BULLISH_TREND'],
        'Bearish': ['BEARISH_TREND'],
        'Neutral': []
    },
    
    # Volatility/Risk Blocks (neutral - work for any direction)
    'atr': {
        'Bullish': ['NORMAL', 'HIGH', 'VERY_HIGH', 'EXTREME'],  # All volatility states
        'Bearish': ['NORMAL', 'HIGH', 'VERY_HIGH', 'EXTREME'],
        'Neutral': ['NORMAL', 'HIGH', 'VERY_HIGH', 'EXTREME']
    },
    
    'bollinger_bands': {
        'Bullish': ['LOWER_BAND_TOUCH', 'OVERSOLD'],
        'Bearish': ['UPPER_BAND_TOUCH', 'OVERBOUGHT'],
        'Neutral': []
    },
    
    # Exit/Risk Management Blocks (neutral - work for any direction)
    'trailing_stop': {
        'Bullish': ['ACTIVE'],
        'Bearish': ['ACTIVE'],
        'Neutral': ['ACTIVE']
    },
    
    'break_even_stop': {
        'Bullish': ['ACTIVE'],
        'Bearish': ['ACTIVE'],
        'Neutral': ['ACTIVE']
    },
    
    'dynamic_tp': {
        'Bullish': ['ACTIVE'],
        'Bearish': ['ACTIVE'],
        'Neutral': ['ACTIVE']
    },
    
    'partial_tp': {
        'Bullish': ['ACTIVE'],
        'Bearish': ['ACTIVE'],
        'Neutral': ['ACTIVE']
    },
    
    # Price Level Blocks
    'supply_demand_zones': {
        'Bullish': ['DEMAND_ZONE'],
        'Bearish': ['SUPPLY_ZONE'],
        'Neutral': []
    },
    
    'support_resistance': {
        'Bullish': ['SUPPORT_LEVEL'],
        'Bearish': ['RESISTANCE_LEVEL'],
        'Neutral': []
    },
    
    # Session Blocks (neutral - time-based only)
    'asia_session': {
        'Bullish': ['ACTIVE'],
        'Bearish': ['ACTIVE'],
        'Neutral': ['ACTIVE']
    },
    
    'london_session': {
        'Bullish': ['ACTIVE'],
        'Bearish': ['ACTIVE'],
        'Neutral': ['ACTIVE']
    },
    
    'new_york_session': {
        'Bullish': ['ACTIVE'],
        'Bearish': ['ACTIVE'],
        'Neutral': ['ACTIVE']
    },
    
    # Wyckoff Blocks
    'wyckoff_accumulation': {
        'Bullish': ['ACCUMULATION_DETECTED', 'SPRING_DETECTED'],
        'Bearish': [],  # Accumulation is bullish only
        'Neutral': []
    },
    
    'wyckoff_distribution': {
        'Bullish': [],  # Distribution is bearish only
        'Bearish': ['DISTRIBUTION_DETECTED', 'UPTHRUST_DETECTED'],
        'Neutral': []
    },
    
    # Market Structure Blocks
    'market_structure_break': {
        'Bullish': ['BULLISH_BREAK'],
        'Bearish': ['BEARISH_BREAK'],
        'Neutral': []
    },
    
    'higher_high_lower_low': {
        'Bullish': ['HIGHER_HIGH', 'HIGHER_LOW'],
        'Bearish': ['LOWER_HIGH', 'LOWER_LOW'],
        'Neutral': []
    },
    
    # Volume Blocks (mostly neutral)
    'volume_profile': {
        'Bullish': ['HIGH_VOLUME_NODE'],
        'Bearish': ['HIGH_VOLUME_NODE'],
        'Neutral': ['HIGH_VOLUME_NODE']
    },
    
    'vwap': {
        'Bullish': ['BELOW_VWAP'],  # Price below VWAP for bullish entry
        'Bearish': ['ABOVE_VWAP'],  # Price above VWAP for bearish entry
        'Neutral': []
    },
    
    # Fibonacci Blocks
    'fibonacci_retracement': {
        'Bullish': ['FIB_618_SUPPORT', 'FIB_50_SUPPORT'],
        'Bearish': ['FIB_618_RESISTANCE', 'FIB_50_RESISTANCE'],
        'Neutral': []
    },
    
    # HOD/LOD Blocks
    'hod': {
        'Bullish': [],  # HOD is for bearish rejections
        'Bearish': ['HOD_REJECTION', 'HOD_BREAK', 'HOD_RETEST'],
        'Neutral': []
    },
    
    'lod': {
        'Bullish': ['LOD_BOUNCE', 'LOD_BREAK', 'LOD_RETEST'],
        'Bearish': [],  # LOD is for bullish bounces
        'Neutral': []
    },
}


def get_signals_for_strategy(
    block_name: str,
    strategy_type: str
) -> List[str]:
    """
    Get appropriate signals for a building block based on strategy type
    
    Args:
        block_name: Name of the building block
        strategy_type: Strategy type ('Bullish', 'Bearish', 'Neutral')
    
    Returns:
        List of signal names appropriate for this strategy type
        
    Examples:
        >>> get_signals_for_strategy('liquidity_sweep', 'Bearish')
        ['BEARISH_SWEEP']
        
        >>> get_signals_for_strategy('liquidity_sweep', 'Bullish')
        ['BULLISH_SWEEP']
        
        >>> get_signals_for_strategy('atr', 'Bearish')
        ['NORMAL', 'HIGH', 'VERY_HIGH', 'EXTREME']  # Neutral block
    """
    # Get mapping for this block
    block_mapping = SIGNAL_MAPPING.get(block_name)
    
    if not block_mapping:
        # Block not in mapping - return empty (fallback to registry)
        return []
    
    # Get signals for strategy type
    signals = block_mapping.get(strategy_type, [])
    
    # If no specific signals for this type, check if it's a neutral block
    if not signals and strategy_type != 'Neutral':
        # Try neutral signals (blocks that work for any direction)
        signals = block_mapping.get('Neutral', [])
    
    return signals


def is_block_compatible(
    block_name: str,
    strategy_type: str
) -> bool:
    """
    Check if a building block is compatible with a strategy type
    
    Args:
        block_name: Name of the building block
        strategy_type: Strategy type ('Bullish', 'Bearish', 'Neutral')
    
    Returns:
        True if block has signals for this strategy type, False otherwise
        
    Examples:
        >>> is_block_compatible('m_pattern', 'Bearish')
        True  # M-pattern is bearish
        
        >>> is_block_compatible('m_pattern', 'Bullish')
        False  # M-pattern is NOT bullish
        
        >>> is_block_compatible('atr', 'Bearish')
        True  # ATR is neutral - works for all
    """
    signals = get_signals_for_strategy(block_name, strategy_type)
    return len(signals) > 0


def get_mapping_stats() -> Dict[str, any]:
    """Get statistics about the signal mapping"""
    total_blocks = len(SIGNAL_MAPPING)
    
    bullish_compatible = sum(1 for m in SIGNAL_MAPPING.values() if m.get('Bullish'))
    bearish_compatible = sum(1 for m in SIGNAL_MAPPING.values() if m.get('Bearish'))
    neutral_compatible = sum(1 for m in SIGNAL_MAPPING.values() if m.get('Neutral'))
    
    return {
        'total_blocks': total_blocks,
        'bullish_compatible': bullish_compatible,
        'bearish_compatible': bearish_compatible,
        'neutral_compatible': neutral_compatible
    }


def print_mapping_summary():
    """Print summary of signal mapping"""
    stats = get_mapping_stats()
    
    logger.info("=" * 80)
    logger.info("INTELLIGENT SIGNAL MAPPING DATABASE")
    logger.info("=" * 80)
    logger.info(f"\nTotal Blocks Mapped: {stats['total_blocks']}")
    logger.info(f"\nCompatible with:")
    logger.info(f"  Bullish strategies: {stats['bullish_compatible']} blocks")
    logger.info(f"  Bearish strategies: {stats['bearish_compatible']} blocks")
    logger.info(f"  Neutral (both): {stats['neutral_compatible']} blocks")
    logger.info("=" * 80)


if __name__ == '__main__':
    print_mapping_summary()
    
    # Test examples
    logger.info("\nTest Examples:")
    logger.info(f"liquidity_sweep (Bearish): {get_signals_for_strategy('liquidity_sweep', 'Bearish')}")
    logger.info(f"liquidity_sweep (Bullish): {get_signals_for_strategy('liquidity_sweep', 'Bullish')}")
    logger.info(f"atr (Bearish): {get_signals_for_strategy('atr', 'Bearish')}")
    logger.info(f"m_pattern (Bearish): {get_signals_for_strategy('m_pattern', 'Bearish')}")
    logger.info(f"m_pattern (Bullish): {get_signals_for_strategy('m_pattern', 'Bullish')}")
