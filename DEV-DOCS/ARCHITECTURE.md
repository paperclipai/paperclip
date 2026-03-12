# Architecture

Last updated: 2026-03-11

## 1. System shape

Paperclip is a control plane for AI-agent companies. The product has three major layers:

- Strategic planning:
  - roadmap items (stored as `goals`)
  - projects
  - approvals
- Execution:
  - agents
  - issues
  - heartbeat runs
  - workspace checkouts
- Interpretation and operator visibility:
  - dashboard
  - activity
  - briefings / records / knowledge
  - system health diagnostics

The important current product distinction is:

- `goals` is still the persistence model and API compatibility name.
- `Roadmap` is now the operator-facing concept in the UI and alias API surface.

That means existing relational links such as `project.goalId`, `project.goalIds`, and `issue.goalId` stay intact while the product language shifts from "goal tracking" to "strategic roadmap guidance."

## 2. Monorepo boundaries

### `packages/shared`

Cross-layer contracts live here:

- enums and string unions
- API validators
- shared entity types
- portability manifest types

This package is the contract boundary between db, server, ui, and cli. Any schema/API behavior change should usually land here first or immediately after the schema change.

### `packages/db`

Owns:

- Drizzle schema
- migrations
- database client helpers
- migration inspection utilities

Recent additions relevant to this change set:

- `companies.defaultManagerPlanningMode`
- `agents.managerPlanningModeOverride`
- `goals.guidance`
- `goals.planningHorizon`
- `goals.sortOrder`

### `server`

Express API plus orchestration services.

Key responsibilities:

- company scoping and authz
- validation and mutation rules
- runtime orchestration for heartbeat runs
- approval enforcement
- activity logging
- adapter environment diagnostics

### `ui`

React operator console.

Key responsibilities:

- company-scoped routing and route prefix normalization
- query/mutation wiring against the REST API
- operator-facing roadmap, dashboard, approvals, and agent management surfaces
- keeping agent detail as the full run-analysis surface
- keeping issue detail compact while linking back to agent runs
- explicit-save project configuration flows where reviewability matters

### `cli`

Operator CLI for local workflows, admin actions, and scripted access to the control plane API.

It now also bridges the repo-local startup safety model:

- `pnpm start` / `pnpm dev` save checkout-specific startup context in `.paperclip/local-start.json`
- `paperclipai doctor --launch-history` explains which instance the current checkout points at
- launch history is stored with the resolved instance, not with the repo checkout

## 3. Core entity model

### Company

A company is the top-level security and data boundary.

Important fields:

- `issuePrefix`
- `requireBoardApprovalForNewAgents`
- `defaultManagerPlanningMode`

`defaultManagerPlanningMode` is the fallback governance policy for manager agents:

- `automatic`
- `approval_required`

### Agent

Agents are workers inside a company. They have:

- an adapter type and runtime config
- a role and permissions
- reporting relationships
- an optional `managerPlanningModeOverride`
- a derived `resolvedManagerPlanningMode`

`resolvedManagerPlanningMode` is calculated server-side so routes and the UI do not need to duplicate fallback logic.

### Roadmap item (`goal`)

Roadmap items are the strategy layer. They answer:

- what matters now
- what is next
- what can wait
- how managers should interpret the item when deciding what work to create

Important fields:

- `title`
- `description`
- `guidance`
- `planningHorizon`
- `sortOrder`
- `parentId`

The old "Goals tab" existed to link strategy to projects and issues. After this change, that purpose is explicit:

- the roadmap is the long-horizon queue managers should consult when execution queues are empty
- roadmap items carry manager-facing guidance, not just labels
- parent/child relationships let strategy decompose without losing hierarchy

### Project

Projects are medium-horizon execution containers. They still link to roadmap items using the existing goal fields and join table semantics.

### Issue

Issues are the atomic execution unit. Current invariants still matter:

- single assignee
- checkout-aware execution
- activity logging on mutations
- approval links tracked through `issue_approvals`

For this change set, issue creation also gained optional `approvalId` input so approved manager plans can be attached and enforced at creation time.

### Approval

Approvals are the governance gate for high-trust actions.

Current important types:

- `hire_agent`
- `approve_ceo_strategy`
- `approve_manager_plan`

`approve_manager_plan` is the new bridge between roadmap guidance and governed top-level work creation.

## 4. Request and validation flow

The common request path is:

1. Shared zod schema validates the payload.
2. Route-level authz checks company scope and actor permissions.
3. Services load and normalize data.
4. Mutations write through Drizzle.
5. Activity logging records the action.
6. Follow-up orchestration may wake agents or create linked records.

This matters because the repo intentionally spreads correctness across layers:

- schema and type safety in `packages/shared`
- persistence truth in `packages/db`
- cross-entity invariants in `server`
- operator language and state transitions in `ui`

## 5. Strategy-to-execution flow

The current planning model is:

1. Board or operators create roadmap items.
2. Roadmap items may link to projects.
3. Projects and issues continue to carry legacy `goalId` / `goalIds` references.
4. Manager agents inspect the roadmap when deciding what top-level work to create next.
5. If planning mode is `approval_required`, managers must first obtain an approved `approve_manager_plan`.
6. Approved plan payloads can then authorize top-level issue creation through `approvalId`.

Why the roadmap rename matters:

- the old tab name made the feature look like passive metadata
- the new name makes it explicit that this is the strategic backlog for manager behavior

## 6. Manager planning governance

Manager planning mode now resolves from two layers:

1. Company default:
   - configured in Company Settings
2. Agent override:
   - configured on the specific agent

Resolution order:

- agent override if present
- otherwise company default
- otherwise `automatic`

### Automatic mode

Manager agents may create top-level issues directly when they decide new work should begin.

### Approval-required mode

Manager agents must:

1. create or obtain an `approve_manager_plan`
2. wait for board approval
3. create top-level issues with the approved `approvalId`

Server enforcement currently applies to:

- agent-authenticated top-level issue creation
- only when `parentId` is absent

Sub-issues are exempt so already-approved work can still be decomposed.

### Why this is enforced in `issues` routes

That is the narrowest reliable control point. Manager intent can originate from multiple adapters and prompt styles, but all work creation converges on the same REST mutation.

## 7. Health diagnostics architecture

`GET /api/health` remains the lightweight bootstrap/status endpoint.

`GET /api/health/subsystems?companyId=:id` is the richer diagnostics endpoint for the board UI.

The diagnostics service runs a registry-style snapshot with normalized results:

- database connectivity and migration readiness
- deployment/auth/bootstrap readiness
- `qmd` availability on PATH
- local adapter environment checks for first-party local runtimes

Each check returns:

- `status`
- `summary`
- `detail`
- `hint`
- `blocking`
- `testedAt`

Blocking vs advisory is an intentional distinction:

- database/auth/bootstrap failures should block confidence in the instance
- missing local CLIs or missing `qmd` are degraded but advisory

The dashboard consumes this endpoint through the `System Health` section instead of introducing a separate page.

## 8. Runtime orchestration

Heartbeat execution is still the center of agent runtime behavior.

Relevant supporting systems:

- wakeup queueing through `heartbeat.wakeup(...)`
- runtime session persistence
- checkout-aware workspace resolution
- adapter execution and environment testing
- cost and activity recording

Approval completion feeds back into orchestration:

- approving a manager plan wakes the requesting manager
- the wake payload includes approval and linked-issue context

That keeps governance and execution connected without giving approvals their own independent task engine.

## 9. UI composition and routing

Current important operator routes:

- `/dashboard`
- `/roadmap`
- `/projects`
- `/issues`
- `/agents`
- `/approvals`
- `/briefings/*`
- `/knowledge`

Legacy `/goals*` routes now redirect to `/roadmap*`.

The UI keeps the old query/API client file names in a few places (`goalsApi`, `queryKeys.goals`) because the backend compatibility contract still uses the goal model internally.

## 10. Testing strategy

The repo currently relies on fast Vitest coverage across packages rather than slow end-to-end UI automation for every feature.

This change set added coverage for:

- subsystem health diagnostics service behavior
- health diagnostics route
- roadmap alias routes
- manager planning mode resolution
- approval-required issue creation enforcement
- manager-plan approval wakeup flow
- roadmap route helpers
- system health UI rendering
- manager-plan approval rendering
- planning mode UI labels

The standard verification contract remains:

```bash
pnpm -r typecheck
pnpm test:run
pnpm build
```

## 11. Practical mental model

If you are reviewing the code and need the shortest correct model:

- Company defines the boundary and default governance.
- Agents execute work and may inherit or override planning governance.
- Roadmap items define strategic direction and manager guidance.
- Projects organize roadmap work.
- Issues are the execution units.
- Approvals gate high-trust actions and now also gate governed manager planning.
- Heartbeat/orchestration runs the agents.
- Dashboard and records help humans understand what is happening.
