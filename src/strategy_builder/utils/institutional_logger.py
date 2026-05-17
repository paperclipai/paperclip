"""
Institutional-Grade Strategy Builder Logger
===========================================

Provides comprehensive logging and debugging capabilities for the Strategy Builder.
Designed for complex system troubleshooting with granular visibility.

Features:
- Multi-level logging (DEBUG, INFO, WARNING, ERROR, CRITICAL)
- Component-specific logging with tags
- Stack trace capture for errors
- Performance metrics
- File + Console + UI output
- Thread-safe operations
- Log filtering and search
- Export capabilities

Author: Strategy Builder Team
Date: 2026-01-16
Version: 1.0
"""

import logging
import traceback
import time
from datetime import datetime
from typing import Optional, List, Dict, Any, Callable
from enum import Enum
from pathlib import Path
import json
from threading import Lock

import logging
logger = logging.getLogger(__name__)



class LogLevel(Enum):
    """Log levels with numeric values for filtering"""
    DEBUG = 10
    INFO = 20
    WARNING = 30
    ERROR = 40
    CRITICAL = 50


class LogComponent(Enum):
    """Components that can emit logs"""
    MAIN_WINDOW = "MainWindow"
    INFO_PANEL = "InfoPanel"
    SEARCH_PANEL = "SearchPanel"
    BLOCKS_PANEL = "BlocksPanel"
    ORCHESTRATOR = "Orchestrator"
    REGISTRY_INTERFACE = "RegistryInterface"
    REGISTRY_ADAPTER = "RegistryAdapter"
    CONFIG_ENGINE = "ConfigEngine"
    DEPENDENCY_RESOLVER = "DependencyResolver"
    CODE_GENERATOR = "CodeGenerator"
    TEST_ENGINE = "TestEngine"
    VALIDATOR = "Validator"
    PERSISTENCE = "Persistence"
    BLOCK_REGISTRY = "BlockRegistry"
    SYSTEM = "System"
    UI = "UI"
    BACKEND = "Backend"


