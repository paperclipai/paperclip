# Paperclip Blog Pipeline Unification Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Turn the current split `mac-pipeline` plus `board-app` blog automation into one Paperclip-native pipeline with a single control plane, a single publish boundary, and mandatory public verification.

**Architecture:** Paperclip will own run state, approvals, scheduling, and operator visibility. Step execution logic will be extracted from `mac-pipeline` into a reusable core package, publish safety logic will be extracted from `board-app` into a reusable policy package, and a dedicated server-side publisher service will be the only code path allowed to write to WordPress.

**Tech Stack:** TypeScript, Express, Drizzle ORM, PostgreSQL, Vitest, existing Paperclip server/services/routes, extracted Node step runners from `mac-pipeline`, extracted publish policy helpers from `board-app`.

---

## Preconditions

- Work in a dedicated branch or worktree off the Paperclip repo root:
  - [/Users/daehan/Documents/persona/paperclip](/Users/daehan/Documents/persona/paperclip)
- Use the design doc as the normative source:
  - [/Users/daehan/Documents/persona/paperclip/doc/plans/2026-04-03-paperclip-blog-pipeline-unification.md](/Users/daehan/Documents/persona/paperclip/doc/plans/2026-04-03-paperclip-blog-pipeline-unification.md)
- Do not delete the old runners until the new Paperclip path passes dry-run and publish smoke tests.

## Task 1: Add Canonical Blog Run Storage

**Files:**
- Create: [/Users/daehan/Documents/persona/paperclip/packages/db/src/schema/blog_runs.ts](/Users/daehan/Documents/persona/paperclip/packages/db/src/schema/blog_runs.ts)
- Modify: [/Users/daehan/Documents/persona/paperclip/packages/db/src/schema/index.ts](/Users/daehan/Documents/persona/paperclip/packages/db/src/schema/index.ts)
- Create: [/Users/daehan/Documents/persona/paperclip/packages/db/src/migrations/0047_blog_pipeline_unification.sql](/Users/daehan/Documents/persona/paperclip/packages/db/src/migrations/0047_blog_pipeline_unification.sql)
- Test: [/Users/daehan/Documents/persona/paperclip/packages/db/src/client.test.ts](/Users/daehan/Documents/persona/paperclip/packages/db/src/client.test.ts)

**Step 1: Write the failing DB test**

Add a migration test that expects these tables to exist:

- `blog_runs`
- `blog_run_step_attempts`
- `blog_artifacts`
- `blog_publish_approvals`
- `blog_publish_executions`

**Step 2: Run test to verify it fails**

Run:
```bash
cd /Users/daehan/Documents/persona/paperclip
pnpm test:run -- packages/db/src/client.test.ts
```

Expected: FAIL because the new tables and schema exports do not exist yet.

**Step 3: Add schema and migration**

Create `blog_runs.ts` exporting all five tables. Keep fields minimal but sufficient:

- `blog_runs`: run identity, company/project/issue, lane, status, current step, site, publish mode, approval hash, idempotency key, post ID, URL, timestamps, failure reason
- `blog_run_step_attempts`: per-step attempt ledger with status, timestamps, worker agent, result JSON, error code/message
- `blog_artifacts`: artifact metadata with run ID, step key, kind, content type, storage path, preview
- `blog_publish_approvals`: entity snapshot hashes, approval payload, revoked metadata
- `blog_publish_executions`: approval link, idempotency key, published result JSON

Update `schema/index.ts` to export the new tables. Add SQL migration `0047_blog_pipeline_unification.sql`.

**Step 4: Run DB checks**

Run:
```bash
cd /Users/daehan/Documents/persona/paperclip
pnpm --filter @paperclipai/db typecheck
pnpm test:run -- packages/db/src/client.test.ts
```

Expected: PASS for schema compile and migration table existence coverage.

**Step 5: Commit**

```bash
git add packages/db/src/schema/blog_runs.ts packages/db/src/schema/index.ts packages/db/src/migrations/0047_blog_pipeline_unification.sql packages/db/src/client.test.ts
git commit -m "feat: add blog pipeline run schema"
```

## Task 2: Extract `mac-pipeline` Step Core Into A Reusable Package

