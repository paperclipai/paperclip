# ADR-PAPERCLIP-003: Orchestration Gate Pipeline — LangGraph + Temporal

- Status: Proposed
- Date: 2026-07-21
- Owners: @haykel1977 (Quantum Engineering), Paperclip Core Team
- Related tasks/PRs: ADR-GATES-001 (Quantum reference), DR5 orchestration pattern, Self-approval audit finding (2026-07-21), GuardSpine maker-checker pattern review

## Context

Paperclip manages human-in-the-loop (HITL) gates for agent actions across the CBS-BIS ecosystem. These gates enforce that certain agent operations — file writes on sensitive paths, shell execution, git pushes to shared branches, cross-network requests, and secret reads — require explicit human approval before execution.

The audit conducted on 2026-07-21 revealed a **critical self-approval risk**: the current gate implementation allows the same agent session to both *request* and *approve* a gate in certain edge cases. Specifically:

1. **Race condition in gate state**: When an agent submits a gate request and a human operator is slow to respond, a subsequent agent action could read the gate as "pending" and treat it as "approved" if the gate state machine has a `pending → approved` auto-transition under timeout.
2. **No durable execution**: If the Paperclip process restarts during a gate evaluation, the gate state is lost. The agent may retry the action without the gate ever being evaluated.
3. **No audit trail of gate decisions**: The current system logs "gate approved" but not *who* approved, *when*, *what alternatives were considered*, or *what the gate evaluated*. This fails DORA traceability and SOC 2 evidence requirements.
4. **Scope creep in gate definitions**: Gates are currently defined in code (Go structs), meaning adding or modifying a gate requires a code change and deployment. The gate taxonomy (T1-T4 severity levels) needs to be data-driven so that new gate types can be added without code changes.

The gate pipeline is the **most security-critical component** in Paperclip. A compromised or buggy gate pipeline could allow agents to bypass human oversight on destructive operations (e.g., `git push --force` to production, modifying migration files, reading encryption keys).

## Options considered

1. **Option A: LangGraph + Temporal.** LangGraph manages the gate state machine (graph-based workflow with conditional branching, interrupt points for HITL, and parallel evaluation paths). Temporal provides durable execution — gate state is persisted in Temporal's event history, surviving process restarts. The pipeline is: `dispatch → validate scope → check permissions → HITL interrupt (if T3/T4) → execute → verify → signal`. Gate definitions are stored in Postgres as configuration data, not code.

2. **Option B: Custom Go state machine with Redis-backed state.** Build a bespoke gate pipeline in Go using Redis for state persistence. Full control, but self-built durable execution and HITL interrupt handling.

3. **Option C: Temporal only (no LangGraph).** Use Temporal workflows for the entire pipeline. Temporal handles durability and HITL via `workflow.Sleep` and signal channels. No separate state machine library.

## Decision

**Adopt Option A: LangGraph for gate state machines + Temporal for durable execution.**

Rationale:

- **Self-approval prevention by architecture**: LangGraph's graph model enforces that the "request gate" node and "approve gate" node are in separate execution branches. The approval branch can only be entered by a human-actor node (verified by `actor_type = 'human'` in the gate decision record). This is not a policy check that can be bypassed — it is a structural constraint of the graph. The `dispatch` skill and `execution-guard` skill can reference this graph structure.
- **Durable execution**: Temporal ensures that if Paperclip restarts mid-gate-evaluation, the workflow resumes from the last persisted state. Gate timeouts (e.g., "approve within 4 hours or auto-reject") are Temporal timers, not in-memory counters. This eliminates the race condition where a restarted process loses gate state.
- **HITL interrupt pattern**: LangGraph supports `interrupt_before` and `interrupt_after` nodes. For T3/T4 severity gates (file writes on sensitive paths, shell execution, git pushes), the graph interrupts before the execution node and waits for a human signal. For T1/T2 gates, the graph proceeds autonomously after validation. This maps directly to the consent gate taxonomy in AGENTS.md.
- **Data-driven gate definitions**: Gate types (what paths trigger T3, what actions require HITL, what SLAs apply) are stored in Postgres `gate_definitions` table. Adding a new gate type is an INSERT, not a code change. The `consent-gates` skill can query this table to explain gate behavior to agents.
- **Audit completeness**: Every gate decision produces a structured record in `gate_decisions` table: `gate_id`, `actor_paif` (from ADR-PAPERCLIP-002), `decision` (approved/rejected/timeout), `timestamp`, `alternatives_considered` (JSONB), `evidence_uri`, `sla_met` (boolean). This satisfies DORA Art. 9 and SOC 2 evidence requirements.
- **Cross-repo consistency**: The GateSpine maker-checker pattern (from the Quantum architecture review) is implemented as a LangGraph subgraph that can be composed into any gate pipeline. CBS-BIS and Quantum both reference the same gate graph definition.

