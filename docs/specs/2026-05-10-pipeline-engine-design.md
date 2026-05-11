# Pipeline Engine — Design Spec

**Author:** Lior Franko
**Date:** 2026-05-10
**Status:** Draft

---

## Overview

A deterministic routing plugin for Paperclip that replaces agent-directed orchestration with a YAML-defined state-machine pipeline engine. Agents become pure workers or classifiers — they receive bounded tasks and produce structured output. The engine makes all routing decisions.

## Motivation

Paperclip's engine (sessions, worktrees, state, UI) is solid. But its orchestration model — where agents reason about routing and decide what happens next — introduces non-determinism. Agents creatively skip steps, pick wrong skills, or route to the wrong agent. The more constrained they become, the less the system leverages their strengths.

**Solution:** Keep the engine, replace the orchestration. Agents write code and classify. A deterministic pipeline engine handles everything else.

## Phasing

| Phase | Scope |
|-------|-------|
| **Step 1** | Remove default Paperclip skills from agents. Replace with worker/orchestrator skill sets. |
| **Step 2** | Build the deterministic routing engine (YAML DAG, state machine, dispatcher, output parsing). |
| **Step 3** | Add learning cycle (Retro agent → proposals → human approval → governance updates). |

---

## Architecture

```
Issue created/updated in Paperclip
        │
        ▼
┌─────────────────────────────────┐
│   Pipeline Engine (Plugin)       │
│   - Watches issue events         │
│   - Matches triggers             │
│   - Materializes DAGs            │
│   - Manages state machine        │
│   - Creates sub-issues           │
│   - Reads structured outputs     │
│   - Routes based on DAG rules    │
└─────────┬───────────────────────┘
          │ creates sub-issues + assigns agents
          ▼
┌─────────────────────────────────┐
│   Worker Agents (pure executors) │
│   - Receive issue with spec      │
│   - Minimal skill set            │
│   - Produce structured JSON      │
│   - Post output as comment       │
└─────────────────────────────────┘
          │ structured output comment
          ▼
┌─────────────────────────────────┐
│   Orchestration Agents           │
│   (classifiers)                  │
│   - Receive context to analyze   │
│   - Read-only (no side effects)  │
│   - Output bounded classification│
│   - Engine acts on their output  │
└─────────────────────────────────┘
```

### Integration Model

The pipeline engine is built as a **Paperclip adapter plugin** using the existing plugin SDK (`packages/plugins/`). It hooks into Paperclip via:

1. **Issue event subscription** — watches for trigger labels on new/updated issues
2. **Sub-issue creation** — creates tasks for each DAG stage via Paperclip's API
3. **Agent completion detection** — watches issue status changes, parses final structured comment
4. **State persistence** — pipeline run state in a new DB table or parent issue metadata

### Fork Changes (Minimal — Step 1 only)

The only change to the Paperclip fork: **make "Required by Paperclip" skills disableable per agent from the UI.**

Currently these skills are force-materialized:
- `paperclip` (execution contract — create child issues, route, delegate)
- `paperclip-create-agent` (hire new agents)
- `paperclip-create-plugin` (create plugins)
- `paperclip-dev` (dev workflow)
- `para-memory-files` (memory/learning)

For pipeline-managed agents, these are disabled and replaced with bounded worker/classifier skills.

---

## Core Principles

1. **Claude Code must write the code** — no substitute delivers equivalent quality
2. **State-machine workflow** — agents never decide what happens next
3. **Workers are bounded** — one job each, no routing knowledge
4. **Orchestration = coded rules + bounded classification** — agents classify, engine acts
5. **Spec is interactive and human-reviewed** — before implementation begins
6. **Governance is immutable from inside the factory** — version-controlled, human-modified only
7. **Scenarios are required** — acceptance criteria as executable specifications
8. **Services support worktree isolation** — parallel agent work without conflicts
9. **Tests before code** — test writer runs first
10. **Code writer never sees tests** — enforced by instructions (Phase 1)
11. **Standard structured output for routing** — schema-validated at every stage
12. **Learning cycle feeds into governance** — not into agent behavior (Phase 3)

