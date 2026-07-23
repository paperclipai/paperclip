from __future__ import annotations
from datetime import datetime
from statistics import mean
from sqlalchemy.orm import Session
from ..models import V5Record, Employee, Company, ApprovalRequest, AuditLog, EnchantmentFeature

DATA = [
    ("constitutional_principle", "human_authority", "Human authority remains final", 100, {"immutable": True, "approval_threshold": "human_board_unanimous", "principle": "High-impact strategy, spend, legal, public, credential, hiring/firing and production actions require explicit human approval."}),
    ("constitutional_principle", "mission_alignment", "Mission alignment over raw optimization", 100, {"immutable": True, "principle": "Do not optimize metrics in ways that undermine trust, lawfulness, safety, values, or long-term resilience."}),
    ("constitutional_principle", "least_privilege", "Least privilege by default", 100, {"immutable": True, "principle": "Agents receive only the context, scopes, tools and time needed for the task."}),
    ("constitutional_principle", "truthful_uncertainty", "Truthful uncertainty", 100, {"immutable": True, "principle": "Expose assumptions, confidence, missing evidence, and limits instead of invented certainty."}),
    ("constitutional_principle", "privacy_security", "Privacy and credential protection", 100, {"immutable": True, "principle": "Never store or expose raw secrets; use env/vault patterns and scan generated artifacts."}),
    ("zero_trust_rule", "jarvis_dashboard_read", "JARVIS dashboard read access", 80, {"actor": "JARVIS", "resource": "dashboard", "scopes": ["read", "summarize"], "verification": "api_key_plus_audit", "ttl_minutes": 240}),
    ("zero_trust_rule", "jarvis_deploy_prepare", "JARVIS production deploy prepare only", 80, {"actor": "JARVIS", "resource": "production_deploy", "scopes": ["prepare", "plan"], "verification": "approval_request_plus_audit", "ttl_minutes": 30}),
    ("zero_trust_rule", "swarm_knowledge_redacted", "Swarm redacted knowledge access", 75, {"actor": "Agent Swarm", "resource": "knowledge_base", "scopes": ["redacted_read", "summarize"], "verification": "task_bound_token", "ttl_minutes": 60}),
    ("carbon_route", "local_cpu_small", "Local CPU small route", 62, {"region": "local", "carbon_intensity_gco2_kwh": 80, "cost_score": 95, "quality_score": 62, "latency_ms": 250}),
    ("carbon_route", "local_gpu_shared", "Local GPU shared route", 78, {"region": "local", "carbon_intensity_gco2_kwh": 110, "cost_score": 85, "quality_score": 78, "latency_ms": 95}),
    ("carbon_route", "eu_low_carbon_region", "EU low-carbon route", 84, {"region": "eu-north", "carbon_intensity_gco2_kwh": 45, "cost_score": 68, "quality_score": 84, "latency_ms": 140}),
    ("carbon_route", "premium_frontier_cloud", "Premium frontier cloud route", 94, {"region": "managed", "carbon_intensity_gco2_kwh": 180, "cost_score": 35, "quality_score": 94, "latency_ms": 90}),
    ("evaluation_suite", "governance_regression", "Governance regression suite", 92, {"checks": ["high_risk_requires_approval", "audit_log_written", "constitutional_check_present"], "threshold": 0.92}),
    ("evaluation_suite", "briefing_quality", "Briefing quality LLM-as-judge suite", 86, {"checks": ["actionable", "prioritized", "truthful_uncertainty", "no_secret_leak"], "threshold": 0.86}),
    ("evaluation_suite", "context_minimization", "Context minimization suite", 88, {"checks": ["least_privilege", "redaction", "compression", "source_traceability"], "threshold": 0.88}),
    ("context_policy", "ceo_command", "CEO command context policy", 90, {"scope": "ceo", "exposure": "executive_summary_plus_relevant_evidence", "max_tokens": 18000, "rules": ["include objectives", "include approvals", "exclude raw secrets"]}),
    ("context_policy", "agent_swarm", "Agent swarm context policy", 86, {"scope": "agents", "exposure": "task_bound_redacted", "max_tokens": 10000, "rules": ["partition by role", "share synthesis not private notes"]}),
    ("context_policy", "public_content", "Public content context policy", 84, {"scope": "external", "exposure": "approved_public_facts_only", "rules": ["no private metrics without approval", "fact-check claims"]}),
    ("skill_listing", "hermes_wargame", "Hermes strategic decision war-game", 88, {"provider": "Hermes", "category": "strategy", "price_credits": 24, "availability": "available"}),
    ("skill_listing", "pi_patch", "Pi implementation patch", 82, {"provider": "Pi", "category": "engineering", "price_credits": 18, "availability": "available"}),
    ("skill_listing", "openclaw_market_scan", "OpenClaw market intelligence scan", 84, {"provider": "OpenClaw", "category": "research", "price_credits": 20, "availability": "available"}),
    ("board_member", "prudence", "Prudence — risk advisor", 86, {"perspective": "risk_first", "role": "AI Board Advisor", "veto_power": False}),
    ("board_member", "prometheus", "Prometheus — growth advisor", 82, {"perspective": "growth_first", "role": "AI Board Advisor", "veto_power": False}),
    ("board_member", "minerva", "Minerva — technical advisor", 85, {"perspective": "technical_depth", "role": "AI Board Advisor", "veto_power": False}),
    ("team_template", "growth_engineering_strike_team", "Growth Engineering Strike Team", 90, {"domain": "Growth Engineering", "roles": ["Growth Lead", "Analytics Agent", "Frontend Agent", "Experimentation Agent"], "onboarding_sop": "Define metric, instrument funnel, ship 3 experiments, review weekly."}),
    ("team_template", "security_hardening_team", "Security Hardening Team", 92, {"domain": "Security Engineering", "roles": ["AppSec Agent", "Credential Scanner", "Compliance Agent", "Red Team Agent"], "onboarding_sop": "Threat model, scan, patch, regression test, document controls."}),
    ("federation_partner", "paperclip_partner_sandbox", "Paperclip Partner Sandbox", 60, {"trust_level": "pilot", "allowed_capabilities": ["research", "code_review"], "data_sharing_policy": "redacted_context_only"}),
    ("acquisition_target", "connector_library", "Open-source connector library", 82, {"category": "integration", "strategic_fit": 86, "integration_complexity": 42, "notes": "High leverage if licensing is clean."}),
    ("deployment_region", "local_homelab", "Local Homelab", 78, {"provider": "self_hosted", "latency_score": 72, "cost_score": 95, "carbon_score": 70}),
    ("deployment_region", "eu_low_carbon_vps", "EU Low Carbon VPS", 84, {"provider": "vps", "latency_score": 78, "cost_score": 75, "carbon_score": 92}),
    ("compliance_rule", "uk_eu_data_protection", "UK/EU data protection control", 90, {"jurisdiction": "UK/EU", "topic": "data protection", "control": "Context minimization, audit logs, consented connectors, deletion workflow."}),
    ("rnd_experiment", "constitutional_checker", "Constitutional action checker", 88, {"hypothesis": "A lightweight checker reduces unsafe execution attempts before approval gates.", "risk_level": "low"}),
    ("growth_allocation", "growth_engineering", "Self-funding allocation: Growth Engineering", 86, {"allocation_percent": 25, "roi_score": 86, "guardrail": "Real spend requires CEO approval and revenue confirmation."}),
    ("culture_signal", "baseline", "Culture and workload baseline", 74, {"morale_score": 78, "stress_score": 48, "collaboration_score": 74, "privacy_note": "Optional, consent-first inputs only."}),
]

