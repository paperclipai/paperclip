# Phase 44: Release Host Verification Harness - Context

**Gathered:** 2026-04-29
**Status:** Ready for planning
**Mode:** auto

<domain>
## Phase Boundary

Phase 44 turns full-suite release verification into a documented, rerunnable release-host gate. It must run `pnpm typecheck` and `pnpm test` through a stable command path, preserve timeout/failure evidence, classify failed slices by suite, duration, owner, and retry recommendation, and allow operators to rerun only failed slices without losing the full audit trail.

This phase is verification infrastructure and evidence capture only. It should not fix embedded Postgres skip behavior directly, rewrite route persistence tests, change artifact/UAT truth alignment, or build the runtime confidence operations surface; those are Phase 45, 46, and 47 respectively.

</domain>

<decisions>
## Implementation Decisions

### Release-host command surface
- **D-01:** Add a repo-owned release-host verification command path, exposed through `package.json`, that runs `pnpm typecheck` and the existing `pnpm test` path under a wrapper rather than asking operators to manually chain commands.
- **D-02:** Keep the wrapper deterministic and local. It must not require network, live providers, Playwright browser suites, or external Postgres. `pnpm test:e2e` remains outside the default release-host gate.
- **D-03:** The command should write a durable run directory under a generated local evidence path, with a machine-readable JSON summary and a human-readable Markdown report.

### Timeout and failure evidence
- **D-04:** Every suite step records command, started/ended timestamps, duration, exit code, timeout status, and truncated stdout/stderr or log file references. A timeout is a classified result, not a silent command failure.
- **D-05:** Classification must include `suite`, `phase`, `duration`, `owner`, and `retryRecommendation`. Owner classification can start with deterministic mapping such as workspace package, `server` route/authz slice, `ui`, `db`, `shared`, `planning/tooling`, or `unknown` when the wrapper cannot infer better.
- **D-06:** Timeout defaults should be configurable by env/CLI flags, with conservative defaults suitable for Windows release-host runs. The report should show the configured timeout so operators can distinguish host slowness from product failure.

### Failed-slice rerun
- **D-07:** Rerun support should consume the prior JSON summary and execute only failed or timed-out slices while appending a new attempt to the same audit trail.
- **D-08:** Rerunning a slice must not overwrite the original full-suite evidence. The report should show attempt number, prior result, rerun result, and whether the full release-host gate is now passable.
- **D-09:** Slice identity should align with the existing `scripts/run-vitest-stable.mjs` structure where possible: typecheck, non-server project suites, server excluding serialized route suites, and individual serialized route/authz tests.

### Integration with existing test runner
- **D-10:** Reuse `scripts/run-vitest-stable.mjs` concepts instead of replacing the entire Vitest strategy. If direct reuse is hard because it exits on first failure, extract or mirror its suite enumeration carefully and keep behavior equivalent.
- **D-11:** Do not broaden Phase 44 into embedded Postgres host readiness. If embedded Postgres suites skip, this phase records the skip/failure evidence and owner, while Phase 45 changes the Postgres execution path.
- **D-12:** Add focused tests for the release-host wrapper's classification, timeout handling, JSON/report shape, and rerun selection using fixture commands or dry-run mode rather than running the full workspace test suite inside unit tests.

### Verification
- **D-13:** Phase verification should include the new focused release-host harness tests, `pnpm typecheck`, and a targeted release verification path. Full `pnpm test` should be attempted when feasible; if the host times out, the new harness must leave explicit blocker or tech-debt evidence.
- **D-14:** Update documentation or generated report instructions so an operator knows the normal run command, the rerun command, where evidence is written, and how to interpret timeout/owner/retry fields.

### the agent's Discretion
- Exact file names for the release-host wrapper and evidence directory, provided they are repo-owned, deterministic, and easy to invoke from `package.json`.
- Exact JSON schema names, provided downstream scripts can parse suite attempts, owner classification, timeout status, and rerun linkage.
- Whether the wrapper is implemented as one script or a small library plus CLI script.

</decisions>

<specifics>
## Specific Ideas

