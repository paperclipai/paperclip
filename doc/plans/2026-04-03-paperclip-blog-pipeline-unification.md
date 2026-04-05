# Paperclip Blog Pipeline Unification

Date: 2026-04-03  
Owner: daehan  
Status: proposed

## Goal

Build one Paperclip-native blog automation system that:

- uses Paperclip as the only orchestration and approval control plane
- preserves the best execution behavior from `mac-pipeline`
- preserves the strongest publish safety guarantees from `board-app`
- keeps WordPress write access tightly isolated
- supports `draft-first`, `publish`, and `report-only` lanes without duplicating orchestration

This plan does not keep two top-level pipelines alive. It absorbs them into one architecture with one source of truth.

## Non-goals

- Keep `mac-pipeline` and `board-app` as long-term parallel orchestrators
- Let general-purpose agents call WordPress write APIs directly
- Make Git, local filesystem artifacts, or issue comments the canonical run state
- Rebuild WordPress publishing from scratch inside Paperclip

## Current State

### What `mac-pipeline` is good at

Files:

- [/Users/daehan/.openclaw/workspace/mac-pipeline/runner/local-pipeline-runner.js](/Users/daehan/.openclaw/workspace/mac-pipeline/runner/local-pipeline-runner.js)
- [/Users/daehan/.openclaw/workspace/mac-pipeline/lib/research/run-research-step.js](/Users/daehan/.openclaw/workspace/mac-pipeline/lib/research/run-research-step.js)
- [/Users/daehan/.openclaw/workspace/mac-pipeline/lib/draft/run-draft-step.js](/Users/daehan/.openclaw/workspace/mac-pipeline/lib/draft/run-draft-step.js)
- [/Users/daehan/.openclaw/workspace/mac-pipeline/lib/validate/run-validate-step.js](/Users/daehan/.openclaw/workspace/mac-pipeline/lib/validate/run-validate-step.js)
- [/Users/daehan/.openclaw/workspace/mac-pipeline/lib/publish/run-publish-step.js](/Users/daehan/.openclaw/workspace/mac-pipeline/lib/publish/run-publish-step.js)
- [/Users/daehan/.openclaw/workspace/mac-pipeline/lib/verify/run-public-verify-step.js](/Users/daehan/.openclaw/workspace/mac-pipeline/lib/verify/run-public-verify-step.js)

Strengths:

- clean step decomposition
- run-local simplicity
- artifact-per-run output under `runs/<run-id>/`
- direct end-to-end smokeability
- WordPress publish path already enforces non-`localhost` API URL
- dry-run and live publish both exist

Weaknesses:

- state lives primarily in filesystem JSON, not in a first-class orchestration model
- no durable approval boundary before WordPress side effects
- no strong idempotency ledger around publish execution
- no central multi-run control plane
- no Paperclip-native issue/heartbeat integration

### What `board-app` is good at

Files:

- [/Users/daehan/ec2-migration/home-ubuntu/board-app/ai-worker.js](/Users/daehan/ec2-migration/home-ubuntu/board-app/ai-worker.js)
- [/Users/daehan/ec2-migration/home-ubuntu/board-app/lib/publish-gateway.js](/Users/daehan/ec2-migration/home-ubuntu/board-app/lib/publish-gateway.js)
- [/Users/daehan/ec2-migration/home-ubuntu/board-app/publish-gateway-daemon.js](/Users/daehan/ec2-migration/home-ubuntu/board-app/publish-gateway-daemon.js)
- [/Users/daehan/ec2-migration/home-ubuntu/board-app/lib/publish-step-execution-helpers.js](/Users/daehan/ec2-migration/home-ubuntu/board-app/lib/publish-step-execution-helpers.js)
- [/Users/daehan/ec2-migration/home-ubuntu/board-app/lib/editorial-publish-utils.js](/Users/daehan/ec2-migration/home-ubuntu/board-app/lib/editorial-publish-utils.js)

Strengths:

- strong lane separation between publish and report
- approval snapshot hashing
- content drift invalidation
- publish idempotency key
- explicit publish-execute lease pattern
- publish verification contract is treated as mandatory

Weaknesses:

- top-level orchestration overlaps with what Paperclip should own
- daemon polling model duplicates job scheduling responsibility
- daily-task-run state model is specific to board-app
- too much policy and orchestration are coupled in one runtime

## Core Decision

The correct target is:

- `Paperclip` owns orchestration, approval workflow, scheduling, and operator visibility
- `mac-pipeline` contributes reusable step executors
- `board-app` contributes reusable publish policy and verification contracts
- WordPress side effects are executed by exactly one isolated publisher worker

This is not a federation of pipelines. It is one pipeline with three code origins.

## Recommended Architecture

### Control Plane

Paperclip becomes the only authoritative state manager.

Responsibilities:

- schedule runs via heartbeats
- create and track blog tasks and blog runs
- show current phase, blocked reason, and artifacts
- route runs to worker agents
- require explicit approval before WordPress publish when configured
- record retries, operator overrides, and verification outcomes

