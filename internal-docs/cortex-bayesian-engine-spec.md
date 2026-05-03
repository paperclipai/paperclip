# Cortex Bayesian Decision Engine — Technical Architecture

**Product:** Cortex Intelligence Layer
**Status:** Architecture Spec — Design Draft
**Date:** 2026-03-13 (repositioned from AgencyOS to Cortex on 2026-04-27)
**Sources:** Google Research (Bayesian Teaching, Nature Communications 2025), system design analysis
**Author:** Coda (WBIT)

> **Note on code samples:** Original draft used Python (FastAPI/SQLAlchemy style). Cortex's actual stack is TypeScript (`server/src/services/*.ts`, pnpm workspaces). Treat inline code as pseudocode — algorithms and SQL transfer cleanly; file paths and types need translating to TS during implementation.

---

## 1. Executive Summary

This document defines the architecture for Cortex's **Bayesian Decision Engine** — a probabilistic inference layer that maintains beliefs, scores candidate actions, simulates outcomes, and learns from results. It replaces deterministic keyword-based routing with belief-driven decisions.

**Naive routing:** User → IntentClassifier (keyword/label) → single department → execute
**Cortex Bayesian routing:** User → Evidence Collection → Bayesian Intent → Candidate Actions → Simulation Scoring → Confidence-Based Execution → Outcome Learning

This transforms Cortex from a task orchestrator into a **decision engine** that asks not "what should I do?" but "what is most likely to succeed?"

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        USER REQUEST                              │
└──────────────────────────┬──────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 1: EVIDENCE COLLECTOR                                     │
│  Gathers: message, conversation history, CRM state,             │
│  user belief profile, time context, recent activity              │
└──────────────────────────┬──────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 2: BAYESIAN INTENT ENGINE                                 │
│  Outputs probability distribution over intents/departments       │
│  {sales: 0.55, customer: 0.30, back_office: 0.15}              │
└──────────────────────────┬──────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 3: ACTION CANDIDATE GENERATOR                             │
│  Top department(s) propose 3-5 candidate actions                 │
│  Each action: type, params, estimated impact                     │
└──────────────────────────┬──────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 4: SIMULATION & SCORING ("Shadow Boardroom")              │
│  Each candidate scored by department evaluators:                 │
│  - Sales: conversion impact?                                     │
│  - Customer: satisfaction risk?                                  │
│  - Operations: workflow sound?                                   │
│  - Compliance: policy safe?                                      │
│  Scores combined with Bayesian arbiter                           │
└──────────────────────────┬──────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 5: CONFIDENCE ROUTER                                      │
│  High confidence (>0.8) → auto-execute (Gemma 9B, local)       │
│  Medium (0.5-0.8) → draft for approval (Gemini, cloud)          │
│  Low (<0.5) → ask clarification OR escalate (Claude, premium)   │
└──────────────────────────┬──────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 6: EXECUTION                                              │
│  Delegated Mode: Action Proposal → Approval Inbox → Execute     │
│  OR auto-execute based on confidence + policy                    │
└──────────────────────────┬──────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 7: OUTCOME LOGGER + BELIEF UPDATER                        │
│  Log: action taken, result, user feedback, overrides            │
│  Update: user belief profile, department priors, tool priors    │
│  Feed: training data pipeline (Qwen/Gemma fine-tuning)          │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Database Schema

### New Tables (added to Cortex Neon DB)

```sql
-- ============================================================
-- BELIEF STATE: Probabilistic user/entity profiles
-- ============================================================
CREATE TABLE belief_state (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          TEXT NOT NULL,
    entity_type     TEXT NOT NULL,        -- 'user', 'contact', 'deal', 'org'
    entity_id       TEXT NOT NULL,        -- user_id, contact_id, deal_id, etc.
    belief_key      TEXT NOT NULL,        -- 'primary_role', 'comm_pref', 'price_sensitivity'
    probabilities   JSONB NOT NULL,       -- {"email": 0.8, "sms": 0.12, "portal": 0.08}
    confidence      FLOAT DEFAULT 0.5,    -- overall confidence in this belief
    evidence_count  INT DEFAULT 0,        -- number of observations
    last_evidence   TEXT,                 -- description of last update source
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now(),

    UNIQUE(org_id, entity_type, entity_id, belief_key)
);

CREATE INDEX idx_belief_entity ON belief_state(org_id, entity_type, entity_id);
CREATE INDEX idx_belief_key ON belief_state(org_id, belief_key);

-- ============================================================
-- INTENT SCORES: Per-request probability distributions
-- ============================================================
CREATE TABLE intent_scores (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          TEXT NOT NULL,
    request_id      UUID NOT NULL,        -- links to the user's request
    user_id         TEXT NOT NULL,
    message_text    TEXT NOT NULL,
    intent_probs    JSONB NOT NULL,       -- {"sales_admin": 0.55, "customer": 0.30, ...}
    evidence_used   JSONB,                -- what signals contributed to scoring
    selected_dept   TEXT NOT NULL,        -- which department was chosen
    was_correct     BOOLEAN,              -- set after outcome (for learning)
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_intent_org ON intent_scores(org_id, created_at DESC);
CREATE INDEX idx_intent_correct ON intent_scores(org_id, was_correct);

-- ============================================================
-- ACTION CANDIDATES: Proposed actions per request
-- ============================================================
CREATE TABLE action_candidates (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id      UUID NOT NULL,
    org_id          TEXT NOT NULL,
    action_type     TEXT NOT NULL,        -- 'send_email', 'create_task', 'update_deal', etc.
    department      TEXT NOT NULL,        -- which dept proposed this
    params_json     JSONB,                -- action parameters
    
    -- Scoring breakdown
    intent_score    FLOAT,                -- from Bayesian intent engine
    context_score   FLOAT,                -- CRM context match
    success_score   FLOAT,                -- predicted success likelihood
    policy_score    FLOAT,                -- compliance/safety score
    final_score     FLOAT,                -- weighted combination
    
    -- Simulation results
    sim_success_prob    FLOAT,            -- simulated probability of success
    sim_risk_level      TEXT,             -- 'low', 'medium', 'high'
    sim_reasoning       TEXT,             -- brief explanation of simulation result
    
    was_selected    BOOLEAN DEFAULT false,
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_candidates_request ON action_candidates(request_id);
CREATE INDEX idx_candidates_selected ON action_candidates(org_id, was_selected, created_at DESC);

-- ============================================================
-- OUTCOMES: What actually happened (the learning loop)
-- ============================================================
CREATE TABLE action_outcomes (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id          UUID NOT NULL,
    org_id              TEXT NOT NULL,
    chosen_action_id    UUID REFERENCES action_candidates(id),
    action_type         TEXT NOT NULL,
    
    -- Result signals
    result              TEXT NOT NULL,     -- 'success', 'partial', 'failed', 'overridden'
    success_flag        BOOLEAN,
    user_override       TEXT,              -- what the user changed (if anything)
    user_feedback       TEXT,              -- explicit feedback
    
    -- Downstream signals (filled async as events come in)
    client_replied      BOOLEAN,           -- did the recipient respond?
    reply_time_hours    FLOAT,             -- how quickly?
    deal_progressed     BOOLEAN,           -- did the deal move forward?
    task_completed      BOOLEAN,           -- was the follow-up task done?
    
    -- Belief updates triggered
    updated_beliefs     JSONB,             -- which beliefs were updated and how
    
    created_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_outcomes_org ON action_outcomes(org_id, created_at DESC);
CREATE INDEX idx_outcomes_action ON action_outcomes(action_type, success_flag);
CREATE INDEX idx_outcomes_learning ON action_outcomes(org_id, result, created_at DESC);

-- ============================================================
-- PGVECTOR: Intent embeddings for semantic similarity
-- ============================================================
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE intent_embeddings (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          TEXT NOT NULL,
    intent_label    TEXT NOT NULL,         -- 'send_proposal', 'follow_up', 'check_status'
    department      TEXT NOT NULL,
    embedding       vector(384),           -- sentence-transformer embedding dimension
    example_text    TEXT NOT NULL,          -- the message that produced this embedding
    frequency       INT DEFAULT 1,         -- how often this intent appears
    created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_intent_emb ON intent_embeddings USING ivfflat (embedding vector_cosine_ops);
CREATE INDEX idx_intent_dept ON intent_embeddings(org_id, department);
```

