---
title: Seat Rollout Runbook
summary: How to backfill seats, reconcile operating modes, attach humans, and safely roll out the seat model
---

This runbook describes how to operate the seat model rollout in a live Paperclip company.

Use it when:

- enabling the seat model for an existing company
- validating backfill output before users start attaching to seats
- repairing seat mode drift
- onboarding a human operator into a seat
- detaching a human from a seat without orphaning work

## Concepts

- **Seat**: the official org and ownership node
- **Primary agent**: the fallback execution actor for the seat
- **Human operator**: an attached user who can temporarily operate the seat
- **Operating mode**:
  - `vacant`: no human attached
  - `assisted`: human + primary agent
  - `shadowed`: human + shadow agent

## Preconditions

Before rollout:

1. Database migrations `0046_spotless_doop.sql`, `0047_sparkling_lockjaw.sql`, and `0048_tidy_seat_guards.sql` are applied.
2. The company has a valid `CEO Seat` and each active agent can resolve to exactly one seat after backfill.
3. Focused verification suites are green:
   - `@paperclipai/db` seat schema and backfill tests
   - `@paperclipai/server` seat, ownership, portability, budget, and attribution tests
   - `@paperclipai/ui` seat helper tests and typecheck

## Migration Inventory

- `0046_spotless_doop.sql`
  - introduces the initial seat model tables, `agent_execution_bindings`, and the first seat-aware ownership/runtime columns on existing tables
- `0047_sparkling_lockjaw.sql`
  - fills in the seat-aware ownership/runtime follow-up schema
- `0048_tidy_seat_guards.sql`
  - adds post-rollout seat guardrails and follow-up hardening

If any of these are missing, stop and finish the migration stage before touching Org actions.

## Preflight Checklist

Before touching a real company:

1. Run `corepack pnpm --filter @paperclipai/shared typecheck`
2. Run `corepack pnpm --filter @paperclipai/db typecheck`
3. Run `corepack pnpm --filter @paperclipai/ui typecheck`
4. Run `PATH="/tmp/codex-bin:$PATH" corepack pnpm --filter @paperclipai/server typecheck`
5. Run the focused seat suites:
   - `corepack pnpm vitest run packages/db/src/seat-backfill.test.ts packages/db/src/seat-tree.test.ts`
   - `corepack pnpm vitest run server/src/__tests__/seat-service.test.ts server/src/__tests__/seat-routes.test.ts server/src/__tests__/seat-pause.test.ts server/src/__tests__/budgets-service.test.ts server/src/__tests__/company-portability.test.ts`
   - `corepack pnpm vitest run ui/src/lib/seat-actions.test.ts ui/src/lib/seat-members.test.ts ui/src/lib/seat-pause.test.ts ui/src/lib/seat-permissions.test.ts`
6. Confirm the target company has:
   - exactly one active CEO agent or a clear manual decision about which seat should remain CEO
   - no unexpected terminated-agent ownership that would be re-homed silently
   - active user memberships for every operator you plan to attach during validation

## Command Inventory

Primary operator entrypoints:

- UI:
  - Org page `Backfill Seats`
  - Org page `Reconcile Modes`
  - Org / OrgChart `Attach`
  - Org / OrgChart `Detach`
  - Org / OrgChart `Edit Permissions`
- HTTP:
  - `GET /api/companies/:companyId/seats`
  - `GET /api/companies/:companyId/seats/:seatId`
  - `PATCH /api/companies/:companyId/seats/:seatId`
  - `POST /api/companies/:companyId/seats/backfill`
  - `POST /api/companies/:companyId/seats/reconcile-modes`
  - `POST /api/companies/:companyId/seats/:seatId/attach-human`
  - `POST /api/companies/:companyId/seats/:seatId/detach-human`
  - `POST /api/companies/:companyId/seats/:seatId/attach-shadow-agent`
  - `POST /api/companies/:companyId/seats/:seatId/detach-shadow-agent`

Choose UI for staged operator validation. Choose direct HTTP calls when you need auditable, repeatable repair steps.

## Recommended Rollout Sequence

### 1. Backfill seats

From the Org page:

- click `Backfill Seats`

Expected result:

- seat rows are created for active agents
- business ownership columns are backfilled
- warnings, if any, are limited to:
  - user-only assigned issues
  - terminated-agent ownership fallback
  - orphaned reporting relationships

What to check immediately after:

- there is exactly one active `CEO Seat`
- every active agent has a `seat_id`
- every active seat has exactly one active `primary_agent`
- warnings are reviewed before any human operator is attached

If the company is large or you are re-running after a partial repair, prefer one company at a time and do not queue concurrent backfills.

### 2. Reconcile modes

From the Org page:

- click `Reconcile Modes`

Expected result:

- stored `operating_mode` values match active occupancies

Use this whenever:

- a migration was partially applied
- occupancy rows were manually edited
- seat mode display looks inconsistent

This call is safe to re-run. It only repairs stored `operating_mode` from active occupancy truth.

### 3. Inspect org tree

In the Org and OrgChart views, verify:

- each node is a seat-backed org node
- seat type and operating mode badges render correctly
- root and child relationships match expectations
- `Details` actions open seat state without leaving the current surface

### 4. Attach a human operator

From the Org page:

1. Find the target seat
2. Click `Attach`
3. Select an active company member from the picker

Expected result:

- the seat switches to `assisted` or remains `shadowed` if a shadow agent is active
- `currentHumanUserId` is set
- permissions derived from seat policy become available to the user if they have active company membership
- the member list is fetched only when the attach dialog opens

### 5. Edit delegated permissions

From the Org page:

1. Click `Perms` on a seat
2. Toggle the permissions that should be inherited by the seat's active primary agent and human operator

Current supported delegated permission patterns:

- `tasks:assign`
- `tasks:assign_scope`
- `users:invite`
- `users:manage_permissions`
- `agents:create`
- `joins:approve`

Use this for non-CEO seats that need scoped operational authority.

Validation notes:

- delegated permission edits are now activity logged
- CEO seat occupancy still grants the board-grade derived permissions even without delegated entries
- paused seats should show an explicit pause reason or pause stack in seat detail

### 6. Apply or clear an operator pause

From the Org or OrgChart seat detail panel:

1. Click `Pause`
2. Choose either `manual_admin` or `maintenance`
3. Save
4. To clear operator-owned pauses, click `Resume Operator Pause`

Expected result:

- active seats move to `paused`
- budget-owned pauses remain distinct from operator-owned pauses
- clearing an operator pause does not reactivate a seat that is still paused by `budget_enforcement`
- audit log records `seat.paused` and `seat.resumed`

### 7. Detach a human operator

From the Org page:

- click `Detach`

Expected result:

- human occupancy becomes inactive
- any active `shadow_agent` occupancy is deactivated for this seat mode
- seat returns to `vacant`
- user-assigned open issues owned by the seat are reassigned to the fallback primary agent
- if an issue was `in_progress`, it is conservatively moved back to `todo`

## Validation Checklist

After a rollout or repair:

1. Org page loads without errors
2. Backfill and reconcile actions return success
3. Seat badges appear in Org and OrgChart views
4. `Costs` page shows seat budget sections and paused seat counts when seat policies exist
5. `Costs` page shows seat attribution provenance in provider, biller, agent, and project breakdowns
6. A seat-attached human can inherit delegated permissions
7. A detached human leaves no human-only owned open work behind
8. Cost events create seat attribution rows
9. Company portability export includes seat metadata and occupancy metadata
10. Audit log shows attach/detach, delegated permission, backfill, and reconcile actions
11. Paused seats expose the correct reason:
    - `budget_enforcement` for budget-owned pauses
    - `manual_admin` for operator-owned pauses
    - `maintenance` for maintenance holds

## Common Failure Modes

### Backfill produced warnings

Typical warnings:

- user-only issue with no owner seat
- work re-homed from terminated agent
- missing manager during seat tree construction

Action:

- review the warnings
- repair the affected seat or ownership manually
- run `Reconcile Modes` afterward

Repair playbook:

1. Fix the root mismatch first:
   - missing `seat_id` on active agent
   - wrong `ownerSeatId` / `leadSeatId` / `assigneeSeatId`
   - stale `parentSeatId`
2. Re-run `Backfill Seats`
3. Re-run `Reconcile Modes`
4. Verify audit entries exist for both repair actions

### Human attach fails

Likely causes:

- the user does not have active company membership
- the seat id is stale

Action:

- verify membership under access controls
- verify the seat still exists and is active
- verify the seat is not paused for `maintenance`

### Human detach succeeded but work still appears odd

Likely causes:

- the work was not owned by the seat
- the work already had an agent assignee
- the issue was hidden or terminal

Action:

- inspect the issue's `ownerSeatId`, `assigneeUserId`, and `assigneeAgentId`
- repair ownership if needed
- confirm the fallback/default agent is still active
- re-run `Reconcile Modes` if the visual mode does not match the occupancy rows

### Seat pause state looks wrong

Likely causes:

- a budget pause was added on top of an existing manual pause
- a legacy manually paused seat has no explicit pause metadata yet
- maintenance metadata was imported but the seat was resumed manually

Action:

- inspect seat detail for `Pause Reason` and `Pause Stack`
- if the pause is budget-owned, resolve the incident from `Costs`
- if the seat should remain paused for a non-budget reason, keep the seat paused and remove only the budget condition
- if metadata drift is suspected, repair the seat metadata and re-run `Reconcile Modes`

### Seat budgets look wrong

Likely causes:

- cost attribution rows are missing
- the event fell back to `agent_seat` when you expected `issue_owner_seat`
- the event is intentionally `unattributed` because no seat was resolvable at ingest time

Action:

- inspect `cost_event_seat_attributions`
- verify the issue had `ownerSeatId`
- verify the agent had `seatId`
- compare provider, biller, agent, and project provenance breakdowns in the `Costs` page

## Rollback Guidance

If rollout causes unacceptable confusion or data quality issues:

1. Stop new attach/detach operations
2. Continue reading legacy ownership fields in emergency tooling if needed
3. Re-run `Reconcile Modes`
4. Review backfill warnings and seat attribution gaps
5. If required, disable seat-driven operational workflows while leaving schema in place

Do not delete seats as a first response. Prefer stabilizing state and falling back operationally.

Rollback decision tree:

1. UI-only confusion with correct underlying data:
   - stop operator mutations
   - re-run `Reconcile Modes`
   - validate with the walkthrough before reopening
2. Ownership drift but seat rows are sound:
   - repair ownership
   - re-run `Backfill Seats`
   - re-run `Reconcile Modes`
3. Seat hierarchy or occupancy corruption:
   - stop attach/detach
   - repair the corrupted seat/occupancy rows
   - re-run `Backfill Seats`
   - re-run `Reconcile Modes`
4. Broad production instability:
   - disable seat-driven workflows operationally
   - keep schema in place
   - use compatibility read paths until the repair window is ready

## Staging Walkthrough

Use the companion checklist in [seat-rollout-walkthrough.md](./seat-rollout-walkthrough.md) for a step-by-step staging validation pass that covers Org, OrgChart, Costs, portability, and repair flows.
