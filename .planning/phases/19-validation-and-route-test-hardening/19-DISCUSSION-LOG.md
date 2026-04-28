# Phase 19: Validation and Route Test Hardening - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md.

**Date:** 2026-04-25
**Phase:** 19-Validation and Route Test Hardening
**Mode:** `--auto --chain`

---

## Validation Artifact Shape

| Option | Description | Selected |
|--------|-------------|----------|
| Add strict `VALIDATION.md` beside existing `VERIFICATION.md` | Keeps previous evidence and adds Nyquist-style coverage | yes |
| Rewrite existing verification docs | Higher churn, loses audit history | |
| Defer validation artifacts | Leaves v2.2 audit in `tech_debt` | |

**Auto choice:** Add strict `VALIDATION.md` beside existing `VERIFICATION.md`.

## Route Test Fallback

| Option | Description | Selected |
|--------|-------------|----------|
| Add mock-backed fallback route tests | Runs without embedded Postgres and validates route contracts | yes |
| Keep embedded-only tests | Preserves skip debt on unsupported hosts | |
| Replace embedded suites entirely | Loses DB-backed confidence | |

**Auto choice:** Add mock-backed fallback route tests while preserving embedded suites.

## Alignment Scorecard Sync

| Option | Description | Selected |
|--------|-------------|----------|
| Add `validated/tech_debt/deferred` status to scorecard | Makes audit state visible in product UI | yes |
| Only update markdown audit | Less visible to operators | |
| Leave v2.2 score unchanged | Does not satisfy VALID-03 | |

**Auto choice:** Add visible validation state to the in-app scorecard and markdown alignment note.

## Deferred Ideas

- Phase 20-23 will implement actual external connectors and advanced product capabilities.