---

## 4. Core Services

### 4.1 Evidence Collector

```python
# cortex/services/evidence_collector.py  (illustrative — Cortex is TS)

from dataclasses import dataclass, field
from datetime import datetime

@dataclass
class InferenceContext:
    """All evidence signals bundled for Bayesian inference."""
    
    # Message
    message: str
    message_embedding: list[float] | None = None
    
    # User context
    user_id: str = ""
    org_id: str = ""
    user_beliefs: dict[str, dict] = field(default_factory=dict)
    
    # Conversation
    recent_messages: list[dict] = field(default_factory=list)  # last 5 turns
    session_intents: list[str] = field(default_factory=list)   # intents so far in session
    
    # CRM state
    active_deals: list[dict] = field(default_factory=list)
    open_tickets: list[dict] = field(default_factory=list)
    pending_tasks: list[dict] = field(default_factory=list)
    recent_activity: list[dict] = field(default_factory=list)  # last 7 days
    
    # Temporal
    timestamp: datetime = field(default_factory=datetime.utcnow)
    day_of_week: int = 0
    hour_of_day: int = 0
    
    # Metadata
    evidence_sources: list[str] = field(default_factory=list)


class EvidenceCollector:
    """Gathers all available evidence for Bayesian inference."""
    
    def __init__(self, db, crm_adapter, embedding_model=None):
        self.db = db
        self.crm = crm_adapter
        self.embedder = embedding_model  # local sentence-transformers model
    
    async def collect(self, message: str, user_id: str, org_id: str, 
                      conversation_history: list[dict] = None) -> InferenceContext:
        """Collect all evidence signals for a request."""
        
        ctx = InferenceContext(
            message=message,
            user_id=user_id,
            org_id=org_id,
            timestamp=datetime.utcnow(),
        )
        ctx.day_of_week = ctx.timestamp.weekday()
        ctx.hour_of_day = ctx.timestamp.hour
        
        # 1. Message embedding (local model, fast)
        if self.embedder:
            ctx.message_embedding = await self.embedder.encode(message)
            ctx.evidence_sources.append("embedding")
        
        # 2. User belief profile
        ctx.user_beliefs = await self._load_beliefs(org_id, "user", user_id)
        if ctx.user_beliefs:
            ctx.evidence_sources.append("user_beliefs")
        
        # 3. Conversation history (last 5 turns)
        if conversation_history:
            ctx.recent_messages = conversation_history[-5:]
            ctx.session_intents = [m.get("intent", "") for m in ctx.recent_messages if m.get("intent")]
            ctx.evidence_sources.append("conversation")
        
        # 4. CRM state (parallel fetches)
        try:
            ctx.active_deals = await self.crm.get_active_deals(org_id, limit=5)
            ctx.open_tickets = await self.crm.get_open_tickets(org_id, limit=5)
            ctx.pending_tasks = await self.crm.get_pending_tasks(org_id, user_id, limit=5)
            ctx.recent_activity = await self.crm.get_recent_activity(org_id, days=7, limit=10)
            ctx.evidence_sources.append("crm")
        except Exception:
            pass  # CRM unavailable — proceed with other evidence
        
        return ctx
    
    async def _load_beliefs(self, org_id: str, entity_type: str, 
                             entity_id: str) -> dict[str, dict]:
        """Load belief state for an entity."""
        rows = await self.db.fetch_all(
            "SELECT belief_key, probabilities, confidence FROM belief_state "
            "WHERE org_id = $1 AND entity_type = $2 AND entity_id = $3",
            org_id, entity_type, entity_id
        )
        return {r["belief_key"]: {
            "probs": r["probabilities"],
            "confidence": r["confidence"]
        } for r in rows}
```

### 4.2 Bayesian Intent Engine

