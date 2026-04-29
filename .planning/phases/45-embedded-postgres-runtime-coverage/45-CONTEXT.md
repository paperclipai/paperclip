# Phase 45: Embedded Postgres Runtime Coverage - Context

**Gathered:** 2026-04-29
**Status:** Ready for planning
**Mode:** auto

<domain>
## Phase Boundary

Phase 45 makes embedded Postgres persistence and route coverage visible on Windows release hosts. It must preserve the current local-dev default of skipping embedded Postgres tests on Windows unless explicitly enabled, but the skip can no longer disappear as an unclassified Vitest skip. The phase delivers host capability evidence, an opt-in Windows host-ready focused execution path, explicit route-level persistence coverage, and release-host confidence output that classifies default skips as accepted debt.

This phase should not broaden into artifact/UAT truth alignment, confidence dashboard UI, full Playwright/browser release smoke, or a rewrite of the embedded Postgres runtime itself. Phase 44 owns the release-host wrapper and failed-slice audit trail; Phase 45 extends that evidence model for embedded Postgres host readiness.

</domain>

<decisions>
## Implementation Decisions

### Embedded Postgres skip evidence
- **D-01:** Preserve Windows default skip unless `PAPERCLIP_ENABLE_EMBEDDED_POSTGRES_TESTS=true` is set. The default protects ordinary Windows dev/test runs from long or flaky embedded Postgres startup.
- **D-02:** Replace console-only skip messages with structured evidence that records host platform, controlling env vars, probe result, fallback reason, and the affected embedded Postgres suites.
- **D-03:** Treat explicit opt-out (`PAPERCLIP_SKIP_EMBEDDED_POSTGRES_TESTS=true`), Windows default disabled, missing dependency/startup failure, and successful support probe as distinct reason codes.
- **D-04:** The evidence should be machine-readable enough for release-host verification to classify it, and human-readable enough for an operator to understand whether the skip is accepted debt or a blocker.

### Windows host-ready focused path
- **D-05:** Add a repo-owned focused command path for embedded Postgres runtime coverage rather than relying on operators to remember a long env-var-plus-Vitest invocation.
- **D-06:** The focused path should set `PAPERCLIP_ENABLE_EMBEDDED_POSTGRES_TESTS=true`, isolate `PAPERCLIP_HOME`/temporary data paths, and run only the embedded Postgres DB and route persistence suites needed for this phase.
- **D-07:** The focused path should be invokable both directly from `package.json` and as a slice or subcommand that the Phase 44 release-host harness can include or report against.
- **D-08:** If Windows host-ready execution still fails on the current host, the result must be a blocker with startup logs and reason code, not a silent skip.

### Route-level persistence coverage
- **D-09:** Route-level coverage must include at least one RT2 route flow backed by a real embedded Postgres database, not only package-level migration/client tests.
- **D-10:** Prefer existing RT2 route persistence suites as the first coverage target: `server/src/__tests__/rt2-task-routes.test.ts` and `server/src/__tests__/rt2-daily-report-routes.test.ts` already use `startEmbeddedPostgresTestDatabase`.
- **D-11:** The route coverage should verify persistence across service/app instances or a realistic read-after-write flow that proves the route depends on embedded Postgres state, not just in-memory test doubles.
- **D-12:** Keep the focused suite narrow. Do not try to run every embedded Postgres test in the repo as the Phase 45 gate; broader DB/server coverage remains available through the normal Vitest project slices.

### Release confidence classification
- **D-13:** Extend `scripts/rt2-release-host-verify.mjs` or a companion helper so embedded Postgres default skips appear in release-host output as `accepted_debt` with `owner=db` or `owner=server-route`, not as a passed suite.
- **D-14:** When the focused host-ready command is run and passes, release confidence should show embedded Postgres runtime coverage as satisfied for that run.
- **D-15:** When the focused command is not run, the report should preserve the accepted debt classification and give the exact command required to close it on a Windows release host.
- **D-16:** Failed embedded Postgres startup under the focused path should be classified separately from default skip: focused failure is a blocker, default skip is accepted debt.

### Verification
- **D-17:** Add focused tests for skip-evidence parsing/classification using fixtures or exported pure functions. These tests must not start embedded Postgres.
- **D-18:** Add or update one real embedded Postgres focused suite path and document the host-ready command. Actual embedded Postgres execution may be opt-in during verification if this host cannot run it reliably.
- **D-19:** Phase verification should include `pnpm typecheck`, focused classification tests, and either the host-ready focused embedded Postgres command or explicit blocker/accepted-debt evidence from the release-host report.

### the agent's Discretion
- Exact reason-code names, JSON field names, and report table wording, provided the distinction between default skip, explicit opt-out, support probe failure, focused pass, and focused failure is unambiguous.
- Whether embedded Postgres evidence is produced by the test helper, a separate probe script, the release-host wrapper, or a small shared utility.
- Exact focused suite list beyond the required RT2 route persistence target, provided the gate remains narrow and release-host friendly.

</decisions>

<specifics>
## Specific Ideas

