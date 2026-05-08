# Paperclip Autonomy Kernel Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Replace Paperclip's distributed heartbeat/routine/recovery automation with a single fail-loud autonomy kernel that only counts verified work as success.

**Architecture:** Add a central autonomy kernel owning company lanes, run authorization, explicit state transitions, evidence validation, approval gates, incidents, and continuation decisions. Existing heartbeat/adapters remain execution plumbing; productivity/recovery/routine services become sensors that submit signals to the kernel instead of independently waking agents or creating work. Critical autonomy state is durable and visible in the board UI/inbox; no hidden approvals, no silent fallback, no generic success.

**Tech Stack:** TypeScript, Express, React/Vite, Drizzle/PostgreSQL, existing Paperclip monorepo packages (`packages/db`, `packages/shared`, `server`, `ui`).

---

## Non-Negotiable Product Semantics

1. No generic run success for autonomous work. Terminal success must be `succeeded_with_evidence`.
2. A clean adapter exit with only planning/status/commentary is `failed_no_evidence` unless the issue contract explicitly allowed a report artifact.
3. Hidden approvals are controller invariant failures. If a gate requires Hugh/board action, a visible approval object and inbox item must exist.
4. Routines, productivity review, recovery, and watchdog systems may emit signals; they may not directly spawn autonomous work or token-consuming loops.
5. Failures stop the affected lane and create durable incidents unless the lane policy explicitly permits retry.
6. Company-wide serialization is the default; parallelism requires explicit dependency-graph proof and lane policy.
7. Issue state transitions require evidence ledger entries.
8. Budget, auth, workspace, dependency, approval, and contract preflight failures happen before wakeup.
9. Agent contracts are explicit, versioned, and enforced.
10. Every critical fail-loud state is visible in Dashboard/Inbox and cannot be localStorage-dismissed into invisibility.

---

## Current Repo Insertion Points

### Server / DB

- Startup and scheduler chain: `server/src/index.ts`
- Heartbeat god-service: `server/src/services/heartbeat.ts`
- Recovery/watchdog: `server/src/services/recovery/service.ts`
- Productivity review: `server/src/services/productivity-review.ts`
- Approvals: `server/src/services/approvals.ts`, `server/src/services/issue-approvals.ts`, `server/src/routes/approvals.ts`
- Budget incidents/gates: `server/src/services/budgets.ts`
- Dashboard aggregation: `server/src/services/dashboard.ts`
- Core schemas: `packages/db/src/schema/*.ts`
- Existing run tables: `heartbeat_runs`, `heartbeat_run_events`, `heartbeat_run_watchdog_decisions`
- Existing approval tables: `approvals`, `issue_approvals`
- Existing issue dependency table: `issue_relations`

### UI / Shared

- Dashboard: `ui/src/pages/Dashboard.tsx`, `ui/src/api/dashboard.ts`, `packages/shared/src/types/dashboard.ts`
- Inbox: `ui/src/pages/Inbox.tsx`, `ui/src/lib/inbox.ts`, `ui/src/hooks/useInboxBadge.ts`
- Sidebar badges: `server/src/routes/sidebar-badges.ts`, `packages/shared/src/types/sidebar-badges.ts`, `ui/src/components/Sidebar.tsx`
- Approvals: `ui/src/pages/Approvals.tsx`, `ui/src/pages/ApprovalDetail.tsx`, `ui/src/components/ApprovalCard.tsx`, `ui/src/components/ApprovalPayload.tsx`, `ui/src/api/approvals.ts`
- Issue evidence/run view: `ui/src/components/IssueRunLedger.tsx`, `ui/src/pages/IssueDetail.tsx`, `ui/src/api/issues.ts`
- Budget incident pattern: `ui/src/components/BudgetIncidentCard.tsx`, `ui/src/pages/Costs.tsx`

---

## Target Domain Model

### Autonomy run lifecycle

Canonical kernel states:

```text
planned
preflight
preflight_failed
authorized
queued
running
evidence_extraction
evidence_validation
issue_update
continuation_decision
terminal
```

Canonical terminal classifications:

```text
succeeded_with_evidence
blocked_with_owner
approval_required_visible
failed_preflight
failed_auth
failed_agent_runtime
failed_no_evidence
failed_invalid_evidence
failed_policy_violation
failed_budget
failed_controller_invariant
failed_validator_error
cancelled_by_policy
cancelled_by_user
timed_out
```

