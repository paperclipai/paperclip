from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from ..db import get_db
from ..security import require_api_key
from ..schemas import IntegrationUpdate
from ..services.integrations import list_integrations, update_integration

router = APIRouter(prefix="/integrations", tags=["integrations"], dependencies=[Depends(require_api_key)])


@router.get("")
def integrations(db: Session = Depends(get_db)):
    return {"integrations": list_integrations(db)}


@router.patch("/{integration_id}")
def update(integration_id: int, req: IntegrationUpdate, db: Session = Depends(get_db)):
    try:
        return update_integration(db, integration_id, req.status, req.notes)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
