# UI Internationalization Checklist

Scope:
- Only internationalize user-visible UI text.
- Do not change backend contracts, IDs, protocol payloads, or runtime semantics.
- Functional/generated instruction payloads stay unchanged unless they are pure UI chrome.

Completed:
- [x] Locale infrastructure, locale preference flow, and centralized message catalogs
- [x] Six locale catalogs wired: `en`, `zh-CN`, `ja-JP`, `es-ES`, `fr-FR`, `de-DE`
- [x] Core UI baseline surfaces
- [x] Shared control components
- [x] Approval list/detail surfaces and approval payload rendering
- [x] Goals page, goal tree, and new-agent entry surfaces

Current Batch:
- [x] Company settings surfaces
- [x] Plugin manager page
- [x] Plugin settings/detail status page
- [x] Company-context plugin page

Next Batches:
- [x] Workspace detail pages
- [x] Project detail and project workspace pages
- [x] Workspace close dialog and budget/finance shared components
- [x] Active agent and activity chart shared utility components
- [x] Shared navigation, filter, banner, and picker utility components
- [x] Copy-heavy setup dialogs and platform instruction modals
- [x] Company import/export pages and org chart surfaces
- [x] Company skill library surfaces
- [x] Repo-wide page sweep across `ui/src/pages` for `CompanySkills`, `Agents`, `Projects`, `Companies`, `Issues`, and `MyIssues`
- [x] Re-check `origin/master` UI changes for newly introduced i18n scope
- [ ] Repo-wide production component sweep across `ui/src/components` and shared UI primitives
  Completed component batch:
  `ui/src/components/IssueWorkspaceCard.tsx`
  `ui/src/components/FinanceBillerCard.tsx`
  `ui/src/components/RoutineVariablesEditor.tsx`
  `ui/src/components/DocumentDiffModal.tsx`
  `ui/src/components/KeyboardShortcutsCheatsheet.tsx`
  `ui/src/components/RoutineRunVariablesDialog.tsx`
  `ui/src/components/OutputFeedbackButtons.tsx`
  `ui/src/components/SidebarAgents.tsx`
  `ui/src/components/ReportsToPicker.tsx`
  `ui/src/components/ProjectProperties.tsx` shared fallback copy
  `ui/src/components/ui/dialog.tsx`
  `ui/src/components/ui/sheet.tsx`
  `ui/src/components/ui/command.tsx`
  `ui/src/components/ui/breadcrumb.tsx`
  `ui/src/components/transcript/RunTranscriptView.tsx`
  `ui/src/components/CopyText.tsx`
  `ui/src/components/InlineEditor.tsx`
  `ui/src/components/MarkdownBody.tsx`
  `ui/src/components/RunChatSurface.tsx`
  `ui/src/components/LiveRunWidget.tsx`
  Remaining production sweep:
  `ui/src/components/JsonSchemaForm.tsx`
  `ui/src/components/EnvVarEditor.tsx`
  `ui/src/components/ExecutionParticipantPicker.tsx`
  `ui/src/components/ScheduleEditor.tsx`
  `ui/src/components/BillerSpendCard.tsx`
  `ui/src/components/ProviderQuotaCard.tsx`
  `ui/src/pages/Routines.tsx`
  `ui/src/pages/RoutineDetail.tsx`
- [ ] Decide whether lab/demo/design pages should be localized in this rollout or tracked separately
- [x] Batch verification pass with `scripts/check-i18n.ts`, `git diff --check`, and targeted typecheck evidence
- [ ] Final repo verification pass after the remaining production sweep completes

