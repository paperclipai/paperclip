from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from ..db import get_db
from ..models import Employee
from ..schemas import EmployeeCreate, EmployeeOut, ReputationEventIn
from ..security import require_api_key, guard_action
from ..services.reputation import add_reputation_event, career_plan
from ..services.burnout import workload_snapshot

router = APIRouter(prefix="/employees", tags=["employees"], dependencies=[Depends(require_api_key)])


@router.get("", response_model=list[EmployeeOut])
def list_employees(db: Session = Depends(get_db)):
    return db.query(Employee).order_by(Employee.kind, Employee.name).all()


@router.post("", response_model=EmployeeOut)
def create_employee(req: EmployeeCreate, db: Session = Depends(get_db)):
    employee = Employee(**req.model_dump())
    db.add(employee)
    db.commit()
    db.refresh(employee)
    return employee


@router.post("/{employee_id}/impact", response_model=EmployeeOut)
def add_impact(employee_id: int, req: ReputationEventIn, db: Session = Depends(get_db)):
    guard_action(db, f"update employee impact score for {employee_id}", req.model_dump())
    try:
        return add_reputation_event(db, employee_id, req.category, req.score_delta, req.note)
    except ValueError:
        raise HTTPException(status_code=404, detail="Employee not found")


@router.get("/{employee_id}/career-plan")
def get_career_plan(employee_id: int, db: Session = Depends(get_db)):
    employee = db.get(Employee, employee_id)
    if not employee:
        raise HTTPException(status_code=404, detail="Employee not found")
    return career_plan(employee)


@router.get("/system/workload")
def get_workload(db: Session = Depends(get_db)):
    return workload_snapshot(db)
