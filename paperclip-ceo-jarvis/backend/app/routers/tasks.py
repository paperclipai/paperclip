from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from ..db import get_db
from ..models import Task, Alert, AuditLog
from ..schemas import TaskCreate, TaskOut
from ..security import require_api_key, guard_action

router = APIRouter(prefix="/ops", tags=["operations"], dependencies=[Depends(require_api_key)])


@router.post("/tasks", response_model=TaskOut)
def create_task(req: TaskCreate, db: Session = Depends(get_db)):
    guard_action(db, f"create task: {req.title}", req.model_dump())
    task = Task(**req.model_dump())
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


@router.get("/tasks", response_model=list[TaskOut])
def list_tasks(db: Session = Depends(get_db)):
    return db.query(Task).order_by(Task.priority.desc(), Task.created_at.desc()).all()


@router.get("/alerts")
def alerts(db: Session = Depends(get_db)):
    return db.query(Alert).filter(Alert.resolved == False).order_by(Alert.created_at.desc()).all()  # noqa: E712


@router.get("/audit")
def audit(db: Session = Depends(get_db)):
    return db.query(AuditLog).order_by(AuditLog.created_at.desc()).limit(100).all()
