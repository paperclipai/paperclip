# Specialist Workflow Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class workflow templates, specialist role bundles, capability-aware routing, and artifact contracts so specialist operating loops are encoded in the product rather than left to prompts and operator habit.

**Architecture:** Build on the existing issue tree, execution policy, review surface, and execution workspace model instead of introducing a parallel orchestration system. Templates should decompose parent issues into child issues with explicit assignee roles, workspace preferences, required artifacts, and review gates, while routing and UI layers reuse the existing issue/task primitives.

**Tech Stack:** TypeScript, Express, React, Drizzle/Postgres schema already present in repo, React Query, existing `issues`/`issue_work_products`/`issue_documents`/`executionWorkspace` systems.

---

## Scope Check

This plan only covers the items that still look truly missing after source verification:

- Workflow templates that turn one initiative into a repeatable specialist flow
- Operational bundles for `designer`, `pm`, `researcher`, and a new `security` role
- Capability- and skill-aware routing beyond text heuristics
- Artifact contracts for stage completion and review
- A first-class security lane

This plan intentionally defers two things that are not clearly "missing" in the current system:

- Making isolated workspaces the global default everywhere
- Splitting QA and release into separate roles

Those should be follow-on product decisions after the foundations land.

## Reality Check

These capabilities already exist and should be reused, not rebuilt:

- Child issue delegation and parent/child wakeups
- QA/release gating and canonical QA ownership
- Output-first review packs
- Optional isolated execution workspaces and merge-on-QA-pass
- Company skill injection into agent runtime config

These are the main proof points in the current code:

- `server/src/services/issues.ts`
- `server/src/routes/issues.ts`
- `server/src/services/issue-review-items.ts`
- `server/src/services/issue-routing-heuristics.ts`
- `server/src/services/company-skills.ts`
- `server/src/services/default-agent-instructions.ts`
- `server/src/onboarding-assets/ceo/AGENTS.md`

## File Map

### New files

- `packages/shared/src/types/workflow-template.ts`
  Defines workflow template, lane, artifact requirement, and routing hint types shared across server and UI.
- `packages/shared/src/validators/workflow-template.ts`
  Validates template payloads and server-resolved template application requests.
- `server/src/services/workflow-templates.ts`
  Central source of built-in templates and resolution helpers.
- `server/src/services/issue-workflow-templates.ts`
  Applies a template to an issue by creating child issues, default assignee roles, workspace preferences, and artifact requirements.
- `server/src/services/agent-capability-routing.ts`
  Scores candidates using role, capabilities text, desired skills, runtime skills, project affinity, and current load.
- `server/src/__tests__/workflow-templates.test.ts`
  Validates built-in template definitions and server resolution rules.
- `server/src/__tests__/issue-workflow-templates.test.ts`
  Covers child issue creation, inheritance, and template application behavior.
- `server/src/__tests__/agent-capability-routing.test.ts`
  Covers routing decisions based on role, skills, and load.
- `server/src/onboarding-assets/designer/AGENTS.md`
- `server/src/onboarding-assets/designer/ROLE_TEMPLATE.md`
- `server/src/onboarding-assets/pm/AGENTS.md`
- `server/src/onboarding-assets/pm/ROLE_TEMPLATE.md`
- `server/src/onboarding-assets/researcher/AGENTS.md`
- `server/src/onboarding-assets/researcher/ROLE_TEMPLATE.md`
- `server/src/onboarding-assets/security/AGENTS.md`
- `server/src/onboarding-assets/security/ROLE_TEMPLATE.md`
  Specialist default bundles so these roles are operationally distinct rather than type-level labels only.

### Existing files to modify

- `packages/shared/src/constants.ts`
  Add `security` role and any new labels/constants needed for workflow templates.
- `packages/shared/src/types/issue.ts`
  Add workflow template assignment metadata and artifact requirement/status fields.
- `packages/shared/src/validators/issue.ts`
  Validate new workflow template metadata on create/update.
- `packages/shared/src/index.ts`
- `packages/shared/src/validators/index.ts`
  Export new shared types and validators.
