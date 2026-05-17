"""
Trade Analysis System
Task 1.3.3: Comprehensive trade analysis with pattern recognition

Analyzes:
- Trade Performance (by time, day, market condition)
- Trade Quality (entry/exit efficiency, slippage)
- Trade Patterns (consecutive wins/losses, clustering)
- Optimization Recommendations
"""

from decimal import Decimal
from typing import List, Dict, Optional, Tuple
from datetime import datetime, timedelta
from collections import defaultdict
import numpy as np
from scipy import stats
from nautilus_trader.model.objects import Money, Quantity, Price
from nautilus_trader.model.currencies import USD
from dotenv import load_dotenv
import os


class TradeAnalyzer:
    """Analyze trade patterns, quality, and optimization opportunities"""
    
    def __init__(self):
        """Initialize trade analyzer with configuration"""
        load_dotenv()
        
        self.config = {
            'min_sample_size': int(os.getenv('TRADE_MIN_SAMPLE_SIZE', '50')),
            'pattern_confidence': float(os.getenv('TRADE_PATTERN_CONFIDENCE', '0.95')),
            'cluster_threshold': float(os.getenv('TRADE_CLUSTER_THRESHOLD', '0.5')),
            'quality_window': int(os.getenv('TRADE_QUALITY_WINDOW', '30')),
            'slippage_threshold': float(os.getenv('TRADE_SLIPPAGE_THRESHOLD', '0.001')),
            'commission_impact': float(os.getenv('TRADE_COMMISSION_IMPACT_THRESHOLD', '0.002'))
        }
    
    def analyze_all_trades(self, trades: List[Dict]) -> Dict:
        """
        Perform comprehensive trade analysis
        
        Args:
            trades: List of trade dictionaries with NautilusTrader types
        
        Returns:
            Dictionary with all analysis results
        """
        if not trades:
            return self._empty_analysis()
        
        # Performance analysis
        performance = {
            'hourly': self.analyze_hourly_performance(trades),
            'daily': self.analyze_daily_performance(trades),
            'market_condition': self.analyze_market_condition_performance(trades)
        }
        
        # Quality analysis
        quality = self.analyze_trade_quality(trades)
        
        # Pattern analysis
        patterns = self.identify_patterns(trades)
        
        # Sprint 1.8 Task 1.8.66: Exit condition performance analysis
        exit_condition_analysis = self._analyze_exit_condition_performance(trades)
        
        # Optimization recommendations
        recommendations = self.get_optimization_recommendations(trades)
        
        return {
            'performance_analysis': performance,
            'quality_metrics': quality,
            'identified_patterns': patterns,
            'exit_condition_analysis': exit_condition_analysis,  # Sprint 1.8 Task 1.8.66
            'optimization_recommendations': recommendations,
            'sample_size': len(trades),
            'sample_sufficient': len(trades) >= self.config['min_sample_size']
        }
    
    # ==================== Performance Analysis ====================
    
    def analyze_hourly_performance(self, trades: List[Dict]) -> List[Dict]:
        """
        Analyze performance by hour of day
        
        Returns list of 24 hourly statistics
        """
        hourly_stats = [{'hour': i, 'trades': [], 'wins': 0, 'losses': 0} 
                       for i in range(24)]
        
        # Categorize trades by hour
        for trade in trades:
            entry_time = trade.get('entry_time', datetime.now())
            hour = entry_time.hour
            
            hourly_stats[hour]['trades'].append(trade)
            
            if self._is_winning_trade(trade):
                hourly_stats[hour]['wins'] += 1
            else:
                hourly_stats[hour]['losses'] += 1
        
        # Calculate statistics for each hour
        results = []
        for hour_data in hourly_stats:
            hour_trades = hour_data['trades']
            
            if not hour_trades:
                results.append({
                    'hour': hour_data['hour'],
                    'trade_count': 0,
                    'win_rate': Decimal('0'),
                    'avg_pnl': Money('0', USD),
                    'total_pnl': Money('0', USD),
                    'avg_duration': timedelta(),
                    'statistical_significance': False
                })
                continue
            
            total_pnl = sum(
                self._money_to_decimal(self._get_trade_pnl(t)) for t in hour_trades
            )
            
            win_rate = Decimal(hour_data['wins']) / Decimal(len(hour_trades))
            
            avg_duration = sum(
                (t.get('exit_time', datetime.now()) - t.get('entry_time', datetime.now()) 
                 for t in hour_trades),
                timedelta()
            ) / len(hour_trades)
            
            # Statistical significance test
            significant = len(hour_trades) >= 30 and (
                win_rate > Decimal('0.6') or win_rate < Decimal('0.4')
            )
            
            results.append({
                'hour': hour_data['hour'],
                'trade_count': len(hour_trades),
                'win_rate': win_rate,
                'avg_pnl': Money(str(total_pnl / Decimal(len(hour_trades))), USD),
                'total_pnl': Money(str(total_pnl), USD),
                'avg_duration': avg_duration,
                'statistical_significance': significant
            })
        
        return results
    
    def analyze_daily_performance(self, trades: List[Dict]) -> List[Dict]:
        """
        Analyze performance by day of week
        
        Returns list of 7 daily statistics
        """
        days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
        daily_stats = [{'day': day, 'day_num': i, 'trades': [], 'wins': 0, 'losses': 0} 
                      for i, day in enumerate(days)]
        
        # Categorize trades by day
        for trade in trades:
            entry_time = trade.get('entry_time', datetime.now())
            day_num = entry_time.weekday()
            
            daily_stats[day_num]['trades'].append(trade)
            
            if self._is_winning_trade(trade):
                daily_stats[day_num]['wins'] += 1
            else:
                daily_stats[day_num]['losses'] += 1
        
        # Calculate statistics for each day
        results = []
        for day_data in daily_stats:
            day_trades = day_data['trades']
            
            if not day_trades:
                results.append({
                    'day': day_data['day'],
                    'day_num': day_data['day_num'],
                    'trade_count': 0,
                    'win_rate': Decimal('0'),
                    'avg_pnl': Money('0', USD),
                    'total_pnl': Money('0', USD),
                    'statistical_significance': False
                })
                continue
            
            total_pnl = sum(
                self._money_to_decimal(self._get_trade_pnl(t)) for t in day_trades
            )
            
            win_rate = Decimal(day_data['wins']) / Decimal(len(day_trades))
            
            # Statistical significance test
            significant = len(day_trades) >= 20 and (
                win_rate > Decimal('0.6') or win_rate < Decimal('0.4')
            )
            
            results.append({
                'day': day_data['day'],
                'day_num': day_data['day_num'],
                'trade_count': len(day_trades),
                'win_rate': win_rate,
                'avg_pnl': Money(str(total_pnl / Decimal(len(day_trades))), USD),
                'total_pnl': Money(str(total_pnl), USD),
                'statistical_significance': significant
            })
        
        return results
    
    def analyze_market_condition_performance(self, trades: List[Dict]) -> Dict:
        """
        Analyze performance by market condition
        
        Market conditions: trending, ranging, volatile
        """
        # Categorize trades by estimated market condition
        trending_trades = []
        ranging_trades = []
        volatile_trades = []
        
        for trade in trades:
            # Use trade duration and PnL volatility as proxy for market condition
            duration = (trade.get('exit_time', datetime.now()) - 
                       trade.get('entry_time', datetime.now()))
            
            pnl_value = abs(self._money_to_decimal(self._get_trade_pnl(trade)))
            
            # Simple heuristic classification
            if duration < timedelta(hours=1) and pnl_value > Decimal('100'):
                volatile_trades.append(trade)
            elif duration > timedelta(hours=4):
                trending_trades.append(trade)
            else:
                ranging_trades.append(trade)
        
        return {
            'trending': self._calculate_condition_stats(trending_trades, 'Trending'),
            'ranging': self._calculate_condition_stats(ranging_trades, 'Ranging'),
            'volatile': self._calculate_condition_stats(volatile_trades, 'Volatile')
        }
    
    def _calculate_condition_stats(self, trades: List[Dict], condition: str) -> Dict:
        """Calculate statistics for a market condition"""
        if not trades:
            return {
                'condition': condition,
                'trade_count': 0,
                'win_rate': Decimal('0'),
                'avg_pnl': Money('0', USD),
                'total_pnl': Money('0', USD)
            }
        
        wins = sum(1 for t in trades if self._is_winning_trade(t))
        total_pnl = sum(
            self._money_to_decimal(self._get_trade_pnl(t)) for t in trades
        )
        
        return {
            'condition': condition,
            'trade_count': len(trades),
            'win_rate': Decimal(wins) / Decimal(len(trades)),
            'avg_pnl': Money(str(total_pnl / Decimal(len(trades))), USD),
            'total_pnl': Money(str(total_pnl), USD)
        }
    
    # ==================== Quality Analysis ====================
    
    def analyze_trade_quality(self, trades: List[Dict]) -> Dict:
        """
        Analyze trade execution quality
        
        Includes entry/exit efficiency, slippage, commission impact
        """
        if not trades:
            return self._empty_quality_metrics()
        
        # Entry efficiency - how close to optimal entry
        entry_efficiency = self._calculate_entry_efficiency(trades)
        
        # Exit efficiency - how close to optimal exit
        exit_efficiency = self._calculate_exit_efficiency(trades)
        
        # Slippage analysis
        slippage_stats = self._analyze_slippage(trades)
        
        # Commission impact
        commission_stats = self._analyze_commission_impact(trades)
        
        # Risk/reward analysis
        rr_stats = self._analyze_risk_reward(trades)
        
        # Profit factor by setup
        setup_stats = self._analyze_profit_by_setup(trades)
        
        return {
            'entry_efficiency': entry_efficiency,
            'exit_efficiency': exit_efficiency,
            'slippage_analysis': slippage_stats,
            'commission_impact': commission_stats,
            'risk_reward_analysis': rr_stats,
            'setup_statistics': setup_stats
        }
    
    def _calculate_entry_efficiency(self, trades: List[Dict]) -> Decimal:
        """Calculate entry efficiency score (0-1)"""
        # Simplified: measure how quickly trades become profitable
        quick_profit_trades = 0
        
        for trade in trades:
            if self._is_winning_trade(trade):
                # If it's a winner, assume good entry
                quick_profit_trades += 1
        
        if not trades:
            return Decimal('0')
        
        return Decimal(quick_profit_trades) / Decimal(len(trades))
    
    def _calculate_exit_efficiency(self, trades: List[Dict]) -> Decimal:
        """Calculate exit efficiency score (0-1)"""
        # Simplified: measure if exits captured reasonable profit
        optimal_exits = 0
        
        for trade in trades:
            if self._is_winning_trade(trade):
                pnl = self._money_to_decimal(self._get_trade_pnl(trade))
                # If PnL is positive and reasonable, consider it optimal
                if pnl > Decimal('0'):
                    optimal_exits += 1
        
        if not trades:
            return Decimal('0')
        
        return Decimal(optimal_exits) / Decimal(len(trades))
    
    def _analyze_slippage(self, trades: List[Dict]) -> Dict:
        """Analyze slippage statistics"""
        slippages = []
        
        for trade in trades:
            slippage = trade.get('slippage', Money('0', USD))
            slippage_value = self._money_to_decimal(slippage)
            slippages.append(slippage_value)
        
        if not slippages:
            return {
                'avg_slippage': Money('0', USD),
                'max_slippage': Money('0', USD),
                'total_slippage': Money('0', USD),
                'problematic_trades': 0
            }
        
        slippages_array = np.array([float(s) for s in slippages])
        
        threshold = self.config['slippage_threshold']
        problematic = np.sum(np.abs(slippages_array) > threshold)
        
        return {
            'avg_slippage': Money(str(Decimal(str(np.mean(slippages_array)))), USD),
            'max_slippage': Money(str(max(slippages, key=abs)), USD),
            'total_slippage': Money(str(sum(slippages)), USD),
            'problematic_trades': int(problematic)
        }
    
    def _analyze_commission_impact(self, trades: List[Dict]) -> Dict:
        """Analyze commission impact on profitability"""
        total_commission = Decimal('0')
        total_pnl = Decimal('0')
        
        for trade in trades:
            commission = trade.get('commission', Money('0', USD))
            pnl = self._get_trade_pnl(trade)
            
            total_commission += self._money_to_decimal(commission)
            total_pnl += self._money_to_decimal(pnl)
        
        if total_pnl == Decimal('0'):
            impact_pct = Decimal('0')
        else:
            impact_pct = abs(total_commission) / abs(total_pnl)
        
        return {
            'total_commission': Money(str(total_commission), USD),
            'avg_commission_per_trade': Money(str(total_commission / Decimal(len(trades))), USD) if trades else Money('0', USD),
            'commission_as_pct_of_pnl': impact_pct,
            'excessive_impact': impact_pct > Decimal(str(self.config['commission_impact']))
        }
    
    def _analyze_risk_reward(self, trades: List[Dict]) -> Dict:
        """Analyze risk/reward ratios"""
        rr_ratios = []
        
        for trade in trades:
            rr = trade.get('risk_reward_ratio', Decimal('0'))
            if isinstance(rr, Decimal):
                rr_ratios.append(rr)
            else:
                rr_ratios.append(Decimal(str(rr)))
        
        if not rr_ratios:
            return {
                'avg_rr_ratio': Decimal('0'),
                'min_rr_ratio': Decimal('0'),
                'max_rr_ratio': Decimal('0')
            }
        
        return {
            'avg_rr_ratio': sum(rr_ratios) / Decimal(len(rr_ratios)),
            'min_rr_ratio': min(rr_ratios),
            'max_rr_ratio': max(rr_ratios)
        }
    
    def _analyze_profit_by_setup(self, trades: List[Dict]) -> Dict:
        """Analyze profit factor by trade setup/signal"""
        # Group by signals (if available)
        setup_performance = defaultdict(lambda: {'wins': 0, 'losses': 0, 'total_pnl': Decimal('0')})
        
        for trade in trades:
            # Get primary signal/setup
            signals = trade.get('signals', [])
            setup_name = signals[0].get('name', 'Unknown') if signals else 'Unknown'
            
            pnl = self._money_to_decimal(self._get_trade_pnl(trade))
            
            if self._is_winning_trade(trade):
                setup_performance[setup_name]['wins'] += 1
            else:
                setup_performance[setup_name]['losses'] += 1
            
            setup_performance[setup_name]['total_pnl'] += pnl
        
        # Calculate profit factor for each setup
        results = {}
        for setup, stats in setup_performance.items():
            total_trades = stats['wins'] + stats['losses']
            win_rate = Decimal(stats['wins']) / Decimal(total_trades) if total_trades > 0 else Decimal('0')
            
            results[setup] = {
                'trade_count': total_trades,
                'win_rate': win_rate,
                'total_pnl': Money(str(stats['total_pnl']), USD),
                'avg_pnl': Money(str(stats['total_pnl'] / Decimal(total_trades)), USD) if total_trades > 0 else Money('0', USD)
            }
        
        return results
    
    # ==================== Pattern Recognition ====================
    
    def identify_patterns(self, trades: List[Dict]) -> List[Dict]:
        """
        Identify trading patterns
        
        Returns list of identified patterns with confidence scores
        """
        patterns = []
        
        # Consecutive wins/losses pattern
        consecutive_pattern = self._identify_consecutive_pattern(trades)
        if consecutive_pattern['confidence'] >= self.config['pattern_confidence']:
            patterns.append(consecutive_pattern)
        
        # Time clustering pattern
        time_clustering = self._identify_time_clustering(trades)
        if time_clustering['confidence'] >= self.config['pattern_confidence']:
            patterns.append(time_clustering)
        
        # Volume patterns
        volume_pattern = self._identify_volume_patterns(trades)
        if volume_pattern['confidence'] >= self.config['pattern_confidence']:
            patterns.append(volume_pattern)
        
        # Duration patterns
        duration_pattern = self._identify_duration_patterns(trades)
        if duration_pattern['confidence'] >= self.config['pattern_confidence']:
            patterns.append(duration_pattern)
        
        return patterns
    
    def _identify_consecutive_pattern(self, trades: List[Dict]) -> Dict:
        """Identify consecutive win/loss patterns"""
        max_consecutive_wins = 0
        max_consecutive_losses = 0
        current_wins = 0
        current_losses = 0
        
        for trade in trades:
            if self._is_winning_trade(trade):
                current_wins += 1
                current_losses = 0
                max_consecutive_wins = max(max_consecutive_wins, current_wins)
            else:
                current_losses += 1
                current_wins = 0
                max_consecutive_losses = max(max_consecutive_losses, current_losses)
        
        # High consecutive losses indicate potential risk management issue
        confidence = 0.0
        description = ""
        
        if max_consecutive_losses >= 5:
            confidence = 0.95
            description = f"High consecutive losses detected ({max_consecutive_losses}). Review risk management."
        elif max_consecutive_wins >= 5:
            confidence = 0.90
            description = f"Strong winning streak detected ({max_consecutive_wins}). Monitor for mean reversion."
        
        return {
            'pattern_type': 'consecutive_trades',
            'confidence': confidence,
            'description': description,
            'max_consecutive_wins': max_consecutive_wins,
            'max_consecutive_losses': max_consecutive_losses
        }
    
    def _identify_time_clustering(self, trades: List[Dict]) -> Dict:
        """Identify if trades cluster at specific times"""
        if len(trades) < self.config['min_sample_size']:
            return {'pattern_type': 'time_clustering', 'confidence': 0.0, 'description': 'Insufficient data'}
        
        # Calculate time between trades
        time_diffs = []
        for i in range(1, len(trades)):
            diff = (trades[i].get('entry_time', datetime.now()) - 
                   trades[i-1].get('entry_time', datetime.now()))
            time_diffs.append(diff.total_seconds() / 3600)  # Hours
        
        if not time_diffs:
            return {'pattern_type': 'time_clustering', 'confidence': 0.0, 'description': 'No time data'}
        
        # Calculate coefficient of variation
        time_array = np.array(time_diffs)
        cv = np.std(time_array) / np.mean(time_array) if np.mean(time_array) > 0 else 0
        
        # Low CV indicates regular trading pattern
        if cv < self.config['cluster_threshold']:
            return {
                'pattern_type': 'time_clustering',
                'confidence': 0.90,
                'description': f'Regular trading pattern detected. Avg time between trades: {np.mean(time_array):.1f}h',
                'coefficient_of_variation': float(cv),
                'avg_time_between_trades_hours': float(np.mean(time_array))
            }
        
        return {
            'pattern_type': 'time_clustering',
            'confidence': 0.0,
            'description': 'No significant time clustering'
        }
    
    def _identify_volume_patterns(self, trades: List[Dict]) -> Dict:
        """Identify volume-related patterns"""
        volumes = []
        
        for trade in trades:
            quantity = trade.get('quantity', Quantity.from_str('0'))
            if isinstance(quantity, Quantity):
                volumes.append(float(quantity.as_decimal()))
            else:
                volumes.append(float(quantity))
        
        if not volumes or len(volumes) < 10:
            return {'pattern_type': 'volume', 'confidence': 0.0, 'description': 'Insufficient volume data'}
        
        volumes_array = np.array(volumes)
        cv = np.std(volumes_array) / np.mean(volumes_array) if np.mean(volumes_array) > 0 else 0
        
        # Consistent volume sizing
        if cv < 0.2:
            return {
                'pattern_type': 'volume',
                'confidence': 0.85,
                'description': 'Consistent position sizing detected',
                'avg_volume': float(np.mean(volumes_array)),
                'volume_std': float(np.std(volumes_array))
            }
        
        return {
            'pattern_type': 'volume',
            'confidence': 0.0,
            'description': 'Variable position sizing'
        }
    
    def _identify_duration_patterns(self, trades: List[Dict]) -> Dict:
        """Identify trade duration patterns"""
        durations = []
        
        for trade in trades:
            entry_time = trade.get('entry_time', datetime.now())
            exit_time = trade.get('exit_time', datetime.now())
            duration = (exit_time - entry_time).total_seconds() / 3600  # Hours
            durations.append(duration)
        
        if not durations or len(durations) < 10:
            return {'pattern_type': 'duration', 'confidence': 0.0, 'description': 'Insufficient duration data'}
        
        durations_array = np.array(durations)
        avg_duration = np.mean(durations_array)
        
        # Categorize as scalping, intraday, or swing
        if avg_duration < 1:
            style = 'Scalping'
        elif avg_duration < 24:
            style = 'Intraday'
        else:
            style = 'Swing'
        
        return {
            'pattern_type': 'duration',
            'confidence': 0.90,
            'description': f'{style} trading style detected. Avg duration: {avg_duration:.1f}h',
            'trading_style': style,
            'avg_duration_hours': float(avg_duration),
            'min_duration_hours': float(np.min(durations_array)),
            'max_duration_hours': float(np.max(durations_array))
        }
    
    # ==================== Optimization Recommendations ====================
    
    def get_optimization_recommendations(self, trades: List[Dict]) -> List[Dict]:
        """
        Generate optimization recommendations
        
        Returns prioritized list of recommendations with impact estimates
        """
        recommendations = []
        
        if len(trades) < self.config['min_sample_size']:
            return [{
                'priority': 'HIGH',
                'category': 'Data',
                'recommendation': f'Collect more data. Need {self.config["min_sample_size"]} trades, have {len(trades)}',
                'impact': 'HIGH',
                'effort': 'MEDIUM'
            }]
        
        # Analyze hourly performance for time-based recommendations
        hourly_perf = self.analyze_hourly_performance(trades)
        best_hours = [h for h in hourly_perf if h['win_rate'] > Decimal('0.6') and h['statistical_significance']]
        worst_hours = [h for h in hourly_perf if h['win_rate'] < Decimal('0.4') and h['statistical_significance']]
        
        if worst_hours:
            recommendations.append({
                'priority': 'HIGH',
                'category': 'Timing',
                'recommendation': f'Avoid trading during hours: {[h["hour"] for h in worst_hours]}',
                'impact': 'HIGH',
                'effort': 'LOW',
                'details': f'These hours show consistently poor performance'
            })
        
        if best_hours:
            recommendations.append({
                'priority': 'MEDIUM',
                'category': 'Timing',
                'recommendation': f'Focus on high-performance hours: {[h["hour"] for h in best_hours]}',
                'impact': 'MEDIUM',
                'effort': 'LOW',
                'details': f'These hours show consistently strong performance'
            })
        
        # Quality-based recommendations
        quality = self.analyze_trade_quality(trades)
        
        if quality['entry_efficiency'] < Decimal('0.6'):
            recommendations.append({
                'priority': 'HIGH',
                'category': 'Execution',
                'recommendation': 'Improve entry timing - entry efficiency is low',
                'impact': 'HIGH',
                'effort': 'HIGH',
                'details': 'Consider tighter entry conditions or better signal confirmation'
            })
        
        if quality['commission_impact']['excessive_impact']:
            recommendations.append({
                'priority': 'MEDIUM',
                'category': 'Cost',
                'recommendation': 'Reduce trading frequency - commission impact is high',
                'impact': 'MEDIUM',
                'effort': 'MEDIUM',
                'details': 'Commission eating into profits significantly'
            })
        
        # Pattern-based recommendations
        patterns = self.identify_patterns(trades)
        for pattern in patterns:
            if pattern['pattern_type'] == 'consecutive_trades' and pattern.get('max_consecutive_losses', 0) >= 5:
                recommendations.append({
                    'priority': 'HIGH',
                    'category': 'Risk Management',
                    'recommendation': 'Implement daily loss limits',
                    'impact': 'HIGH',
                    'effort': 'LOW',
                    'details': f'Max consecutive losses: {pattern.get("max_consecutive_losses")}'
                })
        
        # Sort by priority
        priority_order = {'HIGH': 0, 'MEDIUM': 1, 'LOW': 2}
        recommendations.sort(key=lambda x: priority_order.get(x['priority'], 999))
        
        return recommendations
    
    # ==================== Sprint 1.8 Task 1.8.65: Exit Condition Analysis ====================
    
    def _analyze_exit_condition_performance(self, trades: List[Dict]) -> Dict:
        """
        Analyze exit condition trigger performance - Sprint 1.8 Task 1.8.65
        
        Args:
            trades: List of trade dictionaries
            
        Returns:
            Dictionary with exit condition performance metrics
        """
        # Track exit condition triggers
        exit_condition_trades = []
        tp_only_trades = []
        exits_by_condition = defaultdict(lambda: {
            'count': 0,
            'total_pnl': Decimal('0'),
            'avg_exit_price': Decimal('0'),
            'avg_percentage': Decimal('0')
        })
        
        total_exit_pnl = Decimal('0')
        exit_vs_tp_better = 0
        exit_vs_tp_worse = 0
        
        for trade in trades:
            exit_type = trade.get('exit_type', 'TP1')
            
            # Check if this trade used exit condition
            if exit_type.startswith('EXIT_'):
                exit_condition_trades.append(trade)
                
                # Get exit condition details
                exit_condition_name = trade.get('exit_condition_name', 'Unknown')
                exit_percentage = trade.get('partial_exit_percentage', Decimal('0'))
                exit_price = trade.get('exit_price', Price.from_str('0'))
                
                # Track by condition name
                exits_by_condition[exit_condition_name]['count'] += 1
                exits_by_condition[exit_condition_name]['total_pnl'] += self._money_to_decimal(
                    self._get_trade_pnl(trade)
                )
                exits_by_condition[exit_condition_name]['avg_percentage'] += Decimal(str(exit_percentage))
                
                # Calculate exit condition PnL
                pnl = self._money_to_decimal(self._get_trade_pnl(trade))
                total_exit_pnl += pnl
                
                # Compare to TP price if available
                nearest_tp_price = trade.get('nearest_tp_price', None)
                if nearest_tp_price and isinstance(exit_price, Price):
                    exit_price_decimal = Decimal(str(exit_price.as_decimal()))
                    tp_price_decimal = Decimal(str(nearest_tp_price))
                    
                    # For LONG: Exit > TP = better, Exit < TP = worse
                    # For SHORT: Exit < TP = better, Exit > TP = worse
                    position_side = trade.get('position_side', 'LONG')
                    
                    if position_side == 'LONG':
                        if exit_price_decimal >= tp_price_decimal:
                            exit_vs_tp_better += 1
                        else:
                            exit_vs_tp_worse += 1
                    else:  # SHORT
                        if exit_price_decimal <= tp_price_decimal:
                            exit_vs_tp_better += 1
                        else:
                            exit_vs_tp_worse += 1
            else:
                # TP/SL only trades
                tp_only_trades.append(trade)
        
        # Calculate averages
        for condition_stats in exits_by_condition.values():
            if condition_stats['count'] > 0:
                condition_stats['avg_pnl'] = Money(
                    str(condition_stats['total_pnl'] / Decimal(condition_stats['count'])),
                    'USD'
                )
                condition_stats['avg_percentage'] /= Decimal(condition_stats['count'])
                condition_stats['total_pnl'] = Money(str(condition_stats['total_pnl']), USD)
        
        # Find best and worst performing exit conditions
        best_exit = None
        worst_exit = None
        
        if exits_by_condition:
            sorted_exits = sorted(
                exits_by_condition.items(),
                key=lambda x: self._money_to_decimal(x[1].get('avg_pnl', Money('0', USD))),
                reverse=True
            )
            
            if sorted_exits:
                best_exit = {
                    'name': sorted_exits[0][0],
                    'avg_pnl': sorted_exits[0][1].get('avg_pnl', Money('0', USD)),
                    'count': sorted_exits[0][1]['count']
                }
                
            if len(sorted_exits) > 1:
                worst_exit = {
                    'name': sorted_exits[-1][0],
                    'avg_pnl': sorted_exits[-1][1].get('avg_pnl', Money('0', USD)),
                    'count': sorted_exits[-1][1]['count']
                }
        
        # Calculate exit vs TP comparison percentage
        total_comparisons = exit_vs_tp_better + exit_vs_tp_worse
        exit_vs_tp_win_rate = (
            Decimal(exit_vs_tp_better) / Decimal(total_comparisons)
            if total_comparisons > 0 else Decimal('0')
        )
        
        # Calculate average exit price vs average TP price
        avg_exit_price_vs_tp = Decimal('0')
        if exit_condition_trades:
            exit_prices = []
            tp_prices = []
            
            for trade in exit_condition_trades:
                exit_price = trade.get('exit_price', None)
                nearest_tp = trade.get('nearest_tp_price', None)
                
                if exit_price and nearest_tp:
                    exit_prices.append(Decimal(str(exit_price)))
                    tp_prices.append(Decimal(str(nearest_tp)))
            
            if exit_prices and tp_prices:
                avg_exit = sum(exit_prices) / Decimal(len(exit_prices))
                avg_tp = sum(tp_prices) / Decimal(len(tp_prices))
                
                if avg_tp != Decimal('0'):
                    avg_exit_price_vs_tp = ((avg_exit - avg_tp) / avg_tp) * Decimal('100')
        
        return {
            'total_exit_condition_triggers': len(exit_condition_trades),
            'exit_condition_pnl': Money(str(total_exit_pnl), USD),
            'exit_condition_vs_tp_comparison': {
                'better_than_tp': exit_vs_tp_better,
                'worse_than_tp': exit_vs_tp_worse,
                'win_rate': exit_vs_tp_win_rate,
                'total_comparisons': total_comparisons
            },
            'avg_exit_price_vs_tp_pct': avg_exit_price_vs_tp,
            'exits_by_condition': dict(exits_by_condition),
            'best_performing_exit': best_exit,
            'worst_performing_exit': worst_exit,
            'tp_only_trades': len(tp_only_trades),
            'partial_exit_percentage': (
                Decimal(len(exit_condition_trades)) / Decimal(len(trades)) * Decimal('100')
                if trades else Decimal('0')
            )
        }
    
    # ==================== Helper Methods ====================
    
    def _money_to_decimal(self, money: Money) -> Decimal:
        """Convert Money to Decimal"""
        if isinstance(money, Money):
            return Decimal(str(money.as_decimal()))
        return Decimal(str(money))
    
    def _get_trade_pnl(self, trade: Dict) -> Money:
        """Get trade PnL"""
        pnl = trade.get('pnl', Money('0', USD))
        if isinstance(pnl, Money):
            return pnl
        return Money(str(pnl), USD)
    
    def _is_winning_trade(self, trade: Dict) -> bool:
        """Check if trade is a winner"""
        pnl = self._get_trade_pnl(trade)
        return self._money_to_decimal(pnl) > Decimal('0')
    
    def _empty_analysis(self) -> Dict:
        """Return empty analysis structure"""
        return {
            'error': 'No trades available for analysis',
            'sample_size': 0,
            'sample_sufficient': False
        }
    
    def _empty_quality_metrics(self) -> Dict:
        """Return empty quality metrics"""
        return {
            'entry_efficiency': Decimal('0'),
            'exit_efficiency': Decimal('0'),
            'slippage_analysis': {},
            'commission_impact': {},
            'risk_reward_analysis': {},
            'setup_statistics': {}
        }
