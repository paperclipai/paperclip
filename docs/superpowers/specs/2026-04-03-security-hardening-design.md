# Security Hardening & Quality Improvements — Design Spec

**Date**: 2026-04-03
**Status**: Approved
**Scope**: Fix all critical, high, and medium alerts from the codebase audit
**Approach**: Layer-by-layer (Server → DB → Frontend → Tooling)

---

## Context

A comprehensive audit of the Paperclip codebase identified 14 alerts across 3 severity levels:

- **3 Critical**: hardcoded auth secret, no rate limiting, no React Error Boundary
- **5 High**: CORS wildcard on plugins, missing security headers, no linting in CI, no test coverage metrics, DB pool not configured
- **6 Medium**: massive frontend components, no i18n, DevUiUrl SSRF risk, sensitive data in logs, no JWT TTL bounds, deep context provider tree

This plan addresses all 14 alerts organized in 4 phases by technical layer.

---

## Phase 1 — Server (security, middleware, config)

### 1.1 Remove hardcoded auth secret (CRITICAL)

**File**: `server/src/auth/better-auth.ts:70`

**Current code**:
```typescript
const secret = process.env.BETTER_AUTH_SECRET ?? process.env.PAPERCLIP_AGENT_JWT_SECRET ?? "paperclip-dev-secret";
```

**Change**: Replace the hardcoded fallback with deployment-mode-aware resolution:

- **`local_trusted` mode** (default): Generate a deterministic secret derived from the `PAPERCLIP_HOME` path + a fixed salt constant. This preserves zero-config local usage without exposing a publicly-known secret.
- **`authenticated` mode**: Throw a fatal error at startup if neither `BETTER_AUTH_SECRET` nor `PAPERCLIP_AGENT_JWT_SECRET` is defined. The error message must clearly state which variable to set.

**Implementation**: New helper function `resolveAuthSecret(deploymentMode)` in the same file, called from `createBetterAuthInstance`.

**Tests**: Unit test in `server/src/__tests__/` covering both modes + missing secret error.

### 1.2 Rate limiting (CRITICAL)

**New file**: `server/src/middleware/rate-limit.ts`

**Dependency**: `express-rate-limit` (~15KB, zero transitive deps)

Three tiers:

| Target | Limit | Window | Scope |
|--------|-------|--------|-------|
| Auth endpoints (`/api/auth/*`) | 10 req | 1 min | per IP |
| Mutating API (POST/PUT/PATCH/DELETE) | 100 req | 1 min | per IP |
| Read API (GET) | 300 req | 1 min | per IP |

**Configuration** via environment variables:
- `PAPERCLIP_RATE_LIMIT_ENABLED` (default: `true`) — set `false` when behind a reverse proxy
- `PAPERCLIP_RATE_LIMIT_AUTH` (default: `10`)
- `PAPERCLIP_RATE_LIMIT_API_WRITE` (default: `100`)
- `PAPERCLIP_RATE_LIMIT_API_READ` (default: `300`)

**Mounting**: In `app.ts`, after `httpLogger`, before routes. Auth limiter applied specifically to `/api/auth/*`; API limiters applied to the `/api` router.

**Tests**: Unit test verifying 429 response after threshold.

### 1.3 Security headers (HIGH)

**File**: `server/src/app.ts`

**Dependency**: `helmet`

**Configuration**:
- `contentSecurityPolicy: false` — frontend manages its own CSP if needed
- `crossOriginEmbedderPolicy: false` — plugin UIs load cross-origin resources
- All other headers enabled by default (X-Frame-Options, X-Content-Type-Options, HSTS, X-DNS-Prefetch-Control, etc.)

**Mounting**: First middleware in the chain, before `express.json()`.

**Tests**: Integration test asserting key headers are present in responses.

### 1.4 Restrictive CORS for plugin UI (HIGH)

**File**: `server/src/routes/plugin-ui-static.ts:475`

**Current code**:
```typescript
res.set("Access-Control-Allow-Origin", "*");
```

**Change**: Replace wildcard with origin validation:
- If the request `Origin` header matches one of the instance's `allowedHostnames` → set `Access-Control-Allow-Origin` to that origin
- Otherwise → omit the header (browser blocks the request)

**Plumbing**: Pass `allowedHostnames` from `createApp` opts into `pluginUiStaticRoutes`.

**Tests**: Unit test with matching and non-matching origins.

### 1.5 JWT TTL bounds (MEDIUM)

**File**: `server/src/agent-auth-jwt.ts:34`

**Change**:
```typescript
ttlSeconds: Math.min(
  Math.max(300, parseNumber(process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS, 60 * 60 * 48)),
  30 * 24 * 60 * 60  // max 30 days
)
```

Minimum 5 minutes, maximum 30 days. Log a warning if the configured value was clamped.

**Tests**: Existing JWT tests extended with boundary cases.

### 1.6 Sensitive field redaction in logs (MEDIUM)

**File**: `server/src/middleware/logger.ts`

