# COMPONENT-INVENTORY.md — Component Inventory (Phase 1)

Run scope: `ui/src/components/` and `ui/src/pages/` on branch `design/token-extraction`. Read-only audit — no source files modified.

**All consolidation, merge, and shadcn-swap recommendations in this document are RECOMMENDATIONS ONLY.** Per `GOAL-PROMPT.md` and `DESIGN.md`, no component merges, deletions, or swaps happen in this run. They become human-approved follow-up runs ("Run 2"/"Run 3").

## Counts

| Area | Count |
|---|---:|
| Shared primitives (`ui/src/components/ui/`) | 24 |
| Feature components, flat (`ui/src/components/*.tsx`) | 178 |
| Feature components, nested subdirs (`access/`, `artifacts/`, `environment-variables-editor/`, `interrupt-handoff/`, `issue-output/`, `issue-properties/`, `routine-sections/`, `search/`, `timeline/`, `transcript/`) | 28 |
| **Feature components total** | **206** |
| Pages (`ui/src/pages/`, incl. `pages/secrets/`) | 73 |
| **Grand total** | **303** (roughly matches DESIGN.md's "24 + ~277") |

---

## 1. Shared primitives — `ui/src/components/ui/` (24)

All 24 checked against the live shadcn registry via `npx shadcn@latest diff` (network-available in this environment). Aggregate `diff` and per-component spot checks (`button`, `dialog`) both returned **"No updates found"** — these are currently in sync with the upstream registry source.

| Component | File | Registry name | Variants (props) | Purpose |
|---|---|---|---|---|
| Alert Dialog | `alert-dialog.tsx` | `alert-dialog` | (Radix primitive passthrough) | Confirm/destructive-action modal |
| Avatar | `avatar.tsx` | `avatar` | `size` (sm/default), `shape` (circle/square via `data-shape`) | User/agent avatar with fallback initials |
| Badge | `badge.tsx` | `badge` | `variant` (default/secondary/destructive/outline) | Generic pill label |
| Breadcrumb | `breadcrumb.tsx` | `breadcrumb` | (Radix/plain nav passthrough) | Page breadcrumb trail |
| Button | `button.tsx` | `button` | `variant` (default/destructive/outline/secondary/ghost/link), `size` (default/sm/lg/icon/icon-sm/icon-xs) | CTA / action button, all tiers |
| Card | `card.tsx` | `card` | Header/Title/Description/Content/Footer subparts | Bordered content container |
| Checkbox | `checkbox.tsx` | `checkbox` | (Radix passthrough) | Boolean input |
| Collapsible | `collapsible.tsx` | `collapsible` | (Radix passthrough) | Expand/collapse section |
| Command | `command.tsx` | `command` | Dialog/Input/List/Item/Group/Separator/Shortcut | ⌘K palette primitive (backs `CommandPalette`) |
| Dialog | `dialog.tsx` | `dialog` | (Radix passthrough), expandable max-width transition | Modal dialog |
| Dropdown Menu | `dropdown-menu.tsx` | `dropdown-menu` | Item/CheckboxItem/RadioItem/Sub/Separator/Shortcut | Context/action menu |
| Input | `input.tsx` | `input` | (native input passthrough) | Text input |
| Label | `label.tsx` | `label` | (Radix passthrough) | Form field label |
| Popover | `popover.tsx` | `popover` | (Radix passthrough) | Floating panel |
| Radio Card | `radio-card.tsx` | **not a standard registry name** | (custom, card-shaped radio option) | Large selectable option card (onboarding/settings pickers) |
| Scroll Area | `scroll-area.tsx` | `scroll-area` | (Radix passthrough) | Styled scroll container |
| Select | `select.tsx` | `select` | (Radix passthrough) | Dropdown select |
| Separator | `separator.tsx` | `separator` | `orientation` | Divider line |
| Sheet | `sheet.tsx` | `sheet` | `side` (top/right/bottom/left) | Slide-in drawer |
| Skeleton | `skeleton.tsx` | `skeleton` | (plain div passthrough) | Loading placeholder |
| Tabs | `tabs.tsx` | `tabs` | (Radix passthrough) | Tab navigation |
| Textarea | `textarea.tsx` | `textarea` | (native passthrough) | Multi-line text input |
| Toggle Switch | `toggle-switch.tsx` | **not a standard registry name** (registry has `switch`) | (custom on/off toggle) | Boolean toggle control |
| Tooltip | `tooltip.tsx` | `tooltip` | (Radix passthrough) | Hover/focus hint |

**Note:** `radio-card` and `toggle-switch` are not standard shadcn registry component names (the registry ships `radio-group` and `switch` respectively) — these were custom-built or heavily renamed/adapted rather than installed from the registry, so `shadcn diff` cannot check them against an upstream source. See shadcn-candidates section 4c.

**Stock-value note:** several "arbitrary Tailwind bracket values" flagged in `TOKEN-AUDIT.md` inside these primitives (`checkbox.tsx` `rounded-[4px]`, `tooltip.tsx` `rounded-[2px]`, `command.tsx` `max-h-[300px]`, `avatar.tsx` `text-[10px]`) were verified to match the **current shadcn/ui registry source verbatim** — they are not local drift, just registry boilerplate that itself doesn't route through a token layer. Phase 2 will still need to touch them (DESIGN.md's gate is "zero arbitrary values in `ui/src/components/**`" with no carve-out for `components/ui/`), but they are not evidence of local customization.

---

## 2. Feature components — `ui/src/components/` (206)

Grouped by rough domain area. One line each; variants column is props-based where notable, blank where the component is largely propless/single-purpose.

### 2.1 Issue / task surfaces (largest cluster)

