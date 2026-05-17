"""
Database Connection Pool Management
Task 0.3: Connection Pooling with Retry Logic and Monitoring

Manages PostgreSQL connections with:
- SQLAlchemy connection pooling
- Automatic retry logic with exponential backoff
- Connection metrics tracking
- Resource cleanup
"""

import logging
import time
from collections import defaultdict
from datetime import datetime
from typing import Optional, Dict, Any
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker, scoped_session, Session
from sqlalchemy.pool import QueuePool
from sqlalchemy.exc import OperationalError, DatabaseError

from .config import get_db_config, get_db_url

import logging
logger = logging.getLogger(__name__)



class DatabaseMetrics:
    """Track database connection and performance metrics"""
    
    def __init__(self):
        """Initialize metrics tracking"""
        self.total_connections = 0
        self.active_connections = 0
        self.failed_connections = 0
        self.connection_errors: Dict[str, int] = defaultdict(int)
        self.last_error_time: Optional[datetime] = None
        self.start_time = datetime.now()
        self.total_queries = 0
        self.failed_queries = 0
    
    def record_connection_success(self) -> None:
        """Record successful connection"""
        self.total_connections += 1
        self.active_connections += 1
    
    def record_connection_failure(self, error: Optional[Exception] = None) -> None:
        """Record connection failure"""
        self.failed_connections += 1
        if error:
            error_type = type(error).__name__
            self.connection_errors[error_type] += 1
            self.last_error_time = datetime.now()
    
    def record_connection_close(self) -> None:
        """Record connection close"""
        if self.active_connections > 0:
            self.active_connections -= 1
    
    def record_query_success(self) -> None:
        """Record successful query execution"""
        self.total_queries += 1
    
    def record_query_failure(self) -> None:
        """Record failed query execution"""
        self.failed_queries += 1
    
    def record_pool_shutdown(self) -> Dict[str, Any]:
        """
        Record pool shutdown metrics
        
        Returns:
            Dictionary containing shutdown metrics
        """
        self.active_connections = 0
        uptime = datetime.now() - self.start_time
        return {
            'total_connections': self.total_connections,
            'failed_connections': self.failed_connections,
            'total_queries': self.total_queries,
            'failed_queries': self.failed_queries,
            'error_types': dict(self.connection_errors),
            'uptime_seconds': uptime.total_seconds()
        }
    
    def get_stats(self) -> Dict[str, Any]:
        """
        Get current statistics
        
        Returns:
            Dictionary containing current metrics
        """
        uptime = datetime.now() - self.start_time
        return {
            'total_connections': self.total_connections,
            'active_connections': self.active_connections,
            'failed_connections': self.failed_connections,
            'total_queries': self.total_queries,
            'failed_queries': self.failed_queries,
            'error_types': dict(self.connection_errors),
            'last_error_time': self.last_error_time.isoformat() if self.last_error_time else None,
            'uptime_seconds': uptime.total_seconds()
        }