---

## YAML DAG Format

Pipeline definitions live in YAML files, one per track. Each defines a directed acyclic graph of stages.

### Primitives

| Primitive | Mechanism | Example |
|-----------|-----------|---------|
| Sequential | `depends_on: [prev]` | decompose → implement |
| Conditional | `condition: "expression"` | skip frontend if no frontend component |
| Fan-out | `type: parallel_fan_out` | multiple reviewers in parallel |
| Fan-in | `fan_in: all_complete` | wait for all reviewers |
| Retry loop | `on_failure: { retry_with: ... }` | CI fails → fix → re-validate |
| Goto | `on_failure: { goto: stage_id }` | validation fails → back to implement |
| Checkpoint | `checkpoint: true` | pause materialization, resume with outputs |
| Sub-pipeline | `type: sub-pipeline` | decomposed tasks each run their own pipeline |
| Gate | `type: gate` | engine evaluates condition directly, no agent |
| Skip | `skip_if: "expression"` | skip spec review if spec pre-approved |

### Feature Track

```yaml
name: feature
description: Full feature development — spec → decompose → test → implement → review → validate → merge

trigger:
  label: "pipeline:feature"

stages:
  - id: spec-review
    type: classifier
    agent_role: spec-reviewer
    output_schema: spec-review-output

  - id: decompose
    type: classifier
    agent_role: decomposer
    depends_on: [spec-review]
    condition: "stages.spec_review.output.status == 'approved'"
    output_schema: decomposition-output
    checkpoint: true

  - id: write-tests
    type: sub-pipeline
    pipeline: test-writing
    per_task: true
    ordering: from_output
    depends_on: [decompose]

  - id: implement
    type: sub-pipeline
    pipeline: implementation
    per_task: true
    ordering: from_output
    depends_on: [write-tests]

  - id: validate
    type: worker
    agent_role: validator
    depends_on: [implement]
    fan_in: all_complete
    output_schema: validation-output
    timeout: 15m
    on_failure:
      retry_with:
        goto: implement
        body: "Fix validation failures: {{ output.errors }}"
        max_retries: 3

  - id: review
    type: parallel_fan_out
    depends_on: [validate]
    condition: "stages.validate.output.status == 'pass'"
    stages:
      - id: code-review
        type: classifier
        agent_role: code-reviewer
        output_schema: review-output
      - id: security-review
        type: classifier
        agent_role: security-reviewer
        output_schema: review-output
      - id: architecture-review
        type: classifier
        agent_role: architecture-reviewer
        output_schema: review-output

  - id: review-gate
    type: gate
    depends_on: [review]
    fan_in: all_complete
    condition: "all(s.output.decision == 'approve' for s in stages.review.stages)"
    on_failure:
      retry_with:
        goto: implement
        body: "Address review findings: {{ output.findings }}"
        max_retries: 2

  - id: merge
    type: worker
    agent_role: pr-manager
    depends_on: [review-gate]
    output_schema: merge-output
```

### Bug Track

```yaml
name: bug
description: Bug fix — decompose → fix+test → review → validate → merge

trigger:
  label: "pipeline:bug"

stages:
  - id: decompose
    type: classifier
    agent_role: decomposer
    output_schema: decomposition-output
    checkpoint: true

  - id: write-tests
    type: sub-pipeline
    pipeline: test-writing
    per_task: true
    ordering: from_output
    depends_on: [decompose]

  - id: fix
    type: sub-pipeline
    pipeline: implementation
    per_task: true
    ordering: from_output
    depends_on: [write-tests]

  - id: validate
    type: worker
    agent_role: validator
    depends_on: [fix]
    fan_in: all_complete
    output_schema: validation-output
    on_failure:
      retry_with:
        goto: fix
        body: "Fix still failing: {{ output.errors }}"
        max_retries: 3

  - id: review
    type: classifier
    agent_role: code-reviewer
    depends_on: [validate]
    condition: "stages.validate.output.status == 'pass'"
    output_schema: review-output
    on_failure:
      retry_with:
        goto: fix
        body: "Review findings: {{ output.findings }}"
        max_retries: 2

  - id: merge
    type: worker
    agent_role: pr-manager
    depends_on: [review]
    condition: "stages.review.output.decision == 'approve'"
    output_schema: merge-output
```