```python
# cortex/services/bayesian_intent.py

import math
from dataclasses import dataclass

DEPARTMENTS = ["sales_admin", "customer", "back_office"]

# Default priors (uniform-ish, slightly biased toward sales for business context)
DEFAULT_PRIORS = {
    "sales_admin": 0.40,
    "customer": 0.35,
    "back_office": 0.25,
}

# Keyword likelihoods — P(keyword | department)
# These bootstrap the system before we have enough data for learned priors
KEYWORD_LIKELIHOODS = {
    "sales_admin": {
        "proposal": 0.9, "deal": 0.85, "lead": 0.8, "follow up": 0.7,
        "prospect": 0.85, "pipeline": 0.8, "close": 0.75, "quote": 0.85,
        "revenue": 0.7, "commission": 0.6, "pitch": 0.8, "outreach": 0.75,
    },
    "customer": {
        "ticket": 0.9, "complaint": 0.85, "support": 0.8, "issue": 0.75,
        "refund": 0.85, "bug": 0.7, "help": 0.6, "problem": 0.7,
        "feedback": 0.65, "satisfaction": 0.7, "resolve": 0.8,
    },
    "back_office": {
        "invoice": 0.9, "report": 0.8, "budget": 0.85, "payroll": 0.9,
        "expense": 0.85, "accounting": 0.9, "tax": 0.85, "audit": 0.8,
        "compliance": 0.75, "schedule": 0.5, "document": 0.6, "file": 0.5,
    },
}


@dataclass
class IntentResult:
    """Probability distribution over departments + metadata."""
    probabilities: dict[str, float]
    top_intent: str
    confidence: float
    evidence_used: list[str]
    requires_clarification: bool


class BayesianIntentEngine:
    """Replaces the deterministic IntentClassifier with probabilistic inference."""
    
    def __init__(self, db=None, embedding_index=None):
        self.db = db
        self.embedding_index = embedding_index  # pgvector index
    
    async def classify(self, context: 'InferenceContext') -> IntentResult:
        """
        Compute P(department | evidence) using Bayes' rule.
        
        P(dept | evidence) ∝ P(evidence | dept) × P(dept)
        
        Evidence signals combined multiplicatively (naive Bayes assumption).
        """
        evidence_used = []
        
        # --- PRIOR ---
        # Start with learned priors if available, else defaults
        priors = await self._get_priors(context.org_id, context.user_id)
        evidence_used.append("prior")
        
        # --- LIKELIHOOD FROM MESSAGE KEYWORDS ---
        keyword_likelihood = self._keyword_likelihood(context.message)
        evidence_used.append("keywords")
        
        # --- LIKELIHOOD FROM EMBEDDINGS (if available) ---
        embedding_likelihood = None
        if context.message_embedding and self.embedding_index:
            embedding_likelihood = await self._embedding_likelihood(
                context.message_embedding, context.org_id
            )
            evidence_used.append("embeddings")
        
        # --- LIKELIHOOD FROM CRM CONTEXT ---
        crm_likelihood = self._crm_likelihood(context)
        if any(v != 1.0 for v in crm_likelihood.values()):
            evidence_used.append("crm_context")
        
        # --- LIKELIHOOD FROM CONVERSATION HISTORY ---
        session_likelihood = self._session_likelihood(context)
        if any(v != 1.0 for v in session_likelihood.values()):
            evidence_used.append("session_history")
        
        # --- LIKELIHOOD FROM USER BELIEFS ---
        belief_likelihood = self._belief_likelihood(context)
        if any(v != 1.0 for v in belief_likelihood.values()):
            evidence_used.append("user_beliefs")
        
        # --- COMBINE: posterior ∝ prior × likelihood_1 × likelihood_2 × ... ---
        posteriors = {}
        for dept in DEPARTMENTS:
            posterior = priors.get(dept, 0.33)
            posterior *= keyword_likelihood.get(dept, 1.0)
            if embedding_likelihood:
                posterior *= embedding_likelihood.get(dept, 1.0)
            posterior *= crm_likelihood.get(dept, 1.0)
            posterior *= session_likelihood.get(dept, 1.0)
            posterior *= belief_likelihood.get(dept, 1.0)
            posteriors[dept] = posterior
        
        # --- NORMALIZE ---
        total = sum(posteriors.values())
        if total > 0:
            posteriors = {k: v / total for k, v in posteriors.items()}
        else:
            posteriors = DEFAULT_PRIORS.copy()
        
        # --- RESULT ---
        top_dept = max(posteriors, key=posteriors.get)
        confidence = posteriors[top_dept]
        
        # If confidence is low, flag for clarification
        requires_clarification = confidence < 0.45
        
        return IntentResult(
            probabilities=posteriors,
            top_intent=top_dept,
            confidence=confidence,
            evidence_used=evidence_used,
            requires_clarification=requires_clarification,
        )
    
    async def _get_priors(self, org_id: str, user_id: str) -> dict[str, float]:
        """Load learned priors from historical intent data."""
        if not self.db:
            return DEFAULT_PRIORS.copy()
        
        # Count recent correct intents for this user
        rows = await self.db.fetch_all(
            "SELECT selected_dept, COUNT(*) as cnt FROM intent_scores "
            "WHERE org_id = $1 AND user_id = $2 AND was_correct = true "
            "AND created_at > now() - interval '30 days' "
            "GROUP BY selected_dept",
            org_id, user_id
        )
        
        if not rows:
            return DEFAULT_PRIORS.copy()
        
        total = sum(r["cnt"] for r in rows)
        # Laplace smoothing to prevent zero priors
        learned = {}
        for dept in DEPARTMENTS:
            count = next((r["cnt"] for r in rows if r["selected_dept"] == dept), 0)
            learned[dept] = (count + 1) / (total + len(DEPARTMENTS))
        
        return learned
    
    def _keyword_likelihood(self, message: str) -> dict[str, float]:
        """P(message | department) estimated via keyword matching."""
        msg_lower = message.lower()
        likelihoods = {}
        
        for dept in DEPARTMENTS:
            score = 1.0
            keywords = KEYWORD_LIKELIHOODS.get(dept, {})
            match_count = 0
            for kw, strength in keywords.items():
                if kw in msg_lower:
                    score *= (1.0 + strength)  # boost
                    match_count += 1
            
            if match_count == 0:
                score = 0.5  # no evidence = slight penalty
            
            likelihoods[dept] = score
        
        return likelihoods
    
    async def _embedding_likelihood(self, embedding: list[float], 
                                      org_id: str) -> dict[str, float]:
        """Semantic similarity to known intent embeddings via pgvector."""
        # Find top 5 nearest intent embeddings
        rows = await self.db.fetch_all(
            "SELECT department, 1 - (embedding <=> $1::vector) as similarity "
            "FROM intent_embeddings WHERE org_id = $2 "
            "ORDER BY embedding <=> $1::vector LIMIT 5",
            embedding, org_id
        )
        
        likelihoods = {dept: 1.0 for dept in DEPARTMENTS}
        for row in rows:
            dept = row["department"]
            sim = max(row["similarity"], 0.01)
            likelihoods[dept] *= (1.0 + sim * 2)  # similarity boosts likelihood
        
        return likelihoods
    
    def _crm_likelihood(self, context: 'InferenceContext') -> dict[str, float]:
        """Adjust likelihoods based on CRM state."""
        likelihoods = {dept: 1.0 for dept in DEPARTMENTS}
        
        # Active deals boost sales probability
        if context.active_deals:
            likelihoods["sales_admin"] *= 1.0 + (0.1 * min(len(context.active_deals), 5))
        
        # Open tickets boost customer probability
        if context.open_tickets:
            likelihoods["customer"] *= 1.0 + (0.15 * min(len(context.open_tickets), 5))
        
        # Pending tasks boost back office
        if context.pending_tasks:
            likelihoods["back_office"] *= 1.0 + (0.1 * min(len(context.pending_tasks), 5))
        
        return likelihoods
    
    def _session_likelihood(self, context: 'InferenceContext') -> dict[str, float]:
        """If the session has been about sales, next message probably is too."""
        likelihoods = {dept: 1.0 for dept in DEPARTMENTS}
        
        if not context.session_intents:
            return likelihoods
        
        # Count dept frequency in this session
        for intent in context.session_intents[-3:]:  # last 3 turns
            if intent in likelihoods:
                likelihoods[intent] *= 1.3  # session continuity boost
        
        return likelihoods
    
    def _belief_likelihood(self, context: 'InferenceContext') -> dict[str, float]:
        """Adjust based on stored user belief profile."""
        likelihoods = {dept: 1.0 for dept in DEPARTMENTS}
        
        role_belief = context.user_beliefs.get("primary_role", {}).get("probs", {})
        if role_belief:
            for dept, prob in role_belief.items():
                if dept in likelihoods:
                    likelihoods[dept] *= (1.0 + prob * 0.5)  # gentle boost
        
        return likelihoods
```

