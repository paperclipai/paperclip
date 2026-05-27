# Paperclip Frontend Architecture

Status: Draft
Date: 2026-05-22

## 1. Tech Stack

```
┌──────────────────────────────────────────────────────────────┐
│  Framework      React 19 + TypeScript                        │
│  Build tool     Vite 6                                       │
│  Router         React Router 7 (file-based, nested routes)   │
│  State          TanStack Query v5 (server) + React Context   │
│  UI Library     Radix UI + shadcn/ui components               │
│  Styling        Tailwind CSS 4 + @tailwindcss/vite           │
│  i18n           i18next + react-i18next + browser detector  │
│  Icons          lucide-react                                 │
│  Drag & Drop    @dnd-kit/core + @dnd-kit/sortable            │
│  Markdown       @mdxeditor/editor + react-markdown + remark  │
│  LLM UI         @assistant-ui/react + lexical                │
│  Charts         Mermaid (diagrams)                           │
│  Package manager pnpm 9 (monorepo workspaces)                │
│  Testing        Vitest + React Testing Library               │
│  Storybook      storybook 10 with addon-a11y/addon-docs      │
└──────────────────────────────────────────────────────────────┘
```

**Package name:** `@paperclipai/ui`

## 2. Directory Structure

```
ui/src/
├── adapters/          # Adapter UI modules (config forms, stdout parsers)
│   ├── index.ts
│   ├── registry.ts
│   ├── dynamic-loader.ts
│   ├── types.ts
│   ├── metadata.ts
│   ├── transcript.ts
│   ├── schema-config-fields.tsx
│   ├── acpx-local/
│   ├── claude-local/
│   ├── codex-local/
│   ├── cursor/
│   ├── cursor-cloud/
│   ├── gemini-local/
│   ├── grok-local/
│   ├── hermes-local/
│   ├── http/
│   ├── openclaw-gateway/
│   ├── opencode-local/
│   ├── pi-local/
│   └── process/
│
├── api/                # Typed API client layer (TanStack Query wrappers)
│   ├── index.ts        # Barrel export
│   ├── client.ts       # Base fetch client with auth headers
│   ├── auth.ts         # Auth endpoints
│   ├── companies.ts
│   ├── agents.ts
│   ├── projects.ts
│   ├── issues.ts
│   ├── routines.ts
│   ├── goals.ts
│   ├── approvals.ts
│   ├── costs.ts
│   ├── activity.ts
│   ├── dashboard.ts
│   ├── heartbeats.ts
│   ├── inboxDismissals.ts
│   └── ... (31 source files across all domains)
│
├── components/         # Shared React components (shadcn + custom)
│   ├── ui/            # Base shadcn/radix primitives
│   ├── Layout.tsx     # Main shell: sidebar + breadcrumb + content
│   ├── Sidebar.tsx
│   ├── BreadcrumbBar.tsx
│   ├── OnboardingWizard.tsx
│   ├── CommandPalette.tsx
│   └── [200+ feature components]
│
├── context/            # React Context providers (global state)
│   ├── CompanyContext.tsx      # Companies list, selected company
│   ├── DialogContext.tsx      # Modal/dialog orchestration
│   ├── SidebarContext.tsx     # Sidebar collapsed state
│   ├── BreadcrumbContext.tsx  # Breadcrumb trail state
│   ├── PanelContext.tsx      # Right properties panel visibility
│   ├── ToastContext.tsx       # Toast notifications
│   ├── ThemeContext.tsx       # Theme management
│   ├── LiveUpdatesProvider.tsx # SSE-based real-time updates
│   └── EditorAutocompleteContext.tsx
│
├── i18n/                # Internationalization
│   ├── index.ts        # i18next init, t() helper, useTranslation export
│   ├── locales/        # Translation JSON files (40+ languages)
│   │   ├── en.json
│   │   ├── zh-CN.json
│   │   └── ... (ar, de, fr, ja, es, etc.)
│   └── locale-validation.ts
│
├── lib/                 # Pure utility functions + custom hooks
│   ├── router.ts        # React Router setup
│   ├── groupBy.ts
│   ├── color-contrast.ts
│   ├── keyboardShortcuts.ts
│   ├── issue-filters.ts
│   ├── company-selection.ts
│   ├── inbox.ts
│   └── [80+ lib files, many with matching .test.ts]
│
├── pages/               # Route-level page components
│   ├── Dashboard.tsx
│   ├── Agents.tsx / AgentDetail.tsx
│   ├── Projects.tsx / ProjectDetail.tsx
│   ├── Issues.tsx / IssueDetail.tsx
│   ├── Inbox.tsx
│   ├── Approvals.tsx / ApprovalDetail.tsx
│   ├── Costs.tsx
│   ├── Activity.tsx
│   ├── Goals.tsx / GoalDetail.tsx
│   ├── Routines.tsx / RoutineDetail.tsx
│   ├── OrgChart.tsx
│   ├── CompanySettings.tsx
│   ├── Secrets.tsx
│   ├── PluginManager.tsx
│   ├── AdapterManager.tsx
│   └── [30+ pages]
│
├── App.tsx              # Root: Routes definition with company-prefixed layout
├── App.test.tsx
└── main.tsx
```

