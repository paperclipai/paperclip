from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from ..db import get_db
from ..models import ApprovalRequest, AuditLog
from ..security import require_api_key, guard_action
from ..schemas import ApprovalCreate, ApprovalDecision
from ..services.governance import create_approval, decide_approval, set_flag, system_status

router = APIRouter(prefix="/governance", tags=["governance"], dependencies=[Depends(require_api_key)])


@router.get("/status")
def status(db: Session = Depends(get_db)):
    return system_status(db)


@router.post("/approvals")
def request_approval(req: ApprovalCreate, db: Session = Depends(get_db)):
    return create_approval(db, req.title, req.action, req.risk_level, req.rationale)


@router.get("/approvals")
def list_approvals(status: str = "pending", db: Session = Depends(get_db)):
    q = db.query(ApprovalRequest)
    if status != "all":
        q = q.filter(ApprovalRequest.status == status)
    rows = q.order_by(ApprovalRequest.created_at.desc()).limit(100).all()
    return {"approvals": rows}


@router.post("/approvals/{approval_id}/approve")
def approve(approval_id: int, req: ApprovalDecision, db: Session = Depends(get_db)):
    try:
        return decide_approval(db, approval_id, "approved", req.note)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.post("/approvals/{approval_id}/reject")
def reject(approval_id: int, req: ApprovalDecision, db: Session = Depends(get_db)):
    try:
        return decide_approval(db, approval_id, "rejected", req.note)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.post("/pause")
def pause(reason: str = "CEO pause requested", db: Session = Depends(get_db)):
    guard_action(db, "pause Jarvis automation", {"reason": reason})
    return set_flag(db, "paused", "true", reason)


@router.post("/resume")
def resume(reason: str = "CEO resume requested", db: Session = Depends(get_db)):
    return set_flag(db, "paused", "false", reason)


@router.get("/audit")
def audit(limit: int = 50, db: Session = Depends(get_db)):
    rows = db.query(AuditLog).order_by(AuditLog.created_at.desc()).limit(min(max(limit, 1), 200)).all()
    return {"audit": rows}
