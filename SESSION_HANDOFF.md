# SESSION_HANDOFF

## Current State
- date: 2026-04-03
- summary: added a repo-local Codex control surface, first-read and prompt/agentic operating guide, fail-fast Paperclip guardrail scripts, a repo-managed pre-commit entrypoint, and CI wiring so company/approval/activity and contract-sync checks fail earlier without changing runtime product contracts. Follow-up test-debt passes also hardened worktree port selection against sandbox-restricted socket probes, extracted an explicit loopback-listen helper for openclaw gateway socket tests, and introduced an in-memory Express request helper for route tests so the former `null port`/`supertest` cluster no longer depends on opening a socket. Post-edit proof shows `pnpm run check:paperclip:fast`, expanded targeted route verification, `pnpm -r typecheck`, and `pnpm build` are green, and full-suite failures are now concentrated in loopback-bind-dependent runtime suites.
- implementation boundary: additive hardening only. No REST API, DB schema, shared type/validator, or UI contract changes.
- current baseline stance: `typecheck` and `build` are green; `test:run` is already red in baseline and remains tracked debt rather than a regression introduced by this pass.

## Current Task Lane Evidence
- task scope: repo-local Codex hardening for harness, context, prompt, and agentic workflows
- eligibility result: non-trivial, non-destructive, safe for `main + reader/checker`
- planned lane: main integration + harness/context reader lane + baseline checker lane
- actual spawn availability: one reader lane completed with file-backed findings, one additional reader lane was runtime-limited and closed without edits, and baseline verification ran separately from the main edit lane
- checker lane: baseline proof plus post-edit guardrail verification
- single-lane reason: none
- fallback reason: no disjoint write lane was needed because the final implementation touched shared repo-operational files

## Baseline Proof
- `git status --short`
  - clean before this hardening pass
- `pnpm run check:paperclip:fast`
  - passed on the current working tree
- `bash scripts/install-git-hooks.sh`
  - configured `core.hooksPath=.githooks`
- `.githooks/pre-commit`
  - passed and runs `pnpm run check:paperclip:fast`
- workflow YAML syntax
  - `ruby -e 'require "yaml"; YAML.load_file(".github/workflows/pr.yml"); YAML.load_file(".github/workflows/release.yml")'`
  - passed
- synthetic contract-sync proof
  - `node scripts/check-paperclip-change-scope.mjs packages/db/src/schema/agents.ts`
    - failed as intended, requiring schema index and migrations
  - `node scripts/check-paperclip-change-scope.mjs packages/shared/src/constants.ts`
    - failed as intended, requiring matching `server/src/**` or `ui/src/**`
- synthetic route-guardrail proof
  - `node scripts/check-paperclip-route-guardrails.mjs --root <tmpdir> --only agents.ts`
  - failed as intended on missing `assertCompanyAccess` and `logActivity`
- `pnpm -r typecheck`
  - passed before and after this hardening pass
- `pnpm build`
  - passed before and after this hardening pass
- `pnpm test:run`
  - baseline failed before this hardening and still fails after the repo-operational changes
  - recurring failure classes observed:
    - some route tests still fail with `Cannot read properties of null (reading 'port')`, but the converted in-memory-request slice no longer depends on `supertest` socket bind
    - some socket-backed tests still depend on loopback bind availability
    - some runtime/service tests also fail with environment-level listen errors such as `listen EPERM: operation not permitted 127.0.0.1`
