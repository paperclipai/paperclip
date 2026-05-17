"""
Optimizer V3 - Checkpoint Manager
Handles checkpointing, auto-save, resume, and rollback for optimization runs.
"""

import json
import gzip
import shutil
from pathlib import Path
from typing import Dict, List, Optional
from dataclasses import dataclass, asdict
from datetime import datetime
import hashlib

from src.optimizer_v3.core.logger import OptimizerLogger

import logging
logger = logging.getLogger(__name__)



@dataclass
class CheckpointData:
    """Data stored in a checkpoint"""
    timestamp: str
    strategy_id: str
    total_configs: int
    completed_count: int
    results: List[Dict]
    best_config: Optional[Dict]
    best_metric: Optional[float]
    metadata: Dict


class CheckpointManager:
    """
    Manage checkpoints for optimization runs.
    
    Features:
    - Auto-save progress at configurable intervals
    - Resume from last checkpoint
    - Rollback on errors
    - Checkpoint compression
    - Automatic cleanup of old checkpoints
    - Data integrity validation with checksums
    
    Args:
        logger: OptimizerLogger instance
        checkpoint_dir: Directory to store checkpoints
        interval: Save checkpoint every N configs
        max_age_seconds: Maximum age of checkpoints to keep
        compression: Whether to compress checkpoints
        retention_count: Number of checkpoints to retain
    """
    
    def __init__(
        self,
        logger: OptimizerLogger,
        checkpoint_dir: str = "checkpoints",
        interval: int = 5,
        max_age_seconds: int = 86400,
        compression: bool = True,
        retention_count: int = 3
    ):
        self.logger = logger
        self.checkpoint_dir = Path(checkpoint_dir)
        self.interval = interval
        self.max_age_seconds = max_age_seconds
        self.compression = compression
        self.retention_count = retention_count
        
        # Create checkpoint directory
        self.checkpoint_dir.mkdir(parents=True, exist_ok=True)
        
        self.logger.info(
            "CheckpointManager initialized",
            checkpoint_dir=str(self.checkpoint_dir),
            interval=interval,
            compression=compression,
            retention_count=retention_count
        )
    
    def save_checkpoint(
        self,
        strategy_id: str,
        completed_count: int,
        total_configs: int,
        results: List[Dict],
        best_config: Optional[Dict] = None,
        best_metric: Optional[float] = None,
        metadata: Optional[Dict] = None
    ) -> Path:
        """
        Save checkpoint to disk.
        
        Args:
            strategy_id: Strategy identifier
            completed_count: Number of configs completed
            total_configs: Total number of configs
            results: List of results so far
            best_config: Best configuration found
            best_metric: Best metric value
            metadata: Additional metadata
            
        Returns:
            Path to saved checkpoint file
        """
        checkpoint_data = CheckpointData(
            timestamp=datetime.now().isoformat(),
            strategy_id=strategy_id,
            total_configs=total_configs,
            completed_count=completed_count,
            results=results,
            best_config=best_config,
            best_metric=best_metric,
            metadata=metadata or {}
        )
        
        # Generate checkpoint filename
        filename = f"checkpoint_{strategy_id}_{completed_count}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        if self.compression:
            filename += ".gz"
        
        filepath = self.checkpoint_dir / filename
        
        # Convert to JSON
        data_dict = asdict(checkpoint_data)
        json_data = json.dumps(data_dict, indent=2)
        
        # Calculate checksum
        checksum = hashlib.sha256(json_data.encode()).hexdigest()
        data_dict['checksum'] = checksum
        json_data = json.dumps(data_dict, indent=2)
        
        # Save to file
        if self.compression:
            with gzip.open(filepath, 'wt', encoding='utf-8') as f:
                f.write(json_data)
        else:
            with open(filepath, 'w', encoding='utf-8') as f:
                f.write(json_data)
        
        self.logger.info(
            "Checkpoint saved",
            filepath=str(filepath),
            completed=completed_count,
            total=total_configs,
            checksum=checksum[:8]
        )
        
        # Cleanup old checkpoints
        self._cleanup_old_checkpoints(strategy_id)
        
        return filepath
    
    def load_checkpoint(self, filepath: Path) -> Optional[CheckpointData]:
        """
        Load checkpoint from disk.
        
        Args:
            filepath: Path to checkpoint file
            
        Returns:
            CheckpointData if successful, None otherwise
        """
        if not filepath.exists():
            self.logger.error(f"Checkpoint file not found: {filepath}")
            return None
        
        try:
            # Read file
            if filepath.suffix == '.gz':
                with gzip.open(filepath, 'rt', encoding='utf-8') as f:
                    json_data = f.read()
            else:
                with open(filepath, 'r', encoding='utf-8') as f:
                    json_data = f.read()
            
            data_dict = json.loads(json_data)
            
            # Validate checksum
            stored_checksum = data_dict.pop('checksum', None)
            if stored_checksum:
                # Recalculate checksum without the checksum field
                json_without_checksum = json.dumps(data_dict, indent=2)
                calculated_checksum = hashlib.sha256(json_without_checksum.encode()).hexdigest()
                
                if stored_checksum != calculated_checksum:
                    self.logger.error(
                        "Checkpoint checksum mismatch",
                        filepath=str(filepath),
                        expected=stored_checksum[:8],
                        actual=calculated_checksum[:8]
                    )
                    return None
            
            checkpoint_data = CheckpointData(**data_dict)
            
            self.logger.info(
                "Checkpoint loaded",
                filepath=str(filepath),
                completed=checkpoint_data.completed_count,
                strategy_id=checkpoint_data.strategy_id
            )
            
            return checkpoint_data
            
        except Exception as e:
            self.logger.error(f"Failed to load checkpoint: {str(e)}", filepath=str(filepath))
            return None
    
    def get_latest_checkpoint(self, strategy_id: str) -> Optional[Path]:
        """
        Get path to most recent checkpoint for strategy.
        
        Args:
            strategy_id: Strategy identifier
            
        Returns:
            Path to latest checkpoint or None
        """
        pattern = f"checkpoint_{strategy_id}_*.json*"
        checkpoints = sorted(
            self.checkpoint_dir.glob(pattern),
            key=lambda p: p.stat().st_mtime,
            reverse=True
        )
        
        if checkpoints:
            self.logger.info(
                "Found latest checkpoint",
                strategy_id=strategy_id,
                filepath=str(checkpoints[0])
            )
            return checkpoints[0]
        
        self.logger.info("No checkpoint found", strategy_id=strategy_id)
        return None
    
    def should_save(self, completed_count: int) -> bool:
        """
        Check if checkpoint should be saved based on interval.
        
        Args:
            completed_count: Number of configs completed
            
        Returns:
            True if should save checkpoint
        """
        return completed_count > 0 and completed_count % self.interval == 0
    
    def export_results(
        self,
        results: List[Dict],
        output_path: Path,
        format: str = 'csv'
    ) -> bool:
        """
        Export results to file.
        
        Args:
            results: List of result dictionaries
            output_path: Path to output file
            format: Export format ('csv' or 'json')
            
        Returns:
            True if successful
        """
        try:
            if format == 'csv':
                import csv
                
                if not results:
                    self.logger.warning("No results to export")
                    return False
                
                keys = results[0].keys()
                
                with open(output_path, 'w', newline='', encoding='utf-8') as f:
                    writer = csv.DictWriter(f, fieldnames=keys)
                    writer.writeheader()
                    writer.writerows(results)
                
            elif format == 'json':
                with open(output_path, 'w', encoding='utf-8') as f:
                    json.dump(results, f, indent=2)
            
            else:
                self.logger.error(f"Unsupported format: {format}")
                return False
            
            self.logger.info(
                "Results exported",
                output_path=str(output_path),
                format=format,
                count=len(results)
            )
            
            return True
            
        except Exception as e:
            self.logger.error(f"Export failed: {str(e)}", output_path=str(output_path))
            return False
    
    def rollback(self, strategy_id: str, to_checkpoint: Optional[Path] = None) -> Optional[CheckpointData]:
        """
        Rollback to a previous checkpoint.
        
        Args:
            strategy_id: Strategy identifier
            to_checkpoint: Specific checkpoint to rollback to (or latest if None)
            
        Returns:
            CheckpointData if successful
        """
        if to_checkpoint is None:
            to_checkpoint = self.get_latest_checkpoint(strategy_id)
        
        if to_checkpoint is None:
            self.logger.error("No checkpoint available for rollback", strategy_id=strategy_id)
            return None
        
        checkpoint_data = self.load_checkpoint(to_checkpoint)
        
        if checkpoint_data:
            self.logger.info(
                "Rolled back to checkpoint",
                strategy_id=strategy_id,
                completed=checkpoint_data.completed_count
            )
        
        return checkpoint_data
    
    def _cleanup_old_checkpoints(self, strategy_id: str) -> None:
        """
        Clean up old checkpoints based on retention policy.
        
        Args:
            strategy_id: Strategy identifier
        """
        pattern = f"checkpoint_{strategy_id}_*.json*"
        checkpoints = sorted(
            self.checkpoint_dir.glob(pattern),
            key=lambda p: p.stat().st_mtime,
            reverse=True
        )
        
        # Remove checkpoints beyond retention count
        for checkpoint in checkpoints[self.retention_count:]:
            try:
                checkpoint.unlink()
                self.logger.debug(f"Removed old checkpoint: {checkpoint}")
            except Exception as e:
                self.logger.error(f"Failed to remove checkpoint: {str(e)}")
        
        # Remove checkpoints older than max_age
        now = datetime.now().timestamp()
        for checkpoint in checkpoints:
            if not checkpoint.exists():
                continue
            try:
                age = now - checkpoint.stat().st_mtime
                if age > self.max_age_seconds:
                    checkpoint.unlink()
                    self.logger.debug(f"Removed expired checkpoint: {checkpoint}")
            except Exception as e:
                self.logger.error(f"Failed to remove checkpoint: {str(e)}")
    
    def clear_all_checkpoints(self, strategy_id: str) -> int:
        """
        Remove all checkpoints for a strategy.
        
        Args:
            strategy_id: Strategy identifier
            
        Returns:
            Number of checkpoints removed
        """
        pattern = f"checkpoint_{strategy_id}_*.json*"
        checkpoints = list(self.checkpoint_dir.glob(pattern))
        
        count = 0
        for checkpoint in checkpoints:
            try:
                checkpoint.unlink()
                count += 1
            except Exception as e:
                self.logger.error(f"Failed to remove checkpoint: {str(e)}")
        
        self.logger.info(f"Cleared {count} checkpoints", strategy_id=strategy_id)
        return count
