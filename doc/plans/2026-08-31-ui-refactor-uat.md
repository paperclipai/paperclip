# UI Refactor UAT Script

Date: 2026-08-31
Branch: `codex/core-ui-refactor-082826`
Dataset: `test` company → `UI Refactor UAT` project

Refresh the dataset without creating duplicates:

```sh
node scripts/populate-ui-refactor-uat.mjs
```

## How to record feedback

Copy this block for each finding:

```md
### <short finding title>

- Route/surface:
- Viewport: desktop / compact
- Scenario or task:
- Expected:
- Observed:
- Severity: blocker / major / minor / polish
- Screenshot or recording:
- Requested change:
```

## UAT findings implemented in the current iteration

- `[x]` Add responsive horizontal gutters inside task detail so the main content does not touch either sidebar.
- `[x]` Vertically center the Properties and Subtasks tabs in the right-panel header.
- `[x]` Hide the dedicated Subtasks tab when a task has no children; keep add-first-subtask actions in Relationships and the task overflow menu.
- `[x]` Add Subtasks below Blocking in Relationships, showing `None` when empty and opening a flyout with `Add subtask`.
- `[x]` Remove redundant inline Add label/Add blocker actions; clicking each relationship value opens its flyout.
- `[x]` Remove Timeline from the global left navigation.
- `[x]` Add Timeline beside the List/Kanban view controls on project task pages only.
- `[x]` Contain horizontal thread overflow so no scrollbar appears above the task composer.
- `[x]` Remove the divider to the right of the signed-in user name in the sidebar footer.
- `[x]` Center expanded nested-task guide lines beneath the parent status icon instead of the disclosure caret.
- `[x]` Restore the Agents org-chart view behind an icon toggle beside List view.
- `[x]` Indent each nested task by a full tree step while retaining the parent-status guide axis.
- `[x]` Use one canonical task-row structure across Tasks and Inbox Mine, Recent, Unread, Blocked, and All.
- `[x]` Place the task ID in a fixed column immediately before the fixed rightmost timestamp.
- `[x]` Remove horizontal dividers between task rows and normalize collection spacing.
- `[x]` Append the task ID to the task title in both the task-detail header bar and main content heading.

## Preflight

