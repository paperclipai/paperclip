from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import FederationTrace
from ..schemas import FederationBriefingRequest, FederationExecuteRequest, FederationRouteRequest, FederationTraceQuery
from ..security import require_api_key
from ..services.federation import briefing, execute_task, recent_traces, route_task, system_statuses

router = APIRouter(prefix="/federation", tags=["federation"], dependencies=[Depends(require_api_key)])


@router.get("/systems")
def systems(db: Session = Depends(get_db)):
    return system_statuses(db)


@router.post("/briefing")
def cross_system_briefing(req: FederationBriefingRequest, db: Session = Depends(get_db)):
    return briefing(db, req.focus, req.include_sources)


@router.post("/route")
def route(req: FederationRouteRequest, db: Session = Depends(get_db)):
    return route_task(db, req.task, req.preferred_system, req.context, req.allow_execution)


@router.post("/execute")
def execute(req: FederationExecuteRequest, db: Session = Depends(get_db)):
    return execute_task(db, req.task, req.target_system, req.approved, req.context, req.model_dump(exclude_none=True, by_alias=True))


@router.get("/traces")
def traces(limit: int = 25, db: Session = Depends(get_db)):
    return recent_traces(db, limit)


@router.get("/traces/{trace_id}")
def trace(trace_id: str, db: Session = Depends(get_db)):
    row = db.query(FederationTrace).filter(FederationTrace.trace_id == trace_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Trace not found")
    return {
        "trace_id": row.trace_id,
        "kind": row.kind,
        "source_systems": row.source_systems,
        "target_system": row.target_system,
        "status": row.status,
        "request": row.request,
        "result": row.result,
        "blocked_reason": row.blocked_reason,
        "rollback_hint": row.rollback_hint,
        "created_at": row.created_at,
    }