### Key Naming Conventions

- Pages: `PascalCase.tsx` (e.g., `AgentDetail.tsx`, `CompanySettings.tsx`)
- Components: `PascalCase.tsx` (e.g., `StatusBadge.tsx`, `EntityRow.tsx`)
- Lib utilities: `camelCase.ts` (e.g., `issueFilters.ts`, `companySelection.ts`)
- Tests: sibling `.test.ts` / `.test.tsx` files
- API files: `camelCase.ts` (e.g., `agents.ts`, `heartbeats.ts`)

## 3. Data Flow

```
┌──────────────────────────────────────────────────────────────────┐
│                        User Interaction                          │
└────────────────────────────┬─────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  Pages (React Components)                                        │
│  useCompany(), useTranslation(), useQuery()                      │
└────────────────────────────┬─────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  API Layer (ui/src/api/*.ts)                                     │
│  Typed TanStack Query hooks — each file = one domain             │
│  • Wraps fetch calls with auth headers                            │
│  • Returns { data, isLoading, error, refetch }                    │
│  • Cache key = [endpoint, params]                                │
│  • Optimistic updates for mutations                              │
│  Example: issuesApi.list({ companyId, status })                  │
└────────────────────────────┬─────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  REST API (server/src/routes/)                                   │
│  Express.js with better-auth sessions + API key auth             │
│  Drizzle ORM → PostgreSQL                                         │
│  Adapter execution layer (spawns Claude Code, Codex CLI, etc.)   │
└──────────────────────────────────────────────────────────────────┘
```

**TanStack Query v5 patterns used:**
- `useQuery` for list and detail fetches
- `useMutation` with `onSuccess` invalidation for writes
- `queryClient.setQueryData` for optimistic updates
- Shared query keys via `queryOptions()` factory functions

## 4. Component Hierarchy

```
App
└── Routes
    ├── /auth → AuthPage
    ├── /board-claim/:token → BoardClaimPage
    ├── /invite/:token → InviteLandingPage
    ├── CloudAccessGate (route wrapper)
    │   └── Instance settings routes → Layout
    │       ├── /instance/settings/profile → ProfileSettings
    │       ├── /instance/settings/plugins → PluginManager
    │       └── /instance/settings/adapters → AdapterManager
    │
    ├── UnprefixedBoardRedirect (naked routes → /:companyPrefix/...)
    │
    └── :companyPrefix → Layout (company-scoped shell)
        ├── Sidebar (fixed 240px left)
        │   ├── CompanyHeader (switcher dropdown)
        │   ├── PersonalSection (Inbox, My Issues)
        │   ├── WorkSection (Issues, Projects, Goals, Views)
        │   └── CompanySection (Dashboard, Org, Agents, Costs, Activity)
        │
        ├── BreadcrumbBar (full-width above content)
        │   ├── Breadcrumb trail
        │   ├── Star/favorite toggle
        │   ├── Entity actions menu
        │   └── Notification bell + panel toggle
        │
        └── <Outlet> (main content area)
            ├── /dashboard → Dashboard
            ├── /issues → Issues (list/kanban)
            ├── /issues/:issueId → IssueDetail (three-pane)
            │   ├── IssueTitle + inline properties bar
            │   ├── Description (markdown)
            │   ├── Comments (threaded)
            │   └── Properties Panel (right, 320px)
            ├── /agents → Agents (list)
            ├── /agents/:agentId → AgentDetail (tabs: overview/heartbeats/issues/costs)
            ├── /projects/:projectId → ProjectDetail (tabs: overview/issues/settings)
            ├── /inbox → Inbox (approvals/alerts/stale work)
            ├── /approvals → Approvals list
            ├── /approvals/:approvalId → ApprovalDetail
            ├── /costs → Costs dashboard
            ├── /activity → Activity log
            ├── /goals → Goals tree view
            └── /org → OrgChart (interactive tree)
```

### Three-Pane Layout Pattern

Used by: IssueDetail, ProjectDetail, AgentDetail, ApprovalDetail, GoalDetail

```
┌──────────┬────────────────────────────┬──────────────────┐
│ Sidebar  │ Main Content (scrollable) │ Properties Panel  │
│ (240px)  │                            │ (320px, optional) │
│          │ Title, description,        │ Status, Priority, │
│          │ comments, activity         │ Assignee, dates   │
└──────────┴────────────────────────────┴──────────────────┘
```