### 4.3 Action Candidate Generator

```python
# cortex/services/action_generator.py

from dataclasses import dataclass


@dataclass
class ActionCandidate:
    """A proposed action with metadata for simulation scoring."""
    action_type: str          # 'send_email', 'create_task', 'update_deal', etc.
    department: str           # proposing department
    description: str          # human-readable description
    params: dict              # action parameters
    intent_score: float       # from Bayesian intent engine
    requires_approval: bool   # based on action type + confidence


# Action templates per department
ACTION_TEMPLATES = {
    "sales_admin": [
        "send_email", "create_task", "update_deal_stage", "generate_proposal",
        "schedule_follow_up", "assign_to_rep", "send_sms", "log_activity",
    ],
    "customer": [
        "create_ticket", "send_reply", "escalate", "update_ticket_status",
        "schedule_callback", "issue_refund", "send_resolution",
    ],
    "back_office": [
        "generate_invoice", "create_report", "schedule_task", "update_records",
        "send_document", "create_reminder", "archive_file",
    ],
}


class ActionGenerator:
    """Generates candidate actions for a given intent distribution."""
    
    def __init__(self, engines: dict, llm_client=None):
        self.engines = engines    # department engines
        self.llm = llm_client    # for LLM-driven candidate generation
    
    async def generate(self, context: 'InferenceContext', 
                        intent_result: 'IntentResult',
                        max_candidates: int = 5) -> list[ActionCandidate]:
        """Generate candidate actions from top departments."""
        candidates = []
        
        # Get top 2 departments (or 1 if confidence is very high)
        sorted_depts = sorted(
            intent_result.probabilities.items(),
            key=lambda x: x[1],
            reverse=True
        )
        
        # High confidence: only top department proposes
        # Lower confidence: top 2 departments propose
        num_depts = 1 if intent_result.confidence > 0.75 else 2
        
        for dept, prob in sorted_depts[:num_depts]:
            engine = self.engines.get(dept)
            if not engine:
                continue
            
            # Each department proposes up to 3 actions
            dept_candidates = await engine.propose_actions(
                context.message, context, max_actions=3
            )
            
            for candidate in dept_candidates:
                candidate.intent_score = prob
                candidate.department = dept
                candidates.append(candidate)
        
        # Sort by intent score, take top N
        candidates.sort(key=lambda c: c.intent_score, reverse=True)
        return candidates[:max_candidates]
```

### 4.4 Simulation Scorer ("Shadow Boardroom")

