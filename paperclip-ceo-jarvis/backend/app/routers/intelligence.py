from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from ..db import get_db
from ..security import require_api_key, guard_action
from ..schemas import ReasoningRequest, KnowledgeIn, KnowledgeSearchRequest, DecisionSimulationRequest
from ..services.intelligence import explain_reasoning, create_decision_journal, calibration_summary
from ..services.knowledge import add_document, search_documents, executive_context_bundle

router = APIRouter(prefix="/intelligence", tags=["intelligence"], dependencies=[Depends(require_api_key)])


@router.post("/reason")
def reason(req: ReasoningRequest, db: Session = Depends(get_db)):
    guard_action(db, "generate transparent rationale", req.model_dump())
    return explain_reasoning(db, req.question, req.context, req.horizon_days)


@router.post("/knowledge")
def create_knowledge(req: KnowledgeIn, db: Session = Depends(get_db)):
    guard_action(db, "add knowledge document", {"title": req.title, "source": req.source})
    doc = add_document(db, req.title, req.content, req.source, req.tags, req.importance)
    return {"id": doc.id, "title": doc.title, "source": doc.source, "tags": doc.tags, "importance": doc.importance}


@router.post("/knowledge/search")
def search_knowledge(req: KnowledgeSearchRequest, db: Session = Depends(get_db)):
    return {"results": search_documents(db, req.query, req.limit)}


@router.get("/context")
def context_bundle(query: str = "", db: Session = Depends(get_db)):
    return executive_context_bundle(db, query)


@router.post("/decision-journal")
def journal_entry(req: DecisionSimulationRequest, db: Session = Depends(get_db)):
    item = create_decision_journal(
        db,
        title=req.title,
        context="\n".join(req.assumptions + req.constraints),
        chosen_path=req.decision,
        expected_outcome="Outcome to be reviewed against decision simulation and leading indicators.",
        review_days=min(req.horizon_days, 90),
    )
    return {"id": item.id, "title": item.title, "review_at": item.review_at, "status": item.status}


@router.get("/calibration")
def calibration(db: Session = Depends(get_db)):
    return calibration_summary(db)
