"""Unit tests for figma_bot.lease.

The single-tenant lease is the core multi-client coordination primitive.
Tests pin: lease_held_by_other rejection, expired-lease reclamation, the
heartbeat must-be-fresh contract, and the snapshot/active mechanics that
GET /lease/status returns.
"""

from __future__ import annotations

import time

from figma_bot import lease, state

# ─── lease_active ──────────────────────────────────────────────────────


def test_lease_active_false_when_no_lease():
    assert lease.lease_active({"lease_id": None}) is False


def test_lease_active_true_when_fresh():
    now = time.time()
    snap = {
        "lease_id": "x",
        "acquired_at": now,
        "last_heartbeat_at": now,
        "ttl_seconds": 300,
    }
    assert lease.lease_active(snap) is True


def test_lease_active_false_when_expired():
    now = time.time()
    snap = {
        "lease_id": "x",
        "acquired_at": now - 1000,
        "last_heartbeat_at": now - 1000,
        "ttl_seconds": 300,
    }
    assert lease.lease_active(snap) is False


# ─── acquire_lease ─────────────────────────────────────────────────────


def test_acquire_lease_returns_id_when_free():
    lid, err = lease.acquire_lease("client-A", ttl=120)
    assert err is None
    assert lid is not None
    assert len(lid) > 10  # secrets.token_urlsafe(16) → ~22 chars


def test_acquire_lease_rejects_when_held():
    """Second acquire must return ('lease_held_by_other') so the second
    client knows to back off, not silently take over the page."""
    lid1, _ = lease.acquire_lease("client-A", ttl=300)
    lid2, err = lease.acquire_lease("client-B", ttl=300)
    assert lid1 is not None
    assert lid2 is None
    assert err == "lease_held_by_other"


def test_acquire_lease_reclaims_expired():
    """When the prior lease has aged past its TTL, the new acquire
    reclaims — important so a crashed client can't permanently lock the
    page."""
    # Acquire then forcibly age the lease past its TTL.
    lid1, _ = lease.acquire_lease("crashed-client", ttl=10)
    with state.lease_lock:
        state.lease["acquired_at"] = time.time() - 60
        state.lease["last_heartbeat_at"] = time.time() - 60
    lid2, err = lease.acquire_lease("new-client", ttl=300)
    assert err is None
    assert lid2 is not None
    assert lid2 != lid1


def test_acquire_lease_stores_client_and_ttl():
    lid, _ = lease.acquire_lease("client-X", ttl=42)
    snap = lease.lease_snapshot()
    assert snap["lease_id"] == lid
    assert snap["client_id"] == "client-X"
    assert snap["ttl_seconds"] == 42
    assert snap["active"] is True


# ─── release_lease ─────────────────────────────────────────────────────


def test_release_lease_clears_when_id_matches():
    lid, _ = lease.acquire_lease("client", ttl=300)
    assert lease.release_lease(lid) is True
    snap = lease.lease_snapshot()
    assert snap["lease_id"] is None
    assert snap["client_id"] is None


def test_release_lease_rejects_wrong_id():
    """Trying to release someone else's lease must NOT succeed —
    otherwise a buggy client can DoS the bot by releasing leases it
    doesn't own."""
    lid, _ = lease.acquire_lease("real-client", ttl=300)
    assert lease.release_lease("wrong-id") is False
    assert lease.lease_snapshot()["lease_id"] == lid


# ─── heartbeat_lease ───────────────────────────────────────────────────


def test_heartbeat_refreshes_last_heartbeat_at():
    lid, _ = lease.acquire_lease("client", ttl=300)
    initial_hb = state.lease["last_heartbeat_at"]
    time.sleep(0.01)  # smallest possible wait
    assert lease.heartbeat_lease(lid) is True
    assert state.lease["last_heartbeat_at"] > initial_hb


def test_heartbeat_rejects_wrong_id():
    lease.acquire_lease("real", ttl=300)
    assert lease.heartbeat_lease("wrong") is False


def test_heartbeat_rejects_expired_lease():
    """If a lease has aged out, a stale heartbeat must NOT silently
    restore it — the client should re-acquire instead."""
    lid, _ = lease.acquire_lease("client", ttl=10)
    with state.lease_lock:
        state.lease["last_heartbeat_at"] = time.time() - 60
        state.lease["acquired_at"] = time.time() - 60
    assert lease.heartbeat_lease(lid) is False


# ─── check_lease ───────────────────────────────────────────────────────


def test_check_lease_true_when_owner_and_fresh():
    lid, _ = lease.acquire_lease("client", ttl=300)
    assert lease.check_lease(lid) is True


def test_check_lease_false_when_wrong_id():
    lease.acquire_lease("real", ttl=300)
    assert lease.check_lease("wrong") is False


def test_check_lease_false_when_expired():
    lid, _ = lease.acquire_lease("client", ttl=10)
    with state.lease_lock:
        state.lease["last_heartbeat_at"] = time.time() - 60
    assert lease.check_lease(lid) is False


# ─── snapshot ──────────────────────────────────────────────────────────


def test_snapshot_includes_active_flag():
    """GET /lease/status returns this snapshot — the `active` derived
    field is what callers actually use to decide whether to wait."""
    assert lease.lease_snapshot()["active"] is False
    lease.acquire_lease("client", ttl=300)
    assert lease.lease_snapshot()["active"] is True
