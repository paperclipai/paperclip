# Workflow Templates & SOP Enforcement

**Date:** 2026-04-18
**Status:** Draft — MVP
**Author:** Board + Copilot

## Problem

Agent SOPs defined in `AGENTS.md` are advisory — the LLM can and does skip steps under context pressure. There is no runtime-enforced mechanism to guarantee a multi-step process (e.g. "research → create package → get approval → inject package") executes in order without skipping.

The board currently has to manually create structured issue trees with blocker dependencies to enforce ordering. This is tedious and error-prone for repeated processes.

## Solution

Introduce **workflow templates** — reusable DAG definitions that can be instantiated into runtime-enforced issue trees. Templates define structure and prompts only; metadata (assignee, priority, project) is provided at invoke time or falls back to defaults.

### Key Properties

- **Template = structure + prompts.** No assignee, reviewer, approver, or priority in the template itself.
- **Instance = plain issues.** Invoking a template creates normal issues with `blockedByIssueIds` wiring. No separate instance entity — the issue tree *is* the instance. The server enforces ordering — agents cannot skip steps.
- **Parallel branches supported.** Nodes with no mutual blockers run concurrently.
- **All-or-nothing creation.** If any issue in the tree fails to create, the entire invocation rolls back.
- **Unassigned nodes surface to board.** Fixes the current gap where unassigned blocked issues become dead ends when their blockers resolve. Assigned to `board` (user context) rather than a specific agent — the CEO can use a heartbeat routine to triage and re-assign.

## Architecture

### Data Model

```
workflow_templates
├── id (uuid pk)
├── companyId (fk companies)
├── name (text, not null)
├── description (text, nullable)
├── nodes (jsonb) ← WorkflowTemplateNode[]
├── createdByUserId (text, nullable)
├── createdByAgentId (uuid, fk agents, nullable)
├── createdAt
└── updatedAt
```

One table. Invoking a template creates normal issues — no `workflow_instances` table, no `workflowTemplateId` on issues. The issues stand on their own. Linkage between template and spawned issues can be added later if needed.

### Node Schema

```ts
interface WorkflowTemplateNode {
  tempId: string;                       // e.g. "$node-1"
  title: string;                        // issue title template
  description?: string;                 // prompt/instructions for the assignee
  blockedByTempIds: string[];           // references to other tempIds (defines ordering)
  parentTempId?: string;                // structural parent in tree
  executionPolicy?: IssueExecutionPolicy; // optional review/approval gates
}
```

### Example: Hiring SOP Template

```json
{
  "name": "Agent Hiring SOP",
  "description": "Standard process for hiring a new agent with research, package creation, and board approval.",
  "nodes": [
    {
      "tempId": "$review",
      "title": "Review hire request and clarify with board",
      "description": "Read the parent issue context. If the request is unclear, comment asking for clarification and set status to blocked. Otherwise, confirm scope and continue.",
      "blockedByTempIds": [],
      "parentTempId": "$root"
    },
    {
      "tempId": "$research",
      "title": "Research best practices for {{agent_type}}",
      "description": "Research on the internet for best practices, design patterns, and specifications relevant to this agent's domain. Produce a research document with sources.",
      "blockedByTempIds": ["$review"],
      "parentTempId": "$root"
    },
    {
      "tempId": "$package",
      "title": "Create agent package (SOUL.md, AGENTS.md, HEARTBEAT.md)",
      "description": "Using the research from the previous step, prepare the full agent instruction package. Include SOUL.md, AGENTS.md, HEARTBEAT.md, and any relevant checklists.",
      "blockedByTempIds": ["$research"],
      "parentTempId": "$root"
    },
    {
      "tempId": "$approval",
      "title": "Request board approval for hire",
      "description": "Submit the agent package for board approval. Include a summary of the research basis and the agent's intended capabilities.",
      "blockedByTempIds": ["$package"],
      "parentTempId": "$root",
      "executionPolicy": {
        "stages": [{ "type": "approval", "participants": [{ "type": "user" }] }]
      }
    },
    {
      "tempId": "$inject",
      "title": "Inject agent pack into newly hired agent",
      "description": "Apply the approved agent package to the new agent's instruction folder. Verify the agent can wake and follow its AGENTS.md.",
      "blockedByTempIds": ["$approval"],
      "parentTempId": "$root"
    },
    {
      "tempId": "$root",
      "title": "Hire agent: {{description}}",
      "description": "Parent tracking issue for the full hiring workflow.",
      "blockedByTempIds": ["$inject"]
    }
  ]
}
```