**Files:**
- Create: [/Users/daehan/Documents/persona/paperclip/packages/blog-pipeline-core/package.json](/Users/daehan/Documents/persona/paperclip/packages/blog-pipeline-core/package.json)
- Create: [/Users/daehan/Documents/persona/paperclip/packages/blog-pipeline-core/tsconfig.json](/Users/daehan/Documents/persona/paperclip/packages/blog-pipeline-core/tsconfig.json)
- Create: [/Users/daehan/Documents/persona/paperclip/packages/blog-pipeline-core/src/index.ts](/Users/daehan/Documents/persona/paperclip/packages/blog-pipeline-core/src/index.ts)
- Create: [/Users/daehan/Documents/persona/paperclip/packages/blog-pipeline-core/src/types.ts](/Users/daehan/Documents/persona/paperclip/packages/blog-pipeline-core/src/types.ts)
- Create: [/Users/daehan/Documents/persona/paperclip/packages/blog-pipeline-core/src/research.ts](/Users/daehan/Documents/persona/paperclip/packages/blog-pipeline-core/src/research.ts)
- Create: [/Users/daehan/Documents/persona/paperclip/packages/blog-pipeline-core/src/draft.ts](/Users/daehan/Documents/persona/paperclip/packages/blog-pipeline-core/src/draft.ts)
- Create: [/Users/daehan/Documents/persona/paperclip/packages/blog-pipeline-core/src/review.ts](/Users/daehan/Documents/persona/paperclip/packages/blog-pipeline-core/src/review.ts)
- Create: [/Users/daehan/Documents/persona/paperclip/packages/blog-pipeline-core/src/validate.ts](/Users/daehan/Documents/persona/paperclip/packages/blog-pipeline-core/src/validate.ts)
- Test: [/Users/daehan/Documents/persona/paperclip/server/src/__tests__/blog-pipeline-core-contract.test.ts](/Users/daehan/Documents/persona/paperclip/server/src/__tests__/blog-pipeline-core-contract.test.ts)
- Reference source files:
  - [/Users/daehan/.openclaw/workspace/mac-pipeline/lib/research/run-research-step.js](/Users/daehan/.openclaw/workspace/mac-pipeline/lib/research/run-research-step.js)
  - [/Users/daehan/.openclaw/workspace/mac-pipeline/lib/draft/run-draft-step.js](/Users/daehan/.openclaw/workspace/mac-pipeline/lib/draft/run-draft-step.js)
  - [/Users/daehan/.openclaw/workspace/mac-pipeline/lib/draft/run-draft-review-step.js](/Users/daehan/.openclaw/workspace/mac-pipeline/lib/draft/run-draft-review-step.js)
  - [/Users/daehan/.openclaw/workspace/mac-pipeline/lib/draft/run-draft-polish-step.js](/Users/daehan/.openclaw/workspace/mac-pipeline/lib/draft/run-draft-polish-step.js)
  - [/Users/daehan/.openclaw/workspace/mac-pipeline/lib/draft/run-final-review-step.js](/Users/daehan/.openclaw/workspace/mac-pipeline/lib/draft/run-final-review-step.js)
  - [/Users/daehan/.openclaw/workspace/mac-pipeline/lib/validate/run-validate-step.js](/Users/daehan/.openclaw/workspace/mac-pipeline/lib/validate/run-validate-step.js)

**Step 1: Write the failing contract test**

Add a server test that imports `@paperclipai/blog-pipeline-core` and expects these entry points:

- `runResearchStep`
- `runDraftStep`
- `runDraftReviewStep`
- `runDraftPolishStep`
- `runFinalReviewStep`
- `runValidateStep`

**Step 2: Run test to verify it fails**

Run:
```bash
cd /Users/daehan/Documents/persona/paperclip
pnpm test:run -- server/src/__tests__/blog-pipeline-core-contract.test.ts
```

Expected: FAIL because the package does not exist yet.

**Step 3: Create the package and copy step logic**

Create `@paperclipai/blog-pipeline-core` and move only execution logic, not top-level orchestration:

- normalize all inputs around `BlogRunContext`
- replace filesystem-only assumptions with explicit adapter interfaces where practical
- keep a compatibility file-artifact adapter for initial migration
- do not move direct WordPress write logic into this package

**Step 4: Run package checks**

Run:
```bash
cd /Users/daehan/Documents/persona/paperclip
pnpm --filter @paperclipai/blog-pipeline-core typecheck
pnpm test:run -- server/src/__tests__/blog-pipeline-core-contract.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/blog-pipeline-core server/src/__tests__/blog-pipeline-core-contract.test.ts
git commit -m "feat: extract blog pipeline execution core"
```