**New helper**: `redactSensitiveFields(obj)` — recursively replaces values of fields named `password`, `secret`, `token`, `apiKey`, `api_key`, `authorization`, `cookie` with `"[REDACTED]"`.

**Applied** in `customProps` before returning `reqBody`, `reqParams`, `reqQuery`.

**Tests**: Unit test with nested sensitive fields.

### 1.7 DevUiUrl hostname validation (MEDIUM)

**File**: `server/src/routes/plugin-ui-static.ts`

**Change**: Replace the blocklist approach (localhost, 127.0.0.1, ::1) with an allowlist:
- The `devUiUrl` hostname must be in `allowedHostnames` OR be a recognized loopback address
- Use `node:net` `isIP()` + expanded loopback detection covering IPv6 variations (`[::1]`, `0:0:0:0:0:0:0:1`, `0000:0000:0000:0000:0000:0000:0000:0001`)

**Tests**: Unit test with IPv6 variations.

---

## Phase 2 — Database (connection pool)

### 2.1 Explicit connection pool configuration (HIGH)

**File**: `packages/db/src/client.ts:48-51`

**Current code**:
```typescript
export function createDb(url: string) {
  const sql = postgres(url);
  return drizzlePg(sql, { schema });
}
```

**Change**: Add explicit pool options:
```typescript
export function createDb(url: string, opts?: { maxConnections?: number; idleTimeout?: number }) {
  const sql = postgres(url, {
    max: opts?.maxConnections ?? 20,
    idle_timeout: opts?.idleTimeout ?? 30,
    connect_timeout: 10,
    onnotice: () => {},
  });
  return drizzlePg(sql, { schema });
}
```

**Config variables** (in `server/src/config.ts`):
- `PAPERCLIP_DB_POOL_MAX` (default: `20`)
- `PAPERCLIP_DB_POOL_IDLE_TIMEOUT` (default: `30`)

**Caller**: `server/src/index.ts` passes the new options from config.

`createUtilitySql` with `max: 1` remains unchanged (correct for migrations).

---

## Phase 3 — Frontend (robustness, performance, i18n)

### 3.1 Global Error Boundary (CRITICAL)

**New file**: `ui/src/components/ErrorBoundary.tsx`

Class component (required for `componentDidCatch`) that:
- Catches unhandled render errors
- Displays a minimal fallback screen with error message + "Reload page" button
- Logs the error to console

**Mounting in `ui/src/main.tsx`**: Wraps `<App />` after `<StrictMode>`, before `<QueryClientProvider>`.

**Secondary Error Boundary**: Inside `<Layout />` around `<Outlet />`. Page-level errors show in the content area without destroying the sidebar/navigation chrome. Fallback: error message + "Go to Dashboard" link.

### 3.2 Code splitting for heavy pages (MEDIUM)

**File**: `ui/src/App.tsx`

Replace static imports with `React.lazy()` for the heaviest pages:
- `AgentDetail` (~162KB)
- `CompanyImport` (~50KB)
- `ExecutionWorkspaceDetail` (~41KB)
- `PluginManager`

Add `<Suspense fallback={<PageSkeleton />}>` in `<Layout />` around `<Outlet />`. `PageSkeleton` already exists in the codebase.

Lightweight pages (Dashboard, Issues list, etc.) remain static imports.

### 3.3 Context provider consolidation (MEDIUM)

**Current state**: 11 nested provider levels in `main.tsx`.

**Changes**:
1. **New file** `ui/src/context/AppProviders.tsx` — centralizes all provider composition in one file, cleaning up `main.tsx`
2. **Merge `SidebarProvider` + `PanelProvider`** into `LayoutStateProvider` (single context for sidebar + panel state — they share the same domain)
3. **Move `BreadcrumbProvider`** inside `Layout` component (only consumed there)

**Result**: 11 → 8 provider levels. Single import in `main.tsx`.

### 3.4 Full internationalization (MEDIUM)

#### 3.4.1 — i18n infrastructure

**Dependencies**: `react-i18next`, `i18next`, `i18next-browser-languagedetector`

**New directory**: `ui/src/locales/`
```
ui/src/locales/
  en/
    common.json        — shared labels (buttons, states, errors)
    pages/
      dashboard.json
      agents.json
      issues.json
      projects.json
      routines.json
      goals.json
      approvals.json
      costs.json
      activity.json
      settings.json
      plugins.json
      inbox.json
  fr/
    common.json
    pages/
      ... (same structure)
```

**New file**: `ui/src/lib/i18n.ts` — i18next config with:
- Browser language detection (fallback: `en`)
- Lazy namespace loading
- Interpolation escaping enabled

**Init**: Called in `main.tsx` before `createRoot`.

#### 3.4.2 — Key naming convention

```
common.actions.save         → "Save"
common.actions.cancel       → "Cancel"
common.errors.generic       → "Something went wrong"
common.status.active        → "Active"
pages.dashboard.title       → "Dashboard"
pages.agents.detail.title   → "Agent Details"
pages.agents.status.active  → "Active"
```

#### 3.4.3 — Extraction plan (by domain)

