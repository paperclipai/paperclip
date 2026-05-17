"""
RECHECK Metrics Calculator - Institutional Grade

Calculates performance metrics for RECHECK validation chains:
- Success rates by level
- Validation times
- Chain completion rates
- Performance impact analysis

Author: BTC_Engine_v3
Date: 2026-01-22
"""

from typing import Dict, List, Any, Optional
from decimal import Decimal
from datetime import datetime
import json
from pathlib import Path
import numpy as np

from src.debugger_logger.recheck_debugger import RecheckValidationState

import logging
logger = logging.getLogger(__name__)



class RecheckMetricsCalculator:
    """
    Institutional-grade metrics calculator for RECHECK validation chains.
    
    Features:
    - Chain-level success rates
    - Level-specific metrics
    - Performance impact analysis
    - Statistical validation
    """
    
    def __init__(self):
        """Initialize metrics calculator"""
        # Chain-level tracking
        self.chain_metrics: Dict[str, Dict[str, Any]] = {}
        
        # Level-specific tracking
        self.level_metrics: Dict[int, Dict[str, Any]] = {}
        
        # Performance tracking
        self.validation_times: List[float] = []
        
        # Impact analysis
        self.trade_impact: Dict[str, Dict[str, Any]] = {
            'with_recheck': {'wins': 0, 'losses': 0, 'total': 0},
            'without_recheck': {'wins': 0, 'losses': 0, 'total': 0}
        }
        
        # Sprint 1.8 Task 1.8.69: Exit condition RECHECK results tracking
        self.exit_condition_recheck_results: List[Dict[str, Any]] = []
    
    def add_chain_result(
        self,
        chain_id: str,
        validation_history: List[Dict[str, Any]],
        final_state: RecheckValidationState,
        execution_time: float
    ):
        """
        Add validation result for a complete chain.
        
        Args:
            chain_id: Chain identifier
            validation_history: List of validation attempts
            final_state: Final validation state
            execution_time: Total execution time in milliseconds
        """
        # Track chain-level metrics
        self.chain_metrics[chain_id] = {
            'validation_history': validation_history,
            'final_state': final_state,
            'execution_time': execution_time,
            'total_levels': len(validation_history),
            'completed_levels': sum(1 for v in validation_history if v['success']),
            'timestamp': datetime.now().isoformat()
        }
        
        # Track level-specific metrics
        for entry in validation_history:
            level = entry['level']
            success = entry['success']
            
            if level not in self.level_metrics:
                self.level_metrics[level] = {
                    'attempts': 0,
                    'successes': 0,
                    'failures': 0,
                    'validation_times': []
                }
            
            self.level_metrics[level]['attempts'] += 1
            if success:
                self.level_metrics[level]['successes'] += 1
            else:
                self.level_metrics[level]['failures'] += 1
        
        # Track execution time
        self.validation_times.append(execution_time)
    
    def add_trade_result(
        self,
        trade_id: str,
        is_win: bool,
        used_recheck: bool
    ):
        """
        Add trade result for impact analysis.
        
        Args:
            trade_id: Trade identifier
            is_win: Whether trade was profitable
            used_recheck: Whether RECHECK validation was used
        """
        category = 'with_recheck' if used_recheck else 'without_recheck'
        self.trade_impact[category]['total'] += 1
        if is_win:
            self.trade_impact[category]['wins'] += 1
        else:
            self.trade_impact[category]['losses'] += 1
    
    def add_exit_condition_recheck_result(
        self,
        exit_condition_name: str,
        recheck_passed: bool,
        recheck_bar_count: int,
        exit_executed: bool
    ) -> None:
        """
        Track exit condition recheck validation results - Sprint 1.8 Task 1.8.70
        
        Args:
            exit_condition_name: Name of the exit condition signal
            recheck_passed: Whether RECHECK validation passed
            recheck_bar_count: Number of bars waited for recheck
            exit_executed: Whether exit was actually executed after recheck
        """
        result = {
            'exit_condition_name': exit_condition_name,
            'recheck_passed': recheck_passed,
            'recheck_bar_count': recheck_bar_count,
            'exit_executed': exit_executed,
            'timestamp': datetime.now().isoformat()
        }
        
        self.exit_condition_recheck_results.append(result)
    
    def calculate_metrics(self) -> Dict[str, Any]:
        """
        Calculate comprehensive metrics.
        
        Returns:
            Dictionary containing all calculated metrics
        """
        total_chains = len(self.chain_metrics)
        with_recheck_winrate = float(
            self.trade_impact['with_recheck']['wins'] / self.trade_impact['with_recheck']['total']
            if self.trade_impact['with_recheck']['total'] > 0 else 0
        )
        without_recheck_winrate = float(
            self.trade_impact['without_recheck']['wins'] / self.trade_impact['without_recheck']['total']
            if self.trade_impact['without_recheck']['total'] > 0 else 0
        )
        if total_chains == 0:
            return {
                'error': 'No data available for metrics calculation',
                'timestamp': datetime.now().isoformat(),
                'trade_impact': {
                    'with_recheck': {
                        **self.trade_impact['with_recheck'],
                        'winrate': with_recheck_winrate
                    },
                    'without_recheck': {
                        **self.trade_impact['without_recheck'],
                        'winrate': without_recheck_winrate
                    },
                    'winrate_difference': float(with_recheck_winrate - without_recheck_winrate)
                }
            }
        
        # Chain-level metrics
        successful_chains = sum(
            1 for m in self.chain_metrics.values()
            if m['final_state'] == RecheckValidationState.VALIDATED
        )
        
        failed_chains = sum(
            1 for m in self.chain_metrics.values()
            if m['final_state'] == RecheckValidationState.FAILED
        )
        
        expired_chains = sum(
            1 for m in self.chain_metrics.values()
            if m['final_state'] == RecheckValidationState.EXPIRED
        )
        
        # Level-specific metrics
        level_stats = {}
        for level, metrics in self.level_metrics.items():
            success_rate = (
                metrics['successes'] / metrics['attempts']
                if metrics['attempts'] > 0 else 0
            )
            
            level_stats[level] = {
                'attempts': metrics['attempts'],
                'successes': metrics['successes'],
                'failures': metrics['failures'],
                'success_rate': float(success_rate)
            }
        
        # Performance metrics
        avg_execution_time = np.mean(self.validation_times)
        std_execution_time = np.std(self.validation_times)
        max_execution_time = np.max(self.validation_times)
        
        # Trade impact analysis
        with_recheck = self.trade_impact['with_recheck']
        without_recheck = self.trade_impact['without_recheck']
        
        with_recheck_winrate = (
            with_recheck['wins'] / with_recheck['total']
            if with_recheck['total'] > 0 else 0
        )
        
        without_recheck_winrate = (
            without_recheck['wins'] / without_recheck['total']
            if without_recheck['total'] > 0 else 0
        )
        
        # Sprint 1.8 Task 1.8.71: Exit condition RECHECK statistics
        exit_recheck_stats = self._calculate_exit_recheck_stats()
        
        return {
            'timestamp': datetime.now().isoformat(),
            'chain_metrics': {
                'total_chains': total_chains,
                'successful_chains': successful_chains,
                'failed_chains': failed_chains,
                'expired_chains': expired_chains,
                'success_rate': float(successful_chains / total_chains),
                'failure_rate': float(failed_chains / total_chains),
                'expiry_rate': float(expired_chains / total_chains)
            },
            'level_metrics': level_stats,
            'performance_metrics': {
                'average_execution_time': float(avg_execution_time),
                'std_execution_time': float(std_execution_time),
                'max_execution_time': float(max_execution_time),
                'total_validations': len(self.validation_times)
            },
            'trade_impact': {
                'with_recheck': {
                    **with_recheck,
                    'winrate': float(with_recheck_winrate)
                },
                'without_recheck': {
                    **without_recheck,
                    'winrate': float(without_recheck_winrate)
                },
                'winrate_difference': float(with_recheck_winrate - without_recheck_winrate)
            },
            'exit_condition_recheck': exit_recheck_stats  # Sprint 1.8 Task 1.8.71
        }
    
    def _calculate_exit_recheck_stats(self) -> Dict[str, Any]:
        """
        Calculate exit condition RECHECK statistics - Sprint 1.8 Task 1.8.71
        
        Returns:
            Dictionary with exit condition RECHECK metrics
        """
        if not self.exit_condition_recheck_results:
            return {
                'total_attempts': 0,
                'passed': 0,
                'failed': 0,
                'pass_rate': 0.0,
                'executed_after_pass': 0,
                'execution_rate': 0.0,
                'avg_bar_count': 0.0,
                'by_condition': {}
            }
        
        total_attempts = len(self.exit_condition_recheck_results)
        passed = sum(1 for r in self.exit_condition_recheck_results if r['recheck_passed'])
        failed = total_attempts - passed
        
        executed_after_pass = sum(
            1 for r in self.exit_condition_recheck_results
            if r['recheck_passed'] and r['exit_executed']
        )
        
        # Calculate average bar count
        bar_counts = [r['recheck_bar_count'] for r in self.exit_condition_recheck_results]
        avg_bar_count = np.mean(bar_counts) if bar_counts else 0.0
        
        # Per-condition breakdown
        by_condition = {}
        for result in self.exit_condition_recheck_results:
            condition_name = result['exit_condition_name']
            
            if condition_name not in by_condition:
                by_condition[condition_name] = {
                    'attempts': 0,
                    'passed': 0,
                    'executed': 0
                }
            
            by_condition[condition_name]['attempts'] += 1
            if result['recheck_passed']:
                by_condition[condition_name]['passed'] += 1
            if result['exit_executed']:
                by_condition[condition_name]['executed'] += 1
        
        # Calculate per-condition rates
        for condition_name, stats in by_condition.items():
            stats['pass_rate'] = (
                stats['passed'] / stats['attempts']
                if stats['attempts'] > 0 else 0.0
            )
            stats['execution_rate'] = (
                stats['executed'] / stats['attempts']
                if stats['attempts'] > 0 else 0.0
            )
        
        return {
            'total_attempts': total_attempts,
            'passed': passed,
            'failed': failed,
            'pass_rate': float(passed / total_attempts) if total_attempts > 0 else 0.0,
            'executed_after_pass': executed_after_pass,
            'execution_rate': float(executed_after_pass / passed) if passed > 0 else 0.0,
            'avg_bar_count': float(avg_bar_count),
            'by_condition': by_condition
        }
    
    def generate_report(self, include_raw_data: bool = False) -> str:
        """
        Generate detailed metrics report.
        
        Args:
            include_raw_data: Whether to include raw validation data
            
        Returns:
            Formatted report string
        """
        metrics = self.calculate_metrics()
        
        if 'error' in metrics:
            return f"Error: {metrics['error']}"
        
        chain_metrics = metrics['chain_metrics']
        level_metrics = metrics['level_metrics']
        performance = metrics['performance_metrics']
        impact = metrics['trade_impact']
        
        report = f"""
╔{'═' * 78}╗
║ 📊 RECHECK METRICS REPORT                                                 ║
╚{'═' * 78}╝
Generated: {metrics['timestamp']}

Chain-Level Metrics:
------------------
Total Chains: {chain_metrics['total_chains']}
Successful: {chain_metrics['successful_chains']} ({chain_metrics['success_rate']:.2%})
Failed: {chain_metrics['failed_chains']} ({chain_metrics['failure_rate']:.2%})
Expired: {chain_metrics['expired_chains']} ({chain_metrics['expiry_rate']:.2%})

Level-Specific Metrics:
--------------------"""
        
        for level, stats in level_metrics.items():
            report += f"""
Level {level}:
  Attempts: {stats['attempts']}
  Success Rate: {stats['success_rate']:.2%}
  Failures: {stats['failures']}"""
        
        report += f"""

Performance Metrics:
-----------------
Average Execution Time: {performance['average_execution_time']:.2f}ms
Standard Deviation: {performance['std_execution_time']:.2f}ms
Maximum Time: {performance['max_execution_time']:.2f}ms
Total Validations: {performance['total_validations']}

Trade Impact Analysis:
-------------------
With RECHECK:
  Total Trades: {impact['with_recheck']['total']}
  Win Rate: {impact['with_recheck']['winrate']:.2%}
  
Without RECHECK:
  Total Trades: {impact['without_recheck']['total']}
  Win Rate: {impact['without_recheck']['winrate']:.2%}
  
Win Rate Difference: {impact['winrate_difference']:.2%}
"""
        
        if include_raw_data:
            report += "\nRaw Validation Data:\n"
            report += json.dumps(self.chain_metrics, indent=2, default=str)
        
        return report
    
    def export_metrics(self, output_file: Path):
        """
        Export metrics to JSON file.
        
        Args:
            output_file: Path to write metrics
        """
        metrics = self.calculate_metrics()
        
        output_file.parent.mkdir(parents=True, exist_ok=True)
        with open(output_file, 'w') as f:
            json.dump(metrics, f, indent=2, default=str)
    
    def get_summary_stats(self) -> Dict[str, float]:
        """
        Get key summary statistics.
        
        Returns:
            Dictionary of key metrics
        """
        metrics = self.calculate_metrics()
        
        if 'error' in metrics:
            return {'error_rate': 1.0}
        
        return {
            'chain_success_rate': metrics['chain_metrics']['success_rate'],
            'avg_execution_time': metrics['performance_metrics']['average_execution_time'],
            'winrate_improvement': metrics['trade_impact']['winrate_difference']
        }