### Evidence types

```text
commit
diff
test_run
build
deployment
published_asset
document
screenshot
external_api_check
app_store_state
human_device_result
blocked_dependency
approval_request
approval_decision
issue_transition
run_log
work_product
validator_result
```

### Incident types

```text
AUTH_STALE_AGENT_CODEX
AGENT_API_UNAUTHORIZED
WORKSPACE_MISSING
HIDDEN_APPROVAL_BLOCKER
RUN_SUCCEEDED_WITHOUT_EVIDENCE
RUN_FAILED_NO_EVIDENCE
META_WORK_ATTEMPTED
AGENT_CREATED_UNAUTHORIZED_ISSUE
VALIDATOR_FAILED
LANE_BUDGET_EXCEEDED
CONTROLLER_INVARIANT_BROKEN
DEPENDENCY_GRAPH_INVALID
APPROVAL_EXPIRED
ISSUE_CONTRACT_MISSING
LANE_STOPPED
```

---

## Phase 1: Schema and Shared Contracts

### Task 1.1: Add autonomy shared types

**Objective:** Define public TypeScript contracts before server/UI code diverges.

**Files:**
- Create: `packages/shared/src/types/autonomy.ts`
- Modify: `packages/shared/src/types/index.ts`

**Requirements:**
- Export enums/unions for run kernel state, terminal classification, evidence type/status, incident type/severity/status, lane status, approval gate status.
- Include DTOs:
  - `AutonomyIncident`
  - `AutonomyEvidenceEntry`
  - `AutonomyRunTransition`
  - `CompanyLaneStatus`
  - `AgentContractSummary`
  - `AutonomyInboxItem`
  - `ApprovalGateSummary`
- Keep contracts serializable; dates as ISO strings in shared API types.

**Verification:**
- `pnpm --filter @paperclipai/shared typecheck`

### Task 1.2: Add DB schema for autonomy kernel

**Objective:** Create durable tables for evidence, incidents, lane policies, agent contracts, and state transitions.

**Files:**
- Create: `packages/db/src/schema/autonomy_evidence_entries.ts`
- Create: `packages/db/src/schema/autonomy_incidents.ts`
- Create: `packages/db/src/schema/autonomy_run_transitions.ts`
- Create: `packages/db/src/schema/lane_policies.ts`
- Create: `packages/db/src/schema/agent_contracts.ts`
- Create: `packages/db/src/schema/agent_contract_revisions.ts`
- Modify: `packages/db/src/schema/index.ts`

**Requirements:**
- All business rows company-scoped.
- Reference `heartbeat_runs.id`, `issues.id`, `agents.id` where applicable.
- Incidents support durable resolution, severity, source, source refs, lane stop flag, and human-readable remediation.
- Evidence supports validator verdicts and source refs without storing secrets.
- Agent contracts are versioned; revisions immutable after activation.
- Lane policies are company-scoped and may be default or named lanes.

**Verification:**
- `pnpm --filter @paperclipai/db typecheck`
- `pnpm db:generate`

### Task 1.3: Add DB migrations

**Objective:** Generate and inspect migrations for the new autonomy tables.

**Files:**
- Generated under DB migrations directory used by repo.

**Requirements:**
- Migration must not modify existing tables destructively.
- Indexes for company/status/severity/run/issue lookups.
- Foreign keys use existing schema conventions.

**Verification:**
- `pnpm db:generate`
- `pnpm db:migrate` against dev DB if available

---

## Phase 2: Autonomy Kernel Service Skeleton

### Task 2.1: Create autonomy kernel module

**Objective:** Add a central service with no behavior changes yet.

**Files:**
- Create: `server/src/services/autonomy-kernel/index.ts`
- Create: `server/src/services/autonomy-kernel/types.ts`
- Create: `server/src/services/autonomy-kernel/run-state-machine.ts`
- Create: `server/src/services/autonomy-kernel/evidence-ledger.ts`
- Create: `server/src/services/autonomy-kernel/incidents.ts`
- Create: `server/src/services/autonomy-kernel/lane-policy.ts`
- Create: `server/src/services/autonomy-kernel/agent-contracts.ts`
- Create: `server/src/services/autonomy-kernel/approval-gates.ts`
- Create: `server/src/services/autonomy-kernel/dependency-graph.ts`
- Create: `server/src/services/autonomy-kernel/validators.ts`

