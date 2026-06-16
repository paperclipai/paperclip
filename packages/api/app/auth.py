import asyncio
import json
import logging
import time
import uuid
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt

from app.config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])

security = HTTPBearer()

# JWKS cache keyed by JWKS URL, with TTL
_jwks_cache: dict[str, dict[str, Any]] = {}
_jwks_fetched_at: dict[str, float] = {}
_JWKS_TTL_SECONDS = 3600  # re-fetch keys every hour

# Static JWKS override — no network call needed when set.
_STATIC_JWKS: dict[str, Any] | None = None
if settings.CLERK_JWKS_OVERRIDE:
    try:
        _STATIC_JWKS = json.loads(settings.CLERK_JWKS_OVERRIDE)
    except Exception as _e:
        logger.error("Failed to parse CLERK_JWKS_OVERRIDE: %s", _e)
# Explicit JWKS URL override (from CLERK_JWKS_URL env var).
_STATIC_JWKS_URL: str | None = settings.CLERK_JWKS_URL or None

if _STATIC_JWKS:
    logger.info("Using static JWKS override (%d key(s))", len(_STATIC_JWKS.get("keys", [])))
elif _STATIC_JWKS_URL:
    logger.info("Using explicit JWKS URL: %s", _STATIC_JWKS_URL)


async def _fetch_jwks(jwks_url: str) -> dict[str, Any]:
    """Fetch JWKS from a full URL with retry and TTL cache."""
    now = time.monotonic()
    cached = _jwks_cache.get(jwks_url)
    if cached is not None and (now - _jwks_fetched_at.get(jwks_url, 0)) < _JWKS_TTL_SECONDS:
        return cached

    last_error: Exception | None = None
    for attempt in range(3):
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.get(jwks_url, timeout=15)
                resp.raise_for_status()
                result = resp.json()
                _jwks_cache[jwks_url] = result
                _jwks_fetched_at[jwks_url] = time.monotonic()
                return result
        except httpx.HTTPError as exc:
            last_error = exc
            logger.warning("JWKS fetch from %s attempt %d failed: %s", jwks_url, attempt + 1, exc)
            if attempt < 2:
                await asyncio.sleep(1 * (attempt + 1))

    # All retries exhausted — use stale cache if available
    if cached is not None:
        logger.warning("Using stale JWKS cache for %s after fetch failure", jwks_url)
        return cached

    raise last_error  # type: ignore[misc]


_CLERK_NS = uuid.UUID("6ba7b810-9dad-11d1-80b4-00c04fd430c8")  # UUID namespace OID


class CurrentUser:
    def __init__(self, user_id: str, tenant_id: str | None, claims: dict[str, Any]) -> None:
        self.user_id = user_id
        self.tenant_id = tenant_id
        self.claims = claims

    @property
    def effective_tenant_id(self) -> str:
        """Return the org tenant_id, or a deterministic UUID derived from the
        Clerk user_id for solo users with no Clerk Organisation attached.
        The UUID5 derivation is stable and valid so DB UUID columns accept it."""
        if self.tenant_id:
            return self.tenant_id
        return str(uuid.uuid5(_CLERK_NS, self.user_id))


async def ensure_tenant_exists(db: "AsyncSession", user: "CurrentUser") -> str:
    """Auto-provision a tenant row for solo users so FK constraints are satisfied.

    For users with a real Clerk org the tenant_id comes from the JWT and the
    tenant row is expected to exist already (created during org provisioning).
    For solo users we derive a stable UUID5 from the Clerk user_id and create
    the row on-demand so any property/data write succeeds.
    """
    from sqlalchemy import select
    from sqlalchemy.exc import IntegrityError

    from app.models import Tenant

    tenant_id = user.effective_tenant_id
    result = await db.execute(select(Tenant).where(Tenant.id == tenant_id))
    if result.scalar_one_or_none() is None:
        try:
            async with db.begin_nested():  # savepoint — rolls back only on conflict
                db.add(
                    Tenant(
                        id=tenant_id,
                        name="Personal Workspace",
                        slug=f"solo-{tenant_id[:8]}",
                    )
                )
        except IntegrityError:
            pass  # concurrent request already created it
    return tenant_id


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> CurrentUser:
    token = credentials.credentials
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )

    try:
        # Decode header and claims without verification to get kid and issuer
        unverified_header = jwt.get_unverified_header(token)
        kid = unverified_header.get("kid")
        unverified_claims = jwt.get_unverified_claims(token)
        issuer = unverified_claims.get("iss")

        if not issuer:
            raise credentials_exception

        # Resolve JWKS: static override > explicit URL > derive from iss
        if _STATIC_JWKS is not None:
            jwks = _STATIC_JWKS
        else:
            jwks_url = _STATIC_JWKS_URL or f"{issuer.rstrip('/')}/.well-known/jwks.json"
            jwks = await _fetch_jwks(jwks_url)
        signing_key: dict[str, Any] | None = None
        for key in jwks.get("keys", []):
            if key.get("kid") == kid:
                signing_key = key
                break

        if signing_key is None:
            raise credentials_exception

        payload: dict[str, Any] = jwt.decode(
            token,
            signing_key,
            algorithms=["RS256"],
            options={"verify_aud": False},
            issuer=issuer,
        )

        # Clerk stores the subject as the user ID
        user_id: str | None = payload.get("sub")
        if user_id is None:
            raise credentials_exception

        # tenant_id may be stored in custom claims (org_id or tenant_id)
        tenant_id: str | None = payload.get("org_id") or payload.get("tenant_id")

        return CurrentUser(user_id=user_id, tenant_id=tenant_id, claims=payload)

    except JWTError:
        raise credentials_exception
    except httpx.HTTPError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unable to fetch authentication keys",
        )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/me")
async def get_me(current_user: CurrentUser = Depends(get_current_user)) -> dict[str, Any]:
    return {
        "user_id": current_user.user_id,
        "tenant_id": current_user.tenant_id,
        "claims": current_user.claims,
    }
