# Paperclip V1 Company Roadmap Milestones

Date: 2026-03-19
Scope: First release wave aligned to `doc/SPEC-implementation.md`

## 30 Days (Foundation + Trust)

Milestone 1: Company-scoped control plane reliability
- Outcome: All core entities and critical routes enforce company boundaries consistently.
- Acceptance criteria:
  - Every mutating route touching `companies`, `agents`, `issues`, `goals`, `projects`, and approvals validates company access.
  - Cross-company access attempts return `403` in automated tests.
  - Activity log coverage exists for all critical mutation paths (`agent`, `issue`, `approval`, budget-policy changes).

Milestone 2: Agent governance baseline
- Outcome: Board and permitted agents can create/manage agents safely.
- Acceptance criteria:
  - CEO or explicitly permitted agents can create hires and direct agents through API.
  - Agent key scope is enforced to same-company operations only.
  - Permission regressions are covered by route-level tests.

Milestone 3: Heartbeat execution transparency
- Outcome: Heartbeat runs are consistently visible and traceable.
- Acceptance criteria:
  - `heartbeat_runs` include start/finish/error status for manual and scheduler invocations.
  - Run-to-issue linking (checkout run IDs on issue lifecycle actions) is present for auditability.
  - UI surfaces current run state and recent run outcomes per agent.

## 60 Days (Operator Control + Cost Discipline)

Milestone 4: Budget hard-stop and intervention flow
- Outcome: Operators can prevent unbounded spend and recover quickly.
- Acceptance criteria:
  - Agent/company monthly budget thresholds trigger warning + hard-stop behavior.
  - Auto-paused agents/tasks are visible in dashboard with clear unblock actions.
  - Budget policy edits are logged and reflected in cost views within one refresh cycle.

Milestone 5: Task execution loop hardening
- Outcome: Single-assignee issue flow is robust under concurrent agents.
- Acceptance criteria:
  - Atomic checkout semantics prevent double ownership (409 on contention).
  - Status transitions enforce invariants (`in_progress` requires assignee; terminal states timestamped).
  - Blocked-task lifecycle includes explicit blocker attribution and de-duplicated noisy updates.

Milestone 6: Approval gate maturity
- Outcome: Sensitive actions consistently pass through approvals where configured.
- Acceptance criteria:
  - Hire and strategy approval flows create durable approval records and issue links.
  - Approval decision events automatically update linked issue state with audit comments.
  - Approval APIs and UI show pending/approved/rejected state clearly.

## 90 Days (First Release Wave Readiness)

Milestone 7: Operator-first board UX completeness
- Outcome: One board operator can run an AI-native company end-to-end from UI.
- Acceptance criteria:
  - Dashboard answers: who is doing what, status, blockers, cost burn, and pending approvals.
  - Org chart, task list, approvals, and cost views are navigable without CLI fallback.
  - Error states are explicit and recoverable (no silent failures).

Milestone 8: Release readiness and reproducibility
- Outcome: V1 ships with predictable setup and verification.
- Acceptance criteria:
  - Canonical local startup path (`pnpm dev`) and clean reset path are documented and validated.
  - CI-equivalent checks (`typecheck`, `test:run`, `build`) are green on release branch.
  - Migration workflow (`db:generate`, runtime checks) is stable for developer onboarding.

Milestone 9: Go-live quality gate for V1 contract
- Outcome: V1 decisions in `SPEC-implementation.md` are verifiably true in behavior.
- Acceptance criteria:
  - In-scope V1 features are covered by route/service tests and smoke paths.
  - Out-of-scope items are not accidentally required for core operator workflows.
  - Release checklist maps directly to Sections 2, 3, and 5 of `SPEC-implementation.md`.

## Risks and Mitigations

Risk: Environment-dependent tests (provider config, local binaries) destabilize CI.
- Mitigation: Isolate test env defaults, avoid machine-level secret/config dependency in unit tests.

Risk: Permission drift between board/agent paths.
- Mitigation: Keep permission checks centralized in route helpers and cover with explicit role-based tests.

Risk: Cost controls implemented but hard to operate.
- Mitigation: Pair enforcement with clear UI/state transitions and explicit unblock workflows.
