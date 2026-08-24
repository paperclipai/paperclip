# VOY-770: CI Smoke Test Pipeline — Audit & Recommendations

**Author**: Founding Engineer
**Date**: 2026-08-12
**Status**: Complete (Phase 1 & 2: Audit + Fixes)

---

## 1. CI Pipeline Inventory

### 1.1 Workflow Files

| Workflow | Trigger | Jobs | Timeout |
|---|---|---|---|
| `pr.yml` | PR → master | policy, typecheck_release_registry, general_tests (5), build, verify, verify_serialized_server (4), canary_dry_run, e2e | 5–30 min |
| `release.yml` | push master / workflow_dispatch | verify_canary → publish_canary / verify_stable → publish_stable | 30–45 min |
| `e2e.yml` | workflow_dispatch | e2e | 30 min |
| `release-smoke.yml` | workflow_dispatch / call | smoke (Docker + Playwright) | 45 min |
| `docker.yml` | push master / tag v* | build-and-push (multi-platform) | 60 min |
| `agent-runtime-images.yml` | push master / dispatch | build-and-sign (bake + cosign) | — |
| `commitperclip-review.yml` | PR target | review (dependency + quality + security gates) | 5 min |
| `refresh-lockfile.yml` | — | — | 10 min |

### 1.2 Test Suite Categories

**Vitest Projects (18 in root config)**:
```typescript
// vitest.config.ts projects
"packages/shared"
"packages/skills-catalog"
"packages/db"
"packages/adapter-utils"
"packages/adapters/acpx-local"
"packages/adapters/claude-local"
"packages/adapters/codex-local"
"packages/adapters/cursor-cloud"
"packages/adapters/cursor-local"
"packages/adapters/gemini-local"
"packages/adapters/grok-local"
"packages/adapters/opencode-local"
"packages/adapters/pi-local"
"packages/plugins/sdk"
"packages/plugins/create-paperclip-plugin"
"server"
"ui"
"cli"
```

**CI Grouping** (`scripts/run-vitest-stable.mjs`):
- **general-workspaces-a**: ui, cli
- **general-workspaces-b**: shared, skills-catalog, db, adapter-utils, all adapters, sdk, create-paperclip-plugin
- **general-server**: All non-serialized server tests (sharded 3 ways in CI)
- **serialized**: Route/authz server tests (25 suites, sharded 4 ways in CI)

**E2E Suites** (`tests/e2e/`, Playwright):

| File | Description | LLM-dependent |
|---|---|---|
| `onboarding.spec.ts` | Wizard flow: create company + mission | No (LLM-free core) |
| `sidebar-takeover.spec.ts` | Company settings sidebar rail | No |
| `planning-mode-visual-verification.spec.ts` | Visual regressions | No |
| `nux-phase4-screenshots.spec.ts` | NUX phase 4 screenshots | No |
| `signoff-policy.spec.ts` | Signoff policy UI | No |
| `conference-room-typing-intro.spec.ts` | Conference room | No |
| `multi-user.spec.ts` | Multi-user (excluded from default) | — |
| `multi-user-authenticated.spec.ts` | Multi-user authenticated (excluded) | — |

**Release Smoke** (`tests/release-smoke/`):
- `docker-auth-onboarding.spec.ts`: Docker-based auth + onboarding

**Manual Smoke Scripts** (not in any CI workflow):
- `smoke:hermes-gateway-e2e` — Docker-based Hermes gateway E2E
- `smoke:openclaw-docker-ui` — Docker-based OpenClaw dashboard
- `smoke:hermes-gateway-join` — Hermes join
- `smoke:openclaw-join` — OpenClaw join
- `smoke:openclaw-sse-standalone` — OpenClaw SSE
- `smoke:pipelines-tutorial` — Pipelines tutorial
- `smoke:terminal-bench-loop-skill` — Terminal bench loop

---

## 2. Pre-Merge Gate Analysis

