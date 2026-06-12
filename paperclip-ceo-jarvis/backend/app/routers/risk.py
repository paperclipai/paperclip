from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from ..db import get_db
from ..security import require_api_key, guard_action
from ..schemas import RiskCreate
from ..services.risk import add_risk, risk_register, scan_repo_for_secret_patterns

router = APIRouter(prefix="/risk", tags=["risk"], dependencies=[Depends(require_api_key)])


@router.get("")
def risks(db: Session = Depends(get_db)):
    return risk_register(db)


@router.post("")
def create_risk(req: RiskCreate, db: Session = Depends(get_db)):
    return add_risk(db, req.title, req.category, req.severity, req.likelihood, req.owner, req.mitigation)


@router.post("/scan-secrets")
def scan_secrets(path: str = ".", db: Session = Depends(get_db)):
    guard_action(db, "scan repository for credential leaks", {"path": path})
    return scan_repo_for_secret_patterns(path)