- `server/src/services/default-agent-instructions.ts`
  Register new default specialist bundles.
- `server/src/services/agent-instructions.ts`
  Add role-specific baseline blocks where needed, especially for `security`.
- `server/src/services/agent-heartbeat-model.ts`
  Decide whether any specialist coverage/backfill should exist for `security`; do not auto-backfill lightly.
- `server/src/services/issue-routing-heuristics.ts`
  Demote heuristic-only scoring and hand off to capability-aware routing.
- `server/src/services/issues.ts`
  Persist workflow template metadata and support template-driven child issue creation.
- `server/src/routes/issues.ts`
  Add route(s) to apply templates to existing issues and enforce artifact requirements before stage completion.
- `server/src/services/issue-review-items.ts`
  Surface required artifacts and missing template outputs in the review pack.
- `ui/src/components/NewIssueDialog.tsx`
  Allow template selection when creating a new root issue.
- `ui/src/pages/IssueDetail.tsx`
  Add "apply workflow template" affordance and render lane progress.
- `ui/src/components/IssueProperties.tsx`
  Show template metadata, lane ownership, and artifact requirement state.
- `ui/src/components/IssueReviewBoard.tsx`
  Make missing required artifacts first-class blockers.
- `doc/PRODUCT.md`
- `doc/SPEC-implementation.md`
- `doc/DEVELOPING.md`
  Document the new control-plane behavior and operator expectations.

## Implementation Strategy

Use templates to create specialist child issues rather than trying to overload the existing execution-stage model with every department concern. Preserve the current single-assignee invariant and use existing parent/child issue semantics for parallelism and auditability.

The first built-in template should be one narrow path only:

- `engineering_delivery_v1`
  Lanes: `pm`, `design`, `build`, `security`, `qa`
  Artifacts: plan, design brief, implementation summary, threat review, QA verdict

Do not add a generic template builder in the first pass. Hard-code one built-in template, prove the system shape, then generalize later.

## Task 1: Add Shared Workflow Template Types

**Files:**
- Create: `packages/shared/src/types/workflow-template.ts`
- Create: `packages/shared/src/validators/workflow-template.ts`
- Modify: `packages/shared/src/types/issue.ts`
- Modify: `packages/shared/src/validators/issue.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/validators/index.ts`
- Test: `server/src/__tests__/workflow-templates.test.ts`

- [ ] **Step 1: Write failing shared/template tests**

Run: `pnpm vitest server/src/__tests__/workflow-templates.test.ts`
Expected: FAIL because workflow-template types and validators do not exist yet.

- [ ] **Step 2: Define shared types**

Add:
- `WorkflowTemplateKey`
- `WorkflowTemplateDefinition`
- `WorkflowTemplateLane`
- `WorkflowArtifactRequirement`
- `IssueWorkflowTemplateAssignment`

- [ ] **Step 3: Add validators and issue metadata**

Validate:
- template key
- required lanes
- required artifacts
- lane-level workspace preference

- [ ] **Step 4: Export shared API**

Update shared exports so both server and UI can consume the same model.

- [ ] **Step 5: Re-run focused test**

Run: `pnpm vitest server/src/__tests__/workflow-templates.test.ts`
Expected: PASS for shared model shape.

## Task 2: Add Built-In Specialist Bundles

**Files:**
- Modify: `packages/shared/src/constants.ts`
- Modify: `server/src/services/default-agent-instructions.ts`
- Modify: `server/src/services/agent-instructions.ts`
- Create: `server/src/onboarding-assets/designer/AGENTS.md`
- Create: `server/src/onboarding-assets/designer/ROLE_TEMPLATE.md`
- Create: `server/src/onboarding-assets/pm/AGENTS.md`
- Create: `server/src/onboarding-assets/pm/ROLE_TEMPLATE.md`
- Create: `server/src/onboarding-assets/researcher/AGENTS.md`
- Create: `server/src/onboarding-assets/researcher/ROLE_TEMPLATE.md`
- Create: `server/src/onboarding-assets/security/AGENTS.md`
- Create: `server/src/onboarding-assets/security/ROLE_TEMPLATE.md`
- Test: `server/src/__tests__/default-agent-instructions.test.ts`