| Component | Purpose |
|---|---|
| `IssueRow.tsx` | Single row in a task list (status glyph, title, chips) |
| `IssuesList.tsx` | List/board container rendering many `IssueRow`s, sort/filter/group |
| `IssueColumns.tsx` | Column-layout config for the issues list/board |
| `IssueGroupHeader.tsx` | Section header when list is grouped (by status/project/assignee) |
| `IssueProperties.tsx` | 1-line re-export barrel → `issue-properties/IssueProperties.tsx` |
| `issue-properties/IssueProperties.tsx` | Full task detail properties panel (2,301 lines) — status, assignee, labels, project, dates |
| `IssueChatThread.tsx` | Task comment/chat thread (agent + human messages) |
| `IssueThreadInteractionCard.tsx` | Rich interaction card embedded in the chat thread (approvals, tool calls) |
| `IssueRecoveryActionCard.tsx` | Recovery-action prompt card in a stalled/errored task thread |
| `IssueScheduledRetryCard.tsx` | Scheduled-retry status card in task thread |
| `IssueRunLedger.tsx` | Run/cost ledger table for a task |
| `IssueMonitorActivityCard.tsx` | Monitoring/activity summary card on a task |
| `IssueBlockedNotice.tsx` | Banner when a task is blocked |
| `IssueAssignedBacklogNotice.tsx` | Banner when a backlog task gets assigned |
| `IssueDocumentAnnotations.tsx` / `issue-output/` variants | Doc-annotation highlight overlay on task documents |
| `IssueDocumentsSection.tsx` | Documents tab/section on task detail |
| `IssueAttachmentsSection.tsx` | Attachments tab/section on task detail |
| `IssuePlanDecompositionsSection.tsx` | Sub-task/decomposition list section |
| `IssueRelatedWorkPanel.tsx` | Related-issues panel |
| `IssueReferenceActivitySummary.tsx` / `IssueReferencePill.tsx` | Inline task-reference chip + activity rollup |
| `IssueSiblingNavigation.tsx` | Prev/next sibling task nav |
| `IssueLinkQuicklook.tsx` / `IssuesQuicklook.tsx` | Hover-preview popover for a linked task / task list |
| `IssueFiltersPopover.tsx` | Filter builder popover for the issues list |
| `IssueWorkspaceCard.tsx` | Card summarizing a task's execution workspace |
| `IssueContinuationHandoff.tsx` | Handoff-to-next-run card |
| `NewIssueDialog.tsx` | Create-task dialog |

### 2.2 Agent / execution

| Component | Purpose |
|---|---|
| `AgentCapsule.tsx` | The brand "capsule" motif — 3-state agent avatar (slot/configured/online) |
| `AgentActionButtons.tsx` | Start/stop/pause agent action row |
| `AgentBubbleActionRow.tsx` | Action row (copy/vote/timestamp/menu) under a conf-room agent chat bubble — **only one implementation found**, confirming PRIOR-ART's concern about a duplicate is resolved |
| `AgentConfigForm.tsx` | Agent configuration form (model, instructions, etc.) |
| `AgentIconPicker.tsx` | Icon picker for agent avatars |
| `AgentProperties.tsx` | Agent detail properties panel |
| `ActiveAgentsPanel.tsx` | Sidebar/dashboard panel of currently-running agents |
| `LiveRunWidget.tsx` | Live run status widget |
| `RunChatSurface.tsx` | Shared chat-surface shell used by both conf-room and task chat |
| `ClaudeSubscriptionPanel.tsx` / `CodexSubscriptionPanel.tsx` | Provider-specific subscription/quota panels — parallel, provider-specific (not a duplicate; see 3.4) |
| `ProviderQuotaCard.tsx` / `QuotaBar.tsx` | Generic quota display card / bar |

### 2.3 Chat / composer

| Component | Purpose |
|---|---|
| `ChatComposer.tsx` (380 lines) | Shared lean composer (conf-room + reused where a single-line/simple composer suffices) |
| `MarkdownEditor.tsx` (1,425 lines) | Rich MDX-based editor with mention autocomplete — task comment composer |
| `OnboardingChat.tsx` | Onboarding-flow chat surface |
| `CommentThread.tsx` | Generic comment-thread renderer (non-task contexts) |
| `MarkdownBody.tsx` / `WorkspaceFileMarkdownBody.tsx` | Rendered markdown output (read-only) — general vs. workspace-file-scoped |

**KNOWN-DUPLICATES.md lead verified:** `ChatComposer` vs `MarkdownEditor`-based task composer — confirmed genuinely different in scope (380 vs 1,425 lines; ChatComposer has no mention-autocomplete/MDX machinery). Per KNOWN-DUPLICATES.md this was a deliberate non-unification (PAP-101) — **flagged in section 5, not recommended for merge.**

### 2.4 Status / chips / badges

| Component | Purpose |
|---|---|
| `StatusIcon.tsx` | Interactive status glyph + popover to change status (wraps `StatusGlyph`) |
| `StatusGlyph.tsx` | Pure SVG glyph renderer per status (sm/md/lg), no interactivity |
| `StatusBadge.tsx` | Custom `<span>` pill components: `StatusBadge` (generic run/goal/approval), `AgentStatusBadge`, heartbeat capsule — **does not wrap the shadcn `Badge` primitive** (see shadcn candidates 4a) |
| `PriorityIcon.tsx` | Priority-level icon |
| `ExternalObjectStatusIcon.tsx` / `ExternalObjectStatusSummary.tsx` / `ExternalObjectPill.tsx` | External-object (linked PR/doc/etc.) status glyph, rollup summary, and inline pill — a third, deliberately separate status-presentation family |
| `BlockedReasonChip.tsx` | Chip explaining why a task is blocked |
| `SourceTrustBadge.tsx` / `SourceResolvedFoldBadge.tsx` / `SourceResolvedFoldCallout.tsx` | Trust/fold badges for external content sources |
| `ProductivityReviewBadge.tsx` | Review-status badge |

