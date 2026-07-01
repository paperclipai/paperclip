from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from ..db import get_db
from ..security import require_api_key
from ..schemas import FeaturePlanRequest, FeatureStatusUpdate
from ..services import enchantments as svc

router = APIRouter(prefix="/enchantments", tags=["enchantments"], dependencies=[Depends(require_api_key)])


@router.get("/backlog")
def backlog(category: str | None = Query(default=None), status: str | None = Query(default=None), db: Session = Depends(get_db)):
    return svc.list_enchantments(db, category=category, status=status)


@router.get("/brainstorm")
def brainstorm(db: Session = Depends(get_db)):
    return svc.brainstorm_matrix(db)


@router.post("/plan")
def plan(payload: FeaturePlanRequest, db: Session = Depends(get_db)):
    return svc.build_implementation_plan(db, payload.focus_categories, payload.horizon_days, payload.capacity_level, payload.include_high_risk)


@router.put("/features/{feature_id}/status")
def update_status(feature_id: int, payload: FeatureStatusUpdate, db: Session = Depends(get_db)):
    try:
        return svc.update_feature_status(db, feature_id, payload.status, payload.note)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/audit")
def audit(db: Session = Depends(get_db)):
    return svc.maturity_audit(db)
