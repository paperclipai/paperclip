"""
State Management System
Task 1.3.11: Persistent state management with session recovery

Features:
- Save/load optimization state to disk
- Automatic state persistence
- State validation
- Backup management
- Compression support
"""

from decimal import Decimal
from typing import Dict, Optional, List, Any
from datetime import datetime
from pathlib import Path
import json
import pickle
import gzip
import shutil
from nautilus_trader.model.objects import Money, Quantity, Price
from dotenv import load_dotenv
import os

import logging
logger = logging.getLogger(__name__)

class StateManager:
    """
    Manage optimization state persistence
    
    Handles saving and loading of optimization state for session recovery
    """
    
    def __init__(self, state_dir: Optional[str] = None):
        """
        Initialize state manager
        
        Args:
            state_dir: Directory for state files (default: data/optimizer_state)
        """
        load_dotenv()
        
        self.config = {
            'save_interval': int(os.getenv('STATE_SAVE_INTERVAL', '300')),  # seconds
            'max_history': int(os.getenv('STATE_MAX_HISTORY', '100')),
            'compression': os.getenv('STATE_COMPRESSION', 'true').lower() == 'true',
            'backup_count': int(os.getenv('STATE_BACKUP_COUNT', '3')),
            'validation_level': os.getenv('STATE_VALIDATION_LEVEL', 'strict')
        }
        
        # Set state directory
        if state_dir is None:
            state_dir = 'data/optimizer_state'
        
        self.state_dir = Path(state_dir)
        self.state_dir.mkdir(parents=True, exist_ok=True)
        
        # Backup directory
        self.backup_dir = self.state_dir / 'backups'
        self.backup_dir.mkdir(parents=True, exist_ok=True)
        
        # Track last save time
        self.last_save_time = None
    
    def save_state(self,
                  session_id: str,
                  state: Dict,
                  force: bool = False) -> Dict:
        """
        Save optimization state
        
        Args:
            session_id: Unique session identifier
            state: State dictionary to save
            force: Force save even if interval hasn't elapsed
        
        Returns:
            Save statistics
        """
        # Check if save is needed
        if not force and self.last_save_time:
            elapsed = (datetime.now() - self.last_save_time).total_seconds()
            if elapsed < self.config['save_interval']:
                return {
                    'saved': False,
                    'reason': f'Save interval not elapsed ({elapsed:.1f}s < {self.config["save_interval"]}s)'
                }
        
        try:
            # Validate state
            if self.config['validation_level'] == 'strict':
                validation = self._validate_state(state)
                if not validation['valid']:
                    return {
                        'saved': False,
                        'error': f"State validation failed: {validation['errors']}"
                    }
            
            # Add metadata
            state_with_metadata = {
                'session_id': session_id,
                'timestamp': datetime.now().isoformat(),
                'version': '1.0',
                'state': self._serialize_state(state)
            }
            
            # Determine filepath
            filepath = self._get_state_filepath(session_id)
            
            # Create backup if file exists
            if filepath.exists():
                self._create_backup(session_id, filepath)
            
            # Save state
            if self.config['compression']:
                self._save_compressed(filepath, state_with_metadata)
            else:
                self._save_json(filepath, state_with_metadata)
            
            # Update last save time
            self.last_save_time = datetime.now()
            
            # Clean old backups
            self._cleanup_old_backups(session_id)
            
            return {
                'saved': True,
                'filepath': str(filepath),
                'size_bytes': filepath.stat().st_size,
                'compressed': self.config['compression'],
                'timestamp': self.last_save_time.isoformat()
            }
        
        except Exception as e:
            return {
                'saved': False,
                'error': str(e)
            }
    
    def load_state(self, session_id: str) -> Optional[Dict]:
        """
        Load optimization state
        
        Args:
            session_id: Session identifier
        
        Returns:
            State dictionary or None if not found
        """
        try:
            filepath = self._get_state_filepath(session_id)
            
            if not filepath.exists():
                return None
            
            # Load state
            if self.config['compression']:
                state_with_metadata = self._load_compressed(filepath)
            else:
                state_with_metadata = self._load_json(filepath)
            
            # Validate loaded state
            if self.config['validation_level'] != 'lenient':
                if not self._validate_loaded_state(state_with_metadata):
                    return None
            
            # Deserialize and return state
            state = self._deserialize_state(state_with_metadata['state'])
            
            return state
        
        except Exception as e:
            logger.error(f"Error loading state: {e}")
            return None
    
    def delete_state(self, session_id: str) -> bool:
        """
        Delete state file and backups
        
        Args:
            session_id: Session identifier
        
        Returns:
            True if deleted, False otherwise
        """
        try:
            filepath = self._get_state_filepath(session_id)
            
            # Delete main file
            if filepath.exists():
                filepath.unlink()
            
            # Delete backups
            backup_pattern = f"{session_id}_backup_*"
            for backup_file in self.backup_dir.glob(backup_pattern):
                backup_file.unlink()
            
            return True
        
        except Exception as e:
            logger.error(f"Error deleting state: {e}")
            return False
    
    def list_sessions(self) -> List[Dict]:
        """
        List all saved sessions
        
        Returns:
            List of session information
        """
        sessions = []
        
        # Find all state files
        pattern = "state_*.json*"
        for filepath in self.state_dir.glob(pattern):
            try:
                # Extract session ID from filename
                # Handle both .json and .json.gz
                name = filepath.name
                if name.endswith('.gz'):
                    name = name[:-3]
                if name.endswith('.json'):
                    name = name[:-5]
                session_id = name.replace('state_', '')
                
                # Get file stats
                stat = filepath.stat()
                
                sessions.append({
                    'session_id': session_id,
                    'filepath': str(filepath),
                    'size_bytes': stat.st_size,
                    'modified': datetime.fromtimestamp(stat.st_mtime).isoformat(),
                    'compressed': filepath.suffix == '.gz'
                })
            
            except Exception as e:
                continue
        
        # Sort by modification time (newest first)
        sessions.sort(key=lambda x: x['modified'], reverse=True)
        
        return sessions
    
    def get_latest_session(self) -> Optional[str]:
        """
        Get ID of most recent session
        
        Returns:
            Session ID or None
        """
        sessions = self.list_sessions()
        
        if sessions:
            return sessions[0]['session_id']
        
        return None
    
    # ==================== Backup Management ====================
    
    def _create_backup(self, session_id: str, filepath: Path):
        """Create backup of existing state file"""
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        backup_filename = f"{session_id}_backup_{timestamp}{filepath.suffix}"
        backup_filepath = self.backup_dir / backup_filename
        
        shutil.copy2(filepath, backup_filepath)
    
    def _cleanup_old_backups(self, session_id: str):
        """Remove old backups beyond retention limit"""
        backup_pattern = f"{session_id}_backup_*"
        backups = sorted(
            self.backup_dir.glob(backup_pattern),
            key=lambda p: p.stat().st_mtime,
            reverse=True
        )
        
        # Keep only configured number of backups
        for old_backup in backups[self.config['backup_count']:]:
            old_backup.unlink()
    
    def restore_backup(self, session_id: str, backup_index: int = 0) -> bool:
        """
        Restore from backup
        
        Args:
            session_id: Session identifier
            backup_index: Index of backup to restore (0 = most recent)
        
        Returns:
            True if restored successfully
        """
        try:
            backup_pattern = f"{session_id}_backup_*"
            backups = sorted(
                self.backup_dir.glob(backup_pattern),
                key=lambda p: p.stat().st_mtime,
                reverse=True
            )
            
            if backup_index >= len(backups):
                return False
            
            backup_file = backups[backup_index]
            state_file = self._get_state_filepath(session_id)
            
            shutil.copy2(backup_file, state_file)
            
            return True
        
        except Exception as e:
            logger.error(f"Error restoring backup: {e}")
            return False
    
    # ==================== Serialization ====================
    
    def _serialize_state(self, state: Dict) -> Dict:
        """Serialize state for storage"""
        serialized = {}
        
        for key, value in state.items():
            serialized[key] = self._serialize_value(value)
        
        return serialized
    
    def _serialize_value(self, value: Any) -> Any:
        """Serialize a single value"""
        # Handle NautilusTrader types
        if isinstance(value, (Money, Quantity, Price)):
            return {
                '_type': type(value).__name__,
                '_value': str(value)
            }
        
        # Handle Decimal
        if isinstance(value, Decimal):
            return {
                '_type': 'Decimal',
                '_value': str(value)
            }
        
        # Handle datetime
        if isinstance(value, datetime):
            return {
                '_type': 'datetime',
                '_value': value.isoformat()
            }
        
        # Handle dict recursively
        if isinstance(value, dict):
            return {k: self._serialize_value(v) for k, v in value.items()}
        
        # Handle list
        if isinstance(value, list):
            return [self._serialize_value(v) for v in value]
        
        # Handle other types
        return value
    
    def _deserialize_state(self, state: Dict) -> Dict:
        """Deserialize state from storage"""
        deserialized = {}
        
        for key, value in state.items():
            deserialized[key] = self._deserialize_value(value)
        
        return deserialized
    
    def _deserialize_value(self, value: Any) -> Any:
        """Deserialize a single value"""
        # Handle special typed values
        if isinstance(value, dict) and '_type' in value:
            type_name = value['_type']
            type_value = value['_value']
            
            if type_name == 'Money':
                return Money.from_str(type_value)
            elif type_name == 'Quantity':
                return Quantity.from_str(type_value)
            elif type_name == 'Price':
                return Price.from_str(type_value)
            elif type_name == 'Decimal':
                return Decimal(type_value)
            elif type_name == 'datetime':
                return datetime.fromisoformat(type_value)
        
        # Handle dict recursively
        if isinstance(value, dict):
            return {k: self._deserialize_value(v) for k, v in value.items()}
        
        # Handle list
        if isinstance(value, list):
            return [self._deserialize_value(v) for v in value]
        
        return value
    
    # ==================== File I/O ====================
    
    def _save_json(self, filepath: Path, data: Dict):
        """Save as JSON"""
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, default=str)
    
    def _save_compressed(self, filepath: Path, data: Dict):
        """Save as compressed JSON"""
        json_str = json.dumps(data, default=str)
        
        with gzip.open(filepath, 'wt', encoding='utf-8') as f:
            f.write(json_str)
    
    def _load_json(self, filepath: Path) -> Dict:
        """Load from JSON"""
        with open(filepath, 'r', encoding='utf-8') as f:
            return json.load(f)
    
    def _load_compressed(self, filepath: Path) -> Dict:
        """Load from compressed JSON"""
        with gzip.open(filepath, 'rt', encoding='utf-8') as f:
            return json.load(f)
    
    # ==================== Validation ====================
    
    def _validate_state(self, state: Dict) -> Dict:
        """Validate state before saving"""
        errors = []
        
        # Check required keys
        required_keys = ['results', 'config', 'status']
        for key in required_keys:
            if key not in state:
                errors.append(f"Missing required key: {key}")
        
        # Check data types
        if 'results' in state and not isinstance(state['results'], list):
            errors.append("'results' must be a list")
        
        if 'config' in state and not isinstance(state['config'], dict):
            errors.append("'config' must be a dictionary")
        
        return {
            'valid': len(errors) == 0,
            'errors': errors
        }
    
    def _validate_loaded_state(self, state_with_metadata: Dict) -> bool:
        """Validate loaded state structure"""
        required_keys = ['session_id', 'timestamp', 'version', 'state']
        
        return all(key in state_with_metadata for key in required_keys)
    
    # ==================== Helper Methods ====================
    
    def _get_state_filepath(self, session_id: str) -> Path:
        """Get filepath for session state"""
        ext = '.json.gz' if self.config['compression'] else '.json'
        return self.state_dir / f"state_{session_id}{ext}"
    
    def get_state_size(self, session_id: str) -> Optional[int]:
        """Get size of state file in bytes"""
        filepath = self._get_state_filepath(session_id)
        
        if filepath.exists():
            return filepath.stat().st_size
        
        return None
    
    def cleanup_old_sessions(self, max_age_days: int = 30):
        """
        Clean up old session files
        
        Args:
            max_age_days: Delete sessions older than this many days
        """
        cutoff_time = datetime.now().timestamp() - (max_age_days * 24 * 3600)
        
        deleted_count = 0
        
        for filepath in self.state_dir.glob('state_*.json*'):
            if filepath.stat().st_mtime < cutoff_time:
                filepath.unlink()
                deleted_count += 1
                
                # Also delete associated backups
                session_id = filepath.stem.replace('.gz', '').replace('state_', '')
                for backup in self.backup_dir.glob(f"{session_id}_backup_*"):
                    backup.unlink()
        
        return deleted_count