- `[ ]` Open the [live app](http://localhost:3100/TES/dashboard).
- `[ ]` Open the [Before/After gallery](http://localhost:6006/?path=/story/refactor-review-before-and-after--gallery) in another tab.
- `[ ]` Open the [populated UI Refactor UAT project](http://localhost:3100/TES/projects/ui-refactor-uat/issues).
- `[ ]` Confirm the `UI Refactor UAT` project exists and contains tasks in backlog, todo, in progress, in review, done, blocked, and cancelled states.
- `[ ]` Test once at a wide desktop size and once with the window narrowed to roughly tablet width.

## 1. Global shell and left navigation

- `[ ]` Confirm Recent Tasks contains no more than five items.
- `[ ]` Open tasks from several surfaces and confirm the recent-task order updates correctly.
- `[ ]` Confirm the single Agents link and the Project/Audit destinations are understandable.
- `[ ]` Note whether any remaining navigation item feels duplicated or misplaced.
- `[ ]` Confirm Timeline is absent from the global sidebar.
- `[ ]` Confirm there is no vertical divider immediately to the right of the signed-in user name.

## 2. Populated project task collection

Open `UI Refactor UAT` → Tasks.

- `[ ]` Scan the list without interacting. Record any row whose status, priority, ownership, project, labels, or relationships are unclear.
- `[ ]` Inspect the deliberately long blocked-task title. Confirm truncation preserves useful metadata and does not create horizontal scrolling.
- `[ ]` Compare assigned and unassigned tasks.
- `[ ]` Compare minimal rows with dense multi-label rows.
- `[ ]` Search for `subtask`, `blocked`, and `navigation`; clear search between checks.
- `[ ]` Filter by each status represented in the dataset.
- `[ ]` Filter by priority and assignee.
- `[ ]` Toggle optional columns and reload. Confirm presentation preferences persist.
- `[ ]` Change sort order and confirm the result is visually understandable.
- `[ ]` Switch between List and Kanban; confirm selected state and toolbar geometry remain stable.
- `[ ]` Open Timeline from the project-only view-control group and return to List/Kanban without losing context.
- `[ ]` Expand `TES-3` and confirm each vertical child guide is centered beneath the parent status icon, not the disclosure caret.
- `[ ]` Confirm every child status/title is visibly indented one full step to the right of its parent.
- `[ ]` Confirm IDs form a stable column immediately left of the rightmost timestamp column.
- `[ ]` Confirm there are no horizontal divider lines between task rows.

## 3. Inbox and global Tasks consistency

- `[ ]` Open Inbox and global Tasks in separate tabs.
- `[ ]` Compare toolbar spacing, search behavior, filters, row geometry, and column controls.
- `[ ]` Confirm the routes remain conceptually distinct even though their presentation language is shared.
- `[ ]` Reload both pages and confirm compatible saved preferences remain stable.
- `[ ]` Check empty search results and clear the search.
- `[ ]` Visit Mine, Recent, Unread, Blocked, All, and global Tasks; confirm task rows keep identical left and vertical spacing.
- `[ ]` In every populated view, confirm ID precedes timestamp and timestamp is the rightmost metadata column.
- `[ ]` Confirm Blocked no longer uses bordered legacy rows.
- `[ ]` Confirm unread dots do not shift status icons or titles horizontally.

## 4. Task detail with subtasks

Open [`TES-3 — Prepare the populated task-list experience for design review`](http://localhost:3100/TES/issues/TES-3).

- `[ ]` Confirm the main chat/content column has comfortable gutters from both sidebars.
- `[ ]` Confirm title, metadata, messages, system notices, and composer share a coherent horizontal alignment.
- `[ ]` Confirm the task ID appears immediately after the title in both the top header bar and the main content heading.
- `[ ]` Confirm Properties and Subtasks tabs are vertically centered in the panel header.
- `[ ]` Open Subtasks and confirm the mixed-state progress summary matches its three children.
- `[ ]` Open a child and use Back; confirm the return destination is predictable.
- `[ ]` Collapse and reopen the global sidebar; confirm task detail remains usable.
- `[ ]` Narrow the window and look for clipped controls, unreadable content, or unintended horizontal scrolling.
- `[ ]` Confirm no horizontal scrollbar appears between the transcript and the composer, including with long content.

## 5. Task detail without subtasks

Open [`TES-6 — Verify a task with no subtasks`](http://localhost:3100/TES/issues/TES-6).

- `[ ]` Confirm the dedicated Subtasks tab is hidden.
- `[ ]` In Properties → Relationships, click `Subtasks: None` and confirm the flyout offers `Add subtask`.
- `[ ]` Open the task overflow menu and confirm it also offers `Add subtask`.
- `[ ]` Confirm the right panel defaults to Properties without layout jumping.

## 6. Relationships and blocked state

Open [`TES-4 — the critical blocked task with the long title`](http://localhost:3100/TES/issues/TES-4).

- `[ ]` Confirm the blocked state and critical priority are distinguishable without relying on color alone.
- `[ ]` Confirm the blocker relationship names `Confirm the API contract for bulk task updates`.
- `[ ]` Follow the blocker link and return using Back.
- `[ ]` Confirm the unblock instruction is readable and not visually confused with chat content.

## 7. Contextual navigation

- `[ ]` On Agents, toggle between List and Org chart using the adjacent icon buttons; confirm status tabs and New Agent remain stable.
- `[ ]` Visit one Agent detail view and move between Overview, Instructions, and scoped Audit.
- `[ ]` Visit one Routine detail view and move between Overview and scoped Audit.
- `[ ]` Move between Skills Installed, Discover, and My Skills.
- `[ ]` Visit Settings and Apps/plugin detail pages.
- `[ ]` On each surface, confirm the global sidebar is replaced rather than duplicated and that Back works from direct links.

## 8. Audit hub

- `[ ]` Move among Activity, Runs, Costs, and Budgets.
- `[ ]` Confirm the section names and selected state are unambiguous.
- `[ ]` Follow an Agent- or Routine-scoped Audit link and confirm scope is retained.
- `[ ]` Use Back and confirm the originating entity page is restored.

## 9. Accessibility and resilience pass

- `[ ]` Keyboard through primary navigation, tabs, toolbar controls, rows, dialogs, and the chat composer.
- `[ ]` Confirm focus is visible and follows the visual reading order.
- `[ ]` Check controls at compact width and with long titles.
- `[ ]` Compare light and dark appearance if both themes are available.
- `[ ]` Note unclear icon-only controls, missing labels/tooltips, or color-only state communication.

## Automated self-verification ledger

- `[x]` Focused UI suites pass: 12 files / 279 tests.
- `[x]` UI TypeScript check passes.
- `[x]` UI production build passes.
- `[x]` Storybook production build passes.
- `[x]` All four design-token gates pass across 825 scanned files.
- `[x]` Git diff whitespace check passes.
- `[x]` Live browser smoke confirms no task-composer horizontal scrollbar and no account-footer right border.
- `[x]` Live browser smoke confirms conditional Subtasks tabs, both add-subtask entry points, and exact right-panel tab centering.
- `[x]` Live browser smoke confirms the nested guide is centered beneath the task status icon (0.5 px measured delta).
- `[x]` Live browser smoke confirms Timeline is project-only and retains project scope.
- `[x]` Live browser smoke confirms Agents defaults to List and toggles to the real Org Chart viewport.
- `[x]` Focused collection suites pass: 6 files / 119 tests.
- `[x]` Live parity smoke confirms identical 16 px left / 8 px vertical task-row spacing and 0 px row borders across every populated Tasks/Inbox route.
- `[x]` Live parity smoke confirms fixed ID-before-timestamp ordering with timestamp as the final metadata column.
- `[x]` Live parity smoke confirms a 20 px child indent and 0.5 px guide-to-parent-status center delta.
- `[x]` Live task-detail smoke confirms the title immediately precedes the ID in both heading locations, with no error boundary or overflow regression.

## Completion

- `[ ]` Every finding uses the feedback template.
- `[ ]` Blockers and major issues are separated from polish requests.
- `[ ]` Screenshots identify the route and task when possible.
- `[ ]` The final pass includes both desktop and compact widths.
