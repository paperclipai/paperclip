from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from ..db import get_db
from ..security import require_api_key
from ..schemas import SwarmRunRequest
from ..services.orchestrator import list_agents, run_swarm

router = APIRouter(prefix="/agents", tags=["agents"], dependencies=[Depends(require_api_key)])


@router.get("")
def agents(db: Session = Depends(get_db)):
    return {"agents": list_agents(db)}


@router.post("/swarm")
def swarm(req: SwarmRunRequest, db: Session = Depends(get_db)):
    return run_swarm(db, req.task, req.mode, req.agents, req.require_approval_for_execution)
