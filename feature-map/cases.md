# Cases and structured work records

The cases experiment exposes structured records with types, fields, parent/child relationships, activity, revisions, and related task work.

Implementation: [case list](../ui/src/pages/Cases.tsx), [case detail](../ui/src/pages/CaseDetail.tsx).

## Sub-features

- `browse`: search, filter, sort, group, and navigate case records.
- `structure`: inspect fields and parent/child relationships without losing matching descendants.
- `history`: inspect revisions and activity for a record.
- `task-links`: follow work associated with a case in both directions.

## How to get to it (user POV)

### `case-list`

Open `/cases` and switch between available grouped/tree views.

### `case-record`

Open `/cases/:caseIdentifier` or a task’s linked case.

## Driving it

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Enable cases and prepare related records with different types/statuses plus an associated task.

### `case-list`

Automated: [case list](../ui/src/pages/Cases.test.tsx) covers filters, persisted view state, and keyboard/tree behavior with mocked data.

Manual: Search for a child, verify its parent context remains understandable, change filters/grouping/columns, and reload. Open the record by keyboard and direct link. Include empty results and terminal records.

### `case-record`

Automated: [case routes](../server/src/__tests__/cases-routes.test.ts) covers API behavior; [case fields](../ui/src/components/CaseFieldsPanel.test.tsx) covers field UI separately.

Manual: Edit an offered field, reload, inspect its revision/activity, and follow child and task links. Verify cross-company and invalid field changes fail clearly. Distinguish a pipeline-owned item from a stand-alone case.

## Gotchas

- A case is not a task execution; inspect linked tasks to prove work occurred.
- Feature gating and case-type schema determine which actions are available.
