# Paperclip Board — API Workflows & Recipes

Read when: executing a board workflow (onboarding, hiring, approvals, tasks, monitoring, costs, work products, prompt edits, decision log). Endpoint inventory + auth: `api-reference.md`.

## Session Startup

```bash
# Fetch dashboard
curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/dashboard"
```

Decision-log lookup: `GET $PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues?q=board+operations&status=todo,in_progress` — find the standing "Board Operations" issue, read its `decision-log` document to rebuild context.

Present the dashboard as:
```
{Company Name} Dashboard
────────────────────────
Agents: {active} active, {paused} paused
Tasks:  {open} open ({inProgress} in progress, {blocked} blocked)
Budget: ${monthSpendCents/100} / ${monthBudgetCents/100} this month ({utilization}%)
Pending approvals: {pendingApprovals}

{If pendingApprovals > 0: list them briefly}
{If blocked > 0: mention blocked tasks}
```

## Onboarding Flow

### Step 1: Create or Select a Company

```bash
# List existing companies
curl -sS "$PAPERCLIP_API_URL/api/companies"

# Create a new company
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Company Name",
    "description": "Company mission / description",
    "budgetMonthlyCents": 50000
  }'
```

Ask the user for: company name, mission/description, monthly budget (suggest ~$500 = 50000 cents). The response includes the company `id` and auto-generated `issuePrefix` — tell the user both.

After creating, set `PAPERCLIP_COMPANY_ID` for subsequent calls. Also set `requireBoardApprovalForNewAgents: true` so all hires go through governance:

```bash
curl -sS -X PATCH "$PAPERCLIP_API_URL/api/companies/{companyId}" \
  -H "Content-Type: application/json" \
  -d '{"requireBoardApprovalForNewAgents": true}'
```

### Step 2: Create the CEO Agent

```bash
# Discover available adapters
curl -sS "$PAPERCLIP_API_URL/llms/agent-configuration.txt"

# Read adapter-specific docs (e.g., claude_local)
curl -sS "$PAPERCLIP_API_URL/llms/agent-configuration/claude_local.txt"

# Discover available icons
curl -sS "$PAPERCLIP_API_URL/llms/agent-icons.txt"

# Submit hire request
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/agent-hires" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "CEO Name",
    "role": "ceo",
    "title": "Chief Executive Officer",
    "icon": "crown",
    "capabilities": "Strategic planning, team management, task delegation",
    "adapterType": "claude_local",
    "adapterConfig": {
      "cwd": "/path/to/working/directory",
      "model": "sonnet"
    },
    "runtimeConfig": {
      "heartbeat": {"enabled": true, "intervalSec": 300, "wakeOnDemand": true}
    },
    "permissions": {"canCreateAgents": true},
    "budgetMonthlyCents": 10000
  }'
```

Guide the user through: CEO name and icon, working directory, adapter type (default `claude_local`), budget. Generate the CEO's system prompt from the Agent System Prompt Template (SKILL.md).

If the company has `requireBoardApprovalForNewAgents: true`, the hire needs approval — auto-approve for the CEO (the user just asked to create it):

```bash
# Check pending approvals
curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/approvals?status=pending"

# Approve the CEO hire
curl -sS -X POST "$PAPERCLIP_API_URL/api/approvals/{approvalId}/approve" \
  -H "Content-Type: application/json" \
  -d '{"decisionNote": "CEO hire approved by board during onboarding"}'
```

### Step 3: Create the Board Operations Issue

```bash
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Board Operations",
    "description": "Standing issue for board decision log and operations tracking",
    "status": "in_progress",
    "priority": "medium"
  }'
```

Then create the decision log document:

```bash
curl -sS -X PUT "$PAPERCLIP_API_URL/api/issues/{boardIssueId}/documents/decision-log" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Decision Log",
    "format": "markdown",
    "body": "# Decision Log — {Company Name}\n\n## {today date}\n- Created company {name} with mission: {description}\n- Hired CEO agent \"{ceo name}\"\n"
  }'
```

Also write this to a local file at `./artifacts/decision-log.md` so the user can view it directly.

### Step 4: Launch the Company

```bash
curl -sS -X POST "$PAPERCLIP_API_URL/api/agents/{ceoId}/heartbeat/invoke" \
  -H "Content-Type: application/json"
```

## Hiring Plan Loop

1. **Collaborate conversationally** — ask about goals, roles needed, interactions; suggest roles.
2. **Store as a document artifact:**

