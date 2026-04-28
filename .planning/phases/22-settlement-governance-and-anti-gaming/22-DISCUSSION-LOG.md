# Phase 22: Settlement Governance and Anti-Gaming - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-25
**Phase:** 22-Settlement Governance and Anti-Gaming
**Areas discussed:** Settlement Flow, Anti-Gaming, Approval/Audit

## Settlement Flow

| Option | Description | Selected |
|--------|-------------|----------|
| Deliverable-scoped settlement | Use approved deliverables as the settlement unit | ✓ |
| Actor monthly settlement only | Aggregate actor-level monthly settlement without deliverable detail | |
| Manual ledger entry only | Let operators enter gold manually | |

**User's choice:** Auto-selected deliverable-scoped settlement.
**Notes:** This best matches `ECON-02` because price proposal, rationale, negotiation comments, and status stay attached to the concrete work product.

## Anti-Gaming

| Option | Description | Selected |
|--------|-------------|----------|
| Decision support signals | Surface self-review, gold farming, quality bias as review evidence | ✓ |
| Automatic penalties | Apply penalties when signals trigger | |
| Report-only dashboard | Show signals outside settlement flow | |

**User's choice:** Auto-selected decision support signals.
**Notes:** This satisfies `ECON-04` while avoiding high-risk automated punishment.

## Approval/Audit

| Option | Description | Selected |
|--------|-------------|----------|
| Approval-gated mutation | Approval writes ledger/P&L and audit log; rejection records reason only | ✓ |
| Immediate auto-settlement | All approved deliverables settle immediately | |
| Separate approval product area | Build a new approvals UI outside P&L | |

**User's choice:** Auto-selected approval-gated mutation.
**Notes:** This closes `ECON-03` and keeps Phase 22 inside the existing P&L operator workflow.

## the agent's Discretion

- Use practical default thresholds until configurable policy is introduced.
- Keep UI inside `PnlPage` to avoid a fragmented economy workflow.

## Deferred Ideas

- Fraud case workflow and automatic penalties.
- Configurable anti-gaming thresholds.