**Requirements:**
- Service factory accepts `db` and logger/options, matching existing service style.
- Public methods:
  - `preflightRun(request)`
  - `authorizeRun(request)`
  - `recordTransition(input)`
  - `recordEvidence(input)`
  - `validateEvidence(input)`
  - `createIncident(input)`
  - `resolveIncident(input)`
  - `evaluateContinuation(input)`
  - `getCompanyLaneStatus(companyId)`
  - `getAutonomyInbox(companyId)`
- No wakeup integration yet.

**Verification:**
- Unit tests for factory creation and transition validation.
- `pnpm --filter @paperclipai/server test -- autonomy-kernel`

### Task 2.2: Implement run state machine rules

**Objective:** Enforce valid transitions and terminal classifications.

**Files:**
- Modify: `server/src/services/autonomy-kernel/run-state-machine.ts`
- Test: `server/src/services/autonomy-kernel/__tests__/run-state-machine.test.ts`

**Requirements:**
- Invalid transitions throw typed errors.
- Terminal states are immutable except explicit controller override with incident.
- `succeeded` without evidence is impossible through kernel API.

**Verification:**
- Tests for valid transitions, invalid transitions, terminal immutability, no generic success.

### Task 2.3: Implement incident service

**Objective:** Create durable fail-loud incidents with lane stop semantics.

**Files:**
- Modify: `server/src/services/autonomy-kernel/incidents.ts`
- Test: `server/src/services/autonomy-kernel/__tests__/incidents.test.ts`

**Requirements:**
- Create incident rows idempotently by source/type/company when configured.
- Support `open`, `acknowledged`, `resolved`, `suppressed` statuses.
- Critical incidents can stop lane.
- No local-only dismissal semantics.

**Verification:**
- Tests create/resolve incidents and verify lane stop flag behavior.

### Task 2.4: Implement evidence ledger service

**Objective:** Store normalized evidence and validation verdicts.

**Files:**
- Modify: `server/src/services/autonomy-kernel/evidence-ledger.ts`
- Test: `server/src/services/autonomy-kernel/__tests__/evidence-ledger.test.ts`

**Requirements:**
- Record evidence from run/comment/work product/approval sources.
- Support verdicts: `pending`, `accepted`, `rejected`, `validator_error`.
- Reject secret-looking source values and redact known sensitive fields.

**Verification:**
- Tests for evidence creation, validation update, company scoping, redaction.

---

## Phase 3: Preflight Gates and Fail-Loud Auth/Policy

### Task 3.1: Implement preflight gate composition

**Objective:** Evaluate auth, budget, agent status, workspace, dependency, approval, lane, and contract gates before wakeup.

**Files:**
- Modify: `server/src/services/autonomy-kernel/index.ts`
- Modify: `server/src/services/autonomy-kernel/lane-policy.ts`
- Modify: `server/src/services/autonomy-kernel/agent-contracts.ts`
- Modify: `server/src/services/autonomy-kernel/dependency-graph.ts`
- Test: `server/src/services/autonomy-kernel/__tests__/preflight.test.ts`

**Requirements:**
- Preflight returns explicit `allow | deny | approval_required | blocked`.
- Denials create incidents where appropriate.
- Approval-required gates create visible approval objects or fail controller invariant.
- No adapter process starts after a denied preflight.

**Verification:**
- Tests for each gate class.

### Task 3.2: Integrate heartbeat wakeup with kernel preflight

**Objective:** Prevent wakeups that violate kernel policy.

**Files:**
- Modify: `server/src/services/heartbeat.ts`
- Test: existing heartbeat tests plus new focused tests.

**Requirements:**
- `enqueueWakeup` / wakeup public path calls kernel preflight before run row creation or before adapter process start, according to current architecture constraints.
- Preflight incidents are visible and terminal classification is explicit.
- Existing manual/user cancellation behavior remains intact.

**Verification:**
- Targeted heartbeat tests for preflight denial and approval-required behavior.

### Task 3.3: Integrate run transitions with kernel

**Objective:** Every autonomous heartbeat run gets transition history and final classification.

**Files:**
- Modify: `server/src/services/heartbeat.ts`
- Modify: `server/src/services/autonomy-kernel/run-state-machine.ts`
- Test: heartbeat lifecycle tests.

