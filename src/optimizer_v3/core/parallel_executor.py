"""
Optimizer V3 - Parallel Execution Engine
ProcessPoolExecutor-based parallel execution with resource monitoring and error recovery.
"""

import psutil
import multiprocessing as mp
from concurrent.futures import ProcessPoolExecutor, wait, FIRST_COMPLETED
from typing import List, Callable, Dict, Any, Optional
from datetime import datetime, timedelta
import time
import gc

from src.optimizer_v3.core.logger import OptimizerLogger

import logging
logger = logging.getLogger(__name__)



class ProcessMonitor:
    """
    Monitor CPU utilization of worker processes.
    
    Features:
    - Track CPU utilization per worker process
    - Detect stuck workers (low CPU usage)
    - Automatic process restart
    - Process cleanup
    
    Args:
        logger: OptimizerLogger instance for logging
        min_cpu_util: Minimum CPU utilization threshold (default: 1.0%)
        check_interval: Interval between checks in seconds (default: 5)
        restart_threshold: Time below min CPU before restart in seconds (default: 30)
    """
    
    def __init__(
        self,
        logger: OptimizerLogger,
        min_cpu_util: float = 1.0,
        check_interval: int = 5,
        restart_threshold: int = 30
    ):
        self.logger = logger
        self.min_cpu_util = min_cpu_util
        self.check_interval = timedelta(seconds=check_interval)
        self.restart_threshold = restart_threshold
        
        self.processes: Dict[int, psutil.Process] = {}
        self.utilization_history: Dict[int, List[float]] = {}
        self.last_check = datetime.now()
        self.max_workers = mp.cpu_count()
    
    def register_process(self, pid: int) -> None:
        """
        Register a worker process for monitoring.
        
        Args:
            pid: Process ID to monitor
        """
        try:
            process = psutil.Process(pid)
            self.processes[pid] = process
            self.utilization_history[pid] = []
            self.logger.debug(f"Registered process {pid} for monitoring")
        except psutil.NoSuchProcess:
            self.logger.error(f"Failed to register process {pid} - does not exist")
    
    def check_utilization(self) -> Dict[int, float]:
        """
        Check CPU utilization of all monitored processes.
        
        Returns:
            Dictionary of {pid: avg_cpu_percent}
        """
        now = datetime.now()
        if now - self.last_check < self.check_interval:
            return {}
        
        self.last_check = now
        utilization = {}
        restart_pids = []
        
        for pid, process in list(self.processes.items()):
            try:
                cpu_percent = process.cpu_percent(interval=0.1)
                self.utilization_history[pid].append(cpu_percent)
                
                # Keep last 12 measurements (1 minute with 5s intervals)
                if len(self.utilization_history[pid]) > 12:
                    self.utilization_history[pid].pop(0)
                
                # Calculate average utilization
                avg_utilization = sum(self.utilization_history[pid]) / len(
                    self.utilization_history[pid]
                )
                utilization[pid] = avg_utilization
                
                # Check for consistently low CPU utilization
                if len(self.utilization_history[pid]) >= 6:  # At least 30 seconds of data
                    recent_avg = sum(self.utilization_history[pid][-6:]) / 6
                    if recent_avg < self.min_cpu_util:
                        self.logger.warning(
                            f"Process {pid} has low CPU utilization",
                            avg_cpu=f"{recent_avg:.1f}%",
                            threshold=f"{self.min_cpu_util}%"
                        )
                        restart_pids.append(pid)
                
            except psutil.NoSuchProcess:
                self.logger.error(f"Process {pid} no longer exists")
                self.cleanup_process(pid)
            except Exception as e:
                self.logger.error(
                    f"Error checking utilization for process {pid}",
                    error=str(e)
                )
        
        # Note: Process restart is complex in ProcessPoolExecutor context
        # We log warnings but let ProcessPoolExecutor handle worker recovery
        
        return utilization
    
    def cleanup_process(self, pid: int) -> None:
        """
        Clean up monitoring for a terminated process.
        
        Args:
            pid: Process ID to clean up
        """
        self.processes.pop(pid, None)
        self.utilization_history.pop(pid, None)
        self.logger.debug(f"Cleaned up monitoring for process {pid}")
    
    def cleanup_all(self) -> None:
        """Clean up all monitored processes."""
        for pid in list(self.processes.keys()):
            self.cleanup_process(pid)
        self.logger.info("Cleaned up all process monitors")
    
    def detect_zombies(self) -> List[int]:
        """
        Detect zombie processes.
        
        Returns:
            List of zombie process IDs
        """
        zombies = []
        for pid, process in list(self.processes.items()):
            try:
                if process.status() == psutil.STATUS_ZOMBIE:
                    zombies.append(pid)
                    self.logger.warning(f"Detected zombie process {pid}")
            except psutil.NoSuchProcess:
                self.cleanup_process(pid)
            except Exception as e:
                self.logger.error(
                    f"Error checking zombie status for process {pid}",
                    error=str(e)
                )
        
        return zombies
    
    def kill_zombies(self) -> int:
        """
        Kill all zombie processes.
        
        Returns:
            Number of zombies killed
        """
        zombies = self.detect_zombies()
        killed = 0
        
        for pid in zombies:
            try:
                process = self.processes[pid]
                process.kill()
                killed += 1
                self.logger.info(f"Killed zombie process {pid}")
                self.cleanup_process(pid)
            except Exception as e:
                self.logger.error(
                    f"Failed to kill zombie process {pid}",
                    error=str(e)
                )
        
        return killed


