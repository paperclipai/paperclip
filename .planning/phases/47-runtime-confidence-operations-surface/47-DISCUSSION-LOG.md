# Phase 47: Runtime Confidence Operations Surface - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-30
**Phase:** 47-runtime-confidence-operations-surface
**Areas discussed:** Surface shape, Evidence inputs, Debt taxonomy, Operator report content, Implementation pattern, Verification
**Mode:** auto

---

## Surface Shape

| Option | Description | Selected |
|--------|-------------|----------|
| Generated report/CLI operations surface | Create a repo-owned command that emits JSON and Markdown evidence. | yes |
| New React dashboard | Add an in-app operations page immediately. | |
| Documentation-only summary | Explain how to manually read release-host and milestone-gate outputs. | |

**Auto selection:** Generated report/CLI operations surface.
**Notes:** This satisfies "앱 또는 generated report" with the smallest reliable close path and keeps UI work deferred until the data contract proves useful.

---

## Evidence Inputs

| Option | Description | Selected |
|--------|-------------|----------|
| Consume release-host summary and milestone gate JSON | Use Phase 44/45 and Phase 46 outputs as canonical inputs. | yes |
| Re-run all verification commands inside the report | Make report generation execute typecheck/test/gates directly. | |
| Scrape Markdown reports only | Parse existing human reports instead of consuming structured data. | |

**Auto selection:** Consume release-host summary and milestone gate JSON.
**Notes:** Report generation should aggregate truth, not create a long-running second verification runner.

---

## Debt Taxonomy

| Option | Description | Selected |
|--------|-------------|----------|
| Normalize to blocker, accepted_debt, deferred_scope, passed, pending | Keep release confidence and milestone gate taxonomy aligned. | yes |
| Show raw statuses only | Forward every source status without grouping. | |
| Treat all non-passed statuses as blocker | Simpler but loses accepted-debt and future-scope meaning. | |

**Auto selection:** Normalize to blocker, accepted_debt, deferred_scope, passed, pending.
**Notes:** This directly addresses the Phase 47 success criteria that blocker, accepted debt, and deferred future scope stay distinct.

---

## Operator Report Content

| Option | Description | Selected |
|--------|-------------|----------|
| Executive summary plus evidence tables | Top-line status, counts, latest paths, release-host attempts, artifact issues, requirement evidence, and next commands. | yes |
| Full raw evidence dump | Embed all logs and artifact text in one report. | |
| Minimal pass/fail badge | Only show overall status. | |

**Auto selection:** Executive summary plus evidence tables.
**Notes:** Operators need the shortest route from current state to next action, while retaining paths to raw evidence.

---

## Implementation Pattern

| Option | Description | Selected |
|--------|-------------|----------|
| Repo-local Node `.mjs` script with fixture tests | Match existing release-host and milestone-gate tooling. | yes |
| App route first | Add backend/UI route before a generated evidence command. | |
| Shell script wrapper | Compose existing commands with ad hoc text processing. | |

**Auto selection:** Repo-local Node `.mjs` script with fixture tests.
**Notes:** Existing script patterns already provide deterministic JSON/Markdown report generation and testable pure helpers.

---

## Verification

| Option | Description | Selected |
|--------|-------------|----------|
| Focused script tests plus typecheck/gate/report sample run | Verify taxonomy and output shape without running full suite inside tests. | yes |
| Full `pnpm test:e2e` as default gate | Browser suite is separate and outside default release confidence gate. | |
| Manual inspection only | Avoid adding tests for the reporting script. | |

**Auto selection:** Focused script tests plus typecheck/gate/report sample run.
**Notes:** This keeps Phase 47 release-host friendly and checks the behavior that matters.

---

## the agent's Discretion

- Exact command name and evidence directory.
- Exact JSON field names, provided they remain stable and future UI-friendly.
- Owner inference details for artifact-gate issue codes.
- Whether a small shared helper is extracted from existing scripts.

## Deferred Ideas

- Rich React operations dashboard after report data contract is proven.
- Browser E2E/release-smoke integration into default runtime confidence report.
- Changing embedded Postgres default Windows test policy.
