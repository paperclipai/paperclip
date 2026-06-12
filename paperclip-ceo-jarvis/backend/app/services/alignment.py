from sqlalchemy.orm import Session
from ..models import Company, Objective, Task


def alignment_report(db: Session) -> dict:
    companies = db.query(Company).all()
    open_tasks = db.query(Task).filter(Task.status == "open").all()
    active_objectives = db.query(Objective).filter(Objective.status == "active").all()
    reports = []
    for company in companies:
        mission_terms = set(company.mission.lower().split()) | set(company.strategy.lower().split())
        task_hits = 0
        for task in open_tasks:
            text = f"{task.title} {task.description}".lower()
            if any(term in text for term in mission_terms if len(term) > 4):
                task_hits += 1
        denominator = max(1, len(open_tasks))
        alignment_score = round((task_hits / denominator) * 100, 2)
        reports.append({
            "company": company.name,
            "alignment_score": alignment_score,
            "active_objectives": len(active_objectives),
            "warning": alignment_score < 35,
        })
    return {"reports": reports, "recommendation": "Archive or rewrite low-alignment work before it quietly becomes company strategy by accident."}
