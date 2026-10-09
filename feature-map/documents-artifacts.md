# Documents, attachments, and work products

People read and revise task documents, annotate specific content, open attached files, and inspect the outputs an agent hands back. The artifact library provides another route to the same work.

Implementation: [task documents](../ui/src/components/IssueDocumentsSection.tsx), [artifact library](../ui/src/pages/Artifacts.tsx), [document panel](../ui/src/components/task-side-panel/TaskDocumentPanel.tsx).

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

### `artifact-library`

Open `/artifacts` and its grouping, search, and media controls.

## Driving it

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Use a task with a text document, a small attachment, and a generated work product. Use nonsensitive fixture files.

### `task-document`

Automated: [documents service](../server/src/__tests__/documents-service.test.ts), [annotations](../server/src/__tests__/document-annotations-service.test.ts), and [revision restore](../server/src/__tests__/issue-document-restore-routes.test.ts) cover server contracts.

Manual: Edit a paragraph, save, reload, and compare revisions. Add an annotation to a specific selection and inspect it after another edit. Resolve it through the supported action. Restore a disposable revision and confirm the new current document and history agree.

### `task-output`

Automated: [attachment routes](../server/src/__tests__/issue-attachment-routes.test.ts) and [work products](../server/src/__tests__/work-products.test.ts) cover data/access behavior; [artifact arrival browser suite](../tests/e2e/artifact-tab-arrival.spec.ts) targets the arrival experience.

Manual: Upload a fixture and have the test task produce an output. Preview and download each, compare the contents, and follow the source task link. Reload and test an inaccessible user/company; verify missing workspace-only resources have an explicit state.

### `artifact-library`

Automated: [artifact page](../ui/src/pages/Artifacts.test.tsx) covers grouping, search requests, and pagination using mocks.

Manual: Find the task’s output through search and grouping, open its stack, page through results, and reload a direct stack link. Confirm the same file/content appears as from the task.

## Gotchas

- A local path is not automatically an uploaded artifact accessible to another user.
- A preview screenshot is not proof that download bytes or revision references are correct.
- Version conflicts and stale annotations must stay visible rather than silently targeting different content.
