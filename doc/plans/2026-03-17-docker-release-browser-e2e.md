# Docker Release Browser E2E Plan

## Context

Today release smoke testing for published Paperclip packages is manual and shell-driven:

```sh
HOST_PORT=3232 DATA_DIR=./data/release-smoke-canary PAPERCLIPAI_VERSION=canary ./scripts/docker-onboard-smoke.sh
HOST_PORT=3233 DATA_DIR=./data/release-smoke-stable PAPERCLIPAI_VERSION=latest ./scripts/docker-onboard-smoke.sh
```

That is useful because it exercises the same public install surface users hit:

- Docker
- `npx paperclipai@canary`
- `npx paperclipai@latest`
- authenticated bootstrap flow

But it still leaves the most important release questions to a human with a browser:

- can I sign in with the smoke credentials?
- do I land in onboarding?
- can I complete onboarding?
- does the initial CEO agent actually get created and run?

The repo already has two adjacent pieces:

- `tests/e2e/onboarding.spec.ts` covers the onboarding wizard against the local source tree
- `scripts/docker-onboard-smoke.sh` boots a published Docker install and auto-bootstraps authenticated mode, but only verifies the API/session layer

What is missing is one deterministic browser test that joins those two paths.

## Goal

Add a release-grade Docker-backed browser E2E that validates the published `canary` and `latest` installs end to end:

1. boot the published package in Docker
2. sign in with known smoke credentials
3. verify the user is routed into onboarding
4. complete onboarding in the browser
5. verify the first CEO agent exists
6. verify the initial CEO run was triggered and reached a terminal or active state

Then wire that test into GitHub Actions so release validation is no longer manual-only.

## Recommendation In One Sentence

Turn the current Docker smoke script into a machine-friendly test harness, add a dedicated Playwright release-smoke spec that drives the authenticated browser flow against published Docker installs, and run it in GitHub Actions for both `canary` and `latest`.

## What We Have Today

### Existing local browser coverage

`tests/e2e/onboarding.spec.ts` already proves the onboarding wizard can:

- create a company
- create a CEO agent
- create an initial issue
- optionally observe task progress

That is a good base, but it does not validate the public npm package, Docker path, authenticated login flow, or release dist-tags.

### Existing Docker smoke coverage

`scripts/docker-onboard-smoke.sh` already does useful setup work:

- builds `Dockerfile.onboard-smoke`
- runs `paperclipai@${PAPERCLIPAI_VERSION}` inside Docker
- waits for health
- signs up or signs in a smoke admin user
- generates and accepts the bootstrap CEO invite in authenticated mode
- verifies a board session and `/api/companies`

That means the hard bootstrap problem is mostly solved already. The main gap is that the script is human-oriented and never hands control to a browser test.

### Existing CI shape

The repo already has:

- `.github/workflows/e2e.yml` for manual Playwright runs against local source
- `.github/workflows/release.yml` for canary publish on `master` and manual stable promotion

So the right move is to extend the current test/release system, not create a parallel one.

## Product Decision

### 1. The release smoke should stay deterministic and token-free

The first version should not require OpenAI, Anthropic, or external agent credentials.

Use the onboarding flow with a deterministic adapter that can run on a stock GitHub runner and inside the published Docker install. The existing `process` adapter with a trivial command is the right base path for this release gate.

That keeps this test focused on:

- release packaging
- auth/bootstrap
- UI routing
- onboarding contract
- agent creation
- heartbeat invocation plumbing

Later we can add a second credentialed smoke lane for real model-backed agents.

### 2. Smoke credentials become an explicit test contract

The current defaults in `scripts/docker-onboard-smoke.sh` should be treated as stable test fixtures:

- email: `smoke-admin@paperclip.local`
- password: `paperclip-smoke-password`

The browser test should log in with those exact values unless overridden by env vars.

### 3. Published-package smoke and source-tree E2E stay separate

Keep two lanes:

- source-tree E2E for feature development
- published Docker release smoke for release confidence

They overlap on onboarding assertions, but they guard different failure classes.

## Proposed Design

## 1. Add a CI-friendly Docker smoke harness

Refactor `scripts/docker-onboard-smoke.sh` so it can run in two modes:

- interactive mode
  - current behavior
  - streams logs and waits in foreground for manual inspection