```python
# cortex/services/simulation_scorer.py

from dataclasses import dataclass


@dataclass
class SimulationResult:
    """Scored action candidate after simulation."""
    candidate: 'ActionCandidate'
    
    # Component scores (0.0 - 1.0)
    intent_confidence: float      # from Bayesian intent engine
    context_match: float          # how well does action match CRM state
    success_likelihood: float     # estimated probability of success
    policy_safety: float          # compliance/permission score
    user_satisfaction: float      # estimated user satisfaction
    
    # Composite
    final_score: float
    risk_level: str               # 'low', 'medium', 'high'
    reasoning: str                # brief explanation
    
    # Execution recommendation
    execution_mode: str           # 'auto', 'draft', 'approval', 'clarify'


# Scoring weights
SCORING_WEIGHTS = {
    "intent_confidence": 0.25,
    "context_match": 0.20,
    "success_likelihood": 0.25,
    "policy_safety": 0.15,
    "user_satisfaction": 0.15,
}

# Actions that always require approval (regardless of confidence)
HIGH_RISK_ACTIONS = {
    "send_email", "send_sms", "issue_refund", "generate_proposal",
    "update_deal_stage", "escalate",
}

# Actions safe for auto-execution
LOW_RISK_ACTIONS = {
    "create_task", "log_activity", "create_reminder", "schedule_task",
    "update_records", "archive_file",
}


class SimulationScorer:
    """
    Scores candidate actions using multiple evaluator perspectives.
    
    This is the "shadow boardroom" — each evaluator represents a
    department head's perspective on whether this action is a good idea.
    """
    
    def __init__(self, db=None, llm_client=None):
        self.db = db
        self.llm = llm_client  # optional: use LLM for complex simulation
    
    async def score_candidates(self, candidates: list['ActionCandidate'],
                                 context: 'InferenceContext',
                                 intent_result: 'IntentResult') -> list[SimulationResult]:
        """Score all candidates and return sorted by final_score."""
        
        results = []
        for candidate in candidates:
            result = await self._score_one(candidate, context, intent_result)
            results.append(result)
        
        # Sort by final score descending
        results.sort(key=lambda r: r.final_score, reverse=True)
        return results
    
    async def _score_one(self, candidate: 'ActionCandidate',
                          context: 'InferenceContext',
                          intent_result: 'IntentResult') -> SimulationResult:
        """Score a single candidate action."""
        
        # --- Intent confidence (from Bayesian engine) ---
        intent_confidence = candidate.intent_score
        
        # --- Context match (CRM state alignment) ---
        context_match = self._score_context_match(candidate, context)
        
        # --- Success likelihood (from historical outcomes) ---
        success_likelihood = await self._score_success_likelihood(
            candidate, context
        )
        
        # --- Policy safety ---
        policy_safety = self._score_policy(candidate, context)
        
        # --- User satisfaction estimate ---
        user_satisfaction = self._score_user_satisfaction(candidate, context)
        
        # --- Composite score ---
        final_score = (
            intent_confidence * SCORING_WEIGHTS["intent_confidence"]
            + context_match * SCORING_WEIGHTS["context_match"]
            + success_likelihood * SCORING_WEIGHTS["success_likelihood"]
            + policy_safety * SCORING_WEIGHTS["policy_safety"]
            + user_satisfaction * SCORING_WEIGHTS["user_satisfaction"]
        )
        
        # --- Risk assessment ---
        risk_level = "low"
        if policy_safety < 0.5 or success_likelihood < 0.3:
            risk_level = "high"
        elif policy_safety < 0.7 or success_likelihood < 0.5:
            risk_level = "medium"
        
        # --- Execution mode ---
        execution_mode = self._determine_execution_mode(
            candidate, final_score, risk_level, intent_result.confidence
        )
        
        # --- Reasoning ---
        reasoning = self._generate_reasoning(
            candidate, intent_confidence, context_match,
            success_likelihood, policy_safety
        )
        
        return SimulationResult(
            candidate=candidate,
            intent_confidence=intent_confidence,
            context_match=context_match,
            success_likelihood=success_likelihood,
            policy_safety=policy_safety,
            user_satisfaction=user_satisfaction,
            final_score=final_score,
            risk_level=risk_level,
            reasoning=reasoning,
            execution_mode=execution_mode,
        )
    
    def _score_context_match(self, candidate: 'ActionCandidate',
                              context: 'InferenceContext') -> float:
        """How well does this action match the current CRM state?"""
        score = 0.5  # neutral baseline
        
        action = candidate.action_type
        
        # Email follow-up scores higher if there's an active deal with no recent activity
        if action in ("send_email", "send_sms"):
            if context.active_deals:
                # Check for stale deals (no activity)
                score += 0.2
            if context.recent_activity:
                # Recent activity means context is fresh
                score += 0.1
        
        # Task creation scores higher if there are pending items
        if action == "create_task":
            score += 0.15  # always somewhat relevant
        
        # Proposal generation scores higher with active deals
        if action == "generate_proposal" and context.active_deals:
            score += 0.3
        
        # Ticket actions score higher with open tickets
        if action in ("create_ticket", "send_reply", "update_ticket_status"):
            if context.open_tickets:
                score += 0.25
        
        return min(score, 1.0)
    
    async def _score_success_likelihood(self, candidate: 'ActionCandidate',
                                          context: 'InferenceContext') -> float:
        """Estimate success probability from historical outcomes."""
        if not self.db:
            return 0.5  # no data = uncertain
        
        # Look up historical success rate for this action type in this org
        row = await self.db.fetch_one(
            "SELECT COUNT(*) FILTER (WHERE success_flag = true) as successes, "
            "COUNT(*) as total FROM action_outcomes "
            "WHERE org_id = $1 AND action_type = $2 "
            "AND created_at > now() - interval '90 days'",
            context.org_id, candidate.action_type
        )
        
        if not row or row["total"] < 5:
            return 0.5  # not enough data
        
        # Laplace smoothing
        return (row["successes"] + 1) / (row["total"] + 2)
    
    def _score_policy(self, candidate: 'ActionCandidate',
                       context: 'InferenceContext') -> float:
        """Check compliance and permission constraints."""
        score = 1.0
        
        # External-facing actions get a safety penalty
        if candidate.action_type in HIGH_RISK_ACTIONS:
            score *= 0.7
        
        # Check user role beliefs
        role_belief = context.user_beliefs.get("primary_role", {}).get("probs", {})
        if role_belief:
            # If action requires sales permission but user is probably ops...
            if candidate.department == "sales_admin" and role_belief.get("sales_admin", 0) < 0.3:
                score *= 0.6  # mismatch penalty
        
        return score
    
    def _score_user_satisfaction(self, candidate: 'ActionCandidate',
                                  context: 'InferenceContext') -> float:
        """Estimate whether the user will be happy with this action."""
        score = 0.6  # baseline
        
        # Check communication preference beliefs
        comm_pref = context.user_beliefs.get("comm_pref", {}).get("probs", {})
        if comm_pref:
            if candidate.action_type == "send_email" and comm_pref.get("email", 0) > 0.5:
                score += 0.2
            elif candidate.action_type == "send_sms" and comm_pref.get("sms", 0) > 0.5:
                score += 0.2
        
        # Check decision speed beliefs
        speed_pref = context.user_beliefs.get("decision_speed", {}).get("probs", {})
        if speed_pref:
            if speed_pref.get("immediate", 0) > 0.6 and candidate.action_type in LOW_RISK_ACTIONS:
                score += 0.15  # user likes fast action, this is safe
        
        return min(score, 1.0)
    
    def _determine_execution_mode(self, candidate: 'ActionCandidate',
                                    final_score: float, risk_level: str,
                                    intent_confidence: float) -> str:
        """Decide how to execute based on confidence and risk."""
        
        # Always require approval for high-risk actions
        if candidate.action_type in HIGH_RISK_ACTIONS:
            if final_score > 0.8 and intent_confidence > 0.85:
                return "draft"  # high confidence, but still show draft
            return "approval"
        
        # Low-risk actions with high confidence → auto-execute
        if candidate.action_type in LOW_RISK_ACTIONS:
            if final_score > 0.7 and intent_confidence > 0.7:
                return "auto"
            return "draft"
        
        # Everything else
        if risk_level == "high":
            return "approval"
        elif final_score > 0.75:
            return "draft"
        elif final_score < 0.4:
            return "clarify"
        else:
            return "approval"
    
    def _generate_reasoning(self, candidate, intent_conf, context_match,
                             success_like, policy_safety) -> str:
        """Generate brief human-readable reasoning."""
        parts = []
        
        if intent_conf > 0.7:
            parts.append(f"High intent match ({intent_conf:.0%})")
        elif intent_conf < 0.4:
            parts.append(f"Low intent match ({intent_conf:.0%})")
        
        if success_like > 0.7:
            parts.append(f"historically successful ({success_like:.0%})")
        elif success_like < 0.3:
            parts.append(f"low historical success ({success_like:.0%})")
        
        if policy_safety < 0.6:
            parts.append("policy concerns flagged")
        
        return "; ".join(parts) if parts else "standard confidence"
```

