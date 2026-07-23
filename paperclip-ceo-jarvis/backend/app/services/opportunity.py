from sqlalchemy.orm import Session
from ..models import Company, Objective


def opportunity_radar(db: Session) -> list[dict]:
    companies = db.query(Company).all()
    objectives = db.query(Objective).filter(Objective.status == "active").all()
    opportunities = []
    for company in companies:
        base = company.health_score
        opportunities.append({
            "company": company.name,
            "title": "Package internal AI agents as a paid product tier",
            "score": round(min(95, base * 0.75 + 25), 2),
            "why": "Existing agent infrastructure can become customer-facing leverage.",
            "first_step": "Select one internal workflow and productize it as a beta feature.",
        })
        opportunities.append({
            "company": company.name,
            "title": "Create executive intelligence dashboard",
            "score": round(min(92, base * 0.70 + len(objectives) * 2 + 20), 2),
            "why": "CEO visibility improves decision speed and reduces coordination waste.",
            "first_step": "Connect objective, task, employee, and risk data into one daily briefing.",
        })
    return sorted(opportunities, key=lambda x: x["score"], reverse=True)
