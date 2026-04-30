# Phase 48: RT2 Identity and Korean Shell - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions captured in CONTEXT.md — this log preserves the automatic discussion choices.

**Date:** 2026-04-30
**Phase:** 48-rt2-identity-and-korean-shell
**Mode:** auto
**Areas analyzed:** Brand surface and startup identity, Korean-first shell copy, legacy naming cleanup, settings/onboarding/fallback behavior, navigation priority, verification

## Auto-Selected Gray Areas

[--auto] Selected all gray areas:
- Brand surface and startup identity
- Korean-first shell copy
- Legacy naming cleanup
- Settings/onboarding/fallback behavior
- Navigation priority
- Verification

## Decisions Presented And Auto-Resolved

### Brand surface and startup identity
- **Q:** Should Phase 48 update document metadata and install title?
  - **Selected:** Yes. `ui/index.html` should be RealTycoon2-first and Korean-locale by default.
  - **Reason:** `ui/index.html` still has `lang="en"`, `apple-mobile-web-app-title="Paperclip"`, and `<title>Paperclip</title>`, while requirements IDENT-01 and IDENT-04 require first-viewport and browser/loading/fallback branding to identify RealTycoon2.

### Korean-first shell copy
- **Q:** Should shell copy be translated broadly or only the exact legacy brand leaks?
  - **Selected:** Broad Korean-first shell copy for product-facing chrome.
  - **Reason:** IDENT-03 covers onboarding, empty states, settings, errors, and help copy. Narrow brand replacement would leave the app feeling like an English control plane.

### Legacy naming cleanup
- **Q:** Should Paperclip be banned everywhere?
  - **Selected:** No. Ban visible product-facing usage, preserve internal identifiers/developer surfaces.
  - **Reason:** This is a brownfield Paperclip-derived repo. Package names, APIs, adapter names, build markers, and internal developer docs can remain stable while user-facing UI becomes RT2-first.

### Settings/onboarding/fallback behavior
- **Q:** Should settings and onboarding remain English because they are admin surfaces?
  - **Selected:** No. Settings and onboarding are operator-facing and should use Korean defaults.
  - **Reason:** Phase 48 explicitly includes settings, onboarding, empty states, errors, loading, and fallback states.

### Navigation priority
- **Q:** Should Phase 48 make the board the first route?
  - **Selected:** Preserve the existing `one-liner` route behavior and adjust labels/copy only.
  - **Reason:** Phase 49 owns making the daily 3-lane board the first operational work surface. Changing route semantics now would create scope creep.

### Verification
- **Q:** Should verification use a repo-wide string ban?
  - **Selected:** Use focused shell tests and a product-facing target scan, not a repo-wide ban.
  - **Reason:** Internal code and tests legitimately contain Paperclip. The requirement targets product-facing UI copy.

## Auto-Resolved

- All selected decisions used recommended defaults under `--auto`; no user corrections were requested.
- No pending todos matched the phase scope.
- No deferred idea was introduced during discussion beyond roadmap-defined later phases.

## Codebase Evidence Used

- `ui/index.html` has static Paperclip title/mobile metadata.
- `ui/src/context/BreadcrumbContext.tsx` already sets runtime title to RealTycoon2.
- `ui/src/components/CompanyRail.tsx` already has a RealTycoon2 brand mark and Korean add-company affordance.
- `ui/src/components/MobileBottomNav.tsx` already uses concise Korean labels.
- `ui/src/components/Sidebar.tsx`, `SidebarAccountMenu.tsx`, `SidebarCompanyMenu.tsx`, `InstanceSidebar.tsx`, `CompanySettingsSidebar.tsx`, `App.tsx`, `InstanceGeneralSettings.tsx`, and `NotFound.tsx` contain English shell/settings/fallback copy or visible Paperclip help/version copy that Phase 48 should address.

## Deferred Ideas

- Phase 49: daily 3-lane board as primary operational work surface.
- Phase 50: quick edit and board controls.
- Phase 51: One-Liner to board capture/review flow.
- Phase 52: supporting surfaces and broader identity regression gate.