- focused follow-up proof
  - `pnpm exec vitest run cli/src/__tests__/worktree.test.ts --reporter=verbose`
    - passed after making worktree port selection stop overflowing to `65536` and fall back deterministically during config-only init when probe sockets are sandbox-blocked
  - `pnpm exec vitest run server/src/__tests__/openclaw-gateway-adapter.test.ts --reporter=verbose`
    - still fails in this sandbox with `listen EPERM: operation not permitted 127.0.0.1` and downstream timeouts; helper setup is now explicit, but the runtime still forbids loopback bind
  - `pnpm exec vitest run server/src/__tests__/private-hostname-guard.test.ts server/src/__tests__/companies-route-path-guard.test.ts server/src/__tests__/costs-service.test.ts server/src/__tests__/issue-comment-reopen-routes.test.ts server/src/__tests__/company-portability-routes.test.ts server/src/__tests__/cli-auth-routes.test.ts server/src/__tests__/routines-routes.test.ts server/src/__tests__/board-mutation-guard.test.ts server/src/__tests__/instance-settings-routes.test.ts --reporter=verbose`
    - passed after switching those files to the in-memory Express request helper
  - expanded focused proof
    - `pnpm exec vitest run server/src/__tests__/activity-routes.test.ts server/src/__tests__/agent-instructions-routes.test.ts server/src/__tests__/agent-permissions-routes.test.ts server/src/__tests__/agent-skills-routes.test.ts server/src/__tests__/approval-routes-idempotency.test.ts server/src/__tests__/company-branding-route.test.ts server/src/__tests__/company-skills-routes.test.ts server/src/__tests__/health.test.ts server/src/__tests__/issues-goal-context-routes.test.ts server/src/__tests__/openclaw-invite-prompt-route.test.ts packages/db/src/runtime-config.test.ts cli/src/__tests__/doctor.test.ts --reporter=verbose`
    - passed; `12 files / 40 tests` green
  - full-suite status after the latest pass
    - `pnpm test:run` still fails, but the suite moved from `101 failed / 88 errors` to `7 failed / 0 errors`
    - latest summary: `7 failed | 643 passed | 19 skipped`
    - remaining failures are now entirely loopback-bind-dependent and reproduce as `listen EPERM: operation not permitted 127.0.0.1`
    - remaining failing suites/files:
      - `packages/db/src/client.test.ts`
      - `server/src/__tests__/workspace-runtime.test.ts` (`ensureRuntimeServicesForRun` cases only)
      - `server/src/__tests__/heartbeat-process-recovery.test.ts`
      - `server/src/__tests__/issues-service.test.ts`
      - `server/src/__tests__/routines-e2e.test.ts`
      - `server/src/__tests__/routines-service.test.ts`
      - `cli/src/__tests__/company-import-export-e2e.test.ts`
- runtime limitation note:
  - full-check truth currently requires distinguishing `new hardening regressions` from `pre-existing test debt`; this handoff treats the failing test set as an already-red baseline unless a newly added file/script is named in the failure.

## Failing Test Cluster Notes
- `null port`
  - representative files: `server/src/__tests__/private-hostname-guard.test.ts`, `server/src/__tests__/costs-service.test.ts`, `server/src/__tests__/company-portability-routes.test.ts`, `server/src/__tests__/cli-auth-routes.test.ts`
  - reproduction: `pnpm exec vitest run server/src/__tests__/private-hostname-guard.test.ts --reporter=verbose`
  - immediate cause: route tests call `request(app)` on an Express app that is not already listening; `supertest@7.2.2` then falls back to `app.listen(0)` inside `lib/test.js` before reading `app.address().port`
  - root cause in this runtime: the sandbox denies that implicit bind with `listen EPERM: operation not permitted 0.0.0.0`, so `app.address()` stays null and the visible assertion failure becomes `Cannot read properties of null (reading 'port')`
- `timeout`
  - representative file: `server/src/__tests__/openclaw-gateway-adapter.test.ts`
  - reproduction: `pnpm exec vitest run server/src/__tests__/openclaw-gateway-adapter.test.ts --reporter=verbose`
  - immediate cause: the mock gateway server waits on `server.listen(0, "127.0.0.1")`, so the adapter execution path never receives a reachable websocket endpoint
  - root cause in this runtime: the bind attempt fails with `listen EPERM: operation not permitted 127.0.0.1`; the test then waits until Vitest's default `5000ms` timeout, so the timeout is a downstream symptom of the same socket restriction rather than a proven adapter logic regression