class LogEntry:
    """
    Structured log entry with all metadata
    """
    def __init__(
        self,
        level: LogLevel,
        component: LogComponent,
        message: str,
        details: Optional[Dict[str, Any]] = None,
        exception: Optional[Exception] = None,
        stack_trace: Optional[str] = None
    ):
        self.timestamp = datetime.now()
        self.level = level
        self.component = component
        self.message = message
        self.details = details or {}
        self.exception = exception
        self.stack_trace = stack_trace
        
        # Auto-capture stack trace for errors
        if level.value >= LogLevel.ERROR.value and not stack_trace and not exception:
            self.stack_trace = ''.join(traceback.format_stack()[:-1])
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON export"""
        return {
            'timestamp': self.timestamp.isoformat(),
            'level': self.level.name,
            'component': self.component.value,
            'message': self.message,
            'details': self.details,
            'exception': str(self.exception) if self.exception else None,
            'stack_trace': self.stack_trace
        }
    
    def format_console(self) -> str:
        """Format for console output"""
        time_str = self.timestamp.strftime('%H:%M:%S.%f')[:-3]
        level_str = self.level.name.ljust(8)
        component_str = self.component.value.ljust(20)
        
        msg = f"[{time_str}] {level_str} [{component_str}] {self.message}"
        
        if self.details:
            msg += f"\n         Details: {json.dumps(self.details, indent=2)}"
        
        if self.exception:
            msg += f"\n         Exception: {type(self.exception).__name__}: {str(self.exception)}"
        
        if self.stack_trace:
            msg += f"\n         Stack Trace:\n{self.stack_trace}"
        
        return msg
    
    def format_ui(self) -> str:
        """Format for UI display (compact)"""
        time_str = self.timestamp.strftime('%H:%M:%S')
        return f"[{time_str}] [{self.component.value}] {self.message}"


class InstitutionalLogger:
    """
    Institutional-grade logger for Strategy Builder
    
    Thread-safe, multi-output, filterable logging system.
    """
    
    _instance = None
    _lock = Lock()
    
    def __new__(cls):
        """Singleton pattern"""
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
        return cls._instance
    
    def __init__(self):
        """Initialize the logger"""
        if hasattr(self, '_initialized'):
            return
        
        self._initialized = True
        self.entries: List[LogEntry] = []
        self.ui_callbacks: List[Callable[[LogEntry], None]] = []
        self.min_level = LogLevel.DEBUG
        self.max_entries = 10000  # Limit to prevent memory issues
        
        # Performance tracking
        self.component_stats: Dict[str, Dict[str, Any]] = {}
        self.error_counts: Dict[str, int] = {}
        
        # File logging
        self.log_dir = Path("logs/strategy_builder")
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self.current_log_file = self.log_dir / f"session_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log"
        
        # Python logging integration
        self.python_logger = logging.getLogger("StrategyBuilder")
        self.python_logger.setLevel(logging.DEBUG)
        
        # File handler
        file_handler = logging.FileHandler(self.current_log_file)
        file_handler.setFormatter(
            logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
        )
        self.python_logger.addHandler(file_handler)
        
        # Console handler
        console_handler = logging.StreamHandler()
        console_handler.setFormatter(
            logging.Formatter('%(levelname)s - %(message)s')
        )
        self.python_logger.addHandler(console_handler)
        
        # Initial log
        self.info(LogComponent.SYSTEM, "Institutional Logger initialized", {
            'log_file': str(self.current_log_file),
            'max_entries': self.max_entries
        })
    
    def set_min_level(self, level: LogLevel):
        """Set minimum logging level"""
        self.min_level = level
        self.debug(LogComponent.SYSTEM, f"Log level set to {level.name}")
    
    def register_ui_callback(self, callback: Callable[[LogEntry], None]):
        """Register a callback for UI updates"""
        self.ui_callbacks.append(callback)
    
    def _emit(self, entry: LogEntry):
        """Emit a log entry to all outputs"""
        #  Filter by level
        if entry.level.value < self.min_level.value:
            return
        
        # Add to entries list
        with self._lock:
            self.entries.append(entry)
            
            # Trim if exceeds max
            if len(self.entries) > self.max_entries:
                self.entries = self.entries[-self.max_entries:]
        
        # Update stats
        self._update_stats(entry)
        
        # Python logger
        log_func = self._get_python_log_function(entry.level)
        log_func(entry.format_console())
        
        # UI callbacks
        for callback in self.ui_callbacks:
            try:
                callback(entry)
            except Exception as e:
                # Avoid infinite loop if UI callback fails
                logger.error(f"UI callback error: {e}")
    
    def _get_python_log_function(self, level: LogLevel):
        """Get corresponding Python logging function"""
        mapping = {
            LogLevel.DEBUG: self.python_logger.debug,
            LogLevel.INFO: self.python_logger.info,
            LogLevel.WARNING: self.python_logger.warning,
            LogLevel.ERROR: self.python_logger.error,
            LogLevel.CRITICAL: self.python_logger.critical
        }
        return mapping.get(level, self.python_logger.info)
    
    def _update_stats(self, entry: LogEntry):
        """Update component statistics"""
        comp_name = entry.component.value
        
        if comp_name not in self.component_stats:
            self.component_stats[comp_name] = {
                'total_logs': 0,
                'errors': 0,
                'warnings': 0,
                'first_seen': entry.timestamp,
                'last_seen': entry.timestamp
            }
        
        stats = self.component_stats[comp_name]
        stats['total_logs'] += 1
        stats['last_seen'] = entry.timestamp
        
        if entry.level == LogLevel.ERROR or entry.level == LogLevel.CRITICAL:
            stats['errors'] += 1
            self.error_counts[comp_name] = self.error_counts.get(comp_name, 0) + 1
        elif entry.level == LogLevel.WARNING:
            stats['warnings'] += 1
    
    # Convenience methods
    #
    # All level methods accept two calling conventions:
    #
    #   Preferred (structured):
    #       logger.info(LogComponent.SYSTEM, "message", {details})
    #
    #   Legacy / plain-string (backward-compatible):
    #       logger.info("message")
    #
    # When the first argument is a plain string (not a LogComponent), it is
    # treated as the message and component defaults to LogComponent.SYSTEM.

    @staticmethod
    def _normalize_args(
        component_or_msg,
        message: Optional[str],
        details: Optional[Dict[str, Any]],
    ):
        """Resolve (component, message, details) from overloaded positional args."""
        if isinstance(component_or_msg, LogComponent):
            return component_or_msg, message, details
        # First arg is the message string; shift positional args left.
        # component_or_msg → message, message → details (was None or a dict from caller)
        return LogComponent.SYSTEM, component_or_msg, message

    def debug(self, component_or_msg, message: Optional[str] = None, details: Optional[Dict[str, Any]] = None):
        """Log debug message.

        Accepts both:
            debug(LogComponent.X, "msg", {...})
            debug("msg")
        """
        component, message, details = self._normalize_args(component_or_msg, message, details)
        entry = LogEntry(LogLevel.DEBUG, component, message, details)
        self._emit(entry)

    def info(self, component_or_msg, message: Optional[str] = None, details: Optional[Dict[str, Any]] = None):
        """Log info message.

        Accepts both:
            info(LogComponent.X, "msg", {...})
            info("msg")
        """
        component, message, details = self._normalize_args(component_or_msg, message, details)
        entry = LogEntry(LogLevel.INFO, component, message, details)
        self._emit(entry)

    def warning(self, component_or_msg, message: Optional[str] = None, details: Optional[Dict[str, Any]] = None):
        """Log warning message.

        Accepts both:
            warning(LogComponent.X, "msg", {...})
            warning("msg")
        """
        component, message, details = self._normalize_args(component_or_msg, message, details)
        entry = LogEntry(LogLevel.WARNING, component, message, details)
        self._emit(entry)

    def error(
        self,
        component_or_msg,
        message: Optional[str] = None,
        details: Optional[Dict[str, Any]] = None,
        exception: Optional[Exception] = None,
    ):
        """Log error message.

        Accepts both:
            error(LogComponent.X, "msg", {...}, exc)
            error("msg")
        """
        component, message, details = self._normalize_args(component_or_msg, message, details)
        entry = LogEntry(LogLevel.ERROR, component, message, details, exception)
        self._emit(entry)

    def critical(
        self,
        component_or_msg,
        message: Optional[str] = None,
        details: Optional[Dict[str, Any]] = None,
        exception: Optional[Exception] = None,
    ):
        """Log critical message.

        Accepts both:
            critical(LogComponent.X, "msg", {...}, exc)
            critical("msg")
        """
        component, message, details = self._normalize_args(component_or_msg, message, details)
        entry = LogEntry(LogLevel.CRITICAL, component, message, details, exception)
        self._emit(entry)
    
    def exception(self, component: LogComponent, message: str, exc: Exception):
        """Log exception with full stack trace"""
        stack_trace = traceback.format_exc()
        entry = LogEntry(
            LogLevel.ERROR,
            component,
            message,
            exception=exc,
            stack_trace=stack_trace
        )
        self._emit(entry)
    
    def performance(self, component: LogComponent, operation: str, duration_ms: float, details: Optional[Dict[str, Any]] = None):
        """Log performance metric"""
        perf_details = {'operation': operation, 'duration_ms': duration_ms}
        if details:
            perf_details.update(details)
        
        level = LogLevel.DEBUG if duration_ms < 1000 else LogLevel.WARNING
        self.debug(component, f"Performance: {operation} took {duration_ms:.2f}ms", perf_details)
    
    # Query and filter methods
    
    def get_entries(
        self,
        component: Optional[LogComponent] = None,
        level: Optional[LogLevel] = None,
       
 search: Optional[str] = None,
        limit: int = 100
    ) -> List[LogEntry]:
        """Get filtered log entries"""
        filtered = self.entries
        
        if component:
            filtered = [e for e in filtered if e.component == component]
        
        if level:
            filtered = [e for e in filtered if e.level == level]
        
        if search:
            search_lower = search.lower()
            filtered = [
                e for e in filtered
                if search_lower in e.message.lower()
                or search_lower in str(e.details).lower()
            ]
        
        return filtered[-limit:]
    
    def get_errors(self, limit: int = 50) -> List[LogEntry]:
        """Get recent error entries"""
        return [
            e for e in self.entries
            if e.level.value >= LogLevel.ERROR.value
        ][-limit:]
    
    def get_component_stats(self) -> Dict[str, Dict[str, Any]]:
        """Get statistics per component"""
        return self.component_stats.copy()
    
    def export_to_file(self, filepath: Optional[Path] = None) -> Path:
        """Export all logs to JSON file"""
        if filepath is None:
            filepath = self.log_dir / f"export_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        
        data = {
            'export_time': datetime.now().isoformat(),
            'total_entries': len(self.entries),
            'component_stats': self.component_stats,
            'error_counts': self.error_counts,
            'entries': [e.to_dict() for e in self.entries]
        }
        
        with open(filepath, 'w') as f:
            json.dump(data, f, indent=2)
        
        self.info(LogComponent.SYSTEM, f"Logs exported to {filepath}")
        return filepath
    
    def clear(self):
        """Clear all log entries"""
        with self._lock:
            count = len(self.entries)
            self.entries.clear()
            self.component_stats.clear()
            self.error_counts.clear()
        
        self.info(LogComponent.SYSTEM, f"Cleared {count} log entries")


# Singleton instance
logger = InstitutionalLogger()
