# Tasks created from a task

Run `pnpm --filter @paperclipai/ui exec storybook dev -p 6017 -c storybook/.storybook --no-open`.
Open **UX Labs → Tasks Created From a Task → Full Task Page**.

The stories render production `Layout`, `IssueDetail`, `TaskSidePanel` and
`TaskDetailTasksPanel` with illustrative fixtures based on PAP-1953. They use no
replica shell or custom CSS. Task and project links navigate to real page
components backed by local fixtures.

## Membership

- Subtasks includes the existing subtask tree, regardless of creator or run.
- Project and No project groups contain tasks created by runs originating from
  the current task, regardless of current parentage. Created subtasks appear in
  both sections. Deduplication applies within each section, not between them.
- Fixtures cover both legacy and native runs, a subtask created elsewhere, an
  unrelated task by the same agent, and a created task without a project.
- Unfinished tasks sort before done and cancelled tasks. Only Subtasks shows a
  progress bar. Empty Subtasks sections are omitted.
- Sections fold independently. Carets follow the heading text; project links sit
  at the far right. Controls fade on hover or focus using reduced-motion-aware
  tokens. There are no project icons, tab counts, search or collection controls.
- First Task Appears demonstrates the tab arriving without replacing the Plan tab.

## Production integration

`GET /api/companies/:companyId/issues?createdFromIssueId=<uuid>` projects creation
provenance through `issues.originRunId` and the originating heartbeat run. Native
runs use `nativeIssueId`; legacy/historical runs fall back to the persisted
`issueId`, `taskId`, or `taskKey` context. The source, run and results must belong
to the requested company. When the origin run is absent, recorded issue creation activity can recover its
run. Comments and shared creators are never used to infer attribution.
The normal issue creation service persists the actor run when no explicit origin
run was provided, including the legacy child helper. Native creation already
provides its run. No schema migration or runner-mode distinction is needed.

The real issue page queries this projection alongside its existing subtask query.
Both queries page by immutable task ID with an afterId cursor so task activity
and removal of earlier rows do not shift later pages. Existing company issue-list invalidation refreshes both on task activity. Errors
remain visible with a Retry action. Historical rows without either an origin run or attributed creation activity
cannot be attributed and are not included in project groups.
