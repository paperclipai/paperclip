"""
Optimizer V3 Validation Module
Sprint 1.9: Institutional-Grade Validation Framework

Exports:
- InstitutionalValidator: Main validator class
- ValidationReport: Complete validation report with issues and metrics
- ValidationIssue: Single validation issue
- ValidationSeverity: Issue severity levels
- TimelineEvent: Timeline event for visualization

Author: BTC_Engine_v3
Date: 2026-01-30
"""

from src.optimizer_v3.validation.institutional_validator import (
    InstitutionalValidator,
    ValidationReport,
    ValidationIssue,
    ValidationSeverity,
    TimelineEvent
)

__all__ = [
    'InstitutionalValidator',
    'ValidationReport',
    'ValidationIssue',
    'ValidationSeverity',
    'TimelineEvent'
]