### Invoke Payload

```ts
interface WorkflowInvokeInput {
  context?: string;                 // high-level description injected into all node descriptions
  defaultAssigneeAgentId?: string;  // fallback assignee for nodes without overrides (recommended: CEO)
  nodeOverrides?: Record<string, {
    assigneeAgentId?: string;
    assigneeUserId?: string;
    priority?: string;
    projectId?: string;
    goalId?: string;
    billingCode?: string;
    executionPolicy?: IssueExecutionPolicy;
    // any createIssueSchema field except title/description/blockedByIssueIds/parentId
  }>;
  goalId?: string;                  // applied to all nodes unless overridden
  projectId?: string;               // applied to all nodes unless overridden
}
```

### Invoke Response

The invoke endpoint returns a flat summary for the UI to display the created tree. No persisted instance entity — this is a one-time response.

```ts
interface WorkflowInvokeResponse {
  rootIssueId: string;                          // the root of the created tree
  createdIssues: {
    tempId: string;                             // original node tempId
    issueId: string;                            // real issue ID
    title: string;
    status: "todo" | "blocked";
    assigneeAgentId: string | null;
  }[];
}
```

The UI uses this to render a confirmation view with links to the created issues. After that, the issues are navigated to individually — no persistent workflow instance view.

### Invoke Algorithm

1. Load template, validate node graph (DAG — no cycles)
2. Begin database transaction
3. **Create all issues** with title + description only (no blockers, no parentId yet). Collect `tempId → realIssueId` mapping
4. **Wire relations** — for each node, resolve `blockedByTempIds` and `parentTempId` to real IDs, update each issue with `blockedByIssueIds` and `parentId`
5. **Set statuses** — nodes with zero blockers → `todo`, nodes with blockers → `blocked`
6. **Apply overrides** — merge `nodeOverrides` per node, apply `defaultAssigneeAgentId` where no assignee set
7. Commit transaction (any failure → full rollback)
8. Fire assignment wakeups for unblocked `todo` nodes that have assignees

### Blocked-Node Wakeup Suppression

**Problem:** When an agent is assigned to a `blocked` issue, `queueIssueAssignmentWakeup` fires. The agent wakes, sees the issue is blocked, and exits — there is nothing to do until blockers resolve. This is pure token burn with no useful work.

