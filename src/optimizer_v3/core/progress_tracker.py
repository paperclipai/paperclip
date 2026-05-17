"""
Optimizer V3 - Progress Tracking System
Real-time progress monitoring with ETA calculation for parallel execution.
"""

from datetime import datetime, timedelta
from typing import Dict, Optional, List, Callable
from dataclasses import dataclass, field
from enum import Enum
import threading

from src.optimizer_v3.core.logger import OptimizerLogger

import logging
logger = logging.getLogger(__name__)



class TaskStatus(Enum):
    """Status of a tracked task"""
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass
class TaskProgress:
    """Progress information for a single task"""
    task_id: str
    status: TaskStatus = TaskStatus.PENDING
    start_time: Optional[datetime] = None
    end_time: Optional[datetime] = None
    progress_percent: float = 0.0
    error_message: Optional[str] = None
    metadata: Dict = field(default_factory=dict)
    
    @property
    def duration(self) -> Optional[timedelta]:
        """Get task duration"""
        if self.start_time is None:
            return None
        
        end = self.end_time or datetime.now()
        return end - self.start_time
    
    @property
    def is_complete(self) -> bool:
        """Check if task is complete"""
        return self.status in (TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED)


class ProgressTracker:
    """
    Track progress across multiple parallel tasks with ETA calculation.
    
    Features:
    - Track individual task progress
    - Calculate overall completion percentage
    - Estimate time to completion (ETA)
    - Real-time progress updates
    - Thread-safe operations
    - Progress callbacks
    
    Args:
        total_tasks: Total number of tasks to track
        logger: OptimizerLogger instance for logging
        update_interval: Minimum interval between progress updates in seconds
    """
    
    def __init__(
        self,
        total_tasks: int,
        logger: OptimizerLogger,
        update_interval: float = 1.0
    ):
        self.total_tasks = total_tasks
        self.logger = logger
        self.update_interval = update_interval
        
        self._tasks: Dict[str, TaskProgress] = {}
        self._lock = threading.RLock()
        self._callbacks: List[Callable] = []
        self._last_update = datetime.now()
        self._start_time = datetime.now()
        self._active = False
        
        self.logger.info(
            "ProgressTracker initialized",
            total_tasks=total_tasks,
            update_interval=update_interval
        )
    
    def register_task(self, task_id: str, metadata: Dict = None) -> None:
        """
        Register a new task for tracking.
        
        Args:
            task_id: Unique identifier for the task
            metadata: Optional metadata about the task
        """
        with self._lock:
            if task_id in self._tasks:
                self.logger.warning(f"Task {task_id} already registered")
                return
            
            self._tasks[task_id] = TaskProgress(
                task_id=task_id,
                metadata=metadata or {}
            )
            
            self.logger.debug(f"Registered task {task_id}")
    
    def start_task(self, task_id: str) -> None:
        """
        Mark task as started.
        
        Args:
            task_id: Task identifier
        """
        with self._lock:
            if task_id not in self._tasks:
                self.register_task(task_id)
            
            task = self._tasks[task_id]
            task.status = TaskStatus.IN_PROGRESS
            task.start_time = datetime.now()
            
            self.logger.debug(f"Started task {task_id}")
            self._trigger_update()
    
    def complete_task(self, task_id: str, metadata: Dict = None) -> None:
        """
        Mark task as completed.
        
        Args:
            task_id: Task identifier
            metadata: Optional completion metadata
        """
        with self._lock:
            if task_id not in self._tasks:
                self.logger.warning(f"Task {task_id} not found")
                return
            
            task = self._tasks[task_id]
            task.status = TaskStatus.COMPLETED
            task.end_time = datetime.now()
            task.progress_percent = 100.0
            
            if metadata:
                task.metadata.update(metadata)
            
            self.logger.debug(
                f"Completed task {task_id}",
                duration=task.duration.total_seconds() if task.duration else 0
            )
            self._trigger_update()
    
    def fail_task(self, task_id: str, error: str, metadata: Dict = None) -> None:
        """
        Mark task as failed.
        
        Args:
            task_id: Task identifier
            error: Error message
            metadata: Optional failure metadata
        """
        with self._lock:
            if task_id not in self._tasks:
                self.logger.warning(f"Task {task_id} not found")
                return
            
            task = self._tasks[task_id]
            task.status = TaskStatus.FAILED
            task.end_time = datetime.now()
            task.error_message = error
            
            if metadata:
                task.metadata.update(metadata)
            
            self.logger.error(
                f"Task {task_id} failed",
                error=error,
                duration=task.duration.total_seconds() if task.duration else 0
            )
            self._trigger_update()
    
    def update_task_progress(self, task_id: str, progress_percent: float) -> None:
        """
        Update task progress percentage.
        
        Args:
            task_id: Task identifier
            progress_percent: Progress percentage (0-100)
        """
        with self._lock:
            if task_id not in self._tasks:
                self.logger.warning(f"Task {task_id} not found")
                return
            
            task = self._tasks[task_id]
            task.progress_percent = min(100.0, max(0.0, progress_percent))
            
            self._trigger_update()
    
    def get_progress(self) -> float:
        """
        Get overall completion percentage.
        
        Returns:
            Completion percentage (0-100)
        """
        with self._lock:
            if not self._tasks:
                return 0.0
            
            # Calculate weighted progress
            total_progress = sum(
                task.progress_percent
                for task in self._tasks.values()
            )
            
            return total_progress / self.total_tasks if self.total_tasks > 0 else 0.0
    
    def get_completed_count(self) -> int:
        """
        Get number of completed tasks.
        
        Returns:
            Number of completed tasks
        """
        with self._lock:
            return sum(
                1 for task in self._tasks.values()
                if task.status == TaskStatus.COMPLETED
            )
    
    def get_failed_count(self) -> int:
        """
        Get number of failed tasks.
        
        Returns:
            Number of failed tasks
        """
        with self._lock:
            return sum(
                1 for task in self._tasks.values()
                if task.status == TaskStatus.FAILED
            )
    
    def get_in_progress_count(self) -> int:
        """
        Get number of in-progress tasks.
        
        Returns:
            Number of in-progress tasks
        """
        with self._lock:
            return sum(
                1 for task in self._tasks.values()
                if task.status == TaskStatus.IN_PROGRESS
            )
    
    def get_eta(self) -> Optional[timedelta]:
        """
        Calculate estimated time to completion.
        
        Returns:
            Estimated time remaining or None if cannot calculate
        """
        with self._lock:
            completed = self.get_completed_count()
            
            if completed == 0:
                return None
            
            # Calculate average time per completed task
            elapsed = datetime.now() - self._start_time
            avg_time_per_task = elapsed / completed
            
            # Calculate remaining tasks
            remaining = self.total_tasks - completed - self.get_failed_count()
            
            if remaining <= 0:
                return timedelta(0)
            
            # Estimate time remaining
            return avg_time_per_task * remaining
    
    def get_rate(self) -> float:
        """
        Get completion rate (tasks per second).
        
        Returns:
            Tasks completed per second
        """
        with self._lock:
            completed = self.get_completed_count()
            
            if completed == 0:
                return 0.0
            
            elapsed = (datetime.now() - self._start_time).total_seconds()
            return completed / elapsed if elapsed > 0 else 0.0
    
    def get_status_summary(self) -> Dict:
        """
        Get summary of current status.
        
        Returns:
            Dictionary with status information
        """
        with self._lock:
            eta = self.get_eta()
            
            return {
                'total_tasks': self.total_tasks,
                'completed': self.get_completed_count(),
                'failed': self.get_failed_count(),
                'in_progress': self.get_in_progress_count(),
                'pending': (
                    self.total_tasks -
                    self.get_completed_count() -
                    self.get_failed_count() -
                    self.get_in_progress_count()
                ),
                'progress_percent': self.get_progress(),
                'eta_seconds': eta.total_seconds() if eta else None,
                'rate_per_second': self.get_rate(),
                'elapsed_seconds': (datetime.now() - self._start_time).total_seconds()
            }
    
    def register_callback(self, callback: Callable[[Dict], None]) -> None:
        """
        Register a progress update callback.
        
        Args:
            callback: Function to call on progress updates
        """
        with self._lock:
            if callback not in self._callbacks:
                self._callbacks.append(callback)
                self.logger.debug("Registered progress callback")
    
    def unregister_callback(self, callback: Callable[[Dict], None]) -> None:
        """
        Unregister a progress update callback.
        
        Args:
            callback: Callback to remove
        """
        with self._lock:
            if callback in self._callbacks:
                self._callbacks.remove(callback)
                self.logger.debug("Unregistered progress callback")
    
    def _trigger_update(self) -> None:
        """Trigger progress update callbacks if interval elapsed"""
        now = datetime.now()
        
        if (now - self._last_update).total_seconds() < self.update_interval:
            return
        
        self._last_update = now
        summary = self.get_status_summary()
        
        # Log progress
        self.logger.info(
            "Progress update",
            **summary
        )
        
        # Call callbacks
        for callback in self._callbacks:
            try:
                callback(summary)
            except Exception as e:
                self.logger.error(
                    f"Progress callback failed: {str(e)}",
                    callback=str(callback)
                )
    
    def reset(self) -> None:
        """Reset progress tracker"""
        with self._lock:
            self._tasks.clear()
            self._start_time = datetime.now()
            self._last_update = datetime.now()
            
            self.logger.info("ProgressTracker reset")
    
    # Compatibility methods for simple API
    def start(self, total: int, description: str = "") -> None:
        """Start tracking (compatibility method)"""
        with self._lock:
            self.total_tasks = total
            self._start_time = datetime.now()
            self._active = True
            self.logger.info(f"Progress tracking started: {description}", total=total)
    
    def update(self, n: int = 1) -> None:
        """Update progress (compatibility method)"""
        for i in range(n):
            task_id = f"task_{len(self._tasks)}"
            self.register_task(task_id)
            self.complete_task(task_id)
    
    def complete(self) -> None:
        """Complete tracking (compatibility method)"""
        with self._lock:
            self._active = False
            self.logger.info("Progress tracking complete")
    
    def is_active(self) -> bool:
        """Check if tracking is active (compatibility method)"""
        with self._lock:
            return self._active
