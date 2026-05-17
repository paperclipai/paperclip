"""
Helper Methods for AI Prompt Builder
=====================================

These helper methods format and analyze data for the AI prompt.
They identify problems, strengths, and structure the request clearly.

Author: Optimizer v3 Team
Date: 2026-01-23
Sprint: 1.6
"""

from typing import Dict, List, Any


def identify_performance_problems(metrics: Dict, trades: Dict) -> List[Dict]:
    """Identify specific performance problems to address"""
    problems = []
    
    # Win rate problems
    win_rate = 0
    if 'win_rate' in metrics:
        win_rate_data = metrics['win_rate']
        if isinstance(win_rate_data, dict):
            win_rate = float(win_rate_data.get('value', 0))
            rating = win_rate_data.get('rating', '')
            
            if rating == '✗ Poor' or win_rate < 50:
                problems.append({
                    'metric': 'win_rate',
                    'current': win_rate,
                    'target': '55-60%',
                    'severity': 'high',
                    'description': f'Win rate {win_rate:.1f}% is below breakeven. Need higher quality signals.'
                })
    
    # Sharpe ratio problems
    if 'sharpe_ratio' in metrics:
        sharpe_data = metrics['sharpe_ratio']
        if isinstance(sharpe_data, dict):
            sharpe = float(sharpe_data.get('value', 0))
            rating = sharpe_data.get('rating', '')
            
            if rating in ['✗ Poor', '⚠ Fair'] or sharpe < 1.5:
                problems.append({
                    'metric': 'sharpe_ratio',
                    'current': sharpe,
                    'target': 2.0,
                    'severity': 'medium',
                    'description': f'Sharpe {sharpe:.2f} indicates poor risk-adjusted returns. Need to reduce volatility or improve consistency.'
                })
    
    # Drawdown problems
    if 'max_drawdown_pct' in metrics:
        dd_data = metrics['max_drawdown_pct']
        if isinstance(dd_data, dict):
            dd = float(dd_data.get('value', 0))
            rating = dd_data.get('rating', '')
            
            if rating in ['✗ High', '⚠ Monitor'] or dd > 15:
                problems.append({
                    'metric': 'max_drawdown_pct',
                    'current': dd,
                    'target': 10.0,
                    'severity': 'high',
                    'description': f'Drawdown {dd:.1f}% exceeds institutional limits. Need tighter risk management.'
                })
    
    # Trade frequency problems
    total_trades = trades.get('total_trades', 0)
    lookback_days = 180  # Default
    trades_per_month = (total_trades / lookback_days) * 30 if lookback_days > 0 else 0
    
    if trades_per_month < 5:
        problems.append({
            'metric': 'trade_frequency',
            'current': trades_per_month,
            'target': '8-12 per month',
            'severity': 'medium',
            'description': f'Only {trades_per_month:.1f} trades/month. Strategy too selective - missing opportunities.'
        })
    elif trades_per_month > 30:
        problems.append({
            'metric': 'trade_frequency',
            'current': trades_per_month,
            'target': '15-20 per month',
            'severity': 'medium',
            'description': f'{trades_per_month:.1f} trades/month is excessive. Over-fitting or false signals.'
        })
    
    return problems


def describe_strategy_intent(strategy: Dict) -> str:
    """Describe what the strategy is trying to accomplish"""
    strategy_type = strategy.get('strategy_type', 'Unknown')
    blocks = strategy.get('blocks', [])
    
    block_names = [b.get('name', '') for b in blocks]
    
    if strategy_type == 'Bearish':
        return f"This is a BEARISH (short-only) strategy using {len(blocks)} blocks: {', '.join(block_names)}. It enters SHORT positions when all blocks trigger, looking for downside moves and resistance levels."
    elif strategy_type == 'Bullish':
        return f"This is a BULLISH (long-only) strategy using {len(blocks)} blocks: {', '.join(block_names)}. It enters LONG positions when all blocks trigger, looking for upside moves and support levels."
    else:
        return f"This strategy uses {len(blocks)} blocks: {', '.join(block_names)}. Logic: Enter when blocks align."


def describe_strengths(metrics: Dict, trades: Dict) -> str:
    """Describe what's working well"""
    strengths = []
    
    # Check each metric for good ratings
    for key, data in metrics.items():
        if isinstance(data, dict):
            rating = data.get('rating', '')
            value = data.get('value', 0)
            
            if rating == '✓ Good':
                if key == 'sharpe_ratio':
                    strengths.append(f"✓ Sharpe Ratio {value:.2f} shows excellent risk-adjusted returns")
                elif key == 'profit_factor':
                    strengths.append(f"✓ Profit Factor {value:.2f} indicates wins significantly exceed losses")
                elif key == 'win_rate':
                    strengths.append(f"✓ Win Rate {value:.1f}% demonstrates good signal quality")
                elif key == 'recovery_factor':
                    strengths.append(f"✓ Recovery Factor {value:.2f} shows strong bounce-back from drawdowns")
    
    if not strengths:
        strengths.append("Strategy shows promise but needs optimization across multiple metrics")
    
    return "\n".join(f"  {s}" for s in strengths)


