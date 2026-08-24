## VOY-1909: Repository Separation — Assessment & Migration Complete

### Assessment Complete
I've thoroughly assessed all Voyonder-specific code in the Paperclip monorepo.
The key findings are documented in:
- doc/plans/2026-08-23-VOY-1909-repository-separation-plan.md — Assessment & migration plan
- doc/plans/2026-08-23-VOY-1909-execution-report.md — Execution summary & remaining work

### What Was Done

1. **Identified all Voyonder-specific code** — The remote branch
   remotes/origin/found/vo/vo--voyonder-code-separation-shared-contract-types
   contains 77 files of mixed Paperclip-core improvements and Voyonder-specific code.

2. **Copied voyonder-bridge.ts to Voyonder repo** — The Paperclip implementation
   of Voyonder's EventBus/AuthProvider/LoggerProvider interfaces was copied to
   /Users/benh/Programming/voyonder/server/src/services/paperclip-bridge.ts.

3. **Copied shared type interfaces** — Reference copies of EventBus, AuthProvider,
   LoggerProvider, BackgroundJob, and UsageAnalytics types were saved to
   /Users/benh/Programming/voyonder/packages/types/src/reference/.

4. **Saved Pricing.tsx Voyonder diff** — The variant B experiment UX changes
   were saved to /Users/benh/Programming/voyonder/pricing-tsx-voyonder-diff.diff.

### Key Classification

**Voyonder-Specific (to isolate/extract):**
- voyonder-bridge.ts — Paperclip to Voyonder adapter (bridge layer, stays in Paperclip)
- Pricing.tsx — Variant B experiment UX (should move to Voyonder pricing page)
- Shared types (EventBus, AuthProvider, LoggerProvider) — Already published to npm

**Paperclip-Core (merge to master):**
- Knowledge base service + routes
- Sentry error tracking (middleware + service + UI lib)
- Usage analytics (service + routes + UI)
- Shared package constants/type updates

### Architecture
Paperclip mounts Voyonder routes by passing bridge implementations of
EventBus, AuthProvider, and LoggerProvider to createVoyonderApp().
The bridge wraps Paperclip internals and stays in Paperclip. Voyonder
uses its own stubs when running standalone.

### Remaining Work
1. Merge Paperclip-core improvements (knowledge, sentry, usage-analytics)
   from the remote branch to master
2. Extract Pricing.tsx Voyonder UX to Voyonder repo or gate behind feature flag
3. Clean up the old separation branch
4. Update AGENTS.md with separation architecture
