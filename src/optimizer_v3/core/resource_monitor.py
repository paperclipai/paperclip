"""
Optimizer V3 - Resource Monitoring System
Real-time monitoring of CPU, memory, and disk resources.
"""

import psutil
from typing import Dict, List, Optional, Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import Enum
import threading
import time

from src.optimizer_v3.core.logger import OptimizerLogger

import logging
logger = logging.getLogger(__name__)



class ResourceType(Enum):
    """Types of system resources"""
    CPU = "cpu"
    MEMORY = "memory"
    DISK = "disk"
    NETWORK = "network"


class ResourceStatus(Enum):
    """Resource usage status"""
    NORMAL = "normal"
    WARNING = "warning"
    CRITICAL = "critical"


@dataclass
class ResourceSnapshot:
    """Snapshot of resource usage at a point in time"""
    timestamp: datetime
    cpu_percent: float
    memory_percent: float
    memory_available_mb: float
    disk_percent: float
    disk_available_gb: float
    network_sent_mb: float = 0.0
    network_recv_mb: float = 0.0
    metadata: Dict = field(default_factory=dict)
    
    def to_dict(self) -> Dict:
        """Convert to dictionary"""
        return {
            'timestamp': self.timestamp.isoformat(),
            'cpu_percent': self.cpu_percent,
            'memory_percent': self.memory_percent,
            'memory_available_mb': self.memory_available_mb,
            'disk_percent': self.disk_percent,
            'disk_available_gb': self.disk_available_gb,
            'network_sent_mb': self.network_sent_mb,
            'network_recv_mb': self.network_recv_mb,
            'metadata': self.metadata
        }


