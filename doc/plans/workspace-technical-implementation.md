# Workspace Technical Implementation Spec

## Role of This Document

This document translates [workspace-product-model-and-work-product.md](/Users/dotta/paperclip-subissues/doc/plans/workspace-product-model-and-work-product.md) into an implementation-ready engineering plan.

It is intentionally concrete:

- schema and migration shape
- shared contract updates
- route and service changes
- UI changes
- rollout and compatibility rules

This is the implementation target for the first workspace-aware delivery slice.

## Locked Decisions

These decisions are treated as settled for this implementation:

1. Add a new durable `execution_workspaces` table now.
2. Each issue has at most one current execution workspace at a time.
3. `issues` get explicit `project_workspace_id` and `execution_workspace_id`.
4. Workspace reuse is in scope for V1.
5. The feature is gated in the UI by `/instance/settings > Experimental > Workspaces`.
6. The gate is UI-only. Backend model changes and migrations always ship.
7. Existing users upgrade into compatibility-preserving defaults.
8. `project_workspaces` evolves in place rather than being replaced.
9. Work product is issue-first, with optional links to execution workspaces and runtime services.
10. GitHub is the only PR provider in the first slice.
11. Both `adapter_managed` and `cloud_sandbox` execution modes are in scope.
12. Workspace controls ship first inside existing project properties, not in a new global navigation area.
13. Subissues are out of scope for this implementation slice.

## Non-Goals

- Building a full code review system
- Solving subissue UX in this slice
- Implementing reusable shared workspace definitions across projects in this slice
- Reworking all current runtime service behavior before introducing execution workspaces

## Existing Baseline

The repo already has:

- `project_workspaces`
- `projects.execution_workspace_policy`
- `issues.execution_workspace_settings`
- runtime service persistence in `workspace_runtime_services`
- local git-worktree realization in `workspace-runtime.ts`

This implementation should build on that baseline rather than fork it.

## Terminology

- `Project workspace`: durable configured codebase/root for a project
- `Execution workspace`: actual runtime workspace used for one or more issues
- `Work product`: user-facing output such as PR, preview, branch, commit, artifact, document
- `Runtime service`: process or service owned or tracked for a workspace
- `Compatibility mode`: existing behavior preserved for upgraded installs with no explicit workspace opt-in

## Architecture Summary

The first slice should introduce three explicit layers:

1. `Project workspace`
   - existing durable project-scoped codebase record
   - extended to support local, git, non-git, and remote-managed shapes

2. `Execution workspace`
   - new durable runtime record
   - represents shared, isolated, operator-branch, or remote-managed execution context

3. `Issue work product`
   - new durable output record
   - stores PRs, previews, branches, commits, artifacts, and documents

The issue remains the planning and ownership unit.
The execution workspace remains the runtime unit.
The work product remains the deliverable/output unit.

## Configuration and Deployment Topology

## Important correction

This repo already uses `PAPERCLIP_DEPLOYMENT_MODE` for auth/deployment behavior (`local_trusted | authenticated`).

Do not overload that variable for workspace execution topology.

## New env var

Add a separate execution-host hint:

- `PAPERCLIP_EXECUTION_TOPOLOGY=local|cloud|hybrid`

Default:

- if unset, treat as `local`

Purpose:

- influences defaults and validation for workspace configuration
- does not change current auth/deployment semantics
- does not break existing installs

### Semantics

- `local`
  - Paperclip may create host-local worktrees, processes, and paths
- `cloud`
  - Paperclip should assume no durable host-local execution workspace management
  - adapter-managed and cloud-sandbox flows should be treated as first-class
- `hybrid`
  - both local and remote execution strategies may exist

This is a guardrail and defaulting aid, not a hard policy engine in the first slice.

## Instance Settings

Add a new `Experimental` section under `/instance/settings`.

### New setting

- `experimental.workspaces: boolean`

Rules:

- default `false`
- UI-only gate
- stored in instance config or instance settings API response
- backend routes and migrations remain available even when false

### UI behavior when off

- hide workspace-specific issue controls
- hide workspace-specific project configuration
- hide issue `Work Product` tab if it would otherwise be empty
- do not remove or invalidate any stored workspace data

## Data Model

## 1. Extend `project_workspaces`

Current table exists and should evolve in place.

### New columns

- `source_type text not null default 'local_path'`
  - `local_path | git_repo | non_git_path | remote_managed`
- `default_ref text null`
- `visibility text not null default 'default'`
  - `default | advanced`
