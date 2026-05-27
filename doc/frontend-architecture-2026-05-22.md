# Paperclip Frontend Architecture Document

**Date:** 2026-05-22
**Author:** Frontend Developer (ecb11a4c)
**Scope:** `ui/src/` directory

## 1. Overview

Paperclip is an AI agent orchestration platform with a React 18 + TypeScript SPA frontend. The UI provides management of companies, agents, issues, projects, goals, routines, adapters, plugins, and real-time monitoring.

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | React 18 + TypeScript |
| Build Tool | Vite |
| Routing | React Router v6 |
| Styling | CSS Modules + CSS Variables (design tokens) |
| State Management | React Query (server state) + React Context (UI state) |
| i18n | i18next + react-i18next (37 languages) |
| UI Components | Radix UI primitives + custom shadcn-style components |
| Testing | Vitest + React Testing Library + Playwright |
| HTTP Client | Native `fetch` with typed wrapper (`api/client.ts`) |
| Real-time | Server-Sent Events (SSE) |

## 2. Directory Structure

```
ui/src/
├── adapters/              # Adapter-specific UI components
├── api/                   # API client layer (32 modules)
├── components/            # Reusable UI components (184 files)
│   └── ui/               # Base UI primitives (dialog, sheet, etc.)
├── context/              # React Context providers
├── fixtures/             # Test fixtures
├── hooks/                # Custom React hooks (13 hooks)
├── i18n/                 # Internationalization (37 locales)
│   ├── locales/          # en.json, zh-CN.json, etc.
│   ├── index.ts          # i18next initialization
│   └── locales.ts        # Auto-locale loader
├── lib/                  # Utilities and helpers
├── pages/                # Page-level components (76 files)
├── plugins/              # Plugin UI integration
├── App.tsx               # Root app component + routing
└── main.tsx              # Entry point
```

## 3. Architecture Layers

### 3.1 API Layer (`api/`)

The API layer provides a thin typed wrapper around `fetch`:

```
api/client.ts          → Base HTTP client (get, post, postForm, put, patch, del)
api/index.ts           → Re-exports all API modules
api/*.ts               → Domain-specific API functions (agents, issues, companies, etc.)
```

**Pattern:** Each domain module exports typed async functions that call `api.get/post/patch` with the appropriate path and schema.

**Key characteristics:**
- `credentials: "include"` for session-based auth
- `ApiError` class with HTTP status and response body
- FormData support for file uploads
- No automatic retry or caching (delegated to React Query)

### 3.2 Routing (`App.tsx`)

React Router v6 with nested layout routes:

```
App.tsx
├── /companies/:companyId/     → Company layout (sidebar + content)
│   ├── /dashboard
│   ├── /issues                → IssuesList page
│   ├── /issues/:id            → IssueDetail page
│   ├── /agents                → Agents list
│   ├── /agents/:id            → AgentDetail
│   ├── /projects/:id          → ProjectDetail
│   ├── /goals                 → Goals list
│   ├── /routines              → Routines list
│   ├── /settings/*            → Company settings tabs
│   └── /...                   → ~30 more company-scoped routes
├── /instance/settings/*       → Instance-level settings
├── /auth                      → Authentication
├── /companies                 → Company list
├── /search                    → Global search
├── /inbox                     → Notification inbox
└── *                          → NotFound
```

### 3.3 Component Hierarchy

```
App.tsx (root, i18n provider, router)
├── CompanyLayout              → Sidebar + main content area
│   ├── Sidebar                → Company navigation
│   │   ├── SidebarCompanyMenu
│   │   ├── SidebarAgents
│   │   └── CompanySwitcher
│   └── Page Components        → 76 page-level components
│       ├── IssuesList         → Issue list with filters
│       │   ├── IssueFiltersPopover
│       │   ├── IssueWorkspaceCard
│       │   └── NewIssueDialog
│       ├── IssueDetail        → Single issue view
│       │   ├── IssueChatThread
│       │   ├── IssueProperties
│       │   ├── CommentThread
│       │   └── IssueDocumentsSection
│       ├── Agents             → Agent list (list + org chart views)
│       │   ├── AgentConfigForm
│       │   └── NewAgentDialog
│       └── Dashboard          → Metrics, charts, activity
│           ├── ActivityCharts
│           └── BudgetPolicyCard
└── AuthLayout                 → Login/register pages
```

### 3.4 State Management

**Server State (React Query):**
- Issue data, agent configs, company settings, costs
- Cached with configurable stale times
- Mutations for create/update/delete operations
- Optimistic updates for real-time issue changes

**UI State (React Context):**
- Current company selection
- Language/locale (via i18next)
- Sidebar preferences
- Inbox dismissal state

**Real-time State (SSE):**
- Live issue updates (status changes, comments)
- Agent run status changes
- Budget alerts
- Join request notifications

## 4. Key Patterns

### 4.1 Page Pattern

Each page follows this structure:
```typescript
export default function PageName() {
  const { t } = useTranslation();
  const { companyId } = useCompany();
  const { data, isLoading } = useSomething(companyId);

  if (isLoading) return <LoadingSkeleton />;
  if (!data) return <EmptyState />;

  return (
    <div className={styles.page}>
      <PageHeader title={t("page.name.title")} />
      <Content data={data} />
    </div>
  );
}
```

### 4.2 i18n Pattern

All user-facing text uses `t()` with nested keys:
```typescript
// Page text
t("page.agents.title")           // "Agents"
t("page.agentDetail.tab.issues") // "Issues"

// Component text
t("component.agentConfig.model") // "Model"

// Common/shared
t("common.actions.save")         // "Save"
t("common.status.active")        // "Active"
```

### 4.3 API Hook Pattern

```typescript
// Hook definition (hooks/useAgents.ts)
export function useAgents(companyId: string) {
  return useQuery({
    queryKey: ["agents", companyId],
    queryFn: () => api.agents.list(companyId),
  });
}

// Usage in component
const { data: agents } = useAgents(companyId);
```

## 5. Data Flow

```
User Action → Component → API call (api/client.ts) → Server
                  ↓                                    ↓
            UI Update ← React Query cache ← JSON response
                  ↓
            SSE Event → React Query invalidation → Refetch
```

## 6. Performance Characteristics

- **Bundle size:** Vite code-splitting by route
- **Lazy loading:** Pages loaded on demand via `React.lazy()`
- **Caching:** React Query handles response caching
- **Real-time:** SSE for live updates without polling
- **i18n:** Locale files loaded per-language (not all 37 at once)

## 7. i18n Status

**Coverage:** ~95% of user-facing text migrated to `t()` calls.
- 1,948 translation call sites across 126 files
- 37 language locale files
- ~30 remaining hardcoded strings in production code (see `doc/i18n-audit-2026-05-22.md`)

## 8. Known Technical Debt

1. **Remaining hardcoded strings** - ~30 user-facing strings in Inbox.tsx, PluginSettings.tsx, Secrets.tsx, and other pages
2. **Large components** - AgentConfigForm.tsx (1400+ lines), IssueDetail.tsx (4000+ lines), Inbox.tsx (2200+ lines) should be broken down
3. **Test coverage gaps** - Some pages lack unit tests
4. **No ESLint rule** preventing new hardcoded strings

## 9. File Statistics

| Category | Count | Total Lines (approx.) |
|----------|-------|-----------------------|
| Pages | 76 | ~25,000 |
| Components | 184 | ~40,000 |
| API modules | 32 | ~3,000 |
| Hooks | 13 | ~1,500 |
| i18n locales | 37 | ~200,000 (combined) |
| Test files | ~30 | ~5,000 |