- Treat Phase 44 as the direct closure of the Phase 43 residual risk: `pnpm typecheck` passed, `pnpm test` timed out after 10 minutes, and the operator needs a release-host gate that explains the timeout instead of losing the signal.
- Use the Phase 43 milestone artifact gate pattern as the shape precedent: a deterministic repo-local Node script, package script aliases, fixture tests, text output, and JSON output.
- The operator question this phase should answer is: "When full release verification fails or times out, what failed, who owns it, and what exact slice should I rerun?"

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Scope And Requirements
- `.planning/PROJECT.md` - v2.7 release-host confidence goal, RT2-first identity, deterministic local verification constraint, and Windows timeout context.
- `.planning/REQUIREMENTS.md` - `REL-01`, `REL-02`, and `REL-03` requirements and Phase 44 traceability.
- `.planning/ROADMAP.md` - Phase 44 goal and success criteria.
- `.planning/STATE.md` - v2.7 start state and deferred full-suite timeout / embedded Postgres caveats.

### Prior Evidence And Patterns
- `.planning/phases/43-validation-debt-and-milestone-gate-closure/43-CONTEXT.md` - Prior decisions about deterministic planning gates, explicit reason codes, and full-suite timeout residual risk.
- `.planning/phases/43-validation-debt-and-milestone-gate-closure/43-01-SUMMARY.md` - Evidence that `pnpm typecheck` passed and `pnpm test` timed out after 10 minutes.
- `.planning/phases/43-validation-debt-and-milestone-gate-closure/43-VALIDATION.md` - Validation caveat describing full-suite timeout on this Windows host.
- `.planning/phases/43-validation-debt-and-milestone-gate-closure/43-MILESTONE-GATE.md` - Human-facing gate report pattern from the previous phase.

### Existing Code Evidence
- `package.json` - Existing scripts for `pnpm typecheck`, `pnpm test`, `pnpm test:run`, `pnpm test:e2e`, `rt2:milestone-gate`, and `test:milestone-gate`.
- `scripts/run-vitest-stable.mjs` - Current stable Vitest runner that enumerates non-server projects, server suites, and serialized route/authz tests.
- `scripts/rt2-milestone-artifact-gate.mjs` - Deterministic repo-local script pattern with text/JSON output and explicit issue codes.
- `scripts/rt2-milestone-artifact-gate.test.mjs` - Fixture-based script test pattern that avoids running the full product suite.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `scripts/run-vitest-stable.mjs` already knows how the default `pnpm test` suite is split: package projects, server excluding serialized tests, then serialized route/authz tests one by one.
- `scripts/rt2-milestone-artifact-gate.mjs` already demonstrates a small Node CLI with `--json`, text output, deterministic issue codes, and exported pure functions for fixture tests.
- `package.json` already has release and milestone scripts; adding `rt2:release-host-verify` and a focused harness test script fits the existing convention.

### Established Patterns
- Verification scripts are Node `.mjs` files under `scripts/` and are exposed through `package.json`.
- Tests for scripts can use `node:assert/strict`, temporary fixture directories, and direct exported function calls.
- Full browser E2E is explicitly separate from default `pnpm test`.
- Windows host timeout caveats are recorded as explicit residual risk instead of hidden.

### Integration Points
- Add the release-host wrapper under `scripts/`.
- Add package scripts for normal run, rerun, and focused script tests.
- Keep `scripts/run-vitest-stable.mjs` behavior as the default Vitest strategy or use its suite split as the source of release-host slice identity.
- Write Phase 44 verification artifacts after the harness produces evidence.

</code_context>

<deferred>
## Deferred Ideas

- Embedded Postgres Windows host-ready persistence coverage belongs to Phase 45.
- Validation metadata, legacy UAT status, and requirement traceability truth alignment belong to Phase 46.
- Operator-facing runtime confidence surface/report aggregation belongs to Phase 47.
- Playwright E2E and release-smoke browser suites remain separate verification paths, not part of Phase 44 default full-suite gate.

</deferred>

---

*Phase: 44-release-host-verification-harness*
*Context gathered: 2026-04-29*