class DatabaseConnectionPool:
    """
    Manage PostgreSQL connections with pooling, monitoring, and retry logic
    
    Features:
    - SQLAlchemy connection pooling with QueuePool
    - Automatic retry with exponential backoff
    - Connection health verification
    - Comprehensive metrics tracking
    - Proper resource cleanup
    
    Example:
        pool = DatabaseConnectionPool()
        session = pool.get_session()
        try:
            result = session.execute(text("SELECT 1"))
            session.commit()
        finally:
            session.close()
    """
    
    MAX_RETRIES = 3
    RETRY_DELAY = 1  # seconds
    
    def __init__(self):
        """Initialize database connection pool"""
        self.logger = logging.getLogger(__name__)
        self.metrics = DatabaseMetrics()
        self._engine = None
        self._session_factory = None
        self._initialize_pool()
    
    def _initialize_pool(self) -> None:
        """Initialize SQLAlchemy engine and session factory"""
        try:
            config = get_db_config()
            db_url = get_db_url()
            
            self.logger.info(
                f"Initializing database connection pool: "
                f"{config['host']}:{config['port']}/{config['database']}"
            )
            
            # Create engine with connection pooling
            self._engine = create_engine(
                db_url,
                poolclass=QueuePool,
                pool_size=config['pool_size'],
                max_overflow=config['max_overflow'],
                pool_timeout=config['pool_timeout'],
                pool_recycle=config['pool_recycle'],
                pool_pre_ping=True,  # Verify connections before using
                echo=False,  # Set to True for SQL debugging
            )
            
            # Create session factory
            self._session_factory = scoped_session(
                sessionmaker(
                    bind=self._engine,
                    autocommit=False,
                    autoflush=False,
                    expire_on_commit=False
                )
            )
            
            # Verify connection
            self._verify_connection()
            
            self.logger.info(
                f"Connection pool initialized: "
                f"size={config['pool_size']}, "
                f"max_overflow={config['max_overflow']}"
            )
            
        except Exception as e:
            self.logger.error(f"Failed to initialize connection pool: {str(e)}")
            self.metrics.record_connection_failure(e)
            raise
    
    def _verify_connection(self) -> None:
        """Verify database connection is working"""
        try:
            with self._engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            self.logger.info("Database connection verified")
        except Exception as e:
            self.logger.error(f"Connection verification failed: {str(e)}")
            raise
    
    def get_session(self) -> Session:
        """
        Get a database session with retry logic and monitoring
        
        Returns:
            SQLAlchemy Session object
        
        Raises:
            ConnectionError: If max retries exceeded
        
        Example:
            session = pool.get_session()
            try:
                # Use session
                session.commit()
            except Exception:
                session.rollback()
                raise
            finally:
                session.close()
        """
        attempt = 0
        last_error = None
        
        while attempt < self.MAX_RETRIES:
            try:
                session = self._session_factory()
                
                # Verify connection is alive with a simple query
                session.execute(text("SELECT 1"))
                
                self.metrics.record_connection_success()
                self.metrics.record_query_success()
                
                return session
                
            except (OperationalError, DatabaseError) as e:
                attempt += 1
                last_error = e
                self.metrics.record_connection_failure(e)
                
                self.logger.warning(
                    f"Connection attempt {attempt}/{self.MAX_RETRIES} failed: {str(e)}"
                )
                
                if attempt < self.MAX_RETRIES:
                    # Exponential backoff
                    delay = self.RETRY_DELAY * (2 ** (attempt - 1))
                    self.logger.info(f"Retrying in {delay} seconds...")
                    time.sleep(delay)
                
                # Clean up failed session
                try:
                    session.close()
                except:
                    pass
        
        # Max retries exceeded
        error_msg = f"Failed to get session after {self.MAX_RETRIES} attempts: {last_error}"
        self.logger.error(error_msg)
        raise ConnectionError(error_msg)
    
    def close_all(self) -> Dict[str, Any]:
        """
        Close all connections and cleanup resources
        
        Returns:
            Dictionary containing shutdown metrics
        """
        try:
            self.logger.info("Shutting down connection pool...")
            
            # Remove scoped session
            if self._session_factory:
                self._session_factory.remove()
            
            # Dispose engine and close all connections
            if self._engine:
                self._engine.dispose()
            
            shutdown_metrics = self.metrics.record_pool_shutdown()
            
            self.logger.info(
                f"Connection pool shutdown complete: "
                f"total_connections={shutdown_metrics['total_connections']}, "
                f"failed_connections={shutdown_metrics['failed_connections']}, "
                f"uptime={shutdown_metrics['uptime_seconds']:.2f}s"
            )
            
            return shutdown_metrics
            
        except Exception as e:
            self.logger.error(f"Error during pool shutdown: {str(e)}")
            raise
    
    def get_pool_status(self) -> Dict[str, Any]:
        """
        Get current pool status
        
        Returns:
            Dictionary containing pool status information
        """
        if not self._engine:
            return {'status': 'not_initialized'}
        
        pool = self._engine.pool
        return {
            'status': 'active',
            'size': pool.size(),
            'checked_in': pool.checkedin(),
            'checked_out': pool.checkedout(),
            'overflow': pool.overflow(),
            'metrics': self.metrics.get_stats()
        }
    
    @property
    def engine(self):
        """Get SQLAlchemy engine"""
        return self._engine
    
    @property
    def session_factory(self):
        """Get session factory"""
        return self._session_factory


# Global connection pool instance
_connection_pool: Optional[DatabaseConnectionPool] = None


def get_connection_pool() -> DatabaseConnectionPool:
    """
    Get global connection pool instance (singleton pattern)
    
    Returns:
        DatabaseConnectionPool instance
    
    Example:
        pool = get_connection_pool()
        session = pool.get_session()
    """
    global _connection_pool
    
    if _connection_pool is None:
        _connection_pool = DatabaseConnectionPool()
    
    return _connection_pool


def close_connection_pool() -> Optional[Dict[str, Any]]:
    """
    Close global connection pool
    
    Returns:
        Shutdown metrics if pool exists, None otherwise
    """
    global _connection_pool
    
    if _connection_pool is not None:
        metrics = _connection_pool.close_all()
        _connection_pool = None
        return metrics
    
    return None
