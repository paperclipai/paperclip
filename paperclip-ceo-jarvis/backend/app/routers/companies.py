from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from ..db import get_db
from ..models import Company
from ..schemas import CompanyCreate, CompanyOut
from ..security import require_api_key

router = APIRouter(prefix="/companies", tags=["companies"], dependencies=[Depends(require_api_key)])


@router.get("", response_model=list[CompanyOut])
def list_companies(db: Session = Depends(get_db)):
    return db.query(Company).order_by(Company.name).all()


@router.post("", response_model=CompanyOut)
def create_company(req: CompanyCreate, db: Session = Depends(get_db)):
    company = Company(**req.model_dump())
    db.add(company)
    db.commit()
    db.refresh(company)
    return company
