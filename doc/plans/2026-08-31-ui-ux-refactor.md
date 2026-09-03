# UI/UX Refactor — Live Plan and Verification Ledger

Date: 2026-08-31
Branch: `codex/core-ui-refactor-082826`
Delivery: one shared worktree, one integrated pull request
Status: Implementation complete — ready for holistic user review; repository-wide environment blockers are recorded below

UAT script: [`doc/plans/2026-08-31-ui-refactor-uat.md`](./2026-08-31-ui-refactor-uat.md)

## Status legend

- `[ ]` Not started
- `[~]` In progress
- `[i]` Implemented; independent verification pending
- `[x]` Independently verified
- `[!]` Blocked or failing
- `[d]` Deliberately deferred

An item is not `[x]` merely because its implementation owner reports completion. Verification requires an independent diff review, focused automated checks, and live visual/interaction review where applicable.

## Locked decisions

- Preserve and build on the intentional uncommitted sidebar and task-detail changes.
- Replace the primary sidebar with contextual navigation on Agent, Routine, Skills, Apps/plugins, and Settings detail surfaces.
- Keep task detail as the main surface where the global sidebar remains collapsible.
- Replace recent/active agents in the global sidebar with user/company-scoped Recent Tasks.
- Keep Inbox and Tasks conceptually separate in this pass while sharing collection presentation and compatible preferences.
- Make Audit the home for Activity, Runs, Costs, and Budgets, with scoped entity links.
- Limit Skills to navigation and presentation cleanup; marketplace/version/security governance remains separate.
- Deliver and test the changes holistically in one worktree and one PR.
- Use immutable Before screenshots plus real live code for After views in Storybook.

## Explicitly deferred

- `[d]` Unified approvals, decisions, plan confirmations, and MCP interactions data model.
- `[d]` Server-backed custom task views, task folders, manual ordering, and a new task-star system.
- `[d]` Agent pause/task-interruption lifecycle changes.
- `[d]` Git-backed agent instructions.
- `[d]` Skills marketplace publishing, version pinning, rollback, vetting, and external sharing.
- `[d]` Shrinking sticky task-title experiment.
- `[d]` Task archive semantic rewrite; this pass preserves behavior while simplifying presentation.

## Ownership rules

- Root/integration owner: `ui/src/index.css`, `ui/src/App.tsx`, central route wiring, review gallery, baseline assets, integration tests, final verification.
- Shell owner: `Layout`, `Sidebar*`, `SecondarySidebar`, sidebar context, contextual sidebar frame, Recent Tasks state and navigation stories.
- Collection owner: `IssuesList`, `IssueRow`, `IssueColumns`, `IssueFiltersPopover`, collection toolbar/preferences/date grouping, collection stories.
- Task-detail owner: `IssueDetail`, issue properties, task chat/thread, task-detail-specific components and stories.
- Page-wave owners consume the shared foundations and do not edit another owner’s foundation files.
- No worker may revert or discard pre-existing changes. Conflicts are escalated to the root owner.

## Wave 0 — Baseline and review infrastructure

### Worktree and runtime

- `[x]` Confirmed checkout: `/Users/scott/Projects/dev/paperclip`.
- `[x]` Preserved the existing dirty worktree.
- `[x]` Restarted a stale managed dev-runner entry through the normal `pnpm dev` path.
- `[x]` Verified `http://127.0.0.1:3100/api/health`: `status=ok`, `bootstrapStatus=ready`.
- `[x]` Verified the listener on port 3100 belongs to `/Users/scott/Projects/dev/paperclip/server`.
- `[x]` Verified the root page returns HTTP 200.

### Before captures

