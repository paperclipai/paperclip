from __future__ import annotations
import os
import re
from pathlib import Path
from sqlalchemy.orm import Session
from ..models import RiskItem, DebtItem, AuditLog

SECRET_PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9_-]{20,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"(?i)(password|client_secret|api_key)\s*=\s*['\"]?[^\s'\"]{12,}"),
]


def add_risk(db: Session, title: str, category: str, severity: int, likelihood: int, owner: str, mitigation: str) -> RiskItem:
    item = RiskItem(title=title, category=category, severity=severity, likelihood=likelihood, owner=owner, mitigation=mitigation)
    db.add(item)
    db.add(AuditLog(actor="jarvis", action="add risk item", risk_level="medium", allowed=True, details={"title": title}))
    db.commit()
    db.refresh(item)
    return item


def risk_register(db: Session) -> dict:
    items = db.query(RiskItem).filter(RiskItem.status == "open").order_by(RiskItem.severity.desc(), RiskItem.likelihood.desc()).all()
    return {
        "open_count": len(items),
        "aggregate_risk_score": sum(i.severity * i.likelihood for i in items),
        "items": [{"id": i.id, "title": i.title, "category": i.category, "severity": i.severity, "likelihood": i.likelihood, "owner": i.owner, "mitigation": i.mitigation} for i in items],
        "recommendation": "Work the highest severity × likelihood item first; risk does not care about your roadmap aesthetic.",
    }


def add_debt(db: Session, title: str, category: str, owner: str, due_at, impact: int) -> DebtItem:
    item = DebtItem(title=title, category=category, owner=owner, due_at=due_at, impact=impact)
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


def scan_text_for_secrets(text: str) -> list[dict]:
    findings = []
    for pattern in SECRET_PATTERNS:
        for match in pattern.finditer(text):
            raw = match.group(0)
            findings.append({"pattern": pattern.pattern, "sample": raw[:8] + "…", "severity": "critical"})
    return findings


def scan_repo_for_secret_patterns(path: str, max_files: int = 200) -> dict:
    root = Path(path)
    findings = []
    scanned = 0
    if not root.exists():
        return {"error": "path_not_found", "path": path, "findings": []}
    for file in root.rglob("*"):
        if scanned >= max_files:
            break
        if not file.is_file() or file.suffix.lower() in {".png", ".jpg", ".jpeg", ".gif", ".zip", ".db", ".sqlite"}:
            continue
        if any(part in {".git", "node_modules", ".venv", "__pycache__"} for part in file.parts):
            continue
        try:
            text = file.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        scanned += 1
        for finding in scan_text_for_secrets(text):
            finding["file"] = str(file)
            findings.append(finding)
    return {"path": str(root), "scanned_files": scanned, "findings": findings, "safe_to_publish": len(findings) == 0}
