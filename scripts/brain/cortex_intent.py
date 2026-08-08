from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List


@dataclass
class CortexIntent:
    intent: str
    confidence: str = "medium"
    route_reason: str = "default"
    needs_web_search: bool = False
    needs_vault_search: bool = False
    dashboard_context: str = ""

    def get(self, key, default=None):
        return getattr(self, key, default)


DASHBOARD_CONTEXT = """Contexte dashboard Cortex:
- URL locale: http://127.0.0.1:8765/
- Dashboard GPU/brain: brain_gpu.html
- Sidecar chat à droite
- Onglet Playtest
- Onglet Consortium
- APIs utiles: /api/cortex/judges, /api/cortex/homeostasis, /api/chat
"""


def _norm(text: str) -> str:
    return (text or "").lower().strip()


def detect_intent(message: str) -> CortexIntent:
    m = _norm(message)

    if m.startswith("/code") and any(k in m for k in [
        "playtest", "app", "application", "html", "interface",
        "calculatrice", "todo", "kanban", "dashboard"
    ]):
        return CortexIntent(
            intent="playtest_code_task",
            confidence="high",
            route_reason="playtest_builder_direct",
            dashboard_context=DASHBOARD_CONTEXT,
        )

    if any(k in m for k in [
        "recherche web", "cherche sur le web", "actualité", "actualités",
        "actu", "news", "récent", "récente", "aujourd'hui", "maintenant",
        "dernières nouvelles", "latest"
    ]):
        return CortexIntent(
            intent="recent_web_search",
            confidence="high",
            route_reason="needs_web_search",
            needs_web_search=True,
        )

    if any(k in m for k in [
        "playtest", "playtest intégré", "dashboard", "brain_gpu",
        "sidecar", "consortium", "juges", "judges", "homeostasis"
    ]):
        return CortexIntent(
            intent="playtest_dashboard_help",
            confidence="high",
            route_reason="dashboard_context_injected",
            dashboard_context=DASHBOARD_CONTEXT,
        )

    if any(k in m for k in [
        "vault", "mémoire", "memoire", "obsidian", "souviens",
        "tu vois le projet", "projet de site", "site comores", "comores",
        "workspace", "fichier local", "dans le repo", "dans les fichiers"
    ]):
        return CortexIntent(
            intent="local_project_search",
            confidence="high",
            route_reason="needs_vault_or_file_search",
            needs_vault_search=True,
        )

    if any(k in m for k in [
        "debug", "raisonne", "analyse profonde", "planifie",
        "architecture", "pourquoi", "diagnostic"
    ]):
        return CortexIntent(
            intent="deep_reason",
            confidence="medium",
            route_reason="deep_reason_requested",
        )

    if any(k in m for k in [
        "tu es qui", "présente toi", "présente-toi", "qui es-tu",
        "c'est quoi cortex", "qui t'a créé"
    ]):
        return CortexIntent(
            intent="identity",
            confidence="high",
            route_reason="identity_or_presentation",
        )

    if any(k in m for k in [
        "code", "patch", "modifie", "corrige", "commande",
        "powershell", "python", "git"
    ]):
        return CortexIntent(
            intent="code_task",
            confidence="medium",
            route_reason="code_or_task_execution",
        )

    return CortexIntent(
        intent="simple_chat",
        confidence="medium",
        route_reason="simple_chat",
    )


def metadata(intent: CortexIntent, backend: str = "minimax_fast", tools_used: List[str] | None = None, evidence_count: int = 0) -> dict:
    return {
        "intent": intent.intent,
        "tools_used": tools_used or [],
        "evidence_count": evidence_count,
        "backend": backend,
        "route_reason": intent.route_reason,
        "confidence": intent.confidence,
        "needs_web_search": intent.needs_web_search,
        "needs_vault_search": intent.needs_vault_search,
    }
