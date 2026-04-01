---
title: Seat Rollout Walkthrough
summary: Step-by-step staging validation for the seat model rollout
---

Use this document after the seat-model migrations are applied and before enabling operator traffic on a real company.

## Scope

This walkthrough covers:

1. seat backfill and mode reconciliation
2. Org attach, detach, and delegated permission edits
3. OrgChart seat detail and action parity
4. Costs seat drill-down and attribution provenance
5. portability round-trip with seat occupancy data

## Required Setup

Before starting:

- pick one staging company with a stable agent graph
- ensure at least one active user membership exists for attach/detach validation
- ensure cost events exist for at least one seat-owned issue so the Costs drill-down is meaningful
- keep browser devtools and server logs open while you validate

## Scripted Verification

Run these before the manual pass:

```bash
corepack pnpm vitest run \
  packages/db/src/seat-backfill.test.ts \
  packages/db/src/seat-tree.test.ts \
  server/src/__tests__/seat-service.test.ts \
  server/src/__tests__/seat-routes.test.ts \
  server/src/__tests__/seat-pause.test.ts \
  server/src/__tests__/budgets-service.test.ts \
  server/src/__tests__/company-portability.test.ts \
  ui/src/lib/seat-actions.test.ts \
  ui/src/lib/seat-members.test.ts \
  ui/src/lib/seat-pause.test.ts \
  ui/src/lib/seat-permissions.test.ts
```

Expected outcome:

- all focused suites pass

Failure signatures:

- `seat_backfill` warnings or ownership assertions failing
- route tests missing `seat.backfill_executed`, `seat.modes_reconciled`, or `seat.delegated_permissions_updated`
- portability tests dropping seat pause or occupancy metadata

## Walkthrough 1: Backfill And Reconcile

Steps:

1. Open `Org`
2. Click `Backfill Seats`
3. Wait for the success toast
4. Click `Reconcile Modes`
5. Refresh the page once

Expected outcome:

- seat tree loads without empty-root regressions
- success toasts show created/updated counts
- every active seat has a valid `Details` panel
- audit log includes one `seat.backfill_executed` and one `seat.modes_reconciled`

Failure signatures:

- backfill toast shows repeated unresolved owner warnings
- `Reconcile Modes` updates an unexpectedly large number of seats on every rerun
- Org and OrgChart disagree on operating mode after refresh

## Walkthrough 2: Org Attach, Detach, And Permissions

Steps:

1. Pick a non-CEO seat with an active default agent
2. Open `Details`
3. Click `Attach`
4. Select an active company member
5. Confirm the seat moves to `assisted`
6. Click `Edit Permissions`
7. Enable `tasks:assign`
8. Save and refresh
9. Click `Detach`

Expected outcome:

- attach dialog only lists active user memberships
- seat detail shows the attached human user id
- delegated permission changes persist after refresh
- detach returns the seat to `vacant`
- if open work was human-assigned, the fallback reassignment count is visible in the success toast
- audit log includes `seat.human_attached`, `seat.delegated_permissions_updated`, and `seat.human_detached`
- opening Org alone does not issue a company-members permission query until `Attach` is opened

Failure signatures:

- attach dialog accepts a user not present in company membership
- delegated permissions save but disappear after refresh
- detach leaves `currentHumanUserId` populated
- detached work still shows `assigneeUserId` without a fallback agent
- the page emits a members-list 403 before the attach dialog is opened

## Walkthrough 3: Operator Pause Management

Steps:

1. Open seat detail in `Org`
2. Click `Pause`
3. Choose `maintenance`
4. Save and refresh
5. Click `Resume Operator Pause`

Expected outcome:

- seat status changes to `paused`
- `Pause Reason` and `Pause Stack` show the operator-owned reason
- resume clears operator-owned pause reasons only
- if a budget pause is also present, the seat remains paused after operator resume

Failure signatures:

- pause action only changes metadata but not `status`
- resume clears `budget_enforcement` accidentally
- Org and OrgChart disagree about the current pause stack

## Walkthrough 4: OrgChart Parity

Steps:

1. Open `OrgChart`
2. Click the same seat from Walkthrough 2
3. Compare seat detail with the `Org` page
4. Trigger `Attach` or `Edit Permissions` from OrgChart
5. Refresh and reopen the seat

Expected outcome:

- OrgChart detail shows the same slug, status, pause reason, pause stack, and delegated permissions as Org
- attach and permission dialogs behave identically to Org
- query invalidation keeps both surfaces consistent after mutation

Failure signatures:

- OrgChart detail omits pause reason while Org shows it
- one surface updates while the other shows stale delegated permissions
- mutation toasts or validation rules differ between Org and OrgChart

## Walkthrough 5: Costs Seat Drill-Down

Steps:

1. Open `Costs`
2. Click a seat-scoped budget card or paused seat summary
3. Open the seat detail sheet
4. Compare the seat status, pause reason, and pause stack with `Org`
5. Inspect provider, biller, agent, and project provenance breakdowns

Expected outcome:

- seat sheet shows the same pause ownership as Org/OrgChart
- budget-owned pauses read as `budget_enforcement`
- attribution provenance is explainable from either `issue_owner_seat`, `agent_seat`, or an explicitly `unattributed` event

Failure signatures:

- Costs shows a paused seat but `Org` shows `active`
- budget incident exists but the seat sheet reports a non-budget pause reason
- attribution rows are missing for clearly seat-owned cost events

## Walkthrough 6: Portability Round-Trip

Steps:

1. Export the staging company portability bundle
2. Confirm `.paperclip.yaml` contains seat metadata for one representative agent
3. Import the bundle into a disposable company
4. Open `Org` in the imported company
5. Validate occupancies, parent seat links, and pause reason fields

Expected outcome:

- exported manifest contains seat slug, type, status, operating mode, occupancy, and pause fields
- import restores primary agent, human occupancy, and shadow occupancy where present
- imported paused seats preserve their pause ownership

Failure signatures:

- import reassigns the wrong primary agent
- human occupancy is dropped even though the target company has the membership
- paused seats import as generic `paused` without a reason or stack

## Repair Pass

If any walkthrough fails:

1. stop new attach/detach operations for the staging company
2. capture the exact seat id, user id, and failing surface
3. repair the underlying data
4. re-run `Backfill Seats`
5. re-run `Reconcile Modes`
6. verify the expected audit log entry exists for the repair action
7. repeat only the failed walkthrough section before continuing
