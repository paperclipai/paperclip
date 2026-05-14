"""
Database Initialization
Task 0.4: Database Schema Creation and Index Setup

Creates all tables, indexes, and constraints for Optimizer V3
"""

import logging
from sqlalchemy import create_engine, text
from sqlalchemy.exc import SQLAlchemyError

from .config import get_db_url
from .models import Base

import logging
logger = logging.getLogger(__name__)



logger = logging.getLogger(__name__)


def initialize_database(drop_existing: bool = False) -> bool:
    """
    Initialize database schema with all tables and indexes
    
    Args:
        drop_existing: If True, drops all existing tables before creating
        
    Returns:
        True if successful, False otherwise
        
    Raises:
        SQLAlchemyError: If database initialization fails
    """
    try:
        db_url = get_db_url()
        engine = create_engine(db_url)
        
        logger.info("Initializing database schema...")
        
        # Drop existing tables if requested
        if drop_existing:
            logger.warning("Dropping all existing tables...")
            Base.metadata.drop_all(engine)
            logger.info("Existing tables dropped")
        
        # Create all tables
        logger.info("Creating tables...")
        Base.metadata.create_all(engine)
        logger.info("Tables created successfully")
        
        # Create additional indexes for performance
        logger.info("Creating additional performance indexes...")
        _create_performance_indexes(engine)
        
        # Create database functions and triggers
        logger.info("Creating database functions...")
        _create_database_functions(engine)
        
        logger.info("✅ Database initialization complete")
        return True
        
    except SQLAlchemyError as e:
        logger.error(f"❌ Database initialization failed: {str(e)}")
        raise
    except Exception as e:
        logger.error(f"❌ Unexpected error during initialization: {str(e)}")
        raise


def _create_performance_indexes(engine) -> None:
    """Create additional indexes for query performance"""
    
    indexes = [
        # Optimization runs - compound indexes for common queries
        """
        CREATE INDEX IF NOT EXISTS idx_opt_runs_status_time 
        ON optimization_runs(status, start_time DESC);
        """,
        
        # Strategy variations - performance ranking
        """
        CREATE INDEX IF NOT EXISTS idx_variations_perf_metrics 
        ON strategy_variations(sharpe_ratio DESC, profit_factor DESC, win_rate DESC)
        WHERE status = 'completed';
        """,
        
        # Signal events - time-based queries
        """
        CREATE INDEX IF NOT EXISTS idx_signal_events_name_time_range 
        ON signal_events(signal_name, timestamp DESC);
        """,
        
        # Signal events - outcome analysis
        """
        CREATE INDEX IF NOT EXISTS idx_signal_events_outcomes 
        ON signal_events(signal_name, led_to_trade, trade_result)
        WHERE led_to_trade = true;
        """,
        
        # Signal metrics - latest metrics lookup
        """
        CREATE INDEX IF NOT EXISTS idx_signal_metrics_latest 
        ON signal_metrics(signal_name, end_date DESC);
        """,
        
        # Training sessions - successful sessions
        """
        CREATE INDEX IF NOT EXISTS idx_training_completed 
        ON training_sessions(status, validation_accuracy DESC)
        WHERE status = 'completed';
        """,
        
        # Session states - active sessions
        """
        CREATE INDEX IF NOT EXISTS idx_session_states_progress 
        ON session_states(run_id, progress_percentage);
        """,
        
        # Backtest results - quick lookup
        """
        CREATE INDEX IF NOT EXISTS idx_backtest_variations 
        ON backtest_results(variation_id, start_time DESC);
        """,
    ]
    
    with engine.connect() as conn:
        for idx_sql in indexes:
            try:
                conn.execute(text(idx_sql))
                conn.commit()
            except SQLAlchemyError as e:
                logger.warning(f"Index creation warning: {str(e)}")
                # Continue even if index already exists
    
    logger.info("Performance indexes created")