- Properties panel toggles via `]` keyboard shortcut
- Slides in on detail view, hidden on list views
- Persisted in PanelContext

## 5. Routing Design

Paperclip uses **company-prefixed routes** — every board route is scoped under `/:companyPrefix`. This allows sharing the same route tree for multiple companies.

```tsx
// App.tsx structure
<Routes>
  <Route path="auth" element={<AuthPage />} />
  <Route element={<CloudAccessGate />}>
    <Route path="instance" element={<Layout />}>
      {/* Instance-level settings (no company prefix) */}
    </Route>
    <Route path=":companyPrefix" element={<Layout />}>
      {boardRoutes()}  // ~60 board routes
    </Route>
  </Route>
</Routes>
```

**Company prefix resolution:**
1. `CompanyContext` holds current company state
2. `UnprefixedBoardRedirect` catches bare routes (`/issues`, `/agents`) and redirects to `/:companyPrefix/...`
3. `CompanyRootRedirect` redirects `/` to `/:companyPrefix/dashboard`

**Route conventions:**
- `all/active/paused/error` sub-routes for filtered list views
- `:tab` param for tabbed detail views (heartbeats, issues, costs, overview)
- Nested routes via `<Outlet>` for project workspaces and sub-pages

## 6. Context Architecture

```
┌─────────────────────────────────────────────┐
│  CompanyContext                             │
│  • companies[]                              │
│  • selectedCompany                          │
│  • loading                                  │
│  (loaded once on boot, shared everywhere)   │
└─────────────────────────────────────────────┘
        │
        ├── Sidebar (company switcher)
        ├── All page components (company-scoped queries)
        └── Route resolution (prefix → company mapping)

┌─────────────────────────────────────────────┐
│  DialogContext                              │
│  • openOnboarding({ companyId?, step? })    │
│  • openEntity(entity)                       │
│  (powers OnboardingWizard + global modals)  │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│  LiveUpdatesProvider (SSE)                  │
│  • Subscribes to /api/events?companyId=X    │
│  • Emits: issue_updated, agent_heartbeat     │
│  • Updates TanStack Query cache via         │
│    queryClient.setQueryData                 │
└─────────────────────────────────────────────┘
```

Other contexts: SidebarContext (collapsed state), BreadcrumbContext (nav trail), PanelContext (right panel), ToastContext, ThemeContext, EditorAutocompleteContext.

## 7. Internationalization (i18n)

**Stack:** i18next + react-i18next + i18next-browser-languagedetector

**Supported locales:** 40+ languages (en, zh-CN, ar, de, fr, ja, es, etc.)

**Initialization (`ui/src/i18n/index.ts`):**
```ts
i18n
  .use(LanguageDetector)    // Detects from localStorage "paperclip_locale" or navigator
  .use(initReactI18next)
  .init({
    resources: i18nextResources,
    fallbackLng: DEFAULT_LOCALE,
    detection: {
      order: ["localStorage", "navigator"],
      lookupLocalStorage: "paperclip_locale",
      caches: ["localStorage"],
    },
  });
```

**Usage patterns:**
```tsx
// Component usage
const { t } = useTranslation();
return <span>{t("issue.status.inProgress", { defaultValue: "In Progress" })}</span>

// Direct function usage (for complex components)
import { t } from "@/i18n";
<span>{t("common.save")}</span>
```

**Translation file structure (`en.json`):**
```json
{
  "common": { "save": "Save", "cancel": "Cancel", "delete": "Delete" },
  "issue": { "status": { "todo": "Todo", "inProgress": "In Progress", ... } },
  "sidebar": { "dashboard": "Dashboard", "inbox": "Inbox", ... },
  "agent": { "status": { "running": "Running", "idle": "Idle", ... } }
}
```

**Current migration status:** Active — many components still use hardcoded strings; ongoing effort to migrate all UI text to i18n keys.

## 8. Adapter Bridge Architecture

The adapter system connects Paperclip's control plane to external AI runtimes. The UI side consists of:

```
┌──────────────────────────────────────────────────────┐
│  AdapterRegistry (adapters/registry.ts)              │
│  • Lists all available adapters (claude-local,       │
│    codex-local, opencode-local, gemini-local, etc.)   │
│  • Provides adapter metadata (name, description,      │
│    config fields schema)                             │
│  • Used by AdapterManager page + NewAgent wizard     │
└──────────────────────────────────────────────────────┘
        │
        ├── AdapterManager page → shows all adapters
        └── NewAgent page → adapter selector + config form
                              │
                              ▼
        ┌─────────────────────────────────────────────┐
        │  DynamicLoader (adapters/dynamic-loader.ts) │
        │  • Loads adapter UI module at runtime       │
        │  • Supports local + workspace adapters      │
        │  • Sandboxed parser worker for stdout parsing│
        └─────────────────────────────────────────────┘
                              │
                              ▼
        ┌─────────────────────────────────────────────┐
        │  ConfigFields (per adapter)                 │
        │  • Schema-driven form fields                │
        │  • Model selection, capability flags         │
        │  • Runtime controls (context window size)  │
        └─────────────────────────────────────────────┘
```

