"""
Advanced Risk Metrics Calculator
Task 1.3.2: Advanced risk metrics (VaR, ES, drawdown analysis)
Task 1.3.4: Drawdown calculator

Calculates:
- Value at Risk (Historical, Parametric, Monte Carlo)
- Expected Shortfall
- Comprehensive Drawdown Analysis
- Risk-Adjusted Returns
"""

from decimal import Decimal
from typing import List, Dict, Optional, Tuple
from datetime import datetime, timedelta
import numpy as np
from scipy import stats
from nautilus_trader.model.objects import Money, Quantity, Price
from nautilus_trader.model.currencies import USD
from dotenv import load_dotenv
import os


class RiskMetrics:
    """Calculate advanced risk metrics with multiple methodologies"""
    
    def __init__(self):
        """Initialize risk metrics calculator with configuration"""
        load_dotenv()
        
        self.config = {
            'var_confidence': float(os.getenv('RISK_VAR_CONFIDENCE', '0.99')),
            'var_window': int(os.getenv('RISK_VAR_WINDOW', '10')),
            'es_confidence': float(os.getenv('RISK_ES_CONFIDENCE', '0.975')),
            'monte_carlo_sims': int(os.getenv('RISK_MONTE_CARLO_SIMS', '10000')),
            'drawdown_window': int(os.getenv('RISK_DRAWDOWN_WINDOW', '252')),
            'correlation_window': int(os.getenv('RISK_CORRELATION_WINDOW', '60'))
        }
    
    def calculate_all_risk_metrics(self, 
                                   trades: List[Dict],
                                   market_returns: Optional[List[Decimal]] = None) -> Dict:
        """
        Calculate all risk metrics
        
        Args:
            trades: List of trade dictionaries with NautilusTrader types
            market_returns: Optional market returns for correlation analysis
        
        Returns:
            Dictionary with all risk metrics
        """
        if not trades:
            return self._empty_risk_metrics()
        
        returns = self._calculate_returns(trades)
        
        # VaR calculations
        var_metrics = {
            'historical_var_95': self._calculate_historical_var(returns, 0.95),
            'historical_var_99': self._calculate_historical_var(returns, 0.99),
            'parametric_var_95': self._calculate_parametric_var(returns, 0.95),
            'parametric_var_99': self._calculate_parametric_var(returns, 0.99),
            'monte_carlo_var_95': self._calculate_monte_carlo_var(returns, 0.95),
            'monte_carlo_var_99': self._calculate_monte_carlo_var(returns, 0.99)
        }
        
        # Expected Shortfall
        es_metrics = {
            'historical_es_95': self._calculate_historical_es(returns, 0.95),
            'historical_es_99': self._calculate_historical_es(returns, 0.99),
            'parametric_es_95': self._calculate_parametric_es(returns, 0.95),
            'parametric_es_99': self._calculate_parametric_es(returns, 0.99)
        }
        
        # Drawdown analysis
        drawdown_metrics = self._calculate_comprehensive_drawdowns(trades)
        
        # Risk-adjusted returns
        risk_adjusted = self._calculate_risk_adjusted_returns(trades, returns)
        
        # Market correlation (if market data provided)
        correlation_metrics = {}
        if market_returns:
            correlation_metrics = self._calculate_market_correlation(returns, market_returns)
        
        return {
            **var_metrics,
            **es_metrics,
            **drawdown_metrics,
            **risk_adjusted,
            **correlation_metrics
        }
    
    # ==================== VaR Calculations ====================
    
    def _calculate_historical_var(self, 
                                  returns: List[Decimal],
                                  confidence: float) -> Money:
        """
        Calculate Historical Value at Risk
        
        Uses actual historical returns distribution
        """
        if not returns or len(returns) < 10:
            return Money('0', USD)
        
        returns_array = np.array([float(r) for r in returns])
        
        # Find percentile
        percentile = (1 - confidence) * 100
        var = np.percentile(returns_array, percentile)
        
        return Money(str(abs(var)), USD)
    
    def _calculate_parametric_var(self,
                                  returns: List[Decimal],
                                  confidence: float) -> Money:
        """
        Calculate Parametric Value at Risk
        
        Assumes normal distribution of returns
        """
        if not returns or len(returns) < 10:
            return Money('0', USD)
        
        returns_array = np.array([float(r) for r in returns])
        
        # Calculate mean and std dev
        mean_return = np.mean(returns_array)
        std_dev = np.std(returns_array, ddof=1)
        
        # Z-score for confidence level
        z_score = stats.norm.ppf(1 - confidence)
        
        # VaR = mean + z_score * std_dev
        var = mean_return + z_score * std_dev
        
        return Money(str(abs(var)), USD)
    
    def _calculate_monte_carlo_var(self,
                                   returns: List[Decimal],
                                   confidence: float) -> Money:
        """
        Calculate Monte Carlo Value at Risk
        
        Uses Monte Carlo simulation with historical parameters
        """
        if not returns or len(returns) < 10:
            return Money('0', USD)
        
        returns_array = np.array([float(r) for r in returns])
        
        # Calculate parameters from historical data
        mean_return = np.mean(returns_array)
        std_dev = np.std(returns_array, ddof=1)
        
        # Run Monte Carlo simulations
        np.random.seed(42)  # For reproducibility
        simulated_returns = np.random.normal(
            mean_return,
            std_dev,
            self.config['monte_carlo_sims']
        )
        
        # Calculate VaR from simulated returns
        percentile = (1 - confidence) * 100
        var = np.percentile(simulated_returns, percentile)
        
        return Money(str(abs(var)), USD)
    
    # ==================== Expected Shortfall ====================
    
    def _calculate_historical_es(self,
                                 returns: List[Decimal],
                                 confidence: float) -> Money:
        """
        Calculate Historical Expected Shortfall (Conditional VaR)
        
        Average of losses beyond VaR threshold
        """
        if not returns or len(returns) < 10:
            return Money('0', USD)
        
        returns_array = np.array([float(r) for r in returns])
        
        # Find VaR threshold
        percentile = (1 - confidence) * 100
        var_threshold = np.percentile(returns_array, percentile)
        
        # Calculate average of losses beyond VaR
        tail_losses = returns_array[returns_array <= var_threshold]
        
        if len(tail_losses) == 0:
            return Money('0', USD)
        
        es = np.mean(tail_losses)
        
        return Money(str(abs(es)), USD)
    
    def _calculate_parametric_es(self,
                                 returns: List[Decimal],
                                 confidence: float) -> Money:
        """
        Calculate Parametric Expected Shortfall
        
        Uses normal distribution assumption
        """
        if not returns or len(returns) < 10:
            return Money('0', USD)
        
        returns_array = np.array([float(r) for r in returns])
        
        # Calculate parameters
        mean_return = np.mean(returns_array)
        std_dev = np.std(returns_array, ddof=1)
        
        # Z-score for confidence level
        z_score = stats.norm.ppf(1 - confidence)
        
        # ES = mean - std_dev * pdf(z) / (1 - confidence)
        pdf_z = stats.norm.pdf(z_score)
        es = mean_return - std_dev * pdf_z / (1 - confidence)
        
        return Money(str(abs(es)), USD)
    
    # ==================== Drawdown Analysis ====================
    
    def _calculate_comprehensive_drawdowns(self, trades: List[Dict]) -> Dict:
        """
        Calculate comprehensive drawdown metrics
        
        Returns all drawdown-related statistics
        """
        if not trades:
            return {}
        
        # Build equity curve
        equity_curve = self._build_equity_curve(trades)
        
        # Calculate all drawdown periods
        drawdown_periods = self._identify_drawdown_periods(equity_curve)
        
        # Maximum drawdown
        max_dd = self._calculate_max_drawdown_from_equity(equity_curve)
        
        # Average drawdown
        avg_dd = self._calculate_average_drawdown_from_periods(drawdown_periods)
        
        # Drawdown duration
        max_dd_duration = self._calculate_max_drawdown_duration_from_periods(drawdown_periods)
        avg_dd_duration = self._calculate_avg_drawdown_duration_from_periods(drawdown_periods)
        
        # Recovery periods
        recovery_stats = self._calculate_recovery_periods(drawdown_periods, equity_curve)
        
        # Underwater periods
        underwater_stats = self._calculate_underwater_periods(equity_curve)
        
        # Drawdown distribution
        dd_distribution = self._calculate_drawdown_distribution(drawdown_periods)
        
        return {
            'max_drawdown_money': Money(str(max_dd['amount']), USD),
            'max_drawdown_percent': Decimal(str(max_dd['percent'])),
            'max_drawdown_duration': max_dd['duration'],
            'average_drawdown_money': Money(str(avg_dd['amount']), USD),
            'average_drawdown_percent': Decimal(str(avg_dd['percent'])),
            'average_drawdown_duration': avg_dd_duration,
            'total_drawdown_periods': len(drawdown_periods),
            'average_recovery_time': recovery_stats['avg_recovery'],
            'max_recovery_time': recovery_stats['max_recovery'],
            'total_underwater_time': underwater_stats['total_time'],
            'underwater_percentage': underwater_stats['percentage'],
            'drawdown_frequency': dd_distribution['frequency'],
            'drawdown_severity_distribution': dd_distribution['severity']
        }
    
    def _build_equity_curve(self, trades: List[Dict]) -> List[Tuple[datetime, Decimal]]:
        """Build equity curve with timestamps"""
        if not trades:
            return []
        
        equity_curve = []
        
        # Initial equity
        initial_capital = self._get_trade_capital_start(trades[0])
        initial_value = self._money_to_decimal(initial_capital)
        initial_time = trades[0].get('entry_time', datetime.now())
        
        equity_curve.append((initial_time, initial_value))
        current_equity = initial_value
        
        # Add each trade result
        for trade in trades:
            pnl = self._money_to_decimal(self._get_trade_pnl(trade))
            current_equity += pnl
            exit_time = trade.get('exit_time', datetime.now())
            equity_curve.append((exit_time, current_equity))
        
        return equity_curve
    
    def _identify_drawdown_periods(self, 
                                   equity_curve: List[Tuple[datetime, Decimal]]) -> List[Dict]:
        """Identify all drawdown periods"""
        drawdown_periods = []
        
        if not equity_curve:
            return drawdown_periods
        
        peak_time, peak_value = equity_curve[0]
        in_drawdown = False
        dd_start_time = None
        dd_start_value = None
        
        for timestamp, value in equity_curve[1:]:
            if value > peak_value:
                # New peak - end any existing drawdown
                if in_drawdown:
                    drawdown_periods.append({
                        'start_time': dd_start_time,
                        'start_value': dd_start_value,
                        'trough_time': timestamp,
                        'trough_value': peak_value - (peak_value - value),
                        'end_time': timestamp,
                        'end_value': value,
                        'peak_value': dd_start_value,
                        'amount': dd_start_value - (dd_start_value - (peak_value - (peak_value - value))),
                        'percent': (dd_start_value - (dd_start_value - (peak_value - (peak_value - value)))) / dd_start_value
                    })
                    in_drawdown = False
                
                peak_time = timestamp
                peak_value = value
            
            elif value < peak_value:
                if not in_drawdown:
                    # Start of new drawdown
                    in_drawdown = True
                    dd_start_time = peak_time
                    dd_start_value = peak_value
        
        # Handle ongoing drawdown at end
        if in_drawdown:
            final_time, final_value = equity_curve[-1]
            drawdown_periods.append({
                'start_time': dd_start_time,
                'start_value': dd_start_value,
                'trough_time': final_time,
                'trough_value': final_value,
                'end_time': None,  # Ongoing
                'end_value': None,
                'peak_value': dd_start_value,
                'amount': dd_start_value - final_value,
                'percent': (dd_start_value - final_value) / dd_start_value if dd_start_value > 0 else Decimal('0')
            })
        
        return drawdown_periods
    
    def _calculate_max_drawdown_from_equity(self, 
                                            equity_curve: List[Tuple[datetime, Decimal]]) -> Dict:
        """Calculate maximum drawdown from equity curve"""
        if not equity_curve:
            return {'amount': Decimal('0'), 'percent': Decimal('0'), 'duration': timedelta()}
        
        max_dd = Decimal('0')
        max_dd_pct = Decimal('0')
        max_dd_duration = timedelta()
        
        peak_time, peak_value = equity_curve[0]
        dd_start_time = peak_time
        
        for timestamp, value in equity_curve[1:]:
            if value > peak_value:
                peak_time = timestamp
                peak_value = value
                dd_start_time = timestamp
            else:
                dd = peak_value - value
                if dd > max_dd:
                    max_dd = dd
                    max_dd_duration = timestamp - dd_start_time
                
                if peak_value > 0:
                    dd_pct = dd / peak_value
                    if dd_pct > max_dd_pct:
                        max_dd_pct = dd_pct
        
        return {
            'amount': max_dd,
            'percent': max_dd_pct,
            'duration': max_dd_duration
        }
    
    def _calculate_average_drawdown_from_periods(self, drawdown_periods: List[Dict]) -> Dict:
        """Calculate average drawdown from periods"""
        if not drawdown_periods:
            return {'amount': Decimal('0'), 'percent': Decimal('0')}
        
        total_amount = sum(dd['amount'] for dd in drawdown_periods)
        total_pct = sum(dd['percent'] for dd in drawdown_periods)
        
        return {
            'amount': total_amount / Decimal(len(drawdown_periods)),
            'percent': total_pct / Decimal(len(drawdown_periods))
        }
    
    def _calculate_max_drawdown_duration_from_periods(self, 
                                                      drawdown_periods: List[Dict]) -> timedelta:
        """Calculate maximum drawdown duration"""
        if not drawdown_periods:
            return timedelta()
        
        max_duration = timedelta()
        
        for dd in drawdown_periods:
            if dd['end_time']:
                duration = dd['end_time'] - dd['start_time']
                if duration > max_duration:
                    max_duration = duration
        
        return max_duration
    
    def _calculate_avg_drawdown_duration_from_periods(self,
                                                      drawdown_periods: List[Dict]) -> timedelta:
        """Calculate average drawdown duration"""
        if not drawdown_periods:
            return timedelta()
        
        total_duration = timedelta()
        completed_periods = 0
        
        for dd in drawdown_periods:
            if dd['end_time']:
                duration = dd['end_time'] - dd['start_time']
                total_duration += duration
                completed_periods += 1
        
        if completed_periods == 0:
            return timedelta()
        
        return total_duration / completed_periods
    
    def _calculate_recovery_periods(self,
                                   drawdown_periods: List[Dict],
                                   equity_curve: List[Tuple[datetime, Decimal]]) -> Dict:
        """Calculate recovery period statistics"""
        recovery_times = []
        
        for dd in drawdown_periods:
            if dd['end_time']:
                recovery_time = dd['end_time'] - dd['start_time']
                recovery_times.append(recovery_time)
        
        if not recovery_times:
            return {
                'avg_recovery': timedelta(),
                'max_recovery': timedelta()
            }
        
        return {
            'avg_recovery': sum(recovery_times, timedelta()) / len(recovery_times),
            'max_recovery': max(recovery_times)
        }
    
    def _calculate_underwater_periods(self,
                                     equity_curve: List[Tuple[datetime, Decimal]]) -> Dict:
        """Calculate underwater (below peak) statistics"""
        if not equity_curve:
            return {'total_time': timedelta(), 'percentage': Decimal('0')}
        
        total_time = timedelta()
        underwater_time = timedelta()
        
        peak_value = equity_curve[0][1]
        last_time = equity_curve[0][0]
        was_underwater = False
        underwater_start = None
        
        for timestamp, value in equity_curve[1:]:
            time_diff = timestamp - last_time
            total_time += time_diff
            
            if value >= peak_value:
                # At or above peak
                if was_underwater and underwater_start:
                    underwater_time += timestamp - underwater_start
                    was_underwater = False
                peak_value = value
            else:
                # Below peak (underwater)
                if not was_underwater:
                    underwater_start = last_time
                    was_underwater = True
            
            last_time = timestamp
        
        # Handle ongoing underwater at end
        if was_underwater and underwater_start:
            underwater_time += equity_curve[-1][0] - underwater_start
        
        percentage = (underwater_time / total_time) if total_time.total_seconds() > 0 else Decimal('0')
        
        return {
            'total_time': underwater_time,
            'percentage': Decimal(str(percentage))
        }
    
    def _calculate_drawdown_distribution(self, drawdown_periods: List[Dict]) -> Dict:
        """Calculate drawdown distribution statistics"""
        if not drawdown_periods:
            return {
                'frequency': 0,
                'severity': {}
            }
        
        # Severity buckets
        severity_buckets = {
            'minor': 0,      # < 5%
            'moderate': 0,   # 5-10%
            'significant': 0, # 10-20%
            'severe': 0,      # > 20%
        }
        
        for dd in drawdown_periods:
            pct = float(dd['percent'])
            
            if pct < 0.05:
                severity_buckets['minor'] += 1
            elif pct < 0.10:
                severity_buckets['moderate'] += 1
            elif pct < 0.20:
                severity_buckets['significant'] += 1
            else:
                severity_buckets['severe'] += 1
        
        return {
            'frequency': len(drawdown_periods),
            'severity': severity_buckets
        }
    
    # ==================== Risk-Adjusted Returns ====================
    
    def _calculate_risk_adjusted_returns(self, 
                                        trades: List[Dict],
                                        returns: List[Decimal]) -> Dict:
        """Calculate risk-adjusted return metrics"""
        if not returns:
            return {}
        
        returns_array = np.array([float(r) for r in returns])
        
        # Mean return
        mean_return = Decimal(str(np.mean(returns_array)))
        
        # Volatility
        volatility = Decimal(str(np.std(returns_array, ddof=1)))
        
        # Downside deviation
        downside_returns = returns_array[returns_array < 0]
        downside_deviation = Decimal('0')
        if len(downside_returns) > 0:
            downside_deviation = Decimal(str(np.sqrt(np.mean(downside_returns ** 2))))
        
        # Risk-adjusted return
        risk_adjusted_return = mean_return / volatility if volatility > 0 else Decimal('0')
        
        # Upside potential ratio
        upside_returns = returns_array[returns_array > 0]
        upside_potential = Decimal('0')
        if len(upside_returns) > 0 and downside_deviation > 0:
            upside_mean = Decimal(str(np.mean(upside_returns)))
            upside_potential = upside_mean / downside_deviation
        
        return {
            'mean_return': mean_return,
            'volatility': volatility,
            'downside_deviation': downside_deviation,
            'risk_adjusted_return': risk_adjusted_return,
            'upside_potential_ratio': upside_potential
        }
    
    # ==================== Market Correlation ====================
    
    def _calculate_market_correlation(self,
                                     strategy_returns: List[Decimal],
                                     market_returns: List[Decimal]) -> Dict:
        """Calculate correlation with market"""
        if not strategy_returns or not market_returns:
            return {}
        
        # Align returns (use minimum length)
        min_len = min(len(strategy_returns), len(market_returns))
        strat_array = np.array([float(r) for r in strategy_returns[:min_len]])
        market_array = np.array([float(r) for r in market_returns[:min_len]])
        
        # Correlation coefficient
        correlation = np.corrcoef(strat_array, market_array)[0, 1]
        
        # Beta calculation
        covariance = np.cov(strat_array, market_array)[0, 1]
        market_variance = np.var(market_array, ddof=1)
        beta = covariance / market_variance if market_variance > 0 else 0
        
        return {
            'market_correlation': Decimal(str(round(correlation, 4))),
            'beta': Decimal(str(round(beta, 4)))
        }
    
    # ==================== Helper Methods ====================
    
    def _calculate_returns(self, trades: List[Dict]) -> List[Decimal]:
        """Calculate trade returns"""
        returns = []
        
        for trade in trades:
            pnl = self._get_trade_pnl(trade)
            capital = self._get_trade_capital_start(trade)
            
            pnl_value = self._money_to_decimal(pnl)
            capital_value = self._money_to_decimal(capital)
            
            if capital_value > Decimal('0'):
                trade_return = pnl_value / capital_value
                returns.append(trade_return)
        
        return returns
    
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
    
    def _get_trade_capital_start(self, trade: Dict) -> Money:
        """Get trade starting capital"""
        capital = trade.get('capital_start', Money('10000', USD))
        if isinstance(capital, Money):
            return capital
        return Money(str(capital), USD)
    
    def _empty_risk_metrics(self) -> Dict:
        """Return empty risk metrics"""
        return {
            'error': 'No trades available for risk analysis'
        }
