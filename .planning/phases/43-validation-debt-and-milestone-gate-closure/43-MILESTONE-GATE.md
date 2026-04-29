# Phase 43: Milestone Artifact Gate

**Date:** 2026-04-29
**Status:** implemented

## Command

```sh
pnpm run rt2:milestone-gate
```

Equivalent direct command:

```sh
node scripts/rt2-milestone-artifact-gate.mjs
```

## What It Checks

The gate checks the v2.6 close path and the historical validation debt that Phase 43 is responsible for:

- Phase 39-43 phase directories exist.
- Phase 39-43 have `*-SUMMARY.md`, `*-VERIFICATION.md`, and `*-VALIDATION.md` artifacts.
- Phase 39-43 summaries include YAML frontmatter with `phase`, `status`, and requirement fields.
- Phase 19-24 historical strict `*-VALIDATION.md` artifacts exist.
- Phase 43 legacy UAT closure artifact exists.
- `.planning/REQUIREMENTS.md` has v2.6 requirement checkboxes checked.
- `.planning/REQUIREMENTS.md` traceability rows mark v2.6 requirements complete.

## Failure Shape

Failures include reason codes, file paths, and a short message. Example reason codes:

- `SUMMARY_MISSING`
- `SUMMARY_FRONTMATTER_MISSING`
- `SUMMARY_REQUIREMENTS_FIELD_MISSING`
- `VERIFICATION_MISSING`
- `VALIDATION_MISSING`
- `HISTORICAL_VALIDATION_MISSING`
- `LEGACY_UAT_CLOSURE_MISSING`
- `REQUIREMENT_CHECKBOX_OPEN`
- `REQUIREMENT_TRACEABILITY_INCOMPLETE`

## Test Command

```sh
pnpm run test:milestone-gate
```

This test builds temporary pass/fail planning fixtures and verifies that the gate passes complete artifacts and reports missing validation artifacts with explicit paths.

## Scope

This gate is deterministic filesystem and markdown/frontmatter validation. It does not call external providers, external network, browser E2E, embedded Postgres, or live LLM evaluation.

