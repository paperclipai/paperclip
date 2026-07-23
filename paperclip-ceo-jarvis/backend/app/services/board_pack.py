from datetime import datetime
from sqlalchemy.orm import Session
from ..models import Company, Task, Decision, Employee
from .burnout import workload_snapshot


def generate_board_pack(db: Session) -> dict:
    companies = db.query(Company).all()
    high_risk_tasks = db.query(Task).filter(Task.risk_level == "high", Task.status == "open").all()
    recent_decisions = db.query(Decision).order_by(Decision.created_at.desc()).limit(5).all()
    employees = db.query(Employee).filter(Employee.active == True).all()  # noqa: E712
    workload = workload_snapshot(db)
    company_health = [{"name": c.name, "health_score": c.health_score, "mission": c.mission} for c in companies]
    risks = [f"High-risk task open: {t.title}" for t in high_risk_tasks]
    if workload["risk_count"]:
        risks.append(f"{workload['risk_count']} employee(s)/agent(s) are overloaded.")
    if not risks:
        risks.append("No critical operational risks detected from current local data.")
    return {
        "generated_at": datetime.utcnow(),
        "summary": f"Board pack generated from {len(companies)} companies, {len(employees)} employees/agents, and {len(recent_decisions)} recent decisions.",
        "company_health": company_health,
        "risks": risks,
        "decisions_needed": [d.title for d in recent_decisions[:3]] or ["No stored decisions awaiting board review."],
        "recommendations": [
            "Approve one measurable 30-day execution objective.",
            "Review overloaded teams before approving additional scope.",
            "Convert strategic ideas into explicit decision records with owners.",
        ],
    }