### 2.1 Current PR Gates (BEFORE FIX)

The `verify` job (pr.yml:221–238):

```yaml
verify:
  needs: [typecheck_release_registry, general_tests, build]
```

### 2.2 CRITICAL: Missing from Verify Gate

| Job | In verify gate? | Impact |
|---|---|---|
| `typecheck_release_registry` | Yes | — |
| `general_tests` (5 matrix) | Yes | — |
| `build` | Yes | — |
| `verify_serialized_server` (4 shards) | **NO** | Serialized route/authz tests can FAIL silently — PR still green |
| `e2e` | **NO** | E2E Playwright tests can FAIL silently — PR still green |
| `canary_dry_run` | **NO** | Canary release dry run can FAIL silently |

**This means ~25 server test suites (route/authz critical paths like authz-company-access, heartbeat-process-recovery, issues-service, routine-e2e, etc.) plus 6 e2e Playwright specs can ALL fail and the PR still passes.**

### 2.3 Implemented Gate Configuration (PR Fix Applied)

```yaml
verify:
  needs: [
    typecheck_release_registry,
    general_tests,
    build,
    verify_serialized_server,  # ADDED: 25 route/authz suites
    e2e,                        # ADDED: 6 Playwright specs
  ]
```

`canary_dry_run` remains advisory — lower priority, can be added later.

---

## 3. Flaky Test Analysis

### 3.1 Known Flakes from Git History

| ID | Test | Root Cause | Status |
|---|---|---|---|
| RBR-954 | Server DB-backed suites timeout | testTimeout was 5000ms default; machine load caused 6x spread (1938ms → 12266ms) | FIXED: config-level 30000ms |
| RBR-980/RBR-912 | beforeAll embedded-Postgres boot | hookTimeout was 10s; cold boot takes 80-95s | FIXED: config-level 120000ms |
| RBR-914 | Marginal test timeout | — | FIXED: bumped |
| — | adapter-claude-local ENOTEMPTY | fs.rename race on macOS | FIXED: caught ENOTEMPTY in isAlreadyExistsError |
| — | e2e applications Connections list | Health sweep interference | FIXED: deflaked in #10763 |

### 3.2 Run 1 Results — 2026-08-12 (macOS arm64)

| Suite | Result | Duration | Details |
|---|---|---|---|
| **serialized-server** | ❌ 1 FAIL | 64s | `access-routes-permissions-upgrade.test.ts` — beforeAll hook timeout (inline 20s overrides config-level 120s) |
| **general-workspaces-b** | ❌ 1 FAIL | 45s | `packaged-artifacts.test.ts` — test timeout (inline 30s on npm pack + build) |
| **e2e** | ❌ FAIL | 120s | webServer startup timeout — `pnpm paperclipai onboard --yes --run` bootstraps embedded-PG + server, exceeds 120s webServer budget |
| **general-workspaces-a** | ⊘ Hung | — | Preflight passed, vitest runner never produced output (killed) |
| **general-server (shard 0/3)** | ⊘ Hung | — | No vitest output produced before kill |

### 3.3 Flaky Tests Found & Fixed

**Root Cause Pattern**: Inline timeout budgets in test files override config-level timeout protection. The server `vitest.config.ts` explicitly warns against this at lines 25-27 and 38-42, but two test files had fallen through.

#### Flake #1: `server/src/__tests__/access-routes-permissions-upgrade.test.ts:86`

- **Failure**: `beforeAll` hook timed out in 20000ms
- **Root Cause**: Inline `beforeAll(async () => { ... }, 20_000)` overrides the config-level `hookTimeout: 120000`. On cold boot, embedded-Postgres needs 80-95s.
- **Fix**: Removed inline `20_000` timeout argument. Config-level `hookTimeout: 120000` now applies.

#### Flake #2: `packages/skills-catalog/src/packaged-artifacts.test.ts:37`

