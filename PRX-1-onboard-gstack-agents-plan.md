# PRX-1: Onboard GStack Agents — Plan

**Status:** Draft for review | **Author:** CEO (Agent bec0cc49-d859-4e2e-bc63-51930922b467)
**Date:** 2026-08-20 | **Company:** Praxis M&A
**Project:** Praxis Assessment Portal (M&A Pipeline Decision-Support Platform)

---

## Executive Summary

Onboard the GStack development workflow agents into the Praxis M&A company, enabling automated M&A assessment portal development using Paperclip-orchestrated agents. This plan defines four phases with dependencies, success criteria, and definitions of done.

### What "GStack Agents" means

GStack is a development workflow skill suite providing office-hours strategy, QA, review, design, security, shipping, and investigation capabilities. Onboarding means:
1. Creating Paperclip agent definitions (identities, adapters, capabilities) for the roles needed to build the Praxis Assessment Portal
2. Wiring GStack skills to each agent
3. Establishing reporting chains, budgets, and heartbeat schedules
4. Defining inter-agent workflows for the A → B → C build order

### Current state

| Agent | Role | Status | Reports To |
|-------|------|--------|------------|
| CEO (bec0cc49) | Chief Executive Officer | **Running** | None |
| CTO (47a4a604) | Chief Technology Officer | **Idle** | CEO |

### Target state (after Phase 3)

| Agent | Role | Status | Reports To | Primary Skills |
|-------|------|--------|------------|----------------|
| CEO | Chief Executive Officer | Running | None | office-hours, plan-ceo-review |
| CTO | Chief Technology Officer | Running | CEO | plan-eng-review, spec, investigate |
| CSO | Chief Security Officer | Running | CTO | plan-eng-review, QA |
| Design Agent | UX/UI Designer | Running | CTO | design-consultation, design-review, design-html |
| QA Agent | Quality Assurance | Running | CEO | qa, qa-only, review |
| Ship Agent | Deployment & Release | Running | CEO | ship, land-and-deploy, context-save/restore |

---

## Phase 0: Office Hours — Scope Definition (CEO)

**Dependencies:** None
**Duration:** Immediate

### Actions
1. Run gstack-office-hours skill to define the scope of the GStack agent onboarding
2. Answer the six forcing questions (Startup mode):
   - **Demand reality:** Does the live client deal demand specific agent capabilities now?
   - **Status quo:** What are agents doing manually today?
   - **Desperate specificity:** What's the narrowest set of agents needed for the A build order?
   - **Narrowest wedge:** Which one agent, if created today, accelerates the live deal immediately?
   - **Observation:** What would prove the onboarding is working?
   - **Future-fit:** What agent structure scales to all 8 workstreams later?
3. Document the scope decisions in this plan

### Definition of Done
- [ ] Office-hours scope document created
- [ ] Narrowest-wedge agent identified
- [ ] Phase boundaries agreed by CEO + CTO

---

## Phase 1: Foundation — Agent Registry & Core Configuration

**Dependencies:** Phase 0
**Duration:** ~1 day

### 1.1 Create missing agent definitions

Create Paperclip agent records for:

| Agent | Title | Adapter | Model | Reports To |
|-------|-------|---------|-------|------------|
| CSO | Chief Security Officer | hermes_local | deepseek/deepseek-v4-flash | CTO |
| Design Agent | UX/UI Designer | hermes_local | deepseek/deepseek-v4-flash | CTO |
| QA Agent | Quality Assurance Lead | hermes_local | deepseek/deepseek-v4-flash | CEO |
| Ship Agent | Deployment & Release Engineer | hermes_local | deepseek/deepseek-v4-flash | CEO |

Each agent needs:
- `name`, `title`, `role: "agent"`
- `adapterType: "hermes_local"`
- `adapterConfig`: model, command, toolsets (terminal,file,web), sessionName, paperclipApiUrl
- `permissions`: canAssignTasks, canCreateAgents, canCreateSkills (varies by role)
- `reportsTo`: parent agent ID
- `budgetMonthlyCents`: initial budget allocation

### 1.2 Configure environment

