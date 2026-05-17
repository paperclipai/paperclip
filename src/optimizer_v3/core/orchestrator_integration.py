"""
Optimizer V3 - Orchestrator Integration
Integrates parallel execution with the Strategy Builder Orchestrator.
"""

from typing import List, Dict, Optional, Callable
from dataclasses import dataclass
from datetime import datetime

from dotenv import load_dotenv
import os

from src.optimizer_v3.core.logger import OptimizerLogger
from src.optimizer_v3.core.parallel_executor import ParallelExecutor
from src.optimizer_v3.core.progress_tracker import ProgressTracker
from src.optimizer_v3.core.error_recovery import ErrorRecoveryStrategy
from src.optimizer_v3.core.resource_monitor import ResourceMonitor, ResourceStatus
from src.optimizer_v3.core.early_stopping import EarlyStopping, StoppingReason

import logging
logger = logging.getLogger(__name__)

load_dotenv()


@dataclass
class OptimizationConfig:
    """Configuration for optimization run"""
    strategy_id: str
    configs: List[Dict]
    metric_name: str = "sharpe_ratio"
    early_stop_patience: int = int(os.getenv('EARLY_STOP_PATIENCE', '10'))
    early_stop_min_delta: float = float(os.getenv('EARLY_STOP_MIN_DELTA', '0.001'))
    max_workers: Optional[int] = None
    enable_checkpoints: bool = True
    checkpoint_interval: int = 5


@dataclass
class OptimizationResult:
    """Result from optimization run"""
    strategy_id: str
    total_configs: int
    completed_configs: int
    failed_configs: int
    best_config: Optional[Dict]
    best_metric_value: Optional[float]
    stopped_early: bool
    stopping_reason: Optional[str]
    duration_seconds: float
    results: List[Dict]


class OrchestratorIntegration:
    """
    Integrate parallel execution components with Strategy Builder Orchestrator.
    
    Features:
    - Coordinates all parallel execution components
    - Manages resource monitoring during execution
    - Handles progress tracking and reporting
    - Implements error recovery strategies
    - Supports early stopping
    - Provides result aggregation
    
    Args:
        logger: OptimizerLogger instance
        worker_function: Function to execute for each config
    """
    
    def __init__(
        self,
        logger: OptimizerLogger,
        worker_function: Callable[[Dict], Dict]
    ):
        self.logger = logger
        self.worker_function = worker_function
        
        # Initialize components
        self.executor = ParallelExecutor(logger)
        self.progress_tracker = ProgressTracker(total_tasks=0, logger=logger)
        self.error_manager = ErrorRecoveryStrategy(logger)
        self.resource_monitor = ResourceMonitor(logger)
        
        self._running = False
        self._current_optimization: Optional[OptimizationConfig] = None
        
        self.logger.info("OrchestratorIntegration initialized")
    
    def run_optimization(
        self,
        config: OptimizationConfig
    ) -> OptimizationResult:
        """
        Run optimization with full integration of all components.
        
        Args:
            config: OptimizationConfig with run parameters
            
        Returns:
            OptimizationResult with aggregated results
        """
        if self._running:
            raise RuntimeError("Optimization already running")
        
        self._running = True
        self._current_optimization = config
        start_time = datetime.now()
        
        try:
            # Start resource monitoring
            self.resource_monitor.start()
            
            # Initialize progress tracking
            self.progress_tracker.start(
                total=len(config.configs),
                description=f"Optimizing {config.strategy_id}"
            )
            
            # Initialize early stopping if enabled
            early_stopping = None
            if config.early_stop_patience > 0:
                early_stopping = EarlyStopping(
                    logger=self.logger,
                    metric_name=config.metric_name,
                    patience=config.early_stop_patience,
                    min_delta=config.early_stop_min_delta,
                    maximize=True
                )
            
            # Execute configurations
            results = []
            failed_count = 0
            best_config = None
            best_metric = None
            
            for i, cfg in enumerate(config.configs):
                # Check resource status
                resource_status = self.resource_monitor.get_status()
                if resource_status == ResourceStatus.CRITICAL:
                    self.logger.warning("Critical resource usage, pausing briefly")
                    import time
                    time.sleep(5)
                
                # Execute with error recovery
                result = self.error_manager.execute_with_recovery(
                    func=self.worker_function,
                    func_args=(cfg,),
                    config_id=cfg.get('id', f'config_{i}')
                )
                
                if result is not None:
                    results.append(result)
                    
                    # Update progress
                    self.progress_tracker.update(1)
                    
                    # Check early stopping
                    if early_stopping and config.metric_name in result:
                        metric_value = result[config.metric_name]
                        should_continue = early_stopping.update(metric_value)
                        
                        # Track best
                        if best_metric is None or metric_value > best_metric:
                            best_metric = metric_value
                            best_config = cfg
                        
                        if not should_continue:
                            self.logger.info(
                                "Early stopping triggered",
                                reason=early_stopping.get_stopping_reason()
                            )
                            break
                else:
                    failed_count += 1
            
            # Complete progress tracking
            self.progress_tracker.complete()
            
            # Stop resource monitoring
            self.resource_monitor.stop()
            
            # Calculate duration
            duration = (datetime.now() - start_time).total_seconds()
            
            # Create result
            result = OptimizationResult(
                strategy_id=config.strategy_id,
                total_configs=len(config.configs),
                completed_configs=len(results),
                failed_configs=failed_count,
                best_config=best_config,
                best_metric_value=best_metric,
                stopped_early=early_stopping.should_stop() if early_stopping else False,
                stopping_reason=early_stopping.get_stopping_reason().value if early_stopping and early_stopping.should_stop() else None,
                duration_seconds=duration,
                results=results
            )
            
            self.logger.info(
                "Optimization complete",
                strategy_id=config.strategy_id,
                completed=len(results),
                failed=failed_count,
                duration=duration,
                best_metric=best_metric
            )
            
            return result
            
        finally:
            self._running = False
            self._current_optimization = None
            
            # Ensure cleanup
            if self.progress_tracker.is_active():
                self.progress_tracker.complete()
            
            if self.resource_monitor.is_running():
                self.resource_monitor.stop()
    
    def is_running(self) -> bool:
        """Check if optimization is running."""
        return self._running
    
    def get_current_config(self) -> Optional[OptimizationConfig]:
        """Get current optimization configuration."""
        return self._current_optimization
    
    def get_progress(self) -> Dict:
        """Get current progress information."""
        if not self._running:
            return {'status': 'idle'}
        
        progress = self.progress_tracker.get_progress()
        resources = self.resource_monitor.get_current_usage()
        
        return {
            'status': 'running',
            'strategy_id': self._current_optimization.strategy_id if self._current_optimization else None,
            'progress': progress,
            'resources': resources.to_dict(),
            'errors': self.error_manager.get_total_errors()
        }
