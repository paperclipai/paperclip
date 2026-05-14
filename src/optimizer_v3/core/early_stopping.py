"""
Optimizer V3 - Early Stopping System
Detect when optimization should stop based on lack of improvement.
"""

from typing import Optional, Callable, List, Dict
from dataclasses import dataclass
from datetime import datetime
from enum import Enum

from src.optimizer_v3.core.logger import OptimizerLogger

import logging
logger = logging.getLogger(__name__)



class StoppingReason(Enum):
    """Reasons for early stopping"""
    NO_IMPROVEMENT = "no_improvement"
    PATIENCE_EXCEEDED = "patience_exceeded"
    TARGET_REACHED = "target_reached"
    USER_STOPPED = "user_stopped"
    RESOURCE_LIMIT = "resource_limit"


@dataclass
class ImprovementRecord:
    """Record of a metric improvement"""
    timestamp: datetime
    iteration: int
    metric_value: float
    improvement: float
    is_improvement: bool


class EarlyStopping:
    """
    Early stopping mechanism for optimization.
    
    Features:
    - Tracks metric improvements over time
    - Configurable patience (iterations without improvement)
    - Minimum improvement delta threshold
    - Best value tracking
    - Stop callbacks for cleanup
    
    Args:
        logger: OptimizerLogger instance
        metric_name: Name of metric to monitor (e.g., 'sharpe_ratio')
        patience: Number of iterations without improvement before stopping
        min_delta: Minimum improvement to count as progress
        maximize: Whether to maximize (True) or minimize (False) the metric
    """
    
    def __init__(
        self,
        logger: OptimizerLogger,
        metric_name: str = "sharpe_ratio",
        patience: int = 10,
        min_delta: float = 0.001,
        maximize: bool = True
    ):
        self.logger = logger
        self.metric_name = metric_name
        self.patience = patience
        self.min_delta = min_delta
        self.maximize = maximize
        
        self._best_value: Optional[float] = None
        self._best_iteration: int = 0
        self._iterations_without_improvement: int = 0
        self._current_iteration: int = 0
        self._should_stop: bool = False
        self._stopping_reason: Optional[StoppingReason] = None
        self._history: List[ImprovementRecord] = []
        self._stop_callbacks: List[Callable] = []
        
        self.logger.info(
            f"EarlyStopping initialized",
            metric=metric_name,
            patience=patience,
            min_delta=min_delta,
            maximize=maximize
        )
    
    def update(self, metric_value: float) -> bool:
        """
        Update with new metric value and check if should stop.
        
        Args:
            metric_value: Current metric value
            
        Returns:
            True if should continue, False if should stop
        """
        self._current_iteration += 1
        
        # Determine if this is an improvement
        is_improvement = False
        improvement = 0.0
        
        if self._best_value is None:
            # First iteration
            self._best_value = metric_value
            self._best_iteration = self._current_iteration
            is_improvement = True
            improvement = 0.0
        else:
            # Calculate improvement
            if self.maximize:
                improvement = metric_value - self._best_value
                is_improvement = improvement > self.min_delta
            else:
                improvement = self._best_value - metric_value
                is_improvement = improvement > self.min_delta
        
        # Record the update
        record = ImprovementRecord(
            timestamp=datetime.now(),
            iteration=self._current_iteration,
            metric_value=metric_value,
            improvement=improvement,
            is_improvement=is_improvement
        )
        self._history.append(record)
        
        # Update best value and iteration counter
        if is_improvement:
            self._best_value = metric_value
            self._best_iteration = self._current_iteration
            self._iterations_without_improvement = 0
            
            self.logger.info(
                f"New best {self.metric_name}: {metric_value:.6f}",
                iteration=self._current_iteration,
                improvement=improvement
            )
        else:
            self._iterations_without_improvement += 1
            
            self.logger.debug(
                f"No improvement in {self.metric_name}",
                iteration=self._current_iteration,
                current=metric_value,
                best=self._best_value,
                patience_remaining=self.patience - self._iterations_without_improvement
            )
        
        # Check if should stop
        if self._iterations_without_improvement >= self.patience:
            self.stop(StoppingReason.PATIENCE_EXCEEDED)
            return False
        
        return not self._should_stop
    
    def stop(self, reason: StoppingReason) -> None:
        """
        Trigger early stopping.
        
        Args:
            reason: Reason for stopping
        """
        if self._should_stop:
            return
        
        self._should_stop = True
        self._stopping_reason = reason
        
        self.logger.warning(
            f"Early stopping triggered: {reason.value}",
            iterations=self._current_iteration,
            best_iteration=self._best_iteration,
            best_value=self._best_value,
            iterations_without_improvement=self._iterations_without_improvement
        )
        
        # Call stop callbacks
        for callback in self._stop_callbacks:
            try:
                callback(self)
            except Exception as e:
                self.logger.error(
                    f"Stop callback failed: {str(e)}",
                    callback=str(callback)
                )
    
    def register_stop_callback(self, callback: Callable) -> None:
        """
        Register callback to be called when stopping.
        
        Args:
            callback: Function to call with self as argument
        """
        if callback not in self._stop_callbacks:
            self._stop_callbacks.append(callback)
            self.logger.debug("Registered early stopping callback")
    
    def unregister_stop_callback(self, callback: Callable) -> None:
        """
        Unregister stop callback.
        
        Args:
            callback: Callback to remove
        """
        if callback in self._stop_callbacks:
            self._stop_callbacks.remove(callback)
            self.logger.debug("Unregistered early stopping callback")
    
    def should_stop(self) -> bool:
        """Check if optimization should stop."""
        return self._should_stop
    
    def get_best_value(self) -> Optional[float]:
        """Get best metric value seen so far."""
        return self._best_value
    
    def get_best_iteration(self) -> int:
        """Get iteration where best value was found."""
        return self._best_iteration
    
    def get_stopping_reason(self) -> Optional[StoppingReason]:
        """Get reason for stopping."""
        return self._stopping_reason
    
    def get_history(self) -> List[ImprovementRecord]:
        """Get improvement history."""
        return self._history.copy()
    
    def get_statistics(self) -> Dict:
        """
        Get early stopping statistics.
        
        Returns:
            Dictionary with statistics
        """
        total_improvements = sum(1 for r in self._history if r.is_improvement)
        
        return {
            'total_iterations': self._current_iteration,
            'best_value': self._best_value,
            'best_iteration': self._best_iteration,
            'total_improvements': total_improvements,
            'improvement_rate': total_improvements / self._current_iteration if self._current_iteration > 0 else 0.0,
            'iterations_without_improvement': self._iterations_without_improvement,
            'should_stop': self._should_stop,
            'stopping_reason': self._stopping_reason.value if self._stopping_reason else None
        }
    
    def reset(self) -> None:
        """Reset early stopping state."""
        self._best_value = None
        self._best_iteration = 0
        self._iterations_without_improvement = 0
        self._current_iteration = 0
        self._should_stop = False
        self._stopping_reason = None
        self._history.clear()
        
        self.logger.info("Early stopping reset")
