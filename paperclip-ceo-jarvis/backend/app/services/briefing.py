from datetime import datetime
from sqlalchemy.orm import Session
from ..models import BriefingItem, Task, Company, Decision
from .burnout import workload_snapshot


def morning_briefing(db: Session, primary_user: str) -> dict:
    items = db.query(BriefingItem).filter(BriefingItem.resolved == False).order_by(BriefingItem.urgency.desc(), BriefingItem.created_at.desc()).limit(8).all()  # noqa: E712
    open_tasks = db.query(Task).filter(Task.status == "open").order_by(Task.priority.desc()).limit(5).all()
    companies = db.query(Company).all()
    decisions = db.query(Decision).order_by(Decision.created_at.desc()).limit(3).all()
    workload = workload_snapshot(db)

    top_items = [
        {"category": i.category, "title": i.title, "summary": i.summary, "urgency": i.urgency, "source": i.source}
        for i in items
    ]
    for task in open_tasks:
        top_items.append({
            "category": "task",
            "title": task.title,
            "summary": task.description or "Open task needs execution.",
            "urgency": task.priority,
            "source": "task_registry",
        })

    recommendations = [
        "Clear the highest-risk open item before opening new work.",
        "Run decision simulation for any commitment over 30 days or with irreversible cost.",
    ]
    if workload["risk_count"]:
        recommendations.append("Rebalance overloaded employees today; burnout is just technical debt with a pulse.")
    if companies:
        weak = [c.name for c in companies if c.health_score < 65]
        if weak:
            recommendations.append(f"Review company health for: {', '.join(weak)}.")
    if decisions:
        recommendations.append("Review latest simulations and convert one into a committed next action.")

    return {
        "generated_at": datetime.utcnow(),
        "greeting": f"Good morning, {primary_user}. I have your executive briefing ready.",
        "top_items": top_items[:10],
        "workload": workload,
        "recommendations": recommendations,
    }
