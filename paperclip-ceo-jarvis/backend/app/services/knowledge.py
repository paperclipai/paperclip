from __future__ import annotations
import hashlib
import re
from sqlalchemy.orm import Session
from ..models import KnowledgeDocument, Memory, Company, Objective, Task, DecisionJournal


def digest_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _tokens(text: str) -> set[str]:
    return set(re.findall(r"[a-zA-Z0-9_+-]{3,}", text.lower()))


def add_document(db: Session, title: str, content: str, source: str = "manual", tags: list[str] | None = None, importance: int = 3) -> KnowledgeDocument:
    doc = KnowledgeDocument(title=title, content=content, source=source, tags=tags or [], importance=importance, digest=digest_text(content))
    db.add(doc)
    db.commit()
    db.refresh(doc)
    return doc


def search_documents(db: Session, query: str, limit: int = 5) -> list[dict]:
    q = _tokens(query)
    docs = db.query(KnowledgeDocument).all()
    scored = []
    for doc in docs:
        haystack = _tokens(f"{doc.title} {doc.content} {' '.join(doc.tags or [])}")
        overlap = len(q & haystack)
        if overlap or query.lower() in doc.content.lower() or query.lower() in doc.title.lower():
            score = overlap * 10 + doc.importance * 2
            scored.append({
                "id": doc.id,
                "title": doc.title,
                "source": doc.source,
                "tags": doc.tags,
                "importance": doc.importance,
                "score": score,
                "snippet": doc.content[:700] + ("…" if len(doc.content) > 700 else ""),
                "created_at": doc.created_at,
            })
    return sorted(scored, key=lambda x: x["score"], reverse=True)[:limit]


def executive_context_bundle(db: Session, query: str = "") -> dict:
    companies = db.query(Company).all()
    objectives = db.query(Objective).filter(Objective.status == "active").order_by(Objective.priority.desc()).limit(8).all()
    tasks = db.query(Task).filter(Task.status == "open").order_by(Task.priority.desc()).limit(10).all()
    memories = db.query(Memory).order_by(Memory.importance.desc(), Memory.updated_at.desc()).limit(8).all()
    journals = db.query(DecisionJournal).order_by(DecisionJournal.created_at.desc()).limit(5).all()
    docs = search_documents(db, query, 5) if query else []
    return {
        "companies": [{"name": c.name, "mission": c.mission, "strategy": c.strategy, "health_score": c.health_score} for c in companies],
        "objectives": [{"title": o.title, "priority": o.priority, "description": o.description} for o in objectives],
        "open_tasks": [{"title": t.title, "priority": t.priority, "risk_level": t.risk_level, "due_at": t.due_at} for t in tasks],
        "important_memories": [{"key": m.key, "value": m.value, "importance": m.importance} for m in memories],
        "recent_decisions": [{"title": j.title, "chosen_path": j.chosen_path, "status": j.status, "review_at": j.review_at} for j in journals],
        "knowledge_hits": docs,
    }
