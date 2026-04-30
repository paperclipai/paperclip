"""
TODO:
"""

from __future__ import annotations

__all__ = [
    "Error",
    "ParserError",
    "UniquenessError",
]


from typing import Any, Optional


class Error(Exception):
    """Base class for rdflib exceptions."""

    def __init__(self, msg: Optional[str] = None):
        Exception.__init__(self, msg)
        self.msg = msg


class ParserError(Error):
    """RDF Parser error."""

    def __init__(self, msg: str):
        Error.__init__(self, msg)
        self.msg: str = msg

    def __str__(self) -> str:
        return self.msg


class UniquenessError(Error):
    """A uniqueness assumption was made in the context, and that is not true"""

    def __init__(self, values: Any):
        Error.__init__(
            self,
            "\
Uniqueness assumption is not fulfilled. Multiple values are: %s"
            % values,
        )
