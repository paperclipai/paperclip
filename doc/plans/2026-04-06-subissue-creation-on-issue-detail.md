# 2026-04-06 Sub-issue Creation On Issue Detail Plan

Status: Proposed
Date: 2026-04-06
Audience: Product and engineering
Related:
- `ui/src/pages/IssueDetail.tsx`
- `ui/src/components/IssueProperties.tsx`
- `ui/src/components/NewIssueDialog.tsx`
- `ui/src/context/DialogContext.tsx`
- `packages/shared/src/validators/issue.ts`
- `server/src/services/issues.ts`

## 1. Purpose

This document defines the implementation plan for adding manual sub-issue creation from the issue detail page.

Requested UX:

- the `Sub-issues` tab should always show an `Add sub-issue` action, even when there are no children yet
- the properties pane should also expose a `Sub-issues` section with the same `Add sub-issue` entry point
- both entry points should open the existing new-issue dialog in a "create sub-issue" mode
- the dialog should only show sub-issue-specific UI when it was opened from one of those entry points

This is a UI-first change. The backend already supports child issue creation with `parentId`.

## 2. Current State

### 2.1 Existing child issue display

`ui/src/pages/IssueDetail.tsx` already derives `childIssues` by filtering the company issue list on `parentId === issue.id`.

Current limitation:

- the `Sub-issues` tab only renders the empty state or the child issue list
- there is no action to create a child issue from that tab

### 2.2 Existing properties pane

`ui/src/components/IssueProperties.tsx` shows `Blocked by`, `Blocking`, and `Parent`, but it has no sub-issue section or child issue affordance.

### 2.3 Existing dialog state

`ui/src/context/DialogContext.tsx` can open the global new-issue dialog with defaults such as status, priority, project, assignee, title, and description.

Current limitation:

- there is no way to pass sub-issue context like `parentId`
- `ui/src/components/NewIssueDialog.tsx` therefore cannot submit a child issue or render parent-specific context

### 2.4 Backend contract already exists

The create-issue validator already accepts `parentId`.

`server/src/services/issues.ts` already uses:

- `parentId` for parent-child issue relationships
- `parentId` as the default workspace inheritance source when `inheritExecutionWorkspaceFromIssueId` is not provided

That means the required API and workspace inheritance behavior already exist. No server or schema change is required for the first pass.

## 3. Proposed Implementation

## 3.1 Extend dialog defaults for sub-issue context

Extend `NewIssueDefaults` in `ui/src/context/DialogContext.tsx` with:

- `parentId?: string`
- optional parent display metadata for the dialog header, for example:
  - `parentIdentifier?: string`
  - `parentTitle?: string`

This keeps the dialog self-contained and avoids re-fetching parent context purely for presentation.

## 3.2 Add issue-detail entry points

Use `openNewIssue(...)` from `ui/src/pages/IssueDetail.tsx` in two places:

1. `Sub-issues` tab
2. properties pane via props passed into `IssueProperties`

Both entry points should pass:

- `parentId: issue.id`
- `parentIdentifier: issue.identifier ?? issue.id`
- `parentTitle: issue.title`
- `projectId: issue.projectId ?? undefined`

Using the current issue's `projectId` preserves the common expectation that sub-issues stay inside the same project unless the operator changes it in the dialog.

No special assignee default should be forced in V1.

## 3.3 Add a dedicated properties-pane section

Extend `IssueProperties` to accept:

- `childIssues: Issue[]`
- `onCreateSubissue: () => void`

Render a new `Sub-issues` section near `Blocked by` / `Blocking`:

- if children exist, show compact links or pills to the existing sub-issues
- always show an `Add sub-issue` button

This keeps the child issue affordance visible in the property area without requiring a generic parent selector.

## 3.4 Update the sub-issues tab layout

Refactor the `Sub-issues` tab in `IssueDetail` to render:

- a small header row with child count
- an `Add sub-issue` button
- the existing empty state or child issue list beneath it

This satisfies the requirement that the action is visible whether or not sub-issues already exist.

## 3.5 Add sub-issue mode to the new-issue dialog

Update `ui/src/components/NewIssueDialog.tsx` so that when `newIssueDefaults.parentId` is present:

- the dialog submits `parentId`
- the header/button copy can switch to `New sub-issue` / `Create sub-issue`
- a compact parent context row is shown, for example `Parent: PAP-1150 add the ability...`

Important constraint:

- this parent context row should only render when the dialog was opened with sub-issue defaults
- opening the dialog from global create actions should remain unchanged and should not expose a generic parent control

That preserves the requested UX boundary: sub-issue creation is intentional, not part of the default create-issue surface.

## 3.6 Query invalidation and refresh behavior

No new data-fetch path is needed.

The existing create success handler in `NewIssueDialog` already invalidates:

- `queryKeys.issues.list(companyId)`
- issue-related list badges

That should be enough for the parent `IssueDetail` view to recompute `childIssues` after creation because it derives children from the company issue list query.

If the detail page ever moves away from the full company issue list, this should be revisited, but it does not require additional work for the current architecture.

## 4. Implementation Order

1. Extend `DialogContext` issue defaults with sub-issue fields.
2. Wire `IssueDetail` to open the dialog in sub-issue mode from the `Sub-issues` tab.
3. Extend `IssueProperties` to display child issues and the `Add sub-issue` action.
4. Update `NewIssueDialog` submission and header UI for sub-issue mode.
5. Add UI tests for the new entry points and payload behavior.

## 5. Testing Plan

Add focused UI tests covering:

1. `IssueDetail`
   - `Sub-issues` tab shows `Add sub-issue` when there are zero children
   - clicking the action opens the dialog with parent defaults

2. `IssueProperties`
   - the properties pane renders the sub-issue section
   - `Add sub-issue` remains available when there are no child issues

3. `NewIssueDialog`
   - when opened with `parentId`, submit payload includes `parentId`
   - sub-issue-specific copy appears only in that mode
   - when opened normally, no parent UI is shown and payload is unchanged

No backend test expansion is required unless implementation discovers a client/server contract gap.

## 6. Risks And Decisions

### 6.1 Parent metadata source

Decision: pass parent label metadata through dialog defaults instead of making `NewIssueDialog` fetch the parent issue.

Reason:

- less coupling
- no loading state inside the dialog
- simpler tests

### 6.2 Project inheritance

Decision: prefill `projectId` from the parent issue, but keep it editable.

Reason:

- matches expected operator behavior
- avoids silently moving a sub-issue outside the current project by default

### 6.3 Keep parent selection out of the generic dialog

Decision: do not add a freeform parent picker in this change.

Reason:

- the request explicitly wants sub-issue controls only when the flow starts from a sub-issue action
- this keeps the default issue creation surface simpler

## 7. Success Criteria

This plan is complete when an operator can:

1. open any issue detail page
2. click `Add sub-issue` from either the `Sub-issues` tab or the properties pane
3. land in the existing new-issue dialog with clear parent context
4. create the child issue and see it appear under the parent without a page reload
