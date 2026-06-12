from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..db import get_db
from ..security import require_api_key
from ..services.providers import provider_catalog

router = APIRouter(prefix="/providers", tags=["providers"], dependencies=[Depends(require_api_key)])


@router.get("/catalog")
def catalog(db: Session = Depends(get_db)):
    # DB dependency kept for consistency with other authenticated routes and future refresh support.
    _ = db
    return provider_catalog()
