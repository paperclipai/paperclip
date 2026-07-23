from __future__ import annotations
import hashlib
import math
import re
from datetime import datetime, timedelta
from sqlalchemy.orm import Session
from ..models import Company, Objective, Task, DecisionJournal, PredictionRecord

STOPWORDS = {"the", "and", "for", "with", "that", "this", "from", "into", "should", "would", "could", "about", "your", "our", "are", "you"}


def stable_float(text: str, low: float = 0.45, high: float = 0.88) -> float:
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    value = int(digest[:8], 16) / 0xFFFFFFFF
    return round(low + value * (high - low), 2)


def keywords(text: str, limit: int = 12) -> list[str]:
    words = re.findall(r"[a-zA-Z][a-zA-Z0-9_+-]{2,}", text.lower())
    seen = []
    for word in words:
        if word not in STOPWORDS and word not in seen:
            seen.append(word)
    return seen[:limit]


def explain_reasoning(db: Session, question: str, context: dict | None = None, horizon_days: int = 60) -> dict:
    """Return an auditable rationale artifact, not hidden chain-of-thought.

    This gives the CEO enough reasoning structure to trust or challenge the output
    without exposing private model scratchpad.
    """
    context = context or {}
    companies = db.query(Company).all()
    objectives = db.query(Objective).filter(Objective.status == "active").all()
    open_tasks = db.query(Task).filter(Task.status == "open").all()
    terms = keywords(question + " " + " ".join(str(v) for v in context.values()))
    confidence = stable_float(question + str(context) + str(len(open_tasks)))

    objective_matches = []
    for obj in objectives:
        text = f"{obj.title} {obj.description}".lower()
        score = sum(1 for term in terms if term in text) + obj.priority * 0.2
        if score > 0.5:
            objective_matches.append({"title": obj.title, "priority": obj.priority, "match_score": round(score, 2)})

    task_pressure = len([t for t in open_tasks if t.priority >= 4 or t.risk_level == "high"])
    rationale = [
        "Mapped the request to active company objectives and open execution pressure.",
        "Separated reversible next steps from actions that need explicit CEO approval.",
        "Estimated confidence from available local context, assumption count, and risk density.",
    ]
    if task_pressure:
        rationale.append(f"Detected {task_pressure} high-priority or high-risk open item(s), so execution capacity is a constraint.")
    if objective_matches:
        rationale.append("At least one active objective supports this direction, which improves strategic fit.")
    else:
        rationale.append("No strong active-objective match was found; treat this as a strategic exploration until aligned.")

    branches = [
        {
            "name": "Conservative path",
            "summary": "Validate assumptions with a small pilot before broad commitment.",
            "expected_outcome": "Lower downside; slower learning velocity.",
            "confidence": round(min(0.92, confidence + 0.07), 2),
        },
        {
            "name": "Aggressive path",
            "summary": "Commit team capacity now and push toward first-mover advantage.",
            "expected_outcome": "Higher upside; higher coordination and quality risk.",
            "confidence": round(max(0.2, confidence - 0.12), 2),
        },
        {
            "name": "Defer path",
            "summary": "Do not commit until stronger data or customer signal appears.",
            "expected_outcome": "Preserves attention; may lose a timing window.",
            "confidence": round(max(0.25, 1 - confidence), 2),
        },
    ]
    causal_links = [
        {"cause": "Clear owner + metric", "effect": "Higher execution reliability", "strength": "high"},
        {"cause": "More active priorities", "effect": "Greater burnout and delivery risk", "strength": "medium"},
        {"cause": "Reversible pilot", "effect": "Cheaper learning and cleaner stop-loss", "strength": "high"},
    ]
    if companies:
        causal_links.append({"cause": "Mission/strategy alignment", "effect": f"Protects {companies[0].name} from drift", "strength": "medium"})

    recommendation = "Run a reversible pilot with one owner, one metric, and a review date. Very CEO, regrettably sensible."
    return {
        "generated_at": datetime.utcnow(),
        "question": question,
        "confidence": confidence,
        "horizon_days": horizon_days,
        "recommendation": recommendation,
        "visible_rationale": rationale,
        "assumptions_to_validate": [
            "The user/customer problem is painful enough to justify immediate action.",
            "The team has capacity after current high-priority work.",
            "The success metric can be observed within the forecast horizon.",
        ],
        "objective_matches": objective_matches[:5],
        "scenario_branches": branches,
        "causal_links": causal_links,
        "evidence_required": [
            "Customer signal or usage data",
            "Owner capacity check",
            "Cost and risk estimate",
            "Stop-loss criteria",
        ],
        "next_actions": [
            "Create a decision journal entry.",
            "Open an approval request if the action is public, destructive, financial, or irreversible.",
            "Schedule a review checkpoint before expanding scope.",
        ],
    }


def create_decision_journal(db: Session, title: str, context: str, chosen_path: str, expected_outcome: str, review_days: int = 30) -> DecisionJournal:
    item = DecisionJournal(
        title=title,
        context=context,
        chosen_path=chosen_path,
        expected_outcome=expected_outcome,
        review_at=datetime.utcnow() + timedelta(days=review_days),
        status="open",
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


def calibration_summary(db: Session) -> dict:
    records = db.query(PredictionRecord).filter(PredictionRecord.accuracy_score.isnot(None)).all()
    if not records:
        return {
            "status": "insufficient_data",
            "average_accuracy": None,
            "recommendation": "Resolve at least five predictions before trusting calibration curves.",
        }
    avg = sum(r.accuracy_score or 0 for r in records) / len(records)
    overconfident = [r for r in records if r.confidence - (r.accuracy_score or 0) > 0.2]
    underconfident = [r for r in records if (r.accuracy_score or 0) - r.confidence > 0.2]
    return {
        "status": "calibrated" if len(records) >= 5 else "early",
        "resolved_predictions": len(records),
        "average_accuracy": round(avg, 2),
        "overconfident_count": len(overconfident),
        "underconfident_count": len(underconfident),
        "recommendation": "Reduce confidence on strategic forecasts." if overconfident else "Calibration acceptable; keep recording outcomes.",
    }