- Phase 45 directly closes the Phase 44 deferred item: "Embedded Postgres Windows host-ready persistence coverage belongs to Phase 45."
- The operator question this phase should answer is: "Did embedded Postgres persistence actually run on this Windows host, or did we intentionally accept the skip for this release run?"
- The existing helper already contains the critical policy boundary: Windows skips unless `PAPERCLIP_ENABLE_EMBEDDED_POSTGRES_TESTS=true`, while `PAPERCLIP_SKIP_EMBEDDED_POSTGRES_TESTS=true` is an explicit opt-out.
- Release confidence should not imply runtime persistence passed when the embedded Postgres suites were skipped by host policy.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Scope And Requirements
- `.planning/PROJECT.md` - v2.7 goal, RT2-first identity, deterministic local verification constraint, and Phase 45 focus.
- `.planning/REQUIREMENTS.md` - `PG-01`, `PG-02`, and `PG-03` Phase 45 traceability.
- `.planning/ROADMAP.md` - Phase 45 goal and success criteria.
- `.planning/STATE.md` - Current v2.7 state and Phase 44 handoff.
- `.planning/phases/44-release-host-verification-harness/44-CONTEXT.md` - Prior decisions for release-host wrapper, failed-slice rerun, owner/retry classification, and explicit deferral of embedded Postgres readiness.

### Existing Embedded Postgres Runtime
- `packages/db/src/test-embedded-postgres.ts` - Support probe, Windows default skip policy, env controls, test database startup, migration application, and cleanup behavior.
- `server/src/__tests__/helpers/embedded-postgres.ts` - Server test re-export of the DB embedded Postgres helper.
- `server/src/index.ts` - Application startup behavior for external vs embedded Postgres, startup logging, migration application, and embedded data directory/port handling.
- `packages/db/src/migration-runtime.ts` - Embedded Postgres migration runtime path used by DB tooling.

### Existing Embedded Postgres Test Coverage
- `packages/db/src/client.test.ts` - Embedded Postgres migration/client coverage.
- `packages/db/src/rt2-task-persistence.test.ts` - RT2 task persistence migration coverage.
- `packages/db/src/rt2-daily-report-persistence.test.ts` - RT2 daily report persistence migration coverage.
- `server/src/__tests__/rt2-task-routes.test.ts` - RT2 task route tests using embedded Postgres.
- `server/src/__tests__/rt2-daily-report-routes.test.ts` - RT2 daily report route tests using embedded Postgres.

### Release Host Harness
- `package.json` - Existing scripts including `rt2:release-host-verify`, `rt2:release-host-rerun`, `test:release-host-verify`, `pnpm typecheck`, and `pnpm test`.
- `scripts/rt2-release-host-verify.mjs` - Release-host slice enumeration, owner classification, timeout/failure evidence, JSON summary, and Markdown report.
- `scripts/rt2-release-host-verify.test.mjs` - Fixture-style release-host harness tests.
- `scripts/run-vitest-stable.mjs` - Stable Vitest project and serialized route slice strategy used by default `pnpm test`.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `getEmbeddedPostgresTestSupport()` already centralizes support probing and skip policy. It can be extended or wrapped to produce structured evidence without changing every suite by hand.
- `startEmbeddedPostgresTestDatabase()` already creates an isolated embedded Postgres instance, applies migrations, and returns a connection string plus cleanup hook.
- `scripts/rt2-release-host-verify.mjs` already writes `summary.json`, `report.md`, per-slice logs, owner classification, timeout status, and retry recommendations.
- Existing RT2 route tests already create apps backed by embedded Postgres databases, especially `rt2-task-routes.test.ts` and `rt2-daily-report-routes.test.ts`.

### Established Patterns
- Windows embedded Postgres tests are disabled by default and enabled by `PAPERCLIP_ENABLE_EMBEDDED_POSTGRES_TESTS=true`.
- Explicit host caveats are recorded as release evidence rather than hidden.
- Repo-local Node `.mjs` scripts exposed through `package.json` are the accepted shape for release and milestone gates.
- Script tests should use pure functions/fixtures and avoid running the full workspace suite.
- Default `pnpm test` uses `scripts/run-vitest-stable.mjs` and keeps route/authz suites serialized.

### Integration Points
- Add embedded Postgres host evidence production near `packages/db/src/test-embedded-postgres.ts` or as a shared utility consumed by it.
- Add a focused package script for embedded Postgres host-ready coverage.
- Extend `scripts/rt2-release-host-verify.mjs` classification/reporting so skipped embedded Postgres coverage becomes accepted debt unless the focused path has run and passed.
- Document the Windows host-ready command in release-host docs or Phase 45 verification artifacts.

</code_context>

<deferred>
## Deferred Ideas

- Artifact and UAT truth alignment belongs to Phase 46.
- Operator-facing runtime confidence UI/report aggregation belongs to Phase 47.
- Making embedded Postgres mandatory in every default Windows `pnpm test` run is out of scope unless the host-ready focused path proves stable enough for a later policy change.
- External PostgreSQL CI matrix coverage is future infrastructure scope; this phase focuses on embedded Postgres Windows host evidence.

</deferred>

---

*Phase: 45-embedded-postgres-runtime-coverage*
*Context gathered: 2026-04-29*
