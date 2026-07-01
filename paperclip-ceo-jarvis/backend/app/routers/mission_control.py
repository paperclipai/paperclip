from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from ..config import get_settings
from ..db import get_db
from ..security import require_api_key, guard_action
from ..schemas import CommandRequest, WorkflowStartRequest, WorkflowAdvanceRequest, SOPCreate, NotificationCreate
from ..models import NotificationEvent
from ..services.workflows import (
    list_playbooks,
    start_workflow,
    workflow_detail,
    list_workflow_runs,
    advance_workflow,
    command_triage,
    next_best_actions,
    daily_operating_ritual,
    list_sops,
    create_sop,
)

router = APIRouter(prefix="/mission-control", tags=["mission-control"], dependencies=[Depends(require_api_key)])


@router.post("/command")
def command(req: CommandRequest, db: Session = Depends(get_db)):
    guard_action(db, "triage mission-control command", {"command": req.command, "autonomous": req.autonomous})
    return command_triage(db, req.command, req.context, req.autonomous)


@router.get("/playbooks")
def playbooks(db: Session = Depends(get_db)):
    return {"playbooks": list_playbooks(db)}


@router.post("/workflows")
def start(req: WorkflowStartRequest, db: Session = Depends(get_db)):
    try:
        return start_workflow(db, req.template_key, req.title, req.owner, req.input_payload)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/workflows")
def runs(status: str = "running", db: Session = Depends(get_db)):
    return list_workflow_runs(db, status)


@router.get("/workflows/{run_id}")
def get_run(run_id: int, db: Session = Depends(get_db)):
    try:
        return workflow_detail(db, run_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.post("/workflows/{run_id}/advance")
def advance(run_id: int, req: WorkflowAdvanceRequest, db: Session = Depends(get_db)):
    try:
        return advance_workflow(db, run_id, req.output, req.status)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/next-best-actions")
def nba(db: Session = Depends(get_db)):
    return next_best_actions(db)


@router.get("/daily-ritual")
def daily(db: Session = Depends(get_db)):
    return daily_operating_ritual(db, get_settings().jarvis_primary_user)


@router.get("/sops")
def sops(db: Session = Depends(get_db)):
    return list_sops(db)


@router.post("/sops")
def add_sop(req: SOPCreate, db: Session = Depends(get_db)):
    guard_action(db, "create SOP document", {"title": req.title, "category": req.category})
    return create_sop(db, req.title, req.category, req.body, req.owner, req.review_days)


@router.get("/notifications")
def notifications(status: str = "queued", db: Session = Depends(get_db)):
    q = db.query(NotificationEvent)
    if status != "all":
        q = q.filter(NotificationEvent.status == status)
    rows = q.order_by(NotificationEvent.priority.desc(), NotificationEvent.created_at.desc()).limit(100).all()
    return {"notifications": rows}


@router.post("/notifications")
def create_notification(req: NotificationCreate, db: Session = Depends(get_db)):
    row = NotificationEvent(channel=req.channel, title=req.title, body=req.body, priority=req.priority, payload=req.payload)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row