- `setup_command text null`
- `cleanup_command text null`
- `remote_provider text null`
  - examples: `github`, `openai`, `anthropic`, `custom`
- `remote_workspace_ref text null`
- `shared_workspace_key text null`
  - reserved for future cross-project shared workspace definitions

### Backfill rules

- if existing row has `repo_url`, backfill `source_type='git_repo'`
- else if existing row has `cwd`, backfill `source_type='local_path'`
- else backfill `source_type='remote_managed'`
- copy existing `repo_ref` into `default_ref`

### Indexes

- retain current indexes
- add `(project_id, source_type)`
- add `(company_id, shared_workspace_key)` non-unique for future support

## 2. Add `execution_workspaces`

Create a new durable table.

### Columns

- `id uuid pk`
- `company_id uuid not null`
- `project_id uuid not null`
- `project_workspace_id uuid null`
- `source_issue_id uuid null`
- `mode text not null`
  - `shared_workspace | isolated_workspace | operator_branch | adapter_managed | cloud_sandbox`
- `strategy_type text not null`
  - `project_primary | git_worktree | adapter_managed | cloud_sandbox`
- `name text not null`
- `status text not null default 'active'`
  - `active | idle | in_review | archived | cleanup_failed`
- `cwd text null`
- `repo_url text null`
- `base_ref text null`
- `branch_name text null`
- `provider_type text not null default 'local_fs'`
  - `local_fs | git_worktree | adapter_managed | cloud_sandbox`
- `provider_ref text null`
- `derived_from_execution_workspace_id uuid null`
- `last_used_at timestamptz not null default now()`
- `opened_at timestamptz not null default now()`
- `closed_at timestamptz null`
- `cleanup_eligible_at timestamptz null`
- `cleanup_reason text null`
- `metadata jsonb null`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

### Foreign keys

- `company_id -> companies.id`
- `project_id -> projects.id`
- `project_workspace_id -> project_workspaces.id on delete set null`
- `source_issue_id -> issues.id on delete set null`
- `derived_from_execution_workspace_id -> execution_workspaces.id on delete set null`

### Indexes

- `(company_id, project_id, status)`
- `(company_id, project_workspace_id, status)`
- `(company_id, source_issue_id)`
- `(company_id, last_used_at desc)`
- `(company_id, branch_name)` non-unique

## 3. Extend `issues`

Add explicit workspace linkage.

### New columns

- `project_workspace_id uuid null`
- `execution_workspace_id uuid null`
- `execution_workspace_preference text null`
  - `inherit | shared_workspace | isolated_workspace | operator_branch | reuse_existing`

### Foreign keys

- `project_workspace_id -> project_workspaces.id on delete set null`
- `execution_workspace_id -> execution_workspaces.id on delete set null`

### Backfill rules

- all existing issues get null values
- null should be interpreted as compatibility/inherit behavior

### Invariants

- if `project_workspace_id` is set, it must belong to the issue's project and company
- if `execution_workspace_id` is set, it must belong to the issue's company
- if `execution_workspace_id` is set, the referenced workspace's `project_id` must match the issue's `project_id`

## 4. Add `issue_work_products`

Create a new durable table for outputs.

### Columns

- `id uuid pk`
- `company_id uuid not null`
- `project_id uuid null`
- `issue_id uuid not null`
- `execution_workspace_id uuid null`
- `runtime_service_id uuid null`
- `type text not null`
  - `preview_url | runtime_service | pull_request | branch | commit | artifact | document`
- `provider text not null`
  - `paperclip | github | vercel | s3 | custom`
- `external_id text null`
- `title text not null`
- `url text null`
- `status text not null`
  - `active | ready_for_review | approved | changes_requested | merged | closed | failed | archived`
- `review_state text not null default 'none'`
  - `none | needs_board_review | approved | changes_requested`
- `is_primary boolean not null default false`
- `health_status text not null default 'unknown'`
  - `unknown | healthy | unhealthy`
- `summary text null`
- `metadata jsonb null`
- `created_by_run_id uuid null`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

### Foreign keys

- `company_id -> companies.id`
- `project_id -> projects.id on delete set null`
- `issue_id -> issues.id on delete cascade`
- `execution_workspace_id -> execution_workspaces.id on delete set null`
- `runtime_service_id -> workspace_runtime_services.id on delete set null`
- `created_by_run_id -> heartbeat_runs.id on delete set null`

### Indexes

- `(company_id, issue_id, type)`
- `(company_id, execution_workspace_id, type)`
- `(company_id, provider, external_id)`
- `(company_id, updated_at desc)`