### Execution Plane

Extract the step logic from `mac-pipeline` into a reusable package or service module.

Proposed Paperclip module:

- `packages/blog-pipeline-core`

Contents:

- research step
- draft step
- draft review step
- draft polish step
- final review step
- validate step
- image step
- publish adapter interface
- public verify adapter interface

The old local runner becomes a thin compatibility wrapper, not the canonical engine.

### Policy Plane

Extract publish policy and verification contracts from `board-app` into a reusable module.

Proposed Paperclip module:

- `packages/blog-pipeline-policy`

Contents:

- lane rules
- publish approval hashing
- content drift revocation
- publish idempotency key creation
- final review normalization
- public verification contract
- report-lane WordPress write prohibition

The old board-app daemon becomes unnecessary once Paperclip owns run claiming.

### Side-effect Boundary

Create one dedicated publisher service boundary.

Proposed module:

- `server/src/services/blog-publisher`

Responsibilities:

- own WordPress credentials
- validate publish approval before any write
- perform `/users/me`, `/posts`, `/media`, `/posts/{id}` calls
- persist publish execution record
- return structured publish result only

Hard rule:

- no other worker or agent may receive WordPress write credentials by default

## Single Unified Run Model

### Canonical entity

Add a `BlogRun` domain model to Paperclip.

Suggested fields:

- `id`
- `company_id`
- `project_id`
- `issue_id`
- `topic`
- `lane`
- `target_site`
- `status`
- `current_step`
- `approval_mode`
- `publish_mode`
- `wordpress_post_id`
- `published_url`
- `approval_key_hash`
- `publish_idempotency_key`
- `created_at`
- `updated_at`
- `completed_at`
- `failed_reason`

### Step attempts

Add `BlogRunStepAttempt`.

Suggested fields:

- `blog_run_id`
- `step_key`
- `attempt_number`
- `status`
- `started_at`
- `finished_at`
- `worker_agent_id`
- `error_code`
- `error_message`
- `result_json`

### Artifacts

Add `BlogArtifact`.

Suggested fields:

- `blog_run_id`
- `step_key`
- `artifact_kind`
- `content_type`
- `storage_kind`
- `storage_path`
- `body_preview`
- `created_at`

Filesystem artifact copies under a run directory should remain, but they are mirrors, not the source of truth.

## Unified State Machine

Required states:

1. `queued`
2. `research_running`
3. `research_ready`
4. `draft_running`
5. `draft_ready`
6. `editorial_review_running`
7. `editorial_review_passed`
8. `validate_running`
9. `validated`
10. `publish_approval_pending`
11. `publish_approved`
12. `publish_running`
13. `published`
14. `public_verify_running`
15. `public_verified`
16. `archived`
17. `operator_review_required`
18. `failed`

Rules:

- only one active step at a time for a publish lane run
- research and drafting may be retried
- publish may be retried only through the publish idempotency boundary
- `public_verified` is the only successful terminal state for a published run

## Lanes

Keep lanes from `board-app`, but make them first-class in Paperclip.

### `publish`

- full run allowed
- WordPress write allowed only through publisher service
- public verify mandatory

### `draft_only`

- full content pipeline allowed
- publish step writes only `draft`
- public verify checks draft visibility expectations

### `report`

- research, drafting, review allowed
- WordPress write forbidden
- output stored as report artifact or comment

This keeps the strongest current safety behavior while mapping cleanly to Paperclip workflows.

## Approval Model

The publish approval design from `board-app` should be preserved.

Before `publish_running`, compute:

- artifact hash
- normalized DOM hash
- target slug
- site id
- policy version
- approval key hash

Then:

- if current content matches existing active approval, reuse it
- if content drifted, revoke previous approval
- if publish execution already exists for the same publish idempotency key, reuse it instead of writing again

This is the main protection against duplicate posts and silent drift.

## Publish Boundary

### Why a separate boundary is mandatory

Without a dedicated publish boundary:

- any research/draft worker can accidentally publish
- credentials spread across too many runtimes
- replay and duplication protection becomes inconsistent
- approval logic is easier to bypass

### Boundary contract

Input:

- `blog_run_id`
- `approval_id`
- `approval_key_hash`
- `publish_idempotency_key`
- `draft artifact reference`
- `target site`
- `target status`

Output:

- `wp_post_id`
- `status`
- `link`
- `featured_media`
- `supporting_media`
- `raw_result_json`

Only this boundary gets:

- `WP_API_URL`
- `WP_USER`
- `WP_APP_PASSWORD`

The current `mac-pipeline` rule that forbids `localhost` WordPress API URLs must be retained.

## Quality Gates

### Gate 1: structural validate

Use current `mac-pipeline` validation concepts:

- article shape
- H2 count
- claim ledger
- source registry
- topic alignment
- validator CLI output

### Gate 2: editorial review

Use the current review normalization logic from `board-app`:

- must-fix
- should-improve
- strengths
- reader drop points
- final publish review

