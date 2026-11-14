---
navigation: {"section":"Automation and structured work","sectionOrder":60,"order":30}
---

# Cases

First-task kickoff may supply `initialDocuments`; these are ordinary task
documents, saved before the assignee wakes. The read-only case page surfaces
authorized primary/linked task documents and their revisions with their task
origin. Historical case-owned documents remain readable; no document copies or
editing controls are introduced. Native `create_case` requires kickoff and
creates the first task before dispatch; missing kickoff creates nothing.
Either `workflowId` or `workflow_document_text` becomes the task's ordinary Markdown `workflow`
document. Agents read it on demand; its reference is prioritized in bounded
context. Authoring guidance recommends both a Mermaid `stateDiagram-v2` map and
prose explaining each transition's conditions, evidence, agent and wait/retry
rules, without server transition parsing.

The cases experiment exposes structured records with types, fields, parent/child relationships, revisions, and related task work. Work appears above Details in one column. Details use a compact monospace key/value table: nested objects become dotted leaf paths, singleton object arrays omit the redundant index (`items.quantity`), and multiple object-array entries retain their indices (`items[0].quantity`). Primitive arrays remain inline JSON; scalar task/case/URL references remain links. Case changes live in Audit, accessible through a case-scoped link and the Cases action/Case entity filters.

Feature ID: `cases`.

Implementation: [case list](../../ui/src/pages/Cases.tsx), [case detail](../../ui/src/pages/CaseDetail.tsx).

Agent access: [companion](../agent-access-map/cases.md).

## Sub-features

- `browse`: `cases/browse` — search, choose visible columns, filter by status/type/project, sort/group, and navigate read-only case records.
- `structure`: `cases/structure` — read saved fields, documents, attachments, and parent/child relationships.
- `history`: `cases/history` — inspect document revisions and case changes in the shared Audit view, with actor avatars and case/action filters.
- `task-links`: `cases/task-links` — follow work associated with a case in both directions.
- `handoffs`: `cases/handoffs` — move the same primary task between agents and inspect its phase and handoff history.

## How to get to it (user POV)

### `case-list`

Open Cases in the company sidebar (`/:companyPrefix/cases`). The task-style header has Search and four icon controls: Columns, Filter (with an active-filter count), Sort and Group. Filter opens status/type/project choices, including No project. Sort offers updated/created/title/status/type and toggles direction; Group offers none/status/type/project. Open a row; the breadcrumb returns to the same filters and view. Cases have no Kanban or New case control.

### `case-record`

Open `/cases/:caseIdentifier` or a task’s linked case.

## Driving it with Playwright and the Paperclip CLI

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Enable cases and prepare related records with different types/statuses plus an associated task.

### `case-list`

Automated: [case list](../../ui/src/pages/Cases.test.tsx) covers the four header controls, read-only column visibility, URL filters/view state, server sort/group queries before pagination, group headers, detail/back navigation and loading/failure with mocked data.

Provider-free browser regression: [cases read-only journey](../../tests/e2e/cases-read-only.spec.ts) seeds passive cases, nested objects, singleton/multiple object arrays, a related unassigned task and two document revisions through production APIs, then checks column visibility, server-backed title sorting/type grouping, Filter popover/count, semantic key/value table rows and dotted paths, Work-before-Details layout, document revision previews, case-scoped Audit history/action filtering and return navigation in Chromium. It creates no agents. Run `env -u DATABASE_URL -u DATABASE_MIGRATION_URL pnpm exec playwright test --config tests/e2e/playwright.config.ts tests/e2e/cases-read-only.spec.ts --project chromium` on an unused `PAPERCLIP_E2E_PORT`. The existing harness starts an isolated instance; this journey does not qualify agent handoffs or live agent avatars.

Manual: Hide/show a field through Columns, choose a sort/direction, group by type/status/project, then use Filter for status/type/project including No project. Verify the badge counts active selectors. Open a row and return through the breadcrumb; reload to verify URL filters, columns, sort and grouping remain. Use keyboard and touch controls; include empty results, terminal cases, loading, and retry after a list failure. If there are more results, use Next/Previous without losing the view.

### `case-record`

Automated: [case routes](../../server/src/__tests__/cases-routes.test.ts) covers API behavior; [case fields](../../ui/src/components/CaseFieldsPanel.test.tsx) covers field UI separately.

Manual: Inspect Work above Details in one column. Read nested values as compact dotted key/value rows; a singleton item has `items.quantity`, while multiple items use `items[0].quantity` and `items[1].quantity`. Verify keys/values remain legible on mobile without horizontal page overflow and scalar references still link to their destinations. Preview a document, inspect its revisions, and close with Escape; focus returns to the document link. Follow View in Audit to the case's retained history; filter by Cases actions or Case entities in Audit and verify agents use their configured avatars. Read attachments, follow parent/child/task links, and inspect a passive case. Case pages have no editing controls, including status, labels, documents, or handoff retry/cancel. Verify inaccessible cases fail clearly and remain distinct from pipeline-owned items.