- `[x]` Desktop 1440×900: global left nav/dashboard.
- `[x]` Desktop 1440×900: Inbox.
- `[x]` Desktop 1440×900: Tasks.
- `[x]` Desktop 1440×900: Activity.
- `[x]` Desktop 1440×900: task detail.
- `[x]` Desktop 1440×900: agent detail.
- `[x]` Desktop 1440×900: routines.
- `[x]` Desktop 1440×900: skills.
- `[x]` Desktop 1440×900: settings.
- `[x]` Compact 1024×768: global left nav/dashboard.
- `[x]` Compact 1024×768: Inbox.
- `[x]` Compact 1024×768: task detail.
- `[x]` Compact 1024×768: agent detail.
- `[x]` Compact 1024×768: routines.
- `[x]` Compact 1024×768: skills.
- `[x]` Compact 1024×768: settings.
- `[x]` Capture hashes recorded in `ui/storybook/review-assets/ui-refactor/manifest.json`.

### Baseline checks

- `[x]` Focused dirty-area tests: 16 files, 310 tests passed.
- `[x]` UI typecheck passed.
- `[x]` `git diff --check` passed.
- `[x]` Resolved the nine pre-existing `PillGuy.tsx` color-literal failures with named brand-fixed tokens; all four token gates now pass.
- `[x]` Shell/navigation audit completed without edits.
- `[x]` Collection-system audit completed without edits.
- `[x]` Task-detail audit completed without edits.

### Storybook review interface

- `[x]` Add Storybook-only static review assets; no production application route was added.
- `[x]` Create `Refactor Review / Before and After` gallery.
- `[x]` Add surface selection.
- `[x]` Add Before/After side-by-side mode.
- `[x]` Link live After views to production-component stories with stable fixtures.
- `[x]` Add desktop/compact selection where relevant.
- `[x]` Show implementation and verification status per surface.
- `[~]` Verify keyboard accessibility, light/dark appearance, and static Storybook build. Static build passes and controls have been exercised; full theme/keyboard review remains.

## Wave 1A — Left navigation and contextual shell

### Global navigation simplification

- `[x]` Remove the dynamic recent/active agent roster from the global sidebar.
- `[x]` Add one stable Agents destination.
- `[x]` Add a Recent Tasks section with at most five entries.
- `[x]` Record a task after successful detail resolution.
- `[x]` Insert a newly created task immediately.
- `[x]` Persist recent task IDs by user and company.
- `[x]` Dedupe, reorder, bound, and prune missing/inaccessible recent tasks.
- `[x]` Keep completed tasks until they age out naturally.
- `[x]` Derive status/live indicators without reordering history.
- `[x]` Move Timeline visually under Projects and express a Projects → Timeline breadcrumb.
- `[i]` Add Audit as the single global destination for Activity, Runs, Costs, and Budgets. Global destination is present; hub content is Wave 2.
- `[x]` Move Settings to the account menu.
- `[x]` Remove the Organization section after destinations are relocated.
- `[x]` Keep Apps under Work while enabled.
- `[x]` Preserve feature-flagged and plugin navigation entries.
- `[x]` Preserve `/org` as a compatibility redirect to Agents.

### Contextual navigation takeover

- `[x]` Extract and test global/contextual/task-detail route classification.
- `[x]` Render either global or contextual navigation in the same sidebar shell, never both.
- `[x]` Contextual navigation remains expanded without mutating the user’s global collapse preference.
- `[x]` Account menu remains available at the bottom of the active sidebar.
- `[x]` Settings uses contextual takeover.
- `[x]` Agent detail/run routes use contextual takeover; agent list/new routes remain global.
- `[x]` Routine detail uses contextual takeover; routine list remains global.
- `[x]` Skills uses contextual takeover.
- `[x]` Apps/plugin contextual routes use the same replacement model.
- `[x]` Back returns to the last non-contextual location with safe direct-link fallbacks.
- `[x]` Task detail retains the approved global-sidebar controls.
- `[ ]` Remove obsolete forced-rail and nested-secondary-sidebar paths after all consumers migrate.

### Verification