**KNOWN-DUPLICATES.md lead verified:** StatusIcon / inline-mention chips / task chips are intentionally three separate systems (StatusIcon+StatusGlyph = task status glyph family; `ExternalObjectStatusIcon`/`Pill`/`Summary` = a second, external-object-specific family; mention chips in `lib/mention-chips.ts` + markdown CSS = a third, generic "chip in prose" family). **Documented here per instruction, not merged.**

### 2.5 Sidebar / navigation

| Component | Purpose |
|---|---|
| `Sidebar.tsx` / `SidebarShell.tsx` / `SecondarySidebar.tsx` / `InstanceSidebar.tsx` | Primary/secondary/instance-scoped sidebar shells |
| `SidebarSection.tsx` / `SidebarNavItem.tsx` | Sidebar section grouping + nav item row |
| `SidebarProjects.tsx` / `SidebarStarredProjects.tsx` | Project list / starred-project list in sidebar |
| `SidebarAgents.tsx` | Agent list in sidebar |
| `SidebarAccountMenu.tsx` / `SidebarCompanyMenu.tsx` | Account and company switcher menus |
| `SidebarServerInfo.tsx` | Server/instance info footer |
| `RequestCollapsedSidebar.tsx` | Collapsed-state sidebar for request/approval views |
| `RoutineSubSidebar.tsx` | Routine-scoped sub-sidebar |
| `MobileBottomNav.tsx` | Mobile bottom tab bar |
| `BreadcrumbBar.tsx` (uses `ui/breadcrumb`) | Page breadcrumb bar wrapper |
| `PageTabBar.tsx` | In-page tab bar |
| `CommandPalette.tsx` | ⌘K command palette (wraps `ui/command`) |

**Sidebar text-size cluster** (cross-ref TOKEN-AUDIT.md 3.1): `Sidebar.tsx`, `SidebarNavItem.tsx`, `SidebarAgents.tsx`, `SidebarProjects.tsx`, `SidebarStarredProjects.tsx`, `SidebarAccountMenu.tsx` all independently use `text-[13px]` — six components implementing what looks like one shared "sidebar row label" intent as six separate arbitrary values. Flagged for the human type-scale decision, not merged here.

### 2.6 Pipelines / routines / goals

| Component | Purpose |
|---|---|
| `PipelineHealthWarnings.tsx` / `PipelineLivenessBanner.tsx` | Pipeline health/liveness banners |
| `PipelineItemBodyDocument.tsx` / `PipelineStageHistoryPanel.tsx` / `PipelineWorkReferences.tsx` | Pipeline stage detail panels |
| `PipelinesExperimentalGate.tsx` | Feature-flag gate wrapper for pipelines |
| `RoutineList.tsx` / `ManagedRoutinesList.tsx` | Routine list views |
| `RoutineActivityRow.tsx` / `RoutineHistoryTab.tsx` | Routine activity row + history tab |
| `RoutineRunVariablesDialog.tsx` / `RoutineVariablesEditor.tsx` | Routine run-variable input dialog/editor |
| `RoutineSaveBar.tsx` / `RoutineTriggerCard.tsx` | Routine save-bar + trigger config card |
| `routine-sections/editable-sections.tsx` (+2 more) | Editable routine-section blocks |
| `ScheduleEditor.tsx` | Cron/schedule editor |
| `GoalTree.tsx` / `GoalProperties.tsx` / `NewGoalDialog.tsx` | Goal hierarchy tree, detail panel, create dialog |

### 2.7 Finance / budget

| Component | Purpose |
|---|---|
| `AccountingModelCard.tsx` / `BillerSpendCard.tsx` / `FinanceBillerCard.tsx` / `FinanceKindCard.tsx` / `FinanceTimelineCard.tsx` | Various finance-dashboard cards — 5 distinct card shapes for different finance groupings (model/biller/kind/timeline); worth a human check for whether all 5 are truly distinct or 2-3 could share a base card |
| `BudgetIncidentCard.tsx` / `BudgetPolicyCard.tsx` / `BudgetSidebarMarker.tsx` | Budget incident, policy config, sidebar marker |
| `MetricCard.tsx` | Generic metric-display card |

### 2.8 Files / documents / artifacts

| Component | Purpose |
|---|---|
| `FileTree.tsx` | General file-tree renderer + `buildFileTree`/`FileTreeNode` model |
| `PackageFileTree.tsx` | Thin wrapper around `FileTree` (`wrapLabels` default) — reuses `FileTreeProps`, not a duplicate |
| `WorkspaceFileBrowser.tsx` | Execution-workspace file browser — **defines its own parallel tree-node model** (`WorkspaceFileTreeNode`, `buildWorkspaceFileTree`, `compareTreeNodes`) instead of reusing `FileTree`'s `FileTreeNode`/`buildFileTree` — see suspected duplicates (3.2) |
| `FileViewerSheet.tsx` | File content viewer sheet (wraps `ui/sheet`) |
| `FileTree.tsx`'s `parseFrontmatter` | Shared frontmatter parser (also exported, reused elsewhere) |
| `DocumentAnnotationLayer.tsx` / `DocumentAnnotationPanel.tsx` | Document highlight/annotation overlay + side panel |
| `DocumentDiffModal.tsx` | Document diff viewer modal |
| `DocumentFrameHeader.tsx` | Header chrome for an embedded document frame |
| `ArtifactFileChip.tsx` / `artifacts/ArtifactCard.tsx` / `artifacts/ArtifactGroupCard.tsx` / `ArtifactsPanel.tsx` | Artifact chip, card, grouped-card, and panel — internally consistent `rounded-[8px]` cluster (TOKEN-AUDIT 3.5) |
| `ImageGalleryModal.tsx` | Image gallery lightbox modal |

