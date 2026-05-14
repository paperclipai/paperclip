"""
Statistical Comparison System
Task 1.3.6: Compare optimization results with statistical significance testing

Uses:
- T-tests for mean comparisons
- Mann-Whitney U test for non-parametric comparisons
- Bootstrap confidence intervals
- Effect size calculations
"""

from decimal import Decimal
from typing import List, Dict, Tuple, Optional
import numpy as np
from scipy import stats
from nautilus_trader.model.objects import Money
from nautilus_trader.model.currencies import USD
from dotenv import load_dotenv
import os


class StatisticalComparison:
    """
    Perform statistical comparisons between optimization results
    
    Tests statistical significance of performance differences
    """
    
    def __init__(self):
        """Initialize statistical comparison with configuration"""
        load_dotenv()
        
        self.config = {
            'significance_level': float(os.getenv('STATS_SIGNIFICANCE_LEVEL', '0.05')),
            'power_level': float(os.getenv('STATS_POWER_LEVEL', '0.8')),
            'min_effect_size': float(os.getenv('STATS_MIN_EFFECT_SIZE', '0.2')),
            'bootstrap_samples': int(os.getenv('STATS_BOOTSTRAP_SAMPLES', '10000'))
        }
    
    def compare_two_results(self,
                          result_a: Dict,
                          result_b: Dict,
                          metric: str = 'returns') -> Dict:
        """
        Compare two optimization results statistically
        
        Args:
            result_a: First result with trades
            result_b: Second result with trades
            metric: Metric to compare ('returns', 'pnl', 'sharpe')
        
        Returns:
            Dictionary with comparison statistics
        """
        trades_a = result_a.get('trades', [])
        trades_b = result_b.get('trades', [])
        
        if not trades_a or not trades_b:
            return {
                'error': 'Insufficient data for comparison',
                'result_a_trades': len(trades_a),
                'result_b_trades': len(trades_b)
            }
        
        # Extract metric values
        values_a = self._extract_metric_values(trades_a, metric)
        values_b = self._extract_metric_values(trades_b, metric)
        
        # Perform tests
        t_test = self._perform_t_test(values_a, values_b)
        mann_whitney = self._perform_mann_whitney(values_a, values_b)
        effect_size = self._calculate_effect_size(values_a, values_b)
        bootstrap_ci = self._bootstrap_confidence_interval(values_a, values_b)
        
        # Determine winner
        winner = self._determine_winner(values_a, values_b, t_test, mann_whitney)
        
        return {
            'metric': metric,
            'result_a': {
                'n_trades': len(trades_a),
                'mean': Decimal(str(np.mean(values_a))),
                'std': Decimal(str(np.std(values_a, ddof=1))),
                'median': Decimal(str(np.median(values_a)))
            },
            'result_b': {
                'n_trades': len(trades_b),
                'mean': Decimal(str(np.mean(values_b))),
                'std': Decimal(str(np.std(values_b, ddof=1))),
                'median': Decimal(str(np.median(values_b)))
            },
            't_test': t_test,
            'mann_whitney': mann_whitney,
            'effect_size': effect_size,
            'bootstrap_ci': bootstrap_ci,
            'winner': winner,
            'statistically_significant': t_test['significant'] or mann_whitney['significant']
        }
    
    def compare_multiple_results(self,
                                results: List[Dict],
                                metric: str = 'returns') -> Dict:
        """
        Compare multiple optimization results using ANOVA
        
        Args:
            results: List of results with trades
            metric: Metric to compare
        
        Returns:
            Dictionary with ANOVA results and pairwise comparisons
        """
        if len(results) < 2:
            return {
                'error': 'Need at least 2 results for comparison',
                'n_results': len(results)
            }
        
        # Extract metric values for all results
        all_values = []
        for result in results:
            trades = result.get('trades', [])
            if trades:
                values = self._extract_metric_values(trades, metric)
                all_values.append(values)
        
        if len(all_values) < 2:
            return {
                'error': 'Insufficient data across results',
                'valid_results': len(all_values)
            }
        
        # Perform ANOVA
        anova_result = self._perform_anova(all_values)
        
        # Perform pairwise comparisons if ANOVA is significant
        pairwise = None
        if anova_result['significant']:
            pairwise = self._pairwise_comparisons(all_values)
        
        # Summary statistics
        summary = []
        for i, values in enumerate(all_values):
            summary.append({
                'result_index': i,
                'n_trades': len(values),
                'mean': Decimal(str(np.mean(values))),
                'std': Decimal(str(np.std(values, ddof=1))),
                'median': Decimal(str(np.median(values)))
            })
        
        return {
            'metric': metric,
            'n_results': len(all_values),
            'anova': anova_result,
            'pairwise_comparisons': pairwise,
            'summary_statistics': summary
        }
    
    # ==================== Statistical Tests ====================
    
    def _perform_t_test(self, 
                       values_a: np.ndarray,
                       values_b: np.ndarray) -> Dict:
        """
        Perform independent samples t-test
        
        Tests if means are significantly different
        """
        try:
            statistic, p_value = stats.ttest_ind(values_a, values_b)
            
            return {
                'test': 't-test',
                'statistic': float(statistic),
                'p_value': float(p_value),
                'significant': p_value < self.config['significance_level'],
                'alpha': self.config['significance_level']
            }
        except Exception as e:
            return {
                'test': 't-test',
                'error': str(e),
                'significant': False
            }
    
    def _perform_mann_whitney(self,
                             values_a: np.ndarray,
                             values_b: np.ndarray) -> Dict:
        """
        Perform Mann-Whitney U test
        
        Non-parametric test for median differences
        """
        try:
            statistic, p_value = stats.mannwhitneyu(values_a, values_b, alternative='two-sided')
            
            return {
                'test': 'Mann-Whitney U',
                'statistic': float(statistic),
                'p_value': float(p_value),
                'significant': p_value < self.config['significance_level'],
                'alpha': self.config['significance_level']
            }
        except Exception as e:
            return {
                'test': 'Mann-Whitney U',
                'error': str(e),
                'significant': False
            }
    
    def _perform_anova(self, all_values: List[np.ndarray]) -> Dict:
        """
        Perform one-way ANOVA
        
        Tests if means differ across multiple groups
        """
        try:
            statistic, p_value = stats.f_oneway(*all_values)
            
            return {
                'test': 'One-way ANOVA',
                'f_statistic': float(statistic),
                'p_value': float(p_value),
                'significant': p_value < self.config['significance_level'],
                'alpha': self.config['significance_level']
            }
        except Exception as e:
            return {
                'test': 'One-way ANOVA',
                'error': str(e),
                'significant': False
            }
    
    # ==================== Effect Size ====================
    
    def _calculate_effect_size(self,
                              values_a: np.ndarray,
                              values_b: np.ndarray) -> Dict:
        """
        Calculate Cohen's d effect size
        
        Measures magnitude of difference between groups
        """
        try:
            mean_a = np.mean(values_a)
            mean_b = np.mean(values_b)
            std_a = np.std(values_a, ddof=1)
            std_b = np.std(values_b, ddof=1)
            
            # Pooled standard deviation
            n_a = len(values_a)
            n_b = len(values_b)
            pooled_std = np.sqrt(((n_a - 1) * std_a ** 2 + (n_b - 1) * std_b ** 2) / (n_a + n_b - 2))
            
            # Cohen's d
            cohens_d = (mean_a - mean_b) / pooled_std if pooled_std > 0 else 0
            
            # Interpret effect size
            magnitude = self._interpret_effect_size(abs(cohens_d))
            
            return {
                'cohens_d': float(cohens_d),
                'magnitude': magnitude,
                'meaningful': abs(cohens_d) >= self.config['min_effect_size']
            }
        except Exception as e:
            return {
                'error': str(e),
                'meaningful': False
            }
    
    def _interpret_effect_size(self, d: float) -> str:
        """Interpret Cohen's d effect size"""
        if d < 0.2:
            return 'negligible'
        elif d < 0.5:
            return 'small'
        elif d < 0.8:
            return 'medium'
        else:
            return 'large'
    
    # ==================== Bootstrap ====================
    
    def _bootstrap_confidence_interval(self,
                                      values_a: np.ndarray,
                                      values_b: np.ndarray,
                                      confidence: float = 0.95) -> Dict:
        """
        Calculate bootstrap confidence interval for mean difference
        
        Provides robust CI without normality assumptions
        """
        try:
            np.random.seed(42)  # For reproducibility
            
            n_bootstrap = self.config['bootstrap_samples']
            n_a = len(values_a)
            n_b = len(values_b)
            
            # Bootstrap resampling
            bootstrap_diffs = []
            
            for _ in range(n_bootstrap):
                # Resample with replacement
                sample_a = np.random.choice(values_a, size=n_a, replace=True)
                sample_b = np.random.choice(values_b, size=n_b, replace=True)
                
                # Calculate difference in means
                diff = np.mean(sample_a) - np.mean(sample_b)
                bootstrap_diffs.append(diff)
            
            bootstrap_diffs = np.array(bootstrap_diffs)
            
            # Calculate confidence interval
            alpha = 1 - confidence
            lower = np.percentile(bootstrap_diffs, alpha / 2 * 100)
            upper = np.percentile(bootstrap_diffs, (1 - alpha / 2) * 100)
            
            # Check if CI includes zero
            includes_zero = (lower <= 0 <= upper)
            
            return {
                'method': 'bootstrap',
                'confidence_level': confidence,
                'n_samples': n_bootstrap,
                'mean_difference': float(np.mean(bootstrap_diffs)),
                'ci_lower': float(lower),
                'ci_upper': float(upper),
                'includes_zero': includes_zero,
                'significant': not includes_zero
            }
        except Exception as e:
            return {
                'method': 'bootstrap',
                'error': str(e),
                'significant': False
            }
    
    # ==================== Pairwise Comparisons ====================
    
    def _pairwise_comparisons(self, all_values: List[np.ndarray]) -> List[Dict]:
        """
        Perform pairwise comparisons with Bonferroni correction
        
        Compares all pairs of results
        """
        n_comparisons = len(all_values) * (len(all_values) - 1) // 2
        adjusted_alpha = self.config['significance_level'] / n_comparisons  # Bonferroni
        
        comparisons = []
        
        for i in range(len(all_values)):
            for j in range(i + 1, len(all_values)):
                values_i = all_values[i]
                values_j = all_values[j]
                
                # T-test
                statistic, p_value = stats.ttest_ind(values_i, values_j)
                
                # Effect size
                mean_diff = np.mean(values_i) - np.mean(values_j)
                
                comparisons.append({
                    'pair': (i, j),
                    'result_a_index': i,
                    'result_b_index': j,
                    'mean_difference': float(mean_diff),
                    'p_value': float(p_value),
                    'adjusted_alpha': adjusted_alpha,
                    'significant': p_value < adjusted_alpha
                })
        
        return comparisons
    
    # ==================== Winner Determination ====================
    
    def _determine_winner(self,
                         values_a: np.ndarray,
                         values_b: np.ndarray,
                        t_test: Dict,
                         mann_whitney: Dict) -> Dict:
        """
        Determine which result is better
        
        Considers statistical significance and practical significance
        """
        mean_a = np.mean(values_a)
        mean_b = np.mean(values_b)
        
        # Determine which is better numerically
        if mean_a > mean_b:
            better = 'A'
            difference_pct = ((mean_a - mean_b) / abs(mean_b)) * 100 if mean_b != 0 else float('inf')
        elif mean_b > mean_a:
            better = 'B'
            difference_pct = ((mean_b - mean_a) / abs(mean_a)) * 100 if mean_a != 0 else float('inf')
        else:
            better = 'tie'
            difference_pct = 0
        
        # Check statistical significance
        is_significant = t_test.get('significant', False) or mann_whitney.get('significant', False)
        
        # Determine confidence level
        if is_significant:
            confidence = 'high'
        elif abs(difference_pct) > 10:
            confidence = 'medium'
        else:
            confidence = 'low'
        
        return {
            'winner': better,
            'difference_pct': float(difference_pct),
            'statistically_significant': is_significant,
            'confidence': confidence,
            'recommendation': self._get_recommendation(better, is_significant, difference_pct)
        }
    
    def _get_recommendation(self,
                           winner: str,
                           is_significant: bool,
                           difference_pct: float) -> str:
        """Generate recommendation based on comparison"""
        if winner == 'tie':
            return "Results are equivalent. Either can be used."
        
        if is_significant:
            return f"Result {winner} is statistically superior. Recommend using Result {winner}."
        elif abs(difference_pct) > 10:
            return f"Result {winner} appears better but needs more data for confirmation."
        else:
            return "Differences are marginal. Consider other factors in selection."
    
    # ==================== Helper Methods ====================
    
    def _extract_metric_values(self, trades: List[Dict], metric: str) -> np.ndarray:
        """
        Extract metric values from trades
        
        Args:
            trades: List of trade dictionaries
            metric: Metric to extract ('returns', 'pnl', 'sharpe')
        
        Returns:
            NumPy array of values
        """
        values = []
        
        for trade in trades:
            if metric == 'returns':
                pnl = self._get_trade_pnl(trade)
                capital = self._get_trade_capital(trade)
                capital_val = self._money_to_decimal(capital)
                
                if capital_val > Decimal('0'):
                    pnl_val = self._money_to_decimal(pnl)
                    ret = float(pnl_val / capital_val)
                    values.append(ret)
            
            elif metric == 'pnl':
                pnl = self._get_trade_pnl(trade)
                pnl_val = float(self._money_to_decimal(pnl))
                values.append(pnl_val)
            
            elif metric == 'duration':
                entry_time = trade.get('entry_time')
                exit_time = trade.get('exit_time')
                if entry_time and exit_time:
                    duration = (exit_time - entry_time).total_seconds() / 3600  # hours
                    values.append(duration)
        
        return np.array(values) if values else np.array([0.0])
    
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
    
    def _get_trade_capital(self, trade: Dict) -> Money:
        """Get trade capital"""
        capital = trade.get('capital_start', Money('10000', USD))
        if isinstance(capital, Money):
            return capital
        return Money(str(capital), USD)