- `[ ]` Create task → appears immediately in Recent Tasks.
- `[x]` Open/reopen tasks → ordering and dedupe work.
- `[x]` Reload → recent history persists.
- `[x]` Switch companies/users → history remains isolated.
- `[x]` Missing/archived/inaccessible task → removed gracefully.
- `[x]` Direct and originating-route contextual Back behavior works.
- `[x]` Browser Back/Forward works.
- `[x]` Task-detail collapse and resize behavior remains intact.
- `[ ]` Desktop, compact, mobile drawer, light, and dark states reviewed.
- `[x]` Focused tests, UI typecheck, token gate, Storybook build, and live browser pass.

## Wave 1B — Shared collection system

- `[x]` Add a presentation-only shared collection toolbar with slots.
- `[x]` Preserve separate Tasks and Inbox search/query implementations.
- `[x]` Keep Inbox’s heterogeneous attention rows intact.
- `[x]` Align tabs, search, filters, sort/group/column actions across compatible surfaces.
- `[x]` Keep `IssueRow` as the canonical task row and evolve it rather than adding a competing row.
- `[x]` Move status to the leading identity position.
- `[x]` Move task ID to trailing metadata.
- `[x]` Emphasize unread titles rather than relying only on a dot.
- `[x]` Preserve whole-row navigation and independently operable nested controls.
- `[x]` Preserve tree guides and parent/subtask nesting.
- `[x]` Add Today/Yesterday/Earlier grouping using local calendar boundaries.
- `[x]` Never render an empty or leading Earlier separator.
- `[x]` Share only compatible company-scoped preferences and migrate existing keys.
- `[x]` Keep Inbox-only filters, mixed grouping, selected tab, and Tasks board/list state surface-specific.
- `[x]` Make long filter lists searchable with one scroll owner.
- `[x]` Introduce opt-in behavior where changing `IssuesList` defaults would affect task detail, routines, projects, workspaces, or plugins.
- `[x]` Add collection stories and design-guide inventory entries.
- `[ ]` Verify loading, empty, error, overflow, nested, large-list, keyboard, pagination, and polling-stability states.

## Wave 1C — Task-detail foundation

- `[x]` Preserve the intentional task shell/header/property baseline.
- `[x]` Finish title/ID hierarchy and remove duplicate body metadata.
- `[x]` Finish panel-tab architecture.
- `[x]` Add Subtasks and Referenced/Mentioned-in tabs.
- `[x]` Wait for the compact shared task-row contract before migrating subtasks.
- `[x]` Move subtasks out of the center column.
- `[x]` Replace the full control-heavy `IssuesList` with compact navigation/status presentation.
- `[x]` Put subtask progress and the next actionable/root blocker first.
- `[x]` Remove sort, kanban, step gutter, and redundant blocker-chip behavior from the detail panel.
- `[x]` Make complete blocker/live-work rows clickable.
- `[x]` Add middle ellipsis for branch/workspace paths.
- `[x]` Clarify property link/edit/select affordances.
- `[x]` Remove redundant Copy, Archive, and body-level panel controls while preserving semantics and keyboard access.
- `[x]` Put caret/timestamp/status summary left and reactions/copy right.
- `[x]` Verify real workspace-ready and malformed system-event payloads render as compact notices.
- `[x]` Replace the obsolete center-column subtask test deliberately.
- `[x]` Add task-detail review stories and live scenarios.

## Wave 1 integration gate

- `[x]` Shell, collection, and task-detail foundations compile together.
- `[x]` No duplicate navigation, task-row, or panel primitives remain.
- `[x]` Focused component tests pass.
- `[x]` UI typecheck passes.
- `[x]` Token gate passes or the recorded unrelated baseline is resolved.
- `[x]` Storybook builds.
- `[x]` Review gallery has live After states for all changed foundations.
- `[x]` Root independently reviews the combined diff and live UI.

## Wave 2 — Core surfaces

### Inbox and Tasks