### 2.9 Onboarding / access / identity

| Component | Purpose |
|---|---|
| `OnboardingWizard.tsx` / `OnboardingWizardVariant.tsx` | Onboarding flow + an alternate variant — worth a human check on whether the variant is still live or leftover from an A/B (see 3.5) |
| `FrontDoor.tsx` | Landing/entry gate component |
| `CloudAccessGate.tsx` / `ConferenceRoomChatGate.tsx` / `PipelinesExperimentalGate.tsx` | Three separate feature-flag/access gate wrappers — same pattern (children-if-enabled), each hand-rolled per feature; candidate for a shared `FeatureGate` primitive (flagged, not built here) |
| `Identity.tsx` | Avatar + name identity chip (`deriveInitials` helper) |
| `MembershipAction.tsx` | Membership accept/decline action row |
| `access/` (2 files) | Access-request related components |
| `ReportsToPicker.tsx` / `ExecutionParticipantPicker.tsx` / `InlineEntitySelector.tsx` / `SearchableSelect.tsx` | Four distinct entity-picker components — overlapping purpose (pick a person/entity from a list); see suspected duplicates (3.3) |
| `SecretBindingPicker.tsx` / `environment-variables-editor/` (5 files) | Secrets/env-var binding UI |

### 2.10 System / chrome / misc

| Component | Purpose |
|---|---|
| `Layout.tsx` | App shell layout |
| `EmptyState.tsx` | **The single canonical empty-state component** — confirmed only one exists, matching DESIGN.md principle 1 |
| `SystemNotice.tsx` | Global system notice banner |
| `DevRestartBanner.tsx` | Dev-mode restart-required banner |
| `ToastViewport.tsx` + `context/ToastContext.tsx` | Fully custom toast notification system — no shadcn `sonner`/toast primitive installed (see shadcn candidates 4a) |
| `KeyboardShortcutsCheatsheet.tsx` | ⌘K-adjacent shortcuts help modal |
| `PageSkeleton.tsx` | Loading skeleton (wraps `ui/skeleton`) |
| `RouteErrorBoundary.tsx` | Route-level error boundary |
| `ThemeToggle.tsx` | Light/dark toggle |
| `CopyText.tsx` | Copy-to-clipboard text control |
| `EntityRow.tsx` | Generic entity list row (used across several list contexts) |
| `SwipeToArchive.tsx` | Mobile swipe-to-archive gesture wrapper |
| `ScrollToBottom.tsx` | Scroll-to-bottom floating button |
| `FoldCurtain.tsx` | Collapsible "show more" curtain/fade |
| `InlineEditor.tsx` | Generic inline-edit-in-place control |
| `JsonSchemaForm.tsx` | JSON-schema-driven dynamic form renderer |
| `TrustPresetSection.tsx` | Trust-level preset picker section |
| `WorktreeBanner.tsx` | Worktree-branding banner |
| `CompanyPatternIcon.tsx` | Canvas-rendered company pattern/avatar icon |
| `CompanySwitcher.tsx` / `CompanySettingsSidebar.tsx` | Company switcher + settings sidebar |
| `ProjectProperties.tsx` / `ProjectTile.tsx` / `ProjectWorkspaceSummaryCard.tsx` / `ProjectWorkspacesContent.tsx` | Project detail panel, tile, workspace summary card, workspace content |
| `ApprovalCard.tsx` / `ApprovalPayload.tsx` | Approval request card + payload renderer |
| `ExecutionWorkspaceCloseDialog.tsx` | Close-workspace confirm dialog |
| `ResponsibleUserDenialNotice.tsx` | Denial-notice banner |
| `BootstrapPendingPage.tsx` | Bootstrap-pending full-page state |
| `MissingPluginTabPlaceholder.tsx` | Placeholder when a plugin tab isn't installed |
| `StandaloneBrowserControls.tsx` | Standalone-mode browser chrome controls |
| `AsciiArtAnimation.tsx` | Decorative ASCII animation (boot/loading) |
| `OpenCodeLogoIcon.tsx` | Static logo icon |
| `StarToggle.tsx` | Star/favorite toggle button |
| `OutputFeedbackButtons.tsx` | Thumbs up/down feedback buttons on agent output |
| `KanbanBoard.tsx` | Kanban board view (alternate to `IssuesList` list view) |
| `agent-config-primitives.tsx` | Shared field primitives for agent config forms |
| `PropertiesPanel.tsx` | Generic properties-panel shell (used by Issue/Project/Agent/Goal Properties) |

### 2.11 Nested subdirectories

| Directory | Files | Purpose |
|---|---|---|
| `access/` | 2 | Access-request UI |
| `artifacts/` | 2 | `ArtifactCard`, `ArtifactGroupCard` |
| `environment-variables-editor/` | 5 | Env-var/secret editor rows and index |
| `interrupt-handoff/` | 1 | `InterruptHandoffViews.tsx` |
| `issue-output/` | 5 | Task output file tiles / sections |
| `issue-properties/` | 5 | Task properties panel (full impl, see 2.1) |
| `routine-sections/` | 3 | Editable routine section blocks |
| `search/` | 3 | Search result row, `HighlightedText`, `MatchSourceChip` |
| `timeline/` | 1 | `WorkTimelineChart.tsx` |
| `transcript/` | 1 | `RunTranscriptView.tsx` |

---

## 3. Pages — `ui/src/pages/` (73)

Grouped by area; one line each.