**Requirements:**
- Run status changes append autonomy transition rows.
- Adapter success routes into evidence extraction/validation before terminal success.
- If no evidence is accepted, final classification is `failed_no_evidence`.
- Existing `heartbeat_runs.status` may remain coarse for compatibility, but autonomy classification must be queryable.

**Verification:**
- Tests prove clean adapter exit with empty/comment-only output is not classified as useful success.

---

## Phase 4: Evidence Extraction and Validators

### Task 4.1: Build evidence extractor interface

**Objective:** Convert run events/comments/work products/logs into candidate evidence.

**Files:**
- Modify: `server/src/services/autonomy-kernel/validators.ts`
- Create: `server/src/services/autonomy-kernel/evidence-extractors.ts`
- Test: `server/src/services/autonomy-kernel/__tests__/evidence-extractors.test.ts`

**Requirements:**
- Extract commit hashes, test commands/results, build commands/results, document/work product refs, URLs, screenshots, approval decisions, blocker owner/action.
- Does not trust claims; marks evidence `pending` until validated.

**Verification:**
- Tests cover representative run/comment snippets.

### Task 4.2: Implement validator registry

**Objective:** Verify evidence independently.

**Files:**
- Modify: `server/src/services/autonomy-kernel/validators.ts`
- Create validators under `server/src/services/autonomy-kernel/validators/`

**Required validators:**
- Git commit exists in repo/workspace.
- Test/build command result exists and succeeded.
- File/artifact path exists and is inside allowed storage/workspace.
- URL health/external check returns expected status.
- Issue transition has accepted evidence.
- Approval decision exists and is visible.
- Blocked dependency has owner and unblock action.

**Verification:**
- Unit tests with mocks and temp repos/files.

### Task 4.3: Attach validation to run completion

**Objective:** Final run classification depends on accepted evidence.

**Files:**
- Modify: `server/src/services/heartbeat.ts`
- Modify: `server/src/services/autonomy-kernel/index.ts`

**Requirements:**
- On adapter completion, kernel extracts and validates evidence.
- Accepted evidence can produce `succeeded_with_evidence`.
- Rejected/missing evidence creates incident and fails loud.
- Validator errors create `failed_validator_error` and stop lane if severity warrants.

**Verification:**
- Tests for commit evidence accepted, comment-only rejected, validator error incident.

---

## Phase 5: Approvals and Visible Inbox

### Task 5.1: Add autonomy approval gate contract

**Objective:** Make approval gates typed and visible.

**Files:**
- Modify: `packages/shared/src/types/autonomy.ts`
- Modify: `server/src/services/autonomy-kernel/approval-gates.ts`
- Modify: `server/src/services/approvals.ts`
- Test: approval gate tests.

**Requirements:**
- Approval gate includes issue, agent, governed action, risk, accept/reject actions, expiry, policy source.
- Creating an approval gate writes approval row and evidence entry.
- If approval cannot be created, kernel creates `HIDDEN_APPROVAL_BLOCKER` / `CONTROLLER_INVARIANT_BROKEN` incident.

**Verification:**
- Tests for visible approval creation and invariant failure.

### Task 5.2: Upgrade Approval Inbox UI

**Objective:** Hugh/board can see every approval and autonomy gate.

**Files:**
- Modify: `ui/src/pages/Approvals.tsx`
- Modify: `ui/src/pages/ApprovalDetail.tsx`
- Modify: `ui/src/components/ApprovalCard.tsx`
- Modify: `ui/src/components/ApprovalPayload.tsx`
- Modify: `ui/src/api/approvals.ts`

**Requirements:**
- Pending autonomy gates are visually distinct.
- Show issue, agent, lane, risk, exact action, evidence links, expiry.
- No critical approval can be hidden only through local dismissals.

**Verification:**
- Component tests or targeted UI test where existing test setup supports it.

### Task 5.3: Add Telegram/action integration later if platform route exists

**Objective:** Keep approval product primitive platform-independent first.

**Files:**
- TBD after inspecting notification subsystem.

**Requirements:**
- Telegram summary is optional extension; approval inbox is source of truth.

**Verification:**
- Not required before core approval UI/API works.

---

## Phase 6: Company Lane Controller and Continuation

### Task 6.1: Add lane policy resolver

**Objective:** Make company lanes explicit.

