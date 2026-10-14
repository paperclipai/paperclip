---
navigation: {"section":"Tasks and conversations","sectionOrder":20,"order":70}
---

# Documents, attachments, and work products

People read and revise task documents, annotate specific content, open attached files, and inspect the outputs an agent hands back. The artifact library provides another route to the same work.

Implementation: [task documents](../../ui/src/components/IssueDocumentsSection.tsx), [artifact library](../../ui/src/pages/Artifacts.tsx), [document panel](../../ui/src/components/task-side-panel/TaskDocumentPanel.tsx).

Agent access: [companion](../agent-access-map/documents-artifacts.md).

## Sub-features

- `documents`: edit versioned task documents and inspect or restore revisions.
- `annotations`: attach feedback to document content and inspect resolution state.
- `attachments`: upload, preview, and download allowed files with company access checks.
- `work-products`: link deliverables to their source task, resource, and review context.
- `library`: search, filter, group, and open artifact stacks.

## How to get to it (user POV)

### `task-document`

Open a document from the task thread or document side panel.

### `task-output`

Open an attachment, output card, or file link from a task.
For direct uploads, use the task side panel's **Open a new tab → Artifacts →
Upload files** or drop files anywhere in that panel. On mobile, open
**More actions → Properties** first. Agent conversations do not expose this upload path.

### `artifact-library`

Open `/artifacts` and its grouping, search, and media controls.

## Driving it with Playwright and the Paperclip CLI

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Use a task with a text document, a small attachment, and a generated work product. Use nonsensitive fixture files.

### `task-document`

Automated: [documents service](../../server/src/__tests__/documents-service.test.ts), [annotations](../../server/src/__tests__/document-annotations-service.test.ts), and [revision restore](../../server/src/__tests__/issue-document-restore-routes.test.ts) cover server contracts.

Manual: Edit a paragraph, save, reload, and compare revisions. Add an annotation to a specific selection and inspect it after another edit. Resolve it through the supported action. Restore a disposable revision and confirm the new current document and history agree.

### `task-output`

Automated: [attachment routes](../../server/src/__tests__/issue-attachment-routes.test.ts) and [work products](../../server/src/__tests__/work-products.test.ts) cover data/access behavior; [artifact arrival browser suite](../../tests/e2e/artifact-tab-arrival.spec.ts) targets arrival. [Artifact uploads](../../tests/e2e/artifact-uploads.spec.ts) drives file selection/drop, filename collisions, retry, and preservation of paused/unassigned tasks.

Manual: Upload a small Markdown file and CSV through Artifacts. Markdown becomes
a versioned task document; other files become attachments. Read the document,
download the CSV and compare bytes, then reload. Upload the same Markdown filename
again and verify a separate suffixed document without overwriting the original.
On a paused unassigned task, confirm upload does not start work or add comments.
Verify agent-produced work products separately using an eligible test run.
Test an inaccessible user/company and explicit missing workspace-only resources.

### `artifact-library`

Automated: [artifact page](../../ui/src/pages/Artifacts.test.tsx) covers grouping, search requests, and pagination using mocks.

Manual: Find the task’s output through search and grouping, open its stack, page through results, and reload a direct stack link. Confirm the same file/content appears as from the task.

## Gotchas

- A local path is not automatically an uploaded artifact accessible to another user.
- A preview screenshot is not proof that download bytes or revision references are correct.
- Version conflicts and stale annotations must stay visible rather than silently targeting different content.

### Storybook verification

#### `documents`

Scope: ui
Storybook: Writable/read-only document, save pending/failure/conflict, revision history/historical preview and restore confirmation.
Production: Persist edited body and reload; append-only restore creates new revision; reject stale writes and inaccessible company/task.
Sources: Source: [IssueDocumentsSection.tsx](../../ui/src/components/IssueDocumentsSection.tsx), [TaskDocumentPanel.tsx](../../ui/src/components/task-side-panel/TaskDocumentPanel.tsx), [documents.ts](../../server/src/services/documents.ts). Tests: [IssueDocumentsSection.test.tsx](../../ui/src/components/IssueDocumentsSection.test.tsx), [document-revisions.test.ts](../../ui/src/lib/document-revisions.test.ts), [documents-service.test.ts](../../server/src/__tests__/documents-service.test.ts), [issue-document-restore-routes.test.ts](../../server/src/__tests__/issue-document-restore-routes.test.ts)

### Documentation scope: Artifacts and work products

Document/attachment/library/work-product journeys are mapped; every media preview type, storage backend, annotation conflict, and runtime-resource lifecycle variant remains separate.
