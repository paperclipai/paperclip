"""ANSI color formatting for output in terminal."""

from __future__ import annotations

from termcolor.termcolor import (
    ATTRIBUTES,
    COLORS,
    HIGHLIGHTS,
    RESET,
    can_colorize,
    colored,
    cprint,
)

__all__ = [
    "ATTRIBUTES",
    "COLORS",
    "HIGHLIGHTS",
    "RESET",
    "can_colorize",
    "colored",
    "cprint",
]