### Fast-Track

```yaml
name: fast-track
description: Config/typo/deps changes — implement → CI → merge

trigger:
  label: "pipeline:fast-track"

stages:
  - id: implement
    type: worker
    agent_role: code-writer
    output_schema: implementation-output

  - id: validate
    type: worker
    agent_role: validator
    depends_on: [implement]
    output_schema: validation-output
    on_failure:
      retry_with:
        goto: implement
        body: "CI failed: {{ output.errors }}"
        max_retries: 2

  - id: merge
    type: worker
    agent_role: pr-manager
    depends_on: [validate]
    condition: "stages.validate.output.status == 'pass'"
    output_schema: merge-output
```

---

## Structured Output Schemas

Every agent produces validated JSON output posted as an issue comment. The engine parses this to make routing decisions.

### spec-review-output

```json
{
  "status": "approved | needs_revision | rejected",
  "completeness_score": 0.0-1.0,
  "gaps": ["string"],
  "recommendations": ["string"]
}
```

### decomposition-output

```json
{
  "tasks": [
    {
      "id": "task-0",
      "title": "string",
      "body": "string (task spec for the worker)",
      "track": "feature | bug | fast-track",
      "component": "backend | frontend | infra",
      "dependencies": ["task-id"],
      "estimated_complexity": "small | medium | large"
    }
  ],
  "rationale": "string"
}
```

### implementation-output

```json
{
  "status": "complete | blocked | partial",
  "files_changed": ["string"],
  "branch": "string",
  "summary": "string",
  "blockers": ["string"]
}
```

### validation-output

```json
{
  "status": "pass | fail",
  "test_results": { "passed": 0, "failed": 0, "skipped": 0 },
  "lint_status": "pass | fail",
  "type_check_status": "pass | fail",
  "errors": [
    { "type": "test_failure | lint | type_error", "file": "string", "message": "string" }
  ]
}
```

### review-output

```json
{
  "decision": "approve | request_changes | block",
  "findings": [
    {
      "file": "string",
      "line": 0,
      "category": "security | performance | correctness | style",
      "severity": "low | medium | high | critical",
      "description": "string",
      "suggestion": "string"
    }
  ],
  "summary": "string"
}
```

The router uses `decision` for gating. Per-finding `severity` is informational context passed to the fix stage.

### merge-output

```json
{
  "status": "merged | failed | blocked",
  "pr_url": "string",
  "merge_sha": "string",
  "failure_reason": "string | null"
}
```

### classification-output (generic)

```json
{
  "classification": "string (value from predefined enum)",
  "confidence": 0.0-1.0,
  "reasoning": "string",
  "context": {}
}
```

---

## Agent Roles & Boundaries

| Role | Type | Input | Cannot See | Output |
|------|------|-------|------------|--------|
| Spec Reviewer | Classifier | Spec + governance | Code, tests, pipeline state | spec-review-output |
| Decomposer | Classifier | Spec/bug + codebase | Tests, pipeline state | decomposition-output |
| Test Writer | Worker | Sub-task spec + codebase | Implementation code | Test files on branch |
| Code Writer | Worker | Sub-task spec + codebase | Test files | implementation-output |
| Validator | Worker | Branch + test commands | Pipeline state | validation-output |
| Code Reviewer | Classifier | PR diff + codebase | Pipeline state, other reviews | review-output |
| Security Reviewer | Classifier | PR diff + security rules | Pipeline state | review-output |
| Architecture Reviewer | Classifier | PR diff + arch docs | Pipeline state | review-output |
| PR Manager | Worker | Approved PR reference | Pipeline internals | merge-output |
| Triage | Classifier | Issue body | Codebase (lightweight) | classification-output |

