---
navigation: {"section":"Automation and structured work","sectionOrder":60,"order":30}
---

# Cases

The cases experiment exposes structured records with types, fields, parent/child relationships, activity, revisions, and related task work.

Implementation: [case list](../../ui/src/pages/Cases.tsx), [case detail](../../ui/src/pages/CaseDetail.tsx).

Agent access: [companion](../agent-access-map/cases.md).

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

## Driving it with Playwright and the Paperclip CLI

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Enable cases and prepare related records with different types/statuses plus an associated task.

### `case-list`

Automated: [case list](../../ui/src/pages/Cases.test.tsx) covers filters, persisted view state, and keyboard/tree behavior with mocked data.

Manual: Search for a child, verify its parent context remains understandable, change filters/grouping/columns, and reload. Open the record by keyboard and direct link. Include empty results and terminal records.

### `case-record`

Automated: [case routes](../../server/src/__tests__/cases-routes.test.ts) covers API behavior; [case fields](../../ui/src/components/CaseFieldsPanel.test.tsx) covers field UI separately.

Manual: Change status or labels, reload, inspect activity, and follow child/task
links. Edit a case document and inspect its document revisions separately.
Arbitrary JSON fields are currently displayed without a general field editor.
Verify cross-company and invalid changes fail clearly.

## Gotchas

- A case is not a task execution; inspect linked tasks to prove work occurred.
- Feature gating and offered controls determine available actions. The API
  accepts a string case type and arbitrary JSON fields; do not infer typed
  case-field validation or a field-editing UI from those values.

### Storybook verification

#### `browse`

Scope: ui
Storybook: Mount Cases search/filter/sort/group/tree, matched-child parent context, persisted view choices, keyboard navigation and empty/loading/error.
Production: GET /companies/{id}/cases scope/filter behavior is production evidence; rendered fixtures establish presentation only. Mutation/permission scenarios need real API checks separately.
Sources: Source: [Cases.tsx](../../ui/src/pages/Cases.tsx), [cases.ts](../../server/src/routes/cases.ts). Tests: [Cases.test.tsx](../../ui/src/pages/Cases.test.tsx), [cases-routes.test.ts](../../server/src/__tests__/cases-routes.test.ts)

#### `structure`

Scope: ui
Storybook: Mount CaseDetail and CaseFieldsPanel with arbitrary JSON fields and parent/children, matching descendants and unavailable child. Do not invent a general field editor or typed field validation.
Production: GET /cases/{id} must return permitted company records and correct relationships; changes/persistence require route tests separately.
Sources: Source: [CaseDetail.tsx](../../ui/src/pages/CaseDetail.tsx), [CaseFieldsPanel.tsx](../../ui/src/components/CaseFieldsPanel.tsx), [Cases.tsx](../../ui/src/pages/Cases.tsx), [cases.ts](../../server/src/routes/cases.ts). Tests: [CaseFieldsPanel.test.tsx](../../ui/src/components/CaseFieldsPanel.test.tsx), [Cases.test.tsx](../../ui/src/pages/Cases.test.tsx), [CaseDetail.test.tsx](../../ui/src/pages/CaseDetail.test.tsx), [cases-routes.test.ts](../../server/src/__tests__/cases-routes.test.ts)

#### `history`

Scope: ui
Storybook: Mount CaseDetail activity and document revisions as distinct views, empty/loading/errors, attribution and source links.
Production: GET /cases/{id}/events and /cases/{id}/documents/{key}/revisions require company/access filtering; a fixture list does not establish durable revision creation or restoration.
Sources: Source: [CaseDetail.tsx](../../ui/src/pages/CaseDetail.tsx), [cases.ts](../../server/src/routes/cases.ts). Tests: [CaseDetail.test.tsx](../../ui/src/pages/CaseDetail.test.tsx), [cases-routes.test.ts](../../server/src/__tests__/cases-routes.test.ts)

#### `task-links`

Scope: ui
Storybook: Mount CaseDetail and IssueCasesPanel related-task/case links in both directions, missing links and unavailable targets.
Production: GET /issues/{id}/cases and GET /cases/{id} must enforce permitted task/case relationships; production browser cold links verify destination and company context.
Sources: Source: [CaseDetail.tsx](../../ui/src/pages/CaseDetail.tsx), [IssueCasesPanel.tsx](../../ui/src/components/IssueCasesPanel.tsx), [cases.ts](../../server/src/routes/cases.ts). Tests: [IssueCasesPanel.test.tsx](../../ui/src/components/IssueCasesPanel.test.tsx), [CaseDetail.test.tsx](../../ui/src/pages/CaseDetail.test.tsx), [cases-routes.test.ts](../../server/src/__tests__/cases-routes.test.ts)