def describe_problems(problems: List[Dict]) -> str:
    """Describe identified problems clearly"""
    if not problems:
        return "  No critical issues identified - focus on incremental improvements"
    
    problem_text = []
    for p in sorted(problems, key=lambda x: {'high': 0, 'medium': 1, 'low': 2}[x['severity']]):
        problem_text.append(f"  {p['severity'].upper()}: {p['description']}")
    
    return "\n".join(problem_text)


def analyze_trade_patterns(trades: Dict) -> str:
    """Analyze trade execution patterns"""
    total = trades.get('total_trades', 0)
    winning = trades.get('winning_trades', 0)
    losing = trades.get('losing_trades', 0)
    avg_win = trades.get('avg_win', 0)
    avg_loss = trades.get('avg_loss', 0)
    
    analysis = []
    analysis.append(f"Total Executions: {total} ({winning} wins / {losing} losses)")
    
    if avg_win > 0 and avg_loss != 0:
        rr_ratio = abs(avg_win / avg_loss)
        analysis.append(f"Risk:Reward: {rr_ratio:.2f}:1 (Avg win ${avg_win:.2f} vs avg loss ${avg_loss:.2f})")
    
    # Get first 5 trades for pattern analysis
    trade_list = trades.get('trades', [])[:5]
    if trade_list:
        analysis.append("\nRecent Trade Examples:")
        for i, t in enumerate(trade_list, 1):
            pnl = t.get('pnl', 0)
            side = t.get('side', 'Unknown')
            duration = t.get('duration_time', 'Unknown')
            analysis.append(f"  Trade {i}: {side} → ${pnl:.2f} ({duration})")
    
    return "\n".join(analysis)


def format_config_summary(config: Dict) -> str:
    """Format backtest configuration summary"""
    summary = []
    summary.append(f"Timeframe: {config.get('lookback_days', 180)} days lookback")
    summary.append(f"Position Sizing: {config.get('position_sizing', {}).get('position_size', 0.1)} BTC per trade")
    
    risk = config.get('risk_management', {})
    summary.append(f"Stop Loss: {risk.get('stop_loss', 0.02)*100:.1f}%")
    summary.append(f"Take Profit: {risk.get('take_profit_levels', [])}")
    
    return "\n".join(f"- {s}" for s in summary)


def define_primary_objective(problems: List[Dict]) -> str:
    """Define the primary optimization objective"""
    if not problems:
        return "Fine-tune existing strategy for optimal performance"
    
    # Get highest severity problem
    high_severity = [p for p in problems if p['severity'] == 'high']
    if high_severity:
        top_problem = high_severity[0]
        return f"PRIMARY: Fix {top_problem['metric']} - {top_problem['description']}"
    
    # Otherwise get first problem
    return f"PRIMARY: {problems[0]['description']}"


def format_available_blocks_summary(blocks: List[Dict]) -> str:
    """Format available blocks by category"""
    from collections import defaultdict
    
    by_category = defaultdict(list)
    for block in blocks:
        category = block.get('category', 'Unknown')
        name = block.get('name', '')
        by_category[category].append(name)
    
    summary = []
    for category, block_names in sorted(by_category.items()):
        summary.append(f"**{category}** ({len(block_names)}): {', '.join(block_names[:5])}")
        if len(block_names) > 5:
            summary.append(f"  ... and {len(block_names) - 5} more")
    
    return "\n".join(summary)


def extract_relevant_config(config: Dict) -> Dict:
    """Extract only relevant config for AI"""
    return {
        'lookback_days': config.get('lookback_days', 180),
        'timeframe': config.get('timeframe', '15m'),
        'position_sizing': config.get('position_sizing', {}),
        'risk_management': config.get('risk_management', {})
    }


def extract_trade_summary(trades: Dict) -> Dict:
    """Extract trade summary for AI"""
    return {
        'total_trades': trades.get('total_trades', 0),
        'winning_trades': trades.get('winning_trades', 0),
        'losing_trades': trades.get('losing_trades', 0),
        'win_rate': trades.get('win_rate', 0),
        'avg_win': trades.get('avg_win', 0),
        'avg_loss': trades.get('avg_loss', 0),
        'largest_win': trades.get('largest_win', 0),
        'largest_loss': trades.get('largest_loss', 0),
        'sample_trades': trades.get('trades', [])[:10]  # First 10 trades only
    }


def extract_metrics_summary(metrics: Dict) -> Dict:
    """Extract metrics summary for AI"""
    summary = {}
    for key, data in metrics.items():
        if isinstance(data, dict):
            summary[key] = {
                'value': data.get('value', 0),
                'rating': data.get('rating', ''),
                'category': data.get('category', 'Performance')
            }
    return summary


def format_blocks_catalog(blocks: List[Dict]) -> Dict:
    """Format blocks catalog by category for AI"""
    from collections import defaultdict
    
    by_category = defaultdict(list)
    for block in blocks:
        category = block.get('category', 'Unknown')
        by_category[category].append({
            'name': block.get('name', ''),
            'description': block.get('description', ''),
            'signals_count': len(block.get('signals', []))
        })
    
    return dict(by_category)
