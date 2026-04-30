"""
This module defines all exception classes in the whole package.
"""


class ISO8601Error(ValueError):
    """Raised when the given ISO string can not be parsed."""
