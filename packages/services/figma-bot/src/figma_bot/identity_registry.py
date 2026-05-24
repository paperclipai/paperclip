"""Identity registry + backoff state machine.

Loads `identities.json` from `/etc/figma-identities/` (mounted from the
`paperclip-figma-bot-identities` Secret). Strict on required fields,
lenient on additions — one bad entry never poisons the whole map.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from dataclasses import dataclass

from . import state
from .config import IDENTITIES_PATH


def slug_for(email: str) -> str:
    """Per-identity directory slug. Matches ccrotate-auth-bot convention."""
    return hashlib.sha256(email.encode("utf-8")).hexdigest()[:16]


class IdentityRegistry:
    """Loads identities.json from /etc/figma-identities/. Strict on required
    fields, lenient on additions. One bad entry never poisons the whole map."""

    def __init__(self, path: str = IDENTITIES_PATH):
        self.path = path
        self._lock = threading.RLock()
        self._mtime: float | None = None
        self._map: dict[str, dict] = {}
        self._default_identity_env = (
            os.environ.get("FIGMA_DEFAULT_IDENTITY")
            or os.environ.get("FIGMA_EMAIL")
            or ""
        )
        self._load(force=True)

    @staticmethod
    def _validate_entry(email, entry) -> dict | None:
        """Return entry if valid, None if it should be skipped. Logs the reason."""
        if not isinstance(email, str) or "@" not in email:
            state.log(f"IdentityRegistry: WARNING skipping non-email key {email!r}")
            return None
        if not isinstance(entry, dict):
            state.log(f"IdentityRegistry: WARNING skipping non-object value for {email}")
            return None
        password = entry.get("password")
        if not isinstance(password, str) or not password:
            state.log(f"IdentityRegistry: WARNING skipping {email}: missing or empty password")
            return None
        return entry

    def _load(self, force: bool = False) -> None:
        try:
            st = os.stat(self.path)
        except FileNotFoundError:
            with self._lock:
                if force or self._map:
                    state.log(f"IdentityRegistry: file missing at {self.path}; registry empty")
                self._mtime = None
                self._map = {}
            return
        if not force and self._mtime == st.st_mtime:
            return
        try:
            with open(self.path) as f:
                raw = f.read()
            parsed = json.loads(raw)
            if not isinstance(parsed, dict):
                raise ValueError("identities.json top-level must be a JSON object")
        except (ValueError, OSError) as e:
            state.log(
                f"IdentityRegistry: ERROR parsing {self.path}: "
                f"{type(e).__name__}: {str(e)[:160]}"
            )
            with self._lock:
                self._mtime = st.st_mtime
                self._map = {}
            return
        new_map: dict[str, dict] = {}
        for email, entry in parsed.items():
            valid = self._validate_entry(email, entry)
            if valid is not None:
                new_map[email] = valid
        with self._lock:
            self._mtime = st.st_mtime
            self._map = new_map
        state.log(f"IdentityRegistry: loaded {len(new_map)} identities from {self.path}")

    def maybe_reload(self) -> None:
        self._load(force=False)

    def known(self) -> list[str]:
        with self._lock:
            return sorted(self._map.keys())

    def get(self, email: str) -> dict | None:
        with self._lock:
            return self._map.get(email)

    def default_identity(self) -> str | None:
        env = self._default_identity_env
        if env and self.get(env) is not None:
            return env
        return None


# ─── Per-identity backoff state machine ────────────────────────────────


@dataclass
class IdentityState:
    consecutive_failures: int = 0
    backoff_until: float | None = None  # epoch seconds
    last_login_at: float | None = None
    last_failure: dict | None = None  # {"at": float, "reason": str}


_identity_states: dict[str, IdentityState] = {}
_identity_states_lock = threading.RLock()

# Backoff curve after the n-th consecutive failure.
# 60s, 5m, 30m, 2h, 6h cap. Matches the cluster operator runbook's
# expected escalation; changes here require updating the runbook.
_BACKOFF_SCHEDULE = [60, 300, 1800, 7200, 21600]


def get_identity_state(identity: str) -> IdentityState:
    with _identity_states_lock:
        s = _identity_states.get(identity)
        if s is None:
            s = IdentityState()
            _identity_states[identity] = s
        return s


def record_login_success(identity: str) -> None:
    with _identity_states_lock:
        s = get_identity_state(identity)
        s.consecutive_failures = 0
        s.backoff_until = None
        s.last_login_at = time.time()
        s.last_failure = None


def record_login_failure(identity: str, reason: str) -> float:
    """Record a failure, set backoff_until, return the picked backoff
    duration in seconds. Callers that need a fresh retry_after_seconds
    should re-read s.backoff_until - time.time() via identity_in_backoff."""
    now = time.time()
    with _identity_states_lock:
        s = get_identity_state(identity)
        s.consecutive_failures += 1
        idx = min(s.consecutive_failures - 1, len(_BACKOFF_SCHEDULE) - 1)
        backoff = _BACKOFF_SCHEDULE[idx]
        s.backoff_until = now + backoff
        s.last_failure = {"at": now, "reason": reason}
        return backoff


def identity_in_backoff(identity: str) -> float | None:
    """Return retry_after_seconds if in backoff, else None."""
    with _identity_states_lock:
        s = get_identity_state(identity)
        if s.backoff_until is None:
            return None
        remain = s.backoff_until - time.time()
        return remain if remain > 0 else None