class ResourceMonitor:
    """
    Monitor system resources with threshold alerts.
    
    Features:
    - Real-time CPU, memory, and disk monitoring
    - Threshold-based alerts
    - Resource history tracking
    - Thread-safe operations
    - Automatic cleanup of old data
    - Status callbacks for alerts
    
    Args:
        logger: OptimizerLogger instance
        cpu_threshold: CPU usage warning threshold (percent)
        memory_threshold: Memory usage warning threshold (percent)
        disk_threshold: Disk usage warning threshold (percent)
        check_interval: Interval between checks in seconds
        history_length: Number of snapshots to keep in history
    """
    
    def __init__(
        self,
        logger: OptimizerLogger,
        cpu_threshold: float = 90.0,
        memory_threshold: float = 85.0,
        disk_threshold: float = 90.0,
        check_interval: float = 5.0,
        history_length: int = 60
    ):
        self.logger = logger
        self.cpu_threshold = cpu_threshold
        self.memory_threshold = memory_threshold
        self.disk_threshold = disk_threshold
        self.check_interval = check_interval
        self.history_length = history_length
        
        self._history: List[ResourceSnapshot] = []
        self._lock = threading.RLock()
        self._callbacks: List[Callable] = []
        self._running = False
        self._monitor_thread: Optional[threading.Thread] = None
        self._last_network_io = None
        
        self.logger.info(
            "ResourceMonitor initialized",
            cpu_threshold=cpu_threshold,
            memory_threshold=memory_threshold,
            disk_threshold=disk_threshold,
            check_interval=check_interval
        )
    
    def start(self) -> None:
        """Start resource monitoring"""
        with self._lock:
            if self._running:
                self.logger.warning("ResourceMonitor already running")
                return
            
            self._running = True
            self._monitor_thread = threading.Thread(
                target=self._monitor_loop,
                daemon=True,
                name="ResourceMonitor"
            )
            self._monitor_thread.start()
            
            self.logger.info("ResourceMonitor started")
    
    def stop(self) -> None:
        """Stop resource monitoring"""
        with self._lock:
            if not self._running:
                return
            
            self._running = False
            
            if self._monitor_thread:
                self._monitor_thread.join(timeout=self.check_interval + 1)
                self._monitor_thread = None
            
            self.logger.info("ResourceMonitor stopped")
    
    def is_running(self) -> bool:
        """Check if monitor is running"""
        return self._running
    
    def get_current_usage(self) -> ResourceSnapshot:
        """
        Get current resource usage snapshot.
        
        Returns:
            ResourceSnapshot with current usage
        """
        # CPU usage
        cpu_percent = psutil.cpu_percent(interval=0.1)
        
        # Memory usage
        memory = psutil.virtual_memory()
        memory_percent = memory.percent
        memory_available_mb = memory.available / (1024 * 1024)
        
        # Disk usage
        disk = psutil.disk_usage('/')
        disk_percent = disk.percent
        disk_available_gb = disk.free / (1024 * 1024 * 1024)
        
        # Network I/O
        network_io = psutil.net_io_counters()
        network_sent_mb = 0.0
        network_recv_mb = 0.0
        
        if self._last_network_io:
            network_sent_mb = (network_io.bytes_sent - self._last_network_io.bytes_sent) / (1024 * 1024)
            network_recv_mb = (network_io.bytes_recv - self._last_network_io.bytes_recv) / (1024 * 1024)
        
        self._last_network_io = network_io
        
        return ResourceSnapshot(
            timestamp=datetime.now(),
            cpu_percent=cpu_percent,
            memory_percent=memory_percent,
            memory_available_mb=memory_available_mb,
            disk_percent=disk_percent,
            disk_available_gb=disk_available_gb,
            network_sent_mb=network_sent_mb,
            network_recv_mb=network_recv_mb
        )
    
    def get_status(self) -> ResourceStatus:
        """
        Get overall resource status based on thresholds.
        
        Returns:
            ResourceStatus (NORMAL/WARNING/CRITICAL)
        """
        snapshot = self.get_current_usage()
        
        # Check for critical conditions
        if (snapshot.cpu_percent >= self.cpu_threshold or
            snapshot.memory_percent >= self.memory_threshold or
            snapshot.disk_percent >= self.disk_threshold):
            return ResourceStatus.CRITICAL
        
        # Check for warning conditions (80% of threshold)
        warning_cpu = self.cpu_threshold * 0.8
        warning_memory = self.memory_threshold * 0.8
        warning_disk = self.disk_threshold * 0.8
        
        if (snapshot.cpu_percent >= warning_cpu or
            snapshot.memory_percent >= warning_memory or
            snapshot.disk_percent >= warning_disk):
            return ResourceStatus.WARNING
        
        return ResourceStatus.NORMAL
    
    def get_history(self) -> List[ResourceSnapshot]:
        """
        Get resource usage history.
        
        Returns:
            List of ResourceSnapshot instances
        """
        with self._lock:
            return self._history.copy()
    
    def get_average_usage(self) -> Dict:
        """
        Get average resource usage from history.
        
        Returns:
            Dictionary with average usage statistics
        """
        with self._lock:
            if not self._history:
                return {
                    'cpu_percent': 0.0,
                    'memory_percent': 0.0,
                    'disk_percent': 0.0,
                    'samples': 0
                }
            
            avg_cpu = sum(s.cpu_percent for s in self._history) / len(self._history)
            avg_memory = sum(s.memory_percent for s in self._history) / len(self._history)
            avg_disk = sum(s.disk_percent for s in self._history) / len(self._history)
            
            return {
                'cpu_percent': avg_cpu,
                'memory_percent': avg_memory,
                'disk_percent': avg_disk,
                'samples': len(self._history)
            }
    
    def get_peak_usage(self) -> Dict:
        """
        Get peak resource usage from history.
        
        Returns:
            Dictionary with peak usage statistics
        """
        with self._lock:
            if not self._history:
                return {
                    'cpu_percent': 0.0,
                    'memory_percent': 0.0,
                    'disk_percent': 0.0
                }
            
            peak_cpu = max(s.cpu_percent for s in self._history)
            peak_memory = max(s.memory_percent for s in self._history)
            peak_disk = max(s.disk_percent for s in self._history)
            
            return {
                'cpu_percent': peak_cpu,
                'memory_percent': peak_memory,
                'disk_percent': peak_disk
            }
    
    def register_callback(self, callback: Callable[[ResourceSnapshot, ResourceStatus], None]) -> None:
        """
        Register callback for resource updates.
        
        Args:
            callback: Function to call with (snapshot, status)
        """
        with self._lock:
            if callback not in self._callbacks:
                self._callbacks.append(callback)
                self.logger.debug("Registered resource monitoring callback")
    
    def unregister_callback(self, callback: Callable) -> None:
        """
        Unregister callback.
        
        Args:
            callback: Callback to remove
        """
        with self._lock:
            if callback in self._callbacks:
                self._callbacks.remove(callback)
                self.logger.debug("Unregistered resource monitoring callback")
    
    def clear_history(self) -> None:
        """Clear resource usage history"""
        with self._lock:
            self._history.clear()
            self.logger.info("Resource history cleared")
    
    def _monitor_loop(self) -> None:
        """Main monitoring loop (runs in separate thread)"""
        self.logger.info("Resource monitoring loop started")
        
        while self._running:
            try:
                # Get current snapshot
                snapshot = self.get_current_usage()
                
                # Add to history
                with self._lock:
                    self._history.append(snapshot)
                    
                    # Trim history if needed
                    if len(self._history) > self.history_length:
                        self._history.pop(0)
                
                # Get status
                status = self.get_status()
                
                # Log warnings/critical
                if status == ResourceStatus.CRITICAL:
                    self.logger.warning(
                        "CRITICAL resource usage",
                        cpu_percent=snapshot.cpu_percent,
                        memory_percent=snapshot.memory_percent,
                        disk_percent=snapshot.disk_percent
                    )
                elif status == ResourceStatus.WARNING:
                    self.logger.info(
                        "WARNING resource usage",
                        cpu_percent=snapshot.cpu_percent,
                        memory_percent=snapshot.memory_percent,
                        disk_percent=snapshot.disk_percent
                    )
                
                # Call callbacks
                for callback in self._callbacks.copy():
                    try:
                        callback(snapshot, status)
                    except Exception as e:
                        self.logger.error(
                            f"Resource callback failed: {str(e)}",
                            callback=str(callback)
                        )
                
                # Sleep until next check
                time.sleep(self.check_interval)
                
            except Exception as e:
                self.logger.error(f"Resource monitoring error: {str(e)}")
                time.sleep(self.check_interval)
        
        self.logger.info("Resource monitoring loop stopped")
