from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from ..db import get_db
from ..models import PredictionRecord, DebtItem
from ..security import require_api_key
from ..schemas import DebtCreate, PredictionCreate, PredictionResolve
from ..services.temporal import execution_timeline, opportunity_windows, debt_snapshot, add_prediction, resolve_prediction
from ..services.risk import add_debt

router = APIRouter(prefix="/temporal", tags=["temporal"], dependencies=[Depends(require_api_key)])


@router.get("/timeline")
def timeline(horizon_days: int = 90, db: Session = Depends(get_db)):
    return execution_timeline(db, horizon_days)


@router.get("/opportunity-windows")
def windows(db: Session = Depends(get_db)):
    return opportunity_windows(db)


@router.get("/debt")
def debts(db: Session = Depends(get_db)):
    return debt_snapshot(db)


@router.post("/debt")
def create_debt(req: DebtCreate, db: Session = Depends(get_db)):
    return add_debt(db, req.title, req.category, req.owner, req.due_at, req.impact)


@router.post("/predictions")
def create_prediction(req: PredictionCreate, db: Session = Depends(get_db)):
    return add_prediction(db, req.subject, req.prediction, req.confidence, req.horizon_days, req.expected_signal)


@router.get("/predictions")
def list_predictions(status: str = "open", db: Session = Depends(get_db)):
    q = db.query(PredictionRecord)
    if status != "all":
        q = q.filter(PredictionRecord.status == status)
    return {"predictions": q.order_by(PredictionRecord.created_at.desc()).limit(100).all()}


@router.post("/predictions/{prediction_id}/resolve")
def resolve(prediction_id: int, req: PredictionResolve, db: Session = Depends(get_db)):
    try:
        return resolve_prediction(db, prediction_id, req.actual_outcome, req.accuracy_score)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
