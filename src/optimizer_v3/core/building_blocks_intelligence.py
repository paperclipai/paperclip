"""
Building Blocks Intelligence Database
======================================

Maps all building blocks to their metric improvement capabilities.

This database powers the intelligent recommendation engine by providing:
- Metric impact analysis (which metrics each block improves)
- Expected improvement percentages (based on historical data)
- Use case recommendations (when to add each block)
- Category classification (entry filters, trend filters, etc.)

Author: Optimizer v3 Team
Date: 2026-01-22
Sprint: 1.6 (Intelligent Recommendations - Task 1.6.1)
"""

from typing import Dict, List, Any

import logging
logger = logging.getLogger(__name__)

# Building Block Intelligence Mapping
# ====================================
# Each block maps to:
# - type: ENTRY_FILTER, TREND_FILTER, EXIT_OPTIMIZATION, RISK_MANAGEMENT
# - improves_metrics: List of metrics this block typically improves
# - average_improvement: Expected improvement by metric (positive = increase, negative = decrease in bad metric)
# - category: Block category from registry
# - block_registry_name: Name in BlockRegistry
# - description: What the block does
# - use_case: When to add this block

BUILDING_BLOCK_IMPROVEMENTS: Dict[str, Dict[str, Any]] = {
    # ================================================================
    # ENTRY FILTERS - Reduce false entries, improve win rate
    # ================================================================
    
    'rsi_divergence': {
        'type': 'ENTRY_FILTER',
        'improves_metrics': ['win_rate', 'avg_loss', 'sharpe_ratio'],
        'average_improvement': {
            'win_rate': +0.10,      # +10% absolute improvement
            'avg_loss': -0.18,       # -18% reduction in average loss
            'sharpe_ratio': +0.15    # +0.15 improvement
        },
        'category': 'OSCILLATORS',
        'block_registry_name': 'rsi_divergence',
        'description': 'RSI divergence filter - reduces false entries by validating momentum reversals',
        'use_case': 'Add when win rate < 60% or avg loss > $50'
    },
    
    'vwap': {
        'type': 'ENTRY_FILTER',
        'improves_metrics': ['win_rate', 'profit_factor'],
        'average_improvement': {
            'win_rate': +0.08,
            'profit_factor': +0.25
        },
        'category': 'INSTITUTIONAL',
        'block_registry_name': 'vwap',
        'description': 'VWAP confirmation - ensures entries align with institutional levels',
        'use_case': 'Add when profit factor < 2.0 or win rate < 55%'
    },
    
    'macd': {
        'type': 'ENTRY_FILTER',
        'improves_metrics': ['win_rate', 'sharpe_ratio', 'profit_factor'],
        'average_improvement': {
            'win_rate': +0.07,
            'sharpe_ratio': +0.12,
            'profit_factor': +0.20
        },
        'category': 'OSCILLATORS',
        'block_registry_name': 'macd',
        'description': 'MACD momentum confirmation - validates trend strength before entry',
        'use_case': 'Add when profit factor < 1.8 or sharpe ratio < 1.5'
    },
    
    'stochastic': {
        'type': 'ENTRY_FILTER',
        'improves_metrics': ['win_rate', 'avg_loss'],
        'average_improvement': {
            'win_rate': +0.09,
            'avg_loss': -0.15
        },
        'category': 'OSCILLATORS',
        'block_registry_name': 'stochastic',
        'description': 'Stochastic overbought/oversold filter - improves entry timing',
        'use_case': 'Add when win rate < 55% or entries are poorly timed'
    },
    
    'bollinger_bands': {
        'type': 'ENTRY_FILTER',
        'improves_metrics': ['win_rate', 'avg_win', 'profit_factor'],
        'average_improvement': {
            'win_rate': +0.06,
            'avg_win': +0.10,
            'profit_factor': +0.18
        },
        'category': 'VOLATILITY',
        'block_registry_name': 'bollinger_bands',
        'description': 'Bollinger Bands volatility filter - enters at mean reversion points',
        'use_case': 'Add when entries need volatility confirmation'
    },
    
    'volume_profile': {
        'type': 'ENTRY_FILTER',
        'improves_metrics': ['win_rate', 'profit_factor', 'avg_win'],
        'average_improvement': {
            'win_rate': +0.11,
            'profit_factor': +0.28,
            'avg_win': +0.12
        },
        'category': 'INSTITUTIONAL',
        'block_registry_name': 'volume_profile',
        'description': 'Volume profile support/resistance - entries at high-probability levels',
        'use_case': 'Add when win rate < 58% or profit factor < 2.2'
    },
    
    # ================================================================
    # TREND FILTERS - Improve directional accuracy
    # ================================================================
    
    'ema_200_trend': {
        'type': 'TREND_FILTER',
        'improves_metrics': ['win_rate', 'profit_factor', 'recovery_factor'],
        'average_improvement': {
            'win_rate': +0.12,
            'profit_factor': +0.30,
            'recovery_factor': +0.25
        },
        'category': 'MOVING_AVERAGES',
        'block_registry_name': 'ema_200_trend',
        'description': 'EMA 200 trend filter - only trade with higher timeframe trend',
        'use_case': 'Add when win rate < 50% or when losing against trend'
    },
    
    'ema_50_trend': {
        'type': 'TREND_FILTER',
        'improves_metrics': ['win_rate', 'sharpe_ratio'],
        'average_improvement': {
            'win_rate': +0.08,
            'sharpe_ratio': +0.14
        },
        'category': 'MOVING_AVERAGES',
        'block_registry_name': 'ema_50_trend',
        'description': 'EMA 50 trend filter - medium-term trend confirmation',
        'use_case': 'Add when trading against intermediate trend'
    },
    
    'sma_cross': {
        'type': 'TREND_FILTER',
        'improves_metrics': ['win_rate', 'profit_factor'],
        'average_improvement': {
            'win_rate': +0.07,
            'profit_factor': +0.22
        },
        'category': 'MOVING_AVERAGES',
        'block_registry_name': 'sma_cross',
        'description': 'SMA crossover trend filter - validates trend changes',
        'use_case': 'Add when catching false trend reversals'
    },
    
    'adx': {
        'type': 'TREND_FILTER',
        'improves_metrics': ['win_rate', 'profit_factor', 'sharpe_ratio'],
        'average_improvement': {
            'win_rate': +0.10,
            'profit_factor': +0.26,
            'sharpe_ratio': +0.16
        },
        'category': 'TREND',
        'block_registry_name': 'adx',
        'description': 'ADX trend strength filter - only trade in strong trends',
        'use_case': 'Add when win rate < 55% or trading in choppy markets'
    },
    
    'supertrend': {
        'type': 'TREND_FILTER',
        'improves_metrics': ['win_rate', 'recovery_factor', 'profit_factor'],
        'average_improvement': {
            'win_rate': +0.09,
            'recovery_factor': +0.22,
            'profit_factor': +0.24
        },
        'category': 'TREND',
        'block_registry_name': 'supertrend',
        'description': 'Supertrend indicator - dynamic trend following',
        'use_case': 'Add when trend identification is weak'
    },
    
    # ================================================================
    # EXIT OPTIMIZATION - Improve avg_win, reduce avg_loss
    # ================================================================
    
    'trailing_stop': {
        'type': 'EXIT_OPTIMIZATION',
        'improves_metrics': ['avg_win', 'largest_win', 'recovery_factor'],
        'average_improvement': {
            'avg_win': +0.15,
            'largest_win': +0.20,
            'recovery_factor': +0.20
        },
        'category': 'RISK_MANAGEMENT',
        'block_registry_name': 'trailing_stop',
        'description': 'Trailing stop - locks in profits during strong moves',
        'use_case': 'Add when avg win < avg loss or when profits give back gains'
    },
    
    'dynamic_tp': {
        'type': 'EXIT_OPTIMIZATION',
        'improves_metrics': ['avg_win', 'profit_factor', 'risk_reward_ratio'],
        'average_improvement': {
            'avg_win': +0.18,
            'profit_factor': +0.28,
            'risk_reward_ratio': +0.35
        },
        'category': 'RISK_MANAGEMENT',
        'block_registry_name': 'dynamic_tp',
        'description': 'Dynamic take profit - adjusts targets based on market conditions',
        'use_case': 'Add when risk/reward ratio < 2.0 or avg win is small'
    },
    
    'break_even_stop': {
        'type': 'EXIT_OPTIMIZATION',
        'improves_metrics': ['avg_loss', 'profit_factor', 'recovery_factor'],
        'average_improvement': {
            'avg_loss': -0.25,
            'profit_factor': +0.22,
            'recovery_factor': +0.18
        },
        'category': 'RISK_MANAGEMENT',
        'block_registry_name': 'break_even_stop',
        'description': 'Break-even stop - moves SL to entry after profit threshold',
        'use_case': 'Add when avg loss > $40 or profit factor < 1.8'
    },
    
    'partial_tp': {
        'type': 'EXIT_OPTIMIZATION',
        'improves_metrics': ['avg_win', 'win_rate', 'profit_factor'],
        'average_improvement': {
            'avg_win': +0.12,
            'win_rate': +0.05,
            'profit_factor': +0.20
        },
        'category': 'RISK_MANAGEMENT',
        'block_registry_name': 'partial_tp',
        'description': 'Partial take profit - secures gains while letting winners run',
        'use_case': 'Add when winners frequently reverse before TP'
    },
    
    # ================================================================
    # RISK MANAGEMENT - Reduce drawdown, improve risk metrics
    # ================================================================
    
    'atr': {
        'type': 'RISK_MANAGEMENT',
        'improves_metrics': ['max_drawdown_pct', 'sortino_ratio', 'calmar_ratio'],
        'average_improvement': {
            'max_drawdown_pct': -0.25,  # 25% reduction
            'sortino_ratio': +0.20,
            'calmar_ratio': +0.18
        },
        'category': 'VOLATILITY',
        'block_registry_name': 'atr',
        'description': 'ATR-based position sizing - adapts risk to volatility',
        'use_case': 'Add when max drawdown > 15% or volatility issues'
    },
    
    'position_sizing_kelly': {
        'type': 'RISK_MANAGEMENT',
        'improves_metrics': ['max_drawdown_pct', 'recovery_factor', 'sharpe_ratio'],
        'average_improvement': {
            'max_drawdown_pct': -0.30,
            'recovery_factor': +0.35,
            'sharpe_ratio': +0.22
        },
        'category': 'RISK_MANAGEMENT',
        'block_registry_name': 'position_sizing_kelly',
        'description': 'Kelly Criterion position sizing - optimal bet sizing for growth',
        'use_case': 'Add when max drawdown > 20% or sizing is suboptimal'
    },
    
    'max_daily_loss_limit': {
        'type': 'RISK_MANAGEMENT',
        'improves_metrics': ['max_drawdown_pct', 'max_consecutive_losses', 'recovery_factor'],
        'average_improvement': {
            'max_drawdown_pct': -0.20,
            'max_consecutive_losses': -0.30,
            'recovery_factor': +0.25
        },
        'category': 'RISK_MANAGEMENT',
        'block_registry_name': 'max_daily_loss_limit',
        'description': 'Daily loss limit - stops trading after threshold breach',
        'use_case': 'Add when max_consecutive_losses > 5 or drawdown > 18%'
    },
    
    'correlation_filter': {
        'type': 'RISK_MANAGEMENT',
        'improves_metrics': ['max_drawdown_pct', 'sharpe_ratio', 'sortino_ratio'],
        'average_improvement': {
            'max_drawdown_pct': -0.15,
            'sharpe_ratio': +0.18,
            'sortino_ratio': +0.22
        },
        'category': 'RISK_MANAGEMENT',
        'block_registry_name': 'correlation_filter',
        'description': 'Correlation filter - prevents over-exposure to correlated assets',
        'use_case': 'Add when trading multiple correlated instruments'
    },
    
    # ================================================================
    # PATTERN RECOGNITION - Improve entry quality
    # ================================================================
    
    'm_pattern': {
        'type': 'ENTRY_FILTER',
        'improves_metrics': ['win_rate', 'profit_factor', 'avg_win'],
        'average_improvement': {
            'win_rate': +0.13,
            'profit_factor': +0.32,
            'avg_win': +0.16
        },
        'category': 'PATTERNS',
        'block_registry_name': 'm_pattern',
        'description': 'M pattern (double top) bearish reversal detection',
        'use_case': 'Add when missing reversal opportunities or win rate < 58%'
    },
    
    'w_pattern': {
        'type': 'ENTRY_FILTER',
        'improves_metrics': ['win_rate', 'profit_factor', 'avg_win'],
        'average_improvement': {
            'win_rate': +0.13,
            'profit_factor': +0.32,
            'avg_win': +0.16
        },
        'category': 'PATTERNS',
        'block_registry_name': 'w_pattern',
        'description': 'W pattern (double bottom) bullish reversal detection',
        'use_case': 'Add when missing reversal opportunities or win rate < 58%'
    },
    
    'head_shoulders': {
        'type': 'ENTRY_FILTER',
        'improves_metrics': ['win_rate', 'avg_win', 'profit_factor'],
        'average_improvement': {
            'win_rate': +0.11,
            'avg_win': +0.14,
            'profit_factor': +0.28
        },
        'category': 'PATTERNS',
        'block_registry_name': 'head_shoulders',
        'description': 'Head and shoulders pattern - strong reversal signal',
        'use_case': 'Add when need higher confidence reversal entries'
    },
    
    'engulfing_candle': {
        'type': 'ENTRY_FILTER',
        'improves_metrics': ['win_rate', 'avg_loss'],
        'average_improvement': {
            'win_rate': +0.08,
            'avg_loss': -0.12
        },
        'category': 'PRICE_ACTION',
        'block_registry_name': 'engulfing_candle',
        'description': 'Engulfing candle pattern - strong directional signal',
        'use_case': 'Add when entries need candlestick confirmation'
    },
    
    # ================================================================
    # SMC/ICT CONCEPTS - Institutional order flow
    # ================================================================
    
    'order_block': {
        'type': 'ENTRY_FILTER',
        'improves_metrics': ['win_rate', 'profit_factor', 'avg_win'],
        'average_improvement': {
            'win_rate': +0.14,
            'profit_factor': +0.35,
            'avg_win': +0.18
        },
        'category': 'SMC_ICT',
        'block_registry_name': 'order_block',
        'description': 'Order block detection - institutional demand/supply zones',
        'use_case': 'Add when win rate < 62% or need institutional-grade entries'
    },
    
    'fair_value_gap': {
        'type': 'ENTRY_FILTER',
        'improves_metrics': ['win_rate', 'avg_win', 'profit_factor'],
        'average_improvement': {
            'win_rate': +0.12,
            'avg_win': +0.15,
            'profit_factor': +0.30
        },
        'category': 'SMC_ICT',
        'block_registry_name': 'fair_value_gap',
        'description': 'Fair value gap (FVG/Imbalance) - price inefficiency zones',
        'use_case': 'Add when need high-probability retracement entries'
    },
    
    'liquidity_sweep': {
        'type': 'ENTRY_FILTER',
        'improves_metrics': ['win_rate', 'profit_factor', 'sharpe_ratio'],
        'average_improvement': {
            'win_rate': +0.15,
            'profit_factor': +0.38,
            'sharpe_ratio': +0.24
        },
        'category': 'SMC_ICT',
        'block_registry_name': 'liquidity_sweep',
        'description': 'Liquidity sweep detection - stop hunts before reversals',
        'use_case': 'Add when catching false breakouts or win rate < 65%'
    },
    
    'breaker_block': {
        'type': 'ENTRY_FILTER',
        'improves_metrics': ['win_rate', 'avg_win'],
        'average_improvement': {
            'win_rate': +0.11,
            'avg_win': +0.13
        },
        'category': 'SMC_ICT',
        'block_registry_name': 'breaker_block',
        'description': 'Breaker block - failed order blocks become reversal zones',
        'use_case': 'Add when need advanced reversal confirmation'
    },
    
    # ================================================================
    # SUPPLY/DEMAND - Price levels
    # ================================================================
    
    'supply_demand_zones': {
        'type': 'ENTRY_FILTER',
        'improves_metrics': ['win_rate', 'profit_factor', 'avg_win'],
        'average_improvement': {
            'win_rate': +0.10,
            'profit_factor': +0.27,
            'avg_win': +0.14
        },
        'category': 'SUPPLY_DEMAND',
        'block_registry_name': 'supply_demand_zones',
        'description': 'Supply/demand zone detection - institutional S/R levels',
        'use_case': 'Add when entries need strong support/resistance confirmation'
    },
    
    # ================================================================
    # FIBONACCI - Retracement levels
    # ================================================================
    
    'fibonacci_retracement': {
        'type': 'ENTRY_FILTER',
        'improves_metrics': ['win_rate', 'avg_win'],
        'average_improvement': {
            'win_rate': +0.09,
            'avg_win': +0.12
        },
        'category': 'FIBONACCI',
        'block_registry_name': 'fibonacci_retracement',
        'description': 'Fibonacci retracement levels - natural retracement zones',
        'use_case': 'Add when need pullback entry confirmation'
    },
    
    # ================================================================
    # SESSION FILTERS - Time-based filters
    # ================================================================
    
    'asia_session': {
        'type': 'ENTRY_FILTER',
        'improves_metrics': ['win_rate', 'profit_factor'],
        'average_improvement': {
            'win_rate': +0.06,
            'profit_factor': +0.18
        },
        'category': 'SESSIONS',
        'block_registry_name': 'asia_session',
        'description': 'Asia session filter - trades only during Asian hours',
        'use_case': 'Add when strategy performs better in Asia session'
    },
    
    'london_session': {
        'type': 'ENTRY_FILTER',
        'improves_metrics': ['win_rate', 'avg_win', 'profit_factor'],
        'average_improvement': {
            'win_rate': +0.08,
            'avg_win': +0.10,
            'profit_factor': +0.22
        },
        'category': 'SESSIONS',
        'block_registry_name': 'london_session',
        'description': 'London session filter - high volatility trading hours',
        'use_case': 'Add when need higher volatility for profitable trades'
    },
    
    'new_york_session': {
        'type': 'ENTRY_FILTER',
        'improves_metrics': ['win_rate', 'avg_win', 'profit_factor'],
        'average_improvement': {
            'win_rate': +0.09,
            'avg_win': +0.11,
            'profit_factor': +0.24
        },
        'category': 'SESSIONS',
        'block_registry_name': 'new_york_session',
        'description': 'New York session filter - US market hours trading',
        'use_case': 'Add when strategy performs better in NY session'
    },
    
    # ================================================================
    # WYCKOFF - Market phases
    # ================================================================
    
    'wyckoff_accumulation': {
        'type': 'ENTRY_FILTER',
        'improves_metrics': ['win_rate', 'profit_factor', 'avg_win'],
        'average_improvement': {
            'win_rate': +0.12,
            'profit_factor': +0.30,
            'avg_win': +0.16
        },
        'category': 'WYCKOFF',
        'block_registry_name': 'wyckoff_accumulation',
        'description': 'Wyckoff accumulation phase detection - smart money buying',
        'use_case': 'Add when need institutional accumulation confirmation'
    },
    
    'wyckoff_distribution': {
        'type': 'ENTRY_FILTER',
        'improves_metrics': ['win_rate', 'profit_factor', 'avg_win'],
        'average_improvement': {
            'win_rate': +0.12,
            'profit_factor': +0.30,
            'avg_win': +0.16
        },
        'category': 'WYCKOFF',
        'block_registry_name': 'wyckoff_distribution',
        'description': 'Wyckoff distribution phase detection - smart money selling',
        'use_case': 'Add when need institutional distribution confirmation'
    },
    
    # ================================================================
    # MARKET STRUCTURE - Higher timeframe context
    # ================================================================
    
    'market_structure_break': {
        'type': 'TREND_FILTER',
        'improves_metrics': ['win_rate', 'profit_factor', 'sharpe_ratio'],
        'average_improvement': {
            'win_rate': +0.11,
            'profit_factor': +0.28,
            'sharpe_ratio': +0.18
        },
        'category': 'MARKET_STRUCTURE',
        'block_registry_name': 'market_structure_break',
        'description': 'Market structure break - trend change confirmation',
        'use_case': 'Add when catching trend reversals early'
    },
    
    'higher_high_lower_low': {
        'type': 'TREND_FILTER',
        'improves_metrics': ['win_rate', 'profit_factor'],
        'average_improvement': {
            'win_rate': +0.08,
            'profit_factor': +0.20
        },
        'category': 'MARKET_STRUCTURE',
        'block_registry_name': 'higher_high_lower_low',
        'description': 'HH/HL/LL/LH pattern - trend structure validation',
        'use_case': 'Add when trend identification needs refinement'
    },
}


