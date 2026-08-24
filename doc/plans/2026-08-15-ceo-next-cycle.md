# CEO Directive: Next Cycle — Project Polaris

**Date**: 2026-08-15
**Author**: CEO (Voyonder)
**Status**: Product-Level Plan (pre-implementation)

## 1. Current State Assessment

The v0.2.10/v0.2.12 release cycle is fully closed. All operational fires are out:
- Release Engineer adapter configured and running
- Duplicate COO instances resolved
- Legal pages shipped on voyonder.com
- BUG-1..4 fixed
- Deployments stable

**Board Status**: CLEAN — zero open issues. All agents idle except COO/Support Engineer heartbeats.

## 2. The Product Context

Paperclip now ships as a mature control plane:
- Full agent lifecycle with 10+ adapters
- Skills system with Studio and Store
- Plugin framework with external adapter loading
- Sandbox execution environments
- Company Artifacts and Work Products
- Task Watchdogs and Recovery
- Hermes built-in adapter
- Work Timeline
- Multiple human users

The foundation is solid. The next phase is about **trust and leverage** — making agents more capable of independent, long-running work while keeping governance tight.

## 3. Strategic Theme: PROJECT POLARIS

**Core question**: How do we make it safe to trust agents with more autonomy?

**Answer**: By making their work product inspectable, their plans reviewable, and their knowledge persistent — so the human operator can verify intent, not transcript.

Polaris has three workstreams:

### Workstream A — Deep Planning (v0.4.0)

Issue documents are currently linear markdown. Agents need a structured planning surface:
- Revisionable plan documents with diff review
- Milestone tracking within a plan
- Plan→Task decomposition that lets a plan *be* the parent of multiple issues
- Approval gates at plan level (not just issue level)

**Why this matters**: Before we give agents more autonomy, they need to show their work at the plan level. A plan that a human can review, approve, and track against is the foundation of trust.

**Key deliverables**:
- Structured plan document with sections, milestones, and status tracking
- Plan revision history with diffs
- Plan-level review gates with acceptance criteria
- Plan→Issue decomposition that links child issues to plan milestones
- Board UI for plan browsing and approval

### Workstream B — Memory & Knowledge (v0.4.0)

Agents currently work with only their immediate context. A memory layer lets them:
- Remember decisions from previous runs
- Surface relevant past work when starting new tasks
- Build company-level knowledge that persists across agents

**Why this matters**: Without memory, every task starts from zero. With memory, the company learns. This is the difference between a team of smart individuals and a smart organization.

**Key deliverables**:
- Agent-level memory store (key-value, time-scoped, searchable)
- Company-level knowledge base (curated, reviewed, versioned)
- Automatic context injection from memory into new tasks
- Memory browser UI for operators

### Workstream C — CEO Chat & Board Interface (v0.4.0)

A lighter-weight way to interact with leadership agents that still resolves to real work objects.
- `board-chat.ts` route exists but needs to be surfaced in the UI
- Chat-style thread for giving direction to the CEO/COO
- Every conversation resolves to an issue, approval, or decision document

**Why this matters**: The board UI is powerful but heavy for quick direction. A chat interface lowers the friction of giving agents direction while keeping work tracked.

## 4. Delivery Strategy

**Phase 1 (v0.4.0-alpha)**: Ship Deep Planning first — it's prerequisite for everything else. Without plans, memory has nothing to anchor to and chat has nothing to resolve to.

**Phase 2 (v0.4.0-beta)**: Memory & Knowledge — build on the plan infrastructure to give agents durable context.

**Phase 3 (v0.4.0)**: CEO Chat surfaced in the UI with plan/memory integration.

## 5. Immediate Actions

| # | Action | Owner | Timeline |
|---|---|---|---|
| 1 | COO: Create child issues for Deep Planning workstream | COO | Next heartbeat |
| 2 | CTO: Technical assessment of plan document schema | CTO | This week |
| 3 | Staff Engineer: Evaluate memory store options (embeddings DB, vector search) | Staff Engineer | This week |
| 4 | COO: Update ROADMAP.md with Polaris theme | COO | Next heartbeat |

## 6. Key Decisions

1. **Deep Planning before Memory** — Plans provide the structure that memory attaches to. Shipping planning first means memory has a natural anchor.
2. **Keep v0.4.0 scoped to three workstreams** — No scope creep into MAXIMIZER MODE, Work Queues, or Self-Organization. Those are v0.5.0.
3. **Board approval gates stay at plan level** — Individual issue-level approval is available but the default flow is: propose plan → board approves plan → execute under plan.
4. **Memory is agent-scoped first, company-scoped second** — Agents should remember their own history before we aggregate across the org.

## 7. Risk Register

| Risk | Mitigation |
|---|---|
| Plan schema becomes too rigid | Start with flexible JSONB, iterate on structure |
| Memory adds latency to heartbeat start | Async warm-up; memory is pre-fetched not inline |
| CEO Chat becomes a generic chat app | Enforce resolution to work objects — every thread ends at an issue/approval/decision |
| Scope creep | Strict v0.4.0 boundary; MAXIMIZER MODE, Work Queues, Self-Org are explicitly deferred to v0.5.0 |