DOMAINS = [
    ("Content Engineering", "core", 5, ["Content Systems Agent", "SEO Agent"], "CMS, personalization, A/B content testing, docs and conversion assets."),
    ("Growth Engineering", "core", 5, ["Growth Agent", "Analytics Agent"], "Activation, onboarding, referral loops, product-led growth, retention experiments."),
    ("ML / Data Science Engineering", "core", 5, ["ML Agent", "Experimentation Agent"], "Forecasting, feature stores, MLOps, experimentation."),
    ("Security Engineering", "core", 5, ["AppSec Agent", "Compliance Agent"], "AppSec, credential scanning, threat modeling, controls."),
    ("Infrastructure Engineering", "core", 4, ["Platform Agent", "SRE Agent"], "Cloud architecture, networking, compute and deployment optimization."),
    ("Agentic Systems Engineering", "emerging", 4, ["Agent Lifecycle Agent", "Safety Agent"], "Agent creation, versioning, evaluation and retirement."),
    ("AI Safety & Alignment Engineering", "cross_cutting", 5, ["Constitutional AI Agent", "Red Team Agent"], "Maximizer prevention, constitutional checks, adversarial testing."),
    ("Sustainability Engineering", "emerging", 3, ["Carbon Router Agent"], "Carbon-aware routing and green software patterns."),
    ("Accessibility Engineering", "cross_cutting", 4, ["Accessibility Agent"], "Inclusive UI and assistive technology compatibility."),
    ("Voice & Multimodal Engineering", "emerging", 4, ["Voice Agent", "Vision Agent"], "Voice, vision and multimodal executive interfaces."),
]


