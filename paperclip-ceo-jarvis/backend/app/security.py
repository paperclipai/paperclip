from fastapi import Header, HTTPException, status
from sqlalchemy.orm import Session
from .config import get_settings
from .models import AuditLog

settings = get_settings()

HIGH_RISK_KEYWORDS = {
    "delete", "wire transfer", "payment", "password", "production deploy",
    "fire employee", "legal notice", "terminate contract", "public announcement",
    "publish", "send external", "spend", "credential rotation",
}
MEDIUM_RISK_KEYWORDS = {"send", "invite", "archive", "update", "scan", "credential", "connect", "sync"}
SAFE_AUDIT_ACTIONS = {"scan repository for credential leaks", "generate transparent rationale"}


def require_api_key(x_jarvis_key: str | None = Header(default=None)) -> None:
    if settings.environment == "development" and settings.jarvis_api_key == "dev-change-me":
        return
    if not x_jarvis_key or x_jarvis_key != settings.jarvis_api_key:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid Jarvis API key")


def classify_risk(action: str) -> str:
    lowered = action.lower()
    if lowered in SAFE_AUDIT_ACTIONS:
        return "low"
    if any(k in lowered for k in HIGH_RISK_KEYWORDS):
        return "high"
    if any(k in lowered for k in MEDIUM_RISK_KEYWORDS):
        return "medium"
    return "low"


def guard_action(db: Session, action: str, details: dict | None = None) -> bool:
    risk = classify_risk(action)
    allowed = risk != "high" or settings.allow_high_risk_actions
    db.add(AuditLog(actor="jarvis", action=action, risk_level=risk, allowed=allowed, details=details or {}))
    db.commit()
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="High-risk action blocked. Create/approve an approval request, or set ALLOW_HIGH_RISK_ACTIONS=true only in controlled environments.",
        )
    return True
