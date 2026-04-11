# neurOS macOS Parity Matrix

Date: 2026-04-10
Reference branch for macOS app analysis: `refactor/central-operacoes-ui-ux`

## Goal

Record the current parity status between the existing web product surface in `ui/src/pages` and the native macOS app currently implemented under `apps/neuros-macos` on `refactor/central-operacoes-ui-ux`.

This document is intentionally evidence-based. It reflects what is actually implemented in code, not what is implied by naming or roadmap intent.

## Method

- Web surface source: `ui/src/pages/*.tsx`
- macOS surface source: `apps/neuros-macos/Sources/**/*` on `refactor/central-operacoes-ui-ux`
- Supporting scope docs:
  - `apps/neuros-macos/README.md`
  - `doc/DEVELOPING.md`
  - `doc/plans/2026-04-10-neuros-macos-native-foundation.md`

Status terms:

- `implemented`: a native macOS section exists with meaningful interaction depth matching the core use case of the web surface
- `partial`: some native coverage exists, but important list/detail/create/settings flows are still missing
- `not_started`: no meaningful native surface found
- `n/a`: not counted toward parity because it is a fallback/test/dev-only route

## Evidence Snapshot

The current macOS navigation defined in `NavigationSection.swift` is:

- `operations`
- `inbox`
- `activity`
- `goals`
- `queue`
- `agents`
- `projects`
- `approvals`
- `runtime`
- `plugins`
- `organization`
- `settings`

The current native detail routing in `RootSplitView.swift` maps those sections to:

- `OperationsHomeView`
- `InboxSectionView`
- `ActivitySectionView`
- `GoalsSectionView`
- `QueueSectionView`
- `AgentsSectionView`
- `ProjectsSectionView`
- `ApprovalsSectionView`
- `RuntimeSectionView`
- `PluginsSectionView`
- `OrganizationSectionView`
- `SettingsView`

Notable real interactive consoles already present on macOS:

- approval detail, comments, and decision actions
- plugin health, logs, enable/disable, and upgrade actions
- project workspace runtime start/stop/restart actions

## Coverage Summary

Grouped product capabilities counted in this matrix: 16

- `implemented`: 2
- `partial`: 10
- `not_started`: 4

Interpretation:

- The macOS app already has a real native operational shell.
- It is beyond a placeholder prototype.
- It is not yet at full product parity with the web app.
- The strongest implemented areas are `Operations` and `Approvals`.
- The largest missing areas are `Costs`, `Routines`, auth/onboarding, and design/developer utility surfaces.

## Parity Matrix