**Files:**
- Modify: `server/src/services/autonomy-kernel/lane-policy.ts`
- Test: `server/src/services/autonomy-kernel/__tests__/lane-policy.test.ts`

**Requirements:**
- Default company lane policy generated if none exists.
- Policy defines allowed agents, concurrency, max manager runs, allowed issue types, allowed evidence types, budget hooks, retry policy.
- Company-wide serialization default.

**Verification:**
- Tests for default policy and strict serialization.

### Task 6.2: Implement issue picker and continuation decision

**Objective:** Kernel decides next concrete work after every run.

**Files:**
- Modify: `server/src/services/autonomy-kernel/index.ts`
- Create: `server/src/services/autonomy-kernel/issue-picker.ts`
- Create: `server/src/services/autonomy-kernel/continuation.ts`
- Test: continuation tests.

**Requirements:**
- Skip blocked/human-only issues unless blocker changed.
- Prefer builder agents over managers.
- Refuse meta/routine/productivity issues unless explicitly contracted.
- If issue still open and unblocked, select next concrete agent/action.
- If no concrete action exists, create incident instead of comment loop.

**Verification:**
- Tests with ODIN-style issue set: builder issue selected, JLL/MKT meta skipped, blocked Tolera issue assigned to human/device owner.

### Task 6.3: Replace scheduler calls with kernel tick

**Objective:** Stop independent scheduler soup.

**Files:**
- Modify: `server/src/index.ts`
- Modify: `server/src/services/heartbeat.ts` as needed
- Modify: `server/src/services/recovery/service.ts`
- Modify: `server/src/services/productivity-review.ts`

**Requirements:**
- Startup/periodic scheduler invokes kernel tick.
- Recovery/productivity/routine services emit signals only or are called by kernel as sensors.
- No direct autonomous wake/comment/issue spawn from sensors without kernel authorization.

**Verification:**
- Tests for scheduler tick creating signal/incident, not autonomous meta issue.

---

## Phase 7: Incidents, Dashboard, Inbox, Sidebar

### Task 7.1: Add autonomy status and inbox API

**Objective:** Expose fail-loud state through server-authoritative endpoints.

**Files:**
- Create: `server/src/routes/autonomy.ts`
- Modify: route registration in server index/router location
- Modify: `packages/shared/src/types/autonomy.ts`

**Endpoints:**
- `GET /api/companies/:companyId/autonomy/status`
- `GET /api/companies/:companyId/autonomy/inbox`
- `GET /api/issues/:issueId/evidence-ledger` or issue route equivalent
- `POST /api/autonomy/incidents/:incidentId/acknowledge`
- `POST /api/autonomy/incidents/:incidentId/resolve`

**Verification:**
- Route tests for company scoping and incident visibility.

### Task 7.2: Extend dashboard with company lane status

**Objective:** Board sees autonomy health immediately.

**Files:**
- Modify: `packages/shared/src/types/dashboard.ts`
- Modify: `server/src/services/dashboard.ts`
- Modify: `ui/src/api/dashboard.ts`
- Modify: `ui/src/pages/Dashboard.tsx`

**Requirements:**
- Top panel shows lane state: healthy, running, blocked, approval required, degraded, stopped.
- Critical incidents appear above generic metrics.
- Links to inbox/incident/evidence detail.

**Verification:**
- Server dashboard tests and UI smoke/component checks.

### Task 7.3: Promote incidents/autonomy blocks in Inbox

**Objective:** Inbox becomes the fail-loud control surface.

**Files:**
- Modify: `ui/src/pages/Inbox.tsx`
- Modify: `ui/src/lib/inbox.ts`
- Modify: `ui/src/hooks/useInboxBadge.ts`
- Modify: `server/src/routes/sidebar-badges.ts`
- Modify: `packages/shared/src/types/sidebar-badges.ts`
- Modify: `ui/src/components/Sidebar.tsx`

**Requirements:**
- Durable incident/autonomy-block categories.
- Badge danger reflects incidents/autonomy blocks, not just failed runs.
- Critical items cannot be dismissed via localStorage only.

**Verification:**
- UI tests where available; otherwise targeted typecheck/build.

### Task 7.4: Build issue evidence ledger surface

**Objective:** Work proof is visible next to issue history.

**Files:**
- Modify: `ui/src/components/IssueRunLedger.tsx`
- Modify: `ui/src/pages/IssueDetail.tsx`
- Modify: `ui/src/api/issues.ts`
- Modify: server issue/autonomy route for evidence ledger.

