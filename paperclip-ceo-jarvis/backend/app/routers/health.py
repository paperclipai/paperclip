from fastapi import APIRouter
from ..config import get_settings

router = APIRouter()


@router.get("/health")
def health():
    settings = get_settings()
    return {
        "status": "online",
        "app": settings.app_name,
        "version": "3.0.0",
        "environment": settings.environment,
        "capabilities": ["briefings", "reasoning", "agents", "approvals", "dashboard", "temporal", "risk", "integrations", "mission-control", "playbooks", "capability-readiness"],
    }