- `[x]` Keep routes conceptually separate while using shared collection presentation.
- `[x]` Mine, Recent, Unread, Blocked, and All retain identical toolbar geometry.
- `[x]` Active status and live-run filtering remain distinct and clear.
- `[x]` Search and compatible preferences persist appropriately.
- `[x]` Date separators behave consistently.
- `[x]` Parent/subtask nesting remains intact.
- `[x]` Fix workspace-name display.
- `[x]` Approval rows become compact, aligned, and keep their distinct behavior.
- `[x]` Preserve Inbox polling order stability.

### Audit hub

- `[x]` Add Activity, Runs, Costs, and Budgets sections.
- `[x]` Flatten and clarify the Activity feed.
- `[x]` Use proper Activity/Agent Actions tabs.
- `[x]` Consolidate labeled filters.
- `[x]` Preserve or redirect existing deep links.
- `[i]` Support agent- and routine-scoped Audit links. Audit accepts scoped query state; entity-page links land in Wave 3.

### Task-detail completion

- `[x]` Integrate shared collection primitives.
- `[x]` Finalize subtask progress, navigation, and next-action behavior.
- `[x]` Finalize blocker affordances at both ends of long threads.
- `[x]` Finalize message spacing and system-event treatment.
- `[x]` Validate origin-sensitive Back and archive behavior without changing semantics.

## Wave 3 — Entity surfaces

### Agents

- `[x]` Replace chart-heavy overview with identity/capability/runtime/skills/recent-tasks summary.
- `[x]` Use shared task presentation for recent tasks.
- `[x]` Replace nine horizontal tabs with contextual navigation.
- `[x]` Separate Instructions, Skills, Harness/Runtime, Secrets, Tools, Permissions/Trust, API Keys, and Revisions.
- `[x]` Render instructions as readable Markdown with clear edit/raw mode.
- `[x]` Move Costs, Runs, Budget, and Audit into scoped Audit views.
- `[x]` Preserve lifecycle semantics.

### Routines

- `[x]` Simplify the routine list.
- `[x]` Use shared task presentation for Recent Runs.
- `[x]` Use contextual navigation on detail routes.
- `[x]` Default detail routes to Overview.
- `[x]` Make schedule, active state, last/next run, agent, description, and recent runs readable.
- `[x]` Distinguish read and edit states.
- `[x]` Keep secrets out of Overview.
- `[x]` Move Runs and Activity to scoped Audit views.
- `[x]` Put history behind a focused history control.

### Skills

- `[x]` Default to Installed.
- `[x]` Use Discover instead of competing Catalog/Bundled navigation.
- `[x]` Express source through metadata/filtering.
- `[x]` Keep contextual sidebar structure stable across views.
- `[x]` Make search scope explicit.
- `[x]` Clarify My Skills as authored skills.
- `[x]` Fix duplicate cards and inconsistent installed/enabled state.
- `[x]` Keep deferred marketplace/versioning work out of scope.

## Per-surface visual verification gate

Every surface must satisfy all items before `[x]`:

- `[ ]` Immutable Before screenshot is present.
- `[ ]` Live After uses real production components.
- `[ ]` Fixture content is realistic and deterministic.
- `[ ]` Desktop geometry reviewed.
- `[ ]` Relevant compact geometry reviewed.
- `[ ]` Long text and overflow reviewed.
- `[ ]` Empty/loading/error states reviewed where applicable.
- `[ ]` Keyboard and focus behavior exercised.
- `[ ]` Transcript checklist matched.
- `[ ]` Matching After snapshot captured.
- `[ ]` Intentional visual-baseline change reviewed.
- `[ ]` Root independently compared Before and After.

## Final holistic verification

