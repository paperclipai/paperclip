# Phase 46: Artifact and UAT Truth Alignment - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-30
**Phase:** 46-artifact-and-uat-truth-alignment
**Areas discussed:** milestone artifact gate scope, validation frontmatter truth, legacy UAT closure truth, requirement traceability, verification
**Mode:** auto

---

## Milestone Artifact Gate Scope

| Option | Description | Selected |
|--------|-------------|----------|
| Extend `scripts/rt2-milestone-artifact-gate.mjs` | Reuse the Phase 43 deterministic repo-local artifact gate and expand it for v2.7. | yes |
| Add a separate v2.7 gate | Create a second script for v2.7 truth alignment only. | |
| Use only GSD external tooling | Depend on external workflow tooling rather than repo-owned release scripts. | |

**Auto choice:** Extend `scripts/rt2-milestone-artifact-gate.mjs`.
**Notes:** This follows Phase 43-45 script/test conventions and avoids split truth between two gates.

---

## Validation Frontmatter Truth

| Option | Description | Selected |
|--------|-------------|----------|
| Require machine-readable validation frontmatter | Current milestone `*-VALIDATION.md` files must expose status and requirement list that agrees with summary and verification evidence. | yes |
| Trust prose status headings | Treat body text such as `Status: passed` as enough. | |
| Patch only Phase 39 | Fix the known stale historical file without adding a reusable active-milestone rule. | |

**Auto choice:** Require machine-readable validation frontmatter.
**Notes:** ART-01 specifically needs stale validation frontmatter rejection. A reusable v2.7 rule is more useful than a one-off historical patch.

---

## Legacy UAT Closure Truth

| Option | Description | Selected |
|--------|-------------|----------|
| Use Phase 43 closure artifact as canonical | Parse or structure `43-LEGACY-UAT-CLOSURE.md` so tools and milestone docs report the same classifications. | yes |
| Rewrite old UAT checkboxes | Edit historical UAT files until audit-open no longer reports unknown. | |
| Keep manual documentation only | Leave scripts and docs with potentially different UAT status language. | |

**Auto choice:** Use Phase 43 closure artifact as canonical.
**Notes:** Historical UAT files are snapshots; closure truth should be classified, not manufactured.

---

## Requirement Traceability

| Option | Description | Selected |
|--------|-------------|----------|
| Enforce one phase and one verification artifact per requirement | Gate fails when active v2.7 requirements are duplicated, missing, or not backed by the matching verification artifact. | yes |
| Check only `.planning/REQUIREMENTS.md` rows | Keep traceability validation limited to the requirements table. | |
| Defer to milestone close audit | Let the final audit discover traceability mismatch later. | |

**Auto choice:** Enforce one phase and one verification artifact per requirement.
**Notes:** This directly covers ART-03 and matches retrospective lessons about updating traceability at phase close.

---

## Verification

| Option | Description | Selected |
|--------|-------------|----------|
| Focused fixture tests plus normal typecheck/gate run | Add deterministic script tests for new failure modes, then run `pnpm test:milestone-gate`, `pnpm typecheck`, and `pnpm rt2:milestone-gate`. | yes |
| Full suite only | Rely on `pnpm test` to cover artifact gate behavior indirectly. | |
| Manual artifact inspection | Verify by reading planning files without automated gate checks. | |

**Auto choice:** Focused fixture tests plus normal typecheck/gate run.
**Notes:** This follows existing script test style and keeps Phase 46 release-host friendly.

---

## the agent's Discretion

- Exact validation frontmatter schema beyond the required status/phase/requirements fields.
- Exact legacy UAT parser or structured-summary representation.
- Exact issue-code names, as long as failures remain path-specific and machine-readable.

## Deferred Ideas

- Runtime confidence operations surface/report aggregation remains Phase 47.
- Release-host execution and embedded Postgres runtime policy changes remain outside Phase 46.
