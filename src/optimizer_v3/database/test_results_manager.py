"""
Test Results Manager
SPRINT 1.6.1 - Phase 1 Day 2

Manages strategy test results and performance tracking
for backtests, forward tests, and live trading validation.

Institutional-grade implementation with:
- Complete test result tracking
- Performance metrics storage
- Historical comparison
- Regression detection
"""

from typing import Optional, List, Dict, Any
from uuid import uuid4
from datetime import datetime
import json
import logging
from sqlalchemy.orm import Session
from sqlalchemy import text

import logging
logger = logging.getLogger(__name__)


logger = logging.getLogger(__name__)


class TestResultsManager:
    """
    Database manager for test results tracking and analysis
    
    Provides:
    - Store backtest/forward test results
    - Query by strategy, version, test type
    - Compare performance across versions
    - Detect performance regressions
    - Track best performing versions
    """
    
    def __init__(self, db_session: Session):
        """
        Initialize test results manager
        
        Args:
            db_session: SQLAlchemy session for database operations
        """
        self.session = db_session
        self.logger = logging.getLogger(f"{__name__}.{self.__class__.__name__}")
    
    def create_test_result(self, test_data: Dict[str, Any]) -> str:
        """
        Create new test result record using ORM
        
        Args:
            test_data: Test result details including:
                - strategy_id (str): Strategy ID
                - strategy_version_id (str): Version ID tested
                - test_type (str): backtest, forward_test, paper_trade, live
                - test_config (dict): Test configuration
                - start_date (datetime): Test period start
                - end_date (datetime): Test period end
                - metrics (dict): Performance metrics
                - trades (list, optional): Trade details
                - equity_curve (list, optional): Equity curve data
                - risk_metrics (dict, optional): Risk analysis
                - exit_condition_results (dict, optional): Exit condition statistics (Sprint 1.8)
                - errors (list, optional): Error log
                - warnings (list, optional): Warning log
                - notes (str, optional): Additional notes
                
        Returns:
            result_id: UUID string of created test result
            
        Raises:
            ValueError: If required fields missing or invalid
            
        Real Money Impact: HIGH - WRITES backtest/live test results to database
        
        ORM Refactored: Sprint 1.6.1 Task 3.1.5
        """
        from src.optimizer_v3.database.models import StrategyTestResult
        
        # Validate required fields
        required = ['strategy_id', 'strategy_version_id', 'test_type', 'test_config', 'start_date', 'end_date', 'metrics']
        missing = [f for f in required if f not in test_data]
        if missing:
            raise ValueError(f"Missing required fields: {', '.join(missing)}")
        
        # Validate test type
        valid_types = ['backtest', 'forward_test', 'paper_trade', 'live', 'walk_forward']
        if test_data['test_type'] not in valid_types:
            raise ValueError(f"Invalid test_type. Must be one of: {', '.join(valid_types)}")
        
        try:
            # Extract key metrics
            metrics = test_data['metrics']
            
            # Create ORM object
            # Note: ORM handles JSONB serialization automatically - no json.dumps() needed!
            test_result = StrategyTestResult(
                strategy_id=test_data['strategy_id'],
                version_id=test_data['strategy_version_id'],  # Input uses 'strategy_version_id', DB uses 'version_id'
                test_type=test_data['test_type'],
                # JSONB fields - pass Python objects directly
                test_config=test_data['test_config'],
                metrics=metrics,
                trades=test_data.get('trades'),
                equity_curve=test_data.get('equity_curve'),
                risk_metrics=test_data.get('risk_metrics'),
                ai_recommendations=test_data.get('ai_recommendations'),
                exit_condition_results=test_data.get('exit_condition_results'),
                errors=test_data.get('errors'),
                warnings=test_data.get('warnings'),
                # Date fields
                start_date=test_data['start_date'],
                end_date=test_data['end_date'],
                # Metric fields (extracted from metrics dict)
                total_return_pct=metrics.get('total_return_pct'),
                sharpe_ratio=metrics.get('sharpe_ratio'),
                max_drawdown_pct=metrics.get('max_drawdown_pct'),
                win_rate=metrics.get('win_rate'),
                profit_factor=metrics.get('profit_factor'),
                total_trades=metrics.get('total_trades'),
                # Other fields
                notes=test_data.get('notes')
            )
            
            # Add to session and commit
            self.session.add(test_result)
            self.session.commit()
            
            # Get the generated result_id
            result_id_str = str(test_result.result_id)
            
            self.logger.info(
                f"Created test result: {result_id_str} "
                f"(strategy: {test_data['strategy_id']}, version: {test_data['strategy_version_id']}, "
                f"type: {test_data['test_type']})"
            )
            
            return result_id_str
            
        except Exception as e:
            self.session.rollback()
            self.logger.error(f"Failed to create test result: {e}")
            raise
    
    def get_test_result(self, result_id: str) -> Optional[Dict[str, Any]]:
        """
        Get test result by ID using ORM
        
        Args:
            result_id: Result UUID string
            
        Returns:
            Test result dict or None if not found
            JSONB fields automatically deserialized to Python objects
            
        Real Money Impact: MEDIUM - Retrieves backtest/live test results
        
        ORM Refactored: Sprint 1.6.1 Task 3.1.1
        """
        from src.optimizer_v3.database.models import StrategyTestResult
        
        try:
            # Query using ORM
            test_result = self.session.query(StrategyTestResult).filter_by(
                result_id=result_id
            ).first()
            
            if not test_result:
                return None
            
            # Convert ORM object to dict
            # JSONB fields are automatically deserialized by SQLAlchemy
            result_dict = {
                'result_id': str(test_result.result_id),
                'strategy_id': test_result.strategy_id,
                'version_id': str(test_result.version_id),
                'test_type': test_result.test_type,
                # JSONB fields - already Python objects
                'test_config': test_result.test_config,
                'metrics': test_result.metrics,
                'trades': test_result.trades,
                'equity_curve': test_result.equity_curve,
                'ai_recommendations': test_result.ai_recommendations,
                'exit_condition_results': test_result.exit_condition_results,
                # Date fields
                'start_date': test_result.start_date,
                'end_date': test_result.end_date,
                # Metric fields
                'total_return_pct': test_result.total_return_pct,
                'sharpe_ratio': test_result.sharpe_ratio,
                'max_drawdown_pct': test_result.max_drawdown_pct,
                'win_rate': test_result.win_rate,
                'profit_factor': test_result.profit_factor,
                'total_trades': test_result.total_trades,
                # Timestamps
                'timestamp': test_result.timestamp,
                'created_at': test_result.created_at
            }
            
            return result_dict
            
        except Exception as e:
            self.session.rollback()
            self.logger.error(f"Failed to get test result {result_id}: {e}")
            return None
    
    def get_strategy_test_results(
        self,
        strategy_id: str,
        test_type: Optional[str] = None,
        limit: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        """
        Get test results for a strategy using ORM
        
        Args:
            strategy_id: Strategy ID
            test_type: Optional filter by test type
            limit: Optional limit number of results
            
        Returns:
            List of test result dicts
            JSONB fields automatically deserialized
            
        Real Money Impact: MEDIUM - Retrieves historical test results
        
        ORM Refactored: Sprint 1.6.1 Task 3.1.2
        """
        from src.optimizer_v3.database.models import StrategyTestResult
        
        try:
            # Build ORM query
            query = self.session.query(StrategyTestResult).filter_by(
                strategy_id=strategy_id
            )
            
            # Optional filter by test type
            if test_type:
                query = query.filter_by(test_type=test_type)
            
            # Order by created_at descending
            query = query.order_by(StrategyTestResult.created_at.desc())
            
            # Optional limit
            if limit:
                query = query.limit(limit)
            
            # Execute query
            results = query.all()
            
            # Convert ORM objects to dicts
            tests = []
            for test_result in results:
                test_dict = {
                    'result_id': str(test_result.result_id),
                    'strategy_id': test_result.strategy_id,
                    'version_id': str(test_result.version_id),
                    'test_type': test_result.test_type,
                    # JSONB fields - already Python objects
                    'test_config': test_result.test_config,
                    'metrics': test_result.metrics,
                    'trades': test_result.trades,
                    'equity_curve': test_result.equity_curve,
                    'risk_metrics': test_result.risk_metrics,
                    'ai_recommendations': test_result.ai_recommendations,
                    'exit_condition_results': test_result.exit_condition_results,
                    'errors': test_result.errors,
                    'warnings': test_result.warnings,
                    # Date fields
                    'start_date': test_result.start_date,
                    'end_date': test_result.end_date,
                    # Metric fields
                    'total_return_pct': test_result.total_return_pct,
                    'sharpe_ratio': test_result.sharpe_ratio,
                    'max_drawdown_pct': test_result.max_drawdown_pct,
                    'win_rate': test_result.win_rate,
                    'profit_factor': test_result.profit_factor,
                    'total_trades': test_result.total_trades,
                    # Other fields
                    'notes': test_result.notes,
                    # Timestamps
                    'timestamp': test_result.timestamp,
                    'created_at': test_result.created_at
                }
                tests.append(test_dict)
            
            return tests
            
        except Exception as e:
            self.session.rollback()
            self.logger.error(f"Failed to get test results for strategy {strategy_id}: {e}")
            return []
    
    def get_version_test_results(
        self,
        version_id: str
    ) -> List[Dict[str, Any]]:
        """
        Get all test results for a specific version using ORM
        
        Args:
            version_id: Strategy version ID
            
        Returns:
            List of test result dicts
            JSONB fields automatically deserialized
            
        Real Money Impact: MEDIUM - Retrieves version-specific test results
        
        ORM Refactored: Sprint 1.6.1 Task 3.1.3
        """
        from src.optimizer_v3.database.models import StrategyTestResult
        
        try:
            # Query using ORM
            results = self.session.query(StrategyTestResult).filter_by(
                version_id=version_id
            ).order_by(StrategyTestResult.created_at.desc()).all()
            
            # Convert ORM objects to dicts
            tests = []
            for test_result in results:
                test_dict = {
                    'result_id': str(test_result.result_id),
                    'strategy_id': test_result.strategy_id,
                    'version_id': str(test_result.version_id),
                    'test_type': test_result.test_type,
                    # JSONB fields - already Python objects
                    'test_config': test_result.test_config,
                    'metrics': test_result.metrics,
                    'trades': test_result.trades,
                    'equity_curve': test_result.equity_curve,
                    'risk_metrics': test_result.risk_metrics,
                    'ai_recommendations': test_result.ai_recommendations,
                    'exit_condition_results': test_result.exit_condition_results,
                    'errors': test_result.errors,
                    'warnings': test_result.warnings,
                    # Date fields
                    'start_date': test_result.start_date,
                    'end_date': test_result.end_date,
                    # Metric fields
                    'total_return_pct': test_result.total_return_pct,
                    'sharpe_ratio': test_result.sharpe_ratio,
                    'max_drawdown_pct': test_result.max_drawdown_pct,
                    'win_rate': test_result.win_rate,
                    'profit_factor': test_result.profit_factor,
                    'total_trades': test_result.total_trades,
                    # Other fields
                    'notes': test_result.notes,
                    # Timestamps
                    'timestamp': test_result.timestamp,
                    'created_at': test_result.created_at
                }
                tests.append(test_dict)
            
            return tests
            
        except Exception as e:
            self.session.rollback()
            self.logger.error(f"Failed to get test results for version {version_id}: {e}")
            return []
    
    def get_latest_test_result(
        self,
        strategy_id: str,
        version_id: str,
        test_type: str
    ) -> Optional[Dict[str, Any]]:
        """
        Get most recent test result for strategy version and test type using ORM
        
        Args:
            strategy_id: Strategy ID
            version_id: Version ID
            test_type: Test type
            
        Returns:
            Latest test result dict or None
            JSONB fields automatically deserialized
            
        Real Money Impact: MEDIUM - Retrieves latest test result
        
        ORM Refactored: Sprint 1.6.1 Task 3.1.4
        """
        from src.optimizer_v3.database.models import StrategyTestResult
        
        try:
            # Query using ORM - filter by all 3 parameters
            test_result = self.session.query(StrategyTestResult).filter_by(
                strategy_id=strategy_id,
                version_id=version_id,
                test_type=test_type
            ).order_by(StrategyTestResult.created_at.desc()).first()
            
            if not test_result:
                return None
            
            # Convert ORM object to dict
            result_dict = {
                'result_id': str(test_result.result_id),
                'strategy_id': test_result.strategy_id,
                'version_id': str(test_result.version_id),
                'test_type': test_result.test_type,
                # JSONB fields - already Python objects
                'test_config': test_result.test_config,
                'metrics': test_result.metrics,
                'trades': test_result.trades,
                'equity_curve': test_result.equity_curve,
                'risk_metrics': test_result.risk_metrics,
                'ai_recommendations': test_result.ai_recommendations,
                'exit_condition_results': test_result.exit_condition_results,
                'errors': test_result.errors,
                'warnings': test_result.warnings,
                # Date fields
                'start_date': test_result.start_date,
                'end_date': test_result.end_date,
                # Metric fields
                'total_return_pct': test_result.total_return_pct,
                'sharpe_ratio': test_result.sharpe_ratio,
                'max_drawdown_pct': test_result.max_drawdown_pct,
                'win_rate': test_result.win_rate,
                'profit_factor': test_result.profit_factor,
                'total_trades': test_result.total_trades,
                # Other fields
                'notes': test_result.notes,
                # Timestamps
                'timestamp': test_result.timestamp,
                'created_at': test_result.created_at
            }
            
            return result_dict
            
        except Exception as e:
            self.session.rollback()
            self.logger.error(
                f"Failed to get latest test result for strategy={strategy_id}, "
                f"version={version_id}, type={test_type}: {e}"
            )
            return None
    
    def compare_versions(
        self,
        strategy_id: str,
        version_ids: List[str],
        test_type: str = 'backtest'
    ) -> Dict[str, Any]:
        """
        Compare performance across multiple versions
        
        Args:
            strategy_id: Strategy ID
            version_ids: List of version IDs to compare
            test_type: Test type to use for comparison
            
        Returns:
            Dict with comparison results
        """
        if not version_ids:
            return {'error': 'No version IDs provided'}
        
        placeholders = ', '.join([f':v{i}' for i in range(len(version_ids))])
        
        query = text(f"""
            SELECT 
                version_id,
                AVG(total_return_pct) as avg_return,
                AVG(sharpe_ratio) as avg_sharpe,
                AVG(max_drawdown_pct) as avg_drawdown,
                AVG(win_rate) as avg_win_rate,
                AVG(profit_factor) as avg_profit_factor,
                COUNT(*) as test_count
            FROM strategy_test_results
            WHERE strategy_id = :strategy_id
            AND test_type = :test_type
            AND version_id IN ({placeholders})
            GROUP BY version_id
        """)
        
        params = {
            'strategy_id': strategy_id,
            'test_type': test_type
        }
        for i, vid in enumerate(version_ids):
            params[f'v{i}'] = vid
        
        results = self.session.execute(query, params).fetchall()
        
        comparison = {
            'strategy_id': strategy_id,
            'test_type': test_type,
            'versions': []
        }
        
        for row in results:
            comparison['versions'].append(dict(row._mapping))
        
        # Find best version by Sharpe ratio
        if comparison['versions']:
            best = max(comparison['versions'], key=lambda x: x['avg_sharpe'] or 0)
            comparison['best_version'] = best['version_id']
            comparison['best_sharpe'] = best['avg_sharpe']
        
        return comparison
    
    def detect_regression(
        self,
        strategy_id: str,
        new_version_id: str,
        baseline_version_id: str,
        test_type: str = 'backtest',
        threshold_pct: float = 10.0
    ) -> Dict[str, Any]:
        """
        Detect performance regression between versions
        
        Args:
            strategy_id: Strategy ID
            new_version_id: New version to test
            baseline_version_id: Baseline version to compare against
            test_type: Test type to use
            threshold_pct: Regression threshold percentage
            
        Returns:
            Dict with regression analysis
        """
        # Get latest test for each version
        new_test = self.get_latest_test_result(strategy_id, new_version_id, test_type)
        baseline_test = self.get_latest_test_result(strategy_id, baseline_version_id, test_type)
        
        if not new_test or not baseline_test:
            return {
                'error': 'Missing test results for comparison',
                'new_test_exists': new_test is not None,
                'baseline_test_exists': baseline_test is not None
            }
        
        # Compare key metrics
        regression = {
            'strategy_id': strategy_id,
            'new_version_id': new_version_id,
            'baseline_version_id': baseline_version_id,
            'test_type': test_type,
            'threshold_pct': threshold_pct,
            'regressions': [],
            'improvements': [],
            'overall_status': 'pass'
        }
        
        metrics_to_compare = [
            ('total_return_pct', 'higher_is_better'),
            ('sharpe_ratio', 'higher_is_better'),
            ('max_drawdown_pct', 'lower_is_better'),
            ('win_rate', 'higher_is_better'),
            ('profit_factor', 'higher_is_better')
        ]
        
        for metric, direction in metrics_to_compare:
            new_val = new_test.get(metric)
            baseline_val = baseline_test.get(metric)
            
            if new_val is None or baseline_val is None or baseline_val == 0:
                continue
            
            change_pct = ((new_val - baseline_val) / abs(baseline_val)) * 100
            
            is_regression = (
                (direction == 'higher_is_better' and change_pct < -threshold_pct) or
                (direction == 'lower_is_better' and change_pct > threshold_pct)
            )
            
            is_improvement = (
                (direction == 'higher_is_better' and change_pct > threshold_pct) or
                (direction == 'lower_is_better' and change_pct < -threshold_pct)
            )
            
            if is_regression:
                regression['regressions'].append({
                    'metric': metric,
                    'baseline_value': baseline_val,
                    'new_value': new_val,
                    'change_pct': change_pct
                })
                regression['overall_status'] = 'fail'
            elif is_improvement:
                regression['improvements'].append({
                    'metric': metric,
                    'baseline_value': baseline_val,
                    'new_value': new_val,
                    'change_pct': change_pct
                })
        
        return regression
    
    def get_best_performing_version(
        self,
        strategy_id: str,
        test_type: str = 'backtest',
        metric: str = 'sharpe_ratio'
    ) -> Optional[Dict[str, Any]]:
        """
        Get best performing version based on metric
        
        Args:
            strategy_id: Strategy ID
            test_type: Test type to consider
            metric: Metric to optimize
            
        Returns:
            Best version info dict or None
        """
        valid_metrics = [
            'total_return_pct', 'sharpe_ratio', 'win_rate', 'profit_factor'
        ]
        
        if metric not in valid_metrics:
            raise ValueError(f"Invalid metric. Must be one of: {', '.join(valid_metrics)}")
        
        query = text(f"""
            SELECT 
                version_id,
                AVG({metric}) as avg_metric,
                COUNT(*) as test_count
            FROM strategy_test_results
            WHERE strategy_id = :strategy_id
            AND test_type = :test_type
            AND {metric} IS NOT NULL
            GROUP BY version_id
            ORDER BY avg_metric DESC
            LIMIT 1
        """)
        
        result = self.session.execute(
            query,
            {
                'strategy_id': strategy_id,
                'test_type': test_type
            }
        ).fetchone()
        
        if not result:
            return None
        
        return {
            'strategy_id': strategy_id,
            'version_id': result[0],
            'metric': metric,
            'metric_value': result[1],
            'test_count': result[2],
            'test_type': test_type
        }
    
    def get_exit_condition_statistics(self, strategy_id: str) -> Dict[str, Any]:
        """
        Get aggregate exit condition statistics for a strategy
        
        Sprint 1.8 Task 1.8.29: Aggregate exit condition performance across all test results
        
        Args:
            strategy_id: Strategy ID
            
        Returns:
            Dict with exit condition statistics:
                - total_triggers: Total exit condition triggers across all tests
                - trigger_by_condition: Dict mapping condition names to trigger counts
                - avg_exit_percentage: Average exit percentage
                - pnl_by_condition: Dict mapping condition names to total P&L
                - best_performing_exit: Exit condition with highest P&L
                - worst_performing_exit: Exit condition with lowest P&L
        """
        # Get all test results for this strategy
        tests = self.get_strategy_test_results(strategy_id)
        
        if not tests:
            return {
                'total_triggers': 0,
                'trigger_by_condition': {},
                'avg_exit_percentage': 0.0,
                'pnl_by_condition': {},
                'best_performing_exit': None,
                'worst_performing_exit': None,
                'test_count': 0
            }
        
        # Aggregate statistics
        total_triggers = 0
        trigger_by_condition = {}
        pnl_by_condition = {}
        exit_percentage_sum = 0
        exit_percentage_count = 0
        
        for test in tests:
            exit_results = test.get('exit_condition_results')
            if not exit_results:
                continue
            
            # Aggregate triggers
            test_triggers = exit_results.get('total_triggers', 0)
            total_triggers += test_triggers
            
            # Aggregate by condition name
            by_condition = exit_results.get('by_condition_name', {})
            for cond_name, cond_data in by_condition.items():
                if cond_name not in trigger_by_condition:
                    trigger_by_condition[cond_name] = 0
                    pnl_by_condition[cond_name] = 0.0
                
                trigger_by_condition[cond_name] += cond_data.get('triggers', 0)
                pnl_by_condition[cond_name] += cond_data.get('pnl', 0.0)
            
            # Aggregate avg percentages
            partial_exits = exit_results.get('partial_exits', 0)
            if partial_exits > 0:
                exit_percentage_count += partial_exits
                # Approximate from partial_exit_count and total triggers
                if test_triggers > 0:
                    exit_percentage_sum += (partial_exits / test_triggers) * 50  # Estimate
        
        # Calculate averages
        avg_exit_percentage = (
            exit_percentage_sum / exit_percentage_count 
            if exit_percentage_count > 0 else 0.0
        )
        
        # Find best/worst performing exits
        best_exit = None
        worst_exit = None
        
        if pnl_by_condition:
            best_exit = max(pnl_by_condition.items(), key=lambda x: x[1])
            worst_exit = min(pnl_by_condition.items(), key=lambda x: x[1])
        
        return {
            'total_triggers': total_triggers,
            'trigger_by_condition': trigger_by_condition,
            'avg_exit_percentage': round(avg_exit_percentage, 2),
            'pnl_by_condition': pnl_by_condition,
            'best_performing_exit': {
                'condition_name': best_exit[0],
                'total_pnl': best_exit[1]
            } if best_exit else None,
            'worst_performing_exit': {
                'condition_name': worst_exit[0],
                'total_pnl': worst_exit[1]
            } if worst_exit else None,
            'test_count': len(tests)
        }