- `65536`
  - representative file: `cli/src/__tests__/worktree.test.ts`
  - reproduction: `pnpm exec vitest run cli/src/__tests__/worktree.test.ts --reporter=verbose`
  - immediate cause: `cli/src/commands/worktree.ts` probes ports with `isPortAvailable()` and increments until it finds a bindable port, but it has no upper bound or early-stop branch for permission-denied socket errors
  - root cause in this runtime: because every probe bind on `127.0.0.1` is treated as unavailable, `findAvailablePort()` keeps incrementing until `server.listen(65536, ...)` throws `ERR_SOCKET_BAD_PORT`; this is a real robustness gap in the port-search helper, even though the trigger is environment-specific
- `EPERM`
  - representative files: `server/src/__tests__/private-hostname-guard.test.ts`, `server/src/__tests__/openclaw-gateway-adapter.test.ts`, `cli/src/commands/worktree.ts`
  - evidence split:
    - implicit bind path: `supertest` uses `app.listen(0)` and gets `EPERM` on `0.0.0.0`
    - explicit bind path: test helpers that call `server.listen(0, "127.0.0.1")` also get `EPERM`
  - working conclusion: the dominant failing-test cluster is not a single feature regression but a runtime restriction against opening local listening sockets in the current execution environment; `null port` and many `timeout` failures are secondary manifestations of that restriction, while `65536` is the project-local helper bug exposed by it

## First-Read Bundle
Read in this order before non-trivial work:

1. `AGENTS.md`
2. `README.md`
3. `SESSION_HANDOFF.md`
4. `doc/GOAL.md`
5. `doc/PRODUCT.md`
6. `doc/SPEC-implementation.md`
7. `doc/DEVELOPING.md`
8. `doc/DATABASE.md`
9. `doc/CODEX_OPERATING_GUIDE.md`

## Active Constraints
- Keep all changes company-scoped.
- Keep `packages/db`, `packages/shared`, `server`, and `ui` contracts synchronized when contracts move.
- Preserve the control-plane invariants:
  - single-assignee task model
  - atomic issue checkout semantics
  - approval gates for governed actions
  - budget hard-stop auto-pause behavior
  - activity logging for mutating actions
- Prefer additive docs updates over wholesale rewrites.
- Keep new plan docs under `doc/plans/` using `YYYY-MM-DD-slug.md`.
- Do not widen the default Codex connector surface in this repo without a concrete need.

## Next Actions
1. Use `pnpm run check:paperclip:fast` before `typecheck/test/build` when touching contracts, route guardrails, or repo-operational files.
2. If `packages/db/src/schema/**` changes, confirm `packages/db/src/schema/index.ts` and generated migrations changed in the same slice before moving on.
3. If `packages/shared/src/**` changes, confirm at least one matching `server/src/**` or `ui/src/**` update in the same slice.
4. If a mutating route changes, explicitly verify company boundary, approval boundary, and activity logging coverage.
5. Treat the remaining red `pnpm test:run` baseline as a loopback-runtime lane, not a `supertest/null-port` lane. The next pass should target actual socket-dependent suites only:
   - embedded-postgres boot tests in `packages/db/src/client.test.ts`
   - runtime service bind tests in `server/src/__tests__/workspace-runtime.test.ts`
   - loopback-backed service/e2e tests in `server/src/__tests__/heartbeat-process-recovery.test.ts`, `server/src/__tests__/issues-service.test.ts`, `server/src/__tests__/routines-e2e.test.ts`, `server/src/__tests__/routines-service.test.ts`, and `cli/src/__tests__/company-import-export-e2e.test.ts`
6. `server/src/__tests__/routines-e2e.test.ts` is the only remaining route test still importing `supertest`, but it also depends on real loopback listeners, so it should be handled with the runtime-limited group rather than the in-memory helper group.
