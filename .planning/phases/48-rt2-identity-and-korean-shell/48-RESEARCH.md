# Phase 48: RT2 Identity and Korean Shell - Research

**Researched:** 2026-04-30
**Domain:** React/Vite product-facing shell copy, metadata, and UI identity hardening
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Product-facing app shell, startup, navigation, settings, empty states, browser title, and fallback/loading states must be RealTycoon2-first and Korean-first.
- Visible `Paperclip`, `Paper Company`, and `Multica` copy is not allowed in product-facing UI, while internal identifiers/build markers may remain.
- Preserve existing route structure and company-prefix redirects; Phase 49 owns changing the daily board as first operational surface.
- Use concise Korean operational copy, not marketing copy.
- Focus verification on product-facing shell targets; do not scan-ban the whole repo.

### the agent's Discretion
- Exact Korean phrasing.
- Whether to use small shared constants for repeated product name/copy.
- Exact focused test boundaries.

### Deferred Ideas (OUT OF SCOPE)
- Phase 49 daily 3-lane board as primary work surface.
- Phase 50 card quick edit and board controls.
- Phase 51 One-Liner to board review flow.
- Phase 52 supporting surfaces and broader regression gate.
</user_constraints>

<architectural_responsibility_map>
## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Static browser/install identity | CDN/Static | Browser/Client | `ui/index.html` owns initial metadata before React mounts. |
| Runtime title and app breadcrumbs | Browser/Client | — | `BreadcrumbContext` already updates `document.title`. |
| Navigation and shell copy | Browser/Client | — | React shell components own visible navigation labels and actions. |
| Settings/onboarding/fallback copy | Browser/Client | API/Backend | UI pages render the copy; backend error text should not be changed unless surfaced directly. |
| Identity regression tests | Browser/Client | Tooling | Vitest component tests and narrow source scans are sufficient for this phase. |
</architectural_responsibility_map>

<research_summary>
## Summary

This phase is a brownfield React/Vite UI identity cleanup. No new library is needed. The implementation should use the existing component structure, `useBreadcrumbs`, `PageSkeleton`, Lucide icons, and existing component tests.

The standard approach is to separate stable route/API identifiers from visible copy. URLs and package names can remain English/Paperclip-derived, while labels, metadata, empty states, and help/version text become RealTycoon2/Korean-first.

**Primary recommendation:** Make focused, product-facing UI copy changes in the shell targets listed in CONTEXT.md, then add a narrow identity regression test for those targets.
</research_summary>

<standard_stack>
## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| React | repo-managed | UI rendering | Existing frontend framework. |
| Vite | repo-managed | Static app shell and dev build | Owns `ui/index.html` injection and runtime. |
| Vitest + Testing Library | repo-managed | Component tests | Existing test pattern across shell components. |
| Lucide React | repo-managed | Navigation/action icons | Existing icon library in shell. |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Tailwind CSS | repo-managed | Existing utility styling | Preserve current layout/spacing while changing copy. |
| `rg`/script scan | system/repo | Focused string regression | Use only against product-facing target files. |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Component-local copy | Full i18n framework | Too broad for Phase 48; no multi-language requirement. |
| Narrow regression scan | Repo-wide forbidden-token ban | Repo-wide ban would fail internal package/API/test references that are intentionally Paperclip-derived. |
</standard_stack>

<architecture_patterns>
## Architecture Patterns

### Pattern 1: Keep Routes Stable, Change Labels
**What:** Leave route paths such as `/one-liner`, `/instance/settings`, and `/company/settings` unchanged while changing user-facing labels to Korean.
**When to use:** Brownfield product identity cleanup where deep links and tests already rely on paths.

### Pattern 2: Static Metadata First, Runtime Title Second
**What:** `ui/index.html` provides the first visible document/install title; `BreadcrumbContext` adjusts title after React route state is known.
**When to use:** Vite apps where the first viewport should not flash old branding before React mounts.

### Pattern 3: Product-Facing Scan Boundary
**What:** Scan only app shell/source targets that render visible product UI.
**When to use:** Repos where internal identifiers still legitimately contain legacy names.

### Anti-Patterns to Avoid
- **Changing API/package identifiers for copy cleanup:** This increases risk without improving visible identity.
- **Adding i18n infrastructure now:** Phase 48 needs Korean default copy, not a localization platform.
- **Only changing `index.html`:** React shell and fallback states would still feel like an English control plane.
</architecture_patterns>

<dont_hand_roll>
## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Runtime title management | New document-title service | Existing `BreadcrumbContext` | Already wired through pages. |
| Loading visuals | New skeleton system | Existing `PageSkeleton` | Avoids new UI surface. |
| Navigation icons | Manual SVGs | Existing Lucide icons | Matches repo convention. |
| Identity regression | Whole-repo parser | Focused Vitest/source scan | Avoids false positives. |
</dont_hand_roll>

<common_pitfalls>
## Common Pitfalls

### Pitfall 1: Visible Legacy Copy Hidden In Menus
**What goes wrong:** Main nav looks Korean, but account/help/settings menus still say Paperclip or English defaults.
**How to avoid:** Include account menu, company menu, instance/company settings sidebars, and settings pages in the target list.

### Pitfall 2: Route Semantics Drift
**What goes wrong:** Copy cleanup accidentally changes default route behavior before Phase 49.
**How to avoid:** Preserve redirects and path segments; only change labels/fallback text.

### Pitfall 3: Regression Scan Too Broad
**What goes wrong:** Tests fail on internal package names and developer fixtures.
**How to avoid:** Restrict forbidden visible-token checks to product-facing shell files and metadata.
</common_pitfalls>

<open_questions>
## Open Questions

None blocking. Exact Korean phrasing can be selected during execution using the context decisions.
</open_questions>

<sources>
## Sources

### Primary (HIGH confidence)
- `.planning/phases/48-rt2-identity-and-korean-shell/48-CONTEXT.md` - locked Phase 48 decisions.
- `ui/index.html` - first-load metadata.
- `ui/src/context/BreadcrumbContext.tsx` - runtime document title behavior.
- `ui/src/components/Sidebar*.tsx`, `InstanceSidebar.tsx`, `CompanySettingsSidebar.tsx`, `CompanyRail.tsx`, `MobileBottomNav.tsx` - shell copy surfaces.
- `ui/src/App.tsx`, `ui/src/pages/InstanceGeneralSettings.tsx`, `ui/src/pages/NotFound.tsx` - startup/settings/fallback copy.
</sources>

<metadata>
## Metadata

**Research scope:**
- Core technology: React/Vite shell and Vitest component tests.
- Patterns: metadata-first branding, route-stable copy replacement, focused visible-copy regression.
- Pitfalls: legacy naming leaks, route drift, false-positive scan gates.

**Confidence breakdown:**
- Standard stack: HIGH - existing repo conventions are clear.
- Architecture: HIGH - changes are UI shell/copy only.
- Pitfalls: HIGH - directly observed in current files.

**Research date:** 2026-04-30
**Valid until:** 2026-05-30
</metadata>

---

*Phase: 48-rt2-identity-and-korean-shell*
*Research completed: 2026-04-30*
*Ready for planning: yes*
