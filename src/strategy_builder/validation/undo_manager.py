"""
UndoManager - Undo support for auto-fix operations in ValidationReportWindow

Tracks applied auto-fix operations and exposes can_undo() / undo_last_fix()
so the UI can offer one-level-deep undo after each fix.

Integrates with AutoFixSafety: each successful fix should call
undo_manager.record_fix(backup) immediately after AutoFixSafety.backup_strategy()
returns the snapshot.

Author: UIEngineer / BTC_Engine_v3
Date: 2026-05-04
"""

from typing import Optional, List, Dict, Any
from copy import deepcopy
import logging
from datetime import datetime

from src.strategy_builder.core.strategy_config_engine import StrategyConfig

import logging
logger = logging.getLogger(__name__)


logger = logging.getLogger(__name__)


class UndoManager:
    """
    Undo history manager for auto-fix operations.

    Design contract:
    - The window calls record_fix(snapshot, label) *before* applying a fix,
      passing the deep-copied pre-fix strategy state.
    - After a successful fix the entry remains on the stack; after a failed
      fix the caller must discard the snapshot (simply don't call record_fix).
    - undo_last_fix(config) restores the live config object in-place from the
      most recent snapshot and pops it from the stack, mirroring
      AutoFixSafety.rollback_if_needed() semantics.
    - can_undo() returns True when at least one recorded snapshot exists.

    Stack depth is capped at MAX_HISTORY to prevent unbounded memory growth.
    """

    MAX_HISTORY: int = 20

    def __init__(self) -> None:
        # Each entry: {'snapshot': StrategyConfig, 'label': str, 'timestamp': str}
        self._history: List[Dict[str, Any]] = []

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def record_fix(self, pre_fix_snapshot: StrategyConfig, label: str = "") -> None:
        """
        Record a deep-copy snapshot taken *before* a fix was applied.

        Call this immediately before applying an auto-fix so the snapshot
        captures the strategy's unmodified state.

        Args:
            pre_fix_snapshot: Deep-copy of the strategy config before the fix.
                              Use deepcopy(config) or AutoFixSafety.backup_strategy()
                              output before passing here.
            label: Human-readable description of the fix (e.g. rule_name).
        """
        entry: Dict[str, Any] = {
            "snapshot": deepcopy(pre_fix_snapshot),
            "label": label,
            "timestamp": datetime.now().isoformat(),
        }
        self._history.append(entry)

        # Enforce cap
        if len(self._history) > self.MAX_HISTORY:
            self._history.pop(0)

        logger.info(
            "UndoManager: recorded fix '%s' — stack depth %d",
            label,
            len(self._history),
        )

    def can_undo(self) -> bool:
        """Return True when at least one fix can be undone."""
        return len(self._history) > 0

    def undo_last_fix(self, config: StrategyConfig) -> bool:
        """
        Restore the live config to the state before the most recent fix.

        Mirrors AutoFixSafety.rollback_if_needed(): updates config.__dict__
        in-place so all existing references to the object remain valid.

        Args:
            config: The live StrategyConfig to restore.  Modified in-place.

        Returns:
            True  — restoration successful; snapshot popped from stack.
            False — no snapshot available (stack empty).
        """
        if not self._history:
            logger.warning("UndoManager: undo_last_fix called with empty stack")
            return False

        entry = self._history.pop()
        snapshot: StrategyConfig = entry["snapshot"]

        # Restore in-place (same pattern as AutoFixSafety.rollback_if_needed)
        config.__dict__.update(deepcopy(snapshot.__dict__))

        logger.info(
            "UndoManager: undone fix '%s' (was applied at %s) — stack depth now %d",
            entry["label"],
            entry["timestamp"],
            len(self._history),
        )
        return True

    def peek_last_label(self) -> Optional[str]:
        """Return the label of the most recent fix without popping it."""
        if not self._history:
            return None
        return self._history[-1]["label"]

    def clear(self) -> None:
        """Clear the entire undo history (e.g. when loading a new strategy)."""
        self._history.clear()
        logger.info("UndoManager: history cleared")
