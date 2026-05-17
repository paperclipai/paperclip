"""
Strategy Database Manager
SPRINT 1.6.1 - Phase 1 Day 2

Manages strategy versioning, CRUD operations, and duplicate detection
for DATABASE-FIRST architecture.

Institutional-grade implementation with:
- Complete version tracking
- SHA-256 hash for duplicate detection
- Git commit integration
- Transaction safety
"""

from typing import Optional, List, Dict, Any
from uuid import uuid4
from datetime import datetime, timezone
import hashlib
import json
import logging
from sqlalchemy.orm import Session
from sqlalchemy import and_, desc, text

import logging
logger = logging.getLogger(__name__)


logger = logging.getLogger(__name__)


class StrategyDatabaseManager:
    """
    Database manager for strategy versioning and persistence
    
    Provides complete CRUD operations for strategies with:
    - Automatic version numbering
    - Duplicate detection via config hash
    - Git commit tracking
    - Complete audit trail
    """
    
    def __init__(self, db_session: Session):
        """
        Initialize strategy database manager
        
        Args:
            db_session: SQLAlchemy session for database operations
        """
        self.session = db_session
        self.logger = logging.getLogger(f"{__name__}.{self.__class__.__name__}")
    
    def create_strategy(self, name: str) -> str:
        """
        Create new strategy parent record using ORM
        
        Args:
            name: Strategy name (will be stripped of whitespace)
            
        Returns:
            strategy_id: Unique strategy identifier (strategy_XXXXXXXX format)
            
        Raises:
            ValueError: If name is empty after stripping
            IntegrityError: If strategy with this ID already exists (extremely rare)
            
        Real Money Impact: HIGH - Creates parent record for trading strategy
        
        ORM Refactored: Sprint 1.6.1 Task 1.1
        """
        # Import Strategy ORM model
        from src.optimizer_v3.database.models import Strategy
        
        # Validation
        name_clean = name.strip() if name else ''
        if not name_clean:
            raise ValueError("Strategy name cannot be empty")
        
        # Generate unique strategy ID
        strategy_id = f"strategy_{uuid4().hex[:8]}"
        
        # Create ORM object
        strategy = Strategy(
            strategy_id=strategy_id,
            name=name_clean
            # created_at, updated_at handled by server defaults
        )
        
        # Add to session and commit
        try:
            self.session.add(strategy)
            self.session.commit()
            
            self.logger.info(f"Created strategy: {strategy_id} - {name_clean}")
            return strategy_id
            
        except Exception as e:
            # Rollback on error to prevent transaction lock
            self.session.rollback()
            self.logger.error(f"Failed to create strategy '{name_clean}': {e}")
            raise
    
    def create_strategy_version(self, strategy_data: Dict[str, Any]) -> str:
        """
        Create new strategy version with complete configuration using ORM
        
        Args:
            strategy_data: Complete strategy configuration including:
                - strategy_id (str): Parent strategy ID
                - name (str): Strategy name
                - description (str, optional): Strategy description
                - blocks (list): Building blocks configuration
                - signals (dict): Signal configurations
                - parameters (dict): Strategy parameters
                - entry_conditions (dict): Entry logic
                - exit_conditions (dict): Exit logic
                - risk_management (dict): Risk management settings
                - backtest_config (dict): Backtest configuration
                - backtest_results (dict, optional): Backtest results
                - metrics (dict, optional): Performance metrics
                - trades (list, optional): Trade list
                -equity_curve (list, optional): Equity curve data
                - tags (list, optional): Tags for organization
                - notes (str, optional): Version notes
                - created_by (str, optional): User who created version
                - git_commit_hash (str, optional): Git commit hash
                
        Returns:
            version_id: UUID string of created version
            
        Raises:
            ValueError: If required fields missing or invalid
            
        Real Money Impact: CRITICAL - Stores complete trading strategy configuration
        
        ORM Refactored: Sprint 1.6.1 Task 1.2
        """
        # Import StrategyVersion ORM model
        from src.optimizer_v3.database.models import StrategyVersion, Strategy
        
        # Validate required fields
        required_fields = [
            'strategy_id', 'name', 'blocks', 'signals', 'parameters',
            'entry_conditions', 'exit_conditions', 'risk_management', 'backtest_config'
        ]
        
        missing_fields = [f for f in required_fields if f not in strategy_data]
        if missing_fields:
            raise ValueError(f"Missing required fields: {', '.join(missing_fields)}")
        
        # Calculate config hash for duplicate detection
        config_hash = self.calculate_config_hash(strategy_data)
        
        # Get next version number for this strategy
        version_number = self._get_next_version_number(strategy_data['strategy_id'])
        
        # Create ORM object
        # CRITICAL: SQLAlchemy automatically handles JSON serialization for JSONB columns
        # No need for json.dumps() - just pass Python dicts/lists directly
        strategy_version = StrategyVersion(
            strategy_id=strategy_data['strategy_id'],
            version_number=version_number,
            name=strategy_data['name'],
            description=strategy_data.get('description', ''),
            strategy_type=strategy_data.get('strategy_type', 'Bullish'),  # Sprint 1.9: Bullish/Bearish
            # Required JSONB fields - SQLAlchemy handles serialization
            blocks=strategy_data['blocks'],
            signals=strategy_data['signals'],
            parameters=strategy_data['parameters'],
            entry_conditions=strategy_data['entry_conditions'],
            exit_conditions=strategy_data['exit_conditions'],
            risk_management=strategy_data['risk_management'],
            backtest_config=strategy_data['backtest_config'],
            # Optional JSONB fields
            backtest_results=strategy_data.get('backtest_results'),
            metrics=strategy_data.get('metrics'),
            trades=strategy_data.get('trades'),
            equity_curve=strategy_data.get('equity_curve'),
            # Metadata fields
            git_commit_hash=strategy_data.get('git_commit_hash'),
            created_by=strategy_data.get('created_by'),
            notes=strategy_data.get('notes'),
            tags=strategy_data.get('tags', []),
            config_hash=config_hash
            # version_id, timestamp, created_at handled by defaults
        )
        
        # Add to session and commit
        try:
            self.session.add(strategy_version)
            
            # Update parent strategy updated_at timestamp
            parent_strategy = self.session.query(Strategy).filter_by(
                strategy_id=strategy_data['strategy_id']
            ).first()
            
            if parent_strategy:
                # Trigger updated_at by setting a field (onupdate will handle timestamp)
                parent_strategy.updated_at = datetime.now(timezone.utc)
            
            self.session.commit()
            
            # Get version_id as string (UUID object converted to string)
            version_id = str(strategy_version.version_id)
            
            self.logger.info(
                f"Created strategy version: {version_id} "
                f"(strategy: {strategy_data['strategy_id']}, version: {version_number})"
            )
            
            return version_id
            
        except Exception as e:
            # CRITICAL: Rollback on error to prevent transaction lock
            self.session.rollback()
            self.logger.error(f"Failed to create strategy version: {e}")
            raise
    
    def get_strategy_version(self, version_id: str) -> Optional[Dict[str, Any]]:
        """
        Get complete strategy version by version ID using ORM
        
        Args:
            version_id: Version UUID string
            
        Returns:
            Complete strategy version dict or None if not found
            Dict includes all fields with JSONB data as Python objects
            
        Real Money Impact: HIGH - Retrieves complete trading strategy configuration
        
        ORM Refactored: Sprint 1.6.1 Task 1.3
        """
        # Import StrategyVersion ORM model
        from src.optimizer_v3.database.models import StrategyVersion
        
        # Expire the identity-map so SQLAlchemy issues a fresh SELECT rather than
        # returning a cached in-memory object.  We intentionally do NOT call
        # self.session.rollback() here: an unconditional rollback would undo any
        # data committed earlier in the *same* session (e.g. create_strategy_version
        # called just before this method), causing the query to return None even
        # when the row was successfully written.  expire_all() achieves the same
        # cache-busting goal without discarding uncommitted writes.
        self.session.expire_all()
        
        try:
            # Query using ORM
            version = self.session.query(StrategyVersion).filter_by(
                version_id=version_id
            ).first()
            
            if not version:
                return None
            
            # Convert ORM object to dict for backwards compatibility
            # JSONB fields are automatically deserialized to Python objects by SQLAlchemy
            version_dict = {
                'version_id': str(version.version_id),  # UUID to string
                'strategy_id': version.strategy_id,
                'version_number': version.version_number,
                'name': version.name,
                'description': version.description,
                # JSONB fields - already Python objects
                'blocks': version.blocks,
                'signals': version.signals,
                'parameters': version.parameters,
                'entry_conditions': version.entry_conditions,
                'exit_conditions': version.exit_conditions,
                'risk_management': version.risk_management,
                'backtest_config': version.backtest_config,
                # Optional JSONB fields
                'backtest_results': version.backtest_results,
                'metrics': version.metrics,
                'trades': version.trades,
                'equity_curve': version.equity_curve,
                # Metadata
                'timestamp': version.timestamp,
                'git_commit_hash': version.git_commit_hash,
                'created_at': version.created_at,
                'created_by': version.created_by,
                'notes': version.notes,
                'tags': version.tags,
                'config_hash': version.config_hash,
                # Validation status (Sprint 1.9)
                'validation_status': version.validation_status,
                'validation_timestamp': version.validation_timestamp,
                # Strategy type (Sprint 1.9)
                'strategy_type': version.strategy_type
            }
            
            return version_dict
            
        except Exception as e:
            # Rollback on error to prevent transaction lock
            self.session.rollback()
            self.logger.error(f"Failed to get strategy version {version_id}: {e}")
            return None
    
    def get_strategy_versions(self, strategy_id: str) -> List[Dict[str, Any]]:
        """
        Get all versions of a strategy
        
        Args:
            strategy_id: Strategy ID
            
        Returns:
            List of all version dicts, ordered by version number (newest first)
        """
        # CRITICAL: Rollback any previous failed transaction before querying
        self.session.rollback()
        
        try:
            query = text("""
                SELECT * FROM strategy_versions 
                WHERE strategy_id = :strategy_id 
                ORDER BY version_number DESC
            """)
            
            results = self.session.execute(query, {'strategy_id': strategy_id}).fetchall()
            
            # Convert to dicts (JSONB columns already parsed by PostgreSQL)
            versions = [dict(row._mapping) for row in results]
            
            # No json.loads needed - JSONB columns return Python objects directly
            return versions
            
        except Exception as e:
            # Rollback on any error to prevent transaction lock
            self.session.rollback()
            self.logger.error(f"Failed to get versions for {strategy_id}: {e}")
            return []
    
    def get_latest_version(self, strategy_id: str) -> Optional[Dict[str, Any]]:
        """
        Get latest version of a strategy
        
        Args:
            strategy_id: Strategy ID
            
        Returns:
            Latest version dict or None if no versions exist
        """
        # CRITICAL: Rollback any previous failed transaction before querying
        self.session.rollback()
        
        try:
            query = text("""
                SELECT * FROM strategy_versions 
                WHERE strategy_id = :strategy_id 
                ORDER BY version_number DESC 
                LIMIT 1
            """)
            
            result = self.session.execute(query, {'strategy_id': strategy_id}).fetchone()
            
            if not result:
                return None
            
            # Convert to dict (JSONB columns already parsed by PostgreSQL)
            version = dict(result._mapping)
            
            # No json.loads needed - JSONB columns return Python objects directly
            return version
            
        except Exception as e:
            # Rollback on any error to prevent transaction lock
            self.session.rollback()
            self.logger.error(f"Failed to get latest version for {strategy_id}: {e}")
            return None
    
    def get_strategy_version_by_number(
        self,
        strategy_id: str,
        version_number: int
    ) -> Optional[Dict[str, Any]]:
        """
        Get specific version by strategy ID and version number
        
        Args:
            strategy_id: Strategy ID
            version_number: Version number
            
        Returns:
            Version dict or None if not found
        """
        query = text("""
            SELECT * FROM strategy_versions 
            WHERE strategy_id = :strategy_id AND version_number = :version_number
        """)
        
        result = self.session.execute(
            query,
            {'strategy_id': strategy_id, 'version_number': version_number}
        ).fetchone()
        
        if not result:
            return None
        
        # Convert to dict (JSONB columns already parsed by PostgreSQL)
        version = dict(result._mapping)
        
        # No json.loads needed - JSONB columns return Python objects directly
        return version
    
    def update_strategy_version(
        self,
        version_id: str,
        updates: Dict[str, Any]
    ) -> bool:
        """
        Update strategy version metadata
        
        Note: Only updates metadata fields (not core configuration)
        
        Args:
            version_id: Version UUID
            updates: Dict of fields to update (description, notes, tags, backtest_results, metrics, trades, equity_curve)
            
        Returns:
            True if updated, False if version not found
        """
        # Allowed update fields (not core configuration)
        allowed_fields = [
            'description', 'notes', 'tags', 'backtest_results',
            'metrics', 'trades', 'equity_curve', 'backtest_config',
            'validation_status',
        ]
        
        # Filter to allowed fields only
        filtered_updates = {
            k: v for k, v in updates.items() if k in allowed_fields
        }
        
        if not filtered_updates:
            return False
        
        # JSON encode list/dict fields
        json_fields = ['tags', 'backtest_results', 'metrics', 'trades', 'equity_curve', 'backtest_config']
        for field in json_fields:
            if field in filtered_updates and filtered_updates[field] is not None:
                filtered_updates[field] = json.dumps(filtered_updates[field])
        
        # Build SET clause
        set_clauses = [f"{field} = :{field}" for field in filtered_updates.keys()]
        set_clause = ", ".join(set_clauses)
        
        query = text(f"""
            UPDATE strategy_versions 
            SET {set_clause}
            WHERE version_id = :version_id
        """)
        
        filtered_updates['version_id'] = version_id
        
        result = self.session.execute(query, filtered_updates)
        self.session.commit()
        
        updated = result.rowcount > 0
        
        if updated:
            self.logger.info(f"Updated strategy version: {version_id}")
        
        return updated

    def save_backtest_config_for_version(
        self,
        version_id: str,
        config: Dict[str, Any],
        source: str = 'manual',
    ) -> bool:
        """
        Persist a backtest configuration snapshot for a specific strategy version.

        Stores a serialisable subset of the BacktestConfigPanel's config dict
        so that it can be automatically restored the next time this version is
        opened.  Non-serialisable values (datetime objects) are converted to
        ISO-8601 strings before storage.

        Args:
            version_id: UUID of the strategy version to update.
            config:     Dict returned by BacktestConfigPanel.get_config().
            source:     Human-readable label for the save trigger
                        ('test_run', 'config_discovery', 'manual').

        Returns:
            True if the row was updated, False if version_id was not found.
        """
        from datetime import datetime as _dt

        # Serialise any datetime values so they survive JSON round-trip
        serialisable = {}
        for k, v in config.items():
            if isinstance(v, _dt):
                serialisable[k] = v.isoformat()
            elif isinstance(v, dict):
                inner = {}
                for ik, iv in v.items():
                    inner[ik] = iv.isoformat() if isinstance(iv, _dt) else iv
                serialisable[k] = inner
            else:
                serialisable[k] = v

        # Tag the snapshot with its save source and timestamp
        serialisable["_saved_at"] = datetime.now(timezone.utc).isoformat()
        serialisable['_save_source'] = source

        return self.update_strategy_version(version_id, {'backtest_config': serialisable})

    def delete_strategy(self, strategy_id: str) -> bool:
        """
        Delete entire strategy and all its versions
        
        Args:
            strategy_id: Strategy ID to delete
            
        Returns:
            True if deleted, False if not found
        """
        try:
            # Check if strategy exists
            check_query = text("SELECT strategy_id FROM strategies WHERE strategy_id = :strategy_id")
            result = self.session.execute(check_query, {'strategy_id': strategy_id}).fetchone()
            
            if not result:
                return False
            
            # Delete all versions first (foreign key constraint)
            delete_versions = text("DELETE FROM strategy_versions WHERE strategy_id = :strategy_id")
            self.session.execute(delete_versions, {'strategy_id': strategy_id})
            
            # Delete strategy parent
            delete_strategy = text("DELETE FROM strategies WHERE strategy_id = :strategy_id")
            self.session.execute(delete_strategy, {'strategy_id': strategy_id})
            
            # Commit transaction
            self.session.commit()
            
            self.logger.info(f"Deleted strategy and all versions: {strategy_id}")
            return True
            
        except Exception as e:
            self.session.rollback()
            self.logger.error(f"Failed to delete strategy {strategy_id}: {e}")
            raise
    
    def delete_strategy_version(self, version_id: str) -> bool:
        """
        Delete a specific strategy version and renumber remaining versions
        
        After deletion, remaining versions are renumbered sequentially:
        Example: v4, v3, v2, v1 -> delete v3 -> v3, v2, v1 (v4 becomes v3)
        
        Note: Cannot delete if it's the only version of a strategy
        
        Args:
            version_id: Version UUID
            
        Returns:
            True if deleted, False if not found or is last version
        """
        try:
            # Get strategy_id for this version
            query = text("SELECT strategy_id FROM strategy_versions WHERE version_id = :version_id")
            result = self.session.execute(query, {'version_id': version_id}).fetchone()
            
            if not result:
                return False
            
            strategy_id = result[0]
            
            # Check how many versions exist
            count_query = text("SELECT COUNT(*) FROM strategy_versions WHERE strategy_id = :strategy_id")
            count_result = self.session.execute(count_query, {'strategy_id': strategy_id}).fetchone()
            version_count = count_result[0]
            
            # Don't delete if it's the only version - delete entire strategy instead
            if version_count <= 1:
                self.logger.warning(f"Cannot delete last version {version_id} - delete strategy instead")
                return False
            
            # Delete the version
            delete_query = text("DELETE FROM strategy_versions WHERE version_id = :version_id")
            self.session.execute(delete_query, {'version_id': version_id})
            
            # Renumber remaining versions sequentially (v1, v2, v3, ...)
            # Get all remaining versions ordered by version_number
            renumber_query = text("""
                SELECT version_id, version_number 
                FROM strategy_versions 
                WHERE strategy_id = :strategy_id 
                ORDER BY version_number ASC
            """)
            remaining_versions = self.session.execute(renumber_query, {'strategy_id': strategy_id}).fetchall()
            
            # Renumber sequentially starting from 1
            for new_number, (vid, old_number) in enumerate(remaining_versions, start=1):
                if old_number != new_number:
                    update_query = text("""
                        UPDATE strategy_versions 
                        SET version_number = :new_number 
                        WHERE version_id = :version_id
                    """)
                    self.session.execute(update_query, {'new_number': new_number, 'version_id': vid})
                    self.logger.debug(f"Renumbered version {vid}: v{old_number} -> v{new_number}")
            
            # Commit transaction
            self.session.commit()
            
            self.logger.info(f"Deleted strategy version {version_id} and renumbered {len(remaining_versions)} remaining versions")
            return True
            
        except Exception as e:
            self.session.rollback()
            self.logger.error(f"Failed to delete version {version_id}: {e}")
            raise
    
    def calculate_config_hash(self, config: Dict[str, Any]) -> str:
        """
        Calculate deterministic hash of strategy configuration
        
        Ignores metadata (description, notes, tags, etc.) and focuses
        only on functional configuration (blocks, parameters, conditions)
        
        Args:
            config: Strategy configuration dict
            
        Returns:
            SHA-256 hash (64 character hex string)
        """
        # Extract core functional elements only
        core_elements = {
            'blocks': [
                {
                    'name': block.get('name', ''),
                    'signals': block.get('signals', []),  # DON'T SORT - dicts can't be compared
                    'parameters': block.get('parameters', {}),
                    'logic_type': block.get('logic_type', 'AND')
                }
                for block in config.get('blocks', [])
            ],  # DON'T SORT - execution order matters
            'parameters': config.get('parameters', {}),
            'entry_conditions': config.get('entry_conditions', {}),
            'exit_conditions': config.get('exit_conditions', {}),
            'risk_management': config.get('risk_management', {})
        }
        
        # Generate deterministic JSON string
        json_str = json.dumps(core_elements, sort_keys=True, separators=(',', ':'))
        
        # Calculate SHA-256 hash
        return hashlib.sha256(json_str.encode('utf-8')).hexdigest()
    
    def find_version_by_hash(self, config_hash: str) -> Optional[str]:
        """
        Find existing version with same config hash (duplicate detection)
        
        Args:
            config_hash: SHA-256 hash to search for
            
        Returns:
            version_id if duplicate found, None otherwise
        """
        query = text("""
            SELECT version_id FROM strategy_versions 
            WHERE config_hash = :config_hash 
            ORDER BY created_at DESC 
            LIMIT 1
        """)
        
        result = self.session.execute(query, {'config_hash': config_hash}).fetchone()
        
        if result:
            self.logger.info(f"Found duplicate configuration: {result[0]}")
            return result[0]
        
        return None
    
    def get_all_strategies(self) -> List[Dict[str, Any]]:
        """
        Get all strategies with their latest version info using ORM
        
        Returns:
            List of strategy dicts with latest version metadata
            Each dict contains: strategy_id, name, created_at, updated_at, latest_version
            
        Real Money Impact: MEDIUM - Lists all trading strategies
        
        ORM Refactored: Sprint 1.6.1 Task 1.4
        """
        # Import ORM models and SQLAlchemy functions
        from src.optimizer_v3.database.models import Strategy, StrategyVersion
        from sqlalchemy import func
        
        try:
            # ORM query with LEFT JOIN and aggregation
            results = self.session.query(
                Strategy.strategy_id,
                Strategy.name,
                Strategy.created_at,
                Strategy.updated_at,
                func.max(StrategyVersion.version_number).label('latest_version')
            ).outerjoin(
                StrategyVersion,
                Strategy.strategy_id == StrategyVersion.strategy_id
            ).group_by(
                Strategy.strategy_id,
                Strategy.name,
                Strategy.created_at,
                Strategy.updated_at
            ).order_by(
                Strategy.updated_at.desc()
            ).all()
            
            # Convert to list of dicts for backwards compatibility
            strategies = []
            for row in results:
                strategy_dict = {
                    'strategy_id': row.strategy_id,
                    'name': row.name,
                    'created_at': row.created_at,
                    'updated_at': row.updated_at,
                    'latest_version': row.latest_version  # Will be None if no versions
                }
                strategies.append(strategy_dict)
            
            return strategies
            
        except Exception as e:
            # Rollback on error to prevent transaction lock
            self.session.rollback()
            self.logger.error(f"Failed to get all strategies: {e}")
            return []
    
    def _get_next_version_number(self, strategy_id: str) -> int:
        """
        Get next version number for strategy
        
        Args:
            strategy_id: Strategy ID
            
        Returns:
            Next version number (starts at 1)
        """
        query = text("""
            SELECT MAX(version_number) as max_version 
            FROM strategy_versions 
            WHERE strategy_id = :strategy_id
        """)
        
        result = self.session.execute(query, {'strategy_id': strategy_id}).fetchone()
        
        max_version = result[0] if result and result[0] else 0
        return max_version + 1
