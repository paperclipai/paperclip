# Phase 45: Embedded Postgres Runtime Coverage - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-29
**Phase:** 45-embedded-postgres-runtime-coverage
**Mode:** auto
**Areas discussed:** Embedded Postgres skip evidence, Windows host-ready focused path, Route-level persistence coverage, Release confidence classification, Verification

---

## Embedded Postgres Skip Evidence

| Option | Description | Selected |
|--------|-------------|----------|
| Preserve Windows default skip and make it structured evidence | Keep the current Windows-safe default, but record env/host/probe/fallback data in machine-readable and human-readable form. | yes |
| Remove the Windows default skip | Force embedded Postgres suites to run in default Windows `pnpm test`. | |
| Leave console-only skip messages | Keep current behavior and rely on Vitest output. | |

**Auto selection:** Preserve Windows default skip and make it structured evidence.
**Notes:** Selected because the phase goal says skip must not be hidden, not that default Windows runs must become mandatory.

---

## Windows Host-Ready Focused Path

| Option | Description | Selected |
|--------|-------------|----------|
| Add a repo-owned focused command | Provide a package script or release-host slice that enables embedded Postgres tests with isolated runtime paths. | yes |
| Document a manual env-var invocation only | Tell operators to run Vitest manually with `PAPERCLIP_ENABLE_EMBEDDED_POSTGRES_TESTS=true`. | |
| Fold all embedded Postgres suites into full release-host verification | Run every embedded Postgres test in the default full-suite harness. | |

**Auto selection:** Add a repo-owned focused command.
**Notes:** This matches Phase 44's command-surface pattern and keeps the release-host path auditable.

---

## Route-Level Persistence Coverage

| Option | Description | Selected |
|--------|-------------|----------|
| Use existing RT2 route suites as the first gate | Target `rt2-task-routes.test.ts` and `rt2-daily-report-routes.test.ts`, adding persistence assertions if needed. | yes |
| Cover only DB package migration tests | Validate migrations/client behavior without route-level flow. | |
| Create a broad all-routes embedded Postgres suite | Attempt to run every route test against embedded Postgres. | |

**Auto selection:** Use existing RT2 route suites as the first gate.
**Notes:** The roadmap explicitly requires route-level persistence flow, and these files already use the embedded Postgres helper.

---

## Release Confidence Classification

| Option | Description | Selected |
|--------|-------------|----------|
| Distinguish accepted debt from blocker | Default skip is accepted debt; focused host-ready failure is blocker; focused pass satisfies the coverage signal. | yes |
| Treat skipped embedded Postgres tests as pass | Release-host output remains green even when persistence coverage did not run. | |
| Treat any skip as blocker | Default Windows `pnpm test` fails unless embedded Postgres runs. | |

**Auto selection:** Distinguish accepted debt from blocker.
**Notes:** This keeps release confidence honest without destabilizing ordinary default test runs.

---

## Verification

| Option | Description | Selected |
|--------|-------------|----------|
| Fixture-test classification and opt-in real host suite | Unit-test evidence parsing/classification without starting Postgres; run the focused real suite when host-ready. | yes |
| Only run the real embedded Postgres suite | Depend on host capability for all verification. | |
| Only test the classifier | Avoid real embedded Postgres execution entirely. | |

**Auto selection:** Fixture-test classification and opt-in real host suite.
**Notes:** This provides deterministic coverage for release confidence behavior while preserving a real host-ready path.

---

## the agent's Discretion

- Exact reason-code names and JSON/report field names.
- Whether evidence production lives in the DB test helper, release-host script, or a shared helper.
- Exact focused suite list beyond the required route persistence target.

## Deferred Ideas

- Phase 46 artifact/UAT truth alignment.
- Phase 47 operator-facing runtime confidence surface.
- Making embedded Postgres mandatory in every default Windows `pnpm test` run.