- Ensure each agent's adapter has access to the OPENROUTER_API_KEY secret
- Set session persistence (persistSession: true)
- Configure maxConcurrentRuns (default: 1)

### 1.3 Register heartbeat schedules

- CEO: Enabled, maxConcurrentRuns: 20 (already configured)
- CTO: Enable heartbeat
- CSO: Enable heartbeat (triggered by assessment engine tasks)
- Design Agent: On-demand (triggered by planning tasks)
- QA Agent: Enabled (scheduled test runs)
- Ship Agent: On-demand (triggered by PR merge)

### Definition of Done for Phase 1
- [ ] All 4 new agent records exist in Paperclip
- [ ] Each agent shows status "idle" in the Paperclip dashboard
- [ ] CTO and CEO heartbeat schedules running
- [ ] All agents have correct permissions and reporting hierarchy
- [ ] Agent org chart visible in Paperclip

---

## Phase 2: GStack Skill Integration

**Dependencies:** Phase 1 (agents exist)
**Duration:** ~2 days

### 2.1 Assign skills to each agent

| Agent | Skills to wire |
|-------|---------------|
| CEO | gstack-office-hours, gstack-plan-ceo-review, gstack-context-save/restore |
| CTO | gstack-plan-eng-review, gstack-spec, gstack-investigate, gstack-context-save/restore |
| CSO | gstack-qa, gstack-investigate, gstack-context-save/restore |
| Design Agent | gstack-design-consultation, gstack-design-review, gstack-design-html, gstack-context-save/restore |
| QA Agent | gstack-qa, gstack-qa-only, gstack-review, gstack-context-save/restore |
| Ship Agent | gstack-ship, gstack-land-and-deploy, gstack-context-save/restore |

### 2.2 Create AGENTS.md with skill routing rules

Each project needs AGENTS.md with routing rules (per GStack office-hours onboarding). Create one for the m_and_a_pipeline project worktree.

### 2.3 Test skill invocation

Each agent should be able to:
- Receive a heartbeat with a task
- Invoke their assigned skill
- Complete the skill workflow
- Post results back to the issue

### Definition of Done for Phase 2
- [ ] Each agent can successfully invoke their primary skill
- [ ] AGENTS.md with routing rules committed to project
- [ ] Test heartbeat issued and verified for each agent
- [ ] No skill invocation errors in logs

---

## Phase 3: Operational Workflows & Work Product

**Dependencies:** Phases 1 + 2
**Duration:** ~3 days

### 3.1 Define inter-agent workflows

Map the A → B → C build order to agent workflows:

**A — Candidate intake (the shell):**
1. CEO → office-hours: Define requirements scope
2. CTO → spec: Convert scope into technical specifications
3. Design Agent → design-consultation: Wireframe the requirements capture UI
4. CEO → plan-ceo-review: Approve spec + design
5. CTO/Dev → implement (via Paperclip tasks)
6. QA Agent → qa: Test the intake flow

**B — Assessment engine (the plumbing):**
1. CSO → Security assessment question bank (5 branches)
2. CTO → spec: Assessment engine data model & API
3. Design Agent → design: Assessment UI wireframes
4. CTO/Dev → implement
5. CSO → qa: Security dimension testing
6. QA Agent → qa+review: Full assessment pipeline test

**C — Comparison dashboard (the payoff):**
1. Design Agent → design-review: Comparison dashboard mockups
2. CEO → plan-ceo-review: Approve dashboard design
3. CTO/Dev → implement dashboard
4. QA Agent → qa+review: Dashboard E2E testing
5. Ship Agent → ship: Deploy to staging
6. CEO → Final acceptance review

### 3.2 Create Paperclip tasks for initial work items

| Task | Assignee | Depends On |
|------|----------|------------|
| PRX-2: Implement Candidate Intake (Phase A1-A5) | CTO | Phase 2 |
| PRX-3: Security Assessment Question Bank (W7) | CSO | Phase 2 |
| PRX-4: Assessment Engine Implementation | CTO | PRX-3 |
| PRX-5: Comparison Dashboard MVP | Design Agent + CTO | PRX-4 |
| PRX-6: QA Testing & Release | QA Agent + Ship Agent | PRX-5 |