**Root cause:** `queueIssueAssignmentWakeup` ([issue-assignment-wakeup.ts](server/src/services/issue-assignment-wakeup.ts#L33)) only guards on `!assigneeAgentId || status === "backlog"`. It doesn't suppress wakeups for `blocked` issues.

**Historical findings (git + GitHub):**
- `backlog` suppression is explicitly intentional. PR `#159` / issue `#96` introduced the guard so issues that are "not ready to work on yet" do not wake agents on create or assign.
- Waking when an issue becomes actionable is also explicit. PR `#267` / issue `#167` added the separate wake path for `backlog -> todo` transitions when the assignee does not change.
- `queueIssueAssignmentWakeup` itself was introduced later in commit `2d8c8abb` (`Fix routine assignment wakeups`) by extracting the existing route logic into a shared helper. The backlog-only guard was copied forward as-is; the commit message does not discuss `blocked` semantics.
- The agent heartbeat protocol includes `blocked` issues in the inbox and tells agents to skip them unless they can unblock them. That supports blocked visibility while already awake, but it does not establish assignment-triggered wakeups for blocked issues as a deliberate product rule.

**Conclusion:** The repository clearly encodes backlog semantics, but it does not show the same level of explicit intent for waking agents immediately on assignment to `blocked` issues. Treating `blocked` suppression as a clarification of wake semantics is lower-risk than treating the current behavior as a protected feature.

**Fix — one line:** Add `"blocked"` to the existing guard:

```ts
// Before
if (!input.issue.assigneeAgentId || input.issue.status === "backlog") return;

// After
if (!input.issue.assigneeAgentId || input.issue.status === "backlog" || input.issue.status === "blocked") return;
```

**Why this is safe:**
- Blocked nodes don't need to wake — there's nothing to do until blockers resolve.
- When blockers resolve, `listWakeableBlockedDependents` fires `reason: "issue_blockers_resolved"` through the update route's separate wake path (not through `queueIssueAssignmentWakeup`). So the agent still wakes at exactly the right moment.
- Manually unblocking (PATCH status → `todo`) fires `reason: "issue_status_changed"` through a separate code path — also unaffected.

**Compatibility considerations:**
- This does not remove blocked issues from the agent inbox, checkout eligibility, or any manual operator workflow.
- It only suppresses the assignment-triggered wake for issues that are still `blocked`.
- Blocked work still wakes through two explicit actionable paths: `issue_blockers_resolved` when dependencies clear, and `issue_status_changed` when someone moves `blocked -> todo`.
- If Paperclip later wants agents to proactively inspect blocked issues on assignment, that should be introduced as an explicit feature with its own wake reason or triage policy, not left as a side-effect of the backlog-only guard.

### Invocation Patterns

The `WorkflowInvokeInput` supports three usage patterns without any special triage machinery:

#### Pattern 1: Explicit assignment (board knows who does what)

Use `nodeOverrides` to assign a specific agent per node. No `defaultAssigneeAgentId`.

```json
{
  "nodeOverrides": {
    "$review": { "assigneeAgentId": "<ceo-id>" },
    "$research": { "assigneeAgentId": "<researcher-id>" },
    "$package": { "assigneeAgentId": "<engineer-id>" }
  }
}
```

**Wakeup behavior:** Only `todo` (unblocked) nodes with an assignee fire wakeups. Blocked nodes are silent (suppressed by the guard above). Each agent wakes exactly when their node unblocks. Zero unnecessary runs.

#### Pattern 2: Delegate to triage agent

Set `defaultAssigneeAgentId` to the triage agent. No `nodeOverrides`.

```json
{
  "defaultAssigneeAgentId": "<triage-agent-id>"
}
```

**Wakeup behavior:** All `todo` leaf nodes fire wakeups for the triage agent. Each wakeup produces a short, focused run: wake → read the one issue → reassign to the right specialist → exit. The heartbeat dedup layer defers concurrent wakeups so they run sequentially.

**Why per-issue triage runs are preferable to a single tree-traversal run:**
- Each run is scoped to one issue — no context compression risk, even for large trees.
- A lighter/cheaper model can handle the mechanical triage task (read issue → pick agent → reassign).
- This is identical cost to triaging any single issue outside of workflows — not "wasted" work.
- Avoids forcing the triage agent to load the entire tree into one context window.

When the triage agent reassigns a `todo` leaf to a specialist, the PATCH (assignee change) fires `queueIssueAssignmentWakeup` for the new assignee — works because the issue is still `todo`. The specialist wakes immediately.

#### Pattern 3: Mix (partial assignment + triage fallback)

Use `nodeOverrides` for nodes where the assignee is known, `defaultAssigneeAgentId` for the rest.

```json
{
  "defaultAssigneeAgentId": "<triage-agent-id>",
  "nodeOverrides": {
    "$approval": { "assigneeAgentId": "<ceo-id>" },
    "$research": { "assigneeAgentId": "<researcher-id>" }
  }
}
```

**Resolution order:** Invoke algorithm step 6 applies `nodeOverrides` first, then fills remaining unassigned nodes with `defaultAssigneeAgentId`. Nodes with explicit overrides go directly to that agent when they unblock; the rest route through the triage agent.

### Wake Chain Flow (all patterns)

1. Invoke creates tree → leaves `todo`, interior nodes `blocked`
2. `todo` nodes with assignees fire wakeups (blocked nodes suppressed)
3. Agents complete leaf work → status `done`
4. `listWakeableBlockedDependents` fires `reason: "issue_blockers_resolved"` for newly-unblocked dependents
5. Repeat until tree completes
6. `getWakeableParentAfterChildCompletion` fires when all children of a parent are terminal

### Cycle Detection

Validate at **template save time** (not just invoke time) using topological sort on the `blockedByTempIds` graph. Reject templates with cycles. Re-validate at invoke time as a safety net.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/companies/:companyId/workflow-templates` | List templates |
| `POST` | `/companies/:companyId/workflow-templates` | Create template |
| `GET` | `/workflow-templates/:id` | Get template |
| `PATCH` | `/workflow-templates/:id` | Update template |
| `DELETE` | `/workflow-templates/:id` | Delete template |
| `POST` | `/workflow-templates/:id/invoke` | Instantiate workflow → creates issue tree |

### Access Control

Same as issues. `assertCompanyAccess(req, companyId)` on all routes. Both board and agent actors can CRUD templates and invoke — if an actor can create issues, they can create workflow templates. No additional permission gates for MVP.

### Delete Behavior

Deleting a template nulls out `workflowTemplateId` on any routines that reference it (cascade set-null). Already-instantiated issue trees are unaffected — they are plain issues and stand on their own.

### Activity Actions

Follows the `domain.verb` convention used by routines and issues:

| Action | Trigger |
|--------|---------|
| `workflow_template.created` | POST create |
| `workflow_template.updated` | PATCH update |
| `workflow_template.deleted` | DELETE |
| `workflow_template.invoked` | POST invoke |

Logged in the **route layer** via `getActorInfo(req)` + `logActivity(db, ...)`, not in the service.

## Fix: Unassigned Wake Gap

**Current behavior:** `listWakeableBlockedDependents` and `getWakeableParentAfterChildCompletion` silently drop issues with no `assigneeAgentId`. Unassigned nodes in a workflow tree become dead ends.

**Fix:** When a dependent/parent issue has no assignee and all blockers are resolved, mark the issue as `todo` (unblocked) but leave it unassigned. Log a `system.issue_unblocked_unassigned` activity entry so it appears in the activity feed. The board sees it immediately; the CEO agent can pick it up via a heartbeat routine that triages unassigned `todo` issues.

**Why not auto-assign to CEO?** Hard-coding a specific agent role is inflexible — companies may want a different triage agent, or may prefer manual board triage. Surfacing the issue to the board and letting a routine handle assignment keeps the core generic.

**Scope:** This fix applies globally (not just workflow issues) since the behavior is correct in all cases — an unassigned unblocked issue should surface to someone.

**Files changed:**
- `server/src/services/issues.ts` — `listWakeableBlockedDependents`, `getWakeableParentAfterChildCompletion`
- Activity log entry for unblocked-unassigned state

## Routine–Workflow Integration

Routines should be able to invoke a workflow template on each trigger, creating a fresh issue tree per run instead of a single flat issue.

### Schema Change

Add to `routines` table:

| Column | Type | Description |
|--------|------|-------------|
| `workflow_template_id` | `uuid` (nullable, fk `workflow_templates`) | If set, each routine run invokes this template instead of creating a single issue |
| `workflow_invoke_input` | `jsonb` (nullable) | Persisted `WorkflowInvokeInput` (context, default assignee, node overrides, etc.) |

### Behavior

- When a routine fires and `workflowTemplateId` is set, the run calls the workflow invoke service instead of `issueService.create`.
- The `context` field in `workflowInvokeInput` supports routine variable interpolation (`{{variableName}}`), same as the existing routine description template.
- The root issue of the created tree becomes the routine run's `linkedIssueId`.
- All existing routine semantics apply: concurrency policy checks against the root issue, coalescing detects live root issues, catch-up policy works normally.
- If the referenced template is deleted, the FK `onDelete: "set null"` nulls `workflowTemplateId` on the routine. The next run falls back to the normal single-issue creation path.

### UI Changes

- Routine create/edit form gains an optional "Workflow Template" picker.
- When a template is selected, show a preview of the template nodes and allow editing the `workflowInvokeInput` (context, default assignee, per-node overrides).
- The existing single-issue description field is hidden when a workflow template is selected.

### Example: Weekly Security Audit Routine

```json
{
  "title": "Weekly security audit",
  "workflowTemplateId": "<security-audit-template-id>",
  "workflowInvokeInput": {
    "context": "Weekly automated security audit for week of {{run_date}}",
    "defaultAssigneeAgentId": "<security-agent-id>",
    "projectId": "<security-project-id>"
  }
}
```

### Files Changed

- `packages/db/src/schema/routines.ts` — add `workflowTemplateId`, `workflowInvokeInput` columns
- `packages/shared/src/types/routine.ts` — add fields to `Routine`, `CreateRoutine`, `UpdateRoutine`
- `packages/shared/src/validators/routine.ts` — add validation for new fields
- `server/src/services/routines.ts` — branch run logic: single-issue vs workflow invoke
- `ui/` — routine form updates for template picker + invoke input editor

## UI Pages

### Workflow Templates List (`/workflows`)
- Table of all templates for the company
- Columns: name, description, node count, created date
- Actions: create new, edit, delete, invoke

### Workflow Template Designer (`/workflows/new`, `/workflows/:id/edit`)
- Node-based editor for defining the DAG
- Each node: title + description (prompt) fields only
- Visual tree/DAG representation with dependency arrows
- Drag to connect nodes (creates `blockedByTempIds` edges)
- Optional: execution policy toggle per node (add review/approval stage)
- No assignee/priority/metadata fields — structure and prompts only

### Workflow Invoke Dialog
- Triggered from templates list or template detail
- Shows all nodes with their titles in tree order
- Global fields: context (text), default assignee, goal, project
- Per-node optional overrides: assignee, priority, etc.
- Submit → calls invoke endpoint → shows created issue tree with links

## Implementation Phases

### Phase 1: Schema & Types
- `packages/db/src/schema/workflow_templates.ts` — create table (follow `routines.ts` column conventions)
- `packages/db/src/schema/index.ts` — export new table
- `packages/shared/src/types/workflow-template.ts` — `WorkflowTemplate`, `WorkflowTemplateListItem`, `WorkflowTemplateDetail`, `WorkflowInvokeResponse`
- `packages/shared/src/types/index.ts` — re-export all types
- `packages/shared/src/validators/workflow-template.ts` — `createWorkflowTemplateSchema`, `updateWorkflowTemplateSchema` (`.partial()`), `workflowInvokeInputSchema`; export inferred types
- `packages/shared/src/validators/index.ts` — re-export schemas + types
- `packages/shared/src/constants.ts` — no new constants needed for MVP (node schema is freeform JSONB)
- `packages/shared/src/index.ts` — re-export all new types, validators from root barrel
- `pnpm db:generate` — migration

### Phase 2: Service & Invoke Logic
- `server/src/services/workflow-templates.ts` — constructor function pattern: `workflowTemplateService(db: Db)` returns object literal with `{ list, get, create, update, remove, invoke }`. Inject `issueService(db)` for invoke. Use `db.transaction()` for invoke atomicity. No activity logging in service — routes handle that.
- `server/src/services/index.ts` — `export { workflowTemplateService } from "./workflow-templates.js"`

### Phase 3: API Routes
- `server/src/routes/workflow-templates.ts` — factory `workflowTemplateRoutes(db: Db)` returns `Router`. Apply `assertCompanyAccess` + `validate()` middleware per route. Log `workflow_template.*` activity actions via `getActorInfo(req)` + `logActivity()` after each mutation.
- `server/src/routes/index.ts` — `export { workflowTemplateRoutes } from "./workflow-templates.js"`
- Wire in `server/src/app.ts` (or wherever routes are mounted) same as other route modules

### Phase 4: Wakeup & Wake-Chain Fixes
- `server/src/services/issue-assignment-wakeup.ts` — add `blocked` status guard (one line)
- `server/src/services/issues.ts` — fix both wake functions to unblock without requiring an assignee
- Activity log for `system.issue_unblocked_unassigned`

### Phase 4b: Routine–Workflow Integration
- `packages/db/src/schema/routines.ts` — add `workflowTemplateId` (uuid, nullable, FK → `workflow_templates`, `onDelete: "set null"`), `workflowInvokeInput` (jsonb, nullable)
- `packages/shared/src/types/routine.ts` — add `workflowTemplateId`, `workflowInvokeInput` to `Routine`, `CreateRoutine`, `UpdateRoutine`
- `packages/shared/src/validators/routine.ts` — add optional fields referencing `workflowInvokeInputSchema`
- `server/src/services/routines.ts` — branch run logic: if `workflowTemplateId` set, call `workflowTemplateService.invoke()` instead of `issueService.create()`
- `pnpm db:generate` — migration

### Phase 5: UI
- `ui/src/api/workflow-templates.ts` — `workflowTemplatesApi` object: `{ list, get, create, update, remove, invoke }` (follow `routinesApi` pattern)
- `ui/src/lib/queryKeys.ts` — add `workflowTemplates: { list, detail }` factory
- `ui/src/App.tsx` — register `/workflows`, `/workflows/new`, `/workflows/:id`, `/workflows/:id/edit` routes
- `ui/src/components/Sidebar.tsx` — add "Workflows" nav item
- `ui/src/context/LiveUpdatesProvider.tsx` — invalidate `workflowTemplates` query keys on relevant live events
- Workflow templates list page
- Workflow template designer
- Workflow invoke dialog

### Phase 6: Verification
- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`
- Manual test: create template → invoke → verify issue tree + blocker chain + wake chain

## File Change Summary

| Layer | Files | Action |
|-------|-------|--------|
| `packages/db/src/schema/` | `workflow_templates.ts`, `index.ts`, `routines.ts` | Create + update |
| `packages/shared/src/types/` | `workflow-template.ts`, `routine.ts`, `index.ts` | Create + update |
| `packages/shared/src/validators/` | `workflow-template.ts`, `routine.ts`, `index.ts` | Create + update |
| `packages/shared/src/` | `index.ts` | Update (re-export new types + validators) |
| `server/src/services/` | `workflow-templates.ts`, `index.ts`, `issues.ts`, `routines.ts`, `issue-assignment-wakeup.ts` | Create + update |
| `server/src/routes/` | `workflow-templates.ts`, `index.ts` | Create + update |
| `ui/src/api/` | `workflow-templates.ts` | Create |
| `ui/src/lib/` | `queryKeys.ts` | Update |
| `ui/src/` | `App.tsx`, `components/Sidebar.tsx`, `context/LiveUpdatesProvider.tsx` | Update |
| `ui/src/pages/` | Workflow list, designer, invoke pages | Create |
| Migration | Auto-generated by `pnpm db:generate` | Create |

## Risks

| Risk | Mitigation |
|------|------------|
| Bulk creation performance at scale | Single transaction + batch insert; typical SOP is 3–10 nodes |
| Partial failure in invoke | Single transaction — all or nothing rollback |
| Unassigned unblocked issues may go unnoticed | Activity log + board visibility; CEO heartbeat routine can auto-triage |
| Routine-linked workflow template deleted | FK `onDelete: "set null"` nulls `workflowTemplateId` on affected routines; next run creates a flat issue (falls back to non-workflow path) |
| Workflow invoke in routine tick adds latency | Acceptable — workflow trees are typically 3–10 nodes; single transaction |
| Assigning blocked nodes triggers unnecessary agent runs | Suppressed by `blocked` guard in `queueIssueAssignmentWakeup`; wake chain handles deferred wake correctly |
| Some existing flows may rely on blocked-assignment wake side effects | Git history shows explicit intent for `backlog`, but not for `blocked`; blocked issues remain visible in inbox and still wake on unblock/status-change paths |
| Triage agent gets multiple leaf wakeups | By design — per-issue runs are scoped and safe; heartbeat dedup serializes them; avoids context compression of a single tree-traversal run |
| Template node graph complexity | Enforce DAG via topological sort at save time |
| Template evolution after instances exist | Instances are decoupled — they're just issues once created. Template changes don't affect existing instances |

## Scope

- **In scope (MVP):** Template CRUD, invoke, blocked-wake suppression, unassigned-wake fix, routine–workflow integration, UI pages.
- **Out of scope (MVP):** Workflow template export/import as part of company packages. Templates are company-local for now.