## Task 3: Extract Publish Policy And Verification Contracts From `board-app`

**Files:**
- Create: [/Users/daehan/Documents/persona/paperclip/packages/blog-pipeline-policy/package.json](/Users/daehan/Documents/persona/paperclip/packages/blog-pipeline-policy/package.json)
- Create: [/Users/daehan/Documents/persona/paperclip/packages/blog-pipeline-policy/tsconfig.json](/Users/daehan/Documents/persona/paperclip/packages/blog-pipeline-policy/tsconfig.json)
- Create: [/Users/daehan/Documents/persona/paperclip/packages/blog-pipeline-policy/src/index.ts](/Users/daehan/Documents/persona/paperclip/packages/blog-pipeline-policy/src/index.ts)
- Create: [/Users/daehan/Documents/persona/paperclip/packages/blog-pipeline-policy/src/lane-policy.ts](/Users/daehan/Documents/persona/paperclip/packages/blog-pipeline-policy/src/lane-policy.ts)
- Create: [/Users/daehan/Documents/persona/paperclip/packages/blog-pipeline-policy/src/publish-approval.ts](/Users/daehan/Documents/persona/paperclip/packages/blog-pipeline-policy/src/publish-approval.ts)
- Create: [/Users/daehan/Documents/persona/paperclip/packages/blog-pipeline-policy/src/public-verify-contract.ts](/Users/daehan/Documents/persona/paperclip/packages/blog-pipeline-policy/src/public-verify-contract.ts)
- Test: [/Users/daehan/Documents/persona/paperclip/server/src/__tests__/blog-pipeline-policy.test.ts](/Users/daehan/Documents/persona/paperclip/server/src/__tests__/blog-pipeline-policy.test.ts)
- Reference source files:
  - [/Users/daehan/ec2-migration/home-ubuntu/board-app/lib/publish-gateway.js](/Users/daehan/ec2-migration/home-ubuntu/board-app/lib/publish-gateway.js)
  - [/Users/daehan/ec2-migration/home-ubuntu/board-app/lib/editorial-publish-utils.js](/Users/daehan/ec2-migration/home-ubuntu/board-app/lib/editorial-publish-utils.js)
  - [/Users/daehan/ec2-migration/home-ubuntu/board-app/ai-worker.js](/Users/daehan/ec2-migration/home-ubuntu/board-app/ai-worker.js)

**Step 1: Write the failing policy test**

Add tests for:

- `report` lane rejecting WordPress writes
- same approval hash reusing publish execution
- changed content revoking old approval
- public verify contract requiring post reread rather than trusting side-effect success

**Step 2: Run test to verify it fails**

Run:
```bash
cd /Users/daehan/Documents/persona/paperclip
pnpm test:run -- server/src/__tests__/blog-pipeline-policy.test.ts
```

Expected: FAIL because the package does not exist yet.

**Step 3: Create policy package**

Move only policy logic, not daemon scheduling:

- lane permissions
- approval hash generation
- content drift revoke helpers
- publish idempotency key generation
- public verify contract
- final review normalization helpers if needed by publish gate

Do not port `publish-gateway-daemon.js`.

**Step 4: Run checks**

Run:
```bash
cd /Users/daehan/Documents/persona/paperclip
pnpm --filter @paperclipai/blog-pipeline-policy typecheck
pnpm test:run -- server/src/__tests__/blog-pipeline-policy.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/blog-pipeline-policy server/src/__tests__/blog-pipeline-policy.test.ts
git commit -m "feat: extract blog pipeline publish policy"
```

## Task 4: Build The Dedicated WordPress Publisher Boundary

**Files:**
- Create: [/Users/daehan/Documents/persona/paperclip/server/src/services/blog-publisher.ts](/Users/daehan/Documents/persona/paperclip/server/src/services/blog-publisher.ts)
- Modify: [/Users/daehan/Documents/persona/paperclip/server/src/services/index.ts](/Users/daehan/Documents/persona/paperclip/server/src/services/index.ts)
- Test: [/Users/daehan/Documents/persona/paperclip/server/src/__tests__/blog-publisher.test.ts](/Users/daehan/Documents/persona/paperclip/server/src/__tests__/blog-publisher.test.ts)
- Reference source file:
  - [/Users/daehan/.openclaw/workspace/mac-pipeline/lib/publish/run-publish-step.js](/Users/daehan/.openclaw/workspace/mac-pipeline/lib/publish/run-publish-step.js)

