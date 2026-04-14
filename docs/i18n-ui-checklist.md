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
- [ ] Copy-heavy setup dialogs and platform instruction modals
- [ ] Repo-wide deep scan across `ui/src/pages` and `ui/src/components`
- [x] Re-check `origin/master` UI changes for newly introduced i18n scope
- [ ] Final verification pass with `scripts/check-i18n.ts` and targeted typecheck evidence

Verification Notes:
- `bun scripts/check-i18n.ts` is the translation completeness gate.
- `pnpm --filter @paperclipai/ui typecheck` must be reported truthfully because this environment has intermittently hung during `tsc -b`.
- Current evidence:
  `bun scripts/check-i18n.ts` passed with `2169` translation keys across `6` locales.
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
  `pnpm --filter @paperclipai/ui typecheck` still hangs at `tsc -b` in this environment; the process was confirmed alive at the `tsc -b` stage and then terminated, so this batch is not claimed as freshly typecheck-clean.