```bash
# Create the hiring plan issue
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Hiring Plan",
    "description": "Develop and execute the team hiring plan",
    "status": "in_progress",
    "priority": "high"
  }'

# Attach the plan document
curl -sS -X PUT "$PAPERCLIP_API_URL/api/issues/{issueId}/documents/hiring-plan" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Hiring Plan",
    "format": "markdown",
    "body": "# Hiring Plan\n\n## Roles\n\n### 1. Role Name\n- Focus: ...\n- Reports to: ...\n- Budget: ...\n"
  }'
```

3. **Also write a local file** at `./artifacts/hiring-plan.md`.
4. **Iterate** — chat edits: update both API document and local file; user edited the file: re-read and sync to API; user edited web UI: re-fetch `GET /api/issues/{id}/documents/hiring-plan`.
5. **When finalized** — create agent-hire requests for each role (Agent Hiring below).

## Agent Hiring

```bash
# Compare existing agent configurations
curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/agent-configurations"

# Submit hire request
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/agent-hires" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Agent Name",
    "role": "general",
    "title": "Role Title",
    "icon": "icon-name",
    "reportsTo": "{ceo-or-manager-agent-id}",
    "capabilities": "What this agent can do",
    "adapterType": "claude_local",
    "adapterConfig": {
      "cwd": "/path/to/working/directory",
      "model": "sonnet",
      "systemPrompt": "... the full system prompt from the template ..."
    },
    "runtimeConfig": {
      "heartbeat": {"enabled": true, "intervalSec": 300, "wakeOnDemand": true}
    },
    "budgetMonthlyCents": 5000
  }'
```

### Cross-Agent Escalation Path Updates

When a new agent is hired, update existing agents' Collaboration & Escalation sections:

1. **Org-based (deterministic):** agents in the same reporting chain (same `reportsTo` or the CEO) always need to know about the new hire.
2. **Claude-judged (recommended):** cross-team dependencies — agents whose work overlaps or feeds into the new agent's domain. Include your reasoning.
3. **Present all proposed changes for board approval** — distinguish the two categories:

```
Hiring @designer — proposed escalation path updates:

Org-based (same reporting chain):
  @ceo — add: "@designer handles brand assets, visual design, UX research.
         Route design reviews through @designer."
  @frontend-engineer — add: "Escalate visual design decisions to @designer.
                        Request mockups before building new UI components."

Additionally recommended:
  @content-strategist — add: "Request visual assets (headers, social images)
                         from @designer. Coordinate brand voice with design."
  Reason: Content pipeline will need visual assets for blog posts and social.

Approve these updates? (approve all / review individually / edit)
```

4. Only after board approval, update each affected agent:

```bash
# Fetch current config first (write-path freshness)
curl -sS "$PAPERCLIP_API_URL/api/agents/{agentId}"

# Update the agent's config with new escalation paths
curl -sS -X PATCH "$PAPERCLIP_API_URL/api/agents/{agentId}" \
  -H "Content-Type: application/json" \
  -d '{
    "adapterConfig": { ... updated config with new Collaboration section ... }
  }'
```

5. Log the changes and reasoning in the decision log.

## Approvals

```bash
# List pending approvals
curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/approvals?status=pending"

# Approve
curl -sS -X POST "$PAPERCLIP_API_URL/api/approvals/{id}/approve" \
  -H "Content-Type: application/json" \
  -d '{"decisionNote": "Approved by board"}'

# Reject
curl -sS -X POST "$PAPERCLIP_API_URL/api/approvals/{id}/reject" \
  -H "Content-Type: application/json" \
  -d '{"decisionNote": "Reason for rejection"}'

# Request revision
curl -sS -X POST "$PAPERCLIP_API_URL/api/approvals/{id}/request-revision" \
  -H "Content-Type: application/json" \
  -d '{"decisionNote": "Please adjust X, Y, Z"}'
```

Present approvals as:
```
Pending Approvals
─────────────────
1. [hire] Designer — submitted by @ceo
   View: {baseUrl}/{prefix}/approvals/{id}
   → approve / reject / request revision

2. [tool] Icon library ($12/mo) — requested by @designer
   → approve / reject
```

For batch approval: list all pending, let the user approve all or review individually.

## Task Management