**Adapter list in `ui/src/adapters/registry.ts`:**
Built-in adapters (12): `acpx-local`, `claude-local`, `codex-local`, `cursor` (local + cloud), `gemini-local`, `grok-local`, `hermes-local`, `opencode-local`, `pi-local`, `openclaw-gateway`, `process`, `http`

## 9. Key Architectural Decisions

### Company-scoped routing
All board routes live under `/:companyPrefix`, resolving to the company's `issuePrefix`. Unprefixed routes redirect to the correct prefixed path. This enables multi-company support with a single route tree.

### TanStack Query for server state
All API calls go through typed query hooks in `ui/src/api/`. No manual `fetch` calls in components. Cache invalidation is explicit via `onSuccess` callbacks.

### Context for global state, TanStack Query for server state
Company list, sidebar state, dialogs, toasts, breadcrumbs — all in React Context. Server data (issues, agents, costs) in TanStack Query.

### i18n for all user-visible text
Current migration phase: hardcoded strings in components are being replaced with `t()` calls referencing `en.json`/`zh-CN.json` keys.

### Radix UI + Tailwind for components
Base primitives from Radix (Dialog, Dropdown, Select, etc.), styled with Tailwind CSS 4 via `@tailwindcss/vite`. Custom components built on top.

### Three-pane layout as default pattern
List → detail navigation always uses the three-pane shell (sidebar + content + properties panel). Properties panel is contextual, not persistent.

## 10. Optimization Findings & Suggestions

### Findings

1. **Good: Schema-driven adapter config** — adapter forms are generated from Zod schemas, making new adapters low-friction.
2. **Good: Company context initialization** — companies loaded once at boot and cached in context; no repeated fetches.
3. **Good: Live updates via SSE** — `LiveUpdatesProvider` handles real-time cache updates without manual polling.
4. **Good: Comprehensive test coverage** — most lib files have `.test.ts` siblings with good isolation.
5. **In progress: i18n migration** — hardcoded strings being systematically replaced with translation keys.

### Suggestions

1. **Lazy-load heavy pages** — `Costs`, `Activity`, `OrgChart`, and the design guide are heavy. Use `React.lazy()` + `Suspense` for code-splitting. Especially `PluginPage`, `RunTranscriptUxLab`.
2. **Consolidate API client** — `client.ts` is the base; ensure all API modules import from one place and don't re-implement auth headers.
3. **Extract shared query options** — many `useQuery({ queryKey: [...], queryFn: ... })` calls could use a `queryOptions()` factory pattern to DRY query keys and staleTime configs.
4. **Stale time tuning** — list queries (issues, agents) use short stale times; consider `staleTime: 30_000` for less frequently changing data (goals, settings) to reduce unnecessary refetches.
5. **DialogContext cleanup** — the global dialog system is powerful but the context shape is large; consider splitting into `DialogActionsContext` (actions) and `DialogStateContext` (open state).
6. **BreadcrumbContext → URL sync** — breadcrumbs are managed in context; consider deriving from URL to avoid sync issues on back navigation.
7. **i18n key naming consistency** — current keys mix patterns (e.g., `issue.status.inProgress` vs `inbox.title`). Standardize on `{domain}.{component}.{element}` format across all translation files.

## 11. Related Documentation

- [System Architecture](../start/architecture.md) — higher-level stack overview
- [UI Spec](../../doc/spec/ui.md) — design system, component specs, layout details
- [API Overview](../../docs/api/overview.md) — backend API reference
- [Adapter System](../../docs/adapters/overview.md) — adapter model and creation guide

## 12. Verification Log

Last verified: 2026-05-22 (auto-verified against codebase)

| Claim | Verdict |
|-------|---------|
| 9 context files in Section 2 | PASS — all 9 exist, plus 3 extras (GeneralSettingsContext, test files) |
| 12 built-in adapters in registry | PASS — 12 adapters in `registry.ts` (not `index.ts`) |
| 31 API source files | CORRECTED — doc now reflects "31 source files" (was "20+" undercount) |
| Dashboard.tsx and Agents.tsx exist | PASS |
| 40+ i18n locales | PASS — 42 locale files found |
| shadcn/ui primitives | Verify manually — `ui/src/components/ui/` directory