## 5. Extend `workspace_runtime_services`

This table already exists and should remain the system of record for owned/tracked services.

### New column

- `execution_workspace_id uuid null`

### Foreign key

- `execution_workspace_id -> execution_workspaces.id on delete set null`

### Behavior

- runtime services remain workspace-first
- issue UIs should surface them through linked execution workspaces and work products

## Shared Contracts

## 1. `packages/shared`

### Update project workspace types and validators

Add fields:

- `sourceType`
- `defaultRef`
- `visibility`
- `setupCommand`
- `cleanupCommand`
- `remoteProvider`
- `remoteWorkspaceRef`
- `sharedWorkspaceKey`

### Add execution workspace types and validators

New shared types:

- `ExecutionWorkspace`
- `ExecutionWorkspaceMode`
- `ExecutionWorkspaceStatus`
- `ExecutionWorkspaceProviderType`

### Add work product types and validators

New shared types:

- `IssueWorkProduct`
- `IssueWorkProductType`
- `IssueWorkProductStatus`
- `IssueWorkProductReviewState`

### Update issue types and validators

Add:

- `projectWorkspaceId`
- `executionWorkspaceId`
- `executionWorkspacePreference`
- `workProducts?: IssueWorkProduct[]`

### Extend project execution policy contract

Replace the current narrow policy with a more explicit shape:

- `enabled`
- `defaultMode`
  - `shared_workspace | isolated_workspace | operator_branch | adapter_default`
- `allowIssueOverride`
- `defaultProjectWorkspaceId`
- `workspaceStrategy`
- `branchPolicy`
- `pullRequestPolicy`
- `runtimePolicy`
- `cleanupPolicy`

Do not try to encode every possible provider-specific field in V1. Keep provider-specific extensibility in nested JSON where needed.

## Service Layer Changes

## 1. Project service

Update project workspace CRUD to handle the extended schema.

### Required rules

- when setting a primary workspace, clear `is_primary` on siblings
- `source_type=remote_managed` may have null `cwd`
- local/git-backed workspaces should still require one of `cwd` or `repo_url`
- preserve current behavior for existing callers that only send `cwd/repoUrl/repoRef`

## 2. Issue service

Update create/update flows to handle explicit workspace binding.

### Create behavior

Resolve defaults in this order:

1. explicit `projectWorkspaceId` from request
2. `project.executionWorkspacePolicy.defaultProjectWorkspaceId`
3. project's primary workspace
4. null

Resolve `executionWorkspacePreference`:

1. explicit request field
2. project policy default
3. compatibility fallback to `inherit`

Do not create an execution workspace at issue creation time unless:

- `reuse_existing` is explicitly chosen and `executionWorkspaceId` is provided

Otherwise, workspace realization happens when execution starts.

### Update behavior

- allow changing `projectWorkspaceId` only if the workspace belongs to the same project
- allow setting `executionWorkspaceId` only if it belongs to the same company and project
- do not automatically destroy or relink historical work products when workspace linkage changes

## 3. Workspace realization service

Refactor `workspace-runtime.ts` so realization produces or reuses an `execution_workspaces` row.

### New flow

Input:

- issue
- project workspace
- project execution policy
- execution topology hint
- adapter/runtime configuration

Output:

- realized execution workspace record
- runtime cwd/provider metadata

### Required modes

- `shared_workspace`
  - reuse a stable execution workspace representing the project primary/shared workspace
- `isolated_workspace`
  - create or reuse a derived isolated execution workspace
- `operator_branch`
  - create or reuse a long-lived branch workspace
- `adapter_managed`
  - create an execution workspace with provider references and optional null `cwd`
- `cloud_sandbox`
  - same as adapter-managed, but explicit remote sandbox semantics

### Reuse rules

When `reuse_existing` is requested:

- only list active or recently used execution workspaces
- only for the same project
- only for the same project workspace if one is specified
- exclude archived and cleanup-failed workspaces

### Shared workspace realization

For compatibility mode and shared-workspace projects:

- create a stable execution workspace per project workspace when first needed
- reuse it for subsequent runs

This avoids a special-case branch in later work product linkage.

## 4. Runtime service integration

When runtime services are started or reused:

- populate `execution_workspace_id`
- continue populating `project_workspace_id`, `project_id`, and `issue_id`

When a runtime service yields a URL:

- optionally create or update a linked `issue_work_products` row of type `runtime_service` or `preview_url`