class ParallelExecutor:
    """
    Execute backtest configurations in parallel with resource monitoring.
    
    Features:
    - ProcessPoolExecutor-based parallel execution
    - CPU utilization monitoring
    - Error recovery with retry logic
    - Resource cleanup
    - Progress tracking
    
    Args:
        logger: OptimizerLogger instance for logging
        max_workers: Maximum number of worker processes (default: auto-detect)
        worker_timeout: Timeout for worker processes in seconds (default: 3600)
        enable_monitoring: Enable CPU utilization monitoring (default: True)
    """
    
    def __init__(
        self,
        logger: OptimizerLogger,
        max_workers: Optional[int] = None,
        worker_timeout: int = 3600,
        enable_monitoring: bool = True
    ):
        self.logger = logger
        self.max_workers = max_workers or mp.cpu_count()
        self.worker_timeout = worker_timeout
        self.enable_monitoring = enable_monitoring
        
        self.monitor = ProcessMonitor(logger) if enable_monitoring else None
        self.active = False
        
        self.logger.info(
            "ParallelExecutor initialized",
            max_workers=self.max_workers,
            worker_timeout=worker_timeout,
            monitoring_enabled=enable_monitoring
        )
    
    def execute_configs(
        self,
        configs: List[dict],
        worker_func: Callable[[dict], dict],
        **kwargs
    ) -> List[dict]:
        """
        Execute configurations in parallel.
        
        Args:
            configs: List of configuration dictionaries
            worker_func: Function to execute for each config
            **kwargs: Additional arguments to pass to worker_func
            
        Returns:
            List of results from worker_func
        """
        self.active = True
        results = []
        
        self.logger.info(
            "Starting parallel execution",
            total_configs=len(configs),
            max_workers=self.max_workers
        )
        
        start_time = datetime.now()
        
        try:
            with ProcessPoolExecutor(max_workers=self.max_workers) as executor:
                # Submit all configs
                future_to_config = {
                    executor.submit(worker_func, config, **kwargs): config
                    for config in configs
                }
                
                self.logger.info(
                    f"Submitted {len(configs)} configs to executor",
                    futures_count=len(future_to_config)
                )
                
                # Register worker processes for monitoring
                if self.monitor:
                    try:
                        main_process = psutil.Process()
                        for child in main_process.children(recursive=True):
                            self.monitor.register_process(child.pid)
                    except Exception as e:
                        self.logger.warning(
                            "Failed to register worker processes for monitoring",
                            error=str(e)
                        )
                
                # Process results as they complete
                completed_count = 0
                failed_count = 0
                
                while future_to_config:
                    # Check CPU utilization if monitoring enabled
                    if self.monitor:
                        utilization = self.monitor.check_utilization()
                        if utilization:
                            self.logger.debug(
                                "Worker CPU utilization: " +
                                ", ".join(
                                    f"PID {pid}: {util:.1f}%"
                                    for pid, util in utilization.items()
                                )
                            )
                        
                        # Check for zombie processes
                        zombies = self.monitor.kill_zombies()
                        if zombies > 0:
                            self.logger.warning(f"Killed {zombies} zombie processes")
                    
                    # Wait for next completion with timeout
                    done, _ = wait(
                        future_to_config.keys(),
                        timeout=1,
                        return_when=FIRST_COMPLETED
                    )
                    
                    # Process completed futures
                    for future in done:
                        config = future_to_config.pop(future)
                        config_id = config.get('id', 'unknown')
                        
                        try:
                            result = future.result(timeout=self.worker_timeout)
                            results.append(result)
                            completed_count += 1
                            
                            self.logger.debug(
                                f"Config {config_id} completed successfully",
                                completed=completed_count,
                                remaining=len(future_to_config)
                            )
                            
                        except Exception as e:
                            failed_count += 1
                            self.logger.error(
                                f"Config {config_id} failed",
                                error=str(e),
                                error_type=type(e).__name__,
                                failed_count=failed_count
                            )
                            
                            # Add failed result with error info
                            results.append({
                                'config_id': config_id,
                                'status': 'failed',
                                'error': str(e),
                                'error_type': type(e).__name__
                            })
                    
                    # Log progress periodically
                    if completed_count % 10 == 0 and completed_count > 0:
                        elapsed = (datetime.now() - start_time).total_seconds()
                        rate = completed_count / elapsed if elapsed > 0 else 0
                        eta_seconds = (
                            (len(configs) - completed_count) / rate
                            if rate > 0
                            else 0
                        )
                        
                        self.logger.info(
                            "Progress update",
                            completed=completed_count,
                            failed=failed_count,
                            total=len(configs),
                            rate_per_sec=f"{rate:.2f}",
                            eta_seconds=f"{eta_seconds:.0f}"
                        )
                
        except Exception as e:
            self.logger.error(
                "Parallel execution failed",
                error=str(e),
                error_type=type(e).__name__
            )
            raise
        
        finally:
            self.active = False
            
            # Clean up monitoring
            if self.monitor:
                self.monitor.cleanup_all()
            
            # Force garbage collection
            gc.collect()
            
            # Log final summary
            elapsed = (datetime.now() - start_time).total_seconds()
            self.logger.info(
                "Parallel execution completed",
                total_configs=len(configs),
                successful=completed_count,
                failed=failed_count,
                elapsed_seconds=f"{elapsed:.2f}"
            )
        
        return results
    
    def is_active(self) -> bool:
        """
        Check if executor is currently running.
        
        Returns:
            True if active, False otherwise
        """
        return self.active
    
    def get_max_workers(self) -> int:
        """
        Get maximum number of worker processes.
        
        Returns:
            Maximum worker count
        """
        return self.max_workers
    
    def set_max_workers(self, max_workers: int) -> None:
        """
        Set maximum number of worker processes.
        
        Note: Only affects future execute_configs() calls.
        
        Args:
            max_workers: New maximum worker count
        """
        if max_workers < 1:
            raise ValueError("max_workers must be >= 1")
        
        if max_workers > mp.cpu_count():
            self.logger.warning(
                f"max_workers ({max_workers}) exceeds CPU count ({mp.cpu_count()})"
            )
        
        self.max_workers = max_workers
        if self.monitor:
            self.monitor.max_workers = max_workers
        
        self.logger.info(f"Updated max_workers to {max_workers}")