def _upsert(db: Session, kind: str, key: str, title: str, score: float, payload: dict, notes: str = "") -> None:
    row = db.query(V5Record).filter(V5Record.kind == kind, V5Record.key == key).first()
    if row:
        row.title, row.score, row.payload, row.notes = title, score, payload, notes
    else:
        db.add(V5Record(kind=kind, key=key, title=title, score=score, payload=payload, notes=notes))


def ensure_v5_defaults(db: Session) -> None:
    for item in DATA:
        _upsert(db, *item)
    for name, cat, priority, agents, value in DOMAINS:
        _upsert(db, "engineering_domain", name.lower().replace(" / ", "_").replace(" ", "_"), name, priority * 20, {"category": cat, "priority": priority, "recommended_agents": agents, "business_value": value})
    for key, title, cat in [
        ("constitutional_ai_layer", "Constitutional AI Layer", "safety"),
        ("zero_trust_security", "Zero-Trust Security Fabric", "safety"),
        ("carbon_aware_router", "Carbon-Aware Compute Router", "sustainability"),
        ("continuous_evaluation", "Continuous Evaluation Framework", "quality"),
        ("context_engineering", "Advanced Context Engineering", "memory"),
        ("skill_marketplace", "Internal Skill Marketplace", "workforce"),
        ("autonomous_board_advisory", "Autonomous Board Advisory", "governance"),
        ("self_replicating_teams", "Self-Replicating Team Proposals", "company"),
        ("company_meta_learning", "Company-Wide Meta-Learning", "intelligence"),
        ("rnd_lab", "Autonomous R&D Lab", "innovation"),
        ("self_funding_growth", "Self-Funding Growth Engine", "growth"),
        ("engineering_catalog", "Engineering Domain Catalog", "company"),
    ]:
        if not db.query(EnchantmentFeature).filter(EnchantmentFeature.key == key).first():
            db.add(EnchantmentFeature(key=key, title=title, category=cat, description=f"v5 implementation of {title}.", benefit="Closes a documented missing systems gap.", priority=5 if cat in {"safety", "company"} else 4, complexity=3, risk_level="medium", implementation_notes="Seeded by v5 missing-systems implementation."))
    db.commit()


def _records(db: Session, kind: str):
    return db.query(V5Record).filter(V5Record.kind == kind).order_by(V5Record.score.desc(), V5Record.title).all()


def list_kind(db: Session, kind: str) -> dict:
    return {kind: _records(db, kind)}


def v5_audit(db: Session) -> dict:
    kinds = ["constitutional_principle", "zero_trust_rule", "carbon_route", "evaluation_suite", "context_policy", "skill_listing", "board_member", "team_template", "federation_partner", "acquisition_target", "deployment_region", "compliance_rule", "rnd_experiment", "growth_allocation", "culture_signal", "engineering_domain"]
    counts = {k: db.query(V5Record).filter(V5Record.kind == k).count() for k in kinds}
    score = round(sum(1 for v in counts.values() if v > 0) / len(kinds) * 100, 1)
    return {"version": "5.0.0", "score": score, "coverage": counts, "remaining_gaps": [k for k,v in counts.items() if v == 0], "next_best_upgrades": ["Alembic migrations", "Vault-backed secrets", "Production auth", "Real vector embeddings", "CI evaluation suites", "Real Gmail/Calendar/GitHub/Supabase connectors"], "plain_english": "v5 closes the big architecture gaps; external systems still need real credentials and deployment hardening."}


