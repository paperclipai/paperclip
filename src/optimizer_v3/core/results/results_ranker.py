"""
Results Ranker - Composite Scoring System
Combines institutional metrics, risk metrics, and trade analysis into unified rankings

Uses configurable weights from environment variables
"""

from decimal import Decimal
from typing import List, Dict, Optional
from datetime import datetime
from nautilus_trader.model.objects import Money
from dotenv import load_dotenv
import os

from .institutional_metrics import InstitutionalMetrics
from .risk_metrics import RiskMetrics
from .trade_analyzer import TradeAnalyzer


class ResultsRanker:
    """
    Rank optimization results using multi-objective scoring
    
    Combines:
    - Core performance metrics (Sharpe, Sortino, Calmar)
    - Risk metrics (drawdown, volatility)
    - Trade metrics (win rate, profit factor)
    - Capital efficiency metrics
    - Trade quality metrics
    """
    
    def __init__(self):
        """Initialize ranker with metrics calculators and weights"""
        load_dotenv()
        
        # Initialize metrics calculators
        self.institutional_metrics = InstitutionalMetrics()
        self.risk_metrics = RiskMetrics()
        self.trade_analyzer = TradeAnalyzer()
        
        # Load scoring weights from environment
        self.weights = {
            'sharpe_ratio': Decimal(os.getenv('WEIGHT_SHARPE_RATIO', '0.20')),
            'sortino_ratio': Decimal(os.getenv('WEIGHT_SORTINO_RATIO', '0.15')),
            'calmar_ratio': Decimal(os.getenv('WEIGHT_CALMAR_RATIO', '0.15')),
            'win_rate': Decimal(os.getenv('WEIGHT_WIN_RATE', '0.10')),
            'profit_factor': Decimal(os.getenv('WEIGHT_PROFIT_FACTOR', '0.10')),
            'max_drawdown': Decimal(os.getenv('WEIGHT_MAX_DRAWDOWN', '0.10')),
            'capital_efficiency': Decimal(os.getenv('WEIGHT_CAPITAL_EFFICIENCY', '0.10')),
            'trade_quality': Decimal(os.getenv('WEIGHT_TRADE_QUALITY', '0.10'))
        }
        
        # Verify weights sum to 1.0
        total_weight = sum(self.weights.values())
        if abs(total_weight - Decimal('1.0')) > Decimal('0.01'):
            raise ValueError(f"Weights must sum to 1.0, got {total_weight}")
    
    def rank_results(self, 
                    results: List[Dict],
                    market_returns: Optional[List[Decimal]] = None) -> List[Dict]:
        """
        Rank optimization results by composite score
        
        Args:
            results: List of optimization result dictionaries
                    Each must contain 'trades' key with trade list
            market_returns: Optional market returns for correlation analysis
        
        Returns:
            List of results sorted by composite score (highest first)
        """
        if not results:
            return []
        
        # Calculate comprehensive metrics for each result
        scored_results = []
        
        for result in results:
            trades = result.get('trades', [])
            
            if not trades:
                # Skip results with no trades
                continue
            
            # Calculate all metrics
            institutional = self.institutional_metrics.calculate_all_metrics(trades)
            risk = self.risk_metrics.calculate_all_risk_metrics(trades, market_returns)
            analysis = self.trade_analyzer.analyze_all_trades(trades)
            
            # Calculate normalized scores for each component
            scores = self._calculate_component_scores(institutional, risk, analysis)
            
            # Calculate composite score
            composite = self._calculate_composite_score(scores)
            
            # Add to results
            scored_result = {
                **result,
                'institutional_metrics': institutional,
                'risk_metrics': risk,
                'trade_analysis': analysis,
                'component_scores': scores,
                'composite_score': composite,
                'rank': 0  # Will be filled after sorting
            }
            
            scored_results.append(scored_result)
        
        # Sort by composite score (highest first)
        scored_results.sort(key=lambda x: x['composite_score'], reverse=True)
        
        # Assign ranks
        for idx, result in enumerate(scored_results, 1):
            result['rank'] = idx
        
        return scored_results
    
    def _calculate_component_scores(self,
                                    institutional: Dict,
                                    risk: Dict,
                                    analysis: Dict) -> Dict:
        """
        Calculate normalized scores for each component (0-100 scale)
        
        Higher is better for all scores
        """
        scores = {}
        
        # Sharpe Ratio (target: 2.0+)
        sharpe = institutional.get('sharpe_ratio', Decimal('0'))
        scores['sharpe_ratio'] = self._normalize_sharpe(sharpe)
        
        # Sortino Ratio (target: 2.5+)
        sortino = institutional.get('sortino_ratio', Decimal('0'))
        scores['sortino_ratio'] = self._normalize_sortino(sortino)
        
        # Calmar Ratio (target: 3.0+)
        calmar = institutional.get('calmar_ratio', Decimal('0'))
        scores['calmar_ratio'] = self._normalize_calmar(calmar)
        
        # Win Rate (target: 60%+)
        win_rate = institutional.get('win_rate', Decimal('0'))
        scores['win_rate'] = self._normalize_win_rate(win_rate)
        
        # Profit Factor (target: 2.0+)
        profit_factor = institutional.get('profit_factor', Decimal('0'))
        scores['profit_factor'] = self._normalize_profit_factor(profit_factor)
        
        # Max Drawdown (lower is better - target: <10%)
        max_dd_pct = institutional.get('max_drawdown_percent', Decimal('0'))
        scores['max_drawdown'] = self._normalize_drawdown(max_dd_pct)
        
        # Capital Efficiency (target: 0.8+)
        cap_efficiency = institutional.get('capital_efficiency', Decimal('0'))
        scores['capital_efficiency'] = self._normalize_capital_efficiency(cap_efficiency)
        
        # Trade Quality (composite of entry/exit efficiency)
        quality_metrics = analysis.get('quality_metrics', {})
        entry_eff = quality_metrics.get('entry_efficiency', Decimal('0'))
        exit_eff = quality_metrics.get('exit_efficiency', Decimal('0'))
        trade_quality = (entry_eff + exit_eff) / Decimal('2')
        scores['trade_quality'] = self._normalize_trade_quality(trade_quality)
        
        return scores
    
    def _calculate_composite_score(self, scores: Dict) -> Decimal:
        """
        Calculate weighted composite score
        
        Returns score on 0-100 scale
        """
        composite = Decimal('0')
        
        for component, weight in self.weights.items():
            component_score = scores.get(component, Decimal('0'))
            composite += component_score * weight
        
        return composite
    
    # ==================== Normalization Functions ====================
    # All normalization functions return 0-100 scale where higher is better
    
    def _normalize_sharpe(self, sharpe: Decimal) -> Decimal:
        """
        Normalize Sharpe ratio to 0-100 scale
        
        0 = 0, 2.0 = 100, linear interpolation
        """
        if sharpe <= Decimal('0'):
            return Decimal('0')
        if sharpe >= Decimal('2.0'):
            return Decimal('100')
        
        return (sharpe / Decimal('2.0')) * Decimal('100')
    
    def _normalize_sortino(self, sortino: Decimal) -> Decimal:
        """
        Normalize Sortino ratio to 0-100 scale
        
        0 = 0, 2.5 = 100, linear interpolation
        """
        if sortino <= Decimal('0'):
            return Decimal('0')
        if sortino >= Decimal('2.5'):
            return Decimal('100')
        
        return (sortino / Decimal('2.5')) * Decimal('100')
    
    def _normalize_calmar(self, calmar: Decimal) -> Decimal:
        """
        Normalize Calmar ratio to 0-100 scale
        
        0 = 0, 3.0 = 100, linear interpolation
        """
        if calmar <= Decimal('0'):
            return Decimal('0')
        if calmar >= Decimal('3.0'):
            return Decimal('100')
        
        return (calmar / Decimal('3.0')) * Decimal('100')
    
    def _normalize_win_rate(self, win_rate: Decimal) -> Decimal:
        """
        Normalize win rate to 0-100 scale
        
        0% = 0, 60%+ = 100, linear below 60%
        """
        if win_rate <= Decimal('0'):
            return Decimal('0')
        if win_rate >= Decimal('0.6'):
            return Decimal('100')
        
        return (win_rate / Decimal('0.6')) * Decimal('100')
    
    def _normalize_profit_factor(self, profit_factor: Decimal) -> Decimal:
        """
        Normalize profit factor to 0-100 scale
        
        1.0 = 0, 2.0+ = 100, linear interpolation
        """
        if profit_factor <= Decimal('1.0'):
            return Decimal('0')
        if profit_factor >= Decimal('2.0'):
            return Decimal('100')
        
        return ((profit_factor - Decimal('1.0')) / Decimal('1.0')) * Decimal('100')
    
    def _normalize_drawdown(self, drawdown_pct: Decimal) -> Decimal:
        """
        Normalize drawdown to 0-100 scale (inverted - lower DD is better)
        
        20%+ = 0, 0% = 100, linear interpolation
        """
        if drawdown_pct >= Decimal('0.2'):
            return Decimal('0')
        if drawdown_pct <= Decimal('0'):
            return Decimal('100')
        
        # Invert: lower drawdown = higher score
        normalized = Decimal('1') - (drawdown_pct / Decimal('0.2'))
        return normalized * Decimal('100')
    
    def _normalize_capital_efficiency(self, efficiency: Decimal) -> Decimal:
        """
        Normalize capital efficiency to 0-100 scale
        
        0 = 0, 0.8+ = 100, linear interpolation
        """
        if efficiency <= Decimal('0'):
            return Decimal('0')
        if efficiency >= Decimal('0.8'):
            return Decimal('100')
        
        return (efficiency / Decimal('0.8')) * Decimal('100')
    
    def _normalize_trade_quality(self, quality: Decimal) -> Decimal:
        """
        Normalize trade quality to 0-100 scale
        
        0 = 0, 0.8+ = 100, linear interpolation
        """
        if quality <= Decimal('0'):
            return Decimal('0')
        if quality >= Decimal('0.8'):
            return Decimal('100')
        
        return (quality / Decimal('0.8')) * Decimal('100')
    
    # ==================== Ranking Analysis ====================
    
    def get_ranking_summary(self, ranked_results: List[Dict]) -> Dict:
        """
        Get summary statistics of ranking
        
        Returns statistics about the ranking distribution
        """
        if not ranked_results:
            return {
                'total_results': 0,
                'error': 'No ranked results'
            }
        
        # Extract composite scores
        scores = [r['composite_score'] for r in ranked_results]
        
        # Top result
        top_result = ranked_results[0]
        
        # Score distribution
        score_ranges = {
            'excellent': 0,   # 80-100
            'good': 0,        # 60-80
            'average': 0,     # 40-60
            'poor': 0,        # 20-40
            'very_poor': 0    # 0-20
        }
        
        for score in scores:
            if score >= Decimal('80'):
                score_ranges['excellent'] += 1
            elif score >= Decimal('60'):
                score_ranges['good'] += 1
            elif score >= Decimal('40'):
                score_ranges['average'] += 1
            elif score >= Decimal('20'):
                score_ranges['poor'] += 1
            else:
                score_ranges['very_poor'] += 1
        
        return {
            'total_results': len(ranked_results),
            'top_score': top_result['composite_score'],
            'top_config': top_result.get('config_id', 'Unknown'),
            'median_score': scores[len(scores) // 2] if scores else Decimal('0'),
            'min_score': min(scores) if scores else Decimal('0'),
            'max_score': max(scores) if scores else Decimal('0'),
            'score_distribution': score_ranges,
            'top_3_ids': [r.get('config_id', f'Result_{r["rank"]}') 
                         for r in ranked_results[:3]]
        }
    
    def compare_top_results(self, ranked_results: List[Dict], top_n: int = 3) -> Dict:
        """
        Compare top N results
        
        Returns detailed comparison of top performers
        """
        if not ranked_results or top_n <= 0:
            return {'error': 'Invalid input'}
        
        top_results = ranked_results[:min(top_n, len(ranked_results))]
        
        comparisons = []
        
        for result in top_results:
            inst_metrics = result.get('institutional_metrics', {})
            scores = result.get('component_scores', {})
            
            comparisons.append({
                'rank': result['rank'],
                'config_id': result.get('config_id', f'Result_{result["rank"]}'),
                'composite_score': result['composite_score'],
                'sharpe_ratio': inst_metrics.get('sharpe_ratio', Decimal('0')),
                'sortino_ratio': inst_metrics.get('sortino_ratio', Decimal('0')),
                'win_rate': inst_metrics.get('win_rate', Decimal('0')),
                'profit_factor': inst_metrics.get('profit_factor', Decimal('0')),
                'max_drawdown_pct': inst_metrics.get('max_drawdown_percent', Decimal('0')),
                'total_trades': inst_metrics.get('total_trades', 0),
                'component_scores': scores
            })
        
        return {
            'top_n': len(comparisons),
            'comparisons': comparisons,
            'winner': comparisons[0] if comparisons else None
        }
    
    def get_strength_weaknesses(self, result: Dict) -> Dict:
        """
        Identify strengths and weaknesses of a result
        
        Returns analysis of which components are strong/weak
        """
        scores = result.get('component_scores', {})
        
        strengths = []
        weaknesses = []
        
        for component, score in scores.items():
            if score >= Decimal('80'):
                strengths.append({
                    'component': component,
                    'score': score,
                    'rating': 'Excellent'
                })
            elif score <= Decimal('40'):
                weaknesses.append({
                    'component': component,
                    'score': score,
                    'rating': 'Needs Improvement'
                })
        
        # Sort by score
        strengths.sort(key=lambda x: x['score'], reverse=True)
        weaknesses.sort(key=lambda x: x['score'])
        
        return {
            'rank': result.get('rank', 0),
            'composite_score': result.get('composite_score', Decimal('0')),
            'strengths': strengths,
            'weaknesses': weaknesses,
            'overall_rating': self._get_overall_rating(result.get('composite_score', Decimal('0')))
        }
    
    def _get_overall_rating(self, composite_score: Decimal) -> str:
        """Get overall rating based on composite score"""
        if composite_score >= Decimal('80'):
            return 'Excellent'
        elif composite_score >= Decimal('60'):
            return 'Good'
        elif composite_score >= Decimal('40'):
            return 'Average'
        elif composite_score >= Decimal('20'):
            return 'Poor'
        else:
            return 'Very Poor'
    
    # ==================== Filtering & Selection ====================
    
    def filter_by_minimum_score(self, 
                                ranked_results: List[Dict],
                                min_score: Decimal) -> List[Dict]:
        """Filter results by minimum composite score"""
        return [r for r in ranked_results if r['composite_score'] >= min_score]
    
    def filter_by_minimum_trades(self,
                                ranked_results: List[Dict],
                                min_trades: int) -> List[Dict]:
        """Filter results by minimum number of trades"""
        return [
            r for r in ranked_results 
            if r.get('institutional_metrics', {}).get('total_trades', 0) >= min_trades
        ]
    
    def filter_by_sharpe(self,
                        ranked_results: List[Dict],
                        min_sharpe: Decimal) -> List[Dict]:
        """Filter results by minimum Sharpe ratio"""
        return [
            r for r in ranked_results
            if r.get('institutional_metrics', {}).get('sharpe_ratio', Decimal('0')) >= min_sharpe
        ]
    
    def filter_by_drawdown(self,
                          ranked_results: List[Dict],
                          max_drawdown_pct: Decimal) -> List[Dict]:
        """Filter results by maximum drawdown percentage"""
        return [
            r for r in ranked_results
            if r.get('institutional_metrics', {}).get('max_drawdown_percent', Decimal('1')) <= max_drawdown_pct
        ]