| Page | Purpose |
|---|---|
| `Dashboard.tsx` | Home/overview dashboard |
| `IssueDetail.tsx` / `IssuesList` route pages | Task detail + list routes |
| `AgentDetail.tsx` / `Agents.tsx` | Agent detail + list |
| `ProjectDetail.tsx` / `Projects.test.tsx`-adjacent list page | Project detail + list |
| `Pipelines.tsx` / `PipelineSettings.tsx` | Pipeline list + settings |
| `Routines.tsx` | Routine list/detail |
| `Org.tsx` / `OrgChart.tsx` | Org directory + org chart visualization |
| `Costs.tsx` | Cost/budget dashboard |
| `Timeline.tsx` | Work timeline view (wraps `timeline/WorkTimelineChart`) |
| `Inbox.tsx` | Notifications/requests inbox |
| `Approvals.tsx` / `ApprovalDetail.tsx` | Approval queue + detail |
| `CompanySettings.tsx` / `CompanySkills.tsx` / `CompanyEnvironments.tsx` / `CompanyAccess.tsx` / `CompanyImport.tsx` / `CompanyExport.tsx` | Company-scoped settings sub-pages |
| `TeamCatalog.tsx` | Team/role catalog |
| `UserProfile.tsx` / `ProfileSettings.tsx` | User profile view + settings |
| `Secrets.tsx` / `secrets/*` (5 files) | Secrets management + sub-tabs (import-from-vault, definitions, my-secrets, presentation helpers, missing-banner) |
| `PluginManager.tsx` / `PluginSettings.tsx` | Plugin management + per-plugin settings |
| `AdapterManager.tsx` | Adapter (agent runtime) management |
| `CloudUpstream.tsx` / `CloudUpstreamUxLab.tsx` | Cloud-upstream connection page + its UxLab showcase twin |
| `InviteLanding.tsx` / `InviteUxLab.tsx` | Invite acceptance landing page + UxLab showcase twin |
| `BootstrapSetupUxLab.tsx` | Bootstrap-setup flow showcase |
| `ResponsibleUserDenialUxLab.tsx` | Denial-flow showcase |
| `SystemNoticeUxLab.tsx` | System-notice showcase |
| `IssueChatUxLab.tsx` / `RunTranscriptUxLab.tsx` | Chat + transcript showcases |
| `DesignGuide.tsx` | Design-system showcase/reference page |
| `BoardChat.tsx` / `BoardClaim.tsx` | Board (concierge) chat + claim flow |
| `NotFound.tsx` | 404 page |
| `CliAuth.tsx` | CLI auth handoff page |
| `JoinRequestQueue.tsx` | Join-request queue |
| `InstanceAccess.tsx` / `InstanceGeneralSettings.tsx` / `InstanceExperimentalSettings.tsx` | Instance-level settings pages |
| `ExecutionWorkspaceDetail.tsx` / `ProjectWorkspaceDetail.tsx` | Execution/project workspace detail pages |
| `Companies.tsx` | Multi-company switcher/list |
| `CompanyImport.tsx` / `CompanyExport.tsx` | Import/export company data |
| `RoutineDetail.tsx` | Routine detail route |

**UxLab pages are real routes** (confirmed via `App.tsx` — `/ux-lab/*`, `/design-guide`), not build-excluded demo code, so all hardcoded values inside them are in-scope per DESIGN.md even though they're showcase surfaces rather than product screens a typical operator visits daily.

---

## 4. Shadcn candidates

**All items below are recommendations only — no swaps happen in this run.**

### 4a. Custom components duplicating an available shadcn primitive

| Custom component | Duplicates | Recommended replacement | Expected visual impact |
|---|---|---|---|
| `ToastViewport.tsx` + `context/ToastContext.tsx` | shadcn's `sonner`-based toast pattern (not currently installed) | Install `sonner`/toast primitive, migrate `useToastActions`/`useToastState` call sites to it | Low if the registry's toast is restyled to match current `toneClasses`/`toneDotClasses` tint system; the current implementation already has custom tone colors (`sky`/`emerald`/`amber`/`red`) that would need to carry over as variant props — a naive swap would look different unless those tones are preserved |
| `components/StatusBadge.tsx` (`StatusBadge`, `AgentStatusBadge`) | shadcn `Badge` primitive (installed, `ui/badge.tsx`) | Keep as a distinct component (status badges need the `.status-chip` color-mix mechanic Badge's variant system doesn't support) but consider having it render `<Badge>` internally with a custom class rather than a bare `<span>`, for consistency of base styles (focus ring, disabled states, etc.) | Low — internal implementation change only if done carefully; skip if it risks the WCAG-tuned status hues |
| Hand-rolled bordered-container `<div>`/`<ul>` patterns (`rounded-md border bg-card`-shaped) found in ~26 files (`pages/AdapterManager.tsx`, `pages/TeamCatalog.tsx`, `pages/InstanceAccess.tsx`, `pages/BootstrapSetupUxLab.tsx`, `pages/ResponsibleUserDenialUxLab.tsx`, `pages/CliAuth.tsx`, `pages/BoardClaim.tsx`, `pages/BoardChat.tsx`, `pages/InstanceGeneralSettings.tsx`, `pages/ProjectWorkspaceDetail.tsx`, `pages/Timeline.tsx`, `pages/PluginManager.tsx`, `pages/JoinRequestQueue.tsx`, `pages/InstanceExperimentalSettings.tsx`, `App.tsx`, `components/BootstrapPendingPage.tsx`, `components/IssuePlanDecompositionsSection.tsx`, `components/BlockedInboxView.tsx`, `components/ApprovalCard.tsx`, + ~7 more) vs. shadcn `Card` (installed, only imported in 21 files) | `Card`/`CardContent` | Low-to-medium — many of these are `<ul>` list wrappers, not literal card content; a swap would need per-site judgment, not a blanket codemod. Flagging the cluster, not asserting every site should change. |
| Hand-rolled pill/badge-shaped `<span>`s (`rounded-full px-2 text-[...]`) outside `Badge` usage, ~34 files | `Badge` (installed, 35 files already use it) | `Badge` with a custom `className` for color | Low if colors are preserved as `className` overrides |
| `plugins/launchers.tsx` generic plugin-shell overlay (`role="dialog"`, hand-rolled backdrop `bg-black/45`, manual z-index math, `rounded-xl`/`rounded-2xl`) | `Dialog` / `Sheet` / `Popover` (all installed) | Case-by-case: this component multiplexes dialog/drawer/popover shell types from one plugin-host abstraction, which none of the three installed primitives do individually — a clean swap likely means keeping the multiplexer but delegating each `shellType` branch to the matching installed primitive instead of a fully custom `<div>` tree | Medium — this is the most structurally custom overlay in the codebase; recommend closer human review before treating it as a simple swap |