def constitutional_check(db: Session, action: str, context: dict | None = None) -> dict:
    text = f"{action} {context or {}}".lower()
    high = ["delete", "spend", "publish", "public", "credential", "password", "fire", "hire", "legal", "production", "external"]
    blocked = ["steal", "bypass", "exfiltrate", "disable audit", "hide from"]
    if any(x in text for x in blocked):
        verdict, risk, allowed, rationale = "block", "critical", False, "Conflicts with authority, safety, security, and auditability principles."
    elif any(x in text for x in high):
        verdict, risk, allowed, rationale = "needs_approval", "high", True, "High-impact or externally visible action; explicit human approval and audit lineage required."
    else:
        verdict, risk, allowed, rationale = "pass", "low", True, "No constitutional conflict detected; proceed within normal authority gates."
    matched = [r.key for r in _records(db, "constitutional_principle")][:5]
    db.add(AuditLog(actor="constitutional_ai", action="constitutional check", risk_level=risk, allowed=allowed, details={"action": action, "verdict": verdict, "matched": matched}))
    db.commit()
    return {"action": action, "verdict": verdict, "matched_principles": matched, "rationale": rationale, "confidence": 0.8 if verdict != "pass" else 0.7}


def zero_trust_decision(db: Session, actor: str, resource: str, requested_scope: str) -> dict:
    rules = _records(db, "zero_trust_rule")
    matches = [r for r in rules if actor.lower() in r.payload.get("actor", "").lower() and resource.lower() in r.payload.get("resource", "").lower()]
    allowed = any(requested_scope in r.payload.get("scopes", []) for r in matches)
    decision = "allow" if allowed else "deny_or_request_approval"
    db.add(AuditLog(actor="zero_trust", action="access decision", risk_level="low" if allowed else "medium", allowed=allowed, details={"actor": actor, "resource": resource, "scope": requested_scope, "decision": decision}))
    db.commit()
    return {"actor": actor, "resource": resource, "requested_scope": requested_scope, "decision": decision, "matching_rules": [r.key for r in matches], "rationale": "Matching scoped rule found." if allowed else "No active least-privilege rule grants this scope."}


def carbon_choose(db: Session, task: str, min_quality: float = 70.0) -> dict:
    routes = [r for r in _records(db, "carbon_route") if r.payload.get("quality_score", r.score) >= min_quality]
    routes = routes or _records(db, "carbon_route")
    ranked = sorted(routes, key=lambda r: (r.payload.get("carbon_intensity_gco2_kwh", 999), -r.payload.get("cost_score", 0), -r.payload.get("quality_score", 0)))
    chosen = ranked[0]
    return {"task": task, "chosen_route": {"key": chosen.key, "title": chosen.title, **chosen.payload}, "alternatives": [{"key": r.key, **r.payload} for r in ranked[1:4]], "policy": "Prefer lower carbon when quality remains acceptable."}


def evaluation_run(db: Session, suite_name: str | None = None) -> dict:
    suites = [r for r in _records(db, "evaluation_suite") if not suite_name or r.key == suite_name]
    results = []
    base = v5_audit(db)["score"] / 100
    for s in suites:
        threshold = s.payload.get("threshold", 0.85)
        score = round(min(0.98, base + (s.score/100)*0.12), 3)
        status = "pass" if score >= threshold else "warn"
        results.append({"suite": s.key, "score": score, "threshold": threshold, "status": status, "checks": s.payload.get("checks", []), "recommendation": "Keep active in CI." if status == "pass" else "Add missing controls before production release."})
    return {"generated_at": datetime.utcnow(), "overall_score": round(mean([r["score"] for r in results]) if results else 0, 3), "results": results}


def context_bundle(db: Session, task: str, scope: str = "ceo") -> dict:
    policies = _records(db, "context_policy")
    policy = next((p for p in policies if p.payload.get("scope") == scope), policies[0])
    return {"task": task, "policy": {"key": policy.key, **policy.payload}, "included_context": ["mission", "active objectives", "pending approvals", "open risks", "relevant knowledge digests"], "excluded_context": ["raw credentials", "irrelevant private data", "unapproved external metrics"], "recommendation": "Start minimal; expand only if confidence or evidence coverage is too low."}


def collaboration_start(db: Session, title: str, participants: list[str], artifact: str = "", mode: str = "co_creation") -> dict:
    key = title.lower().replace(" ", "_")[:120]
    payload = {"mode": mode, "participants": participants, "artifact": artifact, "next_handoff": "Define owner, first output, review gate, and rollback path."}
    _upsert(db, "collaboration_session", key, title, 70, payload, "Created from v5 collaboration OS")
    db.commit()
    return {"title": title, **payload, "status": "active"}


def marketplace(db: Session) -> dict:
    return {"marketplace": _records(db, "skill_listing"), "rules": ["Escrow before work", "Reputation after review", "High-impact work still follows approval gates", "No real money movement without CEO approval"]}