- [ ] **Step 1: Write failing bundle coverage tests**

Run: `pnpm vitest server/src/__tests__/default-agent-instructions.test.ts`
Expected: FAIL because specialist bundles are missing.

- [ ] **Step 2: Add `security` as a first-class role**

Update labels/constants only. Do not auto-backfill the role yet.

- [ ] **Step 3: Register bundle roles**

Extend `default-agent-instructions.ts` so `designer`, `pm`, `researcher`, and `security` map to real onboarding assets.

- [ ] **Step 4: Write specialist instruction bundles**

Each bundle should define:
- when the role owns an issue
- what outputs it must produce
- when it must delegate or escalate

- [ ] **Step 5: Add any role-specific baseline injection**

If `security` needs non-optional threat review output rules, inject them through `agent-instructions.ts` the same way QA gets a baseline block today.

- [ ] **Step 6: Re-run focused tests**

Run: `pnpm vitest server/src/__tests__/default-agent-instructions.test.ts`
Expected: PASS.

## Task 3: Add Capability-Aware Routing

**Files:**
- Create: `server/src/services/agent-capability-routing.ts`
- Modify: `server/src/services/issue-routing-heuristics.ts`
- Modify: `server/src/services/company-skills.ts`
- Modify: `server/src/routes/issues.ts`
- Test: `server/src/__tests__/agent-capability-routing.test.ts`
- Test: `server/src/__tests__/issue-routing-heuristics.test.ts`

- [ ] **Step 1: Write failing routing tests**

Cover:
- role match beats keyword-only match
- matching desired/runtime skills beats plain title text
- overloaded candidate loses to similarly qualified lighter-load candidate
- `security` lane routes to security role first, then QA fallback only if no security agent exists

- [ ] **Step 2: Implement scoring service**

Score with:
- role
- title/capabilities text
- company skill attachment
- required runtime skills
- open issue count / same-project affinity

- [ ] **Step 3: Integrate routing service**

Keep current heuristics as low-level signals, but move final candidate selection into the new service.

- [ ] **Step 4: Re-run focused routing tests**

Run: `pnpm vitest server/src/__tests__/agent-capability-routing.test.ts server/src/__tests__/issue-routing-heuristics.test.ts`
Expected: PASS.

## Task 4: Add Built-In Workflow Template Resolution

**Files:**
- Create: `server/src/services/workflow-templates.ts`
- Test: `server/src/__tests__/workflow-templates.test.ts`

- [ ] **Step 1: Write failing template resolution tests**

Cover:
- built-in template key lookup
- lane definitions
- artifact requirements
- workspace preferences per lane

- [ ] **Step 2: Implement one built-in template**

Ship only `engineering_delivery_v1` with these lanes:
- `pm` -> plan artifact
- `designer` -> design artifact
- `engineer` -> implementation artifact
- `security` -> threat review artifact
- `qa` -> QA verdict artifact

- [ ] **Step 3: Re-run template tests**

Run: `pnpm vitest server/src/__tests__/workflow-templates.test.ts`
Expected: PASS.

## Task 5: Apply Templates by Creating Child Issues

**Files:**
- Create: `server/src/services/issue-workflow-templates.ts`
- Modify: `server/src/services/issues.ts`
- Modify: `server/src/routes/issues.ts`
- Test: `server/src/__tests__/issue-workflow-templates.test.ts`
- Test: `server/src/__tests__/issues-service.test.ts`

- [ ] **Step 1: Write failing application tests**

Cover:
- applying a template to a root issue creates child issues in deterministic order
- each child issue gets `parentId`, `goalId`, and lane metadata
- build/security/QA lanes inherit or request isolated workspace behavior when available
- duplicate application is rejected or idempotent

- [ ] **Step 2: Implement template application service**