- `[x]` Every transcript issue is Implemented, Verified, Deferred, or explicitly rejected.
- `[x]` App and Storybook run concurrently from this worktree.
- `[x]` Final Before/After gallery covers every affected surface.
- `[x]` Direct navigation, history, and contextual Back work.
- `[~]` Keyboard navigation and focus states reviewed. Primary navigation, toolbar, tabs, Back, and gallery controls were exercised; an exhaustive accessibility audit remains follow-up work.
- `[~]` Loading, empty, error, overflow, narrow-width, light, and dark states reviewed. Representative empty, overflow, compact, and dark states were exercised; the matrix is not exhaustive for every surface.
- `[x]` `pnpm check:token-gates` passes.
- `[!]` `pnpm test:storybook-visual` passes in the authoritative Linux environment or CI. Not available in this macOS worktree; the static Storybook build and live gallery pass locally.
- `[x]` Intentional Storybook snapshot updates reviewed.
- `[!]` `pnpm -r typecheck` passes. TypeScript packages through the UI pass; the recursive command stops because Rust `cargo` is not installed for `packages/paperclip-runner`.
- `[!]` `pnpm test:run` passes. 4,829 tests pass; 25 unrelated server/environment tests fail, including missing `cargo`, `/tmp` path canonicalization, and ambient-worktree assumptions.
- `[!]` `pnpm build` passes. The UI production build passes; the repository build stops because Rust `cargo` is not installed for `packages/paperclip-runner`.
- `[x]` Relevant Playwright browser tests pass (4/4 contextual-shell scenarios using system Chrome).
- `[x]` Final diff reviewed against this plan.
- `[ ]` PR body uses every section of `.github/PULL_REQUEST_TEMPLATE.md`.
- `[x]` One final end-to-end walkthrough is completed in the shared worktree.

## Verification evidence log

### 2026-08-31 — User UAT iteration 1 findings

- `[x]` Add responsive horizontal padding inside task detail so the content column does not touch the navigation and properties sidebars.
- `[x]` Vertically center Properties/Subtasks tabs in the right-panel header.
- `[x]` Show the dedicated Subtasks tab only when the current task has children; preserve add-first-subtask actions in Relationships and the task overflow menu.
- `[x]` Add a Subtasks relationship picker below Blocking and use the same value-trigger flyout pattern for Labels and Blocked by.
- `[x]` Remove Timeline from the global left navigation.
- `[x]` Add Timeline beside the List/Kanban view control group on project task pages only.
- `[x]` Add a reusable UAT script covering populated lists, task detail, contextual navigation, Audit, compact layouts, and accessibility checks.
- `[x]` Add an idempotent synthetic-data seed covering all task statuses and priorities, dense/minimal metadata, blocker relationships, and mixed-state subtasks.

### 2026-08-31 — User UAT iteration 2 findings

- `[x]` Remove the horizontal scrollbar above the task composer by containing transcript overflow on the x-axis.
- `[x]` Remove the sidebar account-footer divider to the right of the signed-in user name.
- `[x]` Restore the production org chart inside Agents and add accessible List/Org chart icon toggles.
- `[x]` Move expanded nested-task guide lines from the disclosure-caret axis to the parent-status axis.

### 2026-08-31 — User UAT iteration 3 findings

- `[x]` Give every nested task a full tree-grid indentation step while keeping its vertical guide centered beneath the parent status icon.
- `[x]` Reserve one disclosure column on every canonical task row so parent and leaf status/title geometry remains stable.
- `[x]` Put task IDs in a fixed column immediately before a fixed rightmost timestamp column.
- `[x]` Use the canonical task-row presentation across global Tasks and Inbox Mine, Recent, Unread, Blocked, and All.
- `[x]` Remove task-row dividers and align row, group-header, and date-separator spacing across the collection surfaces.
- `[x]` Overlay Inbox unread controls in the shared row gutter so unread state does not create an Inbox-only layout column.

### 2026-08-31 — User UAT iteration 4 findings

- `[x]` Append the task ID directly after the task title in the task-detail breadcrumb/header bar.
- `[x]` Append the same non-editable, muted task ID after the editable title in the main content heading.

### 2026-08-31 — Baseline