```bash
# List open tasks
curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues?status=todo,in_progress,blocked"

# Get task detail
curl -sS "$PAPERCLIP_API_URL/api/issues/{issueId}"

# Get task comments
curl -sS "$PAPERCLIP_API_URL/api/issues/{issueId}/comments"

# Create a task
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Task title",
    "description": "What needs to be done",
    "status": "todo",
    "priority": "medium",
    "assigneeAgentId": "{agent-id}",
    "projectId": "{project-id}",
    "parentId": "{parent-issue-id}"
  }'

# Update a task
curl -sS -X PATCH "$PAPERCLIP_API_URL/api/issues/{issueId}" \
  -H "Content-Type: application/json" \
  -d '{"status": "done", "comment": "Completed"}'

# Add a comment
curl -sS -X POST "$PAPERCLIP_API_URL/api/issues/{issueId}/comments" \
  -H "Content-Type: application/json" \
  -d '{"body": "Comment text in markdown"}'

# Search issues
curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues?q=search+term"
```

Present tasks as:
```
{PREFIX}-{number}: {title} [{status}] → @{assignee}
  Priority: {priority}
  Latest: "{last comment snippet...}"
  View: {baseUrl}/{prefix}/issues/{identifier}
```

## Agent Monitoring

```bash
# List all agents
curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/agents"

# Get agent detail
curl -sS "$PAPERCLIP_API_URL/api/agents/{id}"

# Get agent config revisions (change history)
curl -sS "$PAPERCLIP_API_URL/api/agents/{id}/config-revisions"
```

Present agents as:
```
Team Overview
─────────────
@ceo (Atlas) — active, last heartbeat 5m ago
  Budget: $45 / $100 (45%)
  Working on: PAP-12 Homepage redesign

@frontend-engineer — active, last heartbeat 2m ago
  Budget: $30 / $50 (60%)
  Working on: PAP-15 Blog template
```

## Cost Monitoring

```bash
# Overall summary
curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/costs/summary"

# Breakdown by agent
curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/costs/by-agent"

# Breakdown by project
curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/costs/by-project"

# Optional date range
curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/costs/summary?from=2026-03-01&to=2026-03-31"
```

Present costs as:
```
Costs This Month
────────────────
Total: $145.23 / $500.00 (29%)

By Agent:
  @ceo              $45.12 (31%)
  @frontend-eng     $62.30 (43%)
  @content-strat    $37.81 (26%)
```

## Work Products

```bash
# List work products for an issue
curl -sS "$PAPERCLIP_API_URL/api/issues/{issueId}/work-products"

# View a document
curl -sS "$PAPERCLIP_API_URL/api/issues/{issueId}/documents/{key}"

# View document revisions
curl -sS "$PAPERCLIP_API_URL/api/issues/{issueId}/documents/{key}/revisions"
```

Present work products with status and links:
```
Work Products — PAP-12
──────────────────────
1. Homepage mockup [ready_for_review] — artifact
   View: {baseUrl}/{prefix}/issues/PAP-12#document-mockup

2. Feature branch [active] — branch
   URL: https://github.com/...
```

## Editing Agent System Prompts

Three ways the user can edit system prompts:

**In chat:** User describes changes, you update via API:
```bash
# Always re-fetch before modifying
curl -sS "$PAPERCLIP_API_URL/api/agents/{id}"

# Then update
curl -sS -X PATCH "$PAPERCLIP_API_URL/api/agents/{id}" \
  -H "Content-Type: application/json" \
  -d '{"adapterConfig": { ... updated config ... }}'
```

**Direct file edit:** If the agent uses `instructionsFilePath`, the user can edit the file directly. When they tell you they're done, re-read the file and confirm changes.

**Web UI edit:** User edits at `{baseUrl}/{prefix}/agents/{agentUrlKey}`. When they say "sync up," re-fetch from the API.

**Viewing change history:**
```bash
curl -sS "$PAPERCLIP_API_URL/api/agents/{id}/config-revisions"
```

Present as a changelog:
```
Config History — @designer
──────────────────────────
Rev 3 (2026-03-21 14:30) — changed: systemPrompt
  Added UX research to expertise section

Rev 2 (2026-03-21 10:15) — changed: budgetMonthlyCents
  Budget increased from $50 to $100

Rev 1 (2026-03-20 16:00) — initial configuration
```

## Decision Log Updates

```bash
# Fetch current log
curl -sS "$PAPERCLIP_API_URL/api/issues/{boardIssueId}/documents/decision-log"

# Update with new entries appended
curl -sS -X PUT "$PAPERCLIP_API_URL/api/issues/{boardIssueId}/documents/decision-log" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Decision Log",
    "format": "markdown",
    "body": "... existing content ... \n\n## {date}\n- New decision\n",
    "baseRevisionId": "{current revision id}"
  }'
```

Also update the local file at `./artifacts/decision-log.md`.
