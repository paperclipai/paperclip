from __future__ import annotations
import hashlib
from datetime import datetime
from sqlalchemy.orm import Session
from ..models import Decision


def _stable_score(text: str, low: int = 45, high: int = 88) -> int:
    digest = hashlib.sha256(text.encode()).hexdigest()
    return low + int(digest[:6], 16) % (high - low + 1)


def simulate_decision(db: Session, title: str, decision: str, horizon_days: int, assumptions: list[str], constraints: list[str]) -> dict:
    joined = "|".join([title, decision, str(horizon_days), *assumptions, *constraints])
    confidence = _stable_score(joined) / 100
    upside = round(50 + confidence * 45, 2)
    downside = round(100 - upside + len(constraints) * 3, 2)
    execution_risk = round(max(10, 65 - confidence * 40 + len(assumptions) * 1.5), 2)

    risks = [
        "Assumptions may be optimistic unless tied to measurable leading indicators.",
        "Execution load may exceed team capacity if ownership is unclear.",
    ]
    if constraints:
        risks.append("Hard constraints could compress the schedule or reduce optionality.")
    if horizon_days < 30:
        risks.append("Short horizon reduces room for correction if early signals are poor.")

    mitigations = [
        "Define stop-loss criteria before committing resources.",
        "Assign one owner, one metric, and one review date.",
        "Run a reversible pilot before full rollout.",
    ]

    recommendation = "Proceed with controlled pilot" if confidence >= 0.62 else "Delay until assumptions are validated"
    forecast = {
        "horizon_days": horizon_days,
        "confidence_interval": [round(max(0.1, confidence - 0.12), 2), round(min(0.95, confidence + 0.12), 2)],
        "upside_score": upside,
        "downside_score": downside,
        "execution_risk_score": execution_risk,
        "expected_signal_dates": ["day_7", "day_30", f"day_{horizon_days}"],
    }
    result = {
        "title": title,
        "recommendation": recommendation,
        "confidence": round(confidence, 2),
        "forecast": forecast,
        "risks": risks,
        "mitigations": mitigations,
        "next_actions": [
            "Write the pilot success metric.",
            "Name the accountable owner.",
            "Schedule a review checkpoint.",
        ],
    }
    db.add(Decision(title=title, decision=decision, horizon_days=horizon_days, assumptions={"items": assumptions, "constraints": constraints}, simulation=result))
    db.commit()
    return result
