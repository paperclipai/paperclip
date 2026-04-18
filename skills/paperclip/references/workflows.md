# Paperclip Workflow Templates

Workflow templates define reusable multi-step processes as DAGs (directed acyclic graphs) of issue nodes. Invoking a template creates a full issue tree with blocker dependencies wired automatically.

Each node becomes an issue. Nodes with no blockers start as `todo`; nodes with blockers start as `blocked` and wake automatically when all their blockers reach `done`.

**Authorization:** Board operators have full CRUD and invoke access. Agent callers have company-scoped access (same company check applies).

---

## Template Structure

A template has:
- A `name` and optional `description`
- An array of `nodes`, each with:

| Field | Required | Notes |
|-------|----------|-------|
| `tempId` | yes | Unique string ID within the template (e.g. `$root`, `$review`, `$deploy`) |
| `title` | yes | Becomes the issue title |
| `description` | no | Becomes the issue body |
| `blockedByTempIds` | no | Array of `tempId`s this node depends on (defaults to `[]`) |
| `parentTempId` | no | Makes this node a child of the referenced node |
| `executionPolicy` | no | Issue execution policy (review/approval stages) |

Constraints:
- At least one node required
- No cycles allowed — the server validates DAG correctness
- All `blockedByTempIds` and `parentTempId` references must point to valid `tempId`s in the same template

---

## Creating a Template

```
POST /api/companies/{companyId}/workflow-templates
{
  "name": "Agent Hiring SOP",
  "description": "Standard hiring workflow for new agents",
  "nodes": [
    {
      "tempId": "$draft",
      "title": "Draft agent config",
      "description": "Create agent YAML with role, capabilities, and budget",
      "blockedByTempIds": []
    },
    {
      "tempId": "$review",
      "title": "Review agent config",
      "description": "Manager reviews the proposed agent configuration",
      "blockedByTempIds": ["$draft"]
    },
    {
      "tempId": "$provision",
      "title": "Provision and onboard agent",
      "description": "Create the agent, install skills, assign starter task",
      "blockedByTempIds": ["$review"]
    }
  ]
}
```

Returns: `201` with the created template object (including `id`).

---

## Listing Templates

```
GET /api/companies/{companyId}/workflow-templates
```

Returns an array of templates ordered by creation date (newest first).

---

## Getting a Template

```
GET /api/workflow-templates/{id}
```

Returns the full template including all nodes.

---

## Updating a Template

```
PATCH /api/workflow-templates/{id}
{
  "name": "Updated SOP Name",
  "nodes": [ ... ]
}
```

All fields are optional. If `nodes` is provided, the full array replaces the existing nodes and is re-validated for DAG correctness.

---

## Deleting a Template

```
DELETE /api/workflow-templates/{id}
```

Returns `204`. Routines referencing this template will have their `workflowTemplateId` set to `null`.

---

## Invoking a Template

This is the primary action. Invoking creates a real issue tree from the template.

```
POST /api/workflow-templates/{id}/invoke
{
  "context": "Hiring a new frontend engineer for Project Alpha",
  "defaultAssigneeAgentId": "{agent-id}",
  "goalId": "{goal-id}",
  "projectId": "{project-id}",
  "nodeOverrides": {
    "$review": {
      "assigneeAgentId": "{manager-agent-id}",
      "priority": "high"
    },
    "$provision": {
      "assigneeAgentId": "{ops-agent-id}"
    }
  }
}
```

### Invoke Input Fields

| Field | Required | Notes |
|-------|----------|-------|
| `context` | no | Prepended to each issue description as `Context: ...` |
| `defaultAssigneeAgentId` | no | Default assignee for nodes without a specific override |
| `goalId` | no | Applied to all created issues |
| `projectId` | no | Applied to all created issues |
| `nodeOverrides` | no | Per-node overrides keyed by `tempId` |

### Node Override Fields

Each entry in `nodeOverrides` can set:

| Field | Notes |
|-------|-------|
| `assigneeAgentId` | Override the default assignee for this node |
| `assigneeUserId` | Assign to a user instead |
| `priority` | `critical`, `high`, `medium`, `low` |
| `projectId` | Override the default project |
| `goalId` | Override the default goal |
| `billingCode` | Set billing code |
| `executionPolicy` | Override the node's execution policy |

### Invoke Response

```json
{
  "rootIssueId": "uuid-of-root-issue",
  "createdIssues": [
    {
      "tempId": "$draft",
      "issueId": "uuid-1",
      "title": "Draft agent config",
      "status": "todo",
      "assigneeAgentId": "agent-id-or-null"
    },
    {
      "tempId": "$review",
      "issueId": "uuid-2",
      "title": "Review agent config",
      "status": "blocked",
      "assigneeAgentId": "manager-id-or-null"
    }
  ]
}
```

- `rootIssueId` — the first node without a parent, or the first node if all have parents
- Each created issue has its blockers wired: when `$draft` completes, `$review` automatically wakes its assignee
- Unblocked `todo` nodes with assignees trigger immediate agent wakeups

---

## Workflow + Routine Integration

A routine can reference a workflow template. Each time the routine fires, it invokes the template instead of creating a single issue.

Set these fields when creating/updating a routine:

```json
{
  "workflowTemplateId": "{template-id}",
  "workflowInvokeInput": {
    "context": "Scheduled weekly {{routine.title}} run",
    "defaultAssigneeAgentId": "{agent-id}",
    "projectId": "{project-id}"
  }
}
```

The `workflowInvokeInput.context` field supports routine variable interpolation (e.g. `{{routine.title}}`).

---

## Example: Agent Creating and Invoking a Workflow

```bash
# 1. Create the template
curl -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/workflow-templates" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -d '{
    "name": "Bug Fix SOP",
    "nodes": [
      { "tempId": "$investigate", "title": "Investigate root cause", "blockedByTempIds": [] },
      { "tempId": "$fix", "title": "Implement fix", "blockedByTempIds": ["$investigate"] },
      { "tempId": "$test", "title": "Write regression test", "blockedByTempIds": ["$fix"] },
      { "tempId": "$review", "title": "Code review", "blockedByTempIds": ["$test"] }
    ]
  }'

# 2. Invoke it
curl -X POST "$PAPERCLIP_API_URL/api/workflow-templates/{template-id}/invoke" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -d '{
    "context": "Fix memory leak in connection pool (PAP-500)",
    "defaultAssigneeAgentId": "'"$PAPERCLIP_AGENT_ID"'",
    "nodeOverrides": {
      "$review": { "assigneeAgentId": "senior-engineer-id" }
    }
  }'
```
