from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from ..db import get_db
from ..config import get_settings
from ..security import require_api_key, guard_action
from ..schemas import DecisionSimulationRequest, DecisionSimulationResponse, BriefingOut, ExecutiveMessageRequest, BoardPackResponse, MeetingOptimizeRequest
from ..services.briefing import morning_briefing
from ..services.decision_simulator import simulate_decision
from ..services.opportunity import opportunity_radar
from ..services.alignment import alignment_report
from ..services.board_pack import generate_board_pack
from ..services.communication import executive_message
from ..services.meeting import optimize_meeting

router = APIRouter(prefix="/ceo", tags=["ceo"], dependencies=[Depends(require_api_key)])


@router.get("/morning-briefing", response_model=BriefingOut)
def get_morning_briefing(db: Session = Depends(get_db)):
    return morning_briefing(db, get_settings().jarvis_primary_user)


@router.post("/decisions/simulate", response_model=DecisionSimulationResponse)
def decision_simulation(req: DecisionSimulationRequest, db: Session = Depends(get_db)):
    guard_action(db, "simulate strategic decision", req.model_dump())
    return simulate_decision(db, req.title, req.decision, req.horizon_days, req.assumptions, req.constraints)


@router.get("/opportunities")
def get_opportunities(db: Session = Depends(get_db)):
    return {"opportunities": opportunity_radar(db)}


@router.get("/alignment")
def get_alignment(db: Session = Depends(get_db)):
    return alignment_report(db)


@router.get("/board-pack", response_model=BoardPackResponse)
def board_pack(db: Session = Depends(get_db)):
    guard_action(db, "generate board pack", {})
    return generate_board_pack(db)


@router.post("/communication/draft")
def draft_message(req: ExecutiveMessageRequest, db: Session = Depends(get_db)):
    guard_action(db, "draft executive communication", req.model_dump())
    return {"draft": executive_message(req.audience, req.objective, req.facts, req.tone)}


@router.post("/meeting/optimize")
def meeting_optimizer(req: MeetingOptimizeRequest):
    return optimize_meeting(req.topic, req.participants, req.desired_outcome)