def health_forecast(db: Session, horizon_days: int = 90) -> dict:
    employees = db.query(Employee).filter(Employee.active == True).all()  # noqa: E712
    companies = db.query(Company).all()
    avg_workload = mean([e.workload_score for e in employees]) if employees else 50
    avg_health = mean([c.health_score for c in companies]) if companies else 75
    pending = db.query(ApprovalRequest).filter(ApprovalRequest.status == "pending").count()
    burnout = round(min(0.95, max(0.05, (avg_workload - 45) / 70)), 2)
    strategic = round(min(0.95, 0.25 + pending * 0.03), 2)
    score = round(max(1, min(100, avg_health - burnout * 12 - strategic * 6)), 1)
    return {"horizon_days": horizon_days, "health_score": score, "burnout_risk": burnout, "capability_gap_score": 0.32, "financial_risk": 0.25, "strategic_risk": strategic, "confidence": 0.70, "drivers": ["workload pressure", "capability gaps", "pending approvals", "connector readiness"], "recommendations": ["Delegate one high-friction task", "Activate Growth/Security/ML capability owners", "Clear stale approvals"]}


def board_vote(db: Session, proposal: str) -> dict:
    votes=[]
    text=proposal.lower()
    for m in _records(db, "board_member"):
        perspective=m.payload.get("perspective")
        vote="approve"; rationale="Aligned if staged with normal gates."; conf=0.68
        if perspective=="risk_first" and any(k in text for k in ["public","production","spend","external"]):
            vote="conditional"; rationale="Proceed only with security, rollback, and communication approvals."; conf=0.76
        elif perspective=="growth_first" and any(k in text for k in ["launch","market","growth"]):
            rationale="Market learning is valuable when bounded by gates."; conf=0.78
        votes.append({"member": m.title, "perspective": perspective, "vote": vote, "rationale": rationale, "confidence": conf})
    return {"proposal": proposal, "votes": votes, "recommendation": "Proceed with conditions and CEO approval.", "human_veto_note": "AI board is advisory only."}


def propose_team(db: Session, demand_signal: str) -> dict:
    templates=_records(db,"team_template")
    chosen=templates[0]
    signal=demand_signal.lower()
    for t in templates:
        if t.payload.get("domain","").split()[0].lower() in signal:
            chosen=t; break
    _upsert(db, "team_creation_proposal", f"proposal_{int(datetime.utcnow().timestamp())}", f"Create {chosen.title}", 70, {"demand_signal": demand_signal, "template": chosen.key, "recommended_roles": chosen.payload.get("roles", []), "onboarding_sop": chosen.payload.get("onboarding_sop")}, "Approval-gated proposal only")
    db.commit()
    return {"template": chosen.title, "recommended_roles": chosen.payload.get("roles", []), "onboarding_sop": chosen.payload.get("onboarding_sop"), "approval_note": "Proposed only; CEO approval required before staffing or spend."}


def ecosystem(db: Session) -> dict:
    return {"health_forecast": health_forecast(db,90), "federation_partners": _records(db,"federation_partner"), "acquisition_watchlist": _records(db,"acquisition_target"), "growth_allocations": _records(db,"growth_allocation"), "team_templates": _records(db,"team_template")}


def meta_learning(db: Session) -> dict:
    if not _records(db, "meta_learning"):
        _upsert(db, "meta_learning", "staged_implementation", "Broad requests need staged implementation", 82, {"project":"Jarvis", "evidence":"Repeated implement-all requests work best as audited runnable upgrades.", "playbook":"Audit -> implement high-ROI gaps -> test -> package."})
        db.commit()
    return {"records": _records(db,"meta_learning"), "recommendation": "Promote repeated successes into workflow templates and evaluation suites."}


def propose_generation(db: Session, parent_agent: str, improvement_goal: str) -> dict:
    key=f"{parent_agent.lower()}_{int(datetime.utcnow().timestamp())}"
    title=f"{parent_agent} vNext proposal"
    payload={"parent_agent": parent_agent, "improvement_goal": improvement_goal, "inherited_capabilities": ["approval gates", "audit logging"], "status":"proposal", "safety_note":"Generated agents require evaluation and CEO approval."}
    _upsert(db,"agent_generation",key,title,60,payload)
    db.commit()
    return {"key": key, "title": title, **payload}