**Requirements:**
- Show evidence entries, validator verdicts, linked approvals/incidents, run provenance.
- Clearly distinguish accepted evidence from rejected claims.

**Verification:**
- Issue detail renders evidence fixtures and failed_no_evidence states.

---

## Phase 8: Migration of Old Automation into Sensors

### Task 8.1: Convert productivity review service into kernel sensor

**Objective:** Stop productivity service from creating noisy autonomous work directly.

**Files:**
- Modify: `server/src/services/productivity-review.ts`
- Modify: `server/src/services/autonomy-kernel/index.ts`
- Tests around productivity review behavior.

**Requirements:**
- Productivity review emits typed signal/evidence.
- Kernel decides incident vs continuation vs ignore.
- No productivity-review issue creation unless lane policy explicitly asks for it.

**Verification:**
- Regression test: stale issue does not create meta issue by itself.

### Task 8.2: Convert recovery/watchdog final actions into kernel decisions

**Objective:** Recovery remains visible but stops bypassing kernel policy.

**Files:**
- Modify: `server/src/services/recovery/service.ts`
- Modify: `server/src/services/autonomy-kernel/index.ts`

**Requirements:**
- Watchdog decisions become evidence/incident inputs.
- Kernel chooses retry, lane stop, recovery issue, or human escalation.
- Process-lost/stale-auth paths create proper incidents.

**Verification:**
- Tests for process-lost retry policy and stale-auth lane stop.

### Task 8.3: Convert routines into sensors or explicit contracted work

**Objective:** No routine can silently start broad work.

**Files:**
- Inspect and modify routine service files.

**Requirements:**
- Routine triggers submit signals to kernel.
- Routines that create work must have lane policy and issue contract.
- Dead/stale company routines are ignored or incidented, not run.

**Verification:**
- Regression tests for no MKT/JLL routine churn.

---

## Phase 9: End-to-End Dogfood on ODIN

### Task 9.1: Seed ODIN lane policy and contracts in dev fixture/tooling

**Objective:** Test real Hugh use case without broad activation.

**Files:**
- Add seed/migration/dev script if repo has fixture convention.

**Requirements:**
- ODIN Core contract requires commit/test/artifact for implementation issues.
- ODIN Distribution contract requires published asset/document evidence.
- ODIN QA contract requires test/build/release evidence.

**Verification:**
- Seed script produces lane policy and contracts.

### Task 9.2: Run ODIN-142-style scenario in tests

**Objective:** Prove controller behavior.

**Requirements:**
- Implementation issue assigned to Core.
- Agent exits with planning comment only → `failed_no_evidence`, incident, lane stopped.
- Agent produces commit/test/artifact → `succeeded_with_evidence`, issue advances.
- Approval requested without visible approval → invariant incident.
- Approval requested with visible approval → `approval_required_visible`, inbox item.

**Verification:**
- End-to-end service test.

### Task 9.3: Verify no old noise paths remain

**Objective:** Prevent regression to fake activity.

**Requirements:**
- No JLL routine issues.
- No `MKT-*` work from dead workspace.
- No productivity/recovery issue spam.
- No success without evidence.

**Verification:**
- Regression suite.

---

## Execution Policy for Implementers

- Follow TDD for each service/module task.
- Commit after each coherent task.
- Do not expose secrets in logs or test fixtures.
- Do not add yourself as co-author.
- Do not replace strategic docs wholesale.
- Keep changes company-scoped.
- Keep shared/db/server/ui contracts synchronized.
- Run targeted tests first, then full PR-ready checks before handoff:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

---

## Definition of Done

This architecture is done when:

1. Every autonomous run has a kernel transition history.
2. Every useful-success classification has accepted evidence.
3. Missing/invalid evidence fails loud and creates an incident.
4. Approval gates are visible in approvals/inbox and linked to issues/runs.
5. Dashboard shows lane status and critical incidents.
6. Inbox shows durable incidents/autonomy blocks without local-only critical dismissal.
7. Productivity/recovery/routine systems cannot independently create token-burning work loops.
8. Company lanes enforce policies and stop on critical invariant failures.
9. ODIN dogfood scenario proves the controller ships evidence or fails loudly.
10. Full typecheck, tests, and build pass.