Verification Notes:
- `bun scripts/check-i18n.ts` is the translation completeness gate.
- `pnpm --filter @paperclipai/ui typecheck` must be reported truthfully because this environment has intermittently hung during `tsc -b`.
- Current evidence:
  `bun scripts/check-i18n.ts` passed with `2645` translation keys across `6` locales.
  `git diff --check` passed.
  `origin/master` review found no additional `ui/` or `docs/` scope in the 2 remote-ahead commits.
  Project/workspace detail pages are now localized:
  `ui/src/components/ProjectProperties.tsx`
  `ui/src/pages/ProjectDetail.tsx`
  `ui/src/pages/ProjectWorkspaceDetail.tsx`
  `ui/src/pages/ExecutionWorkspaceDetail.tsx`
  Shared finance/workspace dashboard components are now localized:
  `ui/src/components/ExecutionWorkspaceCloseDialog.tsx`
  `ui/src/components/BudgetPolicyCard.tsx`
  `ui/src/components/BudgetIncidentCard.tsx`
  `ui/src/components/FinanceTimelineCard.tsx`
  `ui/src/components/ActiveAgentsPanel.tsx`
  `ui/src/components/ActivityCharts.tsx`
  `ui/src/lib/utils.ts`
  Shared navigation/filter/banner utility components are now localized:
  `ui/src/lib/issue-filters.ts`
  `ui/src/components/IssueFiltersPopover.tsx`
  `ui/src/components/CompanySwitcher.tsx`
  `ui/src/components/SidebarProjects.tsx`
  `ui/src/components/WorktreeBanner.tsx`
  `ui/src/components/DevRestartBanner.tsx`
  `ui/src/components/IssueLinkQuicklook.tsx`
  `ui/src/components/AgentIconPicker.tsx`
  Setup and path instruction dialogs are now localized:
  `ui/src/components/NewAgentDialog.tsx`
  `ui/src/components/PathInstructionsModal.tsx`
  `ui/src/components/agent-config-primitives.tsx`
  Company package import/export and org chart pages are now localized:
  `ui/src/pages/CompanyImport.tsx`
  `ui/src/pages/CompanyExport.tsx`
  `ui/src/pages/OrgChart.tsx`
  `ui/src/pages/Org.tsx`
  Company skills and top-level operational list pages are now localized:
  `ui/src/pages/CompanySkills.tsx`
  `ui/src/pages/Agents.tsx`
  `ui/src/pages/Projects.tsx`
  `ui/src/pages/Companies.tsx`
  `ui/src/pages/Issues.tsx`
  `ui/src/pages/MyIssues.tsx`
  Centralized status label rendering is now localized:
  `ui/src/components/StatusBadge.tsx`
  Shared primitive chrome is now localized:
  `ui/src/components/ui/dialog.tsx`
  `ui/src/components/ui/sheet.tsx`
  `ui/src/components/ui/command.tsx`
  `ui/src/components/ui/breadcrumb.tsx`
  Transcript rendering chrome and summaries are now localized:
  `ui/src/components/transcript/RunTranscriptView.tsx`
  Run utility and markdown chrome are now localized:
  `ui/src/components/CopyText.tsx`
  `ui/src/components/InlineEditor.tsx`
  `ui/src/components/MarkdownBody.tsx`
  `ui/src/components/RunChatSurface.tsx`
  `ui/src/components/LiveRunWidget.tsx`
  Targeted `pnpm --filter @paperclipai/ui typecheck | rg "RunTranscriptView|packages/i18n/src/index"` produced no matches after the transcript batch.
  Targeted `pnpm --filter @paperclipai/ui typecheck | rg "CopyText|InlineEditor|MarkdownBody|RunChatSurface|LiveRunWidget|packages/i18n/src/index"` produced no matches for the utility batch.
  Earlier targeted `pnpm --filter @paperclipai/ui typecheck` output still reports existing `t` signature mismatches in `ui/src/components/ProjectProperties.tsx`; the shared primitive batch was therefore not claimed as fully typecheck-clean.
  Fresh `pnpm --filter @paperclipai/ui typecheck` still exits `1` on pre-existing unrelated errors in `ui/src/components/DevRestartBanner.tsx`, `ui/src/components/IssueFiltersPopover.tsx`, `ui/src/components/PathInstructionsModal.tsx`, `ui/src/components/ProjectProperties.tsx`, `ui/src/pages/CompanyImport.tsx`, `ui/src/pages/CompanySkills.tsx`, `ui/src/pages/ExecutionWorkspaceDetail.tsx`, and `ui/src/pages/PluginSettings.tsx`.
  Fresh residual scan found remaining production i18n scope in:
  `ui/src/components/JsonSchemaForm.tsx`
  `ui/src/components/EnvVarEditor.tsx`
  `ui/src/components/ExecutionParticipantPicker.tsx`
  `ui/src/components/ScheduleEditor.tsx`
  `ui/src/components/BillerSpendCard.tsx`
  `ui/src/components/ProviderQuotaCard.tsx`
  `ui/src/pages/Routines.tsx`
  `ui/src/pages/RoutineDetail.tsx`
