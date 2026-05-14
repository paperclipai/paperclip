"""
Database Base Model - Re-export from database.models
====================================================

This module re-exports the SQLAlchemy Base for ORM models.
Provides a consistent import path for all optimizer_v3 models.

CRITICAL: All ORM models should inherit from this Base.
"""

from src.optimizer_v3.database.models import Base

__all__ = ['Base']
