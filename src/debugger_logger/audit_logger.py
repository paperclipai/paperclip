"""
Audit Logger - Simplified version for compatibility

This is a simplified stub. Main functionality is in ConfigDebugger.
"""

from enum import Enum
from typing import Any


class AuditEvent(Enum):
    """Audit event types"""
    CONFIG_LOADED = "CONFIG_LOADED"
    CONFIG_USED = "CONFIG_USED"
    DECISION_MADE = "DECISION_MADE"
    ACTION_TAKEN = "ACTION_TAKEN"
    VALIDATION_FAILED = "VALIDATION_FAILED"


class AuditLogger:
    """Simplified audit logger - delegates to ConfigDebugger"""
    
    def __init__(self, name: str):
        self.name = name
    
    def log_event(self, event: AuditEvent, data: Any):
        """Log an audit event"""
        pass  # ConfigDebugger handles this