Concrete pipeline (LangGraph graph):
```
┌─────────────┐
│  dispatch    │  ← Agent submits action with metadata
└──────┬──────┘
       │
┌──────▼──────┐
│validate_scope│  ← Check action is within agent's declared scope
└──────┬──────┘
       │ (pass)
┌──────▼──────┐
│check_perms   │  ← Check permissions, RBAC, consent gate type
└──────┬──────┘
       │
  ┌────┴────┐
  │ T1/T2   │ T3/T4
  │ (auto)  │ (HITL)
  │         │
  ▼         ▼
┌────┐  ┌──────────┐
│exec│  │ interrupt │  ← LangGraph interrupt_before: waits for human signal
└─┬──┘  └─────┬────┘
  │           │ (human approves)
  │     ┌─────▼────┐
  │     │ exec     │
  │     └─────┬────┘
  │           │
┌─▼───────────▼──┐
│    verify       │  ← Verify action result, check side effects
└──────┬─────────┘
       │
┌──────▼──────┐
│   signal     │  ← Notify requester, update audit log, persist decision
└─────────────┘
```

Temporal workflow: The entire graph is wrapped in a Temporal workflow. Each node is an activity. Interrupts map to Temporal signal channels. Timeouts map to Temporal timers.

## Consequences

- Positive outcomes:
  - Self-approval is structurally impossible (graph topology enforces actor separation)
  - Gate state survives process restarts (Temporal durability)
  - Complete audit trail for every gate decision (structured records with actor, decision, evidence)
  - New gate types added via database INSERT, not code changes
  - Cross-repo gate consistency (same graph definition used by CBS-BIS, Quantum, Paperclip)
  - HITL SLA enforcement via Temporal timers (auto-reject on timeout)

- Negative tradeoffs:
  - Operational complexity: LangGraph + Temporal is a significant dependency stack
  - Learning curve for contributors unfamiliar with graph-based workflows
  - Temporal requires its own infrastructure (Temporal server, database)
  - Overhead for simple T1/T2 gates (mitigated by fast-path optimization in the graph)

- Risks:
  - Temporal vendor lock-in (mitigated by Temporal being open-source and self-hostable)
  - LangGraph state serialization bugs could corrupt gate state (mitigated by schema validation on every state transition)
  - Graph definition errors could create paths that bypass HITL (mitigated by formal verification of gate graphs before deployment, and the `execution-guard` skill)

## Validation and rollback

- **Validation**: 
  1. Unit test: Verify that a T3 gate action cannot proceed without human signal (LangGraph test harness)
  2. Integration test: Kill Paperclip process mid-gate-evaluation, restart, verify gate state is restored from Temporal
  3. Security test: Attempt self-approval by injecting a human-actor signal from the same PAIF that requested the gate — verify rejection
  4. Load test: 100 concurrent gate evaluations, verify no state corruption

- **Rollback**: If LangGraph proves too complex, supersede this ADR and fall back to Temporal-only (Option C). The gate definitions in Postgres and the audit trail schema are reusable. If Temporal is problematic, supersede and fall back to Option B (custom Go + Redis) — but this should be a last resort given the self-approval prevention benefits of the graph model.

## Follow-up actions

1. Deploy Temporal server (self-hosted on Hetzner, consistent with sovereign-first posture)
2. Implement LangGraph gate graphs in Python (Paperclip's orchestration language)
3. Create `gate_definitions` and `gate_decisions` Postgres tables
4. Migrate existing gate logic from Go structs to LangGraph graph definitions
5. Update `execution-guard` skill to reference LangGraph gate graphs
6. Add formal verification step for gate graph changes (CI check)
7. Document HITL operator workflow for T3/T4 gate approvals