## 5. PR and preview reporting

Add a service for creating/updating `issue_work_products`.

### Supported V1 product types

- `pull_request`
- `preview_url`
- `runtime_service`
- `branch`
- `commit`
- `artifact`
- `document`

### GitHub PR reporting

For V1, GitHub is the only provider with richer semantics.

Supported statuses:

- `draft`
- `ready_for_review`
- `approved`
- `changes_requested`
- `merged`
- `closed`

Represent these in `status` and `review_state` rather than inventing a separate PR table in V1.

## Routes and API

## 1. Project workspace routes

Extend existing routes:

- `GET /projects/:id/workspaces`
- `POST /projects/:id/workspaces`
- `PATCH /projects/:id/workspaces/:workspaceId`
- `DELETE /projects/:id/workspaces/:workspaceId`

### New accepted/returned fields

- `sourceType`
- `defaultRef`
- `visibility`
- `setupCommand`
- `cleanupCommand`
- `remoteProvider`
- `remoteWorkspaceRef`

## 2. Execution workspace routes

Add:

- `GET /companies/:companyId/execution-workspaces`
  - filters:
    - `projectId`
    - `projectWorkspaceId`
    - `status`
    - `issueId`
    - `reuseEligible=true`
- `GET /execution-workspaces/:id`
- `PATCH /execution-workspaces/:id`
  - update status/metadata/cleanup fields only in V1

Do not add top-level navigation for these routes yet.

## 3. Work product routes

Add:

- `GET /issues/:id/work-products`
- `POST /issues/:id/work-products`
- `PATCH /work-products/:id`
- `DELETE /work-products/:id`

### V1 mutation permissions

- board can create/update/delete all
- agents can create/update for issues they are assigned or currently executing
- deletion should generally archive rather than hard-delete once linked to historical output

## 4. Issue routes

Extend existing create/update payloads to accept:

- `projectWorkspaceId`
- `executionWorkspacePreference`
- `executionWorkspaceId`

Extend `GET /issues/:id` to return:

- `projectWorkspaceId`
- `executionWorkspaceId`
- `executionWorkspacePreference`
- `currentExecutionWorkspace`
- `workProducts[]`

## 5. Instance settings routes

Add support for:

- reading/writing `experimental.workspaces`

This is a UI gate only.

If there is no generic instance settings storage yet, the first slice can store this in the existing config/instance settings mechanism used by `/instance/settings`.

## UI Changes

## 1. `/instance/settings`

Add section:

- `Experimental`
  - `Enable Workspaces`

When off:

- hide new workspace-specific affordances
- do not alter existing project or issue behavior

## 2. Project properties

Do not create a separate `Code` tab yet.
Ship inside existing project properties first.

### Add or re-enable sections

- `Project Workspaces`
- `Execution Defaults`
- `Provisioning`
- `Pull Requests`
- `Previews and Runtime`
- `Cleanup`

### Display rules

- only show when `experimental.workspaces=true`
- keep wording generic enough for local and remote setups
- only show git-specific fields when `sourceType=git_repo`
- only show local-path-specific fields when not `remote_managed`

## 3. Issue create dialog

When the workspace experimental flag is on and the selected project has workspace automation or workspaces:

### Basic fields

- `Codebase`
  - select from project workspaces
  - default to policy default or primary workspace
- `Execution mode`
  - `Project default`
  - `Shared workspace`
  - `Isolated workspace`
  - `Operator branch`

### Advanced section

- `Reuse existing execution workspace`

This control should query only:

- same project
- same codebase if selected
- active/recent workspaces
- compact labels with branch or workspace name

Do not expose all execution workspaces in a noisy unfiltered list.

## 4. Issue detail

Add a `Work Product` tab when:

- the experimental flag is on, or
- the issue already has work products

### Show

- current execution workspace summary
- PR cards
- preview cards
- branch/commit rows
- artifacts/documents

Add compact header chips:

- codebase
- workspace
- PR count/status
- preview status

## 5. Execution workspace detail page

Add a detail route but no nav item.

Linked from:

- issue work product tab
- project workspace/execution panels

### Show

- identity and status
- project workspace origin
- source issue
- linked issues
- branch/ref/provider info
- runtime services
- work products
- cleanup state

## Runtime and Adapter Behavior

## 1. Local adapters

For local adapters:

- continue to use existing cwd/worktree realization paths
- persist the result as execution workspaces
- attach runtime services and work product to the execution workspace and issue

## 2. Remote or cloud adapters

