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

1. Database migrations `0046_spotless_doop.sql` and `0047_sparkling_lockjaw.sql` are applied.
2. The company has a valid `CEO Seat` and each active agent can resolve to exactly one seat after backfill.
3. Focused verification suites are green:
   - `@paperclipai/db` seat schema and backfill tests
   - `@paperclipai/server` seat, ownership, portability, budget, and attribution tests
   - `@paperclipai/ui` seat helper tests and typecheck

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

### 2. Reconcile modes

From the Org page:

- click `Reconcile Modes`

Expected result:

- stored `operating_mode` values match active occupancies

Use this whenever:

- a migration was partially applied
- occupancy rows were manually edited
- seat mode display looks inconsistent

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
3. Enter the user id

Expected result:

- the seat switches to `assisted` or remains `shadowed` if a shadow agent is active
- `currentHumanUserId` is set
- permissions derived from seat policy become available to the user if they have active company membership

### 5. Edit delegated permissions

From the Org page:

1. Click `Perms` on a seat
2. Toggle the permissions that should be inherited by the seat's active primary agent and human operator

Current supported delegated permission patterns:

- `tasks:assign`
- `users:invite`
- `users:manage_permissions`
- `agents:create`
- `joins:approve`

Use this for non-CEO seats that need scoped operational authority.

### 6. Detach a human operator

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

### Human attach fails

Likely causes:

- the user does not have active company membership
- the seat id is stale

Action:

- verify membership under access controls
- verify the seat still exists and is active

### Human detach succeeded but work still appears odd

Likely causes:

- the work was not owned by the seat
- the work already had an agent assignee
- the issue was hidden or terminal

Action:

- inspect the issue's `ownerSeatId`, `assigneeUserId`, and `assigneeAgentId`
- repair ownership if needed

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
