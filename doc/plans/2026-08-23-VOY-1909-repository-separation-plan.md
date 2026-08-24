# VOY-1909: Repository Separation — Assessment & Migration Plan

## Status: Assessment Complete

## Background

Per CEO Board Pulse VOY-1907, all Voyonder product code must reside in a
separate repository. Phase 1 (release/vo/voyonder-code-separation-phase-1)
published `@paperclipai/shared@0.3.3` and `@paperclipai/db@0.3.3` to npm and
Voyonder now consumes those as published packages.

Phase 2 (branch found/vo/vo--voyonder-code-separation-shared-contract-types)
prepared additional code extraction that has not yet been merged to master.

## Current Architecture

### Voyonder repo (`/Users/benh/Programming/voyonder`)
- `@voyonder/types` — Voyonder-owned interfaces (EventBus, AuthProvider,
  LoggerProvider, BackgroundJob, LiveEvent). Depends on `@paperclipai/shared`.
- `@voyonder/db` — Voyonder-owned DB schema wrappers. Depends on `@paperclipai/db`.
- `@voyonder/product` — Server code with background jobs, research, authz,
  live events, logger, sentry.

### Paperclip monorepo — Voyonder-specific code still present

The following Voyonder-specific code exists on the branch
`found/vo/vo--voyonder-code-separation-shared-contract-types` but NOT on master:

#### 1. voyonder-bridge adapter (`server/src/services/voyonder-bridge.ts`)
Paperclip's implementation of Voyonder's EventBus, AuthProvider, and
LoggerProvider interfaces. Wraps Paperclip internal services:
- `publishLiveEvent` / `subscribeCompanyLiveEvents` (live-events)
- `assertAuthenticated` / `assertCompanyAccess` (authz)
- `logger` (pino)

**Disposition:** This is Voyonder-specific code that wraps Paperclip internals.
It should remain in Paperclip as the bridge layer. The Voyonder repo has
standalone stubs in `lib/authz.ts`, `lib/live-events.ts`, `lib/logger.ts`
that are used when Voyonder runs independently. Paperclip passes its bridge
implementations to `createVoyonderApp()` when mounting Voyonder routes.

#### 2. Pricing.tsx UX enhancements (`ui/src/pages/Pricing.tsx`)
Adds Voyonder-specific variant B experiment features:
- A/B experiment badge and variant B UI
- Billing period toggle (monthly/yearly)
- Confirmation dialog before checkout
- Hero CTA bar ("Get Started Today")
- "Start Free Trial" instead of "Subscribe" for variant B

**Disposition:** Voyonder-specific pricing UX. Should be extracted to the
Voyonder repo for its own pricing page, or gated behind a feature flag.

#### 3. Shared type interfaces (packages/shared/src/types/)
- `event-bus.ts`, `auth-provider.ts`, `logger.ts` — Decoupling interfaces
- `background-job.ts`, `background-job-types.ts` — Background job types
- `usage-analytics.ts` — Usage analytics data types

**Disposition:** These are already published to npm as `@paperclipai/shared` and
duplicated in `@voyonder/types`. No further action needed for the types
themselves; they serve as the shared contract between Paperclip and Voyonder.

#### 4. Usage analytics (service + routes + UI)
- `server/src/services/usage-analytics.ts`
- `server/src/routes/usage-analytics.ts`
- `ui/src/pages/UsageAnalytics.tsx`
- `ui/src/api/usage-analytics.ts`

**Disposition:** Paperclip-core feature (internal analytics for Paperclip
instance operators). Should be merged to master as part of Paperclip platform.

#### 5. Sentry error tracking (middleware + service + UI lib)
- `server/src/middleware/sentry.ts`
- `server/src/services/sentry.ts`
- `ui/src/lib/sentry.ts`

**Disposition:** Paperclip-core infrastructure. Should be merged to master.

#### 6. Knowledge base (service + routes)
- `server/src/services/knowledge.ts`
- `server/src/routes/knowledge.ts`
- `server/scripts/seed-knowledge-faq.ts`

**Disposition:** Paperclip-core feature. Should be merged to master.

## Action Items

### A. Merge Paperclip-core improvements to master
- [ ] Knowledge base service + routes
- [ ] Sentry middleware + service + UI lib
- [ ] Usage analytics service + routes + UI
- [ ] DB schema pricing experiment columns
- [ ] Server app/index.ts wiring for core features
- [ ] UI hook + query key additions for core features

### B. Move Voyonder-specific code
- [x] voyonder-bridge.ts — Documented and isolated; stays in Paperclip
      as the adapter layer. Voyonder's standalone stubs already exist.
- [ ] Pricing.tsx Voyonder-specific UX — Extract to Voyonder repo or gate
      behind feature flag
- [ ] Ensure no Voyonder-specific BACKGROUND_JOB_TYPES leak into
      @paperclipai/shared (already fixed per commit d8d0494)

### C. Clean up branch
- [ ] Rebase the branch against master
- [ ] Split into Paperclip-core PR and Voyonder-extraction
- [ ] Remove Voyonder-specific code from Paperclip master

### D. Document separation boundaries
- [x] This document serves as the assessment
- [ ] Add separation architecture to AGENTS.md

## Reference
- VOY-1907: CEO Board Pulse — Repository Separation directive
- VOY-1657: Shared contract types + workspace link
- VOY-1834: Code Separation Phase 2 (released)
- VOY-1909: This issue