| Batch | Scope | Estimated keys |
|-------|-------|----------------|
| 1 | `common.json` — buttons, labels, states, errors | ~80 |
| 2 | Dashboard, Issues, Agents, Projects | ~150 |
| 3 | Routines, Goals, Approvals, Costs, Activity | ~100 |
| 4 | Settings, Plugins, CompanySettings | ~60 |
| 5 | Layout, Sidebar, OnboardingWizard, shared components | ~50 |
| 6 | French translations for all batches | ~440 |

#### 3.4.4 — Language selector

Language picker added in Instance Settings (General page). Persisted in `localStorage`. Auto-detected from browser `navigator.language` on first load.

---

## Phase 4 — Developer Tooling (linting, coverage, CI)

### 4.1 ESLint + Prettier (HIGH)

**New files at root**:

- `eslint.config.js` — ESLint 9 flat config:
  - `@typescript-eslint/recommended`
  - `eslint-plugin-react-hooks`
  - `eslint-plugin-react/jsx-runtime`
  - Ignores: `dist/`, `node_modules/`, `*.generated.*`, SQL migrations
- `.prettierrc` — matches existing code style (2-space indent, double quotes, trailing commas, semicolons)
- `.prettierignore` — `dist/`, `pnpm-lock.yaml`, `*.sql`, `ui-dist/`

**Root `package.json` scripts**:
```json
"lint": "eslint .",
"lint:fix": "eslint . --fix",
"format": "prettier --write .",
"format:check": "prettier --check ."
```

**Adoption strategy**: No codebase-wide format pass. "Boy scout rule" — files touched in a PR get formatted. Initial commit formats only files modified in this plan.

### 4.2 Test coverage (HIGH)

**File**: `vitest.config.ts` (root)

```typescript
coverage: {
  provider: 'v8',
  reporter: ['text', 'json-summary', 'html'],
  reportsDirectory: './coverage',
  include: ['server/src/**/*.ts', 'packages/*/src/**/*.ts', 'cli/src/**/*.ts'],
  exclude: ['**/__tests__/**', '**/*.test.ts', '**/dist/**'],
  thresholds: {
    statements: 50,
    branches: 45,
    functions: 45,
    lines: 50,
  }
}
```

Conservative thresholds (50%) to avoid blocking existing PRs. UI excluded from thresholds (only 4 test files — would be an immediate blocker). Thresholds raised incrementally over time.

### 4.3 CI integration (HIGH)

**File**: `.github/workflows/pr.yml`

Add steps in the `verify` job after `typecheck`:

```yaml
- name: Lint
  run: pnpm lint

- name: Format check
  run: pnpm format:check

- name: Test with coverage
  run: pnpm test:run --coverage
```

Lint and format checks are blocking. Coverage is reported and fails only if below the base thresholds.

---

## Summary

| Phase | Scope | Alerts addressed | New deps |
|-------|-------|------------------|----------|
| 1 — Server | Auth, middleware, config | 3 critical + 3 high + 3 medium | `express-rate-limit`, `helmet` |
| 2 — Database | Connection pool | 1 high | None |
| 3 — Frontend | ErrorBoundary, splitting, providers, i18n | 1 critical + 4 medium | `react-i18next`, `i18next`, `i18next-browser-languagedetector` |
| 4 — Tooling | Lint, coverage, CI | 2 high | `eslint`, `prettier`, `@typescript-eslint/*`, `eslint-plugin-react-hooks`, `@vitest/coverage-v8` |

## Files modified (non-exhaustive)

**Server**:
- `server/src/auth/better-auth.ts`
- `server/src/agent-auth-jwt.ts`
- `server/src/app.ts`
- `server/src/config.ts`
- `server/src/middleware/logger.ts`
- `server/src/middleware/rate-limit.ts` (new)
- `server/src/routes/plugin-ui-static.ts`
- `server/package.json`

**Database**:
- `packages/db/src/client.ts`

**Frontend**:
- `ui/src/main.tsx`
- `ui/src/App.tsx`
- `ui/src/components/ErrorBoundary.tsx` (new)
- `ui/src/context/AppProviders.tsx` (new)
- `ui/src/context/LayoutStateProvider.tsx` (new)
- `ui/src/lib/i18n.ts` (new)
- `ui/src/locales/` (new directory tree)
- All 40+ page/component files (i18n extraction)
- `ui/package.json`

**Tooling**:
- `eslint.config.js` (new)
- `.prettierrc` (new)
- `.prettierignore` (new)
- `vitest.config.ts`
- `.github/workflows/pr.yml`
- `package.json`

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| i18n extraction breaks string interpolation | Each batch is tested manually + snapshot comparison of rendered output |
| Rate limiting blocks legitimate burst traffic | Configurable limits + disable flag for reverse-proxy setups |
| Prettier reformats trigger noisy diffs | Boy scout rule, no mass-format commit |
| Coverage thresholds block unrelated PRs | Conservative 50% initial threshold, UI excluded |
| `helmet` breaks plugin iframe loading | `crossOriginEmbedderPolicy: false` explicitly set |
