import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.auth import CurrentUser, ensure_tenant_exists, get_current_user, router as auth_router
from app.database import get_db

logger = logging.getLogger(__name__)
from app.routers.comps import router as comps_router
from app.routers.properties import router as properties_router
from app.routers.financing import router as financing_router
from app.routers.catalog import router as catalog_router
from app.routers.photo_analysis import router as photo_analysis_router
from app.routers.orders import router as orders_router
from app.routers.quotes import router as quotes_router
from app.routers.risk import router as risk_router
from app.routers.credit_memos import router as credit_memos_router

app = FastAPI(
    title="GCP Renovation API",
    description="Backend API for the GCP Renovation platform",
    version="0.1.0",
)

# ---------------------------------------------------------------------------
# Middleware
# ---------------------------------------------------------------------------

_origins = (
    [o.strip() for o in settings.CORS_ORIGINS.split(",")]
    if settings.CORS_ORIGINS != "*"
    else ["*"]
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Routers
# ---------------------------------------------------------------------------

app.include_router(auth_router)
app.include_router(properties_router)
app.include_router(comps_router)
app.include_router(risk_router)
app.include_router(financing_router)
app.include_router(catalog_router)
app.include_router(photo_analysis_router)
app.include_router(quotes_router)
app.include_router(orders_router)
app.include_router(credit_memos_router)

# ---------------------------------------------------------------------------
# Core routes
# ---------------------------------------------------------------------------


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error", "type": type(exc).__name__},
    )


@app.get("/health", tags=["health"])
async def health_check() -> dict[str, str]:
    return {"status": "ok", "service": "gcp-renovation-api"}


@app.get("/auth-config", tags=["health"])
async def auth_config() -> dict:
    """Non-sensitive debug: shows which auth mode is active."""
    from app.auth import _STATIC_JWKS, _STATIC_JWKS_URL
    return {
        "static_jwks_loaded": _STATIC_JWKS is not None,
        "static_jwks_key_count": len(_STATIC_JWKS.get("keys", [])) if _STATIC_JWKS else 0,
        "static_jwks_url_set": bool(_STATIC_JWKS_URL),
        "clerk_jwks_override_env_len": len(settings.CLERK_JWKS_OVERRIDE),
    }


@app.post("/seed-demo", tags=["health"])
async def seed_demo(
    current_user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Insert sample properties for the authenticated user's tenant so the
    dashboard has demo data to display. Safe to call multiple times — skips
    rows that already exist (checked by address + tenant_id)."""
    import uuid as _uuid
    from sqlalchemy import select
    from app.models import Property

    tenant_id = await ensure_tenant_exists(db, current_user)
    samples = [
        dict(address="1234 Oak Creek Dr", city="The Woodlands", state="TX", zip="77381",
             beds=4, baths=3.0, sqft=2800, listing_price=450000, arv_estimate=520000,
             property_type="Single Family", data_source="demo"),
        dict(address="5678 Pine Ridge Ln", city="The Woodlands", state="TX", zip="77381",
             beds=3, baths=2.0, sqft=1950, listing_price=310000, arv_estimate=370000,
             property_type="Single Family", data_source="demo"),
        dict(address="9012 Elm Street", city="Spring", state="TX", zip="77373",
             beds=2, baths=1.5, sqft=1200, listing_price=185000, arv_estimate=220000,
             property_type="Townhouse", data_source="demo"),
    ]
    added = 0
    for s in samples:
        existing = await db.execute(
            select(Property).where(
                Property.address == s["address"],
                Property.tenant_id == tenant_id,
            )
        )
        if existing.scalar_one_or_none() is None:
            db.add(Property(id=str(_uuid.uuid4()), tenant_id=tenant_id, status="active", **s))
            added += 1
    await db.commit()
    return {"seeded": added, "tenant_id": tenant_id}
