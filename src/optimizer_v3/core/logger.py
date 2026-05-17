"""
Optimizer V3 - Multi-level Structured Logger
Provides comprehensive logging for all optimizer operations with session tracking.
"""

import logging
import uuid
import os
from datetime import datetime
from pathlib import Path
from typing import Optional

import logging
logger = logging.getLogger(__name__)



class OptimizerLogger:
    """
    Multi-level structured logging system for Optimizer V3.
    
    Features:
    - Session-based logging with unique IDs
    - File and console output
    - Component-specific loggers
    - Structured metadata support
    - Automatic log directory creation
    
    Args:
        component: Name of the component creating the logger
        log_dir: Directory for log files (default: logs/)
        log_level: Logging level (default: DEBUG)
    """
    
    def __init__(
        self,
        component: str,
        log_dir: str = "logs",
        log_level: int = logging.DEBUG
    ):
        self.component = component
        self.session_id = uuid.uuid4()
        self.start_time = datetime.now()
        self.log_dir = Path(log_dir)
        
        # Create log directory if it doesn't exist
        self.log_dir.mkdir(parents=True, exist_ok=True)
        
        # Create component-specific logger
        self.logger = logging.getLogger(f"optimizer_v3.{component}")
        self.logger.setLevel(log_level)
        
        # Remove existing handlers to avoid duplicates
        if self.logger.handlers:
            self.logger.handlers.clear()
        
        # File handler - detailed logging
        log_file = self.log_dir / f"optimizer_v3_{component}_{self.session_id}.log"
        file_handler = logging.FileHandler(log_file)
        file_handler.setLevel(logging.DEBUG)
        file_formatter = logging.Formatter(
            '%(asctime)s | %(name)s | %(levelname)s | %(funcName)s | %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'
        )
        file_handler.setFormatter(file_formatter)
        
        # Console handler - INFO and above
        console_handler = logging.StreamHandler()
        console_handler.setLevel(logging.INFO)
        console_formatter = logging.Formatter(
            '%(asctime)s | %(levelname)s | %(message)s',
            datefmt='%H:%M:%S'
        )
        console_handler.setFormatter(console_formatter)
        
        # Add handlers
        self.logger.addHandler(file_handler)
        self.logger.addHandler(console_handler)
        
        # Log session start
        self.info(
            f"Logger initialized for {component}",
            session_id=str(self.session_id),
            log_file=str(log_file)
        )
    
    def debug(self, message: str, **kwargs) -> None:
        """
        Log debug message with optional metadata.
        
        Args:
            message: Log message
            **kwargs: Additional metadata to include
        """
        extra_info = self._format_extra(kwargs)
        self.logger.debug(f"{message}{extra_info}")
    
    def info(self, message: str, **kwargs) -> None:
        """
        Log info message with optional metadata.
        
        Args:
            message: Log message
            **kwargs: Additional metadata to include
        """
        extra_info = self._format_extra(kwargs)
        self.logger.info(f"{message}{extra_info}")
    
    def warning(self, message: str, **kwargs) -> None:
        """
        Log warning message with optional metadata.
        
        Args:
            message: Log message
            **kwargs: Additional metadata to include
        """
        extra_info = self._format_extra(kwargs)
        self.logger.warning(f"{message}{extra_info}")
    
    def error(self, message: str, **kwargs) -> None:
        """
        Log error message with optional metadata.
        
        Args:
            message: Log message
            **kwargs: Additional metadata to include
        """
        extra_info = self._format_extra(kwargs)
        self.logger.error(f"{message}{extra_info}")
    
    def critical(self, message: str, **kwargs) -> None:
        """
        Log critical message with optional metadata.
        
        Args:
            message: Log message
            **kwargs: Additional metadata to include
        """
        extra_info = self._format_extra(kwargs)
        self.logger.critical(f"{message}{extra_info}")
    
    def _format_extra(self, kwargs: dict) -> str:
        """
        Format extra metadata as string.
        
        Args:
            kwargs: Metadata dictionary
            
        Returns:
            Formatted string of metadata
        """
        if not kwargs:
            return ""
        
        parts = [f"{k}={v}" for k, v in kwargs.items()]
        return f" | {' | '.join(parts)}"
    
    def get_session_id(self) -> str:
        """
        Get current session ID.
        
        Returns:
            Session ID as string
        """
        return str(self.session_id)
    
    def get_session_duration(self) -> float:
        """
        Get duration of current session in seconds.
        
        Returns:
            Duration in seconds
        """
        return (datetime.now() - self.start_time).total_seconds()
    
    def close(self) -> None:
        """
        Close logger and log session end.
        """
        duration = self.get_session_duration()
        self.info(
            f"Logger closing for {self.component}",
            session_duration_seconds=f"{duration:.2f}"
        )
        
        # Close all handlers
        for handler in self.logger.handlers[:]:
            handler.close()
            self.logger.removeHandler(handler)