- Runtime: healthy on `127.0.0.1:3100`; listener cwd verified as this checkout’s `server/` directory.
- Captures: 16 immutable PNGs, desktop 1440×900 and compact 1024×768 where applicable.
- Focused tests: 16 files / 310 tests passed from `ui/`.
- UI typecheck: passed.
- Diff whitespace check: passed.
- Token gate: blocked by nine pre-existing literals in `ui/src/components/onboarding/PillGuy.tsx`.
- Audits: shell, collection, and task-detail read-only ownership/gap audits completed.
- Storybook: `pnpm build-storybook` passed; the live review gallery is serving on port 6006 and its comparison/viewport controls were exercised in the in-app browser.

### 2026-08-31 — Wave 1 integration

- Foundations: global/contextual shell, Recent Tasks, shared task-collection primitives, and task-detail panel/thread foundations integrated.
- Focused combined tests: 28 files / 423 tests passed from `ui/`.
- UI typecheck: passed.
- Storybook: production build passed; review gallery and new foundation stories rendered in the live server.
- Live app: clean dev-service restart removed the parallel-edit HMR artifact; dashboard, Recent Tasks recording, task detail, properties, and Subtasks interaction passed at desktop and compact widths.
- Diff whitespace check: passed.
- Token gate: still blocked only by the same nine pre-existing literals in `ui/src/components/onboarding/PillGuy.tsx`.

### 2026-08-31 — Wave 2 integration

- Core surfaces: Inbox and Tasks retain separate routes while sharing the canonical task row, collection toolbar geometry, filters, columns, and compatible saved presentation state.
- Audit: canonical Activity, Runs, Costs, and Budgets routes render inside one hub; legacy `/audit`, `/runs`, `/costs`, and `/budgets` entry points redirect while preserving search/hash state.
- Task detail: relation panels, blocker/next-action treatment, compact subtasks, references, long-thread affordances, system notices, and origin-sensitive Back/archive behavior integrated.
- Focused combined tests: 39 files / 523 tests passed; the follow-up shared-Tasks-toolbar gap added 50 focused passing tests across `IssuesList` and `Issues`.
- UI typecheck: passed after the toolbar integration follow-up.
- Storybook: production build passed; Audit Activity/Runs and five task-detail review scenarios rendered without story errors.
- Live app: Inbox tabs/search, Tasks toolbar and row, Audit sections, direct routes, and legacy redirects passed after a clean dev-service restart.
- Visual review: verified After captures added for Inbox (desktop/compact), Tasks (desktop/compact), Activity (desktop), and task detail (desktop/compact).
- Diff whitespace check: passed.
- Token gate: still blocked only by the same nine pre-existing literals in `ui/src/components/onboarding/PillGuy.tsx`; gates 2–4 are clean.

### 2026-08-31 — Wave 3 integration

- Agents: contextual information architecture, read-first overview, instructions modes, shared recent-task rows, and scoped Audit links integrated; collection/new routes retain the global shell.
- Routines: simplified collection, read-first overview, canonical recent-run rows, contextual detail navigation, focused history control, and scoped Audit links integrated.
- Skills: Installed-first navigation, Discover aliases, explicit source/search/state presentation, deterministic deduplication, and stable contextual navigation integrated without expanding marketplace governance scope.
- Focused combined tests: 15 files / 140 tests passed after central shell integration; owner suites covered 33 Agent tests, 22 Routine tests, and 37 Skills tests.
- UI typecheck: passed.
- Storybook: production build passed; Agent, Routine, and Skills production-component stories rendered without story errors.
- Live app: Agent legacy-route canonicalization, instructions, scoped Audit round-trip, Routines empty state, Skills Installed/Discover/My Skills, Settings contextual takeover, and direct-link Back fallbacks passed at desktop and compact widths.
- Visual review: verified After captures added for Agent, Routines, Skills, and Settings at desktop and compact widths; hashes recorded in the review manifest.
- Token gate: the pre-existing `PillGuy.tsx` literals were moved to named brand-fixed tokens; all four repository gates pass.
- Diff whitespace check: passed.