**Step 1: Write the failing publisher test**

Cover:

- rejects `localhost` or `127.0.0.1` WordPress API targets
- fails without `WP_USER` and `WP_APP_PASSWORD`
- publishes `draft` and `publish` modes
- uploads featured image and supporting media
- returns structured publish result
- never runs without a valid approval and idempotency key

**Step 2: Run test to verify it fails**

Run:
```bash
cd /Users/daehan/Documents/persona/paperclip
pnpm test:run -- server/src/__tests__/blog-publisher.test.ts
```

Expected: FAIL because the service does not exist yet.

**Step 3: Implement publisher service**

In `blog-publisher.ts`:

- own `WP_API_URL`, `WP_USER`, `WP_APP_PASSWORD`
- provide low-level `wpRequest`
- provide `publishDraft`, `publishPost`, `attachFeaturedMedia`, `uploadSupportingMedia`
- enforce non-`localhost` API host
- accept only structured inputs from a `BlogRun`
- write execution rows to `blog_publish_executions`

**Step 4: Run checks**

Run:
```bash
cd /Users/daehan/Documents/persona/paperclip
pnpm --filter @paperclipai/server typecheck
pnpm test:run -- server/src/__tests__/blog-publisher.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/src/services/blog-publisher.ts server/src/services/index.ts server/src/__tests__/blog-publisher.test.ts
git commit -m "feat: add isolated blog publisher service"
```

## Task 5: Add Blog Run Service And API Surface

**Files:**
- Create: [/Users/daehan/Documents/persona/paperclip/server/src/services/blog-runs.ts](/Users/daehan/Documents/persona/paperclip/server/src/services/blog-runs.ts)
- Create: [/Users/daehan/Documents/persona/paperclip/server/src/routes/blog-runs.ts](/Users/daehan/Documents/persona/paperclip/server/src/routes/blog-runs.ts)
- Modify: [/Users/daehan/Documents/persona/paperclip/server/src/services/index.ts](/Users/daehan/Documents/persona/paperclip/server/src/services/index.ts)
- Modify: [/Users/daehan/Documents/persona/paperclip/server/src/routes/index.ts](/Users/daehan/Documents/persona/paperclip/server/src/routes/index.ts)
- Test: [/Users/daehan/Documents/persona/paperclip/server/src/__tests__/blog-runs-service.test.ts](/Users/daehan/Documents/persona/paperclip/server/src/__tests__/blog-runs-service.test.ts)
- Test: [/Users/daehan/Documents/persona/paperclip/server/src/__tests__/blog-runs-routes.test.ts](/Users/daehan/Documents/persona/paperclip/server/src/__tests__/blog-runs-routes.test.ts)

**Step 1: Write the failing service and route tests**

Cover:

- create run
- claim next executable step
- complete step
- fail step
- record artifacts
- require approval before publish step
- return current status and artifact list

**Step 2: Run tests to verify they fail**

Run:
```bash
cd /Users/daehan/Documents/persona/paperclip
pnpm test:run -- server/src/__tests__/blog-runs-service.test.ts server/src/__tests__/blog-runs-routes.test.ts
```

Expected: FAIL because the service and route do not exist yet.

**Step 3: Implement service and routes**

In `blog-runs.ts`:

- `createRun`
- `getRun`
- `listRunArtifacts`
- `claimNextStep`
- `completeStep`
- `failStep`
- `requestPublishApproval`
- `markPublished`
- `markPublicVerified`

In `blog-runs.ts` routes:

- `POST /api/projects/:projectId/blog-runs`
- `GET /api/blog-runs/:id`
- `POST /api/blog-runs/:id/claim-step`
- `POST /api/blog-runs/:id/steps/:stepKey/complete`
- `POST /api/blog-runs/:id/steps/:stepKey/fail`
- `POST /api/blog-runs/:id/request-publish-approval`

**Step 4: Run checks**

Run:
```bash
cd /Users/daehan/Documents/persona/paperclip
pnpm --filter @paperclipai/server typecheck
pnpm test:run -- server/src/__tests__/blog-runs-service.test.ts server/src/__tests__/blog-runs-routes.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/src/services/blog-runs.ts server/src/routes/blog-runs.ts server/src/services/index.ts server/src/routes/index.ts server/src/__tests__/blog-runs-service.test.ts server/src/__tests__/blog-runs-routes.test.ts
git commit -m "feat: add blog run orchestration API"
```