### `case-handoff`

Reusable company workflows have only a name and Markdown prompt plus ordinary
identity/attribution. Agent/API authoring shares the Cases flag. Work shows the
current workflow; pending intent shows the next name/phase; expanded handoffs and
Audit retain names captured before renames. Switch A → B → A, refresh the current
ID, or detach with null while retaining one primary task and document history.
Shared edits affect future adoptions, and intervening case-document edits hold a
pending adoption for recovery instead of being overwritten. Workflow authoring
screens, graph execution and deletion lifecycle are deferred.

Evidence for this extension: 2026-10-21 real-database and authenticated native-tool
integration checks pass. The extended arithmetic Product E2E oracle requires
adopted prompt markers and persisted transitions; registration alone is not live
provider evidence.

Start a standalone case through the agent's `handoff_case` operation or the case-handoff REST API. Open its existing case record and follow its primary task. Check that the phase and current assignee are distinct from a pending recipient. Each handoff includes a link to the same primary task; expand its history to inspect instructions. A blocked handoff shows its known reason without implying that the recipient is running. Recovery remains available through authorized APIs and existing task controls.

The final agent may hand off to `done`. While ordinary task completion is pending, the case remains open and shows that it will close when the task completes. Accepted completion closes the case and records a completed terminal handoff. Review and user waits do not close it. Case pages remain read-only.

Automated: shared schema tests, case route privacy tests, case handoff service/delivery tests, native lifecycle tests, and `CaseDetail.test.tsx` exercise their individual boundaries. The registered explicit-only case-handoffs Product E2E suite covers the full native journey; registration is not a live pass.

Manual: hand the task through implementation, verification, and correction. Its ID, workspace, thread, and review gates must remain stable. Repeat a request and restart delivery; neither may duplicate work. Try private cases with an unauthorized actor and verify documents, assets, activity, and handoff history remain inaccessible.

Force local scratch preparation to fail, then let the source adapter exit while
a child with closed output streams continues writing. The recipient must remain
pending until the owned process group stops; a fresh delivery worker must then
recover the same intent without repeating the source run. Create terminal intent
from the board and stop the current execution, including a pending native retry:
later task completion must leave the case open. Repeating Stop for an older run
must preserve a newer execution's terminal intent.

With generic API tools disabled, use native `read_case` to open a historical
case document and a linked task document using `section: "document"`,
`documentKey`, and the linked task's `documentIssueId` where applicable. Recover
the full body through bounded JSON pages. Edit the document between pages and
verify a snapshot conflict; unlink the task or revoke source access and verify
further reads fail. System and quarantined documents must remain inaccessible.

While a transfer awaits source release, change its recipient's assignment policy
or revoke the caller's assignment grant. The worker must retain the pending
handoff without changing the task owner or phase or waking the recipient. Restore
the permission and verify that the same receipt can proceed without duplicate
comments or tasks. Internal authorization context must not appear in public
history, retry, or cancellation responses.

In Cloud, verify that a stack owner with owner elevation enabled can complete a
permitted delayed transfer. Disable that setting or change the current stack
role before release, then verify that the transfer observes the new authority.
An unavailable portfolio lookup must leave the transfer pending for recovery.