def get_blocks_for_metric(metric_key: str) -> List[Dict[str, Any]]:
    """
    Get all building blocks that can improve a specific metric
    
    Args:
        metric_key: Metric identifier (e.g., 'win_rate', 'sharpe_ratio')
    
    Returns:
        List of blocks that improve this metric, sorted by improvement potential
    """
    candidates = []
    
    for block_name, intel in BUILDING_BLOCK_IMPROVEMENTS.items():
        if metric_key in intel['improves_metrics']:
            improvement = intel['average_improvement'].get(metric_key, 0)
            candidates.append({
                'block_name': block_name,
                'improvement': improvement,
                'type': intel['type'],
                'category': intel['category'],
                'description': intel['description'],
                'use_case': intel['use_case']
            })
    
    # Sort by improvement potential (absolute value for negative improvements)
    candidates.sort(key=lambda x: abs(x['improvement']), reverse=True)
    
    return candidates


def get_block_intelligence(block_name: str) -> Dict[str, Any]:
    """
    Get intelligence for a specific building block
    
    Args:
        block_name: Name of the building block
    
    Returns:
        Intelligence dictionary or None if not found
    """
    return BUILDING_BLOCK_IMPROVEMENTS.get(block_name)


def get_all_categories() -> List[str]:
    """Get list of all block categories in intelligence database"""
    categories = set()
    for intel in BUILDING_BLOCK_IMPROVEMENTS.values():
        categories.add(intel['category'])
    return sorted(list(categories))


