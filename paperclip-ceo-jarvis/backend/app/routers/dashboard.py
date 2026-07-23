from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from ..db import get_db
from ..security import require_api_key
from ..services.dashboard import executive_snapshot

router = APIRouter(prefix="/dashboard", tags=["dashboard"], dependencies=[Depends(require_api_key)])


@router.get("/snapshot")
def snapshot(db: Session = Depends(get_db)):
    return executive_snapshot(db)


@router.get("/god-view")
def god_view(db: Session = Depends(get_db)):
    data = executive_snapshot(db)
    data["warning"] = "God View means authorized operational visibility, not unauthorized omniscience. Sensible systems stay out of prison."
    return data
