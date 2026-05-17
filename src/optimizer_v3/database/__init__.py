"""
Optimizer V3 Database Package
SPRINT 1.6.1 - Phase 1

Complete database layer for strategy versioning, AI recommendations,
and test results tracking.

Main Components:
- DatabaseManager: Unified database interface
- StrategyDatabaseManager: Strategy versioning operations
- AIRecommendationsManager: AI recommendation tracking
- TestResultsManager: Test results management

Usage:
    ```python
    from src.optimizer_v3.database import get_database_manager
    
    # Get database manager from environment
    db = get_database_manager()
    
    # Create strategy
    strategy_id = db.strategy.create_strategy("My Strategy")
    
    # Create version
    version_id = db.strategy.create_strategy_version({
        'strategy_id': strategy_id,
        'name': 'My Strategy',
        'blocks': [...],
        'parameters': {...},
        # ... other config
    })
    
    # Create AI recommendation
    rec_id = db.ai_recommendations.create_recommendation({
        'strategy_id': strategy_id,
        'recommendation_type': 'performance',
        'title': 'Optimize entry conditions',
        # ... other details
    })
    
    # Record test result
    result_id = db.test_results.create_test_result({
        'strategy_id': strategy_id,
        'strategy_version_id': version_id,
        'test_type': 'backtest',
        # ... metrics and config
    })
    
    # Clean up
    db.close()
    ```
"""

# Main managers
from .database_manager import (
    DatabaseManager,
    DatabaseManagerFactory,
    get_database_manager
)

from .strategy_manager import StrategyDatabaseManager
from .ai_recommendations_manager import AIRecommendationsManager
from .test_results_manager import TestResultsManager

# Models (for type hints and advanced usage)
from .models import (
    Base,
    OptimizationRun,
    StrategyVariation,
    SignalEvent,
    SignalMetrics,
    TrainingSession,
    SessionState,
    BacktestResult,
    # Sprint 1.6.1 ORM Models
    Strategy,
    StrategyVersion,
    StrategyBlockVersion,
    AIRecommendation,
    StrategyTestResult,
    # ADR-0002 Traceability Models
    TraceRequirement,
    TraceTestCase,
    TraceIssue,
    TraceLink,
    ValidationReportDB,
    AiConsultantAudit,
)

__all__ = [
    # Main interface
    'DatabaseManager',
    'DatabaseManagerFactory',
    'get_database_manager',
    
    # Specialized managers
    'StrategyDatabaseManager',
    'AIRecommendationsManager',
    'TestResultsManager',
    
    # Models (original)
    'Base',
    'OptimizationRun',
    'StrategyVariation',
    'SignalEvent',
    'SignalMetrics',
    'TrainingSession',
    'SessionState',
    'BacktestResult',
    
    # Sprint 1.6.1 ORM Models
    'Strategy',
    'StrategyVersion',
    'StrategyBlockVersion',
    'AIRecommendation',
    'StrategyTestResult',
    
    # ADR-0002 Traceability Models
    'TraceRequirement',
    'TraceTestCase',
    'TraceIssue',
    'TraceLink',
    'ValidationReportDB',
    'AiConsultantAudit',
]

__version__ = '1.0.0'
__author__ = 'BTC Trade Engine'
__description__ = 'Database layer for strategy versioning and tracking'
