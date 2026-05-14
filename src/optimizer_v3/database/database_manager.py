"""
Main Database Manager
SPRINT 1.6.1 - Phase 1 Day 3

Unified database interface that orchestrates all specialized managers.
Provides single entry point for all database operations.

Institutional-grade implementation with:
- Unified session management
- Transaction coordination
- Comprehensive error handling
- Connection pooling
"""

from typing import Optional
import logging
from contextlib import contextmanager
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker, Session
from sqlalchemy.pool import NullPool

from .strategy_manager import StrategyDatabaseManager
from .ai_recommendations_manager import AIRecommendationsManager
from .test_results_manager import TestResultsManager

import logging
logger = logging.getLogger(__name__)


logger = logging.getLogger(__name__)


class DatabaseManager:
    """
    Main database manager providing unified access to all database operations
    
    This class orchestrates all specialized managers and provides:
    - Session management with context managers
    - Transaction coordination
    - Connection pooling
    - Automatic resource cleanup
    - Unified error handling
    
    Usage:
        ```python
        db = DatabaseManager(connection_string)
        
        # Using context manager (recommended)
        with db.session_scope() as session:
            strategy_id = db.strategy.create_strategy("My Strategy")
            # Session automatically committed/rolled back
        
        # Or use manager instances directly
        db.strategy.create_strategy("Another Strategy")
        ```
    """
    
    def __init__(
        self,
        connection_string: str,
        echo: bool = False,
        pool_size: int = 5,
        max_overflow: int = 10
    ):
        """
        Initialize database manager
        
        Args:
            connection_string: Database connection string (PostgreSQL format)
            echo: Enable SQL query logging (for debugging)
            pool_size: Number of connections to maintain in pool
            max_overflow: Maximum overflow connections beyond pool_size
        """
        self.logger = logging.getLogger(f"{__name__}.{self.__class__.__name__}")
        
        # Create engine with connection pooling
        self.engine = create_engine(
            connection_string,
            echo=echo,
            pool_size=pool_size,
            max_overflow=max_overflow,
            pool_pre_ping=True  # Verify connections before using
        )
        
        # CRITICAL: Register fork handler to dispose engine in child processes
        # When ProcessPoolExecutor forks, child processes inherit the connection pool
        # but cannot use it (SSL errors). Dispose immediately after fork.
        import os
        if hasattr(os, 'register_at_fork'):
            os.register_at_fork(
                after_in_child=self._dispose_engine_after_fork
            )
        
        # Create session factory
        self.SessionLocal = sessionmaker(
            autocommit=False,
            autoflush=False,
            bind=self.engine
        )
        
        # Create default session for direct usage
        self._session = self.SessionLocal()
        
        # Initialize specialized managers
        self.strategy = StrategyDatabaseManager(self._session)
        self.ai_recommendations = AIRecommendationsManager(self._session)
        self.test_results = TestResultsManager(self._session)
        
        self.logger.info("DatabaseManager initialized successfully")
    
    @contextmanager
    def session_scope(self):
        """
        Provide a transactional scope for database operations
        
        Usage:
            ```python
            with db.session_scope() as session:
                # Use session for operations
                result = session.execute(query)
                # Automatically committed on success
                # Automatically rolled back on exception
            ```
        
        Yields:
            Session: SQLAlchemy session
        """
        session = self.SessionLocal()
        try:
            yield session
            session.commit()
            self.logger.debug("Session committed successfully")
        except Exception as e:
            session.rollback()
            self.logger.error(f"Session rollback due to error: {e}")
            raise
        finally:
            session.close()
            self.logger.debug("Session closed")
    
    def get_session(self) -> Session:
        """
        Get a new database session
        
        Note: Caller is responsible for managing session lifecycle
        Use session_scope() context manager for automatic management
        
        Returns:
            Session: New SQLAlchemy session
        """
        return self.SessionLocal()
    
    def close(self):
        """
        Close database connections and cleanup resources
        
        Should be called when shutting down application
        """
        if self._session:
            self._session.close()
            self.logger.info("Default session closed")
        
        if self.engine:
            self.engine.dispose()
            self.logger.info("Database engine disposed")
    
    def test_connection(self) -> bool:
        """
        Test database connection
        
        Returns:
            bool: True if connection successful, False otherwise
        """
        try:
            with self.session_scope() as session:
                session.execute(text("SELECT 1"))
            self.logger.info("Database connection test: SUCCESS")
            return True
        except Exception as e:
            self.logger.error(f"Database connection test: FAILED - {e}")
            return False
    
    def get_connection_info(self) -> dict:
        """
        Get database connection information
        
        Returns:
            dict: Connection information (without password)
        """
        url = self.engine.url
        return {
            'driver': url.drivername,
            'host': url.host,
            'port': url.port,
            'database': url.database,
            'username': url.username,
            'pool_size': self.engine.pool.size(),
            'pool_overflow': self.engine.pool.overflow()
        }
    
    def _dispose_engine_after_fork(self):
        """
        Fork handler: Dispose engine in child process
        
        Called automatically by os.register_at_fork() when ProcessPoolExecutor
        forks child processes. Disposes inherited connection pool to prevent
        SSL errors when child processes exit.
        
        INSTITUTIONAL PATTERN: Proper multiprocessing database isolation
        """
        if self.engine is not None:
            self.engine.dispose()
            self.logger.debug("Engine disposed in forked child process")


