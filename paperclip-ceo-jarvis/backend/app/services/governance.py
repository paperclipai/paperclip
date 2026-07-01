from __future__ import annotations
from datetime import datetime
from sqlalchemy.orm import Session
from ..models import ApprovalRequest, AuditLog, SystemFlag
from ..security import classify_risk


def create_approval(db: Session, title: str, action: str, risk_level: str | None = None, rationale: str = "") -> ApprovalRequest:
    risk = risk_level or classify_risk(action)
    item = ApprovalRequest(title=title, action=action, risk_level=risk, rationale=rationale, status="pending")
    db.add(item)
    db.add(AuditLog(actor="jarvis", action="create approval request", risk_level=risk, allowed=True, details={"title": title}))
    db.commit()
    db.refresh(item)
    return item


def decide_approval(db: Session, approval_id: int, status: str, note: str = "") -> ApprovalRequest:
    item = db.get(ApprovalRequest, approval_id)
    if not item:
        raise ValueError("Approval request not found")
    if item.status != "pending":
        raise ValueError("Approval request already decided")
    item.status = status
    item.decision_note = note
    item.decided_at = datetime.utcnow()
    db.add(AuditLog(actor="ceo", action=f"{status} approval request", risk_level=item.risk_level, allowed=status == "approved", details={"approval_id": approval_id, "note": note}))
    db.commit()
    db.refresh(item)
    return item


def set_flag(db: Session, key: str, value: str, reason: str = "") -> dict:
    flag = db.query(SystemFlag).filter(SystemFlag.key == key).first()
    if not flag:
        flag = SystemFlag(key=key, value=value, reason=reason)
        db.add(flag)
    else:
        flag.value = value
        flag.reason = reason
    db.add(AuditLog(actor="ceo", action=f"set system flag {key}={value}", risk_level="high" if key == "paused" and value == "true" else "medium", allowed=True, details={"reason": reason}))
    db.commit()
    return {"key": key, "value": value, "reason": reason}


def system_status(db: Session) -> dict:
    flags = {f.key: f.value for f in db.query(SystemFlag).all()}
    paused = flags.get("paused", "false") == "true"
    return {"paused": paused, "flags": flags, "mode": "paused" if paused else "active"}