### Boundary Enforcement (Phase 1)

| Mechanism | What it enforces | Strength |
|-----------|-----------------|----------|
| Issue body control | Pipeline state, other outputs, routing knowledge | Strong — info never provided |
| Agent instructions (skill) | Test/code separation, no routing actions | Soft — instruction-based |
| Skill removal | No issue creation, no routing, no delegation | Strong — capabilities removed |

Test/code separation in Phase 1 is **instructions-only** (Option C): agents are instructed not to read test files. Stronger enforcement (branch-based isolation) is a future enhancement.

---

## Pipeline Engine Components

**Location:** `packages/plugins/pipeline-engine/`

### DAG Parser
Reads YAML pipeline definitions. Validates graph structure (no cycles, valid references, schema completeness).

### Trigger Matcher

Subscribes to `issue.created` and `issue.updated` events. On each event:
1. Calls `ctx.issues.get(issueId)` to fetch the full issue (including `labelIds`)
2. Resolves label names via `ctx.issues.listLabels()` (cached per company)
3. Checks if any label matches a registered pipeline trigger (by label `name` string)
4. If match found AND no active pipeline exists for this issue → materialize the DAG
5. If no match → no-op (early return)

Optimization: maintain an in-memory set of active trigger labels per company. Skip the full issue fetch if the event metadata indicates no label change (when available).

### State Machine

Tracks pipeline instance state using a plugin-owned PostgreSQL schema via `ctx.db`.

**Schema:**

```sql
CREATE TABLE pipeline_runs (
  id UUID PRIMARY KEY,
  company_id UUID NOT NULL,
  parent_issue_id UUID NOT NULL,
  pipeline_name TEXT NOT NULL,
  pipeline_version INTEGER NOT NULL,
  pipeline_yaml TEXT NOT NULL,  -- frozen at materialization time
  status TEXT NOT NULL DEFAULT 'running',  -- running | paused | completed | failed | escalated
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE pipeline_stages (
  id UUID PRIMARY KEY,
  pipeline_run_id UUID NOT NULL REFERENCES pipeline_runs(id),
  stage_id TEXT NOT NULL,  -- matches YAML stage id
  sub_issue_id UUID,  -- Paperclip issue created for this stage
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | running | completed | failed | skipped
  retry_count INTEGER DEFAULT 0,
  output JSONB,  -- parsed structured output from agent
  error TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE TABLE sub_pipeline_runs (
  id UUID PRIMARY KEY,
  parent_pipeline_run_id UUID NOT NULL REFERENCES pipeline_runs(id),
  parent_stage_id UUID NOT NULL REFERENCES pipeline_stages(id),
  child_pipeline_run_id UUID NOT NULL REFERENCES pipeline_runs(id),
  task_index INTEGER NOT NULL,
  ordering_position INTEGER NOT NULL
);
```

Pipeline YAML is frozen at materialization time — mid-run changes to YAML files do not affect active runs.

### Dispatcher

Creates sub-issues for stages and assigns agents.

**Agent role resolution:** Plugin configuration (set at install time) contains a role-to-agent mapping:

```json
{
  "role_mapping": {
    "code-writer": "agent-uuid-1",
    "test-writer": "agent-uuid-2",
    "validator": "agent-uuid-3",
    "code-reviewer": "agent-uuid-4",
    "security-reviewer": "agent-uuid-5",
    "architecture-reviewer": "agent-uuid-6",
    "decomposer": "agent-uuid-7",
    "spec-reviewer": "agent-uuid-8",
    "pr-manager": "agent-uuid-9"
  }
}
```

When dispatching a stage with `agent_role: "code-writer"`, the engine looks up the UUID in this mapping. If no mapping exists → pipeline stage fails with `CONFIGURATION_ERROR`, pipeline enters `ESCALATED` state.

Future enhancement: role pools (multiple agents per role) with load balancing.

### Output Parser