| Product capability | Web pages | macOS coverage | Status | Evidence |
|---|---|---|---|---|
| Operations dashboard | `Dashboard.tsx` | `OperationsHomeView` with metrics, health, queue, projects, agents, runtime summaries | implemented | `OperationsHomeView.swift`, `OperationsPanels.swift` |
| Issues and operational queue | `Issues.tsx`, `IssueDetail.tsx`, `MyIssues.tsx` | `QueueSectionView` lists issues and key metrics, but no dedicated issue detail or personal issue flow | partial | `QueueSectionView` in `OperationsPanels.swift` |
| Agents | `Agents.tsx`, `AgentDetail.tsx`, `NewAgent.tsx` | `AgentsSectionView` shows operational list/state/budget summaries, but no native agent detail or creation flow | partial | `AgentsSectionView` in `OperationsPanels.swift` |
| Projects and workspaces | `Projects.tsx`, `ProjectDetail.tsx`, `ProjectWorkspaceDetail.tsx`, `ExecutionWorkspaceDetail.tsx` | `ProjectsSectionView` supports project selection, workspace loading, and runtime controls, but not full project/workspace detail parity | partial | `ProjectsSectionView` and `WorkspaceDetailCard` in `OperationsPanels.swift` |
| Approvals | `Approvals.tsx`, `ApprovalDetail.tsx` | Native queue plus approval detail, payload, linked issues, comments, and decision actions | implemented | `ApprovalsSectionView` in `OperationsPanels.swift` |
| Runtime and instance health | `ExecutionWorkspaceDetail.tsx`, `RunTranscriptUxLab.tsx` | `RuntimeSectionView` covers health and signals; runtime actions exist inside project workspaces; transcript/lab tooling is absent | partial | `RuntimeSectionView`, `ProjectsSectionView` |
| Plugins and adapters | `PluginManager.tsx`, `PluginPage.tsx`, `PluginSettings.tsx`, `AdapterManager.tsx` | `PluginsSectionView` covers installed plugins, health, logs, enable/disable, upgrade; no native adapter manager or plugin settings/editor surface found | partial | `PluginsSectionView` in `OperationsPanels.swift` |
| Companies and organization | `Companies.tsx`, `CompanyImport.tsx`, `CompanyExport.tsx`, `CompanySettings.tsx`, `CompanySkills.tsx`, `Org.tsx`, `OrgChart.tsx` | `OrganizationSectionView` shows active company and company summaries only; no import/export/settings/skills/org-chart flows | partial | `OrganizationSectionView` in `OperationsPanels.swift` |
| Instance settings | `InstanceSettings.tsx`, `InstanceGeneralSettings.tsx`, `InstanceExperimentalSettings.tsx` | `SettingsView` supports connectivity, runtime preference, launch-at-login, notifications, and diagnostics, but not the full instance settings surface | partial | `SettingsView.swift` |
| Inbox and async work intake | `Inbox.tsx` | native inbox triage now exists over approvals, recent issues, and runtime signals, but without the full web filtering/archive/read workflow | partial | `InboxSectionView` |
| Goals and goal hierarchy | `Goals.tsx`, `GoalDetail.tsx` | native goal tree and detail surface exist, including hierarchy selection and linked project visibility, but creation/editing flows are still missing | partial | `GoalsViews.swift`, `PaperclipDesktopService.swift` |
| Costs and spend management | `Costs.tsx` | budget metrics appear in summaries, but no dedicated native costs surface exists | not_started | metrics only in `OperationsPanels.swift`; no section/view for costs |
| Routines and recurring automation | `Routines.tsx`, `RoutineDetail.tsx` | no native equivalent found | not_started | no matching section in native navigation |
| Auth, claim, and invite flows | `Auth.tsx`, `CliAuth.tsx`, `BoardClaim.tsx`, `InviteLanding.tsx` | no native authentication/onboarding flow found beyond server configuration | not_started | `SettingsView.swift` covers connection only |
| Activity feed | `Activity.tsx` | native activity timeline exists and is backed by the company activity API, but without the full web analytics/dashboard integration | partial | `ActivitySectionView`, `PaperclipDesktopService.swift` |
| Design/dev utility surfaces | `DesignGuide.tsx`, `RunTranscriptUxLab.tsx` | no native equivalent found | not_started | no matching section in native navigation |

## Excluded Pages

These routes are intentionally excluded from parity scoring:

- `NotFound.tsx`
- `Inbox.test.tsx`
- `Routines.test.tsx`

## Main Gap Areas

### 1. Missing first-class work navigation

The macOS app opens at an operational shell, but it still lacks native surfaces for:

- costs
- routines

These are major product areas on web and keep the desktop app from reaching full control-plane coverage.

### 2. Existing sections are mostly list-and-console shaped

The current native app is strongest when the job is:

- inspect current operational state
- take a concrete operational action
- monitor runtime/plugin/approval status

It is still thinner on:

- object creation
- full detail pages
- editing/configuration-heavy workflows
- structured information architecture beyond the operational shell

### 3. Company and plugin parity is only mid-depth

The app already shows meaningful organization and plugin state, but it still lacks the broader management surface that exists on web, especially:

- company import/export/settings/skills
- org chart
- adapter manager
- plugin-specific settings pages

## Recommended Build Order

If the objective is full macOS parity with the current web surface, the most coherent next sequence is:

1. richer `Issues`, `Agents`, and `Projects` detail pages
2. `Companies` + `Org/OrgChart`
3. `Plugin settings` + `Adapter manager`
4. `Costs`
5. `Routines`
6. auth/onboarding flows

Rationale:

- Steps 1 to 3 close the biggest everyday operator gaps now that `Goals` has a native surface.
- Steps 4 to 6 close platform management gaps.
- Auth/onboarding should land only after the native app has enough functional breadth to justify a full login flow.

## Conclusion

The branch `refactor/central-operacoes-ui-ux` already contains the real foundation of the native macOS app and should be treated as the correct base for desktop work.

However, it does not yet represent full product parity with the web app.

Current state is best described as:

- strong native operational shell
- real interactive consoles for approvals, plugins, and workspace runtime
- partial parity across several board/operator surfaces
- major platform surfaces still not started on macOS