- CI mode
  - starts the container
  - waits for health and authenticated bootstrap
  - prints machine-readable metadata
  - exits while leaving the container running for Playwright

Recommended shape:

- keep `scripts/docker-onboard-smoke.sh` as the public entry point
- add a `SMOKE_DETACH=true` or `--detach` mode
- emit a JSON blob or `.env` file containing:
  - `SMOKE_BASE_URL`
  - `SMOKE_ADMIN_EMAIL`
  - `SMOKE_ADMIN_PASSWORD`
  - `SMOKE_CONTAINER_NAME`
  - `SMOKE_DATA_DIR`

The workflow and Playwright tests can then consume the emitted metadata instead of scraping logs.

### Why this matters

The current script always tails logs and then blocks on `wait "$LOG_PID"`. That is convenient for manual smoke testing, but it is the wrong shape for CI orchestration.

## 2. Add a dedicated Playwright release-smoke spec

Create a second Playwright entry point specifically for published Docker installs, for example:

- `tests/release-smoke/playwright.config.ts`
- `tests/release-smoke/docker-auth-onboarding.spec.ts`

This suite should not use Playwright `webServer`, because the app server will already be running inside Docker.

### Browser scenario

The first release-smoke scenario should validate:

1. open `/`
2. unauthenticated user is redirected to `/auth`
3. sign in using the smoke credentials
4. authenticated user lands on onboarding when no companies exist
5. onboarding wizard appears with the expected step labels
6. create a company
7. create the first agent using `process`
8. create the initial issue
9. finish onboarding and open the created issue
10. verify via API:
    - company exists
    - CEO agent exists
    - issue exists and is assigned to the CEO
11. verify the first heartbeat run was triggered:
    - either by checking issue status changed from initial state, or
    - by checking agent/runs API shows a run for the CEO, or
    - both

The test should tolerate the run completing quickly. For this reason, the assertion should accept:

- `queued`
- `running`
- `succeeded`

and similarly for issue progression if the issue status changes before the assertion runs.

### Why a separate spec instead of reusing `tests/e2e/onboarding.spec.ts`

The local-source test and release-smoke test have different assumptions:

- different server lifecycle
- different auth path
- different deployment mode
- published npm package instead of local workspace code

Trying to force both through one spec will make both worse.

## 3. Add a release-smoke workflow in GitHub Actions

Add a workflow dedicated to this surface, ideally reusable:

- `.github/workflows/release-smoke.yml`

Recommended triggers:

- `workflow_dispatch`
- `workflow_call`

Recommended inputs:

- `paperclip_version`
  - `canary` or `latest`
- `host_port`
  - optional, default runner-safe port
- `artifact_name`
  - optional for clearer uploads

### Job outline

1. checkout repo
2. install Node/pnpm
3. install Playwright browser dependencies
4. launch Docker smoke harness in detached mode with the chosen dist-tag
5. run the release-smoke Playwright suite against the returned base URL
6. always collect diagnostics:
   - Playwright report
   - screenshots
   - trace
   - `docker logs`
   - harness metadata file
7. stop and remove container

### Why a reusable workflow

This lets us:

- run the smoke manually on demand
- call it from `release.yml`
- reuse the same job for both `canary` and `latest`

## 4. Integrate it into release automation incrementally

### Phase A: Manual workflow only

First ship the workflow as manual-only so the harness and test can be stabilized without blocking releases.

### Phase B: Run automatically after canary publish

After `publish_canary` succeeds in `.github/workflows/release.yml`, call the reusable release-smoke workflow with:

- `paperclip_version=canary`

This proves the just-published public canary really boots and onboards.

### Phase C: Run automatically after stable publish

After `publish_stable` succeeds, call the same workflow with:

- `paperclip_version=latest`

This gives us post-publish confirmation that the stable dist-tag is healthy.

### Important nuance

Testing `latest` from npm cannot happen before stable publish, because the package under test does not exist under `latest` yet. So the `latest` smoke is a post-publish verification, not a pre-publish gate.

If we later want a true pre-publish stable gate, that should be a separate source-ref or locally built package smoke job.

## 5. Make diagnostics first-class

This workflow is only valuable if failures are fast to debug.

Always capture:

- Playwright HTML report
- Playwright trace on failure
- final screenshot on failure
- full `docker logs` output
- emitted smoke metadata
- optional `curl /api/health` snapshot

Without that, the test will become a flaky black box and people will stop trusting it.

## Implementation Plan

## Phase 1: Harness refactor

Files:

- `scripts/docker-onboard-smoke.sh`
- optionally `scripts/lib/docker-onboard-smoke.sh` or similar helper
- `doc/DOCKER.md`
- `doc/RELEASING.md`

Tasks:

1. Add detached/CI mode to the Docker smoke script.
2. Make the script emit machine-readable connection metadata.
3. Keep the current interactive manual mode intact.
4. Add reliable cleanup commands for CI.

Acceptance:

- a script invocation can start the published Docker app, auto-bootstrap it, and return control to the caller with enough metadata for browser automation

## Phase 2: Browser release-smoke suite

Files:

- `tests/release-smoke/playwright.config.ts`
- `tests/release-smoke/docker-auth-onboarding.spec.ts`
- root `package.json`

Tasks:

1. Add a dedicated Playwright config for external server testing.
2. Implement login + onboarding + CEO creation flow.
3. Assert a CEO run was created or completed.
4. Add a root script such as:
   - `test:release-smoke`

Acceptance:

- the suite passes locally against both:
  - `PAPERCLIPAI_VERSION=canary`
  - `PAPERCLIPAI_VERSION=latest`

## Phase 3: GitHub Actions workflow

Files:

- `.github/workflows/release-smoke.yml`

Tasks:

1. Add manual and reusable workflow entry points.
2. Install Chromium and runner dependencies.
3. Start Docker smoke in detached mode.
4. Run the release-smoke Playwright suite.
5. Upload diagnostics artifacts.

Acceptance:

- a maintainer can run the workflow manually for either `canary` or `latest`

## Phase 4: Release workflow integration

Files:

- `.github/workflows/release.yml`
- `doc/RELEASING.md`

Tasks:

1. Trigger release smoke automatically after canary publish.
2. Trigger release smoke automatically after stable publish.
3. Document expected behavior and failure handling.

Acceptance:

- canary releases automatically produce a published-package browser smoke result
- stable releases automatically produce a `latest` browser smoke result

## Phase 5: Future extension for real model-backed agent validation

Not part of the first implementation, but this should be the next layer after the deterministic lane is stable.

Possible additions:

- a second Playwright project gated on repo secrets
- real `claude_local` or `codex_local` adapter validation in Docker-capable environments
- assertion that the CEO posts a real task/comment artifact
- stable release holdback until the credentialed lane passes

This should stay optional until the token-free lane is trustworthy.

## Acceptance Criteria

The plan is complete when the implemented system can demonstrate all of the following:

1. A published `paperclipai@canary` Docker install can be smoke-tested by Playwright in CI.
2. A published `paperclipai@latest` Docker install can be smoke-tested by Playwright in CI.
3. The test logs into authenticated mode with the smoke credentials.
4. The test sees onboarding for a fresh instance.
5. The test completes onboarding in the browser.
6. The test verifies the initial CEO agent was created.
7. The test verifies at least one CEO heartbeat run was triggered.
8. Failures produce actionable artifacts rather than just a red job.

## Risks And Decisions To Make

### 1. Fast process runs may finish before the UI visibly updates

That is expected. The assertions should prefer API polling for run existence/status rather than only visual indicators.

### 2. `latest` smoke is post-publish, not preventive

This is a real limitation of testing the published dist-tag itself. It is still valuable, but it should not be confused with a pre-publish gate.

### 3. We should not overcouple the test to cosmetic onboarding text

The important contract is flow success, created entities, and run creation. Use visible labels sparingly and prefer stable semantic selectors where possible.

### 4. Keep the smoke adapter path boring

For release safety, the first test should use the most boring runnable adapter possible. This is not the place to validate every adapter.

## Recommended First Slice

If we want the fastest path to value, ship this in order:

1. add detached mode to `scripts/docker-onboard-smoke.sh`
2. add one Playwright spec for authenticated login + onboarding + CEO run verification
3. add manual `release-smoke.yml`
4. once stable, wire canary into `release.yml`
5. after that, wire stable `latest` smoke into `release.yml`

That gives release confidence quickly without turning the first version into a large CI redesign.
