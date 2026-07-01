from sqlalchemy.orm import Session
from ..models import Employee, ReputationEvent

WEIGHTS = {
    "quality": ("impact_score", 0.35),
    "delivery": ("reliability_score", 0.30),
    "reliability": ("reliability_score", 0.30),
    "innovation": ("innovation_score", 0.20),
    "collaboration": ("collaboration_score", 0.15),
}


def clamp(value: float, low: float = 0.0, high: float = 100.0) -> float:
    return max(low, min(high, value))


def add_reputation_event(db: Session, employee_id: int, category: str, score_delta: float, note: str = "") -> Employee:
    employee = db.get(Employee, employee_id)
    if employee is None:
        raise ValueError("Employee not found")

    attr, multiplier = WEIGHTS.get(category, ("impact_score", 0.2))
    setattr(employee, attr, clamp(getattr(employee, attr) + score_delta * multiplier))

    employee.impact_score = clamp(
        employee.impact_score * 0.40
        + employee.reliability_score * 0.25
        + employee.innovation_score * 0.20
        + employee.collaboration_score * 0.15
    )
    db.add(ReputationEvent(employee_id=employee_id, category=category, score_delta=score_delta, note=note))
    db.commit()
    db.refresh(employee)
    return employee


def career_plan(employee: Employee) -> dict:
    gaps = []
    if employee.reliability_score < 65: gaps.append("delivery reliability")
    if employee.collaboration_score < 65: gaps.append("cross-functional communication")
    if employee.innovation_score < 65: gaps.append("experimentation and product thinking")
    if employee.workload_score > 80: gaps.append("delegation and focus protection")
    if not gaps: gaps.append("advanced leadership and mentoring")
    return {
        "employee": employee.name,
        "role": employee.role,
        "next_level_focus": gaps,
        "recommended_projects": [
            "Own one measurable company objective for 30 days",
            "Document one knowledge silo and teach it to another teammate/agent",
            "Pair with an AI agent on a deliverable and compare quality before/after",
        ],
        "skills_to_build": list(employee.skills.keys())[:5] or ["execution", "communication", "systems thinking"],
    }
