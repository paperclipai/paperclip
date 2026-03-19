# i18n Implementation Plan

**Date**: 2026-03-17
**Branch**: feature/i18n-implementation
**Scope**: UI-only (no server, db, or shared changes)

## Goal

Migrate all hardcoded UI strings in the Paperclip UI to use `react-i18next`, starting with English only. This establishes the foundation for future multi-language support.

## Architecture

### Library Choice
- **i18next** + **react-i18next**: Industry standard, well-maintained, 25M+ weekly downloads
- No additional plugins needed for initial English-only setup

### Directory Structure
```
ui/src/i18n/
├── index.ts              # i18n initialization and config
├── types.d.ts            # TypeScript type augmentation for type-safe keys
└── locales/
    └── en/
        ├── common.json       # Shared: buttons, labels, errors, status text
        ├── navigation.json   # Sidebar, breadcrumbs, command palette
        ├── dashboard.json    # Dashboard page
        ├── agents.json       # Agents page and agent-related components
        ├── issues.json       # Issues page and issue-related components
        ├── approvals.json    # Approvals page
        ├── goals.json        # Goals page
        ├── projects.json     # Projects page
        ├── costs.json        # Costs/finance page
        ├── settings.json     # Company settings, instance settings
        ├── auth.json         # Auth/login page
        └── onboarding.json   # Onboarding wizard
```

### Key Naming Convention
- Pattern: `namespace:section.key`
- Examples:
  - `common:buttons.save` → "Save"
  - `common:buttons.cancel` → "Cancel"
  - `dashboard:metrics.agentsEnabled` → "Agents Enabled"
  - `agents:empty.createFirst` → "Create your first agent to get started."
  - `auth:signIn.title` → "Sign in to Paperclip"

### Integration Pattern
```tsx
// Before
<p>No agents yet.</p>

// After
const { t } = useTranslation('agents');
<p>{t('empty.noAgents')}</p>
```

### Interpolation
```tsx
// For dynamic values
t('metrics.budgetPercent', { percent: data.costs.monthUtilizationPercent, budget: formatCents(data.costs.monthBudgetCents) })
// "{{percent}}% of {{budget}} budget"
```

### Pluralization
```tsx
t('agents.count', { count: filtered.length })
// "{{count}} agent" / "{{count}} agents"
```

## What Gets Extracted

### Pages (~30 files)
All hardcoded strings in JSX: headings, labels, empty states, error messages, button text, tab labels, tooltips, placeholders.

### Components (~70+ files)
Same as pages. Shared components like EmptyState, Sidebar, CommandPalette, dialogs, etc.

### What Does NOT Get Extracted
- API error messages (come from server)
- Dynamic data from API (company names, agent names, issue titles)
- CSS class names
- Technical identifiers (route paths, query keys)
- Console.log messages

## Implementation Steps

1. Install `i18next` and `react-i18next` in ui/package.json
2. Create `ui/src/i18n/index.ts` initialization
3. Create `ui/src/i18n/types.d.ts` for type safety
4. Create all translation JSON files in `ui/src/i18n/locales/en/`
5. Import i18n init in `ui/src/main.tsx`
6. Migrate all pages to use `useTranslation()` hook
7. Migrate all components to use `useTranslation()` hook
8. Verify with `pnpm -r typecheck && pnpm build`

## Risks & Mitigations

- **String extraction completeness**: Use systematic file-by-file review
- **Layout breakage**: English-to-English migration has no text length changes
- **Type safety**: Use i18next TypeScript augmentation for compile-time key validation
- **Performance**: JSON imports are bundled, no runtime HTTP fetches needed
