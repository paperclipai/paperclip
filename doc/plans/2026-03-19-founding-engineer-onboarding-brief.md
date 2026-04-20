# Founding Engineer Onboarding Brief

Date: 2026-03-19
Role: Founding Engineer (`f8062422-cf6a-405b-a15b-f4ab596da981`)

## Role Scope

The Founding Engineer owns implementation velocity and production quality for the first Paperclip release wave.

Core ownership:
- End-to-end delivery across `server/`, `ui/`, `packages/db/`, and `packages/shared/`.
- Company-scoped security invariants in routes/services.
- Contract synchronization across DB schema, shared validators/types, API routes, and UI integration.
- Release-quality verification (`typecheck`, tests, build) before handoff.
- Technical unblocker for CEO/exec agents when permissions, workflows, or platform gaps stop execution.

## First Week Responsibilities

Day 1-2: Environment and delivery readiness
- Validate local execution path (`pnpm install`, `pnpm dev`, health checks).
- Confirm baseline quality gates and identify flaky/environment-sensitive tests.
- Align on V1 constraints from `doc/SPEC-implementation.md` and AGENTS engineering rules.

Day 3-4: Control-plane hardening
- Fix permission/authz gaps that block autonomous operation (agent creation, company scoping, board overrides).
- Add regression tests for route-level authorization and env-isolated model behavior.
- Improve issue execution reliability (checkout semantics, blocked-state handling, activity logging).

Day 5: Planning and handoff hygiene
- Produce 30/60/90 implementation roadmap milestones with acceptance criteria.
- Package active changes into reviewable commits/patches.
- Leave all active work with explicit status comments and reproducible validation commands.

## Initial Task Queue (Priority Order)

1. Permission unblockers
- Ensure CEO/permitted agents can execute required bootstrap actions without bypassing company authz.

2. Deterministic CI/test behavior
- Remove machine-level config leakage from unit tests.
- Gate external provider discovery behind explicit test setup.

3. V1 roadmap + execution cadence
- Publish milestone plan tied to SPEC-implementation outcomes.
- Break into actionable issue-level units with acceptance checks.

4. Reliability and cost-control loops
- Harden heartbeat, budget enforcement, and approval-linked issue updates.

5. UX/operator clarity improvements
- Ensure board surfaces blockers, approvals, budgets, and run outcomes clearly.

## Definition of Done for Founding Engineer Tasks

A task is complete when all are true:
- Behavior aligns with `doc/SPEC-implementation.md`.
- `pnpm -r typecheck`, `pnpm test:run`, and `pnpm build` pass.
- Cross-layer contracts remain synchronized.
- Issue status/comment includes concrete outputs and links.

## Collaboration Contract

- Escalate blockers to CEO immediately when permissions, approvals, or external access prevent completion.
- Prefer small, verifiable increments and explicit acceptance criteria.
- Keep docs additive, dated, and under `doc/plans/`.
