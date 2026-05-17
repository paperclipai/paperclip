"""
Optimizer V3 - Error Recovery System
Robust error handling with retry logic and backoff strategy.
"""

from typing import Callable, Any, Dict, Optional, List
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import Enum
import time
import traceback

from src.optimizer_v3.core.logger import OptimizerLogger

import logging
logger = logging.getLogger(__name__)



class ErrorSeverity(Enum):
    """Severity levels for errors"""
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class RecoveryAction(Enum):
    """Actions to take for error recovery"""
    RETRY = "retry"
    SKIP = "skip"
    ABORT = "abort"
    FALLBACK = "fallback"


@dataclass
class ErrorRecord:
    """Record of an error occurrence"""
    error_id: str
    timestamp: datetime
    error_type: str
    error_message: str
    traceback_info: str
    severity: ErrorSeverity
    recovery_action: RecoveryAction
    retry_count: int = 0
    recovered: bool = False
    metadata: Dict = field(default_factory=dict)
    
    def to_dict(self) -> Dict:
        """Convert to dictionary"""
        return {
            'error_id': self.error_id,
            'timestamp': self.timestamp.isoformat(),
            'error_type': self.error_type,
            'error_message': self.error_message,
            'traceback': self.traceback_info,
            'severity': self.severity.value,
            'recovery_action': self.recovery_action.value,
            'retry_count': self.retry_count,
            'recovered': self.recovered,
            'metadata': self.metadata
        }