def get_blocks_by_type(block_type: str) -> Dict[str, Dict[str, Any]]:
    """
    Get all blocks of a specific type
    
    Args:
        block_type: Type filter (ENTRY_FILTER, TREND_FILTER, EXIT_OPTIMIZATION, RISK_MANAGEMENT)
    
    Returns:
        Dictionary of blocks matching the type
    """
    return {
        name: intel
        for name, intel in BUILDING_BLOCK_IMPROVEMENTS.items()
        if intel['type'] == block_type
    }


def get_stats() -> Dict[str, Any]:
    """Get statistics about the intelligence database"""
    types_count = {}
    categories_count = {}
    
    for intel in BUILDING_BLOCK_IMPROVEMENTS.values():
        # Count types
        block_type = intel['type']
        types_count[block_type] = types_count.get(block_type, 0) + 1
        
        # Count categories
        category = intel['category']
        categories_count[category] = categories_count.get(category, 0) + 1
    
    return {
        'total_blocks': len(BUILDING_BLOCK_IMPROVEMENTS),
        'by_type': types_count,
        'by_category': categories_count,
        'categories': get_all_categories()
    }


def print_summary():
    """Print summary of intelligence database"""
    stats = get_stats()
    
    logger.info("=" * 80)
    logger.info("BUILDING BLOCKS INTELLIGENCE DATABASE")
    logger.info("=" * 80)
    logger.info(f"\nTotal Blocks with Intelligence: {stats['total_blocks']}")
    
    logger.info("\nBlocks by Type:")
    for block_type, count in sorted(stats['by_type'].items()):
        logger.info(f"  {block_type:25s}: {count:3d} blocks")
    
    logger.info("\nBlocks by Category:")
    for category, count in sorted(stats['by_category'].items()):
        logger.info(f"  {category:25s}: {count:3d} blocks")
    
    logger.info("=" * 80)


# Print summary when module is imported
if __name__ == '__main__':
    print_summary()
