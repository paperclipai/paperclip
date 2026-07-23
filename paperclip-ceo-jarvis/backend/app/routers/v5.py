from fastapi import APIRouter, Depends, Body, Query
from sqlalchemy.orm import Session
from ..db import get_db
from ..security import require_api_key
from ..services import v5 as svc

router = APIRouter(prefix="/v5", tags=["v5-missing-systems"], dependencies=[Depends(require_api_key)])

@router.get("/audit")
def audit(db: Session = Depends(get_db)): return svc.v5_audit(db)

@router.get("/records/{kind}")
def records(kind: str, db: Session = Depends(get_db)): return svc.list_kind(db, kind)

@router.get("/constitutional/principles")
def principles(db: Session = Depends(get_db)): return svc.list_kind(db, "constitutional_principle")

@router.post("/constitutional/check")
def check(payload: dict = Body(default_factory=dict), db: Session = Depends(get_db)):
    return svc.constitutional_check(db, payload.get("action", "Review action"), payload.get("context", {}))

@router.get("/zero-trust/rules")
def zt_rules(db: Session = Depends(get_db)): return svc.list_kind(db, "zero_trust_rule")

@router.post("/zero-trust/decision")
def zt_decision(payload: dict = Body(default_factory=dict), db: Session = Depends(get_db)):
    return svc.zero_trust_decision(db, payload.get("actor", "JARVIS"), payload.get("resource", "dashboard"), payload.get("requested_scope", "read"))

@router.get("/carbon/routes")
def carbon_routes(db: Session = Depends(get_db)): return svc.list_kind(db, "carbon_route")

@router.post("/carbon/choose-route")
def carbon_choose(payload: dict = Body(default_factory=dict), db: Session = Depends(get_db)):
    return svc.carbon_choose(db, payload.get("task", "general reasoning"), float(payload.get("min_quality", 70.0)))

@router.get("/evaluation/suites")
def eval_suites(db: Session = Depends(get_db)): return svc.list_kind(db, "evaluation_suite")

@router.post("/evaluation/run")
def eval_run(payload: dict = Body(default_factory=dict), db: Session = Depends(get_db)):
    return svc.evaluation_run(db, payload.get("suite_name"))

@router.get("/context/policies")
def context_policies(db: Session = Depends(get_db)): return svc.list_kind(db, "context_policy")

@router.post("/context/bundle")
def context_bundle(payload: dict = Body(default_factory=dict), db: Session = Depends(get_db)):
    return svc.context_bundle(db, payload.get("task", "CEO decision"), payload.get("scope", "ceo"))

@router.get("/collaboration/sessions")
def collaboration_sessions(db: Session = Depends(get_db)): return svc.list_kind(db, "collaboration_session")

@router.post("/collaboration/start")
def collaboration_start(payload: dict = Body(default_factory=dict), db: Session = Depends(get_db)):
    return svc.collaboration_start(db, payload.get("title", "CEO + Agent Co-Creation Session"), payload.get("participants", ["CEO", "JARVIS"]), payload.get("artifact", ""), payload.get("mode", "co_creation"))

@router.get("/workforce/marketplace")
def marketplace(db: Session = Depends(get_db)): return svc.marketplace(db)

@router.get("/company/ecosystem")
def ecosystem(db: Session = Depends(get_db)): return svc.ecosystem(db)

@router.get("/company/health-forecast")
def health_forecast(horizon_days: int = Query(default=90, ge=7, le=365), db: Session = Depends(get_db)): return svc.health_forecast(db, horizon_days)

@router.post("/board/vote")
def board_vote(payload: dict = Body(default_factory=dict), db: Session = Depends(get_db)): return svc.board_vote(db, payload.get("proposal", "Launch Jarvis after review"))

@router.post("/teams/propose")
def team(payload: dict = Body(default_factory=dict), db: Session = Depends(get_db)): return svc.propose_team(db, payload.get("demand_signal", "Growth Engineering demand exceeds capacity"))

@router.get("/meta-learning")
def meta(db: Session = Depends(get_db)): return svc.meta_learning(db)

@router.post("/agents/propose-generation")
def gen(payload: dict = Body(default_factory=dict), db: Session = Depends(get_db)): return svc.propose_generation(db, payload.get("parent_agent", "Hermes"), payload.get("improvement_goal", "Improve evaluation"))

@router.get("/rnd/lab")
def rnd(db: Session = Depends(get_db)): return svc.list_kind(db, "rnd_experiment")

@router.get("/engineering/catalog")
def eng(db: Session = Depends(get_db)): return svc.list_kind(db, "engineering_domain")

@router.get("/deployment/regions")
def regions(db: Session = Depends(get_db)): return svc.list_kind(db, "deployment_region")

@router.get("/compliance/automation")
def compliance(db: Session = Depends(get_db)): return svc.list_kind(db, "compliance_rule")

@router.get("/culture/intelligence")
def culture(db: Session = Depends(get_db)): return svc.list_kind(db, "culture_signal")
