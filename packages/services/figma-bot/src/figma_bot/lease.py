"""Single-tenant lease primitives.

Only one lease_id is active at a time. A lease expires when
(now - last_heartbeat) > ttl. Acquiring while a live lease exists
returns ('lease_held_by_other').
"""

from __future__ import annotations

import secrets
import time

from . import state
from .config import DEFAULT_LEASE_TTL


def lease_active(snap: dict) -> bool:
    if snap.get("lease_id") is None:
        return False
    last = snap.get("last_heartbeat_at") or snap.get("acquired_at") or 0
    return (time.time() - last) <= snap.get("ttl_seconds", DEFAULT_LEASE_TTL)


def lease_snapshot() -> dict:
    with state.lease_lock:
        snap = dict(state.lease)
    snap["active"] = lease_active(snap)
    return snap


def acquire_lease(client_id: str, ttl: int) -> tuple[str | None, str | None]:
    with state.lease_lock:
        if state.lease["lease_id"] is not None:
            last = state.lease.get("last_heartbeat_at") or state.lease.get("acquired_at") or 0
            if (time.time() - last) <= state.lease["ttl_seconds"]:
                return None, "lease_held_by_other"
            state.log(
                f"reclaiming expired lease {state.lease['lease_id']} "
                f"(client={state.lease['client_id']})"
            )
        lid = secrets.token_urlsafe(16)
        now = time.time()
        state.lease["lease_id"] = lid
        state.lease["client_id"] = client_id
        state.lease["acquired_at"] = now
        state.lease["last_heartbeat_at"] = now
        state.lease["ttl_seconds"] = ttl
        state.log(f"lease acquired: {lid} client={client_id} ttl={ttl}s")
        return lid, None


def release_lease(lease_id: str) -> bool:
    with state.lease_lock:
        if state.lease["lease_id"] != lease_id:
            return False
        state.log(f"lease released: {lease_id} client={state.lease['client_id']}")
        state.lease["lease_id"] = None
        state.lease["client_id"] = None
        state.lease["acquired_at"] = None
        state.lease["last_heartbeat_at"] = None
        return True


def heartbeat_lease(lease_id: str) -> bool:
    with state.lease_lock:
        if state.lease["lease_id"] != lease_id:
            return False
        last = state.lease.get("last_heartbeat_at") or state.lease.get("acquired_at") or 0
        if (time.time() - last) > state.lease["ttl_seconds"]:
            state.log(f"heartbeat on expired lease {lease_id}; refusing")
            return False
        state.lease["last_heartbeat_at"] = time.time()
        return True


def check_lease(lease_id: str) -> bool:
    with state.lease_lock:
        if state.lease["lease_id"] != lease_id:
            return False
        last = state.lease.get("last_heartbeat_at") or state.lease.get("acquired_at") or 0
        return (time.time() - last) <= state.lease["ttl_seconds"]
