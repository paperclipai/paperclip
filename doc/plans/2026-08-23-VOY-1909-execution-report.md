# VOY-1909: Repository Separation — Execution Summary

## Status: In Progress — Assessment & Migration Complete

## Files Migrated to Voyonder Repository

### 1. Paperclip Bridge Adapter
**Source:** `server/src/services/voyonder-bridge.ts` (on remote branch)
**Target:** `/Users/benh/Programming/voyonder/server/src/services/paperclip-bridge.ts`

The bridge implements Paperclip's EventBus, AuthProvider, and LoggerProvider
interfaces. It wraps Paperclip internals (live-events, authz, pino logger)
so these can be passed to `createVoyonderApp()` when mounting Voyonder
routes inside Paperclip.

### 2. Shared Type Interfaces (Reference Copies)
Copied from remote branch to `/Users/benh/Programming/voyonder/packages/types/src/reference/`:
- `event-bus.ts` — EventBus interface
- `auth-provider.ts` — AuthProvider interface  
- `logger.ts` — LoggerProvider interface
- `background-job.ts` — Background job types
- `background-job-types.ts` — Background job type constants
- `usage-analytics.ts` — Usage analytics data types

Note: These types already exist in `@voyonder/types` (derived from the
published `@paperclipai/shared` package). The reference copies are for
audit/alignment purposes.

### 3. Pricing.tsx Voyonder-Specific Diff
**Source:** `ui/src/pages/Pricing.tsx` (remote branch diff)
**Target:** `/Users/benh/Programming/voyonder/pricing-tsx-voyonder-diff.diff`

The Pricing.tsx enhancements add variant B experiment UX (confirmation
dialog, billing period toggle, hero CTA bar, experiment badge). These are
Voyonder-specific and should be moved to Voyonder's own pricing page or
gated behind a feature flag.

## Remaining Work

### A. Merge Paperclip-Core Improvements to Master
The following changes on the remote branch are Paperclip-core platform
improvements that should be merged to master:

1. **Knowledge Base** — `server/src/services/knowledge.ts`,
   `server/src/routes/knowledge.ts`, seed scripts
2. **Sentry Error Tracking** — `server/src/middleware/sentry.ts`,
   `server/src/services/sentry.ts`, `ui/src/lib/sentry.ts`
3. **Usage Analytics** — `server/src/services/usage-analytics.ts`,
   `server/src/routes/usage-analytics.ts`, `ui/src/pages/UsageAnalytics.tsx`,
   `ui/src/api/usage-analytics.ts`
4. **Shared Package Updates** — `packages/shared/src/constants.ts` (live event
   types), type exports
5. **Server Wiring** — `server/src/app.ts`, `server/src/index.ts`, route/service
   registrations
6. **UI Wiring** — `ui/src/App.tsx`, `ui/src/lib/queryKeys.ts`,
   `ui/src/hooks/usePageMeta.ts`, `ui/index.html`

### B. Extract/Remove Voyonder-Specific Code
1. `server/src/services/voyonder-bridge.ts` — ✅ Already copied to Voyonder
   repo. Documented as Paperclip's adapter layer.
2. `ui/src/pages/Pricing.tsx` Voyonder UX — ✅ Diff saved. Needs to be
   moved to Voyonder's pricing page.
3. `packages/shared/src/types/event-bus.ts`, `auth-provider.ts`,
   `logger.ts`, `background-job.ts` — Already published to npm as
   `@paperclipai/shared`. Voyonder consumes from npm.
4. `packages/shared/src/background-job-types.ts` — Already published. No
   Voyonder-specific constants should leak (VOY-1714 fix applied).

### C. Clean Up Branch
The local branch `found/vo/vo--voyonder-code-separation-shared-contract-types`
was reset to only contain the pricing commit. The remote branch
`remotes/origin/found/vo/vo--voyonder-code-separation-shared-contract-types`
still has the full separation history.

Recommended approach:
1. Create a new branch from master for Paperclip-core improvements (knowledge,
   sentry, usage-analytics, shared package updates)
2. Create a PR and merge those to master
3. Then delete the old separation branch
4. Ensure Voyonder repo has all necessary code

## Architecture Summary

```
Paperclip Monorepo (master)          Voyonder Repo
├── @paperclipai/shared (npm) ──────→ @voyonder/types (from npm)
├── @paperclipai/db (npm) ──────────→ @voyonder/db (from npm)  
├── server/src/services/
│   └── voyonder-bridge.ts ─────────→ server/src/services/paperclip-bridge.ts
├── server/src/app.ts (mounts
│   Voyonder routes via bridge)      
└── ui/src/pages/Pricing.tsx ───────→ (Voyonder's own pricing page)
```

The bridge implementations wrap Paperclip internals and stay in Paperclip.
Voyonder's `createVoyonderApp()` accepts interfaces from `@voyonder/types`
and Paperclip passes its bridge implementations when mounting.

## Reference
- VOY-1907: CEO Board Pulse — Repository Separation directive
- VOY-1657: Shared contract types + workspace link
- VOY-1834: Code Separation Phase 2 (released)
- VOY-1909: This issue