def _create_database_functions(engine) -> None:
    """Create PostgreSQL functions and triggers for automation"""
    
    functions = [
        # Function to update updated_at timestamp
        """
        CREATE OR REPLACE FUNCTION update_updated_at_column()
        RETURNS TRIGGER AS $$
        BEGIN
            NEW.updated_at = CURRENT_TIMESTAMP;
            RETURN NEW;
        END;
        $$ language 'plpgsql';
        """,
        
        # Function to calculate ranking score
        """
        CREATE OR REPLACE FUNCTION calculate_ranking_score(
            sharpe FLOAT,
            profit_factor FLOAT,
            win_rate FLOAT,
            total_trades INTEGER
        ) RETURNS FLOAT AS $$
        BEGIN
            -- Composite ranking: weighted combination of metrics
            -- Sharpe: 40%, Profit Factor: 30%, Win Rate: 20%, Trade Count: 10%
            RETURN (
                COALESCE(sharpe, 0) * 0.4 +
                COALESCE(profit_factor, 0) * 0.3 +
                COALESCE(win_rate, 0) * 100 * 0.2 +
                LEAST(COALESCE(total_trades, 0) / 100.0, 1.0) * 10 * 0.1
            );
        END;
        $$ LANGUAGE plpgsql IMMUTABLE;
        """,
    ]
    
    triggers = [
        # Trigger for optimization_runs.updated_at
        """
        DROP TRIGGER IF EXISTS update_optimization_runs_updated_at ON optimization_runs;
        CREATE TRIGGER update_optimization_runs_updated_at
            BEFORE UPDATE ON optimization_runs
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column();
        """,
        
        # Trigger for strategy_variations.updated_at
        """
        DROP TRIGGER IF EXISTS update_strategy_variations_updated_at ON strategy_variations;
        CREATE TRIGGER update_strategy_variations_updated_at
            BEFORE UPDATE ON strategy_variations
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column();
        """,
        
        # Trigger for signal_metrics.updated_at
        """
        DROP TRIGGER IF EXISTS update_signal_metrics_updated_at ON signal_metrics;
        CREATE TRIGGER update_signal_metrics_updated_at
            BEFORE UPDATE ON signal_metrics
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column();
        """,
        
        # Trigger for training_sessions.updated_at
        """
        DROP TRIGGER IF EXISTS update_training_sessions_updated_at ON training_sessions;
        CREATE TRIGGER update_training_sessions_updated_at
            BEFORE UPDATE ON training_sessions
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column();
        """,
        
        # Trigger for session_states.updated_at
        """
        DROP TRIGGER IF EXISTS update_session_states_updated_at ON session_states;
        CREATE TRIGGER update_session_states_updated_at
            BEFORE UPDATE ON session_states
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column();
        """,
        
        # Trigger to auto-calculate ranking_score on insert/update
        """
        DROP TRIGGER IF EXISTS calculate_variation_ranking_score ON strategy_variations;
        CREATE TRIGGER calculate_variation_ranking_score
            BEFORE INSERT OR UPDATE ON strategy_variations
            FOR EACH ROW
            EXECUTE FUNCTION (
                SELECT calculate_ranking_score(
                    NEW.sharpe_ratio,
                    NEW.profit_factor,
                    NEW.win_rate,
                    NEW.total_trades
                )
            );
        """,
    ]
    
    with engine.connect() as conn:
        # Create functions
        for func_sql in functions:
            try:
                conn.execute(text(func_sql))
                conn.commit()
            except SQLAlchemyError as e:
                logger.warning(f"Function creation warning: {str(e)}")
        
        # Create triggers
        for trigger_sql in triggers:
            try:
                conn.execute(text(trigger_sql))
                conn.commit()
            except SQLAlchemyError as e:
                logger.warning(f"Trigger creation warning: {str(e)}")
    
    logger.info("Database functions and triggers created")


def verify_schema() -> bool:
    """
    Verify database schema is correctly initialized
    
    Returns:
        True if schema is valid, False otherwise
    """
    try:
        db_url = get_db_url()
        engine = create_engine(db_url)
        
        # Check if all tables exist
        required_tables = [
            'optimization_runs',
            'strategy_variations',
            'signal_events',
            'signal_metrics',
            'training_sessions',
            'session_states',
            'backtest_results'
        ]
        
        with engine.connect() as conn:
            # Query for existing tables
            result = conn.execute(text("""
                SELECT table_name 
                FROM information_schema.tables 
                WHERE table_schema = 'public'
            """))
            
            existing_tables = {row[0] for row in result}
            
            # Check all required tables exist
            missing_tables = set(required_tables) - existing_tables
            
            if missing_tables:
                logger.error(f"Missing tables: {missing_tables}")
                return False
            
            logger.info("✅ Schema verification passed - all tables exist")
            return True
            
    except SQLAlchemyError as e:
        logger.error(f"Schema verification failed: {str(e)}")
        return False


def get_schema_info() -> dict:
    """
    Get information about current database schema
    
    Returns:
        Dictionary with schema information
    """
    try:
        db_url = get_db_url()
        engine = create_engine(db_url)
        
        info = {
            'tables': [],
            'indexes': [],
            'functions': []
        }
        
        with engine.connect() as conn:
            # Get tables
            tables_result = conn.execute(text("""
                SELECT table_name, 
                       pg_size_pretty(pg_total_relation_size(quote_ident(table_name)::regclass)) as size
                FROM information_schema.tables 
                WHERE table_schema = 'public'
                ORDER BY table_name
            """))
            info['tables'] = [
                {'name': row[0], 'size': row[1]} 
                for row in tables_result
            ]
            
            # Get indexes
            indexes_result = conn.execute(text("""
                SELECT indexname, tablename, indexdef
                FROM pg_indexes
                WHERE schemaname = 'public'
                ORDER BY tablename, indexname
            """))
            info['indexes'] = [
                {'name': row[0], 'table': row[1], 'definition': row[2]}
                for row in indexes_result
            ]
            
            # Get functions
            functions_result = conn.execute(text("""
                SELECT routine_name, routine_type
                FROM information_schema.routines
                WHERE routine_schema = 'public'
                ORDER BY routine_name
            """))
            info['functions'] = [
                {'name': row[0], 'type': row[1]}
                for row in functions_result
            ]
        
        return info
        
    except SQLAlchemyError as e:
        logger.error(f"Failed to get schema info: {str(e)}")
        return {'error': str(e)}


if __name__ == '__main__':
    # Setup logging
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )
    
    # Initialize database
    logger.info("Initializing Optimizer V3 Database...")
    success = initialize_database(drop_existing=False)
    
    if success:
        logger.info("\n✅ Database initialized successfully")
        
        # Verify schema
        if verify_schema():
            logger.info("✅ Schema verification passed")
            
            # Show schema info
            info = get_schema_info()
            logger.info(f"\n📊 Schema Information:")
            logger.info(f"Tables: {len(info['tables'])}")
            logger.info(f"Indexes: {len(info['indexes'])}")
            logger.info(f"Functions: {len(info['functions'])}")
        else:
            logger.error("❌ Schema verification failed")
    else:
        logger.error("❌ Database initialization failed")