## Task 6: Wire Paperclip Heartbeats And Workers To The Unified Step Graph

**Files:**
- Modify: [/Users/daehan/Documents/persona/paperclip/server/src/services/heartbeat.ts](/Users/daehan/Documents/persona/paperclip/server/src/services/heartbeat.ts)
- Modify: [/Users/daehan/Documents/persona/paperclip/server/src/services/heartbeat-run-summary.ts](/Users/daehan/Documents/persona/paperclip/server/src/services/heartbeat-run-summary.ts)
- Create: [/Users/daehan/Documents/persona/paperclip/server/src/services/blog-run-worker.ts](/Users/daehan/Documents/persona/paperclip/server/src/services/blog-run-worker.ts)
- Test: [/Users/daehan/Documents/persona/paperclip/server/src/__tests__/blog-run-worker.test.ts](/Users/daehan/Documents/persona/paperclip/server/src/__tests__/blog-run-worker.test.ts)
- Test: [/Users/daehan/Documents/persona/paperclip/server/src/__tests__/heartbeat-blog-runs.test.ts](/Users/daehan/Documents/persona/paperclip/server/src/__tests__/heartbeat-blog-runs.test.ts)

**Step 1: Write the failing worker tests**

Cover:

- heartbeat can create a `BlogRun`
- worker claims the next step in order
- `publish` lane concurrency is capped at `1`
- `report` lane never reaches publisher
- `public_verified` is the only success terminal state for live publish

**Step 2: Run tests to verify they fail**

Run:
```bash
cd /Users/daehan/Documents/persona/paperclip
pnpm test:run -- server/src/__tests__/blog-run-worker.test.ts server/src/__tests__/heartbeat-blog-runs.test.ts
```

Expected: FAIL because no worker integration exists yet.

**Step 3: Implement worker graph**

In `blog-run-worker.ts`:

- map run step keys to extracted core package functions
- call policy package before publish
- call publisher service for publish only
- call public verify after publish
- route failed validation or verify to `operator_review_required`

In `heartbeat.ts`:

- allow heartbeat-driven creation of `BlogRun`
- route configured blog heartbeat items into `blog-run-worker`

**Step 4: Run checks**

Run:
```bash
cd /Users/daehan/Documents/persona/paperclip
pnpm --filter @paperclipai/server typecheck
pnpm test:run -- server/src/__tests__/blog-run-worker.test.ts server/src/__tests__/heartbeat-blog-runs.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/src/services/heartbeat.ts server/src/services/heartbeat-run-summary.ts server/src/services/blog-run-worker.ts server/src/__tests__/blog-run-worker.test.ts server/src/__tests__/heartbeat-blog-runs.test.ts
git commit -m "feat: wire heartbeats into unified blog run worker"
```

## Task 7: Add Artifact Mirroring And Compatibility Wrappers

**Files:**
- Create: [/Users/daehan/Documents/persona/paperclip/server/src/services/blog-artifact-mirror.ts](/Users/daehan/Documents/persona/paperclip/server/src/services/blog-artifact-mirror.ts)
- Modify: [/Users/daehan/Documents/persona/paperclip/server/src/services/blog-runs.ts](/Users/daehan/Documents/persona/paperclip/server/src/services/blog-runs.ts)
- Create: [/Users/daehan/Documents/persona/paperclip/server/src/__tests__/blog-artifact-mirror.test.ts](/Users/daehan/Documents/persona/paperclip/server/src/__tests__/blog-artifact-mirror.test.ts)
- Optional compatibility wrapper:
  - Modify: [/Users/daehan/.openclaw/workspace/mac-pipeline/runner/local-pipeline-runner.js](/Users/daehan/.openclaw/workspace/mac-pipeline/runner/local-pipeline-runner.js)

**Step 1: Write the failing artifact mirror test**

Cover:

- every completed step writes a DB artifact record
- a filesystem mirror is written under a stable run directory
- the filesystem copy is derived from DB-backed state, not vice versa

**Step 2: Run test to verify it fails**

Run:
```bash
cd /Users/daehan/Documents/persona/paperclip
pnpm test:run -- server/src/__tests__/blog-artifact-mirror.test.ts
```

Expected: FAIL because mirror service does not exist yet.

**Step 3: Implement artifact mirror**

In `blog-artifact-mirror.ts`:

