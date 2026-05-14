"""
Database Manager
Task 0.6: High-Level Database Operations

Provides transaction management, CRUD operations, and session lifecycle management
for all database models with proper error handling and resource cleanup.
"""

import logging
from contextlib import contextmanager
from typing import List, Dict, Any, Optional, Type, TypeVar
from datetime import datetime, timezone
from sqlalchemy.orm import Session
from sqlalchemy.exc import SQLAlchemyError

from .connection_pool import get_connection_pool, DatabaseConnectionPool
from .models import (
    Base,
    OptimizationRun,
    StrategyVariation,
    SignalEvent,
    SignalMetrics,
    TrainingSession,
    SessionState,
    BacktestResult,
)
from .validators import NautilusDataValidator, ValidationError

import logging
logger = logging.getLogger(__name__)


# Type variable for model classes
T = TypeVar('T', bound=Base)


class DatabaseManager:
    """
    High-level database manager with transaction support
    
    Provides:
    - Automatic transaction management
    - CRUD operations for all models
    - Proper error handling and rollback
    - Session lifecycle management
    - Bulk operations support
    
    Example:
        db = DatabaseManager()
        
        # Create new run
        run_id = db.create_optimization_run({
            'strategy_id': 'my_strategy',
            'strategy_name': 'Test Strategy',
            'strategy_config': {...},
            'backtest_config': {...},
            'optimization_params': {...}
        })
        
        # Query runs
        runs = db.get_optimization_runs(status='completed')
        
        # Update run
        db.update_optimization_run(run_id, {'status': 'completed'})
    """
    
    def __init__(self, pool: Optional[DatabaseConnectionPool] = None):
        """
        Initialize database manager
        
        Args:
            pool: Optional connection pool (uses global pool if None)
        """
        self.logger = logging.getLogger(__name__)
        self.pool = pool or get_connection_pool()
        self.validator = NautilusDataValidator()
    
    @contextmanager
    def session_scope(self):
        """
        Provide a transactional scope around a series of operations
        
        Automatically commits on success or rolls back on exception.
        Always closes the session when done.
        
        Yields:
            Session: SQLAlchemy session
            
        Example:
            with db.session_scope() as session:
                run = OptimizationRun(...)
                session.add(run)
                # Automatically commits here
        """
        session = self.pool.get_session()
        try:
            yield session
            session.commit()
            self.logger.debug("Transaction committed successfully")
        except Exception as e:
            session.rollback()
            self.logger.error(f"Transaction rolled back due to error: {str(e)}")
            raise
        finally:
            session.close()
            self.pool.metrics.record_connection_close()
    
    # ========================================================================
    # Generic CRUD Operations
    # ========================================================================
    
    def create(self, model_class: Type[T], data: Dict[str, Any]) -> T:
        """
        Create a new record
        
        Args:
            model_class: Model class to create
            data: Data dictionary
            
        Returns:
            Created model instance
            
        Raises:
            ValidationError: If data validation fails
            SQLAlchemyError: If database operation fails
        """
        with self.session_scope() as session:
            instance = model_class(**data)
            session.add(instance)
            session.flush()  # Get the ID
            return instance
    
    def get_by_id(self, model_class: Type[T], id_value: Any) -> Optional[T]:
        """
        Get record by ID
        
        Args:
            model_class: Model class
            id_value: Primary key value
            
        Returns:
            Model instance or None if not found
        """
        with self.session_scope() as session:
            return session.query(model_class).get(id_value)
    
    def update(self, model_class: Type[T], id_value: Any, data: Dict[str, Any]) -> Optional[T]:
        """
        Update record by ID
        
        Args:
            model_class: Model class
            id_value: Primary key value
            data: Update data dictionary
            
        Returns:
            Updated model instance or None if not found
        """
        with self.session_scope() as session:
            instance = session.query(model_class).get(id_value)
            if instance:
                for key, value in data.items():
                    setattr(instance, key, value)
                session.flush()
            return instance
    
    def delete(self, model_class: Type[T], id_value: Any) -> bool:
        """
        Delete record by ID
        
        Args:
            model_class: Model class
            id_value: Primary key value
            
        Returns:
            True if deleted, False if not found
        """
        with self.session_scope() as session:
            instance = session.query(model_class).get(id_value)
            if instance:
                session.delete(instance)
                return True
            return False
    
    def query(self, model_class: Type[T], **filters) -> List[T]:
        """
        Query records with filters
        
        Args:
            model_class: Model class
            **filters: Filter conditions
            
        Returns:
            List of matching records
        """
        with self.session_scope() as session:
            query = session.query(model_class)
            for key, value in filters.items():
                query = query.filter(getattr(model_class, key) == value)
            return query.all()
    
    # ========================================================================
    # OptimizationRun Operations
    # ========================================================================
    
    def create_optimization_run(self, run_data: Dict[str, Any]) -> str:
        """
        Create new optimization run
        
        Args:
            run_data: Run configuration data
            
        Returns:
            Run ID (UUID as string)
            
        Raises:
            ValidationError: If data validation fails
        """
        # Validate run data
        self.validator.validate_optimization_run(run_data)
        
        # Set defaults
        if 'start_time' not in run_data:
            run_data['start_time'] = datetime.now(timezone.utc)
        if 'status' not in run_data:
            run_data['status'] = 'pending'
        
        run = self.create(OptimizationRun, run_data)
        self.logger.info(f"Created optimization run: {run.run_id}")
        return str(run.run_id)
    
    def get_optimization_run(self, run_id: str) -> Optional[OptimizationRun]:
        """Get optimization run by ID"""
        return self.get_by_id(OptimizationRun, run_id)
    
    def update_optimization_run(self, run_id: str, updates: Dict[str, Any]) -> Optional[OptimizationRun]:
        """Update optimization run"""
        return self.update(OptimizationRun, run_id, updates)
    
    def get_optimization_runs(self, **filters) -> List[OptimizationRun]:
        """Get optimization runs with filters"""
        return self.query(OptimizationRun, **filters)
    
    def complete_optimization_run(self, run_id: str, final_metrics: Dict[str, Any]) -> None:
        """Mark optimization run as complete with final metrics"""
        updates = {
            'status': 'completed',
            'end_time': datetime.now(timezone.utc),
            **final_metrics
        }
        self.update_optimization_run(run_id, updates)
        self.logger.info(f"Completed optimization run: {run_id}")
    
    # ========================================================================
    # StrategyVariation Operations
    # ========================================================================
    
    def create_strategy_variation(self, variation_data: Dict[str, Any]) -> str:
        """Create new strategy variation"""
        variation = self.create(StrategyVariation, variation_data)
        return str(variation.variation_id)
    
    def get_strategy_variation(self, variation_id: str) -> Optional[StrategyVariation]:
        """Get strategy variation by ID"""
        return self.get_by_id(StrategyVariation, variation_id)
    
    def update_strategy_variation(self, variation_id: str, updates: Dict[str, Any]) -> Optional[StrategyVariation]:
        """Update strategy variation"""
        return self.update(StrategyVariation, variation_id, updates)
    
    def get_top_variations(self, run_id: str, limit: int = 10) -> List[StrategyVariation]:
        """
        Get top performing variations for a run
        
        Args:
            run_id: Optimization run ID
            limit: Number of top variations to return
            
        Returns:
            List of top variations sorted by ranking score
        """
        with self.session_scope() as session:
            return session.query(StrategyVariation)\
                .filter(StrategyVariation.run_id == run_id)\
                .filter(StrategyVariation.status == 'completed')\
                .order_by(StrategyVariation.ranking_score.desc())\
                .limit(limit)\
                .all()
    
    # ========================================================================
    # SignalEvent Operations
    # ========================================================================
    
    def create_signal_event(self, event_data: Dict[str, Any]) -> str:
        """
        Create new signal event
        
        Args:
            event_data: Signal event data
            
        Returns:
            Event ID
            
        Raises:
            ValidationError: If data validation fails
        """
        # Validate signal event
        self.validator.validate_signal_event(event_data)
        
        event = self.create(SignalEvent, event_data)
        return str(event.event_id)
    
    def get_signal_events(self, **filters) -> List[SignalEvent]:
        """Get signal events with filters"""
        return self.query(SignalEvent, **filters)
    
    def get_signal_events_for_strategy(self, run_id: str, variation_id: Optional[str] = None) -> List[SignalEvent]:
        """Get all signal events for a strategy"""
        filters = {'run_id': run_id}
        if variation_id:
            filters['variation_id'] = variation_id
        return self.query(SignalEvent, **filters)
    
    # ========================================================================
    # TrainingSession Operations
    # ========================================================================
    
    def create_training_session(self, session_data: Dict[str, Any]) -> str:
        """
        Create new training session
        
        Args:
            session_data: Training session data
            
        Returns:
            Session ID
            
        Raises:
            ValidationError: If data validation fails
        """
        # Validate training session
        self.validator.validate_training_session(session_data)
        
        session_obj = self.create(TrainingSession, session_data)
        return str(session_obj.session_id)
    
    def update_training_session(self, session_id: str, updates: Dict[str, Any]) -> Optional[TrainingSession]:
        """Update training session"""
        return self.update(TrainingSession, session_id, updates)
    
    def get_training_sessions(self, **filters) -> List[TrainingSession]:
        """Get training sessions with filters"""
        return self.query(TrainingSession, **filters)
    
    # ========================================================================
    # SessionState Operations (for checkpoints)
    # ========================================================================
    
    def save_session_state(self, run_id: str, state_data: Dict[str, Any]) -> None:
        """
        Save or update session state for checkpoint/resume capability
        
        Args:
            run_id: Optimization run ID
            state_data: State data to save
        """
        with self.session_scope() as session:
            # Try to find existing state
            existing = session.query(SessionState)\
                .filter(SessionState.run_id == run_id)\
                .first()
            
            if existing:
                # Update existing
                for key, value in state_data.items():
                    setattr(existing, key, value)
                existing.last_checkpoint_at = datetime.now(timezone.utc)
            else:
                # Create new
                state_data['run_id'] = run_id
                state = SessionState(**state_data)
                session.add(state)
            
            self.logger.debug(f"Saved session state for run: {run_id}")
    
    def load_session_state(self, run_id: str) -> Optional[SessionState]:
        """Load session state for resuming"""
        with self.session_scope() as session:
            return session.query(SessionState)\
                .filter(SessionState.run_id == run_id)\
                .first()
    
    # ========================================================================
    # Bulk Operations
    # ========================================================================
    
    def bulk_create(self, model_class: Type[T], data_list: List[Dict[str, Any]]) -> List[T]:
        """
        Create multiple records in a single transaction
        
        Args:
            model_class: Model class
            data_list: List of data dictionaries
            
        Returns:
            List of created instances
        """
        with self.session_scope() as session:
            instances = [model_class(**data) for data in data_list]
            session.bulk_save_objects(instances, return_defaults=True)
            return instances
    
    def bulk_update(self, model_class: Type[T], updates: List[Dict[str, Any]]) -> int:
        """
        Update multiple records in a single transaction
        
        Args:
            model_class: Model class
            updates: List of update dictionaries (must include ID field)
            
        Returns:
            Number of records updated
        """
        with self.session_scope() as session:
            count = 0
            for update_data in updates:
                # Extract ID (assumes first column is ID)
                id_column = list(model_class.__table__.primary_key.columns)[0].name
                id_value = update_data.pop(id_column, None)
                
                if id_value:
                    instance = session.query(model_class).get(id_value)
                    if instance:
                        for key, value in update_data.items():
                            setattr(instance, key, value)
                        count += 1
            
            return count
    
    # ========================================================================
    # Utility Methods
    # ========================================================================
    
    def get_pool_status(self) -> Dict[str, Any]:
        """Get connection pool status"""
        return self.pool.get_pool_status()
    
    def close(self) -> Dict[str, Any]:
        """Close database manager and connection pool"""
        return self.pool.close_all()


# Global database manager instance
_db_manager: Optional[DatabaseManager] = None


def get_db_manager() -> DatabaseManager:
    """
    Get global database manager instance (singleton pattern)
    
    Returns:
        DatabaseManager instance
        
    Example:
        db = get_db_manager()
        run_id = db.create_optimization_run({...})
    """
    global _db_manager
    
    if _db_manager is None:
        _db_manager = DatabaseManager()
    
    return _db_manager


def close_db_manager() -> Optional[Dict[str, Any]]:
    """
    Close global database manager
    
    Returns:
        Shutdown metrics if manager exists, None otherwise
    """
    global _db_manager
    
    if _db_manager is not None:
        metrics = _db_manager.close()
        _db_manager = None
        return metrics
    
    return None