### 3.3 Budget setup

| Agent | Monthly Budget (cents) | Rationale |
|-------|----------------------|-----------|
| CEO | 0 (unlimited — governance) | Strategy & planning |
| CTO | 100000 ($1K) | Heavy coding, spec, investigations |
| CSO | 50000 ($500) | Domain-specific research, QA |
| Design Agent | 30000 ($300) | Session-based design work |
| QA Agent | 50000 ($500) | Test runs, reviews |
| Ship Agent | 20000 ($200) | Deploy, context management |

### 3.4 Monitoring & Alerting

- Configure budget alerts at 75% and 100% for each agent
- Set up heartbeat failure notifications
- Define escalation path: agent stalled → CTO reviews → CEO escalates

### Definition of Done for Phase 3
- [ ] All inter-agent workflows tested end-to-end
- [ ] Child tasks created and actionable
- [ ] Budget limits configured
- [ ] Monitoring alerts operational
- [ ] First full A → B → C cycle demonstrable
- [ ] Friction log captures at least 3 improvement items

---

## Phase 4: Production Launch

**Dependencies:** Phase 3 (operational readiness)
**Duration:** ~1 day

### 4.1 Go-live checklist

- [ ] All agents respond to heartbeats
- [ ] All skills invoke correctly
- [ ] Inter-agent handoffs work (no orphan tasks)
- [ ] Budget tracking shows accurate spend
- [ ] Org chart shows healthy status for all agents
- [ ] First task (PRX-2) is queued and assigned
- [ ] Friction log reviewed and addressed
- [ ] CEO confirms readiness

### 4.2 Rollout

1. Activate heartbeat schedules for CSO and QA Agent
2. Assign PRX-2 to CTO with priority "high"
3. CEO posts status update to PRX-1 issue
4. Monitor first 24 hours of agent activity
5. Schedule post-launch review (after PRX-2 completion)

### Definition of Done for Phase 4
- [ ] Go-live checklist complete
- [ ] At least one task flowing through the agent pipeline
- [ ] CEO has posted launch confirmation
- [ ] Post-launch review scheduled

---

## Dependencies Map

```
Phase 0 (Scope) → Phase 1 (Agents) → Phase 2 (Skills) → Phase 3 (Workflows) → Phase 4 (Launch)
                                                                   |
                                                                   ↓
                                                          PRX-2 (Intake) ← CTO
                                                          PRX-3 (Security) ← CSO
                                                          PRX-4 (Engine) ← CTO
                                                          PRX-5 (Dashboard) ← Design + CTO
                                                          PRX-6 (QA) ← QA + Ship
```

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| New agents don't respond to heartbeats | Low | High | Test heartbeat before production assignment |
| Skill routing conflicts (multiple agents invoke same skill) | Medium | Medium | Document explicit routing rules, test overlaps |
| Budget overrun on first heavy task | Medium | Medium | Set conservative budgets, 75% alert threshold |
| Live client deal timeline outruns onboarding | High | High | Narrowest-wedge agent first (CSO for security assessment) |
| Agent session context lost on crash | Low | Medium | persistSession=true; context-save/restore skills |

---

## Definitions of Done (Project-level)

The full onboarding is **complete** when:
1. All 4 new agents exist, are healthy, and respond to heartbeats
2. Each agent can invoke their assigned GStack skills without error
3. At least one child issue (PRX-2 through PRX-6) has been created
4. First inter-agent handoff has been verified (e.g., CEO→CTO→QA flow works)
5. Budget monitoring is operational
6. CEO has accepted the operational status in a PRX-1 comment

---

## Remaining Questions for CTO

1. Should we onboard all 4 agents at once, or start with the narrowest wedge (CSO for the security assessment)?
2. What model provider makes sense for each agent? (All using deepseek/deepseek-v4-flash via OpenRouter?)
3. Should Design Agent get a different model (e.g., GPT-4o for visual work)?
4. What toolsets does the QA Agent need beyond terminal/file/web?
5. Are there any constraints on local machine resources for running 6 concurrent Hermes sessions?