### 4b. Installed shadcn components drifted from the registry

`npx shadcn@latest diff` (run from `ui/`, network available) reported **"No updates found"** for the aggregate diff and for spot-checked `button` and `dialog` individually. **No drift detected** against the current registry for any of the 22 standard-named primitives. (`radio-card` and `toggle-switch` aren't standard registry names so `diff` cannot evaluate them — see 4c.)

### 4c. Raw Radix/plain elements where an installed shadcn wrapper exists

- **No raw `@radix-ui/*` imports were found outside `ui/src/components/ui/`** (`rg -l '@radix-ui' -g '*.tsx' -g '!components/ui/*'` returned zero files) — every Radix primitive in the app is properly routed through the `components/ui/` wrapper layer. This is a clean result; no action needed.
- One raw hand-rolled modal (`plugins/launchers.tsx`, `role="dialog"` on a plain `<div>`) exists where `Dialog`/`Sheet` wrappers are installed — see 4a above, same finding, cross-listed here because it's also a "plain element where a wrapper exists" case.
- `radio-card.tsx` and `toggle-switch.tsx` are functioning as de facto custom primitives sitting in the `ui/` folder alongside real shadcn components, but they were not installed via the registry (no matching registry names). Recommend a human decide whether to (a) leave them as intentionally custom, documenting why the registry's `radio-group`/`switch` don't fit, or (b) evaluate swapping to the registry versions if the customization was incidental rather than deliberate.

---

## 5. Suspected duplicates (with evidence)

All of the below are **leads for human review**, not verdicts, per KNOWN-DUPLICATES.md's framing.

### 5.1 Seed leads from KNOWN-DUPLICATES.md — verified

| Lead | Finding |
|---|---|
| `ChatComposer` vs `MarkdownEditor`-based task composer | **Confirmed genuinely distinct** (380 vs 1,425 lines; different prop interfaces `ChatComposerProps` vs `MarkdownEditorProps`; MarkdownEditor owns mention-autocomplete machinery — `findMentionMatch`, `computeMentionMenuPosition`, `placeCaretAfterMentionAnchor` — that ChatComposer has none of). Matches KNOWN-DUPLICATES.md's note that this was a deliberate non-unification (PAP-101). **Needs human decision: re-confirm this split should remain permanent, or revisit unification now that both have matured further.** |
| `AgentBubbleActionRow.tsx` duplicate check | **Only one file found** (`components/AgentBubbleActionRow.tsx`). The concurrent-work duplicate PRIOR-ART/KNOWN-DUPLICATES.md warned about is not present on this branch — resolved. |
| `StatusIcon` vs inline-mention chips vs task chips | **Confirmed three separate, intentionally distinct systems**: (1) `StatusIcon`/`StatusGlyph` — task status glyph, drives from `--status-task-icon-*` tokens; (2) `ExternalObjectStatusIcon`/`ExternalObjectPill`/`ExternalObjectStatusSummary` — a parallel system for external (PR/doc/etc.) object status, independent color/severity model (`externalObjectStatusIcon`, `externalObjectStatusToneSeverity` in `lib/status-colors.ts`); (3) mention chips (`lib/mention-chips.ts` + `.paperclip-mention-chip` CSS in `index.css`) — generic "entity reference in prose" chip unrelated to status at all. Documented per instruction, **not merged.** |

### 5.2 New leads found during this audit

| Lead | Evidence |
|---|---|
| `FileTree.tsx` vs `WorkspaceFileBrowser.tsx` tree models | `FileTree.tsx` exports `buildFileTree`, `FileTreeNode`, `countFiles`, `collectAllPaths`, `parseFrontmatter`. `WorkspaceFileBrowser.tsx` independently defines its own `WorkspaceFileTreeNode`/`WorkspaceFileTreeFolderNode`/`WorkspaceFileTreeFileNode`, `buildWorkspaceFileTree`, `compareTreeNodes`, `finalizeTreeFolder` — a parallel tree-building implementation rather than reuse of `FileTree`'s exported helpers. `PackageFileTree.tsx` by contrast correctly wraps `FileTree` (reuses `FileTreeProps`). **Needs human decision**: was `WorkspaceFileBrowser`'s separate model a deliberate choice (different node shape needs — e.g. it may need workspace-specific metadata `FileTreeNode` lacks) or copy-paste-and-diverge drift? |
| `agentStatusBadge` vs `brandChipBadge` (`lib/status-colors.ts`) | Byte-for-byte identical maps for the 4 shared keys (gray/blue/amber/red — same hex, same dark-mode alpha suffixes); `brandChipBadge` additionally has `green`/`violet`. Cross-referenced in TOKEN-AUDIT.md section 1.1. **Recommend collapsing `agentStatusBadge` into `brandChipBadge`** (or making it an alias) since they are provably identical, not just similar. |
| Entity-picker family: `ReportsToPicker.tsx`, `ExecutionParticipantPicker.tsx`, `InlineEntitySelector.tsx`, `SearchableSelect.tsx` | Four components with overlapping "pick one entity from a searchable list" purpose. Not verified identical (each has domain-specific filtering — reports-to org hierarchy, execution participants, generic inline selection, generic searchable select) but the prop-surface overlap (all take an options list + selected value + onChange) is a plausible consolidation candidate. **Flagged, not verified as true duplicates** — would need a closer prop-by-prop diff in a follow-up run. |

### 5.3 Corrections after closer inspection

- `OnboardingWizardVariant.tsx` (10 lines) is **not** a duplicate of `OnboardingWizard.tsx` (1,786 lines) — it's a thin routing wrapper (`export function OnboardingWizardVariant() { return <OnboardingWizard />; }`) left over from a since-retired experimental-flag variant (per its own doc comment: "Conference-room chat is now the only surface left behind `enableConferenceRoomChat`; onboarding stays available without that experimental flag"). Both are routed in `App.tsx`. **No action needed** — this is a naming leftover, not visual/logic duplication; candidate for a trivial rename-and-inline cleanup in a future non-visual refactor, out of scope here.
- `components/IssueProperties.tsx` is a 1-line re-export barrel (`export { IssueProperties } from "./issue-properties";`) — not a duplicate of `components/issue-properties/IssueProperties.tsx`, just a compatibility import path.

### 5.4 Finance card family — needs closer human review

`AccountingModelCard.tsx`, `BillerSpendCard.tsx`, `FinanceBillerCard.tsx`, `FinanceKindCard.tsx`, `FinanceTimelineCard.tsx` — five components with card-shaped, finance-dashboard purposes and naming that overlaps enough (`BillerSpendCard` vs `FinanceBillerCard`) to warrant a closer look than this audit had time for. Not verified as duplicates; flagged as a lead only.

### 5.5 Feature-gate wrapper pattern (not a duplicate, but a repeated pattern)

`CloudAccessGate.tsx`, `ConferenceRoomChatGate.tsx`, `PipelinesExperimentalGate.tsx` each independently implement the same "render children only if flag X is enabled, else render fallback" shape. Not byte-identical (each checks a different flag/hook), so not a strict duplicate, but a strong candidate for a shared `FeatureGate`/`ExperimentalGate` primitive that takes a flag-check function as a prop. Flagged as a recommendation, not built here.

---

## 6. Needs human decision (required section)

1. **`ChatComposer` vs `MarkdownEditor`-based composer** — KNOWN-DUPLICATES.md already flags this as deliberately unmerged (PAP-101). This audit confirms the split is real (not accidental) given the large capability gap. Human call: keep permanently split, or revisit now. **DECIDED (Run 2 review, DECISION-SHEET.md C1): keep the split, documented as deliberate — user re-confirmed after visual review.**
2. **`FileTree.tsx` vs `WorkspaceFileBrowser.tsx` independent tree models** — is `WorkspaceFileBrowser`'s separate `WorkspaceFileTreeNode` model justified by different data needs, or is it drift that should be refactored onto `FileTree`'s exported `buildFileTree`/`FileTreeNode`? Needs someone who knows both call sites' actual data shapes. **DECIDED (Run 2 review, DECISION-SHEET.md C2): investigate data-shape needs as Run 3 prep; refactor onto FileTree only if shapes align.** **RESOLVED (Run 3 investigation): KEEP SEPARATE — shapes do not align; see §7.1.**
3. **`agentStatusBadge` vs `brandChipBadge`** (`lib/status-colors.ts`) — these are provably byte-identical for their 4 shared keys. Recommend collapsing, but doing so touches every call site importing `agentStatusBadge`, so it's a human-approved Run 2/3 item, not automatic. **RESOLVED (Run 2 review, DECISION-SHEET.md A1): collapsed — `agentStatusBadge` had zero importing call sites and was deleted; `brandChipBadge` is the single map.**
4. **Entity-picker family** (`ReportsToPicker`, `ExecutionParticipantPicker`, `InlineEntitySelector`, `SearchableSelect`) — plausible consolidation candidate on prop-surface similarity alone; needs a closer prop-by-prop and behavior diff (not done in this pass) before any merge recommendation can be made with confidence. **DECIDED (Run 2 review, DECISION-SHEET.md C3): prop-by-prop diff queued as Run 3 prep; no merge without it.** **RESOLVED (Run 3 investigation): all four KEEP SEPARATE — no copy-paste drift found; see §7.2.**
5. **Finance card family** (5 components, section 5.4) — needs a domain-knowledgeable human to confirm whether all 5 are truly distinct dashboard needs or 2-3 could share a base `FinanceCard`. **DECIDED (Run 2 review, DECISION-SHEET.md C4): keep all five; revisit only if a sixth appears.**
6. **Hand-rolled card-shaped containers vs. `Card` primitive** (~26 files) and **hand-rolled pill spans vs. `Badge`** (~34 files) — both are large, low-risk-looking consolidation opportunities, but "low risk" was assessed at a glance only; a real swap pass needs per-site visual verification (this is exactly what Storybook snapshots from Phase 0 would catch if these were touched). **DECIDED (Run 2 review, DECISION-SHEET.md C5): queued for Run 3 as the shadcn-swap list, with per-site snapshot verification.**
7. **`plugins/launchers.tsx` custom multiplexed overlay** — the most structurally custom modal-like component in the app; recommend a dedicated closer look before deciding whether/how to route it through `Dialog`/`Sheet`/`Popover`, since it currently does something none of the three do alone (switch shell type per plugin action). **DECIDED (Run 2 review, DECISION-SHEET.md C6): dedicated review task; excluded from Run 3.**
8. **`radio-card.tsx` / `toggle-switch.tsx` non-standard "shadcn" primitives** — confirm whether these were deliberately custom-built (and should stay documented as such) or are stale/incidental deviations from `radio-group`/`switch` that should be swapped in a later run. **DECIDED (Run 2 review, DECISION-SHEET.md C7): deliberately custom — documented as such; no swap.**
9. **`StatusBadge`/`AgentStatusBadge` not wrapping the installed `Badge` primitive** — worth a human call on whether unifying the base markup (while keeping the custom `.status-chip` color-mix mechanic) is worth the churn, or whether the current bespoke `<span>` approach should just be documented as an intentional, permanent exception (similar to the StatusIcon/ExternalObject/mention-chip three-way split already documented). **DECIDED (Run 2 review, DECISION-SHEET.md C8): documented as an intentional exception — the WCAG-tuned `.status-chip` mechanic stays bespoke.**
10. **Toast system has no installed shadcn primitive to compare against** — `ToastViewport`/`ToastContext` is fully custom because no `sonner`/toast component is installed at all. Human call: install one and migrate, or formally document the custom toast as the system's permanent choice (it already has a working tone/variant system). **DECIDED (Run 2 review, DECISION-SHEET.md C9): decision deferred to Run 4, when the toast's palette colors get retokenized; sonner-behind-a-pushToast-facade is the alternative to evaluate then.**

---

## 7. Run 3 investigation verdicts (C2/C3)

Investigated Jul 7 2026 on `design/component-convergence` per DECISION-SHEET.md C2/C3. Both are read-only verdicts; no merges executed (neither met the "copy-paste drift with identical data shapes" bar).

### 7.1 C2 — WorkspaceFileBrowser vs FileTree tree models: KEEP SEPARATE

**Deliberate divergence, not copy-paste drift.** No shared git ancestry: `git log --follow` shows FileTree.tsx originating in 3c73ed26b (plugin host surface, #5205) and WorkspaceFileBrowser.tsx independently in 468edd8b2 (workspace file viewer, #7681); no rename/copy relationship, and the only commit touching both is the mechanical token retune (c07e650cd).

**Data shapes are distinct, not overlapping:**
- `FileTreeNode` (FileTree.tsx:18-25): `kind: "dir"|"file"`, keyed on `path`, children on every node, optional `action` string. Built by `buildFileTree(files: Record<string, unknown>)` — a flat path→content map fed static blobs (CompanyExport.tsx:696/762/832, CompanyImport.tsx:783/903, AgentDetail.tsx:1902).
- `WorkspaceFileTreeNode` (WorkspaceFileBrowser.tsx:211-227): `kind: "folder"|"file"` (different literals), composite `key` = `kind:workspaceId:relativePath`, baked-in `depth`, folder-only `lazy` flag, and file nodes embed the entire `WorkspaceFileListFileItem` server DTO (~15 fields: capabilities, previewKind, byteSize, download URLs — packages/shared/src/types/workspace-file-resource.ts:50-94). Built from an array of server DTOs with rootPath prefix-stripping.

**Behavior domains differ:** FileTree is an eager, static tree with tri-state checkboxes, badges/tones, frontmatter parsing, and a full roving-tabindex keyboard grid; WorkspaceFileBrowser is a server-paginated live browser with lazy folders, per-folder "load more" via `useQueries`, a debounced search combobox, and opposite sort order (folders-first vs FileTree's deliberate files-first, FileTree.tsx:96-99). Neither uses the other's load-bearing features; a merge would be a superficial shared-recursion abstraction both sides immediately override.

### 7.2 C3 — Entity-picker family: all four KEEP SEPARATE

**No copy-paste lineage:** four independent creation commits by different efforts — InlineEntitySelector (3709901db, Feb 26), ReportsToPicker (61f53b647, Mar 20), ExecutionParticipantPicker (be518529b, Apr 7, extracted from inline pill UI), SearchableSelect (50ae8fc65, Jun 24, #8597, born cmdk-based). `git log --follow` shows no cross-file rename/copy.

Per-component rationale:
- **ReportsToPicker**: no search, no keyboard nav, domain `Agent[]` single-select with unique manager-state UI (terminated-manager banner, stale-ID handling, ReportsToPicker.tsx:92-104). 2 call sites. A thin bespoke widget, not a drifted copy.
- **ExecutionParticipantPicker**: the only multi-select (toggle set) and the only one with async data fetching (`useQuery` user directory); encodes selections as `agent:<id>`/`user:<id>` tagged strings coupled to execution-policy plumbing. Not behavior-preservingly mergeable into any single-select.
- **InlineEntitySelector vs SearchableSelect** (the only real candidate pair): different engines (hand-rolled input + manual Arrow/Enter/Tab keyboard machine with tab-advance chain driving NewIssueDialog's field flow, InlineEntitySelector.tsx:154-189/90-101 — vs cmdk `Command shouldFilter={false}`, SearchableSelect.tsx:246); different option shapes (`{id,label,searchText}` flat + synthetic none-row vs `{key,value,label,title,searchText,disabled}` grouped + generic `<TValue,TOption>`); each has unique load-bearing features (recent-ordering/onConfirm vs createItem/deriveGroups/scoreOption/veto-close). ~33 call sites on InlineEntitySelector incl. the plugin bridge (plugins/bridge-init.ts:389/479). High-risk, low-reward rewrite — default keep-as-is holds.

### 7.3 Interactive-card affordance (Run 3 review feedback)

`Card` gained an `interactive` prop — pointer cursor, quiet hover (border→foreground/20 + shadow-md lift), focus-visible ring — used when the whole card is a click target (e.g. Companies selector). Skills tiles (CompanySkills `SkillCard`) and artifact cards (`ArtifactCard`/`ArtifactGroupCard`) apply the same recipe verbatim since they cannot render through Card (button/Link semantics). Static container Cards stay affordance-free by design.
