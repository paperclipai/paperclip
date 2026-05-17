"""Shared calibration fingerprint cache — read/write helpers.

Both BacktestConfigPanel (auto-calibration) and TrainingPanelUI (manual
calibration) must call compute_fingerprint() from this module so that
identical settings always produce identical fingerprints.  Cross-pollination
(AC #4 of BTCAAAAA-1096) depends on this guarantee.
"""
import hashlib
import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Tuple

logger = logging.getLogger(__name__)

_CACHE_SCHEMA_VERSION = 1
_CACHE_TTL_DAYS = 7  # Disk cache expires after 7 days; forces fresh calibration


def get_cache_path() -> Path:
    cache_dir = Path.home() / '.paperclip'
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir / 'calibration_cache.json'


def compute_fingerprint(block_names: list, timeframe: str, period_days: int, mode: str) -> str:
    """Return SHA-256 hex digest of the calibration inputs.

    block_names is sorted internally so caller order does not matter.
    """
    payload = {
        "block_names": sorted(block_names),
        "timeframe": timeframe,
        "period_days": period_days,
        "mode": mode,
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def load_cache() -> Tuple[Optional[str], Optional[dict]]:
    """Load fingerprint + delay_map from disk.

    Returns (fingerprint, delay_map) on success, (None, None) on any
    error, schema mismatch, or TTL expiry.  Always safe to call.
    """
    cache_path = get_cache_path()
    if not cache_path.exists():
        return None, None
    try:
        with cache_path.open('r', encoding='utf-8') as fh:
            data = json.load(fh)
        if data.get('schema_version') != _CACHE_SCHEMA_VERSION:
            logger.info("Calibration cache: schema mismatch, ignoring.")
            return None, None
        stored_at_str = data.get('stored_at')
        if stored_at_str:
            stored_at = datetime.fromisoformat(stored_at_str)
            age_days = (datetime.now(timezone.utc) - stored_at).days
            if age_days > _CACHE_TTL_DAYS:
                logger.info(f"Calibration cache: expired ({age_days}d old), ignoring.")
                return None, None
        fingerprint = data.get('fingerprint')
        delay_map = data.get('delay_map')
        if not isinstance(fingerprint, str) or not isinstance(delay_map, dict):
            logger.info("Calibration cache: invalid structure, ignoring.")
            return None, None
        return fingerprint, delay_map
    except Exception as exc:
        logger.info(f"Calibration cache: read error, ignoring. ({exc})")
        return None, None


def save_cache(fingerprint: str, delay_map: dict) -> None:
    """Atomically write fingerprint + delay_map to disk via tmp+rename."""
    if not fingerprint or delay_map is None:
        return
    cache_path = get_cache_path()
    payload = {
        'schema_version': _CACHE_SCHEMA_VERSION,
        'fingerprint': fingerprint,
        'delay_map': delay_map,
        'stored_at': datetime.now(timezone.utc).isoformat(),
    }
    tmp_path = cache_path.with_suffix('.json.tmp')
    try:
        with tmp_path.open('w', encoding='utf-8') as fh:
            json.dump(payload, fh, indent=2)
        tmp_path.replace(cache_path)
        logger.info(f"Calibration cache: persisted to {cache_path}.")
    except Exception as exc:
        logger.warning(f"Calibration cache: failed to persist: {exc}")
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception:
            pass
