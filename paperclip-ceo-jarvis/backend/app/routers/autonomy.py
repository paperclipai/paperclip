from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from ..db import get_db
from ..security import require_api_key
from ..schemas import AutonomyEvaluateRequest, AutonomyPolicyIn, WatchRuleIn
from ..services import autonomy as svc

router = APIRouter(prefix="/autonomy", tags=["autonomy"], dependencies=[Depends(require_api_key)])


@router.get("/policies")
def policies(db: Session = Depends(get_db)):
    return svc.list_policies(db)


@router.post("/policies")
def create_policy(payload: AutonomyPolicyIn, db: Session = Depends(get_db)):
    return svc.create_policy(db, payload.model_dump())


@router.put("/policies/{policy_id}")
def update_policy(policy_id: int, payload: AutonomyPolicyIn, db: Session = Depends(get_db)):
    try:
        return svc.update_policy(db, policy_id, payload.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/evaluate")
def evaluate(payload: AutonomyEvaluateRequest, db: Session = Depends(get_db)):
    return svc.evaluate_action(db, payload.action, payload.context, payload.intended_actor, payload.impact_area)


@router.get("/watch-rules")
def watch_rules(db: Session = Depends(get_db)):
    return svc.list_watch_rules(db)


@router.post("/watch-rules")
def create_watch_rule(payload: WatchRuleIn, db: Session = Depends(get_db)):
    return svc.create_watch_rule(db, payload.model_dump())


@router.put("/watch-rules/{rule_id}")
def update_watch_rule(rule_id: int, payload: WatchRuleIn, db: Session = Depends(get_db)):
    try:
        return svc.update_watch_rule(db, rule_id, payload.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/watch-cycle")
def watch_cycle(db: Session = Depends(get_db)):
    return svc.run_watch_cycle(db)


@router.get("/insights")
def insights(db: Session = Depends(get_db)):
    return svc.insight_digest(db)