class ErrorRecoveryStrategy:
    """
    Error recovery strategy with retry logic and exponential backoff.
    
    Features:
    - Configurable retry attempts
    - Exponential backoff with jitter
    - Error categorization
    - Recovery action determination
    - Error history tracking
    - Success/failure callbacks
    
    Args:
        logger: OptimizerLogger instance
        max_retries: Maximum number of retry attempts
        initial_backoff: Initial backoff delay in seconds
        max_backoff: Maximum backoff delay in seconds
        backoff_factor: Multiplier for exponential backoff
        jitter: Add random jitter to backoff (0.0-1.0)
    """
    
    def __init__(
        self,
        logger: OptimizerLogger,
        max_retries: int = 3,
        initial_backoff: float = 1.0,
        max_backoff: float = 30.0,
        backoff_factor: float = 2.0,
        jitter: float = 0.1
    ):
        self.logger = logger
        self.max_retries = max_retries
        self.initial_backoff = initial_backoff
        self.max_backoff = max_backoff
        self.backoff_factor = backoff_factor
        self.jitter = jitter
        
        self._error_history: List[ErrorRecord] = []
        self._error_counts: Dict[str, int] = {}
        
        self.logger.info(
            "ErrorRecoveryStrategy initialized",
            max_retries=max_retries,
            initial_backoff=initial_backoff,
            max_backoff=max_backoff
        )
    
    def execute_with_retry(
        self,
        func: Callable,
        *args,
        task_id: str = None,
        on_success: Callable = None,
        on_failure: Callable = None,
        **kwargs
    ) -> Any:
        """
        Execute function with retry logic.
        
        Args:
            func: Function to execute
            *args: Positional arguments for func
            task_id: Unique identifier for the task
            on_success: Callback on successful execution
            on_failure: Callback on final failure
            **kwargs: Keyword arguments for func
            
        Returns:
            Function result or raises last exception
        """
        task_id = task_id or str(id(func))
        retry_count = 0
        last_error = None
        
        while retry_count <= self.max_retries:
            try:
                # Execute function
                result = func(*args, **kwargs)
                
                # Success callback
                if on_success:
                    try:
                        on_success(result, retry_count)
                    except Exception as e:
                        self.logger.warning(
                            f"Success callback failed: {str(e)}",
                            task_id=task_id
                        )
                
                # Log success if retried
                if retry_count > 0:
                    self.logger.info(
                        f"Task {task_id} succeeded after {retry_count} retries"
                    )
                    self._mark_recovered(task_id)
                
                return result
                
            except Exception as e:
                last_error = e
                retry_count += 1
                
                # Determine error severity and action
                severity = self._categorize_error(e)
                action = self._determine_action(e, retry_count, severity)
                
                # Record error
                error_record = self._record_error(
                    error=e,
                    task_id=task_id,
                    severity=severity,
                    action=action,
                    retry_count=retry_count
                )
                
                # Check if should retry
                if action != RecoveryAction.RETRY or retry_count > self.max_retries:
                    self.logger.error(
                        f"Task {task_id} failed after {retry_count} attempts",
                        error=str(e),
                        severity=severity.value,
                        action=action.value
                    )
                    
                    # Failure callback
                    if on_failure:
                        try:
                            on_failure(e, retry_count, error_record)
                        except Exception as callback_error:
                            self.logger.warning(
                                f"Failure callback failed: {str(callback_error)}",
                                task_id=task_id
                            )
                    
                    raise e
                
                # Calculate backoff delay
                delay = self._calculate_backoff(retry_count)
                
                self.logger.warning(
                    f"Task {task_id} failed (attempt {retry_count}/{self.max_retries}), "
                    f"retrying in {delay:.1f}s",
                    error=str(e),
                    severity=severity.value
                )
                
                # Wait before retry
                time.sleep(delay)
        
        # Should not reach here, but just in case
        if last_error:
            raise last_error
    
    def _categorize_error(self, error: Exception) -> ErrorSeverity:
        """
        Categorize error by severity.
        
        Args:
            error: Exception to categorize
            
        Returns:
            ErrorSeverity level
        """
        error_type = type(error).__name__
        
        # Critical errors
        critical_errors = {
            'MemoryError',
            'SystemError',
            'KeyboardInterrupt'
        }
        
        if error_type in critical_errors:
            return ErrorSeverity.CRITICAL
        
        # High severity errors
        high_severity = {
            'RuntimeError',
            'ValueError',
            'TypeError',
            'AttributeError'
        }
        
        if error_type in high_severity:
            return ErrorSeverity.HIGH
        
        # Medium severity errors
        medium_severity = {
            'IOError',
            'OSError',
            'ConnectionError',
            'TimeoutError'
        }
        
        if error_type in medium_severity:
            return ErrorSeverity.MEDIUM
        
        # Default to low severity
        return ErrorSeverity.LOW
    
    def _determine_action(
        self,
        error: Exception,
        retry_count: int,
        severity: ErrorSeverity
    ) -> RecoveryAction:
        """
        Determine recovery action based on error.
        
        Args:
            error: Exception to analyze
            retry_count: Current retry count
            severity: Error severity
            
        Returns:
            RecoveryAction to take
        """
        # Critical errors should abort
        if severity == ErrorSeverity.CRITICAL:
            return RecoveryAction.ABORT
        
        # Default to retry (let max_retries handle the limit)
        return RecoveryAction.RETRY
    
    def _calculate_backoff(self, retry_count: int) -> float:
        """
        Calculate backoff delay with exponential backoff and jitter.
        
        Args:
            retry_count: Current retry attempt number
            
        Returns:
            Delay in seconds
        """
        import random
        
        # Exponential backoff
        delay = min(
            self.initial_backoff * (self.backoff_factor ** (retry_count - 1)),
            self.max_backoff
        )
        
        # Add jitter
        if self.jitter > 0:
            jitter_amount = delay * self.jitter * random.random()
            delay += jitter_amount
        
        return delay
    
    def _record_error(
        self,
        error: Exception,
        task_id: str,
        severity: ErrorSeverity,
        action: RecoveryAction,
        retry_count: int
    ) -> ErrorRecord:
        """
        Record error for tracking and analysis.
        
        Args:
            error: Exception that occurred
            task_id: Task identifier
            severity: Error severity
            action: Recovery action taken
            retry_count: Number of retries so far
            
        Returns:
            ErrorRecord instance
        """
        error_id = f"{task_id}_{retry_count}"
        error_type = type(error).__name__
        
        record = ErrorRecord(
            error_id=error_id,
            timestamp=datetime.now(),
            error_type=error_type,
            error_message=str(error),
            traceback_info=traceback.format_exc(),
            severity=severity,
            recovery_action=action,
            retry_count=retry_count,
            metadata={'task_id': task_id}
        )
        
        self._error_history.append(record)
        self._error_counts[error_type] = self._error_counts.get(error_type, 0) + 1
        
        return record
    
    def _mark_recovered(self, task_id: str) -> None:
        """
        Mark task as recovered after successful retry.
        
        Args:
            task_id: Task identifier
        """
        for record in reversed(self._error_history):
            if record.metadata.get('task_id') == task_id:
                record.recovered = True
                self.logger.info(
                    f"Task {task_id} recovered",
                    error_type=record.error_type,
                    retry_count=record.retry_count
                )
                break
    
    def get_error_history(self) -> List[ErrorRecord]:
        """
        Get complete error history.
        
        Returns:
            List of ErrorRecord instances
        """
        return self._error_history.copy()
    
    def get_error_statistics(self) -> Dict:
        """
        Get error statistics.
        
        Returns:
            Dictionary with error statistics
        """
        total_errors = len(self._error_history)
        recovered = sum(1 for r in self._error_history if r.recovered)
        
        severity_counts = {}
        for record in self._error_history:
            severity = record.severity.value
            severity_counts[severity] = severity_counts.get(severity, 0) + 1
        
        return {
            'total_errors': total_errors,
            'recovered': recovered,
            'unrecovered': total_errors - recovered,
            'recovery_rate': recovered / total_errors if total_errors > 0 else 0.0,
            'error_counts': self._error_counts.copy(),
            'severity_counts': severity_counts
        }
    
    def clear_history(self) -> None:
        """Clear error history"""
        self._error_history.clear()
        self._error_counts.clear()
        self.logger.info("Error history cleared")