For remote adapters:

- allow execution workspaces with null `cwd`
- require provider metadata sufficient to identify the remote workspace/session
- allow work product creation without any host-local process ownership

Examples:

- cloud coding agent opens a branch and PR on GitHub
- Vercel preview URL is reported back as a preview work product
- remote sandbox emits artifact URLs

## 3. Approval-aware PR workflow

V1 should support richer PR state tracking, but not a full review engine.

### Required actions

- `open_pr`
- `mark_ready`

### Required review states

- `draft`
- `ready_for_review`
- `approved`
- `changes_requested`
- `merged`
- `closed`

### Storage approach

- represent these as `issue_work_products` with `type='pull_request'`
- use `status` and `review_state`
- store provider-specific details in `metadata`

## Migration Plan

## 1. Existing installs

The migration posture is backward-compatible by default.

### Guarantees

- no existing project must be edited before it keeps working
- no existing issue flow should start requiring workspace input
- all new nullable columns must preserve current behavior when absent

## 2. Project workspace migration

Migrate `project_workspaces` in place.

### Backfill

- derive `source_type`
- copy `repo_ref` to `default_ref`
- leave new optional fields null

## 3. Issue migration

Do not backfill `project_workspace_id` or `execution_workspace_id` on all existing issues.

Reason:

- the safest migration is to preserve current runtime behavior and bind explicitly only when new workspace-aware flows are used

Interpret old issues as:

- `executionWorkspacePreference = inherit`
- compatibility/shared behavior

## 4. Runtime history migration

Do not attempt a perfect historical reconstruction of execution workspaces in the migration itself.

Instead:

- create execution workspace records forward from first new run
- optionally add a later backfill tool for recent runtime services if it proves valuable

## Rollout Order

## Phase 1: Schema and shared contracts

1. extend `project_workspaces`
2. add `execution_workspaces`
3. add `issue_work_products`
4. extend `issues`
5. extend `workspace_runtime_services`
6. update shared types and validators

## Phase 2: Service wiring

1. update project workspace CRUD
2. update issue create/update resolution
3. refactor workspace realization to persist execution workspaces
4. attach runtime services to execution workspaces
5. add work product service and persistence

## Phase 3: API and UI

1. add execution workspace routes
2. add work product routes
3. add instance experimental settings toggle
4. re-enable and revise project workspace UI behind the flag
5. add issue create/update controls behind the flag
6. add issue work product tab
7. add execution workspace detail page

## Phase 4: Provider integrations

1. GitHub PR reporting
2. preview URL reporting
3. runtime-service-to-work-product linking
4. remote/cloud provider references

## Acceptance Criteria

1. Existing installs continue to behave predictably with no required reconfiguration.
2. Projects can define local, git, non-git, and remote-managed project workspaces.
3. Issues can explicitly select a project workspace and execution preference.
4. Each issue can point to one current execution workspace.
5. Multiple issues can intentionally reuse the same execution workspace.
6. Execution workspaces are persisted for both local and remote execution flows.
7. Work products can be attached to issues with optional execution workspace linkage.
8. GitHub PRs can be represented with richer lifecycle states.
9. The main UI remains simple when the experimental flag is off.
10. No top-level workspace navigation is required for this first slice.

## Risks and Mitigations

## Risk: too many overlapping workspace concepts

Mitigation:

- keep issue UI to `Codebase` and `Execution mode`
- reserve execution workspace details for advanced pages

## Risk: breaking current projects on upgrade

Mitigation:

- nullable schema additions
- in-place `project_workspaces` migration
- compatibility defaults

## Risk: local-only assumptions leaking into cloud mode

Mitigation:

- make `cwd` optional for execution workspaces
- use `provider_type` and `provider_ref`
- use `PAPERCLIP_EXECUTION_TOPOLOGY` as a defaulting guardrail

## Risk: turning PRs into a bespoke subsystem too early

Mitigation:

- represent PRs as work products in V1
- keep provider-specific details in metadata
- defer a dedicated PR table unless usage proves it necessary

## Recommended First Engineering Slice

If we want the narrowest useful implementation:

1. extend `project_workspaces`
2. add `execution_workspaces`
3. extend `issues` with explicit workspace fields
4. persist execution workspaces from existing local workspace realization
5. add `issue_work_products`
6. show project workspace controls and issue workspace controls behind the experimental flag
7. add issue `Work Product` tab with PR/preview/runtime service display

This slice is enough to validate the model without yet building every provider integration or cleanup workflow.
