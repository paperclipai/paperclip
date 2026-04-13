"""Sandbox audit middleware — classifies bash commands by risk level.

3-tier classification:
- HIGH: Destructive/dangerous commands that are blocked
- MEDIUM: Package installs, network downloads — logged and allowed
- LOW: Normal commands — allowed silently
"""

import re
from enum import Enum
from typing import Any


class RiskLevel(Enum):
    """Risk classification for bash commands."""
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


# High-risk patterns — these commands are blocked
_HIGH_RISK_PATTERNS = [
    re.compile(r"\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|f[a-zA-Z]*r)\s+/", re.IGNORECASE),
    re.compile(r"\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+/\s*$", re.IGNORECASE),
    re.compile(r"\bchmod\s+777\b", re.IGNORECASE),
    re.compile(r"\bcurl\b.*\|\s*(sh|bash|zsh)\b", re.IGNORECASE),
    re.compile(r"\bwget\b.*\|\s*(sh|bash|zsh)\b", re.IGNORECASE),
    re.compile(r"\bdd\s+if=", re.IGNORECASE),
    re.compile(r"\bmkfs\b", re.IGNORECASE),
    re.compile(r"\bformat\s+[a-zA-Z]:", re.IGNORECASE),
    re.compile(r">\s*/dev/sd[a-z]", re.IGNORECASE),
    re.compile(r"\b(nc|ncat|netcat)\s+.*-[a-zA-Z]*l", re.IGNORECASE),
    re.compile(r"\biptables\s+.*-[A-Z]\s+(INPUT|OUTPUT|FORWARD)\s+.*-j\s+DROP", re.IGNORECASE),
    re.compile(r"\bkill\s+(-9\s+)?1\b", re.IGNORECASE),
    re.compile(r"\b(shutdown|reboot|halt|poweroff)\b", re.IGNORECASE),
    re.compile(r":\(\)\{.*:\|:&\s*\};:", re.IGNORECASE),
    re.compile(r"\bchown\s+.*\s+/\s*$", re.IGNORECASE),
]

# Medium-risk patterns — logged and allowed
_MEDIUM_RISK_PATTERNS = [
    re.compile(r"\b(apt|apt-get|yum|dnf|apk)\s+(install|remove|purge)\b", re.IGNORECASE),
    re.compile(r"\b(pip|pip3)\s+install\b", re.IGNORECASE),
    re.compile(r"\bnpm\s+install\b", re.IGNORECASE),
    re.compile(r"\bwget\s+", re.IGNORECASE),
    re.compile(r"\bcurl\s+.*-[a-zA-Z]*o\b", re.IGNORECASE),
    re.compile(r"\bgit\s+clone\b", re.IGNORECASE),
]


def classify_command(command: str) -> RiskLevel:
    """Classify a bash command by risk level."""
    command = command.strip()
    for pattern in _HIGH_RISK_PATTERNS:
        if pattern.search(command):
            return RiskLevel.HIGH
    for pattern in _MEDIUM_RISK_PATTERNS:
        if pattern.search(command):
            return RiskLevel.MEDIUM
    return RiskLevel.LOW


# Compound command separators
_COMPOUND_SEPARATORS = re.compile(r"\s*(?:&&|\|\||[;|])\s*")


def split_compound_command(command: str) -> list[str]:
    """Split a compound command into individual segments."""
    parts = _COMPOUND_SEPARATORS.split(command.strip())
    return [p.strip() for p in parts if p.strip()]


def classify_compound_command(command: str) -> RiskLevel:
    """Classify a compound command. Returns the highest risk of any segment."""
    segments = split_compound_command(command)
    if not segments:
        return RiskLevel.LOW
    risk_order = {RiskLevel.LOW: 0, RiskLevel.MEDIUM: 1, RiskLevel.HIGH: 2}
    highest = RiskLevel.LOW
    for segment in segments:
        level = classify_command(segment)
        if risk_order[level] > risk_order[highest]:
            highest = level
        if highest == RiskLevel.HIGH:
            break
    return highest


_DEFAULT_MAX_COMMAND_LENGTH = 10000


class SanitizationError(ValueError):
    """Raised when a command fails sanitisation checks."""
    pass


def sanitize_command(command: str, max_length: int = _DEFAULT_MAX_COMMAND_LENGTH) -> str:
    """Validate and sanitize a bash command.

    Returns the stripped command, or raises SanitizationError.
    """
    stripped = command.strip()
    if not stripped:
        raise SanitizationError("Command is empty")
    if len(stripped) > max_length:
        raise SanitizationError(f"Command exceeds maximum length ({len(stripped)} > {max_length})")
    if "\x00" in stripped:
        raise SanitizationError("Command contains null byte")
    return stripped
