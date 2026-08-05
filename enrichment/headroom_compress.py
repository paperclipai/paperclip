"""
headroom_compress.py — reference

Thin Python wrapper around the headroom-ai library for token compression.
Mirrors the logic in the headroom-compress plugin worker (reference)
so enrichment/digester code can call it without going through the Paperclip
plugin IPC layer.

Constraints enforced (per board approval 2c381e30):
  1. HEADROOM_TELEMETRY=off set at import time (kills the Supabase beacon).
  2. Library-mode only — headroom.compress() only. headroom wrap is prohibited.
  3. Graceful ImportError: when headroom-ai is not installed the module
     degrades to pass-through mode (content returned unchanged, ratio 0%).
  4. Python 3.12/3.13 pre-built wheel required; on 3.14+ headroom-ai must be
     compiled from source with Rust, so the ImportError path is expected until
     the deployment runtime is updated.

Public surface:
  check_health() -> dict           mirrors the plugin's 'health' data endpoint
  compress(content: str) -> CompressResult   (compressed, original_len, compressed_len)
"""
from __future__ import annotations

import logging
import os
from typing import NamedTuple

# Constraint 1: kill the Supabase telemetry beacon at import time
os.environ["HEADROOM_TELEMETRY"] = "off"

logger = logging.getLogger(__name__)

_headroom_available: bool | None = None  # lazily resolved, then cached


class CompressResult(NamedTuple):
    compressed: str
    original_len: int
    compressed_len: int


def _try_import() -> object | None:
    """Return the headroom module or None if it cannot be imported."""
    global _headroom_available
    try:
        import headroom as _hr  # type: ignore[import]
        _headroom_available = True
        return _hr
    except ImportError:
        _headroom_available = False
        return None


def check_health() -> dict:
    """
    Check whether headroom-ai is importable.

    Returns a dict with the same shape as the plugin worker's 'health' data
    endpoint so callers can log a consistent startup message regardless of
    whether they call the plugin or this module directly.
    """
    hr = _try_import()
    if hr is not None:
        version = getattr(hr, "__version__", "unknown")
        return {
            "headroomAvailable": True,
            "version": version,
            "telemetryEnforced": os.environ.get("HEADROOM_TELEMETRY") == "off",
            "libraryModeOnly": True,
        }
    return {
        "headroomAvailable": False,
        "version": None,
        "telemetryEnforced": True,
        "libraryModeOnly": True,
    }


def compress(content: str) -> CompressResult:
    """
    Compress *content* using headroom.compress().

    When headroom-ai is not installed (ImportError) or compress() raises,
    the original content is returned unchanged so the caller's LLM call is
    never blocked by a compression failure.

    Token-reduction metrics (original_len, compressed_len) are always returned
    and should be logged by the caller; ratio = 0% indicates pass-through mode.
    """
    original_len = len(content)
    if not content:
        return CompressResult("", 0, 0)

    hr = _try_import()
    if hr is None:
        return CompressResult(content, original_len, original_len)

    try:
        compressed = hr.compress(content)
        compressed_len = len(compressed)
        return CompressResult(compressed, original_len, compressed_len)
    except Exception as exc:
        logger.warning("headroom.compress() error: %s — passing content through", exc)
        return CompressResult(content, original_len, original_len)