Small live smoke: select only
`case-handoffs.runner-codex-subscription.local.receipt-smoke` in Product E2E.
Three agents use four bounded runs to save, review, and correct a tiny case receipt
on the same task. Two API-seeded passive cases exercise read-only list filters;
the browser reads the saved document, its revisions and handoff history. The
independent oracle checks actual native document reads and revision attribution.
See [fixture and limits](../../tests/runner-e2e/README.md#persistent-case-handoffs-explicit-only).

## Gotchas

- A case is not a task execution; inspect linked tasks to prove work occurred.
- Feature gating and offered controls determine available actions. The API
  accepts a string case type and arbitrary JSON fields; do not infer typed
  case-field validation or a field-editing UI from those values.
- Cases can exist without a primary task. A phase name does not approve a review or complete either the task or case. Work begins only after normal execution admission; a queued wake is not a running agent.

### Storybook verification

#### `browse`

Capability ID: `cases/browse`.

Scope: ui
Storybook: Mount the production Cases page in its real shell: Columns/Filter/Sort/Group header controls, URL view state, search/status/type/project filters, No project, result paging, list-to-detail return, keyboard navigation and empty/loading/error recovery. The ListControls story changes columns, title sorting and type grouping using fixture query responses.
Production: GET /companies/{id}/cases and /cases/types scope/filter behavior and ordering before pagination require production evidence; rendered fixtures establish presentation only. Mutation/permission scenarios need real API checks separately.
Sources: Source: [Cases.tsx](../../ui/src/pages/Cases.tsx), [cases.ts](../../server/src/routes/cases.ts). Tests: [Cases.test.tsx](../../ui/src/pages/Cases.test.tsx), [cases-routes.test.ts](../../server/src/__tests__/cases-routes.test.ts)

#### `structure`

Capability ID: `cases/structure`.

Scope: ui
Storybook: Mount read-only CaseDetail and CaseFieldsTable with nested objects, singleton/multiple object arrays and scalar reference links in a compact monospace key/value table, alongside documents, attachments, parent/children and unavailable references. Dotted leaf paths omit the index for a singleton object array and retain it for multiple entries. CaseDetail shows Work above Details in one column. The older CaseFieldsPanel arbitrary/empty examples retain their generic component scope. Do not invent a general field editor or typed field validation.
Production: GET /cases/{id} and the parent-filtered case list must return permitted company records and correct relationships; changes/persistence require route tests separately.
Sources: Source: [CaseDetail.tsx](../../ui/src/pages/CaseDetail.tsx), [CaseFieldsPanel.tsx](../../ui/src/components/CaseFieldsPanel.tsx), [Cases.tsx](../../ui/src/pages/Cases.tsx), [cases.ts](../../server/src/routes/cases.ts). Tests: [CaseFieldsPanel.test.tsx](../../ui/src/components/CaseFieldsPanel.test.tsx), [Cases.test.tsx](../../ui/src/pages/Cases.test.tsx), [CaseDetail.test.tsx](../../ui/src/pages/CaseDetail.test.tsx), [cases-routes.test.ts](../../server/src/__tests__/cases-routes.test.ts)

#### `history`

Capability ID: `cases/history`.

Scope: ui
Storybook: Mount CaseDetail's View in Audit link with the case UUID query scope, and document revisions. Preserve the historical ActivityHistory export/ID for its Audit-navigation example. The destination Audit feed is a separate production surface, not reproduced in the case fixture shell.
Production: The case-scoped Audit query must include retained historical case events, enforce the same case access boundary, and deduplicate events also recorded in the activity log. Case/Case action filters and configured agent avatars need real Audit/browser checks. GET /cases/{id}/events and /cases/{id}/documents/{key}/revisions still require company/access filtering; fixtures do not establish durable creation, privacy or restoration.
Sources: Source: [CaseDetail.tsx](../../ui/src/pages/CaseDetail.tsx), [cases.ts](../../server/src/routes/cases.ts). Tests: [CaseDetail.test.tsx](../../ui/src/pages/CaseDetail.test.tsx), [cases-routes.test.ts](../../server/src/__tests__/cases-routes.test.ts)

#### `task-links`

Capability ID: `cases/task-links`.

Scope: ui
Storybook: Mount CaseDetail and IssueCasesPanel related-task/case links in both directions, missing links and unavailable targets.
Production: GET /issues/{id}/cases and /cases/{id}/issue-links must enforce permitted task/case relationships; production browser cold links verify destination and company context.
Sources: Source: [CaseDetail.tsx](../../ui/src/pages/CaseDetail.tsx), [IssueCasesPanel.tsx](../../ui/src/components/IssueCasesPanel.tsx), [cases.ts](../../server/src/routes/cases.ts). Tests: [IssueCasesPanel.test.tsx](../../ui/src/components/IssueCasesPanel.test.tsx), [CaseDetail.test.tsx](../../ui/src/pages/CaseDetail.test.tsx), [cases-routes.test.ts](../../server/src/__tests__/cases-routes.test.ts)

#### `handoffs`

Capability ID: `cases/handoffs`.

Scope: ui
Storybook: Read-only pages and CaseWorkSummary mount production task/phase/history with waiting and paused-recipient API fixtures. No handoff mutation controls are exposed on these pages.
Production: POST /companies/{id}/case-handoffs and GET /cases/{id}/handoffs require company/task authorization, retained-source privacy, observed revisions, and durable admission. Retry/cancel retain task-control authority. Native and legacy provider/workspace settlement require runtime evidence.
Sources: Source: [CaseWorkSummary.tsx](../../ui/src/components/cases/CaseWorkSummary.tsx), [case-handoffs.ts](../../server/src/services/case-handoffs.ts), [case-handoff-delivery.ts](../../server/src/services/case-handoff-delivery.ts). Tests: [CaseDetail.test.tsx](../../ui/src/pages/CaseDetail.test.tsx)
