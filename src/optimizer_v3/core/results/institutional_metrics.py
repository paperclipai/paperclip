"""
Institutional-Grade Performance Metrics Calculator
Task 1.3.1: Multi-objective scoring with comprehensive institutional metrics

Calculates:
- Core Performance Metrics (Sharpe, Sortino, Calmar, etc.)
- Risk Metrics
- Trade Metrics
- Capital Metrics
"""

from decimal import Decimal
from typing import List, Dict, Optional
from datetime import datetime, timedelta
import numpy as np
from nautilus_trader.model.objects import Money, Quantity, Price
from nautilus_trader.model.currencies import USD
from nautilus_trader.model.identifiers import TradeId
from dotenv import load_dotenv
import os


class InstitutionalMetrics:
    """Calculate institutional-grade performance metrics"""
    
    def __init__(self):
        """Initialize metrics calculator with configuration"""
        load_dotenv()
        
        self.config = {
            'sharpe_window': int(os.getenv('METRICS_SHARPE_WINDOW', '252')),
            'sortino_window': int(os.getenv('METRICS_SORTINO_WINDOW', '252')),
            'calmar_window': int(os.getenv('METRICS_CALMAR_WINDOW', '252')),
            'min_trades': int(os.getenv('METRICS_MIN_TRADES', '30')),
            'confidence_level': float(os.getenv('METRICS_CONFIDENCE_LEVEL', '0.95')),
            'risk_free_rate': Decimal('0.04')  # 4% annualized
        }
        
        # Trading days per year
        self.trading_days_per_year = 252
    
    def calculate_all_metrics(self, trades: List[Dict]) -> Dict:
        """
        Calculate all institutional metrics
        
        Args:
            trades: List of trade dictionaries with NautilusTrader types
        
        Returns:
            Dictionary with all calculated metrics
        """
        if not trades:
            return self._empty_metrics()
        
        if len(trades) < self.config['min_trades']:
            return self._insufficient_data_metrics(len(trades))
        
        # Calculate all metric categories
        core_metrics = self._calculate_core_metrics(trades)
        risk_metrics = self._calculate_risk_metrics(trades)
        trade_metrics = self._calculate_trade_metrics(trades)
        capital_metrics = self._calculate_capital_metrics(trades)
        
        # Combine all metrics
        return {
            **core_metrics,
            **risk_metrics,
            **trade_metrics,
            **capital_metrics,
            'total_trades': len(trades),
            'trade_sample_sufficient': True
        }
    
    def _calculate_core_metrics(self, trades: List[Dict]) -> Dict:
        """Calculate core performance metrics"""
        returns = self._calculate_returns(trades)
        excess_returns = [r - self.config['risk_free_rate'] / Decimal(self.trading_days_per_year) 
                         for r in returns]
        
        # Sharpe Ratio (annualized)
        sharpe_ratio = self._calculate_sharpe_ratio(returns)
        
        # Sortino Ratio (annualized)
        sortino_ratio = self._calculate_sortino_ratio(returns)
        
        # Calmar Ratio
        calmar_ratio = self._calculate_calmar_ratio(trades, returns)
        
        # Information Ratio
        information_ratio = self._calculate_information_ratio(returns)
        
        # Win Rate
        win_rate = self._calculate_win_rate(trades)
        
        # Profit Factor
        profit_factor = self._calculate_profit_factor(trades)
        
        # Recovery Factor
        recovery_factor = self._calculate_recovery_factor(trades)
        
        return {
            'sharpe_ratio': sharpe_ratio,
            'sortino_ratio': sortino_ratio,
            'calmar_ratio': calmar_ratio,
            'information_ratio': information_ratio,
            'win_rate': win_rate,
            'profit_factor': profit_factor,
            'recovery_factor': recovery_factor,
            'total_return': self._calculate_total_return(trades),
            'annualized_return': self._calculate_annualized_return(trades),
            'volatility': self._calculate_volatility(returns),
            'downside_deviation': self._calculate_downside_deviation(returns)
        }
    
    def _calculate_sharpe_ratio(self, returns: List[Decimal]) -> Decimal:
        """
        Calculate annualized Sharpe ratio
        
        Formula: (Mean Return - Risk Free Rate) / Std Dev of Returns * sqrt(252)
        """
        if not returns or len(returns) < 2:
            return Decimal('0')
        
        returns_array = np.array([float(r) for r in returns])
        risk_free_daily = float(self.config['risk_free_rate']) / self.trading_days_per_year
        
        excess_returns = returns_array - risk_free_daily
        mean_excess = np.mean(excess_returns)
        std_dev = np.std(excess_returns, ddof=1)
        
        if std_dev == 0:
            return Decimal('0')
        
        sharpe = mean_excess / std_dev * np.sqrt(self.trading_days_per_year)
        return Decimal(str(round(sharpe, 4)))
    
    def _calculate_sortino_ratio(self, returns: List[Decimal]) -> Decimal:
        """
        Calculate annualized Sortino ratio
        
        Uses downside deviation instead of total volatility
        """
        if not returns or len(returns) < 2:
            return Decimal('0')
        
        returns_array = np.array([float(r) for r in returns])
        risk_free_daily = float(self.config['risk_free_rate']) / self.trading_days_per_year
        
        excess_returns = returns_array - risk_free_daily
        mean_excess = np.mean(excess_returns)
        
        # Calculate downside deviation (only negative returns)
        downside_returns = excess_returns[excess_returns < 0]
        
        if len(downside_returns) == 0:
            return Decimal('999.99')  # Perfect upside, no downside
        
        downside_dev = np.sqrt(np.mean(downside_returns ** 2))
        
        if downside_dev == 0:
            return Decimal('0')
        
        sortino = mean_excess / downside_dev * np.sqrt(self.trading_days_per_year)
        return Decimal(str(round(sortino, 4)))
    
    def _calculate_calmar_ratio(self, trades: List[Dict], returns: List[Decimal]) -> Decimal:
        """
        Calculate Calmar ratio
        
        Formula: Annualized Return / Maximum Drawdown
        """
        annualized_return = self._calculate_annualized_return(trades)
        max_drawdown = self._calculate_max_drawdown_percent(trades)
        
        if max_drawdown == Decimal('0'):
            return Decimal('999.99')  # No drawdown scenario
        
        calmar = annualized_return / abs(max_drawdown)
        return Decimal(str(round(calmar, 4)))
    
    def _calculate_information_ratio(self, returns: List[Decimal]) -> Decimal:
        """
        Calculate Information ratio
        
        Measures risk-adjusted returns relative to a benchmark (using 0 as benchmark)
        """
        if not returns or len(returns) < 2:
            return Decimal('0')
        
        returns_array = np.array([float(r) for r in returns])
        mean_return = np.mean(returns_array)
        tracking_error = np.std(returns_array, ddof=1)
        
        if tracking_error == 0:
            return Decimal('0')
        
        info_ratio = mean_return / tracking_error * np.sqrt(self.trading_days_per_year)
        return Decimal(str(round(info_ratio, 4)))
    
    def _calculate_win_rate(self, trades: List[Dict]) -> Decimal:
        """Calculate win rate as percentage"""
        if not trades:
            return Decimal('0')
        
        winning_trades = sum(1 for t in trades if self._is_winning_trade(t))
        win_rate = Decimal(winning_trades) / Decimal(len(trades))
        
        return win_rate
    
    def _calculate_profit_factor(self, trades: List[Dict]) -> Decimal:
        """
        Calculate profit factor
        
        Formula: Gross Profits / Gross Losses
        """
        gross_profits = Decimal('0')
        gross_losses = Decimal('0')
        
        for trade in trades:
            pnl = self._get_trade_pnl(trade)
            pnl_value = self._money_to_decimal(pnl)
            
            if pnl_value > 0:
                gross_profits += pnl_value
            else:
                gross_losses += abs(pnl_value)
        
        if gross_losses == Decimal('0'):
            return Decimal('999.99')  # Perfect scenario
        
        return gross_profits / gross_losses
    
    def _calculate_recovery_factor(self, trades: List[Dict]) -> Decimal:
        """
        Calculate recovery factor
        
        Formula: Net Profit / Maximum Drawdown
        """
        total_pnl = sum(
            self._money_to_decimal(self._get_trade_pnl(t)) for t in trades
        )
        max_dd = self._calculate_max_drawdown_money(trades)
        max_dd_value = abs(self._money_to_decimal(max_dd))
        
        if max_dd_value == Decimal('0'):
            return Decimal('999.99')  # No drawdown scenario
        
        return total_pnl / max_dd_value
    
    def _calculate_total_return(self, trades: List[Dict]) -> Decimal:
        """Calculate total return as percentage"""
        if not trades:
            return Decimal('0')
        
        initial_capital = self._get_trade_capital_start(trades[0])
        final_capital = self._get_trade_capital_end(trades[-1])
        
        initial_value = self._money_to_decimal(initial_capital)
        final_value = self._money_to_decimal(final_capital)
        
        if initial_value == Decimal('0'):
            return Decimal('0')
        
        return (final_value - initial_value) / initial_value
    
    def _calculate_annualized_return(self, trades: List[Dict]) -> Decimal:
        """Calculate annualized return"""
        if not trades:
            return Decimal('0')
        
        total_return = self._calculate_total_return(trades)
        
        # Calculate time period in years
        start_time = trades[0].get('entry_time', datetime.now())
        end_time = trades[-1].get('exit_time', datetime.now())
        days = (end_time - start_time).days
        
        if days <= 0:
            return total_return  # Less than a day
        
        years = Decimal(days) / Decimal(365)
        
        # Annualized return = (1 + total_return)^(1/years) - 1
        annualized = (Decimal('1') + total_return) ** (Decimal('1') / years) - Decimal('1')
        
        return annualized
    
    def _calculate_volatility(self, returns: List[Decimal]) -> Decimal:
        """Calculate annualized volatility"""
        if not returns or len(returns) < 2:
            return Decimal('0')
        
        returns_array = np.array([float(r) for r in returns])
        std_dev = np.std(returns_array, ddof=1)
        
        # Annualize
        annualized_vol = std_dev * np.sqrt(self.trading_days_per_year)
        
        return Decimal(str(round(annualized_vol, 4)))
    
    def _calculate_downside_deviation(self, returns: List[Decimal]) -> Decimal:
        """Calculate annualized downside deviation"""
        if not returns:
            return Decimal('0')
        
        returns_array = np.array([float(r) for r in returns])
        downside_returns = returns_array[returns_array < 0]
        
        if len(downside_returns) == 0:
            return Decimal('0')
        
        downside_dev = np.sqrt(np.mean(downside_returns ** 2))
        annualized = downside_dev * np.sqrt(self.trading_days_per_year)
        
        return Decimal(str(round(annualized, 4)))
    
    def _calculate_risk_metrics(self, trades: List[Dict]) -> Dict:
        """Calculate risk-related metrics"""
        return {
            'max_drawdown': self._calculate_max_drawdown_money(trades),
            'max_drawdown_percent': self._calculate_max_drawdown_percent(trades),
            'average_drawdown': self._calculate_average_drawdown(trades),
            'max_drawdown_duration': self._calculate_max_drawdown_duration(trades),
            'max_consecutive_losses': self._calculate_max_consecutive_losses(trades),
            'max_consecutive_wins': self._calculate_max_consecutive_wins(trades)
        }
    
    def _calculate_trade_metrics(self, trades: List[Dict]) -> Dict:
        """Calculate trade-specific metrics"""
        winning_trades = [t for t in trades if self._is_winning_trade(t)]
        losing_trades = [t for t in trades if not self._is_winning_trade(t)]
        
        avg_winner = self._calculate_average_winner(winning_trades) if winning_trades else Money('0', USD)
        avg_loser = self._calculate_average_loser(losing_trades) if losing_trades else Money('0', USD)
        
        return {
            'average_trade_pnl': self._calculate_average_trade_pnl(trades),
            'average_winner': avg_winner,
            'average_loser': avg_loser,
            'largest_winner': self._calculate_largest_winner(trades),
            'largest_loser': self._calculate_largest_loser(trades),
            'average_trade_duration': self._calculate_average_trade_duration(trades),
            'win_loss_ratio': self._calculate_win_loss_ratio(avg_winner, avg_loser)
        }
    
    def _calculate_capital_metrics(self, trades: List[Dict]) -> Dict:
        """Calculate capital utilization metrics"""
        return {
            'capital_efficiency': self._calculate_capital_efficiency(trades),
            'max_capital_usage': self._calculate_max_capital_usage(trades),
            'average_capital_usage': self._calculate_average_capital_usage(trades)
        }
    
    # Helper methods for calculations
    
    def _calculate_returns(self, trades: List[Dict]) -> List[Decimal]:
        """Calculate trade returns as decimals"""
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
    
    def _calculate_max_drawdown_money(self, trades: List[Dict]) -> Money:
        """Calculate maximum drawdown in money terms"""
        if not trades:
            return Money('0', USD)
        
        # Build equity curve
        equity = [self._money_to_decimal(self._get_trade_capital_start(trades[0]))]
        
        for trade in trades:
            pnl = self._money_to_decimal(self._get_trade_pnl(trade))
            equity.append(equity[-1] + pnl)
        
        # Calculate drawdowns
        max_dd = Decimal('0')
        peak = equity[0]
        
        for value in equity:
            if value > peak:
                peak = value
            drawdown = peak - value
            if drawdown > max_dd:
                max_dd = drawdown
        
        return Money(str(max_dd), USD)
    
    def _calculate_max_drawdown_percent(self, trades: List[Dict]) -> Decimal:
        """Calculate maximum drawdown as percentage"""
        if not trades:
            return Decimal('0')
        
        # Build equity curve
        equity = [self._money_to_decimal(self._get_trade_capital_start(trades[0]))]
        
        for trade in trades:
            pnl = self._money_to_decimal(self._get_trade_pnl(trade))
            equity.append(equity[-1] + pnl)
        
        # Calculate percentage drawdowns
        max_dd_pct = Decimal('0')
        peak = equity[0]
        
        for value in equity:
            if value > peak:
                peak = value
            
            if peak > Decimal('0'):
                drawdown_pct = (peak - value) / peak
                if drawdown_pct > max_dd_pct:
                    max_dd_pct = drawdown_pct
        
        return max_dd_pct
    
    def _calculate_average_drawdown(self, trades: List[Dict]) -> Money:
        """Calculate average drawdown"""
        if not trades:
            return Money('0', USD)
        
        # Build equity curve
        equity = [self._money_to_decimal(self._get_trade_capital_start(trades[0]))]
        
        for trade in trades:
            pnl = self._money_to_decimal(self._get_trade_pnl(trade))
            equity.append(equity[-1] + pnl)
        
        # Calculate all drawdowns
        drawdowns = []
        peak = equity[0]
        
        for value in equity:
            if value > peak:
                peak = value
            drawdown = peak - value
            if drawdown > Decimal('0'):
                drawdowns.append(drawdown)
        
        if not drawdowns:
            return Money('0', USD)
        
        avg_dd = sum(drawdowns, Decimal('0')) / Decimal(len(drawdowns))
        return Money(str(avg_dd), USD)
    
    def _calculate_max_drawdown_duration(self, trades: List[Dict]) -> timedelta:
        """Calculate maximum drawdown duration"""
        if not trades:
            return timedelta()
        
        # Build equity curve with timestamps
        equity_curve = [(trades[0].get('entry_time', datetime.now()), 
                        self._money_to_decimal(self._get_trade_capital_start(trades[0])))]
        
        for trade in trades:
            exit_time = trade.get('exit_time', datetime.now())
            pnl = self._money_to_decimal(self._get_trade_pnl(trade))
            new_equity = equity_curve[-1][1] + pnl
            equity_curve.append((exit_time, new_equity))
        
        # Find max drawdown duration
        max_duration = timedelta()
        peak_idx = 0
        peak_value = equity_curve[0][1]
        
        for i, (timestamp, value) in enumerate(equity_curve):
            if value > peak_value:
                peak_value = value
                peak_idx = i
            elif value < peak_value:
                duration = timestamp - equity_curve[peak_idx][0]
                if duration > max_duration:
                    max_duration = duration
        
        return max_duration
    
    def _calculate_max_consecutive_losses(self, trades: List[Dict]) -> int:
        """Calculate maximum consecutive losing trades"""
        if not trades:
            return 0
        
        max_consecutive = 0
        current_consecutive = 0
        
        for trade in trades:
            if not self._is_winning_trade(trade):
                current_consecutive += 1
                max_consecutive = max(max_consecutive, current_consecutive)
            else:
                current_consecutive = 0
        
        return max_consecutive
    
    def _calculate_max_consecutive_wins(self, trades: List[Dict]) -> int:
        """Calculate maximum consecutive winning trades"""
        if not trades:
            return 0
        
        max_consecutive = 0
        current_consecutive = 0
        
        for trade in trades:
            if self._is_winning_trade(trade):
                current_consecutive += 1
                max_consecutive = max(max_consecutive, current_consecutive)
            else:
                current_consecutive = 0
        
        return max_consecutive
    
    def _calculate_average_trade_pnl(self, trades: List[Dict]) -> Money:
        """Calculate average trade PnL"""
        if not trades:
            return Money('0', USD)
        
        total_pnl = sum(
            self._money_to_decimal(self._get_trade_pnl(t)) for t in trades
        )
        avg = total_pnl / Decimal(len(trades))
        
        return Money(str(avg), USD)
    
    def _calculate_average_winner(self, winning_trades: List[Dict]) -> Money:
        """Calculate average winning trade"""
        if not winning_trades:
            return Money('0', USD)
        
        total = sum(
            self._money_to_decimal(self._get_trade_pnl(t)) for t in winning_trades
        )
        avg = total / Decimal(len(winning_trades))
        
        return Money(str(avg), USD)
    
    def _calculate_average_loser(self, losing_trades: List[Dict]) -> Money:
        """Calculate average losing trade"""
        if not losing_trades:
            return Money('0', USD)
        
        total = sum(
            self._money_to_decimal(self._get_trade_pnl(t)) for t in losing_trades
        )
        avg = total / Decimal(len(losing_trades))
        
        return Money(str(avg), USD)
    
    def _calculate_largest_winner(self, trades: List[Dict]) -> Money:
        """Calculate largest winning trade"""
        if not trades:
            return Money('0', USD)
        
        max_pnl = max(
            self._money_to_decimal(self._get_trade_pnl(t)) for t in trades
        )
        
        return Money(str(max_pnl), USD)
    
    def _calculate_largest_loser(self, trades: List[Dict]) -> Money:
        """Calculate largest losing trade"""
        if not trades:
            return Money('0', USD)
        
        min_pnl = min(
            self._money_to_decimal(self._get_trade_pnl(t)) for t in trades
        )
        
        return Money(str(min_pnl), USD)
    
    def _calculate_average_trade_duration(self, trades: List[Dict]) -> timedelta:
        """Calculate average trade duration"""
        if not trades:
            return timedelta()
        
        total_duration = timedelta()
        
        for trade in trades:
            entry_time = trade.get('entry_time', datetime.now())
            exit_time = trade.get('exit_time', datetime.now())
            duration = exit_time - entry_time
            total_duration += duration
        
        return total_duration / len(trades)
    
    def _calculate_win_loss_ratio(self, avg_winner: Money, avg_loser: Money) -> Decimal:
        """Calculate win/loss ratio"""
        winner_value = abs(self._money_to_decimal(avg_winner))
        loser_value = abs(self._money_to_decimal(avg_loser))
        
        if loser_value == Decimal('0'):
            return Decimal('999.99')
        
        return winner_value / loser_value
    
    def _calculate_capital_efficiency(self, trades: List[Dict]) -> Decimal:
        """Calculate capital efficiency"""
        if not trades:
            return Decimal('0')
        
        total_pnl = sum(
            self._money_to_decimal(self._get_trade_pnl(t)) for t in trades
        )
        
        avg_capital = sum(
            self._money_to_decimal(self._get_trade_capital_start(t)) for t in trades
        ) / Decimal(len(trades))
        
        if avg_capital == Decimal('0'):
            return Decimal('0')
        
        return total_pnl / avg_capital
    
    def _calculate_max_capital_usage(self, trades: List[Dict]) -> Decimal:
        """Calculate maximum capital usage"""
        if not trades:
            return Decimal('0')
        
        max_usage = Decimal('0')
        
        for trade in trades:
            position_size = self._get_trade_position_size(trade)
            capital = self._get_trade_capital_start(trade)
            
            size_value = self._money_to_decimal(position_size)
            capital_value = self._money_to_decimal(capital)
            
            if capital_value > Decimal('0'):
                usage = size_value / capital_value
                max_usage = max(max_usage, usage)
        
        return max_usage
    
    def _calculate_average_capital_usage(self, trades: List[Dict]) -> Decimal:
        """Calculate average capital usage"""
        if not trades:
            return Decimal('0')
        
        total_usage = Decimal('0')
        
        for trade in trades:
            position_size = self._get_trade_position_size(trade)
            capital = self._get_trade_capital_start(trade)
            
            size_value = self._money_to_decimal(position_size)
            capital_value = self._money_to_decimal(capital)
            
            if capital_value > Decimal('0'):
                usage = size_value / capital_value
                total_usage += usage
        
        return total_usage / Decimal(len(trades))
    
    # Type conversion helpers
    
    def _money_to_decimal(self, money: Money) -> Decimal:
        """Convert Money to Decimal"""
        if isinstance(money, Money):
            return Decimal(str(money.as_decimal()))
        return Decimal(str(money))
    
    def _get_trade_pnl(self, trade: Dict) -> Money:
        """Get trade PnL (NautilusTrader Money type)"""
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
    
    def _get_trade_capital_end(self, trade: Dict) -> Money:
        """Get trade ending capital"""
        capital = trade.get('capital_end', Money('10000', USD))
        if isinstance(capital, Money):
            return capital
        return Money(str(capital), USD)
    
    def _get_trade_position_size(self, trade: Dict) -> Money:
        """Calculate position size in money terms"""
        quantity = trade.get('quantity', Quantity.from_str('0'))
        entry_price = trade.get('entry_price', Price.from_str('0'))
        
        if isinstance(quantity, Quantity) and isinstance(entry_price, Price):
            size_decimal = quantity.as_decimal() * entry_price.as_decimal()
            return Money(str(size_decimal), USD)
        
        return Money('0', USD)
    
    def _is_winning_trade(self, trade: Dict) -> bool:
        """Check if trade is a winner"""
        pnl = self._get_trade_pnl(trade)
        return self._money_to_decimal(pnl) > Decimal('0')
    
    def _empty_metrics(self) -> Dict:
        """Return empty metrics structure"""
        return {
            'total_trades': 0,
            'trade_sample_sufficient': False,
            'error': 'No trades available'
        }
    
    def _insufficient_data_metrics(self, trade_count: int) -> Dict:
        """Return metrics for insufficient data"""
        return {
            'total_trades': trade_count,
            'trade_sample_sufficient': False,
            'error': f'Insufficient trades. Need {self.config["min_trades"]}, have {trade_count}'
        }