**Completion detection:** Subscribes to `issue.comment.created` events. The engine identifies structured output comments by:

1. Comment must be on a tracked sub-issue (looked up via `pipeline_stages.sub_issue_id`)
2. Comment body must contain a fenced JSON block with the sentinel marker:

```
<!-- pipeline-output -->
```json
{ "status": "pass", ... }
```
```

3. The JSON is validated against the stage's expected `output_schema`
4. If valid → stage marked `completed`, output stored in `pipeline_stages.output`
5. If invalid schema → stage marked `failed` with error "malformed output", triggers `on_failure` rules

**Done signal:** The engine does NOT rely on issue status transitions. It relies solely on the sentinel-marked comment. This avoids coupling to Paperclip's status enum and lets agents post intermediate comments without triggering the engine.

### Router

Evaluates DAG conditions and rules against parsed output. Determines next stage(s) to dispatch. Handles retry/goto/escalation logic.

### Expression Language

Conditions use **JSONata** (https://jsonata.org) — a lightweight, safe expression language for JSON queries. It's sandboxed (no I/O), well-documented, and handles nested object traversal naturally.

**Variable namespace available in expressions:**
- `stages` — object keyed by stage ID (hyphen-case), each containing `{ output, status, retry_count }`
- `pipeline` — `{ name, version, parent_issue_id }`
- `env` — `{ company_id }`

**Stage ID normalization:** YAML stage IDs use hyphen-case (`spec-review`). In expressions, access via bracket notation: `stages."spec-review".output.status`.

**Examples:**
```
stages."spec-review".output.status = 'approved'
stages.validate.output.status = 'pass'
$count(stages.review.stages[output.decision != 'approve']) = 0
```

### Retry & Goto Semantics

**Counter scope:** Per stage definition, per pipeline run. Each time a `goto` returns to a stage, the target stage's `retry_count` increments. The counter is on the `pipeline_stages` row.

**On goto:**
1. Target stage's status resets to `pending`, retry_count increments
2. A new sub-issue is created (old one remains closed with its output for audit trail)
3. New sub-issue body includes the failure context from the `body` template
4. All stages downstream of the target are reset to `pending`

**Template language:** `{{ }}` interpolation uses Handlebars-style access to the current stage's output: `{{ output.errors }}`, `{{ output.findings }}`.

**When max_retries exhausted:**
- Pipeline transitions to `ESCALATED` state
- A comment is posted on the parent issue: "Pipeline escalated: stage X failed after N retries"
- No further stages execute until manual intervention

**Manual intervention for escalated pipelines:**
- Human adds label `pipeline:resume` to parent issue → engine retries the failed stage (counter reset)
- Human adds label `pipeline:skip` → engine marks stage as skipped, proceeds to next
- Human adds label `pipeline:cancel` → engine marks pipeline as failed, no further action

### Checkpoint Semantics

A checkpoint stage pauses DAG materialization after its output is available:
1. The checkpoint stage runs normally (agent executes, produces output)
2. After output is parsed, the engine does NOT immediately dispatch downstream stages
3. Instead, it evaluates the output to determine what downstream stages to create (e.g., decomposer output determines how many sub-pipelines)
4. This is automatic — no human signal needed. "Pause" means the engine pauses to dynamically plan the next materialization step, not that it waits for external input.

If human approval is needed at a stage, that's modeled as a separate `gate` type stage with `requires_approval: true` (future enhancement).

### Gate Type

The `gate` type is a **non-agent evaluation stage**. It runs no agent — the engine itself evaluates the condition expression. If the condition passes, downstream stages proceed. If it fails, `on_failure` rules apply.

Gates are used for fan-in decisions: "did all reviewers approve?" without spinning up an agent to answer that question.

### Pipeline Instance Lifecycle

```
TRIGGERED → MATERIALIZING → RUNNING → [CHECKPOINT → MATERIALIZING] → RUNNING → COMPLETED | FAILED | ESCALATED
```

---

## Decomposition & Sub-Pipelines

When a Decomposer outputs multiple tasks, the engine creates **sub-pipeline instances** — one per task.

- Each sub-task becomes its own pipeline run (using the track specified in decomposition output)
- Dependencies between tasks are respected (sequential ordering from `dependencies` field)
- Parent pipeline's fan-in waits for all sub-pipelines to complete
- Sub-pipeline failure triggers parent's `on_failure` rules

### Decomposer Output → Sub-Pipelines

```
Decomposer outputs:
  task-0: "Add validation" (no deps)
  task-1: "Update API" (depends on task-0)
  task-2: "Add frontend form" (no deps)

Engine creates:
  sub-pipeline-0: task-0 (implementation track) — starts immediately
  sub-pipeline-1: task-1 (implementation track) — waits for sub-pipeline-0
  sub-pipeline-2: task-2 (implementation track) — starts immediately (parallel with 0)
```

### Sub-Pipeline Input

Each sub-pipeline's root stage receives an issue body containing:
- The task's `body` field from the decomposition output (the task spec)
- A reference to the parent issue (for codebase context)
- Governance file references relevant to the task's `component`

The sub-pipeline does NOT receive: other tasks' specs, the parent pipeline's state, or other agents' outputs.

### Sub-Pipeline Definitions

Referenced sub-pipelines (`test-writing`, `implementation`) are minimal single-stage pipelines:

**test-writing pipeline:**
```yaml
name: test-writing
description: Write tests for a single task from spec

stages:
  - id: write-tests
    type: worker
    agent_role: test-writer
    output_schema: implementation-output
```

**implementation pipeline:**
```yaml
name: implementation
description: Implement a single task from spec

stages:
  - id: implement
    type: worker
    agent_role: code-writer
    output_schema: implementation-output
```

These are intentionally trivial — a single worker stage. They exist as pipelines (rather than inline stages) so that future enhancement can add per-task validation, review, or retry logic without changing the parent DAG.

### Worktree Isolation for Parallel Sub-Pipelines

Parallel sub-pipelines receive separate worktrees (Paperclip's existing worktree system). Each sub-pipeline's worker operates in its own worktree, creating its own branch.

### Branch Merge Strategy

After fan-in (all sub-pipelines complete), the engine merges branches before dispatching the Validator:

1. Engine creates a merge branch: `pipeline/<run-id>/merged`
2. Branches are merged sequentially in dependency order (tasks with no deps first, then dependents)
3. Merge strategy: **merge commit** (preserves individual task history)
4. If a merge conflict occurs:
   - Engine marks the conflicting stage as `failed` with error type `merge_conflict`
   - Triggers `on_failure` rules (typically: retry the conflicting task's implementation with conflict context)
   - Conflict diff is included in the retry body template
5. Once all branches merge cleanly → Validator receives the merged branch and runs tests/lint/types against it

The Validator does NOT perform the merge — it receives a pre-merged branch. The engine handles merge mechanics.

---

## Phase 3: Learning Cycle (Future)

After pipeline completion, a **Retro agent** analyzes the run and produces structured proposals:

- **Governance updates** — new rules, modified standards
- **Scenario additions** — missing acceptance criteria
- **Pipeline tweaks** — DAG changes
- **Institutional memory** — recurring patterns

Proposals are written as draft PRs or suggestion files. A human reviews and approves/rejects. Nothing self-applies. Approved proposals merge into governance files, scenarios, or pipeline YAMLs.

Inspired by Hermes' self-learning cycle but with a mandatory human approval gate.

---

## Triage & Pipeline Assignment

The Triage agent classifies incoming issues to determine which pipeline track applies. It runs as a **pre-pipeline step**, not within any track's DAG.

**Flow:**
1. Issue created without a pipeline label
2. Engine detects issue has no pipeline label but matches a "triage-eligible" criterion (e.g., specific project, board, or label like `needs-triage`)
3. Engine creates a sub-issue assigned to the Triage agent
4. Triage agent reads the issue body, outputs a `classification-output` with `classification: "feature" | "bug" | "fast-track"`
5. Engine applies the corresponding pipeline label (`pipeline:feature`, `pipeline:bug`, `pipeline:fast-track`) to the original issue
6. Trigger matcher fires on the label → pipeline materializes

This makes Triage optional — issues can be manually labeled to skip classification.

---

## Multi-Tenant Isolation

Pipeline definitions are **per-company**. Each company can have its own set of pipeline YAMLs and role mappings configured in the plugin instance settings for that company.

Pipeline state tables include `company_id` and all queries are scoped.

---

## Resolved Design Decisions

| Decision | Resolution |
|----------|-----------|
| State storage | Plugin-owned PostgreSQL schema via `ctx.db` (see schema above) |
| Agent role assignment | Config-driven role→agentId mapping in plugin settings |
| Pipeline versioning | YAML frozen at materialization time — mid-run changes don't affect active runs |
| Timeout handling | Per-stage `timeout` field in YAML (default: 30 min if omitted). On timeout → stage fails → triggers `on_failure` rules |
| Manual intervention | Label-based: `pipeline:resume`, `pipeline:skip`, `pipeline:cancel` on parent issue |
| Expression language | JSONata — sandboxed, no I/O, native JSON traversal |
| Template language | Handlebars-style `{{ }}` interpolation for retry body templates |
| Schema validation failure | Treated as stage failure → triggers `on_failure` rules |

---

## Future Phases

### Phase 4: Scenario Enforcement

Scenarios (acceptance criteria as executable specifications) must exist before any pipeline materializes.

**Phase 4a — Instruction-based (immediate):**

The CEO agent's AGENTS.md includes a pre-pipeline gate: "A scenario file (`scenarios/*.yaml`) MUST exist before work begins. If the human created the issue without a scenario, comment asking for one and set status to `blocked`."

This is soft enforcement — the agent follows the instruction but nothing structurally prevents bypass.

**Phase 4b — Engine-enforced via project definition (future):**

Scenarios move from repo files to the **project definition** (Paperclip's project-level configuration). Each project defines its scenario requirements as structured data the engine can query at runtime.

1. Before materializing any pipeline, engine checks the project definition for a matching scenario (by issue type, feature area, or explicit link)
2. If no scenario exists → engine does not materialize, posts a comment on the issue requesting scenarios, sets status to `blocked`
3. When a scenario is added to the project definition → engine re-evaluates trigger

Benefits over repo-based scenarios:
- Centrally managed per project, not scattered across repos
- Engine has direct access without cloning/reading the repo
- Naturally multi-tenant (each company's project definition holds its own requirements)
- Scenarios can reference multiple repos (cross-cutting features)

### Phase 5: Governance via Project Definition

Governance (engineering standards, quality gates, rules) moves from repo-level `governance/` files to the **project definition**. This makes governance a first-class engine concept rather than a convention agents follow.

**Phase 5a — Project-definition governance (future):**

Each project definition contains structured governance sections:
- Engineering standards (per component type: backend, frontend, infra)
- Quality gates (thresholds, required checks)
- Agent constraints (per-role rules)

The dispatcher injects the relevant governance sections into each sub-issue body based on the task's `component` field. Agents receive governance as part of their task context — no file-system lookup needed.

Benefits:
- Engine controls what governance each agent sees (information boundary enforcement)
- Governance updates take effect immediately for new pipeline runs (no commit/deploy cycle)
- Version history lives in the project definition's audit log
- Multi-repo projects share governance without duplication

**Phase 5b — Validator governance checks (future):**

The Validator stage gains a governance compliance check:
1. Validator receives the applicable governance sections from the project definition alongside the branch
2. A dedicated check (linter rule, custom script, or LLM-based classifier) verifies the implementation doesn't violate governance rules
3. Governance violations appear in `validation-output.errors` with type `governance_violation`
4. Treated like any other validation failure — triggers `on_failure` retry loop

**Immutability guarantee:** Governance in the project definition can only be modified by humans with project-admin permissions. The pipeline engine and agents have read-only access. This preserves Principle #6 (governance is immutable from inside the factory).

### Phase 6: Structural Test/Code Separation

Phase 1 uses instruction-based separation (Code Writer is told not to read test files). Future phases enforce this structurally.

**Phase 6a — Branch-based isolation (future):**

- Test Writer works on branch `pipeline/<run-id>/tests/<task-id>`
- Code Writer works on branch `pipeline/<run-id>/impl/<task-id>`
- Code Writer's worktree is checked out from a base that does NOT contain the test branch's commits
- Tests are merged into the implementation branch only at the Validator stage (engine handles the merge)

This makes it structurally impossible for the Code Writer to see test files — they don't exist in its worktree.

**Phase 6b — File-system filtering (alternative future):**

If branch-based isolation is too complex:
- Code Writer's worktree uses a sparse checkout that excludes test directories
- Or: a pre-execution hook strips test files from the worktree before the agent wakes

---

## Integration Testing — Internal Developer Portal

The pipeline engine is validated end-to-end using the **Internal Developer Portal** company (`dream-applied-ai/internal-developer-portal`). This is a real project where real agents write real code, orchestrated by deterministic pipelines.

### Repository Structure

```
internal-developer-portal/
├── .paperclip/
│   ├── paperclip.yaml           # Workspace config (company, agents)
│   ├── pipelines/
│   │   ├── feature.yaml         # Full pipeline: spec-review → decompose → tests → implement → validate → review
│   │   ├── bug.yaml             # Shorter: tests → implement → validate → review
│   │   └── fast-track.yaml      # Minimal: implement → validate
│   ├── governance/              # Agent rules and standards (SACRED — immutable)
│   └── scenarios/               # Holdout validation scenarios (19 scenarios)
├── services/
│   ├── backend/                 # FastAPI (Python 3.12+, uv, pytest)
│   └── frontend/               # Next.js 15 App Router (React 19, TypeScript, Vitest)
├── docs/specs/                  # Design specs (required before coding)
└── CLAUDE.md
```

### Agent Roles

| Agent | Role Type | Pipeline Function |
|-------|-----------|-------------------|
| `spec-reviewer` | classifier | Validates design specs for completeness |
| `decomposer` | classifier | Breaks features into ordered tasks |
| `test-writer` | worker | Writes failing tests (red phase TDD) |
| `implementer` | worker | Writes code to make tests pass |
| `validator` | qa | Runs test suite + type checks |
| `reviewer` | classifier | Code quality review |

### Test Scenarios

The first integration test uses **scenario 001 (shell layout navigation)** — a full feature requiring sidebar, routing, breadcrumbs, theme tokens, and 9 pages across both backend and frontend.

| Test | Trigger | Pipeline | What It Validates |
|------|---------|----------|-------------------|
| 1 | `pipeline:feature` on shell layout issue | `feature.yaml` | Full happy path end-to-end |
| 2 | `pipeline:feature` with intentionally broken spec | `feature.yaml` | Spec-review rejection halts pipeline |
| 3 | `pipeline:feature` with failing implementation | `feature.yaml` | Retry/goto loop from validator back to implementer |
| 4 | `pipeline:bug` on a known bug | `bug.yaml` | Shorter pipeline, skips spec-review/decompose |
| 5 | `pipeline:fast-track` on config change | `fast-track.yaml` | Minimal pipeline |

### Running Integration Tests

1. Start local Paperclip (`pnpm dev` in paperclip repo)
2. Ensure pipeline-engine plugin is loaded from `~/.paperclip/plugins/` or dev-linked
3. Open the Internal Developer Portal workspace in the UI
4. Create an issue with the trigger label
5. Observe: pipeline materializes, sub-issues created, agents execute, state transitions
6. Verify: structured outputs parsed, routing decisions correct, final state matches expectations

---

## Remaining Open Questions

1. **Concurrent pipeline limits** — maximum parallel pipelines per company to prevent resource exhaustion?
2. **Observability** — what metrics/logs does the engine emit for debugging stuck pipelines?