### 4.5 Belief Updater

```python
# cortex/services/belief_updater.py

import json
from datetime import datetime


class BeliefUpdater:
    """Updates Bayesian belief profiles based on outcomes."""
    
    def __init__(self, db):
        self.db = db
    
    async def update_from_outcome(self, org_id: str, user_id: str,
                                    intent_result: 'IntentResult',
                                    chosen_action: 'ActionCandidate',
                                    outcome: dict) -> dict:
        """
        Update beliefs after an action outcome.
        
        Outcome dict:
        {
            "result": "success" | "partial" | "failed" | "overridden",
            "user_override": "changed to X" | None,
            "correct_dept": "sales_admin" | None,  # if user redirected
        }
        """
        updates = {}
        
        # 1. Update department routing belief
        if outcome.get("correct_dept"):
            # User corrected the routing — strong signal
            correct = outcome["correct_dept"]
            await self._update_belief(
                org_id, "user", user_id, "primary_role",
                boost_key=correct, boost_amount=0.15,
                decay_others=0.05
            )
            updates["primary_role"] = f"boosted {correct}"
        elif outcome["result"] == "success":
            # Correct routing confirmed
            await self._update_belief(
                org_id, "user", user_id, "primary_role",
                boost_key=chosen_action.department, boost_amount=0.05
            )
            updates["primary_role"] = f"confirmed {chosen_action.department}"
        
        # 2. Update communication preference
        if chosen_action.action_type in ("send_email", "send_sms"):
            channel = "email" if "email" in chosen_action.action_type else "sms"
            if outcome["result"] == "success":
                await self._update_belief(
                    org_id, "user", user_id, "comm_pref",
                    boost_key=channel, boost_amount=0.08
                )
                updates["comm_pref"] = f"boosted {channel}"
            elif outcome.get("user_override"):
                # User changed the channel — negative signal
                await self._update_belief(
                    org_id, "user", user_id, "comm_pref",
                    boost_key=channel, boost_amount=-0.1
                )
                updates["comm_pref"] = f"penalized {channel}"
        
        # 3. Update decision speed preference
        if outcome["result"] == "success" and chosen_action.action_type in (
            "send_email", "send_sms", "generate_proposal"
        ):
            # User accepted auto-action → prefers speed
            await self._update_belief(
                org_id, "user", user_id, "decision_speed",
                boost_key="immediate", boost_amount=0.05
            )
        elif outcome["result"] == "overridden":
            # User wanted to review → prefers deliberation
            await self._update_belief(
                org_id, "user", user_id, "decision_speed",
                boost_key="needs_review", boost_amount=0.08
            )
        
        # 4. Log the outcome
        await self.db.execute(
            "INSERT INTO action_outcomes "
            "(request_id, org_id, chosen_action_id, action_type, result, "
            " success_flag, user_override, updated_beliefs) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
            outcome.get("request_id"), org_id,
            outcome.get("action_id"), chosen_action.action_type,
            outcome["result"], outcome["result"] == "success",
            outcome.get("user_override"), json.dumps(updates)
        )
        
        return updates
    
    async def _update_belief(self, org_id: str, entity_type: str,
                              entity_id: str, belief_key: str,
                              boost_key: str = None,
                              boost_amount: float = 0.05,
                              decay_others: float = 0.0):
        """
        Bayesian belief update with optional decay.
        
        Boost the probability of boost_key, optionally decay others,
        then renormalize.
        """
        # Load current belief
        row = await self.db.fetch_one(
            "SELECT probabilities, evidence_count FROM belief_state "
            "WHERE org_id = $1 AND entity_type = $2 AND entity_id = $3 "
            "AND belief_key = $4",
            org_id, entity_type, entity_id, belief_key
        )
        
        if row:
            probs = row["probabilities"]
            evidence_count = row["evidence_count"]
        else:
            # Initialize with uniform distribution
            if belief_key == "primary_role":
                probs = {"sales_admin": 0.33, "customer": 0.33, "back_office": 0.34}
            elif belief_key == "comm_pref":
                probs = {"email": 0.5, "sms": 0.2, "portal": 0.15, "phone": 0.15}
            elif belief_key == "decision_speed":
                probs = {"immediate": 0.5, "needs_review": 0.5}
            else:
                probs = {}
            evidence_count = 0
        
        # Apply boost
        if boost_key and boost_key in probs:
            probs[boost_key] = min(probs[boost_key] + boost_amount, 0.99)
        
        # Apply decay to others
        if decay_others > 0:
            for k in probs:
                if k != boost_key:
                    probs[k] = max(probs[k] - decay_others, 0.01)
        
        # Renormalize
        total = sum(probs.values())
        if total > 0:
            probs = {k: v / total for k, v in probs.items()}
        
        # Calculate confidence (higher with more evidence)
        confidence = min(0.95, 0.3 + (evidence_count * 0.02))
        
        # Upsert
        await self.db.execute(
            "INSERT INTO belief_state "
            "(org_id, entity_type, entity_id, belief_key, probabilities, "
            " confidence, evidence_count, last_evidence, updated_at) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now()) "
            "ON CONFLICT (org_id, entity_type, entity_id, belief_key) "
            "DO UPDATE SET probabilities = $5, confidence = $6, "
            "evidence_count = belief_state.evidence_count + 1, "
            "last_evidence = $8, updated_at = now()",
            org_id, entity_type, entity_id, belief_key,
            json.dumps(probs), confidence, evidence_count + 1,
            f"outcome:{boost_key}:{boost_amount}"
        )
```

