# Paperclip CEO Jarvis v4 — Autonomy + Enchantment Lab Upgrade

## Why v4 exists

v3 created Mission Control: playbooks, workflows, capability readiness, SOPs, and daily rituals. The remaining missing layer was the system that decides what Jarvis is allowed to do, what must be escalated, what should be refused, and what should be built next.

v4 adds that missing operating layer.

## Implemented upgrades

### 1. Autonomy Kernel

New backend tables and endpoints evaluate proposed actions before execution.

- Read-only analysis and drafting can run autonomously.
- External sending, publishing, production deployment, destructive actions, money/legal commitments, hiring/firing, and credential changes require explicit approval.
- Unsafe or unauthorized access is denied.
- Every evaluation is audit-logged.
- Approval requests are created automatically when an action is allowed but approval-gated.

Endpoints:

- `GET /autonomy/policies`
- `POST /autonomy/policies`
- `PUT /autonomy/policies/{policy_id}`
- `POST /autonomy/evaluate`

### 2. Proactive Watch Rules

Jarvis now has configurable watch rules for operational pressure.

Default checks include:

- pending approval pressure
- critical approval queue
- overdue promise/technical debt
- high-risk open work
- missing core capability configuration
- overloaded people
- stale prediction reviews
- aggregate open risk score

Endpoints:

- `GET /autonomy/watch-rules`
- `POST /autonomy/watch-rules`
- `PUT /autonomy/watch-rules/{rule_id}`
- `POST /autonomy/watch-cycle`
- `GET /autonomy/insights`

The existing background watchdog now also runs the autonomy watch cycle.

### 3. System Insights

Watch rules generate persistent `SystemInsight` records, dashboard alerts, and queued notifications. This turns the dashboard from a passive viewer into a proactive triage queue.

### 4. Enchantment Feature Backlog

v4 adds a structured backlog of 40+ beneficial upgrades across nine categories:

- cognitive reasoning
- memory/context
- agent federation
- execution/operations
- personality/interface
- temporal foresight
- dashboard visibility
- safety/integrations
- growth/content

Endpoints:

- `GET /enchantments/backlog`
- `GET /enchantments/brainstorm`
- `POST /enchantments/plan`
- `PUT /enchantments/features/{feature_id}/status`
- `GET /enchantments/audit`

### 5. Implementation Planner

The planner selects the next upgrades based on priority, complexity, risk, focus categories, horizon, and capacity level. It outputs phases, target days, dependencies, and definition of done.

### 6. Maturity Audit

The v4 audit scores the system across the Jarvis tiers and returns gaps, readiness counts, and next upgrade candidates.

### 7. Dashboard upgrades

The frontend now has two new tabs:

- **Autonomy**: evaluate actions, view policies, run watch cycle, view insights.
- **Enchantments**: view backlog, run maturity audit, generate implementation plans, view brainstorm matrix.

### 8. Expanded capability registry

New capability registry entries include:

- `autonomy.evaluate`
- `watch.proactive_cycle`
- `knowledge.vector_search`
- `voice.local_command`
- `vision.document_analysis`
- `ticket.create`

## What is still intentionally guarded

Jarvis does not claim unrestricted access. It only operates through authorized connectors and local services. High-impact writes are approval-gated. Credentials are never stored raw in database records or generated docs.

## Best next implementation pass

1. Replace simple keyword knowledge search with local embeddings.
2. Add GitHub issue creation for approved enchantment features.
3. Build a proper chart-based dashboard instead of raw JSON panels.
4. Add local voice command support behind a confirmation gate.
5. Add connector sandbox tests before enabling write scopes.