### Gate 3: publish policy

Use `board-app` approval snapshot and lane policy.

### Gate 4: public verify

Use the current publish re-read contract:

- fetch WordPress post via REST
- fetch public HTML
- verify title
- verify featured image
- verify visibility matches status
- run final body contract against public output

Do not mark a run complete before Gate 4 passes.

## Artifact Strategy

Keep the good parts of `mac-pipeline` run directories, but subordinate them to Paperclip.

Recommended artifact set:

- `context.json`
- `research.json`
- `draft.json`
- `draft.md`
- `draft.review.json`
- `draft.polish.json`
- `draft.final-review.json`
- `validation.json`
- `publish.json`
- `verify.json`
- `image.json`
- `status.json`

Each should be stored in:

- Paperclip DB metadata
- filesystem artifact mirror under a stable run directory

The filesystem mirror is valuable for debugging, reproducibility, and postmortem review.

## Scheduling Model

Paperclip heartbeats should replace daemon polling.

Current `publish-gateway-daemon` behavior to remove:

- claim-step polling loop
- lease-based periodic daemon for top-level orchestration

Replacement:

- Paperclip heartbeat creates `BlogRun`
- Paperclip worker assignment claims next executable step
- step execution writes structured attempt result
- next step is derived from state transition rules

Keep lease semantics inside the run-step claim system if needed, but do not keep a separate daemon loop outside Paperclip.

## Concurrency Policy

Mandatory limits:

- `publish` lane: concurrency `1`
- `draft_only` lane: low parallelism allowed
- `report` lane: parallelism allowed
- `publish_running` and `public_verify_running`: never parallelize on the same site

Reason:

- the current blog origin is one local Mac
- publish is the highest blast-radius phase

## Secrets and Trust Boundaries

Rules:

- WordPress write credentials are injected only into the publisher boundary
- general agents get no default WordPress write context
- approval payloads must be signed or hashed exactly once per publish boundary
- report lane must fail hard if any WordPress publish intent appears

This preserves the strongest safety behavior already present in `board-app`.

## Why This Beats Keeping Two Pipelines

Keeping two separate pipelines causes:

- duplicated scheduling
- duplicated state machines
- duplicated retry logic
- ambiguous source of truth
- harder incident recovery

The proposed design keeps:

- `mac-pipeline` step quality
- `board-app` publish safety
- `Paperclip` orchestration

while removing duplicated top-level orchestration.

## Migration Plan

### Phase 0: freeze interfaces

- inventory current step inputs and outputs
- inventory current publish approval and verify contracts
- treat current run JSON artifacts as the temporary compatibility contract

### Phase 1: extract reusable modules

- move `mac-pipeline` step logic into `packages/blog-pipeline-core`
- move `board-app` publish policy logic into `packages/blog-pipeline-policy`
- no behavior changes yet

Success condition:

- local runner still works
- board-app tests still pass

### Phase 2: add Paperclip BlogRun model

- add tables or equivalent storage for blog runs, step attempts, and artifacts
- add server services for claiming and completing blog steps
- add minimal API endpoints

Success condition:

- Paperclip can represent a run and store artifacts without publishing

### Phase 3: integrate research through validate

- Paperclip orchestrates research, draft, review, polish, and validate using extracted core steps
- publish remains disabled

Success condition:

- dry-run artifacts match existing mac-pipeline output quality

### Phase 4: integrate publisher boundary

- replace direct local runner publish control with Paperclip publisher service
- enforce approval hashing, drift revoke, and idempotency

Success condition:

- same content cannot double-publish
- drift forces new approval

### Phase 5: integrate public verify as terminal success gate

- public verify becomes required for success
- failed verify routes to auto-repair or operator review

Success condition:

- no published run is marked complete without re-read verification

### Phase 6: deprecate wrappers

- keep `mac-pipeline` local runner as a thin debug harness only
- retire board-app daemon-driven orchestration

Success condition:

- Paperclip is the only production orchestrator

## Hard Rejections

Do not do any of these:

- keep `local-pipeline-runner.js` as a long-term primary orchestrator
- keep `publish-gateway-daemon.js` as a long-term primary scheduler
- let multiple workers write directly to WordPress
- treat filesystem status JSON as the source of truth
- skip public verify for successful publish runs
- allow `localhost` WordPress API targets in publisher config

## Acceptance Criteria

The unified design is successful when:

- one Paperclip run maps to one blog pipeline execution
- all run state is visible in Paperclip
- publish is impossible without approval
- duplicate publish attempts reuse the prior execution
- public verify is required before success
- draft-only and report lanes remain safe
- existing `mac-pipeline` quality checks and `board-app` safety checks are both preserved

## Recommendation

Implement `Paperclip-native orchestration + mac-pipeline execution core + board-app publish policy`.

This is the highest-quality structure because it separates concerns correctly:

- Paperclip decides and records
- mac-pipeline produces
- board-app policy protects
- one publisher writes
- one verifier closes the loop