### 4.6 Updated Orchestrator

```python
# cortex/services/orchestrator.py (v2.0 — Bayesian)

class BayesianOrchestrator:
    """
    Replaces the deterministic orchestrator with Bayesian decision engine.
    
    Flow:
    1. Collect evidence
    2. Bayesian intent classification
    3. Generate candidate actions
    4. Simulate and score candidates
    5. Route based on confidence
    6. Execute (or draft/clarify)
    7. Log outcome and update beliefs
    """
    
    def __init__(self, evidence_collector, intent_engine, action_generator,
                 simulation_scorer, belief_updater, engines, model_router):
        self.evidence = evidence_collector
        self.intent = intent_engine
        self.actions = action_generator
        self.simulator = simulation_scorer
        self.beliefs = belief_updater
        self.engines = engines
        self.model_router = model_router
    
    async def process(self, message: str, user_id: str, org_id: str,
                       conversation_history: list[dict] = None) -> dict:
        """Process a user request through the full Bayesian pipeline."""
        
        # 1. EVIDENCE COLLECTION
        context = await self.evidence.collect(
            message, user_id, org_id, conversation_history
        )
        
        # 2. BAYESIAN INTENT CLASSIFICATION
        intent_result = await self.intent.classify(context)
        
        # Log intent scores
        request_id = await self._log_intent(intent_result, context)
        
        # 3. Check if clarification needed
        if intent_result.requires_clarification:
            return {
                "type": "clarification",
                "message": await self._generate_clarification(
                    intent_result, context
                ),
                "intent_probs": intent_result.probabilities,
                "request_id": request_id,
            }
        
        # 4. GENERATE CANDIDATE ACTIONS
        candidates = await self.actions.generate(context, intent_result)
        
        # 5. SIMULATE AND SCORE
        scored = await self.simulator.score_candidates(
            candidates, context, intent_result
        )
        
        if not scored:
            return {
                "type": "fallback",
                "message": "I wasn't able to determine the best action. Could you provide more details?",
                "request_id": request_id,
            }
        
        best = scored[0]
        
        # 6. SELECT MODEL TIER based on confidence
        model = self.model_router.select(intent_result.confidence)
        
        # 7. EXECUTE based on execution mode
        if best.execution_mode == "auto":
            result = await self.engines[best.candidate.department].execute(
                best.candidate, context, model=model
            )
            return {
                "type": "executed",
                "action": best.candidate.action_type,
                "result": result,
                "confidence": best.final_score,
                "reasoning": best.reasoning,
                "request_id": request_id,
            }
        
        elif best.execution_mode == "draft":
            draft = await self.engines[best.candidate.department].draft(
                best.candidate, context, model=model
            )
            return {
                "type": "draft",
                "action": best.candidate.action_type,
                "draft": draft,
                "confidence": best.final_score,
                "reasoning": best.reasoning,
                "alternatives": [
                    {"action": s.candidate.action_type,
                     "score": s.final_score,
                     "reasoning": s.reasoning}
                    for s in scored[1:3]  # show top 2 alternatives
                ],
                "request_id": request_id,
            }
        
        elif best.execution_mode == "approval":
            return {
                "type": "approval_needed",
                "action": best.candidate.action_type,
                "description": best.candidate.description,
                "confidence": best.final_score,
                "risk": best.risk_level,
                "reasoning": best.reasoning,
                "alternatives": [
                    {"action": s.candidate.action_type,
                     "score": s.final_score}
                    for s in scored[1:3]
                ],
                "request_id": request_id,
            }
        
        else:  # clarify
            return {
                "type": "clarification",
                "message": await self._generate_clarification(
                    intent_result, context
                ),
                "request_id": request_id,
            }
    
    async def handle_outcome(self, request_id: str, outcome: dict):
        """Called when we know the result of an action."""
        # Retrieve the original intent and action
        # Update beliefs
        # Feed training data pipeline
        pass  # Implementation ties to specific outcome signals
```

---

## 5. Model Tier Integration

The Bayesian confidence score directly drives model selection:

```python
class ModelRouter:
    """Select model tier based on Bayesian confidence."""
    
    TIERS = {
        "local":   {"model": "gemma2:9b", "cost": 0, "threshold": 0.75},
        "mid":     {"model": "gemini-pro", "cost": 0.01, "threshold": 0.50},
        "premium": {"model": "claude-opus", "cost": 0.15, "threshold": 0.0},
    }
    
    def select(self, confidence: float) -> str:
        if confidence >= self.TIERS["local"]["threshold"]:
            return self.TIERS["local"]["model"]
        elif confidence >= self.TIERS["mid"]["threshold"]:
            return self.TIERS["mid"]["model"]
        else:
            return self.TIERS["premium"]["model"]
```

**Cost impact estimate:**
| Scenario | Before (deterministic) | After (Bayesian) |
|----------|----------------------|-------------------|
| First interaction | Cloud model every time | Cloud model (no priors yet) |
| After 10 interactions | Still cloud model | 40% local, 40% mid, 20% premium |
| After 50 interactions | Still cloud model | 70% local, 20% mid, 10% premium |
| After 100 interactions | Still cloud model | 85% local, 10% mid, 5% premium |

**Estimated per-user cost:** $26/mo → $8-12/mo (after learning period)

---

## 6. Bayesian Teaching Pipeline (Fine-Tuning)

Based on the Google Research paper, we generate training data from the Bayesian engine itself:

