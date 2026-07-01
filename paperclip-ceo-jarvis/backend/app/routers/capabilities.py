from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from ..db import get_db
from ..security import require_api_key, guard_action
from ..schemas import ToolCapabilityUpdate
from ..services.capabilities import list_capabilities, update_capability, readiness_report

router = APIRouter(prefix="/capabilities", tags=["capabilities"], dependencies=[Depends(require_api_key)])


@router.get("")
def capabilities(db: Session = Depends(get_db)):
    return list_capabilities(db)


@router.get("/readiness")
def readiness(db: Session = Depends(get_db)):
    return readiness_report(db)


@router.patch("/{capability_id}")
def update(capability_id: int, req: ToolCapabilityUpdate, db: Session = Depends(get_db)):
    guard_action(db, "update tool capability", {"capability_id": capability_id})
    try:
        return update_capability(db, capability_id, req.enabled, req.health_status)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
