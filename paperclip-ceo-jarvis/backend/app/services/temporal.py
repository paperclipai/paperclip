from __future__ import annotations
from datetime import datetime, timedelta
from sqlalchemy.orm import Session
from ..models import Task, OpportunitySignal, DebtItem, PredictionRecord


def execution_timeline(db: Session, horizon_days: int = 90) -> dict:
    tasks = db.query(Task).filter(Task.status == "open").order_by(Task.priority.desc(), Task.created_at.asc()).all()
    now = datetime.utcnow()
    timeline = []
    cursor = now
    for task in tasks[:20]:
        days = max(1, 6 - task.priority)
        if task.risk_level == "high":
            days += 2
        cursor = cursor + timedelta(days=days)
        if (cursor - now).days <= horizon_days:
            timeline.append({
                "task_id": task.id,
                "title": task.title,
                "estimated_completion": cursor,
                "priority": task.priority,
                "risk_level": task.risk_level,
                "note": "High-risk review required before execution." if task.risk_level == "high" else "Proceed if owner has capacity.",
            })
    return {
        "generated_at": now,
        "horizon_days": horizon_days,
        "timeline": timeline,
        "forecast_quality": "rough_local_estimate",
        "recommendation": "Use this as a CEO planning lens, not as prophecy. Prophecy has a poor product-market fit.",
    }


def opportunity_windows(db: Session) -> dict:
    signals = db.query(OpportunitySignal).filter(OpportunitySignal.status == "open").order_by(OpportunitySignal.score.desc()).all()
    if not signals:
        defaults = [
            {"title": "Package agent workflows as paid Paperclip tier", "score": 86, "window_days": 30, "first_step": "Turn one internal CEO workflow into a beta template."},
            {"title": "Publish local-first AI assistant blueprint", "score": 80, "window_days": 14, "first_step": "Release a short technical note and demo video."},
        ]
        return {"windows": defaults, "recommendation": "Pick one window and assign an owner within 24 hours."}
    return {"windows": [{"title": s.title, "score": s.score, "window_days": s.window_days, "rationale": s.rationale, "first_step": s.first_step} for s in signals]}


def debt_snapshot(db: Session) -> dict:
    debts = db.query(DebtItem).filter(DebtItem.status == "open").order_by(DebtItem.impact.desc(), DebtItem.created_at.asc()).all()
    overdue = []
    now = datetime.utcnow()
    for d in debts:
        if d.due_at and d.due_at < now:
            overdue.append(d)
    return {
        "open_count": len(debts),
        "overdue_count": len(overdue),
        "items": [{"id": d.id, "title": d.title, "category": d.category, "owner": d.owner, "due_at": d.due_at, "impact": d.impact} for d in debts[:20]],
        "recommendation": "Pay down overdue promises before inventing new promises. Radical, I know.",
    }


def add_prediction(db: Session, subject: str, prediction: str, confidence: float, horizon_days: int, expected_signal: str) -> PredictionRecord:
    record = PredictionRecord(subject=subject, prediction=prediction, confidence=confidence, horizon_days=horizon_days, expected_signal=expected_signal)
    db.add(record)
    db.commit()
    db.refresh(record)
    return record


def resolve_prediction(db: Session, prediction_id: int, actual_outcome: str, accuracy_score: float) -> PredictionRecord:
    record = db.get(PredictionRecord, prediction_id)
    if not record:
        raise ValueError("Prediction not found")
    record.actual_outcome = actual_outcome
    record.accuracy_score = accuracy_score
    record.status = "resolved"
    db.commit()
    db.refresh(record)
    return record
