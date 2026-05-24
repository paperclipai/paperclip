"""Claim-only lease client for ccrotate-auth-bot.

When figma-designer-bot starts using a ccrotate-managed identity (e.g.
ally@blockcast.net), it POSTs to ccrotate's /lease/claim to register
"figma is using this identity". ccrotate's stale-poller then skips
device-auth on the claimed identity — preserving the figma OAuth chain
that would otherwise be invalidated by a Google SSO rotation.

See Blockcast/onprem-k8s#356 (stale-poller gate) + #357 (claim endpoint)
for the server-side contract.

Graceful: if `CCROTATE_LEASE_URL` is unset or the endpoint is
unreachable, this module logs and continues. The bot still works; it
just loses the protection against concurrent device-auth.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request

from . import state
from .config import (
    CCROTATE_LEASE_AGENT,
    CCROTATE_LEASE_TTL_SEC,
    CCROTATE_LEASE_URL,
)

_TIMEOUT = 5.0  # seconds; ccrotate is in-cluster, should respond fast


def claim(identity: str, *, purpose: str = "designer") -> str | None:
    """POST a claim-only lease for `identity`. Returns the lease id on
    success, or None on any failure (graceful — never raises)."""
    if not CCROTATE_LEASE_URL:
        return None
    url = CCROTATE_LEASE_URL.rstrip("/") + "/lease/claim"
    body = json.dumps(
        {
            "identity": identity,
            "agent": CCROTATE_LEASE_AGENT,
            "purpose": purpose,
            "ttl_seconds": CCROTATE_LEASE_TTL_SEC,
        }
    ).encode()
    req = urllib.request.Request(
        url,
        data=body,
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as r:
            data = json.loads(r.read().decode())
            lease_id = data.get("id")
            state.log(
                f"ccrotate-lease: claimed {identity} → {str(lease_id)[:8]} "
                f"(expires {data.get('expiresAt','?')})"
            )
            return lease_id
    except urllib.error.HTTPError as e:
        try:
            detail = e.read().decode()[:200]
        except Exception:
            detail = ""
        # 409 = identity already leased (some other process holds it);
        # 422 = identity not in DESIGNER_ALLOWLIST on ccrotate. Both are
        # warnings, not errors — bot continues without the protection.
        state.log(f"ccrotate-lease: claim {identity} → HTTP {e.code} {detail}")
        return None
    except Exception as e:
        state.log(
            f"ccrotate-lease: claim {identity} failed: "
            f"{type(e).__name__}: {str(e)[:160]}"
        )
        return None


def release(lease_id: str | None, identity: str | None = None) -> None:
    """DELETE the claim. Graceful — logs on failure but never raises."""
    if not CCROTATE_LEASE_URL or not lease_id:
        return
    qs = urllib.parse.urlencode({"id": lease_id})
    url = CCROTATE_LEASE_URL.rstrip("/") + "/lease/claim?" + qs
    req = urllib.request.Request(url, method="DELETE")
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT):
            state.log(
                f"ccrotate-lease: released {identity or '?'} "
                f"{str(lease_id)[:8]}"
            )
    except Exception as e:
        state.log(
            f"ccrotate-lease: release {str(lease_id)[:8]} failed: "
            f"{type(e).__name__}: {str(e)[:160]}"
        )
