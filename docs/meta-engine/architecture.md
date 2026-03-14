# Meta-Engine Architecture

Status: Working draft
Version: 0.1
Last updated: 2026-03-14

---

## 1. Layer Model

The Meta-Engine is built as five layers on top of the Paperclip fork.

```
┌─────────────────────────────────────────────┐
│           Human Governors                   │  Strategic objectives, kill criteria,
│      (board-level approvals)                │  doctrine amendments, budget authority
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│         Governance Layer (Paperclip)        │  Org chart, roles, goals, tasks,
│   companies / goals / issues / approvals    │  budgets, heartbeats, audit logs
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│       Meta-Engine Core (custom)             │  Policy engine, primitive registry,
│  policy / evals / telemetry / primitives    │  eval harness, opportunity ranker,
│                                             │  research ingestion, cross-business
│                                             │  learning loop
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│        Execution Layer (OpenClaw)           │  Browser control, tool use,
│   sessions / tools / browser / messaging    │  sandboxed agent sessions,
│                                             │  channel-based interaction
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│          Business Workflows                 │  Compliance operator, procurement
│   vertical wrappers on shared substrate     │  ops, B2B research, etc.
└─────────────────────────────────────────────┘
```

---

## 2. Component Responsibilities

### 2.1 Paperclip (Governance Layer)

Paperclip is used as-is (with minor extensions) for:

| Paperclip Concept | Meta-Engine Use |
|-------------------|-----------------|
| Company           | One autonomous business |
| Goal              | Business mission and OKRs |
| Issue             | Task assigned to an agent |
| Agent             | Role in the org (CEO, COO, Operator, QA) |
| Approval          | Human gate for irreversible actions |
| Budget            | Spend limit per agent / per business |
| Heartbeat         | Scheduled agent wakeup |
| Activity log      | Audit trail |

Paperclip is **not** used for:
- Research ingestion
- Mechanism evaluation
- Business opportunity ranking
- Cross-business learning

### 2.2 Meta-Engine Core (custom layer)

Built inside this repo under `meta-engine/`.

#### Policy Engine (`meta-engine/policy/`)
- Enforces approval matrix
- Blocks forbidden actions
- Routes uncertain decisions to human escalation
- Applies risk tier per action type

#### Primitive Registry (`meta-engine/primitives/`)
- Versioned catalog of alignment mechanisms
- Each primitive has: interface, eval threshold, known failure modes, eligible contexts
- Mechanisms are promoted by human governors after eval approval

#### Evaluation Harness (`meta-engine/evals/`)
- Test suites per workflow
- Measures: error rate, escalation quality, reliability uplift, hallucination frequency
- Compares baseline vs mechanism-augmented workflow
- Outputs mechanism performance cards

#### Telemetry & Trace Store (`meta-engine/telemetry/`)
- Every task run produces a trace: inputs, actions, tools used, confidence, escalation, output, corrections
- Aggregated cross-business for learning loop
- Feeds mechanism performance cards

#### Opportunity Engine (`meta-engine/opportunities/`)
- Ranks workflows by: automation feasibility, alignment leverage, speed to revenue, repeatability
- Initially manual; later semi-automated

#### Research Ingestion (`meta-engine/research/`)
- Harvests internal memos, external papers, eval findings
- Produces candidate mechanism cards
- Initially manual / structured document flow

### 2.3 OpenClaw (Execution Layer)

OpenClaw handles:
- Browser-based workflow execution
- Tool routing (files, APIs, SaaS tools)
- Isolated session management
- Channel-based agent interaction (WhatsApp, Slack, etc.)

OpenClaw is treated as an **action surface**, not a decision-maker.
All decisions flow through the Meta-Engine Core before OpenClaw executes them.

### 2.4 Business Workflows

Each business is a vertical wrapper:
- Shares the Meta-Engine Core substrate
- Shares the OpenClaw execution layer
- Has its own: prompt chain, tool allowlist, ICP, pricing, eval suite
- Reports telemetry back to the cross-business learning loop

---

## 3. First Agent Org Chart

### Business: Compliance Operator

```
Human Governors
      │
   CEO Agent
      │
   COO Agent
   ┌──┴──────────┐
Operator     QA Agent
Agent
```

| Role           | Responsibilities |
|----------------|-----------------|
| Human Governor | Approve strategy, budgets, irreversible actions; set kill criteria |
| CEO Agent      | Set quarterly goals, approve new workflow launches, monitor business KPIs |
| COO Agent      | Assign tasks, manage issue queue, approve mid-level decisions |
| Operator Agent | Execute compliance workflow: ingest docs, map controls, identify gaps, produce draft |
| QA Agent       | Review Operator output, apply verifier loop, decide escalate/verify/proceed |

---

## 4. Data Flow for One Task

