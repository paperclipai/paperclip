from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from ..db import get_db
from ..security import require_api_key, guard_action
from ..schemas import ContentRequest
from ..services.content import generate_content

router = APIRouter(prefix="/content", tags=["content"], dependencies=[Depends(require_api_key)])


@router.post("/generate")
def generate(req: ContentRequest, db: Session = Depends(get_db)):
    guard_action(db, f"draft {req.kind}", req.model_dump())
    return generate_content(req.kind, req.topic, req.audience, req.facts, req.tone)