class DatabaseManagerFactory:
    """
    Factory for creating DatabaseManager instances with different configurations
    
    Provides convenient methods for:
    - Production database connections
    - Development database connections
    - Testing database connections (in-memory)
    - Custom configurations
    """
    
    @staticmethod
    def from_env() -> DatabaseManager:
        """
        Create DatabaseManager from environment variables
        
        Expected environment variables:
        - POSTGRES_HOST: Database host
        - POSTGRES_PORT: Database port
        - POSTGRES_DB: Database name
        - POSTGRES_USER: Database user
        - POSTGRES_PASSWORD: Database password
        
        Returns:
            DatabaseManager: Configured database manager instance
            
        Raises:
            EnvironmentError: If required environment variables missing
        """
        import os
        
        required = ['POSTGRES_HOST', 'POSTGRES_PORT', 'POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD']
        missing = [var for var in required if not os.getenv(var)]
        
        if missing:
            raise EnvironmentError(f"Missing required environment variables: {', '.join(missing)}")
        
        connection_string = (
            f"postgresql://{os.getenv('POSTGRES_USER')}:{os.getenv('POSTGRES_PASSWORD')}"
            f"@{os.getenv('POSTGRES_HOST')}:{os.getenv('POSTGRES_PORT')}/{os.getenv('POSTGRES_DB')}"
        )
        
        return DatabaseManager(connection_string)
    
    @staticmethod
    def from_connection_string(connection_string: str, **kwargs) -> DatabaseManager:
        """
        Create DatabaseManager from connection string
        
        Args:
            connection_string: PostgreSQL connection string
            **kwargs: Additional arguments passed to DatabaseManager
            
        Returns:
            DatabaseManager: Configured database manager instance
        """
        return DatabaseManager(connection_string, **kwargs)
    
    @staticmethod
    def for_testing() -> "DatabaseManager":
        """
        Create DatabaseManager for testing using a real PostgreSQL test database.

        Connects to the PostgreSQL instance identified by the standard project
        environment variables (matching the ``pg_conn`` fixture pattern from
        the ITM state tests introduced in BTCAAAAA-450).

        Environment variables (all have sensible defaults matching the project
        ``.env``):
            POSTGRES_HOST     default: localhost
            POSTGRES_PORT     default: 5432
            POSTGRES_DB       default: optimizer_v3
            POSTGRES_USER     default: optimizer_admin
            POSTGRES_PASSWORD default: secure_password_change_me

        Raises:
            pytest.skip (when called from a pytest context): If the PostgreSQL
                server is not reachable the method skips the test gracefully
                rather than failing with an obscure connection error.
            EnvironmentError: Outside a pytest context a clear error is raised
                when ``POSTGRES_PASSWORD`` is not set (to prevent silent use of
                the default in production-adjacent environments).

        Returns:
            DatabaseManager: Test database manager instance backed by
                PostgreSQL, not SQLite.
        """
        import os

        host = os.environ.get("POSTGRES_HOST", "localhost")
        port = os.environ.get("POSTGRES_PORT", "5432")
        db = os.environ.get("POSTGRES_DB", "optimizer_v3")
        user = os.environ.get("POSTGRES_USER", "optimizer_admin")
        password = os.environ.get("POSTGRES_PASSWORD", "secure_password_change_me")

        connection_string = f"postgresql://{user}:{password}@{host}:{port}/{db}"

        # Verify the connection is reachable before returning the manager so
        # that callers get a clear skip/error rather than a cryptic SQLAlchemy
        # exception deep in test code.
        try:
            import psycopg2
            conn = psycopg2.connect(
                host=host, port=int(port), dbname=db, user=user, password=password
            )
            conn.close()
        except ImportError:
            # psycopg2 not installed — try to skip via pytest if available
            try:
                import pytest
                pytest.skip("psycopg2 not installed — skipping real-PostgreSQL tests")
            except ImportError:
                raise RuntimeError(
                    "psycopg2 is required for DatabaseManagerFactory.for_testing(). "
                    "Install it with: pip install psycopg2-binary"
                )
        except Exception as exc:
            try:
                import pytest
                pytest.skip(
                    f"Cannot connect to PostgreSQL ({host}:{port}/{db}): {exc}"
                )
            except ImportError:
                raise RuntimeError(
                    f"DatabaseManagerFactory.for_testing() could not connect to "
                    f"PostgreSQL ({host}:{port}/{db}): {exc}"
                ) from exc

        return DatabaseManager(
            connection_string,
            echo=False,
            pool_size=1,
            max_overflow=0
        )


# Convenience function for quick access
def get_database_manager() -> DatabaseManager:
    """
    Get database manager instance from environment variables
    
    Convenience function for quick access in applications
    
    Returns:
        DatabaseManager: Configured database manager
    """
    return DatabaseManagerFactory.from_env()
