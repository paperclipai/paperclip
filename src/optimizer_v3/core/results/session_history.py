"""
Session History System
Task 1.3.12: Track and retrieve optimization session history

Features:
- Query session history from database
- Filter and search sessions
- Session statistics
- Resume session detection
"""

from decimal import Decimal
from typing import List, Dict, Optional
from datetime import datetime, timedelta
from sqlalchemy import create_engine, and_, or_, text
from sqlalchemy.orm import sessionmaker
from dotenv import load_dotenv
import os

import logging
logger = logging.getLogger(__name__)

class SessionHistory:
    """
    Track and retrieve optimization session history
    
    Integrates with database to provide session management
    """
    
    def __init__(self, db_url: Optional[str] = None):
        """
        Initialize session history manager
        
        Args:
            db_url: Database URL (default: from environment)
        """
        load_dotenv()
        
        # Get database URL from environment if not provided
        if db_url is None:
            host = os.getenv('POSTGRES_HOST', 'localhost')
            port = os.getenv('POSTGRES_PORT', '5432')
            database = os.getenv('POSTGRES_DB', 'optimizer_v3')
            user = os.getenv('POSTGRES_USER', 'optimizer_admin')
            password = os.getenv('POSTGRES_PASSWORD', 'secure_password_change_me')
            
            db_url = f"postgresql://{user}:{password}@{host}:{port}/{database}"
        
        self.db_url = db_url
        self.engine = None
        self.Session = None
    
    def connect(self) -> bool:
        """
        Connect to database
        
        Returns:
            True if connected successfully
        """
        try:
            self.engine = create_engine(self.db_url)
            self.Session = sessionmaker(bind=self.engine)
            
            # Test connection
            with self.engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            
            return True
        
        except Exception as e:
            logger.error(f"Database connection error: {e}")
            return False
    
    def get_session_list(self,
                        limit: int = 100,
                        offset: int = 0,
                        status_filter: Optional[str] = None) -> List[Dict]:
        """
        Get list of optimization sessions
        
        Args:
            limit: Maximum number of sessions to return
            offset: Offset for pagination
            status_filter: Filter by status ('running', 'completed', 'failed')
        
        Returns:
            List of session dictionaries
        """
        if not self.engine:
            if not self.connect():
                return []
        
        try:
            with self.Session() as session:
                # Build query (simplified - actual implementation would use SQLAlchemy models)
                query = """
                    SELECT 
                        session_id,
                        start_time,
                        end_time,
                        status,
                        total_configs,
                        completed_configs,
                        strategy_name,
                        created_at,
                        updated_at
                    FROM optimization_sessions
                """
                
                conditions = []
                if status_filter:
                    conditions.append(f"status = '{status_filter}'")
                
                if conditions:
                    query += " WHERE " + " AND ".join(conditions)
                
                query += f" ORDER BY created_at DESC LIMIT {limit} OFFSET {offset}"
                
                result = session.execute(text(query))

                sessions = []
                for row in result:
                    sessions.append({
                        'session_id': row[0],
                        'start_time': row[1],
                        'end_time': row[2],
                        'status': row[3],
                        'total_configs': row[4],
                        'completed_configs': row[5],
                        'strategy_name': row[6],
                        'created_at': row[7],
                        'updated_at': row[8],
                        'progress_pct': (row[5] / row[4] * 100) if row[4] > 0 else 0
                    })
                
                return sessions
        
        except Exception as e:
            logger.error(f"Error retrieving sessions: {e}")
            return []
    
    def get_session_details(self, session_id: str) -> Optional[Dict]:
        """
        Get detailed information for a session
        
        Args:
            session_id: Session identifier
        
        Returns:
            Session details dictionary or None
        """
        if not self.engine:
            if not self.connect():
                return None
        
        try:
            with self.Session() as session:
                query = """
                    SELECT 
                        session_id,
                        start_time,
                        end_time,
                        status,
                        total_configs,
                        completed_configs,
                        strategy_name,
                        config_snapshot,
                        results_summary,
                        created_at,
                        updated_at
                    FROM optimization_sessions
                    WHERE session_id = :session_id
                """
                
                result = session.execute(text(query), {'session_id': session_id})
                row = result.fetchone()
                
                if not row:
                    return None
                
                return {
                    'session_id': row[0],
                    'start_time': row[1],
                    'end_time': row[2],
                    'status': row[3],
                    'total_configs': row[4],
                    'completed_configs': row[5],
                    'strategy_name': row[6],
                    'config_snapshot': row[7],
                    'results_summary': row[8],
                    'created_at': row[9],
                    'updated_at': row[10],
                    'duration': (row[2] - row[1]) if row[2] else None,
                    'progress_pct': (row[5] / row[4] * 100) if row[4] > 0 else 0
                }
        
        except Exception as e:
            logger.error(f"Error retrieving session details: {e}")
            return None
    
    def get_interrupted_sessions(self) -> List[Dict]:
        """
        Find sessions that were interrupted (running but not updated recently)
        
        Returns:
            List of interrupted session dictionaries
        """
        if not self.engine:
            if not self.connect():
                return []
        
        try:
            # Consider a session interrupted if status is 'running'
            # but it hasn't been updated in the last hour
            cutoff_time = datetime.now() - timedelta(hours=1)
            
            with self.Session() as session:
                query = """
                    SELECT 
                        session_id,
                        start_time,
                        status,
                        total_configs,
                        completed_configs,
                        strategy_name,
                        updated_at
                    FROM optimization_sessions
                    WHERE status = 'running'
                    AND updated_at < :cutoff_time
                    ORDER BY updated_at DESC
                """
                
                result = session.execute(text(query), {'cutoff_time': cutoff_time})

                interrupted = []
                for row in result:
                    interrupted.append({
                        'session_id': row[0],
                        'start_time': row[1],
                        'status': row[2],
                        'total_configs': row[3],
                        'completed_configs': row[4],
                        'strategy_name': row[5],
                        'last_updated': row[6],
                        'progress_pct': (row[4] / row[3] * 100) if row[3] > 0 else 0,
                        'can_resume': True
                    })
                
                return interrupted
        
        except Exception as e:
            logger.error(f"Error finding interrupted sessions: {e}")
            return []
    
    def get_recent_sessions(self, hours: int = 24) -> List[Dict]:
        """
        Get sessions from the last N hours
        
        Args:
            hours: Number of hours to look back
        
        Returns:
            List of recent sessions
        """
        if not self.engine:
            if not self.connect():
                return []
        
        try:
            cutoff_time = datetime.now() - timedelta(hours=hours)
            
            with self.Session() as session:
                query = """
                    SELECT 
                        session_id,
                        start_time,
                        end_time,
                        status,
                        total_configs,
                        completed_configs,
                        strategy_name,
                        created_at
                    FROM optimization_sessions
                    WHERE created_at >= :cutoff_time
                    ORDER BY created_at DESC
                """
                
                result = session.execute(text(query), {'cutoff_time': cutoff_time})

                sessions = []
                for row in result:
                    sessions.append({
                        'session_id': row[0],
                        'start_time': row[1],
                        'end_time': row[2],
                        'status': row[3],
                        'total_configs': row[4],
                        'completed_configs': row[5],
                        'strategy_name': row[6],
                        'created_at': row[7]
                    })
                
                return sessions
        
        except Exception as e:
            logger.error(f"Error retrieving recent sessions: {e}")
            return []
    
    def search_sessions(self, 
                       strategy_name: Optional[str] = None,
                       start_date: Optional[datetime] = None,
                       end_date: Optional[datetime] = None,
                       min_configs: Optional[int] = None) -> List[Dict]:
        """
        Search sessions with filters
        
        Args:
            strategy_name: Filter by strategy name (partial match)
            start_date: Filter sessions after this date
            end_date: Filter sessions before this date
            min_configs: Minimum number of configs tested
        
        Returns:
            List of matching sessions
        """
        if not self.engine:
            if not self.connect():
                return []
        
        try:
            with self.Session() as session:
                query = "SELECT * FROM optimization_sessions WHERE 1=1"
                params = {}
                
                if strategy_name:
                    query += " AND strategy_name LIKE :strategy_name"
                    params['strategy_name'] = f"%{strategy_name}%"
                
                if start_date:
                    query += " AND start_time >= :start_date"
                    params['start_date'] = start_date
                
                if end_date:
                    query += " AND start_time <= :end_date"
                    params['end_date'] = end_date
                
                if min_configs:
                    query += " AND total_configs >= :min_configs"
                    params['min_configs'] = min_configs
                
                query += " ORDER BY start_time DESC"
                
                result = session.execute(text(query), params)

                sessions = []
                for row in result:
                    sessions.append(dict(row._mapping))
                
                return sessions
        
        except Exception as e:
            logger.error(f"Error searching sessions: {e}")
            return []
    
    def get_session_statistics(self) -> Dict:
        """
        Get overall session statistics
        
        Returns:
            Dictionary with statistics
        """
        if not self.engine:
            if not self.connect():
                return {}
        
        try:
            with self.Session() as session:
                # Total sessions
                total_query = "SELECT COUNT(*) FROM optimization_sessions"
                total = session.execute(text(total_query)).scalar()

                # By status
                status_query = """
                    SELECT status, COUNT(*)
                    FROM optimization_sessions
                    GROUP BY status
                """
                status_result = session.execute(text(status_query))
                status_counts = {row[0]: row[1] for row in status_result}

                # Recent activity (last 7 days)
                recent_query = """
                    SELECT COUNT(*)
                    FROM optimization_sessions
                    WHERE created_at >= NOW() - INTERVAL '7 days'
                """
                recent_count = session.execute(text(recent_query)).scalar()

                # Average configs per session
                avg_configs_query = """
                    SELECT AVG(total_configs)
                    FROM optimization_sessions
                    WHERE status = 'completed'
                """
                avg_configs = session.execute(text(avg_configs_query)).scalar()
                
                return {
                    'total_sessions': total,
                    'by_status': status_counts,
                    'recent_7_days': recent_count,
                    'avg_configs_per_session': float(avg_configs) if avg_configs else 0,
                    'interrupted_sessions': status_counts.get('running', 0)
                }
        
        except Exception as e:
            logger.error(f"Error retrieving statistics: {e}")
            return {}
    
    def mark_session_resumable(self, session_id: str) -> bool:
        """
        Mark a session as resumable
        
        Args:
            session_id: Session identifier
        
        Returns:
            True if marked successfully
        """
        if not self.engine:
            if not self.connect():
                return False
        
        try:
            with self.Session() as session:
                query = """
                    UPDATE optimization_sessions
                    SET status = 'interrupted', 
                        updated_at = NOW()
                    WHERE session_id = :session_id
                """
                
                session.execute(text(query), {'session_id': session_id})
                session.commit()

                return True

        except Exception as e:
            logger.error(f"Error marking session as resumable: {e}")
            return False
    
    def update_session_progress(self,
                               session_id: str,
                               completed_configs: int,
                               current_best: Optional[Dict] = None) -> bool:
        """
        Update session progress
        
        Args:
            session_id: Session identifier
            completed_configs: Number of completed configurations
            current_best: Current best result (optional)
        
        Returns:
            True if updated successfully
        """
        if not self.engine:
            if not self.connect():
                return False
        
        try:
            with self.Session() as session:
                query = """
                    UPDATE optimization_sessions
                    SET completed_configs = :completed,
                        results_summary = :summary,
                        updated_at = NOW()
                    WHERE session_id = :session_id
                """
                
                params = {
                    'session_id': session_id,
                    'completed': completed_configs,
                    'summary': str(current_best) if current_best else None
                }
                
                session.execute(text(query), params)
                session.commit()

                return True

        except Exception as e:
            logger.error(f"Error updating session progress: {e}")
            return False
    
    def delete_old_sessions(self, days: int = 90) -> int:
        """
        Delete sessions older than specified days
        
        Args:
            days: Delete sessions older than this many days
        
        Returns:
            Number of sessions deleted
        """
        if not self.engine:
            if not self.connect():
                return 0
        
        try:
            cutoff_date = datetime.now() - timedelta(days=days)
            
            with self.Session() as session:
                # Only delete completed sessions older than cutoff
                query = """
                    DELETE FROM optimization_sessions
                    WHERE status = 'completed'
                    AND end_time < :cutoff_date
                """
                
                result = session.execute(text(query), {'cutoff_date': cutoff_date})
                session.commit()
                
                return result.rowcount
        
        except Exception as e:
            logger.error(f"Error deleting old sessions: {e}")
            return 0
    
    def close(self):
        """Close database connection"""
        if self.engine:
            self.engine.dispose()