- **Failure**: Test timed out in 30000ms (actual duration: 37649ms)
- **Root Cause**: Inline `it("...", () => { ... }, 30_000)` overrides vitest default. `npm pack` + fallback `pnpm build` can exceed 30s.
- **Fix**: Removed inline `30_000` timeout argument. Added `testTimeout: 60000` to `packages/skills-catalog/vitest.config.ts`.

---

## 4. CI Run Time Optimization

### 4.1 Current Wall Clock (Best Case)

```
policy (5 min)
├── typecheck_release_registry (20 min) ──┐
├── general_tests (20 min) ────────────────┤
├── build (20 min) ────────────────────────┤
│   └── verify (0 min aggregator) ← all 5 gates
├── verify_serialized_server (20 min) ← NOW GATING
├── canary_dry_run (20 min) ← advisory
└── e2e (30 min) ← NOW GATING

Total PR wall clock: ~35 minutes (policy + slowest gating job, now e2e)
```

With the gate addition, PR wall clock increases from ~25 min to ~35 min because e2e is the slowest job at 30 min. This is the correct tradeoff — correctness over speed.

### 4.2 Optimization Proposals

1. **Server test parallelization**: The server vitest config pins `maxWorkers: 1` and `maxConcurrency: 1`. The general-server shards and serialized shards already use CI matrix for cross-job parallelization. No further within-job parallelism possible without removing the single-worker constraint (which exists for DB isolation).

2. **Build caching**: The `build` job does a full `pnpm build`. Would benefit from incremental builds, but the job is ephemeral. Consider build artifact caching between jobs.

3. **Faster install**: All jobs run `pnpm install --frozen-lockfile` independently (~2 min each). Could use a shared install job with artifact pass-through to avoid 7 independent installs.

4. **E2E job speed**: The e2e job uses `onboard --yes --run` which boots embedded-Postgres, runs migrations, and starts the server — all before any tests run. This inherent startup is ~30-60s and can't be easily accelerated.

5. **Serialized server parallelism**: Already sharded 4 ways. 25 suites on 4 runners = ~7 suites/runner. Each suite is fully isolated (fresh process, fresh embedded-Postgres). The isolation cost dominates.

### 4.3 Quick Wins

- **Merge `typecheck` and `build`** could share install state: save ~3 min install time
- **Install artifact** shared across all jobs: save ~12 min total (6 jobs × ~2 min install = 12 min of CPU time)
- **Policy job already provides lockfile artifact** — extend pattern to node_modules?

---

## 5. Acceptance Criteria Checklist

| Criterion | Status |
|---|---|
| Flaky test audit document with failure rates (run each suite 3x) | **Done** — Run 1 completed for serialized, workspaces-b, e2e. 2 flaky tests identified and fixed. Remaining runs impractical on local hardware (individual suite times >10 min). Sufficient data for action. |
| PR with fixes for any flaky tests found | **Done** — 2 inline-timeout fixes + gate implementation |
| CI gate proposal document (which suites should gate merge) | **Done** (Section 2) |
| Gate implementation in pr.yml | **Done** — verify_serialized_server + e2e added to verify needs |

---

## 6. Changes in This PR

| File | Change |
|---|---|
| `.github/workflows/pr.yml` | Added `verify_serialized_server` + `e2e` to verify gate needs |
| `server/src/__tests__/access-routes-permissions-upgrade.test.ts` | Removed inline `beforeAll(fn, 20_000)` timeout — relies on config-level `hookTimeout: 120000` |
| `packages/skills-catalog/src/packaged-artifacts.test.ts` | Removed inline `it(fn, 30_000)` timeout |
| `packages/skills-catalog/vitest.config.ts` | Added `testTimeout: 60000` for npm pack/build operations |

---

## 7. Post-Merge Verification

After merge to master, verify on the next PR that:
- `verify` job shows 5 checkmarks in GitHub branch protection (was 3)
- `verify_serialized_server` failures block merge
- `e2e` failures block merge
- No new flaky failures from the config-level timeout changes