```python
class BayesianTeachingDataGenerator:
    """
    Generate fine-tuning data showing Bayesian reasoning progression.
    
    Per Google's findings:
    - Train on Bayesian model's predictions (including uncertain ones)
    - NOT on oracle/correct answers
    - This teaches the model to maintain uncertainty and update beliefs
    - Skills transfer across domains
    """
    
    async def generate_sequence(self, user_profile: dict, 
                                  num_rounds: int = 5) -> list[dict]:
        """Generate a multi-round interaction showing belief updating."""
        
        training_examples = []
        beliefs = {}  # starts empty
        
        for round_num in range(num_rounds):
            # Simulate user request
            request = self._simulate_request(user_profile, round_num)
            
            # Bayesian engine classifies with current beliefs
            intent_probs = self._bayesian_classify(request, beliefs)
            
            # Generate action with uncertainty
            action = self._select_action(intent_probs, round_num)
            
            # Get user feedback
            correct_action = self._oracle_action(request, user_profile)
            was_correct = action == correct_action
            
            # Training example includes the UNCERTAIN reasoning
            training_examples.append({
                "instruction": f"Round {round_num + 1}: Classify intent and select action.",
                "input": json.dumps({
                    "message": request,
                    "current_beliefs": beliefs,
                    "round": round_num + 1,
                }),
                "output": json.dumps({
                    "intent_probabilities": intent_probs,
                    "selected_action": action,
                    "confidence": max(intent_probs.values()),
                    "reasoning": self._explain_reasoning(intent_probs, beliefs),
                }),
            })
            
            # Update beliefs (this is what the model learns to do)
            beliefs = self._update_beliefs(beliefs, request, was_correct)
        
        return training_examples
```

**Training data targets:**
- 200 synthetic user profiles × 5 rounds = 1,000 training sequences
- Mixed with our existing 65 gold examples from Codex
- Fine-tune Gemma 9B LoRA via Unsloth
- Expected improvement: Gemma quality 3/10 → 6-7/10 on intent routing

---

## 7. Implementation Phases

### Phase 1: Foundation (Week 1-2)
- [ ] Create database tables (belief_state, intent_scores, action_candidates, action_outcomes)
- [ ] Enable pgvector extension on Neon
- [ ] Build EvidenceCollector service
- [ ] Build BayesianIntentEngine (replaces IntentClassifier)
- [ ] Integrate into existing orchestrator as drop-in replacement
- [ ] Keyword-based likelihoods (bootstrap, no ML needed yet)
- [ ] Unit tests for Bayesian math (priors, updates, normalization)

### Phase 2: Scoring & Simulation (Week 3-4)
- [ ] Build ActionGenerator service
- [ ] Build SimulationScorer ("shadow boardroom")
- [ ] Scoring formula: intent × context × success × policy × satisfaction
- [ ] Confidence-based execution modes (auto/draft/approval/clarify)
- [ ] Model tier routing based on confidence
- [ ] Store all candidates and scores in DB

### Phase 3: Learning Loop (Week 5-6)
- [ ] Build BeliefUpdater service
- [ ] Outcome logging (success/failure/override signals)
- [ ] Belief profile UI in Cortex dashboard
- [ ] Async downstream signal collection (client replied? deal progressed?)
- [ ] Historical success rate queries for simulation scoring
- [ ] Learned priors replace default priors after sufficient data

### Phase 4: Embeddings & Teaching (Week 7-8)
- [ ] Sentence-transformer embedding model (local, ~100MB)
- [ ] pgvector intent embedding index
- [ ] Semantic similarity as additional likelihood signal
- [ ] Bayesian teaching data generator
- [ ] Generate 1,000 training sequences
- [ ] Fine-tune Gemma 9B LoRA via Unsloth
- [ ] A/B test: Bayesian-taught vs baseline

### Phase 5: Cross-Department Intelligence (Week 9-10)
- [ ] Cross-department belief propagation
  - Sales learns "price-sensitive" → Customer adjusts approach
  - Customer learns "prefers phone" → Sales updates outreach channel
- [ ] Contact-level beliefs (not just user-level)
- [ ] Deal-level beliefs (stage prediction, stall detection)
- [ ] Bayesian planning: predict outcomes before executing
- [ ] "Shadow boardroom" multi-evaluator UI

---

## 8. Files to Create/Modify

> Cortex layout (TypeScript, pnpm workspace, `server/src/...`). Concrete paths TBD during implementation; this is the structural shape.

### New Files
```
cortex/server/src/services/evidence-collector.ts
cortex/server/src/services/bayesian-intent.ts
cortex/server/src/services/action-generator.ts
cortex/server/src/services/simulation-scorer.ts
cortex/server/src/services/belief-updater.ts
cortex/server/src/services/model-router.ts
cortex/server/src/services/teaching-data-generator.ts
cortex/server/src/models/bayesian.ts                (DB models)
cortex/server/src/routes/beliefs.ts                 (belief profile API)
cortex/server/src/routes/outcomes.ts                (outcome logging API)
cortex/scripts/generate-training-data.ts
cortex/scripts/run-bayesian-migration.sql
```

### Modified Files
```
cortex/server/src/services/orchestrator.ts          (Bayesian flow — main entry)
cortex/server/src/index.ts                          (mount new routes)
cortex/config/model-tiers.yaml                      (confidence thresholds)
cortex/config/departments.yaml                      (action templates)
```

---

## 9. Strategic Advantage

| Feature | Typical AI SaaS | Cortex with Bayesian Engine |
|---------|-----------------|------------------------------|
| Intent routing | Keyword match or single LLM call | Probabilistic multi-signal inference |
| Action selection | LLM picks one action | Multiple candidates scored by simulated outcomes |
| Learning | None (same behavior every time) | Belief profiles improve with every interaction |
| Confidence handling | Binary (confident/not) | Gradient (auto/draft/approval/clarify) |
| Model costs | Same model every call | Confidence-driven tiering (85% local after training) |
| Risk management | None | Policy scoring + simulation before execution |
| Cross-domain transfer | None | Bayesian-taught models generalize across departments |

**The pitch:** "Cortex doesn't just follow instructions — it learns your business and makes fewer dumb decisions over time."

---

*This architecture transforms Cortex from a task orchestrator that follows commands into a decision engine that reasons about uncertainty, learns from outcomes, and gets smarter with every interaction.*