Rules:
- only root or explicitly eligible issues can receive templates
- child issues should inherit project and workspace context where sensible
- assignee choice should be resolved through capability-aware routing

- [ ] **Step 3: Add route/UI payload support**

Support create-time template selection and apply-to-existing-issue flow.

- [ ] **Step 4: Re-run focused service tests**

Run: `pnpm vitest server/src/__tests__/issue-workflow-templates.test.ts server/src/__tests__/issues-service.test.ts`
Expected: PASS.

## Task 6: Enforce Artifact Contracts in Review and Completion

**Files:**
- Modify: `server/src/services/issue-review-items.ts`
- Modify: `server/src/routes/issues.ts`
- Modify: `ui/src/components/IssueReviewBoard.tsx`
- Modify: `ui/src/components/IssueProperties.tsx`
- Modify: `ui/src/pages/IssueDetail.tsx`
- Test: `server/src/__tests__/issue-review-items.test.ts`
- Test: `server/src/__tests__/issue-qa-gate-routes.test.ts`

- [ ] **Step 1: Write failing blocker tests**

Cover:
- missing required artifact shows as blocker in review surface
- lane cannot be marked complete if artifact contract is unsatisfied
- security lane requires explicit threat-review artifact, not just a free-form comment

- [ ] **Step 2: Implement artifact requirement synthesis**

Reuse existing work-product/document systems before adding new tables.

- [ ] **Step 3: Surface blockers in review UI**

Missing template artifacts should appear beside existing board-state blockers, not hidden as low-priority hints.

- [ ] **Step 4: Re-run review/gate tests**

Run: `pnpm vitest server/src/__tests__/issue-review-items.test.ts server/src/__tests__/issue-qa-gate-routes.test.ts`
Expected: PASS.

## Task 7: Add Template Selection and Lane Progress UI

**Files:**
- Modify: `ui/src/components/NewIssueDialog.tsx`
- Modify: `ui/src/pages/IssueDetail.tsx`
- Modify: `ui/src/components/IssueProperties.tsx`
- Test: `ui/src/components/NewIssueDialog.test.tsx`
- Test: `ui/src/components/IssueProperties.test.tsx`

- [ ] **Step 1: Write failing UI tests**

Cover:
- root issue creation shows template selector
- applying template from issue detail shows child lane summary
- issue properties render template/lane state and required artifacts

- [ ] **Step 2: Add template selection to create flow**

Only expose built-in template choices for root issues in v1.

- [ ] **Step 3: Add lane progress rendering**

Show:
- lane owner
- child issue status
- missing artifact count
- workspace mode indicator

- [ ] **Step 4: Re-run UI tests**

Run: `pnpm vitest ui/src/components/NewIssueDialog.test.tsx ui/src/components/IssueProperties.test.tsx`
Expected: PASS.

## Task 8: Documentation and Rollout Guardrails

**Files:**
- Modify: `doc/PRODUCT.md`
- Modify: `doc/SPEC-implementation.md`
- Modify: `doc/DEVELOPING.md`

- [ ] **Step 1: Update product docs**

Document that templates are built on issue trees and specialist child issues, not a parallel swarm system.

- [ ] **Step 2: Update V1 implementation contract**

Clarify:
- built-in workflow template support
- artifact contracts
- security lane behavior
- what remains intentionally out of scope

- [ ] **Step 3: Update operator/dev docs**

Document:
- how to apply a template
- when isolated workspaces are used by template lanes
- how security and QA differ

## Verification Pass

Run the smallest relevant commands while building each task, then run the full repo verification before hand-off:

- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`

Expected final state:

- shared types compile
- specialist bundles load
- template application creates child issues deterministically
- review surface blocks missing required artifacts
- routing prefers capability/skill matches over plain text heuristics

## Follow-On Plans (Deliberately Deferred)

After this plan lands, consider separate plans for:

- global isolated-workspace-by-default rollout
- explicit `release` role separated from QA
- user-defined/custom workflow templates
- budget-aware concurrency planner for parallel template lanes
