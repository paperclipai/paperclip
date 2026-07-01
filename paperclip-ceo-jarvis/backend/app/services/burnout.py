from sqlalchemy.orm import Session
from ..models import Employee


def workload_snapshot(db: Session) -> dict:
    employees = db.query(Employee).filter(Employee.active == True).all()  # noqa: E712
    if not employees:
        return {"average_workload": 0, "risk_count": 0, "people_at_risk": [], "recommendations": []}
    avg = sum(e.workload_score for e in employees) / len(employees)
    at_risk = [e for e in employees if e.workload_score >= 80]
    recommendations = []
    if at_risk:
        recommendations.append("Rebalance work from overloaded employees to lower-load agents or team members.")
        recommendations.append("Cancel or compress low-value meetings for the next 72 hours.")
    if avg > 70:
        recommendations.append("Introduce WIP limits: no more than three active priorities per owner.")
    if not recommendations:
        recommendations.append("Workload appears sustainable. Do not ruin it with heroic nonsense.")
    return {
        "average_workload": round(avg, 2),
        "risk_count": len(at_risk),
        "people_at_risk": [{"id": e.id, "name": e.name, "workload_score": e.workload_score} for e in at_risk],
        "recommendations": recommendations,
    }
