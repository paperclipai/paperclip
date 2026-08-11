"""Rolling 7-day Opus reviewer cost tracker with file-based persistence.

Each record is a (timestamp, cost_usd) pair. Entries older than 7 days are
pruned on every read and write so the window is always rolling.

Thread-safety: record() uses file locking (fcntl.LOCK_EX) for atomic
read-modify-write. Suitable for single-machine concurrent use.
"""
import json
import time
import fcntl
from pathlib import Path

WEEKLY_CAP_USD: float = 50.00
WINDOW_SECONDS: float = 7 * 24 * 3600  # 604800 s


class CostCapTracker:
    def __init__(self, ledger_path: str) -> None:
        self._path = Path(ledger_path)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _prune(self, entries: list, now: float) -> list:
        cutoff = now - WINDOW_SECONDS
        return [e for e in entries if e["ts"] >= cutoff]

    def _read_entries(self) -> list:
        if not self._path.exists():
            return []
        try:
            data = json.loads(self._path.read_text())
            return data.get("entries", [])
        except (json.JSONDecodeError, OSError):
            return []

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def weekly_spend(self) -> float:
        """Return rolling 7-day Opus reviewer spend in USD."""
        now = time.time()
        entries = self._prune(self._read_entries(), now)
        return sum(e["cost_usd"] for e in entries)

    def would_breach(self, additional_usd: float = 0.0) -> bool:
        """Return True if current weekly spend + additional_usd exceeds the cap."""
        return self.weekly_spend() + additional_usd > WEEKLY_CAP_USD

    def record(self, cost_usd: float) -> None:
        """Append a new spend entry. Atomic via exclusive file lock."""
        now = time.time()
        self._path.parent.mkdir(parents=True, exist_ok=True)
        # Open in append+binary so the file is created if absent.
        with open(self._path, "a+b") as fh:
            fcntl.flock(fh, fcntl.LOCK_EX)
            try:
                fh.seek(0)
                raw = fh.read()
                try:
                    data = json.loads(raw.decode()) if raw else {}
                    entries = data.get("entries", [])
                except (json.JSONDecodeError, ValueError):
                    entries = []
                entries = self._prune(entries, now)
                entries.append({"ts": now, "cost_usd": cost_usd})
                fh.seek(0)
                fh.truncate()
                fh.write(json.dumps({"entries": entries}).encode())
            finally:
                fcntl.flock(fh, fcntl.LOCK_UN)