- choose a stable root such as `PAPERCLIP_HOME/blog-runs/<run-id>/`
- mirror `context.json`, `research.json`, `draft.json`, `draft.md`, `validation.json`, `publish.json`, `verify.json`, and status snapshots
- write after each successful step completion

Optionally change the old local runner to call the new Paperclip API instead of running the whole orchestration graph locally.

**Step 4: Run checks**

Run:
```bash
cd /Users/daehan/Documents/persona/paperclip
pnpm --filter @paperclipai/server typecheck
pnpm test:run -- server/src/__tests__/blog-artifact-mirror.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/src/services/blog-artifact-mirror.ts server/src/services/blog-runs.ts server/src/__tests__/blog-artifact-mirror.test.ts
git commit -m "feat: mirror blog run artifacts to filesystem"
```

## Task 8: End-to-End Dry-Run And Live Publish Smoke Coverage

**Files:**
- Create: [/Users/daehan/Documents/persona/paperclip/server/src/__tests__/blog-pipeline-dry-run.e2e.test.ts](/Users/daehan/Documents/persona/paperclip/server/src/__tests__/blog-pipeline-dry-run.e2e.test.ts)
- Create: [/Users/daehan/Documents/persona/paperclip/server/src/__tests__/blog-pipeline-publish.e2e.test.ts](/Users/daehan/Documents/persona/paperclip/server/src/__tests__/blog-pipeline-publish.e2e.test.ts)
- Reference:
  - [/Users/daehan/Documents/persona/paperclip/server/src/__tests__/routines-e2e.test.ts](/Users/daehan/Documents/persona/paperclip/server/src/__tests__/routines-e2e.test.ts)

**Step 1: Write the failing e2e tests**

Cover:

- dry-run run produces all step artifacts without WordPress writes
- live publish run creates a post through publisher boundary
- public verify failure blocks success
- duplicate publish request reuses the same execution

**Step 2: Run tests to verify they fail**

Run:
```bash
cd /Users/daehan/Documents/persona/paperclip
pnpm test:run -- server/src/__tests__/blog-pipeline-dry-run.e2e.test.ts server/src/__tests__/blog-pipeline-publish.e2e.test.ts
```

Expected: FAIL because the integrated graph is not complete yet.

**Step 3: Implement the missing glue**

Add only the smallest missing changes needed to make both e2e tests pass. Prefer using mocks for external LLM/image generation and real local logic for run state transitions, policy evaluation, and publish boundary calls.

**Step 4: Run full verification**

Run:
```bash
cd /Users/daehan/Documents/persona/paperclip
pnpm --filter @paperclipai/db typecheck
pnpm --filter @paperclipai/server typecheck
pnpm test:run -- packages/db/src/client.test.ts
pnpm test:run -- server/src/__tests__/blog-publisher.test.ts
pnpm test:run -- server/src/__tests__/blog-runs-service.test.ts
pnpm test:run -- server/src/__tests__/blog-runs-routes.test.ts
pnpm test:run -- server/src/__tests__/blog-run-worker.test.ts
pnpm test:run -- server/src/__tests__/blog-pipeline-dry-run.e2e.test.ts
pnpm test:run -- server/src/__tests__/blog-pipeline-publish.e2e.test.ts
```

Expected: PASS across the new blog pipeline surface.

**Step 5: Commit**

```bash
git add server/src/__tests__/blog-pipeline-dry-run.e2e.test.ts server/src/__tests__/blog-pipeline-publish.e2e.test.ts
git commit -m "test: add unified blog pipeline e2e coverage"
```

## Rollout Order

Ship in this order:

1. schema
2. core package
3. policy package
4. publisher boundary
5. run service and routes
6. heartbeat worker
7. artifact mirroring
8. end-to-end coverage

Do not enable live publish from Paperclip before step 8 passes.

## Final Verification Checklist

- [ ] `mac-pipeline` execution logic is reusable without its top-level runner
- [ ] `board-app` publish safeguards exist without daemon orchestration
- [ ] Paperclip owns all run state transitions
- [ ] only one publisher service can write to WordPress
- [ ] duplicate publishes reuse execution by idempotency key
- [ ] public verify is mandatory for live-publish success
- [ ] draft-only and report lanes still behave safely

Plan complete and saved to `doc/plans/2026-04-03-paperclip-blog-pipeline-unification-implementation.md`. Two execution options:

**1. Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

Which approach?