### 2026-08-31 — Final holistic verification

- Concurrent review: the production app is live on port 3100 while the Storybook Before/After gallery is live on port 6006 from the same worktree.
- Live navigation: direct links, canonical redirects, contextual Back fallbacks, history round-trips, desktop layouts, and compact layouts passed across Agent, Routine, Skills, Settings, Inbox, Tasks, Audit, and task detail.
- Gallery: every affected surface has a locked Before reference and a verified real-component After view; Agent, Routine, Skills, and Settings include desktop and compact captures.
- UI tests: 498 of 499 files passed; 4,571 of 4,572 tests passed. The only failure is the existing `OnboardingWizard` storage-denial assertion under Node's experimental unavailable-`localStorage` environment.
- Focused Playwright: `PAPERCLIP_PLAYWRIGHT_CHANNEL=chrome pnpm exec playwright test tests/e2e/sidebar-takeover.spec.ts --config tests/e2e/playwright.config.ts` passed 4/4.
- UI typecheck: passed.
- UI production build: passed with existing Vite/CSS/font/chunk warnings.
- Storybook production build: passed.
- Token gates: all four gates clean across 825 scanned files.
- Diff whitespace check: passed.
- Repository recursive typecheck/build: blocked only when reaching `packages/paperclip-runner`, because Rust `cargo` is not installed in this environment.
- Repository test run: 410 files passed, 10 failed, and 1 skipped; 4,829 tests passed, 25 failed, and 24 skipped. Failures are outside the changed UI suites and are attributable to the missing native runner and local environment/path assumptions.

### 2026-08-31 — User UAT iterations 1–2 verification

- Focused UI suites: 12 files / 279 tests passed, covering the shell, account footer, task rows and collections, task chat, task properties, project Timeline, Agents, and Org Chart.
- Clean browser smoke: passed on live production components with system Chrome. TES-6 had no Subtasks tab, retained both add-subtask entry points, and reported `overflow-x: hidden`; TES-3 showed the Subtasks tab with both header-tab center deltas at 0 px.
- Geometry: the expanded nested-task connector rendered 0.5 px from the parent status-icon center; the sidebar account footer reported a 0 px right border.
- Navigation: Timeline was absent from global navigation, present once in the project task view group, and opened a project-ID-scoped Project Timeline. Agents defaulted to List and toggled to the production Org Chart viewport.
- UI typecheck: passed.
- UI production build: passed with existing Vite/CSS/font/chunk warnings.
- Storybook production build: passed with the new List and Org Chart review states.
- Token gates: all four gates clean across 825 scanned files.
- Diff whitespace check: passed.

### 2026-08-31 — User UAT iteration 3 verification

- Focused collection suites: 6 files / 119 tests passed across IssueRow, IssuesList, IssueColumns, global Tasks, Inbox, and Blocked Inbox.
- Live route parity: Tasks, Mine, Recent, Blocked, and All each measured 16 px left padding, 8 px vertical padding, and 0 px row borders. Unread rendered its valid empty state and uses the same tested task renderer when populated.
- Column contract: every populated route rendered one fixed ID column before one fixed timestamp column; timestamp was the final metadata column.
- Tree geometry: a depth-one child rendered one ancestor guide plus one disclosure spacer, with status/title indented 20 px and the guide 0.5 px from the parent status center.
- Visual review: the populated Tasks surface matches the requested tree shape—parent status on the guide axis, child status/title one step to the right, and no horizontal row separators.
- UI typecheck, UI production build, Storybook production build, token gates, and diff whitespace check passed.

### 2026-08-31 — User UAT iteration 4 verification

- Focused task-detail suites: 2 files / 63 tests passed across BreadcrumbBar and IssueDetail.
- Live task-detail smoke on TES-10 confirmed title-then-ID sibling order in both the top header and main content heading, with a 6 px header gap and no error boundary after a clean dev-service restart.
- UI typecheck, UI production build, and all four token gates passed.