```
1. Human or scheduler creates task in Paperclip (issue)
2. COO Agent checks out the issue (heartbeat)
3. COO assigns to Operator Agent
4. Operator Agent wakes up, reads task context
5. Operator uses OpenClaw to gather evidence docs
6. Operator maps evidence to controls
7. Uncertainty gate applied:
   - confidence HIGH → proceed to draft
   - confidence MED  → route to QA Agent for verification
   - confidence LOW  → escalate to COO / human
8. QA Agent (if triggered) applies verifier loop, approves or corrects
9. Draft report produced with provenance citations
10. Trace stored in telemetry
11. Task marked complete in Paperclip
12. Human reviews final output (for now)
```

---

## 5. Alignment Mechanisms (MVP)

### 5.1 Uncertainty-Gated Execution (primary MVP mechanism)

**What it does:**
- Agent self-rates confidence for each claim or action
- Routes based on threshold: PROCEED / VERIFY / ESCALATE

**Implementation:**
- Structured output schema requiring `confidence_score` (0–1) and `evidence_citations` per claim
- If any claim confidence < 0.7: trigger VERIFY
- If any claim confidence < 0.4 or evidence missing: trigger ESCALATE
- Policy engine enforces this gate before any output is finalized

**Measurable effect:**
- Unsupported claim rate
- Human correction rate
- Escalation accuracy (were escalations justified?)
- Output reliability vs baseline

### 5.2 Verifier Loop (secondary, introduced in Phase 2)

**What it does:**
- QA Agent independently re-evaluates Operator output
- Flags contradictions, missing evidence, overconfident claims

**Implementation:**
- Separate agent with access to same source docs
- Structured critique schema
- Disagreements trigger escalation, not auto-override

---

## 6. Telemetry Schema (MVP)

Every task trace must capture:

```json
{
  "trace_id": "uuid",
  "task_id": "paperclip_issue_id",
  "business_id": "paperclip_company_id",
  "workflow": "compliance_operator",
  "timestamp_start": "ISO8601",
  "timestamp_end": "ISO8601",
  "agent_role": "operator | qa | coo",
  "inputs": {
    "policy_docs": ["..."],
    "evidence_docs": ["..."],
    "controls": ["..."]
  },
  "actions": [
    {
      "action_type": "read | search | map | draft | escalate",
      "tool": "openclaw_browser | file | api",
      "target": "...",
      "timestamp": "ISO8601"
    }
  ],
  "claims": [
    {
      "claim": "...",
      "evidence_citations": ["..."],
      "confidence_score": 0.85,
      "gate_decision": "proceed | verify | escalate"
    }
  ],
  "escalations": [],
  "output": {
    "draft_report_id": "...",
    "gap_count": 3,
    "unsupported_claim_count": 0
  },
  "reviewer_corrections": [],
  "mechanism_applied": ["uncertainty_gated_execution"]
}
```

---

## 7. Repository Structure

```
paperclip-ai/
├── docs/
│   └── meta-engine/          ← Meta-Engine docs (this folder)
│       ├── doctrine.md
│       ├── architecture.md
│       ├── mvp-workflow.md
│       ├── approval-matrix.md
│       └── risk-register.md
│
├── meta-engine/              ← Custom Meta-Engine layer (new)
│   ├── policy/               ← Policy engine
│   ├── primitives/           ← Alignment primitive registry
│   ├── evals/                ← Evaluation harnesses
│   ├── telemetry/            ← Trace storage and analysis
│   ├── opportunities/        ← Opportunity ranking
│   ├── research/             ← Research ingestion
│   └── workflows/
│       └── compliance-operator/   ← First business workflow
│
├── server/                   ← Paperclip server (existing)
├── ui/                       ← Paperclip UI (existing)
├── packages/                 ← Shared packages (existing)
└── docs/                     ← Existing Paperclip docs
```

---

## 8. Build Phases

### Phase 0 — Constitution (now)
- Write doctrine, architecture, approval matrix, risk register
- Define the invariant and forbidden local maxima
- Commit before any code changes

### Phase 1 — Minimal Engine (Weeks 1–4)
- Scaffold `meta-engine/` layer
- Implement policy engine stub
- Implement telemetry trace schema
- Implement uncertainty-gated execution primitive
- Implement eval harness skeleton with 20 test cases
- Configure Paperclip org for compliance operator business
- First workflow: docs in → draft report out

### Phase 2 — First Revenue (Weeks 5–9)
- Run pilot customers
- QA Agent verifier loop added
- Telemetry feeds mechanism performance card
- Human-reviewed outputs
- Target: $10k–$100k ARR

### Phase 3 — Engine Reuse (Weeks 10–16)
- Second business workflow using same substrate
- Measure: did launch cost decline?
- Measure: was uncertainty gating reused?
- Cross-business telemetry aggregation live

### Phase 4 — Mechanism Dominance (6–12 months)
- At least one mechanism becomes a buyer expectation or architecture default
- Revenue funds engine improvement
- Declining human effort per additional business
